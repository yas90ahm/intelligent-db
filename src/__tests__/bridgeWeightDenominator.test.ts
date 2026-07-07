/**
 * bridgeWeightDenominator.test.ts — Wave-3 `bridge-weight-in-denominator`.
 *
 * THE BUG: `activationWalk`'s local share-normalization denominator
 * (`materializedOutSum`, folded into `effectiveOutSum`) used to sum EVERY
 * out-edge's weight, INCLUDING `CROSS_WEB_BRIDGE` edges — even though the very
 * same pop loop deliberately SKIPS bridges when actually spreading local energy
 * (bridges are funded exclusively from the separate phase-2 sub-budget, never
 * paid out locally). That meant a bridge's weight diluted every OTHER local
 * edge's share for a payout that never happens locally: `Σ(locally-paid shares)`
 * summed to strictly LESS than 1 whenever a strand carried a bridge, silently
 * withholding energy rather than spreading it to the edges that actually
 * receive it.
 *
 * THE FIX: `CROSS_WEB_BRIDGE` out-edges are excluded from the local
 * `materializedOutSum` (and therefore `effectiveOutSum`) entirely — the
 * denominator now covers exactly the edges (+ virtual siblings) that can
 * actually receive a local share.
 *
 * THIS TEST: a strand with ONE normal out-edge and ONE bridge out-edge of EQUAL
 * weight. Pre-fix, the normal edge's share would be diluted by the bridge's
 * weight (1/2 of the parent's energy); post-fix it gets the bridge-excluded
 * share (the full 1/1 = 100% of the local budget) since the bridge edge, which
 * is never locally paid, no longer counts against the local denominator.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALK_CONFIG,
  EdgeType,
  FactOrigin,
  FactState,
  Tier,
  activationWalk,
  asEdgeId,
  asEpochMs,
  asStrandId,
  computeEdgeWeight,
  createHaltingController,
  createMemoryStore,
} from "../index.js";
import type { Edge, EntityId, Strand, StrandId, Unit } from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const GAMMA = DEFAULT_WALK_CONFIG.gamma;

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

describe("bridge-weight-in-denominator (Wave-3)", () => {
  it("a bridge out-edge is excluded from the local share-normalization denominator", () => {
    const store = createMemoryStore();
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b"); // reached by a normal LOCAL edge
    const c = asStrandId("strand:c"); // reached ONLY by a bridge (phase-2, not local)

    store.putStrand(bareStrand(a, "entity:a" as EntityId));
    store.putStrand(bareStrand(b, "entity:b" as EntityId));
    store.putStrand(bareStrand(c, "entity:c" as EntityId));

    const w = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit);
    const normalEdge: Edge = {
      id: asEdgeId("edge:a->b"),
      from: a,
      to: b,
      edgeType: EdgeType.SHARED_ENTITY,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w,
      out_weight_sum: w,
    };
    const bridgeEdge: Edge = {
      id: asEdgeId("edge:a->c"),
      from: a,
      to: c,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w, // SAME weight as the normal edge, by design (isolates the fix's effect)
      out_weight_sum: w,
    };
    store.putEdge(normalEdge);
    store.putEdge(bridgeEdge);
    store.recomputeOutWeightSum(a);

    const result = activationWalk(
      store,
      [{ strandId: a, energy: 1 }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    const bLit = result.lit.find((l) => l.strandId === b)?.activation ?? 0;

    // Post-fix: the bridge edge is excluded from the denominator, so `b`'s
    // out-edge is the ONLY thing in the local Σ_eff — it gets the FULL local
    // share (1/1), not half of it.
    const expected = 1 * 1 * GAMMA; // parent(1) * share(w / w) * gamma
    expect(bLit).toBeCloseTo(expected, 10);

    // Sanity: a bug that folds the bridge weight back into the denominator
    // would halve this (share = w / (w+w) = 1/2) — pin that this is NOT what
    // we measure, so the test actually discriminates the fix from the bug.
    const buggyValue = 1 * 0.5 * GAMMA;
    expect(bLit).not.toBeCloseTo(buggyValue, 10);
  });
});
