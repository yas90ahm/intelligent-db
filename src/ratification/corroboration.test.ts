/**
 * corroboration.test.ts — THE CORROBORATION-EVENT LEDGER + the precise per-event
 * credit reversal that CLOSES the former crack-A in the disown sweep.
 *
 * Pins every verifier invariant:
 *  - RECORD FIDELITY: the recorded `reputationDelta` equals the ACTUAL applied score
 *    change at earning time (after.score - before.score).
 *  - EXACT: a beneficiary who earned delta d via corroboration by a strand that is
 *    later disowned has EXACTLY d reversed (clamped at floor 0).
 *  - BOUNDED: a beneficiary whose credit was NOT funded by a tainted strand has no
 *    matching event and is UNTOUCHED (coincidental independent agreement never punished).
 *  - IDEMPOTENT: each event reversed at most once; a second disown is a credit no-op.
 *  - Append-only, deterministic; `reverseCredit` exact-subtract + floor clamp;
 *    `eventsIntersecting` intersection + dedupe.
 *
 * Exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  createCorroborationLedger,
  createReputationLedger,
  createMemoryStore,
  downstreamDisownSweep,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  Strand,
  StrandId,
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

function ledgerWithCap(cap = 0.9): ReputationLedger {
  // Freeze the decay clock to NOW so `scoreOf`'s pure decay-on-read is deterministic:
  // the default Date.now() clock makes two reads of an UNCHANGED source differ in the
  // ~15th decimal, flaking the `toBe(...)` score-invariance assertions below.
  return createReputationLedger(() => cap as Unit, undefined, () => NOW);
}

/** Earn a source up off the floor so a later reversal is observable. */
function earn(ledger: ReputationLedger, src: SourceId, n = 20): void {
  for (let i = 0; i < n; i++) ledger.ratify(src, NOW);
}

// ---------------------------------------------------------------------------
// Ledger unit behavior
// ---------------------------------------------------------------------------

describe("CorroborationLedger — append-only + deterministic ids", () => {
  it("mints corrob:<seq> ids in append order and preserves insertion order in all()", () => {
    const c = createCorroborationLedger();
    const a = c.record({
      ratifiedStrandId: "s:x" as StrandId,
      corroboratingStrandIds: ["s:a" as StrandId],
      beneficiarySourceId: "src:b" as SourceId,
      reputationDelta: 0.1,
      at: NOW,
    });
    const b = c.record({
      ratifiedStrandId: "s:y" as StrandId,
      corroboratingStrandIds: ["s:a" as StrandId],
      beneficiarySourceId: "src:b" as SourceId,
      reputationDelta: 0.2,
      at: NOW,
    });
    expect(a.eventId).toBe("corrob:0");
    expect(b.eventId).toBe("corrob:1");
    expect(c.all().map((e) => e.eventId)).toEqual(["corrob:0", "corrob:1"]);
  });

  it("takes a supplied eventId verbatim", () => {
    const c = createCorroborationLedger();
    const e = c.record({
      eventId: "custom:1",
      ratifiedStrandId: "s:x" as StrandId,
      corroboratingStrandIds: ["s:a" as StrandId],
      beneficiarySourceId: "src:b" as SourceId,
      reputationDelta: 0.1,
      at: NOW,
    });
    expect(e.eventId).toBe("custom:1");
  });
});

describe("CorroborationLedger — eventsIntersecting / eventsByCorroboratingStrand", () => {
  it("finds intersecting events and dedupes by eventId in append order", () => {
    const c = createCorroborationLedger();
    c.record({ ratifiedStrandId: "s:x" as StrandId, corroboratingStrandIds: ["s:a" as StrandId, "s:b" as StrandId], beneficiarySourceId: "src:1" as SourceId, reputationDelta: 0.1, at: NOW });
    c.record({ ratifiedStrandId: "s:y" as StrandId, corroboratingStrandIds: ["s:c" as StrandId], beneficiarySourceId: "src:2" as SourceId, reputationDelta: 0.2, at: NOW });
    c.record({ ratifiedStrandId: "s:z" as StrandId, corroboratingStrandIds: ["s:b" as StrandId], beneficiarySourceId: "src:3" as SourceId, reputationDelta: 0.3, at: NOW });

    // Intersect {s:a, s:b}: event 0 (via s:a AND s:b — counted once) and event 2 (s:b).
    const hits = c.eventsIntersecting(["s:a" as StrandId, "s:b" as StrandId]);
    expect(hits.map((e) => e.eventId)).toEqual(["corrob:0", "corrob:2"]);

    expect(c.eventsByCorroboratingStrand("s:b" as StrandId).map((e) => e.eventId)).toEqual([
      "corrob:0",
      "corrob:2",
    ]);
    expect(c.eventsByCorroboratingStrand("s:nope" as StrandId)).toEqual([]);
  });

  it("markReversed is the idempotency guard (true once, false after)", () => {
    const c = createCorroborationLedger();
    const e = c.record({ ratifiedStrandId: "s:x" as StrandId, corroboratingStrandIds: ["s:a" as StrandId], beneficiarySourceId: "src:1" as SourceId, reputationDelta: 0.1, at: NOW });
    expect(c.isReversed(e.eventId)).toBe(false);
    expect(c.markReversed(e.eventId)).toBe(true);
    expect(c.markReversed(e.eventId)).toBe(false);
    expect(c.isReversed(e.eventId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reverseCredit — exact subtract + floor clamp
// ---------------------------------------------------------------------------

describe("ReputationLedger.reverseCredit — exact α-mass subtract, prior clamp", () => {
  it("subtracts EXACTLY the given α-mass (the recorded earned w)", () => {
    // Under the Beta model `reverseCredit` subtracts the recorded α-mass (the `w`
    // added at earning time) from α, so the exact disown reversal restores α exactly.
    const ledger = ledgerWithCap();
    const src = "src:b" as SourceId;
    earn(ledger, src);
    const beforeAlpha = ledger.stateOf(src)!.alpha;
    const delta = 0.123;
    const after = ledger.reverseCredit(src, delta, NOW);
    expect(after.alpha).toBeCloseTo(beforeAlpha - delta, 10);
  });

  it("clamps at the prior α = 1 (never sub-prior) on over-reversal", () => {
    const ledger = ledgerWithCap();
    const src = "src:b" as SourceId;
    ledger.ratify(src, NOW); // small positive α
    const after = ledger.reverseCredit(src, 999, NOW);
    expect(after.alpha).toBe(1);
    expect(after.score).toBe(0); // prior reads out 0
  });

  it("does NOT bump contradictedCount (it is a precise unwind, not a contradiction)", () => {
    const ledger = ledgerWithCap();
    const src = "src:b" as SourceId;
    earn(ledger, src);
    const cBefore = ledger.stateOf(src)!.contradictedCount;
    ledger.reverseCredit(src, 0.05, NOW);
    expect(ledger.stateOf(src)!.contradictedCount).toBe(cBefore);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: record (real delta) -> disown -> exact reversal
// ---------------------------------------------------------------------------

/** A reputation ledger whose ratify returns observable deltas. */
function setup() {
  const store: StrandStore = createMemoryStore();
  const ledger = ledgerWithCap();
  const corroboration = createCorroborationLedger();
  return { store, ledger, corroboration };
}

describe("end-to-end — RECORD FIDELITY + EXACT reversal", () => {
  it("recorded delta equals the actual applied score change, and a disown reverses exactly it", () => {
    const { store, ledger, corroboration } = setup();
    const fraud = "src:fraud" as SourceId; // source A (the corroborator, later disowned)
    const beneficiary = "src:beneficiary" as SourceId; // source B (earned by agreeing)

    // A's seed strand (the corroborating strand B agreed with).
    const aStrand = makeStrand({ idRaw: "s:a-seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // B's strand (independently observed; NO derivation edge to A).
    const bStrand = makeStrand({ idRaw: "s:b-claim", roots: [{ classRaw: "class:B", sourceIdRaw: beneficiary }] });
    store.putStrand(aStrand);
    store.putStrand(bStrand);

    // B earns reputation BECAUSE its claim agreed with A's strand. Under the Beta
    // model the recorded delta is the EXACT α-mass added (the independence weight w),
    // so `reverseCredit` can subtract precisely it back out of α on disown.
    const beforeScore = ledger.scoreOf(beneficiary);
    const beforeAlpha = ledger.stateOf(beneficiary)?.alpha ?? 1;
    const after = ledger.ratify(beneficiary, NOW);
    const deltaAlpha = after.alpha - beforeAlpha;
    expect(deltaAlpha).toBeGreaterThan(0);

    const ev = corroboration.record({
      ratifiedStrandId: bStrand.id,
      corroboratingStrandIds: [aStrand.id],
      beneficiarySourceId: beneficiary,
      reputationDelta: deltaAlpha,
      at: NOW,
    });
    expect(ev.reputationDelta).toBe(deltaAlpha);

    const earned = ledger.scoreOf(beneficiary);
    expect(earned).toBeGreaterThan(beforeScore); // the corroboration raised the LCB

    // Disown A. The sweep finds the corroboration event (its corroboratingStrandIds
    // intersect A's seed) and reverses EXACTLY `delta` on B.
    const res = downstreamDisownSweep(
      fraud,
      [aStrand.id],
      store,
      ledger,
      NOW,
      undefined,
      corroboration,
    );

    expect(res.reversedCorroborationEventIds).toContain(ev.eventId);
    // B is back to its pre-earn LCB: exactly the recorded α-mass was reversed.
    expect(ledger.scoreOf(beneficiary)).toBeCloseTo(beforeScore, 10);
    expect(ledger.stateOf(beneficiary)!.alpha).toBeCloseTo(beforeAlpha, 10);
  });
});

describe("end-to-end — BOUNDED: a non-funded beneficiary is UNTOUCHED", () => {
  it("a beneficiary whose credit was funded by a NON-tainted strand has no matching event and keeps its score", () => {
    const { store, ledger, corroboration } = setup();
    const fraud = "src:fraud" as SourceId;
    const honest = "src:honest" as SourceId;
    const someOtherStrand = "s:unrelated" as StrandId; // NOT the disowned seed

    const aStrand = makeStrand({ idRaw: "s:a-seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(aStrand);

    // The honest source earned credit corroborated by an UNRELATED strand (not A's seed).
    earn(ledger, honest);
    const honestScore = ledger.scoreOf(honest);
    corroboration.record({
      ratifiedStrandId: "s:honest-claim" as StrandId,
      corroboratingStrandIds: [someOtherStrand],
      beneficiarySourceId: honest,
      reputationDelta: 0.05,
      at: NOW,
    });

    const res = downstreamDisownSweep(
      fraud,
      [aStrand.id],
      store,
      ledger,
      NOW,
      undefined,
      corroboration,
    );

    // No event intersected the tainted set => the honest source is untouched.
    expect(res.reversedCorroborationEventIds).toEqual([]);
    expect(ledger.scoreOf(honest)).toBe(honestScore);
  });
});

describe("end-to-end — IDEMPOTENT: a second disown reverses nothing further", () => {
  it("each corroboration event is reversed at most once across sweeps", () => {
    const { store, ledger, corroboration } = setup();
    const fraud = "src:fraud" as SourceId;
    const beneficiary = "src:beneficiary" as SourceId;

    const aStrand = makeStrand({ idRaw: "s:a-seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(aStrand);

    const beforeScore = ledger.scoreOf(beneficiary);
    const beforeAlpha = ledger.stateOf(beneficiary)?.alpha ?? 1;
    const after = ledger.ratify(beneficiary, NOW);
    const deltaAlpha = after.alpha - beforeAlpha;
    const ev = corroboration.record({
      ratifiedStrandId: "s:b-claim" as StrandId,
      corroboratingStrandIds: [aStrand.id],
      beneficiarySourceId: beneficiary,
      reputationDelta: deltaAlpha,
      at: NOW,
    });

    const first = downstreamDisownSweep(fraud, [aStrand.id], store, ledger, NOW, undefined, corroboration);
    expect(first.reversedCorroborationEventIds).toContain(ev.eventId);
    const afterFirst = ledger.scoreOf(beneficiary);
    expect(afterFirst).toBeCloseTo(beforeScore, 10);

    // Second sweep: the disowned-source idempotency short-circuits AND the event is
    // already marked reversed — nothing further happens to B.
    const second = downstreamDisownSweep(fraud, [aStrand.id], store, ledger, NOW, undefined, corroboration);
    expect(second.reversedCorroborationEventIds).toEqual([]);
    expect(ledger.scoreOf(beneficiary)).toBe(afterFirst);

    // Even a DIFFERENT disowned source intersecting the SAME event reverses nothing
    // more (the event is reversed at most once, guarded by markReversed).
    const otherFraud = "src:fraud2" as SourceId;
    const aStrand2 = makeStrand({ idRaw: "s:a2-seed", roots: [{ classRaw: "class:A2", sourceIdRaw: otherFraud }] });
    store.putStrand(aStrand2);
    // Record a second event for a different beneficiary that ALSO names aStrand among
    // its corroborators, but mark the first event already reversed (guard holds).
    const third = downstreamDisownSweep(otherFraud, [aStrand2.id, aStrand.id], store, ledger, NOW, undefined, corroboration);
    expect(third.reversedCorroborationEventIds).not.toContain(ev.eventId);
    expect(ledger.scoreOf(beneficiary)).toBe(afterFirst);
  });
});

describe("end-to-end — back-compatible: no corroboration ledger => graph-only behavior", () => {
  it("omitting the corroboration ledger leaves reversedCorroborationEventIds empty", () => {
    const { store, ledger } = setup();
    const fraud = "src:fraud" as SourceId;
    const aStrand = makeStrand({ idRaw: "s:a-seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(aStrand);

    const res = downstreamDisownSweep(fraud, [aStrand.id], store, ledger, NOW);
    expect(res.reversedCorroborationEventIds).toEqual([]);
  });
});
