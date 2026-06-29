/**
 * batch6BridgeAndApproveExtra.test.ts — BATCH 6 strengthening (tests only).
 *
 * Complements batch6BridgeAndApprove.test.ts by closing three invariants its
 * single-case probes leave un-exercised:
 *
 *  B1 — the bridgeSeedsDownweighted counter ACCUMULATES across multiple weak
 *    bridges, and the seed tracks the EXACT per-bridge factor (γ·indep) for a
 *    factor other than 0.5 — proving the down-weight is not hardcoded to one value.
 *
 *  B2 — a THREE-way enumeration (earned 5 / 2 / 0), seeded out of order, is
 *    crossed strictly earned-value DESC — proving the sort is a full reorder, not
 *    a single pairwise swap.
 *
 *  RC-5 — the approve() gate rejects an approver that is MIS-independent of ONE
 *    disputed author but CORRELATED with ANOTHER. The committed RC-5 tests feed a
 *    single `independent` boolean for ALL authors, so they never prove the
 *    "independent of EVERY author" loop (pendingLedger.ts:743–751). This does.
 */

import { describe, it, expect } from "vitest";

import {
  createHaltingController,
  DEFAULT_WALK_CONFIG,
  createPendingLedger,
  createReputationLedger,
  generatePassport,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "../index.js";

import type {
  Activation,
  Unit,
  EdgeId,
  StrandId,
  HaltContext,
  HaltStoreView,
  Strand,
  SourceId,
  ApproveContext,
  EntityId,
  AttributeKey,
  ContradictionSetId,
  PendingRatification,
} from "../index.js";

// ===========================================================================
// Shared controller-driving harness (B1 + B2)
// ===========================================================================

const NEAR = asStrandId("strand:near");

function mockStore(
  bridges: readonly EdgeId[],
  indep: ReadonlyMap<EdgeId, number>,
  earned: ReadonlyMap<EdgeId, number>,
): HaltStoreView {
  return {
    independentClassCount: () => 1,
    litBridgesFrom: (s: StrandId) => (s === NEAR ? bridges : []),
    bridgeTarget: (e: EdgeId) => asStrandId("far:" + String(e)),
    bridgeIndependence: (e: EdgeId) => indep.get(e) ?? 0,
    bridgeEarnedValue: (e: EdgeId) => earned.get(e) ?? 0,
  };
}

function ctxFor(store: HaltStoreView): HaltContext {
  return {
    strandId: NEAR,
    activation: 1 as Activation,
    newIndependentCorroboration: 0 as Unit,
    now: asEpochMs(0),
    store,
  };
}

function crossingsOf(
  bridges: readonly EdgeId[],
  indep: ReadonlyMap<EdgeId, number>,
  earned: ReadonlyMap<EdgeId, number>,
): { seeds: Activation[]; order: EdgeId[]; downweighted: number } {
  const store = mockStore(bridges, indep, earned);
  const ctx = ctxFor(store);
  const ctl = createHaltingController(DEFAULT_WALK_CONFIG);
  ctl.onPop(ctx);
  ctl.beginBridgeSweep(ctx);

  const seeds: Activation[] = [];
  const order: EdgeId[] = [];
  for (;;) {
    const c = ctl.nextBridgeCrossing(ctx);
    if (c === null) break;
    order.push(c.bridgeEdge);
    seeds.push(c.seedActivation);
    ctl.recordCrossingYield({
      bridgeEdge: c.bridgeEdge,
      yieldCorroboration: 1 as Unit,
      popsConsumed: 1,
    });
  }
  return { seeds, order, downweighted: ctl.finalStamp().bridgeSeedsDownweighted };
}

// ===========================================================================
// B1 — counter ACCUMULATES; factor is exact (not hardcoded to 0.5)
// ===========================================================================

describe("B1 — multi-bridge accumulation + exact non-0.5 factor", () => {
  const gamma = DEFAULT_WALK_CONFIG.gamma;

  it("TWO weak bridges each down-weight by their OWN indep; counter reaches 2", () => {
    const weakLo = asEdgeId("edge:wlo");
    const weakHi = asEdgeId("edge:whi");
    const { seeds, order, downweighted } = crossingsOf(
      [weakLo, weakHi],
      new Map([
        [weakLo, 0.2],
        [weakHi, 0.75],
      ]),
      new Map(), // earned 0 for both ⇒ id tiebreak (irrelevant: we index by id)
    );
    const seedOf = (e: EdgeId): number => seeds[order.indexOf(e)]!;
    // Each seed is γ × ITS OWN factor — distinct values prove no single hardcoded factor.
    expect(seedOf(weakLo)).toBeCloseTo(gamma * 0.2, 10);
    expect(seedOf(weakHi)).toBeCloseTo(gamma * 0.75, 10);
    expect(seedOf(weakLo)).not.toBeCloseTo(seedOf(weakHi), 10);
    // Both seeds strictly within (0, γ); termination proof (seed ∈ [0,γ]) intact.
    expect(seedOf(weakLo)).toBeGreaterThan(0);
    expect(seedOf(weakHi)).toBeLessThan(gamma);
    // The counter ACCUMULATES across both weak crossings.
    expect(downweighted).toBe(2);
  });

  it("a MIX of weak + bare-key counts ONLY the weak ones (fail-open bare-key uncounted)", () => {
    const weak = asEdgeId("edge:mix-weak");
    const bare = asEdgeId("edge:mix-bare");
    const { seeds, order, downweighted } = crossingsOf(
      [weak, bare],
      new Map([
        [weak, 0.3],
        [bare, 0],
      ]),
      new Map(),
    );
    const seedOf = (e: EdgeId): number => seeds[order.indexOf(e)]!;
    expect(seedOf(weak)).toBeCloseTo(gamma * 0.3, 10);
    expect(seedOf(bare)).toBe(gamma);
    expect(downweighted).toBe(1); // bare-key never increments the counter
  });
});

// ===========================================================================
// B2 — full reorder across THREE bridges (not a single pairwise swap)
// ===========================================================================

describe("B2 — three-way earned-value ordering", () => {
  it("earned 5 / 2 / 0 enumerated out of order are crossed 5 → 2 → 0", () => {
    const lo = asEdgeId("edge:lo"); // earned 0 (decoy)
    const hi = asEdgeId("edge:hi"); // earned 5 (best signal)
    const mid = asEdgeId("edge:mid"); // earned 2
    // Enumerated decoy-first, best-last on purpose — the sort must fully reorder.
    const { order } = crossingsOf(
      [lo, hi, mid],
      new Map(), // indep 0 ⇒ B1 irrelevant
      new Map([
        [lo, 0],
        [hi, 5],
        [mid, 2],
      ]),
    );
    expect(order).toEqual([hi, mid, lo]);
  });
});

// ===========================================================================
// RC-5 — approver must be independent of EVERY author (not just one)
// ===========================================================================

const NOW = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;
const CSID = "cset:berlin#capital_of" as ContradictionSetId;

function disputeStrand(idRaw: string, sourceId: SourceId): Strand {
  return {
    id: asStrandId(idRaw),
    entity: "entity:berlin" as EntityId,
    attribute: ATTR,
    payload: { v: idRaw },
    content_hash: idRaw as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + idRaw) as Strand["provenance"][number]["rootId"],
        independenceClass: ("class:" + idRaw) as Strand["provenance"][number]["independenceClass"],
        sourceId,
        establishedAt: NOW,
      },
    ],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: CSID,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

const pendingOf = (members: StrandId[]): PendingRatification => ({
  contradictionSetId: CSID,
  attribute: ATTR,
  members,
  reason: "INDEPENDENT_DISPUTE",
  createdAt: NOW,
});

/** ctx whose independence verdict varies PER author (the missing degree of freedom). */
function ctxPerAuthor(
  byId: Map<StrandId, Strand>,
  independentOf: (author: SourceId) => boolean,
): ApproveContext {
  return {
    authorsOf(memberId: StrandId): readonly SourceId[] {
      const s = byId.get(memberId);
      if (s === undefined) return [];
      const out: SourceId[] = [];
      for (const r of s.provenance) if (r.sourceId !== null) out.push(r.sourceId);
      return out;
    },
    memberStrand(memberId: StrandId): Strand {
      const s = byId.get(memberId);
      if (s === undefined) throw new Error("no member " + String(memberId));
      return s;
    },
    mintEdgeId: (w: StrandId, l: StrandId) =>
      ("edge:outranks:" + String(w) + "->" + String(l)) as EdgeId,
    // approverHasAnchors passes; the verdict turns purely on the per-author predicate.
    independentSources: (_a: SourceId, b: SourceId) => independentOf(b),
    approverHasAnchors: (_s: SourceId) => true,
  };
}

describe("RC-5 — approver independent of ONE author but CORRELATED with ANOTHER", () => {
  function setup(): { byId: Map<StrandId, Strand>; a: StrandId; b: StrandId } {
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      [a, disputeStrand("strand:a", "src:a" as SourceId)],
      [b, disputeStrand("strand:b", "src:b" as SourceId)],
    ]);
    return { byId, a, b };
  }

  it("is REJECTED, naming the correlated author (the 'EVERY author' invariant)", () => {
    const { byId, a, b } = setup();
    const sys = generatePassport();
    const approver = generatePassport();
    const ledger = createPendingLedger();
    ledger.appendPending(pendingOf([a, b]), sys);

    // Independent of src:a (the winner's author) but CORRELATED with src:b (the loser's).
    expect(() =>
      ledger.approve(
        CSID,
        a,
        approver,
        NOW,
        ctxPerAuthor(byId, (author) => author !== ("src:b" as SourceId)),
      ),
    ).toThrow(/not anchor-independent of member author src:b/i);
    // Fail-closed + additive: no APPROVAL appended, dispute still open, nothing demoted.
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
    expect(ledger.listPending().length).toBe(1);
    expect(byId.get(b)!.fact_state).toBe(FactState.LIVE);
  });

  it("RESOLVES once the approver is independent of BOTH authors (anti-over-fix)", () => {
    const { byId, a, b } = setup();
    const sys = generatePassport();
    const approver = generatePassport();
    const reputation = createReputationLedger(() => 0.9);
    const ledger = createPendingLedger({ reputation });
    ledger.appendPending(pendingOf([a, b]), sys);

    const resolved = ledger.approve(
      CSID,
      a,
      approver,
      NOW,
      ctxPerAuthor(byId, () => true), // independent of every author
    );
    expect(resolved.winner).toBe(a);
    expect(byId.get(b)!.fact_state).toBe(FactState.DEMOTED);
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });
});
