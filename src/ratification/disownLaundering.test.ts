/**
 * disownLaundering.test.ts — BATCH 2 follow-on coverage for the F2 full-taint
 * disown reversal + F3 non-claw guard. Independent of `disownCreditReversal.test.ts`;
 * these assert the SAME three load-bearing properties from a fresh setup so a
 * regression in either the closure swap or the intersection guard fails here too:
 *
 *  (a) LAUNDERER CLAWED: a beneficiary credited (via a recorded corroboration event)
 *      for agreeing with a DERIVED strand that is tainted through its DERIVATION
 *      closure has EXACTLY its recorded delta reversed, and the derived launderer
 *      strand is itself demoted (never deleted).
 *  (b) COINCIDENTAL AGREER SPARED (the F3 guard, BLOCKING): a genuinely-independent
 *      agreer in an untainted class, whose credit event names NO strand of the
 *      tainted closure, stays LIVE, keeps its reputation, and its event is NOT
 *      reversed — SAFE-DEFER, never punished for coincidental agreement.
 *  (c) IDEMPOTENT SECOND DISOWN: re-running the sweep on the already-disowned source
 *      is a COMPLETE no-op — nothing re-demoted, no further credit reversed, the
 *      beneficiary's (already-clawed) score unchanged — proving the reversal fires
 *      at most once across any number of sweeps.
 *
 * Exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  createCorroborationLedger,
  createReputationLedger,
  createMemoryStore,
  downstreamDisownSweep,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "../index.js";

import type {
  Strand,
  StrandId,
  Edge,
  EntityId,
  AttributeKey,
  SourceId,
  Unit,
  EpochMs,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  ContentHash,
  StrandStore,
  ReputationLedger,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:paris" as EntityId;
const ATTR = "paris#capital_of" as AttributeKey;

function makeStrand(opts: {
  idRaw: string;
  origin?: FactOrigin;
  roots: ReadonlyArray<{ classRaw: string; sourceIdRaw: string | null }>;
}): Strand {
  const { idRaw, origin = FactOrigin.OBSERVED, roots } = opts;
  const provenance: ProvenanceRoot[] = roots.map((r, i) => ({
    rootId: `${idRaw}#root${i}` as ProvenanceRootId,
    independenceClass: r.classRaw as IndependenceClassId,
    sourceId: r.sourceIdRaw === null ? null : (r.sourceIdRaw as SourceId),
    establishedAt: NOW,
  }));
  return {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { note: idRaw },
    content_hash: `hash:${idRaw}` as ContentHash,
    origin,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance,
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}

/** A DERIVATION edge `derived -> witness` (derived RESTED ON witness). */
function derivationEdge(derived: StrandId, witness: StrandId): Edge {
  return {
    id: asEdgeId(`deriv:${String(derived)}->${String(witness)}`),
    from: derived,
    to: witness,
    edgeType: EdgeType.DERIVATION,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w: 1 as Unit,
    out_weight_sum: 1 as Unit,
  };
}

function ledgerWithCap(cap = 0.9): ReputationLedger {
  // Freeze the decay clock to NOW so `scoreOf`'s pure decay-on-read is deterministic
  // (the default Date.now() clock would make two reads of an UNCHANGED source differ
  // in the ~15th decimal — a real `toBe` flake). Witness invariance under exact equality.
  return createReputationLedger(() => cap as Unit, undefined, () => NOW);
}

// ===========================================================================
// (a) LAUNDERER CLAWED — credit for agreeing with a DERIVED tainted strand is reversed
// ===========================================================================

describe("F2 — a derived launderer's corroboration credit IS reversed", () => {
  it("reverses the recorded delta AND demotes the derived strand the credit rested on", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const corrob = createCorroborationLedger();
    const fraud = "src:fraud" as SourceId;
    const launderer = "src:launderer" as SourceId;

    // Seed S (fraud, class:A) <- D (DERIVATION -> S). D rests on the fraudulent seed.
    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:DERIVED", sourceIdRaw: "src:author" }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    // The launderer earns reputation for AGREEING with the derived strand; the credit
    // link is recorded at earning time (the substrate the graph alone could not hold).
    const beforeScore = ledger.scoreOf(launderer);
    const beforeAlpha = ledger.stateOf(launderer)?.alpha ?? 1;
    const after = ledger.ratify(launderer, NOW);
    const delta = after.alpha - beforeAlpha;
    expect(delta).toBeGreaterThan(0);
    const ev = corrob.record({
      ratifiedStrandId: asStrandId("s:launder-claim"),
      corroboratingStrandIds: [derived.id],
      beneficiarySourceId: launderer,
      reputationDelta: delta,
      at: NOW,
    });
    expect(ledger.scoreOf(launderer)).toBeGreaterThan(beforeScore);

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);

    // Derived strand demoted (never deleted: archive stub intact), credit reversed exactly.
    expect(res.demotedDownstream.map(String)).toContain(String(derived.id));
    const persisted = store.getStrand(derived.id)!;
    expect(persisted.fact_state).toBe(FactState.DEMOTED);
    expect(persisted.content_hash).toBe(derived.content_hash); // stub immortal
    expect(res.reversedCorroborationEventIds).toContain(ev.eventId);
    expect(corrob.isReversed(ev.eventId)).toBe(true);
    expect(ledger.scoreOf(launderer)).toBeCloseTo(beforeScore, 10);
    expect(ledger.stateOf(launderer)!.alpha).toBeCloseTo(beforeAlpha, 10);
  });
});

// ===========================================================================
// (b) COINCIDENTAL AGREER SPARED — the F3 intersection guard (BLOCKING)
// ===========================================================================

describe("F3 — a coincidental independent agreer is NEVER clawed (SAFE-DEFER)", () => {
  it("an untainted-class agreer with no funding link into the closure keeps reputation, stays LIVE, event not reversed", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const corrob = createCorroborationLedger();
    const fraud = "src:fraud" as SourceId;
    const honest = "src:honest" as SourceId;

    // Disowned seed (class:X). The honest source observed independently (class:Y) and
    // was credited for agreement funded by its OWN independent strand — NOT the seed.
    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:X", sourceIdRaw: fraud }] });
    const honestStrand = makeStrand({ idRaw: "s:honest", roots: [{ classRaw: "class:Y", sourceIdRaw: honest }] });
    const ownWitness = makeStrand({
      idRaw: "s:own-witness",
      roots: [{ classRaw: "class:Y2", sourceIdRaw: "src:other" }],
    });
    store.putStrand(seed);
    store.putStrand(honestStrand);
    store.putStrand(ownWitness);
    // NO DERIVATION edge from the honest strand to the seed: genuinely independent.

    const after = ledger.ratify(honest, NOW);
    const earnedScore = ledger.scoreOf(honest);
    const earnedAlpha = ledger.stateOf(honest)!.alpha;
    const ev = corrob.record({
      ratifiedStrandId: honestStrand.id,
      corroboratingStrandIds: [ownWitness.id], // NOT a strand of the disowned closure
      beneficiarySourceId: honest,
      reputationDelta: after.alpha - 1,
      at: NOW,
    });

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);

    expect(store.getStrand(honestStrand.id)!.fact_state).toBe(FactState.LIVE);
    expect(res.demotedDownstream.map(String)).not.toContain(String(honestStrand.id));
    expect(res.contradictedSources.map(String)).not.toContain(String(honest));
    expect(res.reversedCorroborationEventIds).not.toContain(ev.eventId);
    expect(corrob.isReversed(ev.eventId)).toBe(false);
    expect(ledger.scoreOf(honest)).toBe(earnedScore);
    expect(ledger.stateOf(honest)!.alpha).toBeCloseTo(earnedAlpha, 10);
  });
});

// ===========================================================================
// (c) IDEMPOTENT SECOND DISOWN — a complete no-op
// ===========================================================================

describe("disown idempotency — a second sweep of the same source is a complete no-op", () => {
  it("re-demotes nothing, reverses no further credit, and leaves the clawed score unchanged", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const corrob = createCorroborationLedger();
    const fraud = "src:fraud" as SourceId;
    const launderer = "src:launderer" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:DERIVED", sourceIdRaw: "src:author" }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const beforeAlpha = ledger.stateOf(launderer)?.alpha ?? 1;
    const after = ledger.ratify(launderer, NOW);
    const ev = corrob.record({
      ratifiedStrandId: asStrandId("s:launder-claim"),
      corroboratingStrandIds: [derived.id],
      beneficiarySourceId: launderer,
      reputationDelta: after.alpha - beforeAlpha,
      at: NOW,
    });

    // FIRST sweep: claws back direct seed, demotes the derived strand, reverses credit.
    const first = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);
    expect(first.seedClawedBack.length).toBeGreaterThan(0);
    expect(first.demotedDownstream.map(String)).toContain(String(derived.id));
    expect(first.reversedCorroborationEventIds).toContain(ev.eventId);
    const scoreAfterFirst = ledger.scoreOf(launderer);
    const alphaAfterFirst = ledger.stateOf(launderer)!.alpha;

    // SECOND sweep of the SAME source: a complete no-op down every channel.
    const second = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);
    expect(second.seedClawedBack).toEqual([]);
    expect(second.demotedDownstream).toEqual([]);
    expect(second.contradictedSources).toEqual([]);
    expect(second.reversedCorroborationEventIds).toEqual([]);
    expect(second.visitedCount).toBe(0);

    // The reversed credit is not double-applied: the score is exactly where the first
    // sweep left it (one reversal, ever).
    expect(ledger.scoreOf(launderer)).toBe(scoreAfterFirst);
    expect(ledger.stateOf(launderer)!.alpha).toBeCloseTo(alphaAfterFirst, 10);
    // The event remains reversed but is not re-counted by the idempotency guard.
    expect(corrob.isReversed(ev.eventId)).toBe(true);
  });
});
