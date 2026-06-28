/**
 * store/memoryStore.ts — the default, FULLY-IMPLEMENTED in-memory StrandStore.
 *
 * This is a SIMPLE part of the scaffold and is implemented completely (no stubs).
 * It is an adjacency-map graph store: it owns identity, indexing and adjacency for
 * the latent spider-web and contains NO traversal, NO crypto, and NO forgetting
 * policy — those live in their own layers and call this store only through the
 * {@link StrandStore} contract.
 *
 * Design grounding (see CLAUDE.md):
 *  - Memory is a web of {@link Strand} nodes connected by directed {@link Edge}
 *    threads. The store keeps, all insertion-ordered for deterministic iteration:
 *      • a strand map        Map<StrandId, Strand>
 *      • an edge map         Map<EdgeId,  InternalEdge>   (mutable internal records)
 *      • an entity index     Map<EntityId,    Set<StrandId>>
 *      • an attribute index  Map<AttributeKey, Set<StrandId>>
 *      • out/in adjacency    Map<StrandId, Set<EdgeId>>  (×2)
 *  - "Threads connect only on shared entity + confirmed link": the entity and
 *    attribute indexes give a cue its mechanical seed strands (energize-by-entity)
 *    and let the contradiction layer count co-equal claims per (entity, attribute) —
 *    nothing here is found by content scan.
 *  - "Web of webs": CROSS_WEB_BRIDGE edges are ordinary edges to this store; it is
 *    edge-type agnostic and merely surfaces {@link Edge.edgeType}. The bridge
 *    sub-budget is the traversal layer's concern, not the store's.
 *  - Share-normalization (`child = parent * (w / out_weight_sum) * γ`) needs a
 *    cached Σw on every out-edge so high-degree junk hubs self-starve.
 *    {@link MemoryStrandStore.recomputeOutWeightSum} sums {@link Edge.w} over a
 *    node's out-edges and writes the cached `out_weight_sum` back onto each of
 *    them. {@link Edge} is `readonly` in the shared contract, so the store keeps
 *    MUTABLE internal edge records and only ever hands callers FROZEN VIEWS of them
 *    (clone-on-read), never a reference to its mutable record.
 *  - Forgetting = downward tier movement, never deletion while a provenance edge
 *    points at a strand. The {@link StrandStore} contract therefore has no delete;
 *    a tier move is just `putStrand` with a lowered {@link Strand.tier}. This store
 *    honors that — it exposes no per-strand eviction; {@link MemoryStrandStore.clear}
 *    exists for test/teardown only and is NOT part of the contract.
 *
 * Determinism: every Map/Set iterates in insertion order, so the contract's
 * unordered reads are nonetheless reproducible run-to-run — a practical aid for a
 * provable, testable traversal layer.
 */

import type {
  AttributeKey,
  Edge,
  EdgeId,
  EntityId,
  Strand,
  StrandId,
} from "../core/types.js";
import type { NeighborView, StrandStore } from "./StrandStore.js";

/**
 * Mutable internal edge record. Structurally a superset-compatible shape of
 * {@link Edge} but with a WRITABLE `out_weight_sum` so
 * {@link MemoryStrandStore.recomputeOutWeightSum} can update the cached
 * share-normalization denominator in place. Callers never see this type — they
 * only receive frozen {@link Edge} views built by {@link freezeEdge}.
 */
interface InternalEdge {
  readonly id: EdgeId;
  readonly from: StrandId;
  readonly to: StrandId;
  readonly edgeType: Edge["edgeType"];
  readonly link_confidence: number;
  readonly provenance_independence: number;
  readonly recency: number;
  readonly w: number;
  /** The one mutable field: cached Σw over the `from` strand's out-edges. */
  out_weight_sum: number;
}

/** Build a fresh mutable internal record from a contract {@link Edge}. */
function toInternalEdge(edge: Edge): InternalEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    edgeType: edge.edgeType,
    link_confidence: edge.link_confidence,
    provenance_independence: edge.provenance_independence,
    recency: edge.recency,
    w: edge.w,
    out_weight_sum: edge.out_weight_sum,
  };
}

/** Project a mutable internal record to a frozen, contract-shaped {@link Edge} view. */
function freezeEdge(e: InternalEdge): Edge {
  return Object.freeze({
    id: e.id,
    from: e.from,
    to: e.to,
    edgeType: e.edgeType,
    link_confidence: e.link_confidence,
    provenance_independence: e.provenance_independence,
    recency: e.recency,
    w: e.w,
    out_weight_sum: e.out_weight_sum,
  }) as Edge;
}

/**
 * In-memory adjacency-map {@link StrandStore}. Single-process, no persistence;
 * the canonical reference backend the rest of the system is written against. All
 * methods are synchronous (the contract is sync), total, and side-effect-free
 * except the explicit mutators (`putStrand`, `putEdge`, `recomputeOutWeightSum`).
 */
export class MemoryStrandStore implements StrandStore {
  /** Strand map (insertion-ordered). */
  private readonly strandMap = new Map<StrandId, Strand>();
  /** Edge map of MUTABLE internal records (insertion-ordered). */
  private readonly edgeMap = new Map<EdgeId, InternalEdge>();

  /** Entity index: every strand about an entity (shared-entity seed lookup). */
  private readonly entityIndex = new Map<EntityId, Set<StrandId>>();
  /** Attribute index: every strand claiming about an (entity, attribute) pair. */
  private readonly attributeIndex = new Map<AttributeKey, Set<StrandId>>();

  /** Out-adjacency: strand -> set of edge ids leaving it. */
  private readonly outAdj = new Map<StrandId, Set<EdgeId>>();
  /** In-adjacency: strand -> set of edge ids entering it. */
  private readonly inAdj = new Map<StrandId, Set<EdgeId>>();

  // -------------------------------------------------------------------------
  // Strands
  // -------------------------------------------------------------------------

  getStrand(id: StrandId): Strand | null {
    return this.strandMap.get(id) ?? null;
  }

  putStrand(s: Strand): void {
    const id = s.id;
    const prev = this.strandMap.get(id);

    // Re-index entity membership if it changed (or on first insert).
    if (prev === undefined || prev.entity !== s.entity) {
      if (prev !== undefined) {
        this.dropFromIndex(this.entityIndex, prev.entity, id);
      }
      this.addToIndex(this.entityIndex, s.entity, id);
    }

    // Re-index attribute membership if it changed (or on first insert).
    const prevAttr = prev?.attribute ?? null;
    if (prevAttr !== s.attribute) {
      if (prevAttr !== null) {
        this.dropFromIndex(this.attributeIndex, prevAttr, id);
      }
      if (s.attribute !== null) {
        this.addToIndex(this.attributeIndex, s.attribute, id);
      }
    }

    // Ensure adjacency buckets exist so out/in lookups are stable for this node.
    if (!this.outAdj.has(id)) this.outAdj.set(id, new Set<EdgeId>());
    if (!this.inAdj.has(id)) this.inAdj.set(id, new Set<EdgeId>());

    this.strandMap.set(id, s);
  }

  putStrandsBatch(strands: Iterable<Strand>): void {
    // In-memory: no separate durability barrier to amortize — each put is already
    // atomic-per-call, so the batch is exactly the per-strand loop. Index maintenance
    // and replace semantics are therefore IDENTICAL to N {@link putStrand} calls.
    for (const s of strands) this.putStrand(s);
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  getEdge(id: EdgeId): Edge | null {
    const e = this.edgeMap.get(id);
    return e === undefined ? null : freezeEdge(e);
  }

  putEdge(e: Edge): void {
    const id = e.id;
    const prev = this.edgeMap.get(id);

    // If endpoints changed on replace, unwire the old adjacency first.
    if (prev !== undefined && (prev.from !== e.from || prev.to !== e.to)) {
      this.outAdj.get(prev.from)?.delete(id);
      this.inAdj.get(prev.to)?.delete(id);
    }

    this.edgeMap.set(id, toInternalEdge(e));

    this.bucket(this.outAdj, e.from).add(id);
    this.bucket(this.inAdj, e.to).add(id);
  }

  outEdges(id: StrandId): Edge[] {
    return this.collectEdges(this.outAdj.get(id));
  }

  inEdges(id: StrandId): Edge[] {
    return this.collectEdges(this.inAdj.get(id));
  }

  neighbors(id: StrandId): NeighborView[] {
    const ids = this.outAdj.get(id);
    if (ids === undefined || ids.size === 0) return [];
    const views: NeighborView[] = [];
    for (const edgeId of ids) {
      const e = this.edgeMap.get(edgeId);
      if (e === undefined) continue;
      const dest = this.strandMap.get(e.to);
      // Skip dangling edges (destination not yet stored); they remain visible via
      // outEdges() but cannot form a NeighborView without a resolved strand.
      if (dest === undefined) continue;
      views.push({ edge: freezeEdge(e), strand: dest });
    }
    return views;
  }

  // -------------------------------------------------------------------------
  // Seed indexes
  // -------------------------------------------------------------------------

  strandsByEntity(entity: EntityId): Strand[] {
    return this.collectStrands(this.entityIndex.get(entity));
  }

  strandsByAttribute(attr: AttributeKey): Strand[] {
    return this.collectStrands(this.attributeIndex.get(attr));
  }

  // -------------------------------------------------------------------------
  // Full scans (offline maintenance only)
  // -------------------------------------------------------------------------

  allStrands(): Iterable<Strand> {
    return this.strandMap.values();
  }

  *allEdges(): Iterable<Edge> {
    for (const e of this.edgeMap.values()) yield freezeEdge(e);
  }

  // -------------------------------------------------------------------------
  // Share-normalization maintenance
  // -------------------------------------------------------------------------

  recomputeOutWeightSum(from: StrandId): void {
    const out = this.outAdj.get(from);
    if (out === undefined || out.size === 0) return;

    let sum = 0;
    for (const edgeId of out) {
      const e = this.edgeMap.get(edgeId);
      if (e !== undefined) sum += e.w;
    }
    // Write the cached denominator back onto every out-edge of this node, so the
    // walk can read `w / out_weight_sum` directly (share-normalization).
    for (const edgeId of out) {
      const e = this.edgeMap.get(edgeId);
      if (e !== undefined) e.out_weight_sum = sum;
    }
  }

  // -------------------------------------------------------------------------
  // Non-contract convenience (NOT part of StrandStore)
  // -------------------------------------------------------------------------

  /** Number of strands held (test/diagnostic helper; not a contract method). */
  strandCount(): number {
    return this.strandMap.size;
  }

  /** Number of edges held (test/diagnostic helper; not a contract method). */
  edgeCount(): number {
    return this.edgeMap.size;
  }

  /**
   * Drop all strands, edges, and indexes. For test teardown / fresh fixtures ONLY
   * — this is NOT forgetting (which is downward tier movement, never deletion) and
   * is intentionally absent from the {@link StrandStore} contract.
   */
  clear(): void {
    this.strandMap.clear();
    this.edgeMap.clear();
    this.entityIndex.clear();
    this.attributeIndex.clear();
    this.outAdj.clear();
    this.inAdj.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Get-or-create the adjacency Set for a strand id. */
  private bucket(map: Map<StrandId, Set<EdgeId>>, id: StrandId): Set<EdgeId> {
    let set = map.get(id);
    if (set === undefined) {
      set = new Set<EdgeId>();
      map.set(id, set);
    }
    return set;
  }

  /** Add a strand id to an index bucket, creating the bucket on first use. */
  private addToIndex<K>(
    index: Map<K, Set<StrandId>>,
    key: K,
    id: StrandId,
  ): void {
    let set = index.get(key);
    if (set === undefined) {
      set = new Set<StrandId>();
      index.set(key, set);
    }
    set.add(id);
  }

  /** Remove a strand id from an index bucket, pruning the bucket when empty. */
  private dropFromIndex<K>(
    index: Map<K, Set<StrandId>>,
    key: K,
    id: StrandId,
  ): void {
    const set = index.get(key);
    if (set === undefined) return;
    set.delete(id);
    if (set.size === 0) index.delete(key);
  }

  /** Materialize a deterministic, frozen array of edge views from edge ids. */
  private collectEdges(ids: Set<EdgeId> | undefined): Edge[] {
    if (ids === undefined || ids.size === 0) return [];
    const out: Edge[] = [];
    for (const edgeId of ids) {
      const e = this.edgeMap.get(edgeId);
      if (e !== undefined) out.push(freezeEdge(e));
    }
    return out;
  }

  /** Materialize a deterministic array of strand views from strand ids. */
  private collectStrands(ids: Set<StrandId> | undefined): Strand[] {
    if (ids === undefined || ids.size === 0) return [];
    const out: Strand[] = [];
    for (const strandId of ids) {
      const s = this.strandMap.get(strandId);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
}

/**
 * Factory for the default backend. Returns the {@link StrandStore} interface (not
 * the concrete class) so call sites stay backend-agnostic and a faster store can
 * be dropped in later without touching them.
 */
export function createMemoryStore(): StrandStore {
  return new MemoryStrandStore();
}
