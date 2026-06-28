/**
 * adapter.ts — the COMMON interface every store in the cross-DB benchmark implements.
 *
 * The benchmark asks every engine the SAME question: "given a stream of asserted facts
 * about (entity, attribute), what value do you recall?" The honest comparison is what
 * each engine does under a cheap Sybil/poisoning attack (see attack.ts):
 *
 *   - DUMB stores (node:sqlite, better-sqlite3, lmdb, duckdb, a brute-force vector
 *     index) have NO provenance / independence model. They recall by their natural
 *     mechanism — SQL/KV majority-or-latest, or vector nearest-neighbour — and so they
 *     return the FALSE majority once the attacker out-copies the truth. That is the
 *     EXPECTED, HONEST result and the whole point of the comparison.
 *   - The IntelligentDB adapter consults the REAL Source-Identity Layer's
 *     `independentRootCount` (maximum-independent-set over anchor-class disjointness),
 *     so a cheap fleet behind one class collapses to ONE witness and the truth (H
 *     disjoint classes) survives.
 *
 * ASYNC NOTE: `node:sqlite`, better-sqlite3, lmdb, the vector index and the engine are
 * all SYNCHRONOUS; `@duckdb/node-api` is async-only. The interface therefore allows a
 * method to return either a value or a Promise of it (the spec's `Promise<void>|void`
 * shape, widened to `recall`/`writeFact`), and the runner `await`s every call. An
 * optional `flush()` lets a buffering backend (DuckDB's batched appender) commit its
 * write buffer once, so write throughput is measured over write-loop + flush.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; type-only imports use
 * `import type`.
 */

/** One asserted fact: a claim that (entity, attribute) = value, from one source. */
export interface Fact {
  /** The real-world entity the claim is about (the shared-entity join key). */
  readonly entity: string;
  /** The attribute of the entity being claimed (the contested slot under attack). */
  readonly attribute: string;
  /** The claimed value (TRUE or FALSE under the poisoning scenario). */
  readonly value: string;
  /** The cryptographic source id (the attacker mints these freely). */
  readonly sourceId: string;
  /**
   * The OFFLINE-ASSIGNED independence class (the external anchor layer's output — the
   * attacker does NOT control this). A cheap Sybil fleet shares ONE class; honest
   * witnesses each hold a distinct class.
   */
  readonly independenceClass: string;
  /** The deterministic synthetic embedding of this fact (for vector engines). */
  readonly embedding: Float32Array;
}

/** A recall cue: which (entity, attribute) to answer, plus its embedding. */
export interface Cue {
  readonly entity: string;
  readonly attribute: string;
  readonly embedding: Float32Array;
}

/** One ranked candidate answer the engine would speak, most-confident first. */
export interface RankedFact {
  /** The value the engine would assert for the cued (entity, attribute). */
  readonly value: string;
  /** The engine's confidence/ordering signal (count, similarity, or independent count). */
  readonly score: number;
}

/**
 * The common adapter every benchmarked store implements. Methods may be sync or async;
 * the runner awaits all of them. `footprintBytes` is sync and returns the best
 * available footprint (on-disk file size for file-backed engines; a measured/estimated
 * heap figure for purely in-memory engines — each adapter documents which it reports).
 */
export interface MemoryAdapter {
  /** A short, stable engine name (the row label in the results table). */
  readonly name: string;
  /** Open/create the backing store. */
  setup(): Promise<void> | void;
  /** Assert one fact. A buffering backend may queue it until `flush`. */
  writeFact(f: Fact): Promise<void> | void;
  /** Commit any buffered writes (no-op for non-buffering engines). */
  flush?(): Promise<void> | void;
  /** Recall the engine's best answer(s) for the cued (entity, attribute). */
  recall(cue: Cue): Promise<RankedFact[]> | RankedFact[];
  /** The store's footprint in bytes (on-disk file size or measured heap; documented per adapter). */
  footprintBytes(): number;
  /** Release resources / delete temp files. */
  close(): Promise<void> | void;
}
