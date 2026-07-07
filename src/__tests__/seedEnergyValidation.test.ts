/**
 * seedEnergyValidation.test.ts — Wave-3 `seed-energy-unvalidated`.
 *
 * THE BUG: `activationWalk`'s existing "weightless" prune guards (`if (childEnergy
 * <= 0) continue;` / `if (siblingEnergy > 0) { ... }`) let a NON-FINITE energy
 * value straight through: `NaN <= 0` and `Infinity <= 0` both evaluate to `false`,
 * so a `NaN`/`Infinity` `WalkSeed.energy` (a caller bug) — or a `NaN`/`Infinity`
 * edge weight (corrupted store data) — used to sail past the guard and light up a
 * strand at an un-orderable, nonsensical activation.
 *
 * THE FIX: every place the walk gates on "is this energy usable" now calls one
 * `isPositiveFiniteEnergy` predicate (finite AND `> 0`) instead of a bare `<= 0`/
 * `> 0` comparison, so NaN/Infinity is pruned exactly like any other unusable
 * delivery — deterministically, never a crash, never a poisoned result.
 *
 * Built directly on `activationWalk` over hand-built strands/edges (mirrors
 * `reinforcementSummation.test.ts`'s low-level harness).
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
import type { Edge, EntityId, Strand, StrandId, StrandStore, Unit } from "../index.js";

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

/** Put a strand in its OWN distinct entity, so no virtual-sibling fan interferes. */
function putIsolated(store: StrandStore, id: StrandId): void {
  store.putStrand(bareStrand(id, ("entity:" + String(id)) as EntityId));
}

/** Wire a single directed edge of weight 1. */
function wireEdge(store: StrandStore, from: StrandId, to: StrandId, w = 1): void {
  const weight = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit) * w;
  const edge: Edge = {
    id: asEdgeId(`edge:${String(from)}->${String(to)}`),
    from,
    to,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w: weight as Unit,
    out_weight_sum: weight as Unit,
  };
  store.putEdge(edge);
}

describe("seed-energy-unvalidated (Wave-3, activationWalk boundary)", () => {
  it("a NaN seed energy is pruned deterministically — no crash, no NaN in the result", () => {
    const store = createMemoryStore();
    const a = asStrandId("strand:a");
    putIsolated(store, a);

    const result = activationWalk(
      store,
      [{ strandId: a, energy: NaN }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    // The seed strand itself DID resolve in the store (it exists) — only its
    // energy was unusable — so it is NOT reported as an unresolved/dangling seed.
    expect(result.seedsResolved).toBe(1);
    expect(result.unresolvedSeeds).toEqual([]);
    // But a strand that never receives usable energy never fires.
    expect(result.lit).toEqual([]);
    expect(Number.isFinite(result.halt.popCount)).toBe(true);
  });

  it("an Infinity seed energy is pruned deterministically — no crash, no Infinity in the result", () => {
    const store = createMemoryStore();
    const a = asStrandId("strand:a");
    putIsolated(store, a);

    const result = activationWalk(
      store,
      [{ strandId: a, energy: Infinity }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    expect(result.seedsResolved).toBe(1);
    expect(result.lit).toEqual([]);
  });

  it("a mix of a NaN seed and a genuinely valid seed: only the valid one fires, and nothing downstream ever sees NaN", () => {
    const store = createMemoryStore();
    const bad = asStrandId("strand:bad");
    const good = asStrandId("strand:good");
    const child = asStrandId("strand:child");
    putIsolated(store, bad);
    putIsolated(store, good);
    putIsolated(store, child);
    wireEdge(store, good, child);
    store.recomputeOutWeightSum(good);

    const result = activationWalk(
      store,
      [
        { strandId: bad, energy: NaN },
        { strandId: good, energy: 1 },
      ],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    expect(result.seedsResolved).toBe(2);
    const litIds = result.lit.map((l) => String(l.strandId)).sort();
    // `bad` never fires (its only energy was NaN); `good` and its real child do.
    expect(litIds).toEqual([String(child), String(good)].sort());
    for (const l of result.lit) {
      expect(Number.isFinite(l.activation)).toBe(true);
      expect(l.activation).toBeGreaterThan(0);
    }
  });

  it("a NaN MATERIALIZED EDGE WEIGHT (corrupted store data) is pruned without poisoning the OTHER edges' shares", () => {
    const store = createMemoryStore();
    const parent = asStrandId("strand:parent");
    const poisoned = asStrandId("strand:poisoned");
    const healthy = asStrandId("strand:healthy");
    putIsolated(store, parent);
    putIsolated(store, poisoned);
    putIsolated(store, healthy);

    // One edge with a NaN weight (simulating corrupted/hand-inserted store data —
    // writeFact's own validation never produces this), and one perfectly normal
    // edge from the SAME parent.
    store.putEdge({
      id: asEdgeId("edge:parent->poisoned"),
      from: parent,
      to: poisoned,
      edgeType: EdgeType.SHARED_ENTITY,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: NaN as Unit,
      out_weight_sum: NaN as Unit,
    });
    wireEdge(store, parent, healthy);
    store.recomputeOutWeightSum(parent);

    const result = activationWalk(
      store,
      [{ strandId: parent, energy: 1 }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    const litIds = result.lit.map((l) => String(l.strandId)).sort();
    // The poisoned edge never lights its target...
    expect(litIds).not.toContain(String(poisoned));
    // ...but the healthy sibling edge from the SAME parent still fires normally,
    // at a real, finite, positive energy (proving the NaN weight was excluded
    // from the share-normalization denominator, not merely caught downstream
    // after already contaminating every other edge's share).
    expect(litIds).toContain(String(healthy));
    for (const l of result.lit) {
      expect(Number.isFinite(l.activation)).toBe(true);
    }
  });
});
