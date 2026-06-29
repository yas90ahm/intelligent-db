/**
 * disownCreditReversal.test.ts — BATCH 2 (F2 full-taint-closure reversal + F3 guard).
 *
 * F2 widens the corroboration-credit / weak-influence reversal target from the one-hop
 * `seedClawedBack` to the FULL demoted taint closure (`taintedStrandIds` = seed ∪ every
 * demoted-downstream strand) that the backward-DERIVATION BFS already materializes. F3
 * keeps the reversal honest: credit is reversed ONLY where the engine-recorded agreement
 * set intersects the demoted closure — never on agreement alone (a coincidental
 * independent agreer is SAFE-DEFER, never clawed).
 *
 *  1. TWO-HOP-RELAY reversal (AC-3): a beneficiary credited for corroborating a strand
 *     TWO DERIVATION hops below the seed has exactly its recorded delta reversed. Fails
 *     on the pre-F2 one-hop `seedClawedBack` lookup; passes after the closure swap.
 *  2. pt-3 NON-CLAW guard (AC-4, BLOCKING): a coincidental independent agreer (untainted
 *     class, no DERIVATION edge, no recorded funding link into the closure) stays LIVE,
 *     keeps its reputation, and is NOT in the reversed-event set — SAFE-DEFER.
 *  3. WEAK-INFLUENCE over the full closure (AC-5): a work consulting a DEMOTED-downstream
 *     tainted strand is QUEUED FOR HUMAN REVIEW (never auto-demoted); idempotent.
 *
 * Exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  createCorroborationLedger,
  createReputationLedger,
  createWeakInfluenceLedger,
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
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

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
    register: null,
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
  // Freeze the decay clock to NOW so `scoreOf`'s pure decay-on-read is deterministic:
  // the default Date.now() clock makes two reads of an UNCHANGED source differ in the
  // ~15th decimal, flaking the `toBe(earnedScore)` invariance check below.
  return createReputationLedger(() => cap as Unit, undefined, () => NOW);
}

// ===========================================================================
// 1. TWO-HOP-RELAY — credit on a strand TWO DERIVATION hops below the seed (AC-3)
// ===========================================================================

describe("F2 — Two-Hop-Relay: credit on a demoted-downstream strand IS reversed", () => {
  it("reverses exactly the recorded delta for a beneficiary crediting a strand two hops down", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const corrob = createCorroborationLedger();
    const fraud = "src:fraud" as SourceId;
    const beneficiary = "src:beneficiary" as SourceId;

    // Seed S (source A) <- D1 (DERIVATION->S) <- D2 (DERIVATION->D1).
    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const d1 = makeStrand({ idRaw: "s:d1", roots: [{ classRaw: "class:DERIVED", sourceIdRaw: "src:author1" }] });
    const d2 = makeStrand({ idRaw: "s:d2", roots: [{ classRaw: "class:DERIVED", sourceIdRaw: "src:author2" }] });
    store.putStrand(seed);
    store.putStrand(d1);
    store.putStrand(d2);
    store.putEdge(derivationEdge(d1.id, seed.id));
    store.putEdge(derivationEdge(d2.id, d1.id));

    // The beneficiary earns reputation for AGREEING with D2 (two hops below the seed).
    const beforeScore = ledger.scoreOf(beneficiary);
    const beforeAlpha = ledger.stateOf(beneficiary)?.alpha ?? 1;
    const after = ledger.ratify(beneficiary, NOW);
    const deltaAlpha = after.alpha - beforeAlpha;
    expect(deltaAlpha).toBeGreaterThan(0);

    const ev = corrob.record({
      ratifiedStrandId: asStrandId("s:relay-claim"),
      corroboratingStrandIds: [d2.id], // funded by the DEMOTED-downstream strand, not the seed
      beneficiarySourceId: beneficiary,
      reputationDelta: deltaAlpha,
      at: NOW,
    });
    expect(ledger.scoreOf(beneficiary)).toBeGreaterThan(beforeScore);

    // Disown A. The BFS demotes D1 and D2 (closure), so the event funded by D2 is in
    // `taintedStrandIds` and its credit is reversed exactly once.
    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);

    expect(res.demotedDownstream.map(String)).toEqual(
      expect.arrayContaining([String(d1.id), String(d2.id)]),
    );
    // The reversal fires over the FULL closure (would MISS on the pre-F2 one-hop seed).
    expect(res.reversedCorroborationEventIds).toContain(ev.eventId);
    expect(ledger.scoreOf(beneficiary)).toBeCloseTo(beforeScore, 10);
    expect(ledger.stateOf(beneficiary)!.alpha).toBeCloseTo(beforeAlpha, 10);
  });
});

// ===========================================================================
// 2. pt-3 NON-CLAW guard — a coincidental independent agreer is NOT clawed (AC-4)
// ===========================================================================

describe("F3 — pt-3: a coincidental independent agreer is SAFE-DEFER, never clawed", () => {
  it("an untainted-class agreer with no funding link into the closure keeps everything", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const corrob = createCorroborationLedger();
    const fraud = "src:fraud" as SourceId;
    const agreerSrc = "src:coincidental" as SourceId; // genuinely independent, class Y

    // Seed S (source A, class X) and an UNRELATED strand the agreer's credit was funded by.
    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:X", sourceIdRaw: fraud }] });
    // The agreer's OWN strand: different class, NO derivation edge to the seed.
    const agreer = makeStrand({ idRaw: "s:agreer", roots: [{ classRaw: "class:Y", sourceIdRaw: agreerSrc }] });
    const unrelated = makeStrand({
      idRaw: "s:unrelated",
      roots: [{ classRaw: "class:Z", sourceIdRaw: "src:third" }],
    });
    store.putStrand(seed);
    store.putStrand(agreer);
    store.putStrand(unrelated);

    // The agreer earned credit funded by a THIRD independent strand — not the seed/closure.
    const after = ledger.ratify(agreerSrc, NOW);
    const earnedScore = ledger.scoreOf(agreerSrc);
    const ev = corrob.record({
      ratifiedStrandId: agreer.id,
      corroboratingStrandIds: [unrelated.id], // NOT a strand of the disowned closure
      beneficiarySourceId: agreerSrc,
      reputationDelta: after.alpha - 1,
      at: NOW,
    });

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, corrob);

    // Not demoted, source not contradicted, reputation intact, event NOT reversed.
    expect(store.getStrand(agreer.id)!.fact_state).toBe(FactState.LIVE);
    expect(res.demotedDownstream).not.toContain(agreer.id);
    expect(res.contradictedSources.map(String)).not.toContain(String(agreerSrc));
    expect(res.reversedCorroborationEventIds).not.toContain(ev.eventId);
    expect(ledger.scoreOf(agreerSrc)).toBe(earnedScore);
  });
});

// ===========================================================================
// 3. WEAK-INFLUENCE over the FULL closure — consulting a DEMOTED-downstream strand (AC-5)
// ===========================================================================

describe("F2 — weak-influence covers the full demoted closure", () => {
  it("a work consulting a demoted-downstream tainted strand is QUEUED for review, idempotently", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const weak = createWeakInfluenceLedger();
    const fraud = "src:fraud" as SourceId;

    // Seed S (source A) <- D1 (DERIVATION->S). D1 will be demoted-downstream.
    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const d1 = makeStrand({ idRaw: "s:d1", roots: [{ classRaw: "class:DERIVED", sourceIdRaw: "src:author1" }] });
    // An influenced work that CONSULTED D1 (the demoted-downstream strand) — no DERIVATION edge.
    const influenced = makeStrand({
      idRaw: "s:influenced",
      roots: [{ classRaw: "class:OTHER", sourceIdRaw: "src:reader" }],
    });
    store.putStrand(seed);
    store.putStrand(d1);
    store.putStrand(influenced);
    store.putEdge(derivationEdge(d1.id, seed.id));
    weak.record({
      strandId: influenced.id,
      consultedStrandId: d1.id, // a DEMOTED-downstream strand, NOT the seed
      context: "read but not cited",
      at: NOW,
    });

    const first = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      weakInfluence: weak,
    });

    expect(first.demotedDownstream).toContain(d1.id);
    expect(first.reviewQueued.map((r) => String(r.strandId))).toContain(String(influenced.id));
    expect(first.reviewQueued[0]!.reason).toBe("WEAK_INFLUENCE_REVIEW");
    // Never auto-demoted — uncited influence is HUMAN-review-only.
    expect(first.demotedDownstream).not.toContain(influenced.id);
    expect(store.getStrand(influenced.id)!.fact_state).toBe(FactState.LIVE);

    // Idempotent: a second sweep of the already-disowned source queues nothing further.
    const second = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      weakInfluence: weak,
    });
    expect(second.reviewQueued).toEqual([]);
  });
});
