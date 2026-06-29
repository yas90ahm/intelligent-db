/**
 * engineOwnedEvidence.test.ts — BATCH 1 (junior): locks the OD-8 engine-owned-evidence
 * INVARIANT and the boolean-intent seam, complementing highImpactGateR.test.ts.
 *
 * highImpactGateR.test.ts already pins the RUNTIME #R outcomes (self-stack ⇒ DEFER,
 * 2-disjoint ⇒ RESOLVE, the derived agreement set, the fail-closed recency). This file
 * adds the pieces NOT covered there:
 *
 *  (c) THE TYPE INVARIANT — a caller can no longer inject evidence. `adjudicate` takes a
 *      boolean INTENT flag (NOT a `HighImpactContext`), and `ratify` no longer accepts a
 *      `corroboratingStrandIds` list. These are COMPILE-TIME assertions enforced by
 *      `npm run typecheck` via `@ts-expect-error`: if either escape hatch were re-opened,
 *      the directive would become unused and typecheck would FAIL.
 *
 *  (a/b) THE BOOLEAN DRIVES THE GATE — on ONE identical self-stacked graph the engine
 *      RESOLVES with `{ highImpact: false }` (decisive LCB margin) but DEFERS with
 *      `{ highImpact: true }`. The caller changed only the INTENT bit; the engine built
 *      the gate evidence itself and #R = 1 (one actor) failed it. Proves no evidence
 *      proxy crosses the seam.
 *
 *  (b/d) #R UNIONS SEPARATE AGREEING STRANDS — adding ONE genuinely anchor-disjoint
 *      agreeing LIVE strand flips #R 1→2 and the high-impact outcome DEFER→RESOLVE,
 *      tying #deriveAgreementSet directly to the gate (the fp-1 under-count, closed).
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createStakeLedger,
  createPendingLedger,
  createReputationLedger,
  generatePassport,
  independenceBetween,
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
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  ReputationLedger,
  Passport,
  Strand,
  ContentHash,
  RatificationDeps,
  IntelligentDb,
  IdentityStamp,
  HighImpactContext,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

const WINNER = "src:winner" as SourceId;
const CORROB = "src:corrob" as SourceId;
const CHAL = "src:chal" as SourceId;

// --- minimal pillar ports (mirrors highImpactGateR.test.ts) -----------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: Passport): void {
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
  return {
    anchorClass,
    realizedCost: weight as Unit,
    independenceWeight: weight as Unit,
  };
}

/** Content-hash equal whenever entity+value match — the mechanical value fingerprint. */
function valueHash(value: string): ContentHash {
  return ("hash:" + value) as ContentHash;
}

function rootOf(idRaw: string, cls: string, sourceId: SourceId): ProvenanceRoot {
  return {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
}

/** A fresh, reputation-bearing engine + store + identity over one in-memory backend. */
function makeEngine(): {
  store: ReturnType<typeof createMemoryStore>;
  identity: SourceIdentityLayer;
  reputation: ReputationLedger;
  db: IntelligentDb;
} {
  const store = createMemoryStore();
  const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };
  const repPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const identity = createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: repPort,
    stake: stakePort,
  });
  const ledger = createPendingLedger({ reputation });
  const ratification: RatificationDeps = { ledger, systemSigner: generatePassport() };
  const db = createIntelligentDb(store, identity, null, reputation, ratification);
  return { store, identity, reputation, db };
}

function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  value: string,
  roots: readonly ProvenanceRoot[],
): Strand {
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { v: value },
    content_hash: valueHash(value),
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
    register: null,
  };
  store.putStrand(s);
  return s;
}

/**
 * Stand up a multi-class dispute whose WINNER self-stacks four anchor-CLASS costumes
 * (all ONE actor ⇒ #R collapses to 1) and is pre-earned to a decisive, earned rep so the
 * dispute reaches the gate. The challenger is a fresh different-value claim.
 */
function selfStackedScenario(): ReturnType<typeof makeEngine> {
  const eng = makeEngine();
  const { store, identity, reputation } = eng;

  identity.register({ ...generatePassport(), sourceId: WINNER } as Passport, [
    bindingOf(AnchorClass.EMAIL_OAUTH, 0.1),
    bindingOf(AnchorClass.PHONE_SIM, 0.2),
    bindingOf(AnchorClass.DOMAIN, 0.35),
    bindingOf(AnchorClass.ORGANIZATION, 0.75),
  ]);
  identity.register({ ...generatePassport(), sourceId: CHAL } as Passport, []);

  for (let i = 0; i < 6; i++) reputation.ratify(WINNER, NOW, 1);

  fileStrand(store, "strand:win", "Berlin", [
    rootOf("win-1", "class:c1", WINNER),
    rootOf("win-2", "class:c2", WINNER),
    rootOf("win-3", "class:c3", WINNER),
    rootOf("win-4", "class:c4", WINNER),
  ]);
  fileStrand(store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);
  return eng;
}

describe("BATCH 1 — OD-8 engine-owned-evidence invariant (junior add-on)", () => {
  it("(c) TYPE: callers cannot inject a HighImpactContext or corroboratingStrandIds", () => {
    // COMPILE-TIME assertions enforced by `npm run typecheck`. The body never runs
    // (guarded by a runtime-false `let` so TS does not treat it as dead/unreachable),
    // so there is zero runtime side effect — tsc still type-checks every line inside.
    // If either escape hatch were re-opened, the matching `@ts-expect-error` would go
    // UNUSED and typecheck would FAIL — which is exactly the regression lock we want.
    let COMPILE_ONLY = false;
    COMPILE_ONLY = (Date.now() < 0); // never true; opaque to TS literal narrowing
    if (COMPILE_ONLY) {
      const db = null as unknown as IntelligentDb;
      const stamp = null as unknown as IdentityStamp;
      const fakeCtx = null as unknown as HighImpactContext;

      // POSITIVE control: the boolean INTENT flag is the ONLY accepted shape.
      db.adjudicate(ATTR, { highImpact: true });
      db.adjudicate(ATTR, { highImpact: false });
      db.adjudicate(ATTR); // opts optional

      // (c-1) OD-8: `highImpact` is a boolean, NOT an injectable evidence proxy.
      // @ts-expect-error — a HighImpactContext object is not assignable to `boolean`.
      db.adjudicate(ATTR, { highImpact: fakeCtx });

      // (c-2) OD-8: no caller-supplied evidence object on the options bag at all.
      // @ts-expect-error — `evidence` / arbitrary keys are not part of AdjudicateOptions.
      db.adjudicate(ATTR, { highImpact: true, evidence: fakeCtx });

      // (c-3) OD-8: ratify no longer accepts a caller-supplied corroborator list — the
      //       engine DERIVES the agreement set itself (#deriveAgreementSet).
      // @ts-expect-error — `corroboratingStrandIds` was removed from RatifyInput.
      db.ratify({ strandId: asStrandId("x"), externalStamp: stamp, corroboratingStrandIds: [] });

      // POSITIVE control: the engine-owned ratify shape still compiles.
      db.ratify({ strandId: asStrandId("x"), externalStamp: stamp });
    }
    expect(COMPILE_ONLY).toBe(false);
  });

  it("(a/b) F4a UNCONDITIONAL #R>=2 floor: a self-stacked (R=1) multi-class dispute DEFERS for BOTH intents", () => {
    // BATCH 3 (F4a) closes the al-c3-05 "build-once-flip-everywhere" amortization that the
    // OLD high-impact-only #R check left open on the DEFAULT-impact path. The engine now
    // applies the >= 2-independent-root structural floor on EVERY multi-class auto-resolve,
    // REGARDLESS of the caller's intent bit. On the IDENTICAL self-stacked graph (winner =
    // ONE actor wearing four anchor-CLASS costumes ⇒ engine-derived #R = 1), BOTH
    // { highImpact: false } and { highImpact: true } now DEFER and demote NOTHING — the
    // self-stacked winner can no longer flip the default-impact path. (The boolean still
    // gates the high-impact-ONLY count/recency clauses on an R>=2 graph; see (b/d).)
    const ordinary = selfStackedScenario();
    const ordinaryOutcome = ordinary.db.adjudicate(ATTR, { highImpact: false });
    expect(ordinaryOutcome.kind).toBe("DEFERRED");
    expect(ordinary.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(
      FactState.LIVE,
    );
    expect(ordinary.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(
      FactState.LIVE,
    );

    const irreversible = selfStackedScenario();
    const irreversibleOutcome = irreversible.db.adjudicate(ATTR, { highImpact: true });
    expect(irreversibleOutcome.kind).toBe("DEFERRED");
    // Nothing demoted: the unconditional floor (and the human horn) owns the call.
    expect(irreversible.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(
      FactState.LIVE,
    );
    expect(irreversible.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(
      FactState.LIVE,
    );
  });

  it("(b/d) #R unions a separate agreeing strand: adding a disjoint LIVE agreer flips DEFER→RESOLVE", () => {
    // Same winner, but this time anchored in a SINGLE real class (DOMAIN) so the only
    // path to #R >= 2 is a SEPARATE agreeing strand from a disjoint actor — the exact
    // corroboration the old single-strand `winner.provenance` read under-counted (fp-1).
    const eng = makeEngine();
    const { store, identity, reputation, db } = eng;

    identity.register({ ...generatePassport(), sourceId: WINNER } as Passport, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    identity.register({ ...generatePassport(), sourceId: CORROB } as Passport, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    identity.register({ ...generatePassport(), sourceId: CHAL } as Passport, []);
    for (let i = 0; i < 6; i++) reputation.ratify(WINNER, NOW, 1);

    // BEFORE: only the winner asserts "Berlin" ⇒ #R = 1 ⇒ high-impact DEFERS.
    fileStrand(store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    fileStrand(store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);
    expect(db.adjudicate(ATTR, { highImpact: true }).kind).toBe("DEFERRED");
    expect(store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.LIVE);

    // ADD a genuinely anchor-disjoint, same-VALUE agreeing LIVE strand ⇒ #R unions to 2.
    fileStrand(store, "strand:agree", "Berlin", [rootOf("agree", "class:corrob", CORROB)]);

    // AFTER: the engine-derived #R = 2 now clears the gate ⇒ RESOLVE; the agreer stays
    // LIVE, only the different-value challenger falls.
    const outcome = db.adjudicate(ATTR, { highImpact: true });
    expect(outcome.kind).toBe("RESOLVED");
    expect(store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(asStrandId("strand:agree"))?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.DEMOTED);
  });
});
