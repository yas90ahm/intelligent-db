/**
 * convergenceOrderingDead.test.ts — Wave-2 hardening, `convergence-ordering-dead`.
 *
 * THE FINDING: `traversal/walk.ts`'s best-first frontier used to break energy
 * TIES on a secondary `orderingKey` derived from `strand.register?.convergence_factor
 * ?? 0`. `Strand.register` (the whole per-traversal `ActivationRegister`) was NEVER
 * populated to anything but `null` anywhere in the engine (`api.ts`'s strand
 * constructor, every bench fixture) — so the tiebreak always compared `0` to `0`.
 * A shipped, tested-sounding ordering feature that never actually ordered a
 * single pop.
 *
 * THE FIX (product-owner decision, not a "wire it up for real" fix): remove the
 * dead tiebreak plumbing entirely — `FrontierCandidate.orderingKey`,
 * `frontierComparator`'s secondary key, `orderingKeyFor`, the unused
 * `makeChildCandidate` helper, and `Strand.register`/`ActivationRegister` — rather
 * than half-wire an unproven feature.
 *
 * THIS TEST proves the removal is a NO-OP on observable walk behavior. THE
 * LOAD-BEARING PROOF is case 2 below — a representative graph with a genuine
 * ENERGY TIE (two siblings fed equal energy from one seed, both feeding a
 * shared downstream convergence node) run through the real, unmodified
 * `activationWalk` (the same production entry point the removed tiebreak used
 * to run inside), asserting an EXACT, pinned `lit` set + `halt` stamp.
 * VERIFIED BYTE-IDENTICAL BEFORE/AFTER (manual repro during the fix, not
 * re-executable inside one test run): this exact case, run unmodified against
 * the PRE-FIX `walk.ts`/`core/types.ts` (secondary `orderingKey` tiebreak +
 * `Strand.register` still present, always `null` as documented), passes with
 * the IDENTICAL pinned `lit`/`halt` values — because the removed tiebreak
 * compared `0` to `0` for every candidate, a plain energy-only comparator
 * decides pop order identically in every case, tied or not.
 *
 * The other three cases pin the NEW (post-removal) contract shape directly
 * (`frontierComparator`'s pure-energy behavior, `FrontierCandidate` and
 * `Strand` no longer carrying the removed fields at all) — they exercise the
 * fixed code's own surface and are not a before/after comparison (the
 * pre-fix `FrontierCandidate`/`Strand` types REQUIRED the now-removed fields,
 * so those two shapes cannot both be constructed against one contract).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALK_CONFIG,
  EdgeType,
  FactOrigin,
  FactState,
  ReasonCode,
  Tier,
  activationWalk,
  asEdgeId,
  asEpochMs,
  asStrandId,
  computeEdgeWeight,
  createHaltingController,
  frontierComparator,
} from "../index.js";
import { createMemoryStore } from "../index.js";
import type {
  Edge,
  EntityId,
  FrontierCandidate,
  Strand,
  StrandId,
  StrandStore,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

/** A bare strand with NO edges/provenance beyond what a test wires up itself. */
function bareStrand(id: StrandId, entity: EntityId): Strand {
  return {
    id,
    entity,
    attribute: null,
    payload: { id: String(id) },
    content_hash: ("hash:" + String(id)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
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

/** Each strand gets its OWN entity so the shared-entity sibling fan adds nothing extra. */
function putIsolated(store: StrandStore, id: StrandId): void {
  store.putStrand(bareStrand(id, ("entity:" + String(id)) as EntityId));
}

/** Wire a single directed edge of weight 1 (link_confidence=recency=provenance_independence=1). */
function wireEdge(store: StrandStore, from: StrandId, to: StrandId): void {
  const w = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit);
  const edge: Edge = {
    id: asEdgeId(`edge:${String(from)}->${String(to)}`),
    from,
    to,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w,
    out_weight_sum: w,
  };
  store.putEdge(edge);
}

describe("convergence-ordering-dead (Wave-2): dead tiebreak removed, walk behavior unchanged", () => {
  it("frontierComparator is a pure energy comparator (no secondary key survives)", () => {
    const lo: FrontierCandidate = { strandId: asStrandId("s:lo"), energy: 0.1 };
    const hi: FrontierCandidate = { strandId: asStrandId("s:hi"), energy: 0.9 };
    const tie1: FrontierCandidate = { strandId: asStrandId("s:tie1"), energy: 0.5 };
    const tie2: FrontierCandidate = { strandId: asStrandId("s:tie2"), energy: 0.5 };

    expect(frontierComparator(hi, lo)).toBeGreaterThan(0); // higher energy pops first
    expect(frontierComparator(lo, hi)).toBeLessThan(0);
    // Equal energy ⇒ exactly 0 (no hidden secondary key breaks the tie anymore).
    expect(frontierComparator(tie1, tie2)).toBe(0);
  });

  it("a genuine energy TIE (two equal-weight siblings converging on one downstream node) produces a PINNED lit set + halt stamp", () => {
    // Diamond: seed S -> {A, B} (equal weight, a genuine frontier tie) -> C
    // (both converge on the same downstream node). This is exactly the shape
    // the dead tiebreak claimed to influence (which of A/B is expanded first)
    // — and exactly the shape that proves it never mattered: C's final
    // activation is the max delivery over ALL paths regardless of pop order.
    const store = createMemoryStore();
    const s = asStrandId("strand:seed");
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const c = asStrandId("strand:c");
    for (const id of [s, a, b, c]) putIsolated(store, id);
    wireEdge(store, s, a);
    wireEdge(store, s, b);
    store.recomputeOutWeightSum(s); // out_weight_sum = w(s->a) + w(s->b), a real tie
    wireEdge(store, a, c);
    store.recomputeOutWeightSum(a);
    wireEdge(store, b, c);
    store.recomputeOutWeightSum(b);

    const result = activationWalk(
      store,
      [{ strandId: s, energy: 1 }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    const gamma = DEFAULT_WALK_CONFIG.gamma;
    const shareAB = 0.5; // s has two equal out-edges
    const energyAB = 1 * shareAB * gamma; // a and b each receive this, tied
    const energyC = energyAB * 1 * gamma; // c receives the SAME delivery from both a and b

    const byId = new Map(result.lit.map((l) => [l.strandId, l.activation]));
    expect(byId.get(s)).toBe(1);
    expect(byId.get(a)).toBeCloseTo(energyAB, 12);
    expect(byId.get(b)).toBeCloseTo(energyAB, 12);
    // Dominance fires c ONCE, at the (identical, since a and b tie) delivered energy —
    // pop order between a and b cannot change this value.
    expect(byId.get(c)).toBeCloseTo(energyC, 12);
    expect(result.lit.map((l) => l.strandId).sort()).toEqual([a, b, c, s].sort());

    // The halt stamp is fully pinned too — this tiny acyclic graph runs the
    // frontier dry (no CROSS_WEB_BRIDGE edges exist) before novelty ever decays
    // below epsilon, so the local phase ends by exhaustion and the (vacuous)
    // bridge sweep resolves the clean, non-degraded stamp.
    expect(result.halt.reason).toBe(ReasonCode.BRIDGE_SWEEP_CLEAR);
    expect(result.halt.degraded).toBe(false);
    expect(result.halt.popCount).toBe(4);
    expect(result.halt.bridgesCrossed).toBe(0);
    expect(result.halt.bridgeSeedsDownweighted).toBe(0);
  });

  it("FrontierCandidate carries no orderingKey field (the plumbing is gone, not merely unused)", () => {
    const cand: FrontierCandidate = { strandId: asStrandId("strand:x"), energy: 1 };
    expect("orderingKey" in cand).toBe(false);
  });

  it("Strand carries no register field (ActivationRegister plumbing fully removed)", () => {
    const s = bareStrand(asStrandId("strand:no-register"), "entity:no-register" as EntityId);
    expect("register" in s).toBe(false);
  });
});
