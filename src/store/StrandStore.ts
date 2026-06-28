/**
 * store/StrandStore.ts — THE PLUGGABLE STORAGE CONTRACT for Intelligent DB.
 *
 * This module defines the single interface the whole engine talks to when it
 * reads or writes the web. It is a PURE CONTRACT: no implementation lives here.
 * The in-memory graph store (the first backend) implements this; a faster
 * backend (an on-disk / columnar / mmap'd store) can replace it later without
 * any caller changing, because callers depend only on this interface.
 *
 * Design grounding (see CLAUDE.md):
 *  - Memory is a "memory palace / spider-web": strands (nodes) are LATENT and
 *    surface only via spreading activation along edges (threads). Nothing sits in
 *    a readable list. The store is the substrate the activation walk crawls — it
 *    must make a node's out-edges, in-edges, and immediate neighbors cheap to
 *    enumerate, because that is the inner loop of the share-normalized
 *    best-first walk.
 *  - "Threads connect only on shared entity + confirmed link." The store maintains
 *    an ENTITY index and an (entity, attribute) ATTRIBUTE index so a cue can SEED
 *    the walk by entity and so co-equal-claim cardinality (the contradiction-bomb
 *    signal) can be counted — since nothing here is found by content scan.
 *  - "Web of webs": CROSS_WEB_BRIDGE edges are ordinary edges to the store (it is
 *    edge-type agnostic); the traversal layer — not the store — interprets the
 *    bridge sub-budget. The store only has to surface them via {@link Edge.edgeType}.
 *  - Share-normalization: the walk computes `child = parent * (w / out_weight_sum) * γ`
 *    per out-edge so high-degree junk hubs self-starve. The store OWNS the cached
 *    `out_weight_sum` denominator and must keep it consistent — see
 *    {@link StrandStore.recomputeOutWeightSum}.
 *  - Forgetting = downward tier movement, never deletion while any provenance edge
 *    points at a strand. The store therefore has NO `delete` method by design;
 *    a tier move (HOT->WARM->COLD->ARCHIVE) is expressed by writing the strand
 *    back with a lowered {@link Strand.tier}.
 *
 * The store is value-semantics over the shared types in core/types.ts. It does
 * NOT redefine the strand/edge model — it imports it via `import type`.
 *
 * Synchrony: every method returns SYNCHRONOUSLY. The first backend is in-memory
 * and the spreading-activation inner loop is hot; a Promise-or-value union would
 * bleed `await` through the entire walk for no benefit today. A future async
 * backend is expected to front this contract with its own adapter rather than
 * widening these signatures.
 */

import type {
  Strand,
  StrandId,
  Edge,
  EdgeId,
  EntityId,
  AttributeKey,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Read views
// ---------------------------------------------------------------------------

/**
 * One step of the activation frontier: an out-edge (the thread the walk would
 * traverse) paired with the strand it lands on. This is exactly the unit the
 * spreading-activation walk consumes — it needs both halves at once to compute
 * `child = parent * (edge.w / edge.out_weight_sum) * γ` AND to read the
 * destination strand's register / fact_state / provenance.
 *
 * Bundling them lets a backend return a node's neighborhood in a single pass
 * (and lets a future backend co-locate edge + destination for cache locality)
 * instead of forcing the caller to issue a {@link StrandStore.getStrand} per edge.
 */
export interface NeighborView {
  /** The thread traversed to reach {@link NeighborView.strand}. */
  readonly edge: Edge;
  /** The destination strand `edge.to` resolves to. */
  readonly strand: Strand;
}

/**
 * A predicate over edges for filtered enumeration. All present fields must match
 * (logical AND); absent fields are wildcards. Kept deliberately small — the store
 * is not a query engine. Richer selection (bridge sub-budget, refractory state,
 * convergence ordering) is the traversal layer's job, computed over the cheap
 * adjacency primitives this store exposes.
 *
 * @example
 *   // Only the CROSS_WEB_BRIDGE out-edges leaving a node, for the bridge sweep.
 *   { from: nodeId, edgeType: EdgeType.CROSS_WEB_BRIDGE }
 */
export interface EdgeQuery {
  /** Restrict to edges leaving this strand. */
  readonly from?: StrandId;
  /** Restrict to edges entering this strand. */
  readonly to?: StrandId;
  /** Restrict to a single structural class (e.g. CROSS_WEB_BRIDGE for a bridge sweep). */
  readonly edgeType?: Edge["edgeType"];
}

// ---------------------------------------------------------------------------
// Transaction contract (optional, no-op for the in-memory backend)
// ---------------------------------------------------------------------------

/**
 * An OPTIONAL unit-of-work handle. The in-memory backend is single-threaded and
 * atomic-per-call, so its implementation may be a NO-OP that simply forwards to
 * the store. The contract exists so a future durable/concurrent backend can group
 * a batch of writes (e.g. a contradiction demotion: write the loser's
 * `outranked_by`, write the OUTRANKS edge, recompute the winner's
 * `out_weight_sum`) into one all-or-nothing commit.
 *
 * Callers that do not need atomicity simply never open a txn and use the store
 * directly; the engine MUST remain correct when {@link StoreTxn} is a no-op.
 */
export interface StoreTxn {
  /** Commit all writes performed within this unit of work. No-op in-memory. */
  commit(): void;
  /** Abandon all writes performed within this unit of work. No-op in-memory. */
  rollback(): void;
}

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

/**
 * The pluggable storage CONTRACT for the strand web.
 *
 * Responsibilities the store OWNS (everything else belongs to higher layers):
 *  - Identity-keyed storage and retrieval of strands and edges.
 *  - The adjacency indexes ({@link StrandStore.outEdges} / {@link StrandStore.inEdges})
 *    that make the activation walk's per-node step O(degree), not O(|E|).
 *  - The shared-entity / shared-attribute indexes that let a cue SEED the walk
 *    ("energize a seed strand") by entity or by (entity, attribute) claim, since
 *    nothing in this design is found by content scan.
 *  - The cached `out_weight_sum` share-normalization denominator
 *    (re-derived by {@link StrandStore.recomputeOutWeightSum}).
 *
 * Responsibilities the store explicitly does NOT have:
 *  - No deletion: forgetting is downward tier movement; a strand leaves "hot"
 *    storage only as an archive stub, expressed by writing it back with a lowered
 *    {@link Strand.tier}. There is intentionally no `deleteStrand`.
 *  - No ranking / halting / independence judgement: those read the identity stamp
 *    and run the two-phase walk; the store is value-neutral plumbing.
 */
export interface StrandStore {
  // -- Strands -------------------------------------------------------------

  /**
   * Fetch a strand by id, or `null` if the store has never seen it. Used
   * constantly by the walk to resolve an edge's `to` into a node whose register
   * and fact_state it can read. Total and side-effect-free.
   */
  getStrand(id: StrandId): Strand | null;

  /**
   * Insert or replace a strand by its {@link Strand.id}. The store updates its
   * entity and (entity, attribute) indexes to reflect the strand's current
   * `entity` / `attribute`. A tier move (HOT->WARM->COLD->ARCHIVE) is just a
   * `putStrand` with a lowered `tier` — there is deliberately no separate evict
   * call, honoring "never deletion while a provenance edge points at a strand".
   *
   * Note: `putStrand` does NOT recompute edge weights. Edge writes own their own
   * `w`; the source node's `out_weight_sum` is reconciled separately via
   * {@link StrandStore.recomputeOutWeightSum}.
   */
  putStrand(s: Strand): void;

  /**
   * BULK INGEST: insert/replace MANY strands as one unit. Semantically identical to
   * calling {@link StrandStore.putStrand} for each element (same entity /
   * (entity, attribute) index maintenance), but a durable backend commits the whole
   * batch under ONE transaction / ONE durability barrier instead of N autocommitted
   * writes. On the in-memory backend this is just the per-strand loop (already
   * atomic-per-call). Nestable on the durable backend: called inside an open
   * {@link StrandStore.beginTxn}, the rows enroll in the outer transaction.
   */
  putStrandsBatch(strands: Iterable<Strand>): void;

  // -- Edges ---------------------------------------------------------------

  /**
   * Fetch an edge (thread) by id, or `null` if unknown. Total and side-effect-free.
   */
  getEdge(id: EdgeId): Edge | null;

  /**
   * Insert or replace an edge by its {@link Edge.id}. The store wires it into both
   * adjacency indexes so it appears in `outEdges(edge.from)` and `inEdges(edge.to)`.
   *
   * IMPORTANT: `putEdge` does not by itself fix the share-normalization
   * denominator. After adding, replacing, or reweighting one or more out-edges of
   * a node, the caller MUST call {@link StrandStore.recomputeOutWeightSum} for that
   * node so the cached {@link Edge.out_weight_sum} stays equal to Σ w over the
   * node's out-edges. (Doing it as one explicit step keeps a batch of edge writes
   * to a node O(degree) total instead of O(degree) per edge.)
   */
  putEdge(e: Edge): void;

  /**
   * All out-edges (threads leaving) the given strand, in no guaranteed order.
   * This is the activation walk's primary expansion primitive: popping a strand
   * means iterating its out-edges and spreading `parent * (w / out_weight_sum) * γ`
   * to each destination. Returns `[]` for an unknown or leaf strand.
   */
  outEdges(id: StrandId): Edge[];

  /**
   * All in-edges (threads entering) the given strand, in no guaranteed order.
   * Used by reverse reasoning: provenance / derivation back-walks, finding which
   * strand OUTRANKS this one, and "what points at me" forgetting gates (a strand
   * with live in-edges from independent roots is harder to evict). Returns `[]`
   * for an unknown or root strand.
   */
  inEdges(id: StrandId): Edge[];

  /**
   * The immediate neighborhood of a strand as {@link NeighborView}s — each
   * out-edge already paired with the destination strand it resolves to. This is
   * the convenience the walk's inner loop wants: one call yields everything needed
   * to compute and deposit child activation without a follow-up
   * {@link StrandStore.getStrand} per edge.
   *
   * Only out-edges whose `to` resolves to a known strand are included; a dangling
   * edge (destination not yet stored) is skipped here (it is still visible via
   * {@link StrandStore.outEdges}). Returns `[]` for an unknown or leaf strand.
   */
  neighbors(id: StrandId): NeighborView[];

  // -- Seed indexes (how a cue enters the web) -----------------------------

  /**
   * All strands ABOUT a given entity. Threads connect only on shared entity, so
   * this index is how a cue first energizes seed strands: an incoming cue mentions
   * an entity, and these strands become the initial activation frontier. Returns
   * `[]` when the entity is unknown to the store.
   */
  strandsByEntity(entity: EntityId): Strand[];

  /**
   * All strands making a claim under a given (entity, attribute) key. This is the
   * co-equal-claim view: contradiction detection and demotion operate over the set
   * of strands sharing one {@link AttributeKey} (the "Berlin->Tokyo pending"
   * superposition, the contradiction-bomb cardinality). Returns `[]` when the
   * attribute key is unknown.
   */
  strandsByAttribute(attr: AttributeKey): Strand[];

  // -- Full scans (maintenance / offline only) -----------------------------

  /**
   * Iterate EVERY strand. NOT part of the query/activation path — the design
   * forbids answering by list scan. This exists for OFFLINE maintenance only:
   * decay sweeps, recomputing `earned_bridge_value` / `far_side_potential`,
   * ancestor-sketch rebuilds, archive-stub verification. Iteration order is
   * unspecified.
   */
  allStrands(): Iterable<Strand>;

  /**
   * Iterate EVERY edge. OFFLINE maintenance only (e.g. global recency re-decay,
   * bulk `out_weight_sum` rebuild, bridge re-classification). Iteration order is
   * unspecified.
   */
  allEdges(): Iterable<Edge>;

  // -- Share-normalization maintenance -------------------------------------

  /**
   * Re-derive the cached {@link Edge.out_weight_sum} across ALL out-edges of
   * `from`, setting each out-edge's `out_weight_sum` to Σ w over that set.
   *
   * This is the store's one piece of non-trivial bookkeeping and it is
   * load-bearing for correctness: the activation walk's share-normalization step
   * `w / out_weight_sum` only starves high-degree hubs if the denominator truly
   * equals the current sum of the node's out-edge weights. Call this after any
   * mutation that adds, removes, or reweights an out-edge of `from` (a new thread,
   * a recency re-decay, a `provenance_independence` update from a fresh identity
   * stamp). Idempotent. A no-op when `from` has no out-edges.
   */
  recomputeOutWeightSum(from: StrandId): void;

  // -- Optional unit of work -----------------------------------------------

  /**
   * Begin an OPTIONAL unit of work. The in-memory backend may return a no-op
   * {@link StoreTxn} (each call is already atomic). Durable / concurrent backends
   * may return a real transaction so a multi-write operation (a demotion, a
   * consolidation) commits atomically. The engine must remain correct whether or
   * not a txn is used.
   *
   * The durable backend's `beginTxn` is NESTABLE — a re-entrant call enrolls in the
   * outermost transaction rather than opening a forbidden nested one — so a compound
   * engine operation may open ONE txn around helpers that themselves manage writes.
   */
  beginTxn?(): StoreTxn;

  /**
   * OPTIONAL structural-integrity probe. A durable backend returns whether its
   * underlying file is sound (e.g. SQLite `PRAGMA integrity_check`); the in-memory
   * backend has no on-disk structure to corrupt and omits this. When present and it
   * returns `false`, the store is corrupted and must NOT be served as correct.
   */
  integrityCheck?(): boolean;
}
