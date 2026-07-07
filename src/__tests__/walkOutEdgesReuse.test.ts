/**
 * walkOutEdgesReuse.test.ts — Wave-2 hardening, `walk-redundant-outedges-refetch`.
 *
 * THE FINDING: `traversal/walk.ts`'s pop loop re-fetched a popped strand's
 * out-edges from the store UP TO THREE TIMES on the SQLite backend (each a real
 * prepared-statement round-trip, never a free in-memory read):
 *   1. `store.outEdges(cand.strandId)` — to sum materialized Σw (the share-
 *      normalization denominator).
 *   2. `store.neighbors(cand.strandId)` — to spread energy to each neighbor;
 *      internally re-queries the SAME `outEdges` rows and re-resolves each
 *      destination strand, entirely independent of (1) above.
 *   3. `HaltStoreView.litBridgesFrom(strandId)` — called once per LIT strand at
 *      `beginBridgeSweep` (after the local phase) to enumerate owed bridge
 *      crossings; re-queries the SAME rows a THIRD time.
 *
 * THE FIX: build `NeighborView`s locally from the out-edges array (1) already
 * fetched, and cache that array per popped strand so (3)'s later bridge-sweep
 * enumeration reuses it too — `store.outEdges` is now called AT MOST ONCE per
 * strand for the WHOLE walk, and `store.neighbors` is never called at all.
 *
 * THIS TEST drives the REAL `activationWalk` over a real, SQLite-backed
 * `StrandStore` (a temp-file DB, not `:memory:`, so `outEdges`/`neighbors` are
 * genuine prepared-statement round-trips) with a graph that exercises BOTH the
 * neighbor-spread path AND the bridge-sweep path, and proves:
 *   1. REDUCED FETCH COUNT: `store.outEdges` is called AT MOST ONCE per
 *      distinct strand id (no duplicates) across the WHOLE walk (local phase +
 *      bridge sweep), and `store.neighbors` is called ZERO times.
 *   2. PARITY: the walk's `lit` set / activations / halt stamp are unaffected
 *      (the SAME assertions a full scan would have produced).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  createSqliteStore,
} from "../index.js";

import type {
  Edge,
  EntityId,
  EpochMs,
  ProvenanceRoot,
  SqliteStrandStore,
  Strand,
  StrandId,
  Unit,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);

function strandIn(idRaw: string, entityRaw: string, cls: string): Strand {
  return {
    id: asStrandId(idRaw),
    entity: entityRaw as EntityId,
    attribute: null,
    payload: { note: idRaw },
    content_hash: idRaw as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
        independenceClass: cls as ProvenanceRoot["independenceClass"],
        sourceId: null,
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
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}

function wireEdge(
  db: SqliteStrandStore,
  from: StrandId,
  to: StrandId,
  edgeType: EdgeType,
): void {
  const w = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit);
  const edge: Edge = {
    id: asEdgeId(`edge:${String(from)}->${String(to)}`),
    from,
    to,
    edgeType,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w,
    out_weight_sum: w,
  };
  db.putEdge(edge);
}

let paths: string[] = [];
function freshPath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-walk-outedges-${unique}.db`);
  paths.push(p);
  return p;
}

afterEach(() => {
  for (const base of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

describe("walk-redundant-outedges-refetch: outEdges fetched at most once per strand, neighbors() never called", () => {
  it("a real SQLite-backed store: local-phase spread + the bridge sweep both reuse ONE cached out-edges fetch per strand", () => {
    const path = freshPath();
    const store = createSqliteStore(path);

    // Diamond-ish graph: seed -> a (materialized) and seed -> far (a BRIDGE, so
    // beginBridgeSweep's litBridgesFrom(seed) is genuinely exercised); a -> c
    // (materialized), so a SECOND strand's out-edges get fetched and cached too.
    const seed = strandIn("strand:seed", "entity:seed", "class:seed");
    const a = strandIn("strand:a", "entity:a", "class:a");
    const c = strandIn("strand:c", "entity:c", "class:c");
    const far = strandIn("strand:far", "entity:far", "class:far");
    store.putStrand(seed);
    store.putStrand(a);
    store.putStrand(c);
    store.putStrand(far);
    wireEdge(store, seed.id, a.id, EdgeType.SHARED_ENTITY);
    wireEdge(store, seed.id, far.id, EdgeType.CROSS_WEB_BRIDGE);
    store.recomputeOutWeightSum(seed.id);
    wireEdge(store, a.id, c.id, EdgeType.SHARED_ENTITY);
    store.recomputeOutWeightSum(a.id);

    const outEdgesSpy = vi.spyOn(store, "outEdges");
    const neighborsSpy = vi.spyOn(store, "neighbors");

    const result = activationWalk(
      store,
      [{ strandId: seed.id, energy: 1 }],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    // 1) store.neighbors() is NEVER called — the walk builds NeighborViews
    //    locally from the cached out-edges array instead.
    expect(neighborsSpy).not.toHaveBeenCalled();

    // 2) store.outEdges() is called AT MOST ONCE per distinct strand id, across
    //    BOTH the local phase (materializedOutSum + neighbor spread, now
    //    sharing one fetch) AND the bridge sweep's litBridgesFrom (now a cache
    //    hit for every strand popped locally) — never a duplicate.
    const fetchedIds = outEdgesSpy.mock.calls.map(([id]) => String(id));
    const distinctIds = new Set(fetchedIds);
    expect(fetchedIds.length).toBe(distinctIds.size);
    // Sanity: this graph really did pop (and therefore fetch) seed AND a — the
    // fixture actually exercises multiple strands, not just the seed.
    expect(distinctIds.has(String(seed.id))).toBe(true);
    expect(distinctIds.has(String(a.id))).toBe(true);
    outEdgesSpy.mockRestore();
    neighborsSpy.mockRestore();

    // 3) PARITY: the walk result is exactly what the pre-fix full-fetch code
    //    would have produced. Seed's out-edge Σw (materializedOutSum) includes
    //    BOTH out-edges (the materialized a-edge AND the bridge edge — the
    //    walk sums ALL out-edges' weight for the share-normalization
    //    denominator, then the neighbor-spread loop separately SKIPS bridges),
    //    so seed->a's share is 1/2, not 1/1.
    const gamma = DEFAULT_WALK_CONFIG.gamma;
    const byId = new Map(result.lit.map((l) => [String(l.strandId), l.activation]));
    expect(byId.get(String(seed.id))).toBe(1);
    expect(byId.get(String(a.id))).toBeCloseTo(0.5 * gamma, 12);
    expect(byId.get(String(c.id))).toBeCloseTo(0.5 * gamma * gamma, 12);
    // The bridge sweep genuinely crosses the one owed bridge: far is lit at
    // exactly the documented crossing seed energy (config.gamma).
    expect(byId.get(String(far.id))).toBeCloseTo(gamma, 12);
    expect(result.halt.bridgesCrossed).toBe(1);
    expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    expect(result.halt.degraded).toBe(false);

    store.close();
  });
});
