/**
 * highImpactGateR.test.ts — BATCH 1: the R-primitive + engine-owned-evidence invariant.
 *
 * Pins the Batch-1 deliverables at the ENGINE seam (all evidence is engine-built; the
 * caller supplies only the `{ highImpact: true }` INTENT flag — OD-8):
 *
 *  - SelfStackedClasses: one actor wearing many anchor-CLASS costumes backs a winner;
 *    the engine-derived `#R` collapses to MIS = 1 (one actor) ⇒ the high-impact gate
 *    fails `minWinnerAnchorClasses (2)` ⇒ DEFER. (Two-Class-Costume / cc-c3-01.)
 *  - Genuine 2-disjoint: two genuinely anchor-disjoint actors corroborate the SAME
 *    value (as separate agreeing strands); `#R` unions the agreement-set roots ⇒ 2 ⇒
 *    an otherwise-clean winner CLEARS the high-impact gate ⇒ RESOLVED. (fp-1 closed.)
 *  - lastContradictionAt fail-closed: a backing source contradicted with NO recorded
 *    timestamp is treated as contradicted-now ⇒ recency window fails ⇒ DEFER.
 *  - #deriveAgreementSet correctness: only same-entity + same-content_hash + LIVE
 *    strands are returned; a DEMOTED or different-value sibling is excluded.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  createCorroborationLedger,
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
  EpochMs,
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
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts) ----------------

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

/** A reputation-bearing identity layer + the anchor registry (exposed for binding). */
function makeIdentity(reputation: ReputationLedgerPort): {
  identity: SourceIdentityLayer;
} {
  // Staking is RETIRED (attribution replaces stake): a constant-zero port.
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
  return { identity };
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

/**
 * Hand-file an OBSERVED strand about (ENTITY, ATTR) with EXPLICIT provenance roots, so
 * a test can fabricate a multi-class / multi-actor backing. `value` drives both the
 * payload and the content_hash (so same value ⇒ same fingerprint ⇒ agreement).
 */
function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  value: string,
  roots: readonly ProvenanceRoot[],
  factState: FactState = FactState.LIVE,
): Strand {
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { v: value },
    content_hash: valueHash(value),
    origin: FactOrigin.OBSERVED,
    fact_state: factState,
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

function rootOf(idRaw: string, cls: string, sourceId: SourceId): ProvenanceRoot {
  return {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
}

const WINNER = "src:winner" as SourceId;
const CORROB = "src:corrob" as SourceId;
const CHAL = "src:chal" as SourceId;

describe("BATCH 1 — #R + the engine-owned high-impact gate (OD-6 / OD-8 / F1)", () => {
  it("SelfStackedClasses: one actor in many anchor-class costumes ⇒ #R = 1 ⇒ DEFER", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
    const { identity } = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const ratification: RatificationDeps = { ledger, systemSource: freshSource().sourceId };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // The winner self-stacks four anchor-CLASS costumes — all resolving to ONE actor.
    identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.EMAIL_OAUTH, 0.1),
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
      bindingOf(AnchorClass.DOMAIN, 0.35),
      bindingOf(AnchorClass.ORGANIZATION, 0.75),
    ]);
    identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);

    // Pre-EARN the winner to a DECISIVE, EARNED reputation so the multi-class dispute
    // reaches the high-impact gate (the gate is what we are testing).
    for (let i = 0; i < 6; i++) reputation.ratify(WINNER, NOW, 1);
    expect(reputation.scoreOf(WINNER)).toBeGreaterThan(0.5);

    // The winner strand carries FOUR provenance roots — different classes, ONE source.
    fileStrand(store, "strand:win", "Berlin", [
      rootOf("win-1", "class:c1", WINNER),
      rootOf("win-2", "class:c2", WINNER),
      rootOf("win-3", "class:c3", WINNER),
      rootOf("win-4", "class:c4", WINNER),
    ]);
    fileStrand(store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    // INTENT-only: the engine builds the gate evidence and derives #R = 1 (one actor),
    // which is < minWinnerAnchorClasses (2) ⇒ DEFER no matter the decisive LCB gap.
    const outcome = db.adjudicate(ATTR, { highImpact: true });
    expect(outcome.kind).toBe("DEFERRED");
    expect(store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.LIVE);
  });

  it("Genuine 2-disjoint: two anchor-disjoint actors agree on the value ⇒ #R = 2 ⇒ RESOLVE", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
    const { identity } = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const ratification: RatificationDeps = { ledger, systemSource: freshSource().sourceId };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // Two GENUINELY anchor-disjoint actors: DOMAIN vs PHONE_SIM (disjoint classes ⇒
    // independenceBetween > 0 ⇒ mutually independent under the MIS).
    identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    identity.register({ ...freshSource(), sourceId: CORROB } as SourceRef, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);

    // The winner must be DECISIVE + EARNED, AND clear the gate's corroboration-count.
    for (let i = 0; i < 6; i++) reputation.ratify(WINNER, NOW, 1);
    expect(reputation.stateOf(WINNER)?.ratifiedCount).toBeGreaterThanOrEqual(2);

    // The winner and a SEPARATE agreeing strand assert the SAME value "Berlin" (same
    // content_hash) from two DISJOINT actors — exactly the corroboration the old
    // single-strand `winner.provenance` read under-counted (fp-1).
    fileStrand(store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    fileStrand(store, "strand:agree", "Berlin", [rootOf("agree", "class:corrob", CORROB)]);
    fileStrand(store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    // #R unions the agreement-set roots ⇒ 2 disjoint actors ⇒ gate CLEARS ⇒ RESOLVED.
    const outcome = db.adjudicate(ATTR, { highImpact: true });
    expect(outcome.kind).toBe("RESOLVED");
    // Winner + its same-value corroborator stay LIVE; only the different-value loser falls.
    expect(store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(asStrandId("strand:agree"))?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.DEMOTED);
  });

  it("lastContradictionAt fail-closed: contradicted source with no timestamp ⇒ DEFER", () => {
    const store = createMemoryStore();
    const real = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);

    // FAIL-CLOSED WRAPPER: a ledger whose stateOf(WINNER) reports a contradicted source
    // (contradictedCount = 1) carrying NO recorded `lastContradictionAt` — exactly the
    // pre-Batch-1 / legacy-row shape. Everything else delegates to the real ledger, so
    // scoreOf stays the genuine decisive LCB. The engine must treat the missing timestamp
    // as contradicted-now ⇒ recency window fails ⇒ DEFER even with #R = 2 and 6 ratifies.
    const reputation = {
      scoreOf: (s: SourceId): Unit => real.scoreOf(s),
      ratify: (s: SourceId, n: EpochMs, w?: number) => real.ratify(s, n, w),
      contradict: (s: SourceId, n: EpochMs, w?: number) => real.contradict(s, n, w),
      reverseCredit: (s: SourceId, d: number, n: EpochMs) => real.reverseCredit(s, d, n),
      disownSweep: (s: SourceId, ids: readonly StrandId[]) => real.disownSweep(s, ids),
      stateOf: (s: SourceId) => {
        const st = real.stateOf(s);
        if (s === WINNER && st !== null) {
          return { ...st, contradictedCount: 1, lastContradictionAt: null };
        }
        return st;
      },
    };
    const { identity } = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const ratification: RatificationDeps = { ledger, systemSource: freshSource().sourceId };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // Two disjoint actors so #R = 2 (so the gate is reachable on (c) and the ONLY failing
    // term is the fail-closed recency check we are exercising).
    identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    identity.register({ ...freshSource(), sourceId: CORROB } as SourceRef, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);

    for (let i = 0; i < 6; i++) real.ratify(WINNER, NOW, 1);

    fileStrand(store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    fileStrand(store, "strand:agree", "Berlin", [rootOf("agree", "class:corrob", CORROB)]);
    fileStrand(store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    const outcome = db.adjudicate(ATTR, { highImpact: true });
    expect(outcome.kind).toBe("DEFERRED");
  });

  it("#deriveAgreementSet (via the engine-derived corroboration event): only same-value LIVE siblings", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
    const { identity } = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const corroboration = createCorroborationLedger();
    const ratification: RatificationDeps = {
      ledger,
      systemSource: freshSource().sourceId,
      corroboration,
    };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    identity.register({ ...freshSource(), sourceId: "src:ext" as SourceId } as SourceRef, []);

    // The target + three siblings about the SAME (entity, attribute):
    //   - a LIVE same-VALUE agreer    → MUST be in the derived agreement set
    //   - a DEMOTED same-VALUE sibling → excluded (not LIVE)
    //   - a LIVE different-VALUE sibling → excluded (different content_hash)
    const target = fileStrand(store, "strand:t", "Berlin", [rootOf("t", "class:t", WINNER)]);
    const agree = fileStrand(store, "strand:a", "Berlin", [rootOf("a", "class:a", CORROB)]);
    fileStrand(store, "strand:dem", "Berlin", [rootOf("d", "class:d", CHAL)], FactState.DEMOTED);
    fileStrand(store, "strand:other", "Tokyo", [rootOf("o", "class:o", CHAL)]);

    // The ratify EARNS credit (fresh external source, cap 0.9) ⇒ the engine DERIVES the
    // agreement set itself and records it on the corroboration event (OD-8).
    db.ratify({ strandId: target.id, externalStamp: identity.stampFor("src:ext" as SourceId) });

    const events = corroboration.all();
    expect(events.length).toBe(1);
    const derived = events[0]!.corroboratingStrandIds.map(String);
    expect(derived).toContain(String(agree.id));
    expect(derived).not.toContain(String(asStrandId("strand:dem")));
    expect(derived).not.toContain(String(asStrandId("strand:other")));
    expect(derived).not.toContain(String(target.id)); // target excludes itself
  });
});
