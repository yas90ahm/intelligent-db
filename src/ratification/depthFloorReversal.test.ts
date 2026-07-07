/**
 * depthFloorReversal.test.ts — RE-AUDIT REGRESSION for the depth-floor credit-reversal
 * findings (hostile production-readiness re-audit, HIGH + MEDIUM):
 *
 *  1. HIGH `reverseCredit`'s depth-floor unwind only moved the LCB at the narrow
 *     depth=2 boundary the sole pre-existing regression test encoded; at a realistic
 *     well-corroborated depth (4, 6, 8) the LCB barely moved (independently
 *     recomputed: depth=10, w=1 dropped the LCB only from 0.7839 to 0.7654).
 *  2. MEDIUM a reversal could erode an UNRELATED, still-valid corroboration's
 *     non-decaying `corroborationDepth` floor on the same beneficiary source, because
 *     the floor was a single per-source `Math.max` scalar and the fix subtracted a
 *     fixed alpha-mass `w` from it directly.
 *
 * ROOT CAUSE (see `identity/reputation.ts`'s `applyCreditReversal` doc comment for the
 * full derivation): `alpha` is an ADDITIVE evidence mass (`w` per event, <= 1) while
 * `corroborationDepth` is a `Math.max` over MIS-depth SNAPSHOTS (`#R`, up to
 * `MAX_EXACT_ROOTS`) recorded at ratify time — the two are NOT commensurable. A single
 * ratify call can snapshot a LARGE depth (because many OTHER agreeing strands already
 * existed) while contributing only `w = 1` of fresh alpha, so subtracting the SAME `w`
 * from both barely unwinds the floor at high depth, and can also strip an unrelated
 * event's own, still-valid depth contribution.
 *
 * THE FIX: the corroboration-event ledger now records the RAW MIS depth (`#R`) each
 * event snapshotted (`corroborationDepthAtEvent`); on reversal, `disown.ts` recomputes
 * the beneficiary's TRUE surviving floor as the MAX `corroborationDepthAtEvent` over
 * every OTHER, still-unreversed event for the SAME beneficiary
 * (`CorroborationLedger.eventsByBeneficiary`) and passes it to
 * `ReputationLedger.reverseCredit`'s new `newCorroborationDepth` parameter, which SETS
 * (not subtracts from) the floor.
 *
 * Both tests drive the REAL production path end-to-end: `db.ratify` (which computes
 * the real MIS depth via the engine's `#R`/`#deriveAgreementSet` and records the real
 * corroboration event) and `db.disown` (the real `downstreamDisownSweep`) — no
 * re-derived math, no hand-constructed `CorroborationEvent` shortcuts.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createCorroborationLedger,
  createPendingLedger,
  independenceBetween,
  lcbReadout,
  DEFAULT_REPUTATION_PARAMS,
  AnchorClass,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  AttributeKey,
  EntityId,
  SourceId,
  Unit,
  AnchorBinding,
  ProvenanceRoot,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  SourceRef,
  Strand,
  StrandId,
  ContentHash,
  RatificationDeps,
  ReputationLedger,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

// ---------------------------------------------------------------------------
// Minimal REAL pillar ports (mirrors highImpactGateR.test.ts / disownReopenWinnerFlip)
// ---------------------------------------------------------------------------

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: SourceRef): void {
      known.add(p.sourceId);
    },
    sourceIdOf(s: SourceId): SourceId | null {
      return known.has(s) ? s : null;
    },
    has(s: SourceId): boolean {
      return known.has(s);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(s: SourceId, anchors: readonly AnchorBinding[]): void {
      book.set(s, [...(book.get(s) ?? []), ...anchors]);
    },
    anchorsOf(s: SourceId): readonly AnchorBinding[] {
      return book.get(s) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function bindingOf(anchorClass: AnchorClass, weight: number): AnchorBinding {
  return { anchorClass, realizedCost: weight as Unit, independenceWeight: weight as Unit };
}

/** Content-hash equal whenever entity+value match — the mechanical value fingerprint. */
function valueHash(entity: string, value: string): ContentHash {
  return `hash:${entity}:${value}` as ContentHash;
}

function rootOf(idRaw: string, cls: string, sourceId: SourceId): ProvenanceRoot {
  return {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
}

/** A deterministic distinct-class anchor ladder, enough for a depth up to 9. */
const CLASS_LADDER: readonly AnchorClass[] = [
  AnchorClass.VERIFIED_HUMAN, // the beneficiary's own class (index 0)
  AnchorClass.EMAIL_OAUTH,
  AnchorClass.PHONE_SIM,
  AnchorClass.DOMAIN,
  AnchorClass.HARDWARE_ATTESTATION,
  AnchorClass.ORGANIZATION,
  AnchorClass.SSO_TENANT_MEMBER,
  AnchorClass.PUBLISHER_TRACKED,
  AnchorClass.LOCAL_DOCUMENT,
];

/** One fully-wired engine instance (real store + identity + reputation + corroboration). */
function wire(): {
  store: ReturnType<typeof createMemoryStore>;
  identity: SourceIdentityLayer;
  reputation: ReputationLedger;
  db: ReturnType<typeof createIntelligentDb>;
} {
  const store = createMemoryStore();
  const anchors = makeAnchorRegistry();
  const reputation = createReputationLedger(
    (s) => {
      // repCapFor over the source's bound anchors (real math, via the registry).
      const bound = anchors.anchorsOf(s);
      let cap = 0.05;
      for (const b of bound) {
        // Mirror repCapFor's per-class ceiling closely enough for this test: the
        // ladder above only uses high-cap classes, so a generous, fixed 0.9 ceiling
        // never binds the numbers under test either way.
        if (b.anchorClass === AnchorClass.VERIFIED_HUMAN) cap = Math.max(cap, 0.9);
        else cap = Math.max(cap, 0.6);
      }
      return cap as Unit;
    },
    DEFAULT_REPUTATION_PARAMS,
    () => NOW,
  );
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors,
    reputation: { scoreOf: (s) => reputation.scoreOf(s) } satisfies ReputationLedgerPort,
    stake: { postedFor: () => 0 } satisfies StakeLedgerPort,
  });
  // A plain pending ledger (these tests never open/approve a dispute; `disown`'s
  // HARDENING-3 reopen path is exercised in `disownReopenWinnerFlip.test.ts` / the
  // dedicated provenance-protection test, not here).
  const ratification: RatificationDeps = {
    ledger: createPendingLedger({}),
    systemSource: freshSource().sourceId,
    corroboration: createCorroborationLedger(),
  };
  const db = createIntelligentDb(store, identity, null, reputation, ratification);
  return { store, identity, reputation, db };
}

function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  entity: string,
  attribute: string,
  value: string,
  roots: readonly ProvenanceRoot[],
): Strand {
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: entity as EntityId,
    attribute: attribute as AttributeKey,
    payload: { v: value },
    content_hash: valueHash(entity, value),
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [...roots],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1 as Unit, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
  store.putStrand(s);
  return s;
}

// ===========================================================================
// 1. HIGH — depth-floor unwind must be EXACT at every realistic depth, not just 2
// ===========================================================================

describe("RE-AUDIT depth-floor reversal — exact at realistic depths, not only the depth=2 boundary", () => {
  it.each([2, 4, 6, 8])(
    "depth=%i: disowning the SOLE corroborator drops the LCB all the way to the fresh-prior floor",
    (depth: number) => {
      const { store, identity, reputation, db } = wire();

      // The beneficiary (VERIFIED_HUMAN, class index 0) files claim "V" about ENTITY.
      const beneficiary = freshSource();
      identity.register(beneficiary, [bindingOf(CLASS_LADDER[0]!, 0.7)]);
      const target = fileStrand(store, "s:target", "entity:e", "attr:a", "V", [
        rootOf("target", "class:0", beneficiary.sourceId),
      ]);

      // depth-1 MORE independent corroborators (each a distinct anchor class + a
      // distinct root independenceClass), so the total MIS depth == `depth`.
      const corroborators: SourceRef[] = [];
      for (let i = 1; i < depth; i++) {
        const c = freshSource();
        identity.register(c, [bindingOf(CLASS_LADDER[i]!, 0.3 + i * 0.02)]);
        corroborators.push(c);
        fileStrand(store, `s:corrob${i}`, "entity:e", "attr:a", "V", [
          rootOf(`corrob${i}`, `class:${i}`, c.sourceId),
        ]);
      }

      // REAL production ratify: computes #R (the true MIS depth) and records a REAL
      // corroboration event with that exact snapshot.
      db.ratify({ strandId: target.id, externalStamp: identity.stampFor(beneficiary.sourceId) });

      const stateAfterRatify = reputation.stateOf(beneficiary.sourceId)!;
      expect(stateAfterRatify.alpha).toBe(2); // w=1 default, prior 1
      expect(stateAfterRatify.corroborationDepth).toBe(depth); // sanity: construction hit the target depth

      const lcbAfterRatify = reputation.scoreOf(beneficiary.sourceId);
      expect(lcbAfterRatify).toBeGreaterThan(0); // genuinely earned something

      // What the PRE-FIX (buggy) code would have produced: subtract w=1 from BOTH
      // alpha AND the depth scalar directly (`corroborationDepth - w`).
      const oldBuggyState = {
        ...stateAfterRatify,
        alpha: 1,
        corroborationDepth: Math.max(0, depth - 1),
      };
      const oldBuggyLcb = lcbReadout(oldBuggyState, 0.9 as Unit, DEFAULT_REPUTATION_PARAMS);

      // Disown the SOLE corroborating source behind `corroborators[0]` — the ONLY
      // event funding the beneficiary's depth floor, so the model-correct surviving
      // depth is 0 (no OTHER event remains) regardless of `depth`.
      const disownTarget = corroborators[0]!;
      const disownResult = db.disown(disownTarget.sourceId, { at: NOW });
      expect(disownResult.reversedCorroborationEventIds.length).toBe(1);

      const stateAfterDisown = reputation.stateOf(beneficiary.sourceId)!;
      expect(stateAfterDisown.alpha).toBe(1); // exactly reversed, back to the fresh prior
      // THE FIX: the depth floor is recomputed to 0 (no surviving event), not
      // `depth - 1` (the pre-fix linear subtraction).
      expect(stateAfterDisown.corroborationDepth).toBe(0);

      const lcbAfterDisown = reputation.scoreOf(beneficiary.sourceId);
      // The model-correct expected LCB for the ACTUAL resulting state (computed via
      // the real `lcbReadout`, not a hard-coded number) — the fresh Beta(1,1) prior,
      // which reads out EXACTLY 0 by the z=sqrt(3) calibration.
      const expectedLcb = lcbReadout(stateAfterDisown, 0.9 as Unit, DEFAULT_REPUTATION_PARAMS);
      expect(expectedLcb).toBeCloseTo(0, 9);
      expect(lcbAfterDisown).toBeCloseTo(expectedLcb, 9);

      // Prove the fix actually MATTERS at this depth (not a vacuous assertion): for
      // depth >= 4 the pre-fix linear subtraction left the floor (and therefore the
      // LCB) materially ABOVE the fixed, model-correct result.
      if (depth >= 4) {
        expect(oldBuggyLcb).toBeGreaterThan(lcbAfterDisown + 0.05);
      }
    },
  );
});

// ===========================================================================
// 2. MEDIUM — a reversal must not erode an UNRELATED corroboration's depth-floor
// ===========================================================================

describe("RE-AUDIT collateral depth-floor erosion — an unrelated corroboration's floor survives a reversal", () => {
  it("two independent corroborations on the SAME beneficiary: disowning one leaves the other's floor fully intact", () => {
    const { store, identity, reputation, db } = wire();

    const beneficiary = freshSource();
    identity.register(beneficiary, [bindingOf(CLASS_LADDER[0]!, 0.7)]);

    // --- Corroboration A: a BIG, independently-earned depth (6) on claim #1, from 5
    // separate corroborators (C1..C5) that are NEVER disowned in this test. ---
    const targetA = fileStrand(store, "s:targetA", "entity:a", "attr:a", "V", [
      rootOf("targetA", "class:0", beneficiary.sourceId),
    ]);
    const bigCorroborators: SourceRef[] = [];
    for (let i = 1; i <= 5; i++) {
      const c = freshSource();
      identity.register(c, [bindingOf(CLASS_LADDER[i]!, 0.3 + i * 0.02)]);
      bigCorroborators.push(c);
      fileStrand(store, `s:bigCorrob${i}`, "entity:a", "attr:a", "V", [
        rootOf(`bigCorrob${i}`, `class:${i}`, c.sourceId),
      ]);
    }
    db.ratify({ strandId: targetA.id, externalStamp: identity.stampFor(beneficiary.sourceId) });
    const afterA = reputation.stateOf(beneficiary.sourceId)!;
    expect(afterA.alpha).toBe(2);
    expect(afterA.corroborationDepth).toBe(6); // beneficiary + 5 independent corroborators

    // --- Corroboration B: a SMALLER, SEPARATE claim (#2, different entity/attribute)
    // corroborated by exactly ONE further independent source, C6. Its own MIS depth
    // (2) is strictly SMALLER than the depth Corroboration A already established, so
    // it never even raises the shared per-source `corroborationDepth` scalar — but it
    // is still a REAL, independently-recorded corroboration event. ---
    const targetB = fileStrand(store, "s:targetB", "entity:b", "attr:b", "W", [
      rootOf("targetB-b0", "class:0", beneficiary.sourceId),
    ]);
    const smallCorroborator = freshSource();
    identity.register(smallCorroborator, [bindingOf(CLASS_LADDER[6]!, 0.4)]);
    fileStrand(store, "s:smallCorrob", "entity:b", "attr:b", "W", [
      rootOf("smallCorrob", "class:small", smallCorroborator.sourceId),
    ]);
    db.ratify({ strandId: targetB.id, externalStamp: identity.stampFor(beneficiary.sourceId) });
    const afterB = reputation.stateOf(beneficiary.sourceId)!;
    // A second w=1 corroboration event (~3; `#ratifyImpl` stamps `at` from real
    // wall-clock time, so a few-ms gap between the two ratify calls decays the
    // FIRST event's alpha by a negligible amount before adding the second unit).
    expect(afterB.alpha).toBeCloseTo(3, 6);
    // Corroboration B's own depth (2) does not exceed A's (6) — the shared scalar is
    // untouched by B, exactly as `Math.max` predicts.
    expect(afterB.corroborationDepth).toBe(6);

    const lcbBeforeDisown = reputation.scoreOf(beneficiary.sourceId);

    // Disown the SMALL corroborator (Corroboration B's sole funder) — completely
    // UNRELATED to Corroboration A's 5 independent backers.
    const disownResult = db.disown(smallCorroborator.sourceId, { at: NOW });
    expect(disownResult.reversedCorroborationEventIds.length).toBe(1);

    const afterDisown = reputation.stateOf(beneficiary.sourceId)!;
    // Alpha drops by exactly the disowned event's own recorded mass (w=1), modulo
    // the same negligible real-wall-clock decay noted above.
    expect(afterDisown.alpha).toBeCloseTo(2, 6);

    // THE FIX: Corroboration A's depth-floor (6) is FULLY INTACT — recomputed as the
    // max recorded depth over the one SURVIVING event (A's own depth=6), never eroded
    // by disowning a source that funded a completely different, smaller corroboration.
    expect(afterDisown.corroborationDepth).toBe(6);

    // What the PRE-FIX (buggy) code would have done instead: linearly subtract w=1
    // from the shared scalar (6 -> 5) — a real, if partial, ERASURE of Corroboration
    // A's untouched, legitimately-earned floor purely because an UNRELATED source was
    // disowned.
    const oldBuggyDepth = Math.max(0, 6 - 1);
    expect(oldBuggyDepth).toBeLessThan(afterDisown.corroborationDepth);

    // The LCB is computed against the fully-intact depth floor (never the eroded
    // one) — via the REAL lcbReadout fed the ACTUAL resulting state (not a
    // hard-coded number).
    const expectedLcb = lcbReadout(afterDisown, 0.9 as Unit, DEFAULT_REPUTATION_PARAMS);
    const lcbAfterDisown = reputation.scoreOf(beneficiary.sourceId);
    expect(lcbAfterDisown).toBeCloseTo(expectedLcb, 9);
    // Both the pre-fix and post-fix LCB stay PINNED by the depth floor here (alpha
    // 2 or 3 is still well under either floor's `alphaFloor`, so the readout does not
    // move with alpha alone) — the LCB is UNCHANGED by this disown under the fix,
    // exactly reflecting that Corroboration A's floor was never touched.
    expect(lcbAfterDisown).toBeCloseTo(lcbBeforeDisown, 9);
    // But the PRE-FIX code's eroded depth (5, not 6) would have pinned a materially
    // LOWER `alphaFloor` (6 instead of 7), reading out a strictly SMALLER LCB —
    // the collateral erosion this fix eliminates, made concrete via the same real
    // `lcbReadout` function fed the counterfactual eroded state.
    const oldBuggyLcb = lcbReadout(
      { ...afterDisown, corroborationDepth: oldBuggyDepth },
      0.9 as Unit,
      DEFAULT_REPUTATION_PARAMS,
    );
    expect(lcbAfterDisown).toBeGreaterThan(oldBuggyLcb);
    expect(lcbAfterDisown).toBeGreaterThan(0.3);
  });
});
