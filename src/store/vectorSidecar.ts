/**
 * store/vectorSidecar.ts — THE VECTOR SIDECAR (Phase-1 retrieval spec §2).
 *
 * A small, OPTIONAL side-table that accelerates seed SELECTION only (never
 * belief). It stores one L2-agnostic embedding per DISTINCT `content_hash` — never
 * per strand — so echoes (same payload, many strands/roots) share one vector.
 * `model_id` travels with every row so a vector minted by one embedding model is
 * NEVER silently compared against a cue embedded by a different one.
 *
 * THE THESIS CONSTRAINT (see core/types.ts's {@link "../core/types".EmbedderPort}
 * doc and docs/specs/PHASE1_RETRIEVAL_SPEC.md): this module is PURE STORAGE + a
 * brute-force cosine scan. It has no opinion about belief, trust, or fact_state —
 * it is consumed EXCLUSIVELY by the seed-selection seam
 * (`recall/cueResolver.ts`'s `createEmbeddingCueResolver`) and the write-path
 * accelerator (`api.ts`'s `writeFactWithEmbedding`).
 *
 * Two backends, mirroring `store/memoryStore.ts` / `store/sqliteStore.ts`:
 *  - {@link createMemoryVectorSidecar} — an in-memory `Map`, for the in-memory
 *    StrandStore and tests.
 *  - {@link createSqliteVectorSidecar} — a `strand_vectors` table in SQLite
 *    (`node:sqlite`, zero external deps), for the durable backend. Pass the SAME
 *    shared `DatabaseSync` handle used by `createSqliteStore({ db })` so a
 *    vector write PLAIN `INSERT`s (no `BEGIN`/`COMMIT` of its own) and therefore
 *    enrolls in whatever transaction the caller (`writeFact`'s `withTxn`) already
 *    has open on that handle — exactly like the reputation/audit ledgers do.
 *
 * SCHEMA: `strand_vectors` is created by `store/migrations.ts`'s v2 rung
 * (`runMigrations`, called below) — NOT an ad-hoc `CREATE TABLE IF NOT EXISTS`
 * here, per the coordination note in PHASE1_RETRIEVAL_SPEC.md §2 ("land as
 * migration v2 if store/migrations.ts exists"). `runMigrations` is idempotent
 * and safe to call from multiple constructors against the same handle (see its
 * own doc), so calling it here is correct whether or not the caller already
 * called it via `createSqliteStore`.
 *
 * Brute-force cosine scan is the deliberate, spec-sanctioned choice at this
 * phase (0.004ms recall + a few ms scan at 100k vectors; benchmark it before
 * assuming otherwise). No ANN library — zero-dep constraint. If scan cost at 1M
 * vectors ever exceeds ~20ms p50, a coarse int8 pre-filter is the documented
 * next step (still zero-dep) — not implemented here.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`
 * ⇒ every type-only import uses `import type`.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { ContentHash } from "../core/types.js";
import { runMigrations } from "./migrations.js";
import { assertOwnedWal, assertSharedHandleWal } from "./sqliteStore.js";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** One stored vector entry, as returned by {@link VectorSidecar.get}. */
export interface StoredVector {
  readonly modelId: string;
  readonly dim: number;
  readonly vec: Float32Array;
}

/** One brute-force cosine scan hit, ranked descending by {@link score}. */
export interface VectorMatch {
  readonly contentHash: ContentHash;
  readonly score: number;
}

/**
 * The vector sidecar contract. Keyed by `content_hash` — NEVER by strand id — so
 * echoes (many strands sharing one payload) share one vector and one embed call.
 */
export interface VectorSidecar {
  /**
   * Insert or replace the vector for `contentHash` (an UPSERT: a later write for
   * the same hash, even under a different `modelId`, replaces the row — this is
   * the "lazily re-embedded on next write of same hash" behavior the spec
   * describes for a model-id mismatch at open).
   */
  put(contentHash: ContentHash, modelId: string, vec: Float32Array): void;

  /** Fetch the stored vector for `contentHash`, or `null` if none is recorded. */
  get(contentHash: ContentHash): StoredVector | null;

  /**
   * Brute-force cosine top-K over every stored vector whose `model_id` matches
   * `modelId` EXACTLY (a mismatched-model row is silently ignored — never
   * compared across embedding spaces). Ranked descending by cosine score, ties
   * broken by `content_hash` ascending for determinism. Returns at most `k`
   * entries; `k <= 0` returns `[]`.
   */
  topK(queryVec: Float32Array, modelId: string, k: number): VectorMatch[];
}

// ---------------------------------------------------------------------------
// Shared cosine math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two vectors (NOT assumed pre-normalized — computed via
 * the full `dot / (||a|| * ||b||)` so a caller-supplied embedder need not
 * L2-normalize). Returns 0 for a zero-norm vector (undefined direction) rather
 * than `NaN`, so a degenerate embedding never poisons a ranking with `NaN`.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Deterministic string comparator (locale-independent) for tie-breaking. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FINAL ranking order for a {@link VectorMatch} pair: score descending, then
 * `content_hash` ascending on an exact tie (determinism). Returns > 0 when `a`
 * should rank AFTER `b` (`a` is worse), < 0 when `a` should rank BEFORE `b` (`a`
 * is better), 0 only when `a`/`b` are the same row.
 */
function rankOrder(a: VectorMatch, b: VectorMatch): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareStrings(String(a.contentHash), String(b.contentHash));
}

/**
 * A bounded min-heap of at most `capacity` {@link VectorMatch}es, ordered so the
 * ROOT is always the CURRENT WORST kept candidate (by {@link rankOrder}). This is
 * the classic streaming top-K selection primitive: `push` costs O(log capacity)
 * — never O(log n) — and the heap NEVER grows past `capacity`, so scanning `n`
 * candidates costs O(n log k) time and, crucially, only O(k) RETAINED memory
 * (never an O(n) array of every scored candidate).
 *
 * Exported (not merely an implementation --detail) so this exact selection
 * primitive — the one both {@link createMemoryVectorSidecar} and
 * {@link createSqliteVectorSidecar} run every `topK` call through — is directly
 * unit-testable for its size bound, not just indirectly via end-to-end output.
 *
 * FIXES `vectorsidecar-topk-full-materialization`: the previous implementation
 * pushed EVERY scored candidate into one array and ran `Array.prototype.sort`
 * over the whole thing before slicing the first `k` — O(n) retained memory (one
 * wrapper object per candidate, all alive simultaneously) and O(n log n) time
 * regardless of how small `k` is.
 */
export class BoundedTopKHeap {
  readonly #capacity: number;
  readonly #data: VectorMatch[] = [];

  constructor(capacity: number) {
    this.#capacity = Math.max(0, capacity);
  }

  /** Number of candidates currently retained (never exceeds `capacity`). */
  get size(): number {
    return this.#data.length;
  }

  /** Offer a candidate: kept if the heap has room, or if it beats the current worst kept. */
  push(candidate: VectorMatch): void {
    if (this.#capacity <= 0) return;
    if (this.#data.length < this.#capacity) {
      this.#data.push(candidate);
      this.#siftUp(this.#data.length - 1);
      return;
    }
    const worst = this.#data[0];
    // worst is defined here: capacity > 0 and the array is already at capacity.
    if (worst !== undefined && rankOrder(candidate, worst) < 0) {
      // candidate ranks BEFORE (beats) the current worst kept -> evict the root.
      this.#data[0] = candidate;
      this.#siftDown(0);
    }
    // else: candidate is worse than or tied-worse-than everything already kept, and
    // the heap is full -> discard without ever allocating a retained slot for it.
  }

  /** Drain the heap into the FINAL ranked array (best first), per {@link rankOrder}. */
  toSorted(): VectorMatch[] {
    return [...this.#data].sort(rankOrder);
  }

  #siftUp(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      const parentItem = this.#data[parent];
      const item = this.#data[idx];
      if (parentItem === undefined || item === undefined) break;
      // Max-heap on "worseness": a parent must rank AFTER (be worse than or equal
      // to) its children so the single worst-kept candidate stays at the root.
      if (rankOrder(parentItem, item) < 0) {
        this.#data[idx] = parentItem;
        this.#data[parent] = item;
        idx = parent;
      } else {
        break;
      }
    }
  }

  #siftDown(i: number): void {
    let idx = i;
    const n = this.#data.length;
    for (;;) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let worst = idx;
      const worstItem0 = this.#data[worst];
      if (worstItem0 === undefined) break;
      let worstItem = worstItem0;
      if (left < n) {
        const leftItem = this.#data[left];
        if (leftItem !== undefined && rankOrder(leftItem, worstItem) > 0) {
          worst = left;
          worstItem = leftItem;
        }
      }
      if (right < n) {
        const rightItem = this.#data[right];
        if (rightItem !== undefined && rankOrder(rightItem, worstItem) > 0) {
          worst = right;
          worstItem = rightItem;
        }
      }
      if (worst === idx) break;
      const tmp = this.#data[idx];
      if (tmp === undefined) break;
      this.#data[idx] = worstItem;
      this.#data[worst] = tmp;
      idx = worst;
    }
  }
}

/**
 * Rank a candidate stream by cosine score descending, `content_hash` ascending on
 * ties, and take the top `k` — via a bounded {@link BoundedTopKHeap}, never a
 * full materialize-then-sort. Shared by both backends so the ranking rule and the
 * O(k)-memory selection algorithm are each defined exactly once. `candidates` is
 * consumed lazily (one at a time): the SQLite backend feeds this from
 * `stmt.iterate()` (never `.all()`), so a brute-force scan over N stored vectors
 * never materializes more than ONE row + at most `k` scored candidates at a time.
 */
function rankTopK(
  candidates: Iterable<{ contentHash: ContentHash; modelId: string; vec: Float32Array }>,
  queryVec: Float32Array,
  modelId: string,
  k: number,
): VectorMatch[] {
  if (k <= 0) return [];
  const heap = new BoundedTopKHeap(k);
  for (const c of candidates) {
    if (c.modelId !== modelId) continue; // mismatched-model row: silently ignored
    heap.push({ contentHash: c.contentHash, score: cosineSimilarity(queryVec, c.vec) });
  }
  return heap.toSorted();
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

interface MemRow {
  readonly modelId: string;
  readonly dim: number;
  readonly vec: Float32Array;
}

/**
 * In-memory {@link VectorSidecar} — a `Map<ContentHash, MemRow>`, matching the
 * spec's "in-memory Map for the memory store". Single-process, non-durable
 * (mirrors {@link "./memoryStore".MemoryStrandStore}).
 */
export function createMemoryVectorSidecar(): VectorSidecar {
  const rows = new Map<ContentHash, MemRow>();

  return {
    put(contentHash, modelId, vec) {
      // Copy the vector so a caller mutating its own Float32Array afterward can
      // never corrupt the stored row (clone-on-write, mirroring the store's
      // clone-on-read discipline elsewhere in this codebase).
      rows.set(contentHash, { modelId, dim: vec.length, vec: Float32Array.from(vec) });
    },
    get(contentHash) {
      const row = rows.get(contentHash);
      if (row === undefined) return null;
      return { modelId: row.modelId, dim: row.dim, vec: Float32Array.from(row.vec) };
    },
    topK(queryVec, modelId, k) {
      function* iter(): Generator<{ contentHash: ContentHash; modelId: string; vec: Float32Array }> {
        for (const [contentHash, row] of rows) {
          yield { contentHash, modelId: row.modelId, vec: row.vec };
        }
      }
      return rankTopK(iter(), queryVec, modelId, k);
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` — identical
 * rationale to `store/sqliteStore.ts`: a static `import` of a Node 24+ built-in
 * newer than bundlers' hardcoded built-in lists makes Vite/Vitest try to bundle
 * a bare `sqlite` package. `require("node:sqlite")` is opaque to that static
 * analysis and resolves via Node's own loader — still zero external deps.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** Widened with `close()` for the owned-handle (path-opening) case. */
export interface SqliteVectorSidecar extends VectorSidecar {
  /** Close the underlying handle. No-op when the handle is a BORROWED shared one. */
  close(): void;
}

/** Serialize a Float32Array to a Buffer for a BLOB column (little-endian, as-is). */
function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Deserialize a BLOB column value back into an owned (copied) Float32Array. */
function fromBlob(raw: unknown): Float32Array {
  const buf = raw as Uint8Array;
  // Copy into a fresh, aligned ArrayBuffer: `buf` may be a view into a statement's
  // internal buffer that gets reused/invalidated on the next call.
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/**
 * Durable {@link VectorSidecar} backed by a `strand_vectors` table. Pass a `path`
 * string to open+own a dedicated handle, or `{ db }` to share the SAME handle a
 * `createSqliteStore({ db })` / reputation / audit ledger already opened — the
 * latter is what makes a vector write ride the caller's open `writeFact`
 * transaction (no `BEGIN`/`COMMIT` is issued here; plain `INSERT`s enroll in
 * whatever transaction is already open on the shared handle).
 */
export function createSqliteVectorSidecar(
  arg: string | { db: DatabaseSyncType },
): SqliteVectorSidecar {
  const owns = typeof arg === "string";
  const db: DatabaseSyncType = owns ? new DatabaseSync(arg as string) : (arg as { db: DatabaseSyncType }).db;

  if (owns) {
    // Standalone/owned handle (e.g. a test or a caller not sharing the main
    // store's handle): set the same crash-safety floor the main store uses, and
    // VERIFY (not just request) that WAL actually took — closes
    // `vectorsidecar-unverified-wal`: this constructor used to set the pragma and
    // trust it blindly, unlike `createSqliteStore`'s owned path, which has always
    // read the pragma back and refused a silent rollback-journal downgrade (e.g. on
    // a network filesystem). Shared helper, same failure mode as the main store.
    assertOwnedWal(db, "createSqliteVectorSidecar");
    db.exec("PRAGMA synchronous=NORMAL");
  } else {
    // BORROWED shared handle: never set connection-wide pragmas on someone else's
    // handle — only VERIFY the owner already put it in WAL mode, mirroring
    // `createSqliteStore`'s `{ db }` overload. Previously this constructor did
    // NOTHING for the shared-handle path, so a vector sidecar sharing an
    // unverified (or genuinely non-WAL) handle gave no signal short of an actual
    // crash losing data.
    assertSharedHandleWal(db, "createSqliteVectorSidecar");
  }

  // Runs the FULL ladder (v1 + v2) on a brand-new handle, or just the pending
  // rungs on one another constructor already partially migrated — idempotent,
  // safe to call more than once against the same handle (see migrations.ts).
  runMigrations(db);

  const putStmt = db.prepare(
    `INSERT INTO strand_vectors (content_hash, model_id, dim, vec) VALUES (?, ?, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       model_id = excluded.model_id,
       dim = excluded.dim,
       vec = excluded.vec`,
  );
  const getStmt = db.prepare(
    "SELECT model_id, dim, vec FROM strand_vectors WHERE content_hash = ?",
  );
  const byModelStmt = db.prepare(
    "SELECT content_hash, vec FROM strand_vectors WHERE model_id = ?",
  );

  return {
    put(contentHash, modelId, vec) {
      putStmt.run(contentHash as string, modelId, vec.length, toBlob(vec));
    },
    get(contentHash) {
      const row = getStmt.get(contentHash as string) as
        | { model_id: string; dim: number; vec: unknown }
        | undefined;
      if (row === undefined) return null;
      return { modelId: row.model_id, dim: row.dim, vec: fromBlob(row.vec) };
    },
    topK(queryVec, modelId, k) {
      if (k <= 0) return [];
      // STREAM rows via stmt.iterate() rather than .all(): the latter materializes
      // EVERY matching row into one JS array before scoring even begins (the
      // `vectorsidecar-topk-full-materialization` finding). iterate() yields rows
      // lazily off the open statement, so combined with rankTopK's bounded heap,
      // this scan never retains more than one raw row + `k` scored candidates at
      // once, however many rows `model_id` matches.
      function* iter(): Generator<{ contentHash: ContentHash; modelId: string; vec: Float32Array }> {
        for (const r of byModelStmt.iterate(modelId) as Iterable<{
          content_hash: string;
          vec: unknown;
        }>) {
          yield {
            contentHash: r.content_hash as ContentHash,
            modelId,
            vec: fromBlob(r.vec),
          };
        }
      }
      return rankTopK(iter(), queryVec, modelId, k);
    },
    close() {
      if (owns) db.close();
    },
  };
}
