/**
 * memoryStore.test.ts — tiny smoke test for the in-memory StrandStore.
 *
 * Covers the mechanical contract this scaffold actually implements: put/get of
 * strands and edges, the entity/attribute seed indexes, out/in adjacency,
 * neighbor resolution (including dangling-edge skipping), and the load-bearing
 * `recomputeOutWeightSum` share-normalization bookkeeping. No traversal, no crypto.
 */

import { describe, expect, it } from "vitest";
import {
  asEpochMs,
  computeEdgeWeight,
  EdgeType,
  FactOrigin,
  FactState,
  Tier,
  type AttributeKey,
  type ContentHash,
  type Edge,
  type EdgeId,
  type EntityId,
  type Strand,
  type StrandId,
} from "../core/types.js";
import { demote } from "../forgetting/consolidation.js";
import { createMemoryStore, MemoryStrandStore } from "./memoryStore.js";

// --- minimal fixtures -------------------------------------------------------

function makeStrand(id: string, entity: string, attribute: string | null): Strand {
  return {
    id: id as StrandId,
    entity: entity as EntityId,
    attribute: attribute === null ? null : (attribute as AttributeKey),
    payload: { note: id },
    content_hash: `hash:${id}` as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: asEpochMs(0), lambda: 0.1, fire_count: 0 },
    description_value: 0,
    observedAt: asEpochMs(0),
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

function makeEdge(id: string, from: string, to: string, w: number): Edge {
  return {
    id: id as EdgeId,
    from: from as StrandId,
    to: to as StrandId,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: w,
    provenance_independence: 1,
    recency: 1,
    w: computeEdgeWeight(w, 1, 1),
    out_weight_sum: 0,
  };
}

describe("MemoryStrandStore", () => {
  it("stores and retrieves strands; getStrand returns null when absent", () => {
    const store = createMemoryStore();
    const a = makeStrand("a", "E1", "E1.color");
    store.putStrand(a);
    expect(store.getStrand("a" as StrandId)).toEqual(a);
    expect(store.getStrand("missing" as StrandId)).toBeNull();
  });

  it("indexes by entity and by attribute", () => {
    const store = createMemoryStore();
    store.putStrand(makeStrand("a", "E1", "E1.color"));
    store.putStrand(makeStrand("b", "E1", "E1.size"));
    store.putStrand(makeStrand("c", "E2", null));

    expect(store.strandsByEntity("E1" as EntityId).map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
    expect(store.strandsByEntity("E2" as EntityId).map((s) => s.id)).toEqual(["c"]);
    expect(
      store.strandsByAttribute("E1.color" as AttributeKey).map((s) => s.id),
    ).toEqual(["a"]);
    expect(store.strandsByAttribute("nope" as AttributeKey)).toEqual([]);
  });

  it("re-indexes when a strand is replaced with a new entity/attribute", () => {
    const store = createMemoryStore();
    store.putStrand(makeStrand("a", "E1", "E1.color"));
    store.putStrand(makeStrand("a", "E2", "E2.color")); // replace
    expect(store.strandsByEntity("E1" as EntityId)).toEqual([]);
    expect(store.strandsByEntity("E2" as EntityId).map((s) => s.id)).toEqual(["a"]);
    expect(store.strandsByAttribute("E1.color" as AttributeKey)).toEqual([]);
  });

  it("wires out/in adjacency and resolves neighbors, skipping dangling edges", () => {
    const store = createMemoryStore();
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5));
    store.putEdge(makeEdge("a->x", "a", "x", 0.5)); // x not stored => dangling

    expect(store.outEdges("a" as StrandId).map((e) => e.id)).toEqual([
      "a->b",
      "a->x",
    ]);
    expect(store.inEdges("b" as StrandId).map((e) => e.id)).toEqual(["a->b"]);

    const nbrs = store.neighbors("a" as StrandId);
    expect(nbrs.map((n) => n.strand.id)).toEqual(["b"]); // dangling a->x skipped
  });

  it("recomputeOutWeightSum writes Σw onto every out-edge of the node", () => {
    const store = createMemoryStore();
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putStrand(makeStrand("c", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5)); // w = 0.5
    store.putEdge(makeEdge("a->c", "a", "c", 0.25)); // w = 0.25

    store.recomputeOutWeightSum("a" as StrandId);
    for (const e of store.outEdges("a" as StrandId)) {
      expect(e.out_weight_sum).toBeCloseTo(0.75);
    }
    // No out-edges => no-op, no throw.
    expect(() => store.recomputeOutWeightSum("b" as StrandId)).not.toThrow();
  });

  it("hands out frozen edge views (internal record stays private)", () => {
    const store = new MemoryStrandStore();
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5));
    const view = store.getEdge("a->b" as EdgeId)!;
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("clear empties the store", () => {
    const store = new MemoryStrandStore();
    store.putStrand(makeStrand("a", "E1", null));
    store.putEdge(makeEdge("a->a", "a", "a", 0.5));
    store.clear();
    expect(store.strandCount()).toBe(0);
    expect(store.edgeCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Regression: inmemory-demote-escapes-txn
  // ---------------------------------------------------------------------------
  //
  // BUG (pre-fix): getStrand()/strandsByAttribute() handed back the LIVE strandMap
  // reference. The engine's real demote() flow (forgetting/consolidation.ts) reads a
  // strand via one of those, then MUTATES its fact_state/outranked_by fields in
  // place, and only afterward (inside a withTxn block) calls putStrand() to persist
  // it. Because the returned object WAS the store's own map entry, the demotion was
  // visible to the store the INSTANT demote() ran -- before putStrand(), before
  // withTxn even opens -- with no way to "not persist it" if the surrounding
  // compound op later throws (MemoryStrandStore has no real beginTxn, so a throw
  // there cannot roll anything back either; see api.ts's adjudicate RESOLVED path).
  //
  // FIX: getStrand()/strandsByAttribute()/allStrands() now return a private clone,
  // and putStrand() stores its own private clone too -- so a caller can mutate the
  // object it holds all it wants; only an explicit putStrand() call can ever change
  // what the store serves next.
  it("a demote() mutation on a strand read via getStrand does NOT leak into the store until putStrand is called (rollback-safe)", () => {
    const store = createMemoryStore();
    const loserId = "strand:loser" as StrandId;
    const winnerId = "strand:winner" as StrandId;
    store.putStrand(makeStrand(loserId, "E1", "E1.color"));

    const winnerEdge: Edge = {
      id: "edge:outranks-1" as EdgeId,
      from: winnerId,
      to: loserId,
      edgeType: EdgeType.OUTRANKS,
      link_confidence: 1,
      provenance_independence: 1,
      recency: 1,
      w: 1,
      out_weight_sum: 1,
    };

    // Mirrors the real compound-op shape (api.ts's adjudicate RESOLVED path): open a
    // (no-op, for this in-memory backend) unit of work, read the disputed strand,
    // run the REAL production demote() against it, then "roll back" by simulating a
    // throw BEFORE the putStrand() call that would otherwise persist it.
    const txn = store.beginTxn?.(); // undefined here -- MemoryStrandStore has no real txn
    const loser = store.getStrand(loserId)!;
    const result = demote(loser, winnerEdge);
    txn?.rollback(); // no-op for this backend; documents the intended rollback point
    // (the putStrand() call that a real op would make next is deliberately skipped,
    // simulating a mid-op throw before persistence)

    // demote() really did mutate the OBJECT it was handed (the bug is aliasing, not
    // that demote() silently no-ops) -- and the receipt is correct.
    expect(loser.fact_state).toBe(FactState.DEMOTED);
    expect(loser.outranked_by).toBe(winnerEdge.id);
    expect(result.demoted).toBe(loserId);

    // THE REGRESSION CHECK: the store's OWN copy must be untouched, because
    // putStrand() was never called.
    const stillInStore = store.getStrand(loserId)!;
    expect(stillInStore.fact_state).toBe(FactState.LIVE);
    expect(stillInStore.outranked_by).toBeNull();

    // Same guarantee via the attribute-index read path (adjudicate's actual entry
    // point, api.ts: `store.strandsByAttribute(attribute)`).
    const viaAttribute = store
      .strandsByAttribute("E1.color" as AttributeKey)
      .find((s) => s.id === loserId)!;
    expect(viaAttribute.fact_state).toBe(FactState.LIVE);
  });
});
