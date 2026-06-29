/**
 * disownHardening.test.ts — THE FOUR UNDO-ENGINE HARDENINGS (roadmap item 4, FINAL).
 *
 * One+ test per hardening (ARCHITECTURE.md §4 + the Undo/Provenance guarantee):
 *
 *  1. WEAK-INFLUENCE EDGES → REVIEW QUEUE (uncited-influence channel): a
 *     consulted-but-not-cited strand on a disowned source emits a REVIEW-QUEUE entry,
 *     NOT a demotion; deduped; idempotent re-sweep emits nothing.
 *  2. TOTAL-LEDGER INVARIANT + RECONCILIATION (off-ledger reputation channel): an
 *     off-ledger α gain is flagged DRIFTED; a fully-recorded source reconciles `ok`;
 *     a decayed source is a `decayGap`, not drift; the write-time invariant throws on
 *     an unrecorded gain.
 *  3. ADJUDICATION-PROVENANCE + DISPUTE RE-OPENING (threshold-effects channel): a
 *     tainted strand that TIPPED a decisive margin re-opens the dispute as PENDING; a
 *     winner with a comfortable margin is NOT re-opened.
 *  4. FALSE-DISOWN-AS-SUPPRESSION PROTECTION (abuse): a derived strand with surviving
 *     independent corroboration stays LIVE; one resting solely on tainted input is
 *     demoted.
 *
 * Exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  downstreamDisownSweep,
  createReputationLedger,
  createMemoryStore,
  createWeakInfluenceLedger,
  createAdjudicationProvenanceLedger,
  createCorroborationLedger,
  createPendingLedger,
  reconcileLedger,
  assertRatifyEmitsEvent,
  OffLedgerReputationError,
  generatePassport,
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
  ContradictionSetId,
  SourceId,
  Unit,
  EpochMs,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  ContentHash,
  StrandStore,
  ReputationLedger,
  AlphaSnapshot,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

function makeStrand(opts: {
  idRaw: string;
  contentHashRaw?: string;
  origin?: FactOrigin;
  roots: ReadonlyArray<{ classRaw: string; sourceIdRaw: string | null; rootIdRaw?: string }>;
}): Strand {
  const { idRaw, origin = FactOrigin.OBSERVED, roots } = opts;
  const provenance: ProvenanceRoot[] = roots.map((r, i) => ({
    rootId: (r.rootIdRaw ?? `${idRaw}#root${i}`) as ProvenanceRootId,
    independenceClass: r.classRaw as IndependenceClassId,
    sourceId: r.sourceIdRaw === null ? null : (r.sourceIdRaw as SourceId),
    establishedAt: NOW,
  }));
  return {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { note: idRaw },
    content_hash: (opts.contentHashRaw ?? `hash:${idRaw}`) as ContentHash,
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
  // Pin the decay-on-read clock to the test's logical NOW so reads at NOW are Δt=0
  // (the fixtures earn at the synthetic NOW; without pinning, the default Date.now()
  // clock would treat the whole gap to the real wall clock as dormancy, decaying every
  // earned LCB toward the prior and intermittently flaking the score assertions).
  return createReputationLedger(() => cap as Unit, undefined, () => NOW);
}

// ===========================================================================
// HARDENING 1 — WEAK-INFLUENCE EDGES → REVIEW QUEUE (uncited-influence channel)
// ===========================================================================

describe("HARDENING 1 — weak-influence review queue", () => {
  it("a consulted-but-not-cited work of a disowned source is QUEUED FOR REVIEW, not demoted", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const weak = createWeakInfluenceLedger();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // An influenced work that merely CONSULTED the seed — NO derivation edge.
    const influenced = makeStrand({
      idRaw: "s:influenced",
      roots: [{ classRaw: "class:OTHER", sourceIdRaw: "src:author" }],
    });
    store.putStrand(seed);
    store.putStrand(influenced);
    weak.record({
      strandId: influenced.id,
      consultedStrandId: seed.id,
      context: "read but not cited",
      at: NOW,
    });

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      weakInfluence: weak,
    });

    // Queued for human review, NOT auto-demoted.
    expect(res.reviewQueued.map((r) => String(r.strandId))).toContain(String(influenced.id));
    expect(res.reviewQueued[0]!.reason).toBe("WEAK_INFLUENCE_REVIEW");
    expect(res.reviewQueued[0]!.disownedSource).toBe(fraud);
    expect(res.demotedDownstream).not.toContain(influenced.id);
    expect(store.getStrand(influenced.id)!.fact_state).toBe(FactState.LIVE);
  });

  it("dedupes by influenced strand and is IDEMPOTENT across re-sweeps", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const weak = createWeakInfluenceLedger();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const seed2 = makeStrand({ idRaw: "s:seed2", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const influenced = makeStrand({
      idRaw: "s:influenced",
      roots: [{ classRaw: "class:OTHER", sourceIdRaw: "src:author" }],
    });
    store.putStrand(seed);
    store.putStrand(seed2);
    store.putStrand(influenced);
    // The SAME influenced work consulted BOTH seeds (two edges, one work).
    weak.record({ strandId: influenced.id, consultedStrandId: seed.id, context: "c1", at: NOW });
    weak.record({ strandId: influenced.id, consultedStrandId: seed2.id, context: "c2", at: NOW });

    const first = downstreamDisownSweep(fraud, [seed.id, seed2.id], store, ledger, NOW, undefined, undefined, {
      weakInfluence: weak,
    });
    // Deduped: ONE review entry for the one influenced work, not two.
    expect(first.reviewQueued.length).toBe(1);

    // A second sweep of the same source is a no-op (direct-seed idempotency) AND the
    // weak-influence guard would emit nothing even if re-walked.
    const second = downstreamDisownSweep(fraud, [seed.id, seed2.id], store, ledger, NOW, undefined, undefined, {
      weakInfluence: weak,
    });
    expect(second.reviewQueued).toEqual([]);
  });
});

// ===========================================================================
// HARDENING 2 — TOTAL-LEDGER INVARIANT + RECONCILIATION (off-ledger reputation)
// ===========================================================================

describe("HARDENING 2 — reconciliation audit + write-time invariant", () => {
  it("a fully-recorded source reconciles OK; an off-ledger gain is flagged DRIFTED", () => {
    const corrob = createCorroborationLedger();
    const recorded = "src:recorded" as SourceId;
    const offLedger = "src:offledger" as SourceId;

    // `recorded` earned 0.5 of α-mass, with a matching event.
    corrob.record({
      ratifiedStrandId: asStrandId("s:1"),
      corroboratingStrandIds: [asStrandId("s:w")],
      beneficiarySourceId: recorded,
      reputationDelta: 0.5,
      at: NOW,
    });

    const snapshots: AlphaSnapshot[] = [
      { sourceId: recorded, alpha: 1.5 }, // earned 0.5, explained 0.5 ⇒ reconciled
      { sourceId: offLedger, alpha: 1.7 }, // earned 0.7, explained 0   ⇒ DRIFTED
    ];

    const report = reconcileLedger(snapshots, corrob);

    expect(report.ok).toBe(false);
    expect(report.drifted.map((d) => String(d.sourceId))).toContain(String(offLedger));
    expect(report.drifted.map((d) => String(d.sourceId))).not.toContain(String(recorded));
    expect(report.reconciled.map((d) => String(d.sourceId))).toContain(String(recorded));
  });

  it("a DECAYED source (earned < explained) is a decayGap, NOT drift", () => {
    const corrob = createCorroborationLedger();
    const decayed = "src:decayed" as SourceId;
    // Recorded 0.8 of α-mass historically; live α has since decayed to 1.3 (earned 0.3).
    corrob.record({
      ratifiedStrandId: asStrandId("s:1"),
      corroboratingStrandIds: [asStrandId("s:w")],
      beneficiarySourceId: decayed,
      reputationDelta: 0.8,
      at: NOW,
    });

    const report = reconcileLedger([{ sourceId: decayed, alpha: 1.3 }], corrob);

    // earned 0.3 < explained 0.8 ⇒ decayGap, and NOT drift ⇒ ok.
    expect(report.ok).toBe(true);
    expect(report.drifted).toEqual([]);
    expect(report.decayGapped.map((d) => String(d.sourceId))).toContain(String(decayed));
  });

  it("a REVERSED event no longer explains live mass (both sides drop, stays reconciled)", () => {
    const corrob = createCorroborationLedger();
    const src = "src:s" as SourceId;
    const ev = corrob.record({
      ratifiedStrandId: asStrandId("s:1"),
      corroboratingStrandIds: [asStrandId("s:w")],
      beneficiarySourceId: src,
      reputationDelta: 0.5,
      at: NOW,
    });
    corrob.markReversed(ev.eventId); // disown reversed it; live α was lowered to 1.0 too.

    const report = reconcileLedger([{ sourceId: src, alpha: 1.0 }], corrob);
    expect(report.ok).toBe(true);
    expect(report.reconciled.map((d) => String(d.sourceId))).toContain(String(src));
  });

  it("the write-time invariant THROWS on a positive gain that named corroborators but recorded nothing", () => {
    const src = "src:s" as SourceId;
    // Positive gain + named corroborators + NOT recorded ⇒ OffLedgerReputationError.
    expect(() => assertRatifyEmitsEvent(src, 0.5, true, false)).toThrow(OffLedgerReputationError);
    // Recorded ⇒ OK; no named corroborators ⇒ no obligation; zero gain ⇒ nothing to record.
    expect(() => assertRatifyEmitsEvent(src, 0.5, true, true)).not.toThrow();
    expect(() => assertRatifyEmitsEvent(src, 0.5, false, false)).not.toThrow();
    expect(() => assertRatifyEmitsEvent(src, 0, true, false)).not.toThrow();
  });
});

// ===========================================================================
// HARDENING 3 — ADJUDICATION-PROVENANCE + DISPUTE RE-OPENING (threshold effects)
// ===========================================================================

describe("HARDENING 3 — adjudication re-opening on margin collapse", () => {
  const CSID = "cset:berlin#capital_of" as ContradictionSetId;

  it("a tainted strand that TIPPED a decisive margin RE-OPENS the dispute as PENDING", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const adj = createAdjudicationProvenanceLedger();
    const pending = createPendingLedger();
    const systemSigner = generatePassport();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const winner = makeStrand({ idRaw: "s:winner", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(seed);
    store.putStrand(winner);

    // The winner's margin (0.4) was supplied SOLELY by tainted contributors (the seed +
    // the winner itself, both in the disowned class). Removing them collapses it to 0.
    adj.record({
      contradictionSetId: CSID,
      attribute: ATTR,
      winner: winner.id,
      margin: 0.4,
      contributingStrandIds: [winner.id, seed.id],
      at: NOW,
    });

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      adjudicationProvenance: adj,
      pending,
      systemSigner,
      decisiveMargin: 0.3,
    });

    expect(res.reopenedDisputes).toContain(CSID);
    // The dispute is back in the human queue with reason REOPENED_BY_DISOWN.
    const open = pending.listPending();
    const reopened = open.find((p) => p.contradictionSetId === CSID);
    expect(reopened).toBeDefined();
    expect(reopened!.reason).toBe("REOPENED_BY_DISOWN");
  });

  it("a winner with a COMFORTABLE surviving margin is NOT re-opened", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const adj = createAdjudicationProvenanceLedger();
    const pending = createPendingLedger();
    const systemSigner = generatePassport();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const winner = makeStrand({ idRaw: "s:winner", roots: [{ classRaw: "class:CLEAN", sourceIdRaw: "src:clean" }] });
    const helper = makeStrand({ idRaw: "s:helper", roots: [{ classRaw: "class:CLEAN", sourceIdRaw: "src:clean" }] });
    store.putStrand(seed);
    store.putStrand(winner);
    store.putStrand(helper);

    // Margin 0.9 from FOUR contributors, only ONE of which (the seed) is tainted.
    // Surviving margin 0.9·(3/4) = 0.675 >= 0.3 ⇒ stays resolved.
    adj.record({
      contradictionSetId: CSID,
      attribute: ATTR,
      winner: winner.id,
      margin: 0.9,
      contributingStrandIds: [winner.id, helper.id, asStrandId("s:x"), seed.id],
      at: NOW,
    });

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      adjudicationProvenance: adj,
      pending,
      systemSigner,
      decisiveMargin: 0.3,
    });

    expect(res.reopenedDisputes).not.toContain(CSID);
    expect(pending.listPending().find((p) => p.contradictionSetId === CSID)).toBeUndefined();
  });

  it("re-opening is IDEMPOTENT across re-sweeps", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const adj = createAdjudicationProvenanceLedger();
    const pending = createPendingLedger();
    const systemSigner = generatePassport();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const winner = makeStrand({ idRaw: "s:winner", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(seed);
    store.putStrand(winner);
    adj.record({
      contradictionSetId: CSID,
      attribute: ATTR,
      winner: winner.id,
      margin: 0.4,
      contributingStrandIds: [winner.id, seed.id],
      at: NOW,
    });

    const deps = { adjudicationProvenance: adj, pending, systemSigner, decisiveMargin: 0.3 };
    const first = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, deps);
    expect(first.reopenedDisputes).toContain(CSID);

    // Second sweep: direct-seed idempotency makes it a complete no-op, and even the
    // adjudication guard would not re-open twice.
    const second = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, deps);
    expect(second.reopenedDisputes).toEqual([]);
    // Exactly ONE PENDING for the dispute, not two.
    expect(pending.listPending().filter((p) => p.contradictionSetId === CSID).length).toBe(1);
  });
});

// ===========================================================================
// HARDENING 4 — FALSE-DISOWN-AS-SUPPRESSION PROTECTION (abuse)
// ===========================================================================

describe("HARDENING 4 — false-disown survival check", () => {
  it("a derived strand with SURVIVING independent corroboration stays LIVE", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // A derived strand with TWO disjoint INDEPENDENT (non-tainted) corroborating
    // classes — its existence does not solely rest on the tainted input.
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [
        { classRaw: "class:IND1", sourceIdRaw: "src:i1", rootIdRaw: "r1" },
        { classRaw: "class:IND2", sourceIdRaw: "src:i2", rootIdRaw: "r2" },
      ],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      checkSurvivingSupport: true, // minSurvivingSupport defaults to 2
    });

    expect(res.survivedDemotion).toContain(derived.id);
    expect(res.demotedDownstream).not.toContain(derived.id);
    expect(store.getStrand(derived.id)!.fact_state).toBe(FactState.LIVE);
  });

  it("a derived strand resting SOLELY on tainted input is still DEMOTED", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // Backed ONLY by the tainted class ⇒ no surviving independent support.
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: fraud }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW, undefined, undefined, {
      checkSurvivingSupport: true,
    });

    expect(res.survivedDemotion).not.toContain(derived.id);
    expect(res.demotedDownstream).toContain(derived.id);
    expect(store.getStrand(derived.id)!.fact_state).toBe(FactState.DEMOTED);
  });

  it("with the check OFF (default), a single-independent-class derivative is DEMOTED (back-compat)", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:IND1", sourceIdRaw: "src:i1" }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    // No hardening object ⇒ the prior demote-every-derivative contract is unchanged.
    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);
    expect(res.demotedDownstream).toContain(derived.id);
    expect(res.survivedDemotion).toEqual([]);
  });
});
