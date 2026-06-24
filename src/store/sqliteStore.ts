/**
 * store/sqliteStore.ts — a DURABLE, crash-safe SQLite-backed StrandStore.
 *
 * This is a DROP-IN replacement for the in-memory {@link MemoryStrandStore}: it
 * implements the exact same {@link StrandStore} contract (synchronously — the whole
 * engine talks only to that interface), but persists every strand and edge to a
 * SQLite database on disk via Node's built-in `node:sqlite` (`DatabaseSync`). A
 * fact filed through the engine survives the process dying and is recalled by a new
 * store opened on the same path.
 *
 * Why this fits the contract with ZERO friction:
 *  - `node:sqlite`'s `DatabaseSync` / `StatementSync` API is FULLY SYNCHRONOUS, so
 *    the synchronous StrandStore contract is honored directly — no `async`/Promise
 *    leaks into the hot spreading-activation walk.
 *  - ZERO external runtime deps: `node:sqlite` is Node stdlib (Node 24+).
 *
 * Design grounding (see CLAUDE.md / store/StrandStore.ts):
 *  - Strands and edges are persisted as canonical JSON in a row keyed by id. The
 *    branded id strings, enums, nested provenance / salience / bridge objects, and
 *    the `payload: unknown` all round-trip faithfully through JSON (brands are
 *    runtime-erased plain strings; a single cast at the parse boundary restores the
 *    static type).
 *  - The shared-entity / shared-attribute SEED indexes (how a cue energizes the
 *    walk) and the out/in ADJACENCY indexes (the walk's per-node O(degree) step)
 *    are backed by indexed columns, so those reads are indexed lookups, not scans.
 *  - The store OWNS the cached `out_weight_sum` share-normalization denominator;
 *    {@link SqliteStrandStore.recomputeOutWeightSum} re-derives Σw over a node's
 *    out-edges and rewrites each out-edge row (one transaction).
 *  - Forgetting = downward tier movement, never deletion: this store, like the
 *    contract, exposes NO delete — a tier move is just a `putStrand`.
 *
 * DURABILITY / CRASH-SAFETY: the database is opened in WAL mode
 * (`PRAGMA journal_mode=WAL`) with `PRAGMA synchronous=NORMAL` — the standard
 * crash-safe/throughput operating point: a process crash cannot corrupt committed
 * data, and every `putStrand` / `putEdge` is its own autocommitted, durable write.
 *
 * Edge READ contract: callers receive FROZEN {@link Edge} views (mirroring the
 * in-memory store's clone-on-read frozen-view contract) so a caller can never
 * mutate stored state through a returned reference.
 *
 * STACK NOTE: ESM + NodeNext means relative imports carry the `.js` extension;
 * `verbatimModuleSyntax` means every type-only import uses `import type`. The only
 * VALUE import is `DatabaseSync` from `node:sqlite`.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  AttributeKey,
  Edge,
  EdgeId,
  EdgeType,
  EntityId,
  Strand,
  StrandId,
} from "../core/types.js";
import type { NeighborView, StoreTxn, StrandStore } from "./StrandStore.js";

/**
 * Load `node:sqlite`'s {@link DatabaseSync} constructor via a runtime `require`
 * rather than a static `import`.
 *
 * WHY: `node:sqlite` is a Node 24+ built-in newer than the hardcoded built-in list
 * in the bundlers/test transformers that process this source (e.g. Vite 5 used by
 * Vitest). A STATIC `import` of it makes those tools' dependency scanners strip the
 * `node:` prefix and try to bundle a bare `sqlite` package, which fails. A runtime
 * `require("node:sqlite")` is opaque to that static analysis and is resolved by
 * Node's own loader exactly as in production — keeping ZERO external runtime deps
 * (this is still a Node stdlib module). The TYPE is imported separately (erased at
 * runtime), so `DatabaseSync` stays fully typed.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * The {@link StrandStore} a {@link createSqliteStore} returns, widened with the one
 * lifecycle method a durable backend needs: {@link SqliteStrandStore.close}. The
 * widened type is still assignable to {@link StrandStore}, so
 * `createIntelligentDb(store, …)` accepts it unchanged (drop-in).
 */
export interface SqliteStrandStore extends StrandStore {
  /**
   * Close the underlying database handle, flushing the WAL. Call on teardown /
   * before deleting the database file. Not part of the {@link StrandStore} contract
   * (the in-memory backend needs no close); present only on the durable backend.
   *
   * No-op when the store was handed a BORROWED, shared `db` handle (only the single
   * owner — the path-opening factory or the caller that opened the handle — may
   * close it).
   */
  close(): void;

  /**
   * BULK INGEST: insert/replace MANY strands under ONE prepared statement and ONE
   * transaction (one `BEGIN`/`COMMIT`, hence one durability barrier) instead of N
   * autocommitted writes. Additive, SQLite-only widening of the {@link StrandStore}
   * contract (like {@link SqliteStrandStore.beginTxn}) — the engine and the in-memory
   * backend are untouched. Nestable: if called inside an open {@link beginTxn}, the
   * rows enroll in the outer transaction (no inner `BEGIN`/`COMMIT`). Semantically
   * identical to calling {@link putStrand} for each element; the only difference is
   * that the whole batch commits atomically and pays one fsync-class barrier.
   */
  putStrandsBatch(strands: Iterable<Strand>): void;

  /**
   * BULK INGEST: insert/replace MANY edges under ONE prepared statement and ONE
   * transaction. Same atomicity/nesting semantics as {@link putStrandsBatch}.
   *
   * NOTE: like {@link putEdge}, this does NOT recompute share-normalization
   * denominators — the caller must still call {@link recomputeOutWeightSum} for each
   * affected `from` node afterward (ideally inside the SAME outer transaction).
   */
  putEdgesBatch(edges: Iterable<Edge>): void;

  /**
   * Begin an all-or-nothing unit of work over the shared db handle (BEGIN; COMMIT on
   * `commit()`, ROLLBACK on `rollback()`). Always present on the durable backend so a
   * compound engine/ledger operation (an adjudication, an approve, a disown sweep, a
   * multi-edge writeFact) commits FACTS + the inner reputation/audit writes that ride
   * the SAME handle as ONE atomic transaction. Nestable: an inner `recomputeOutWeightSum`
   * or a re-entrant `beginTxn` enrolls in the outermost transaction rather than opening
   * a forbidden nested SQLite `BEGIN`.
   */
  beginTxn(): StoreTxn;

  /**
   * Run `PRAGMA integrity_check` and report whether the database is structurally
   * sound. Returns `true` iff SQLite reports the single row `"ok"` — a torn/corrupted
   * page set, a truncated file, or index/page damage yields `false`. This is the
   * STRUCTURAL half of corruption detection (the audit chain's `verifyChain` is the
   * SEMANTIC half); a corrupted store is never silently served as correct.
   */
  integrityCheck(): boolean;
}

/**
 * A row in the `strands` table. `json` is the canonical serialized {@link Strand};
 * `entity` / `attribute` are denormalized into indexed columns for the seed indexes.
 */
const CREATE_STRANDS = `
  CREATE TABLE IF NOT EXISTS strands (
    id        TEXT PRIMARY KEY,
    json      TEXT NOT NULL,
    entity    TEXT NOT NULL,
    attribute TEXT
  )
`;

/**
 * A row in the `edges` table. `json` is the canonical serialized {@link Edge};
 * `from_id` / `to_id` / `edge_type` are denormalized into indexed columns for the
 * adjacency reads.
 */
const CREATE_EDGES = `
  CREATE TABLE IF NOT EXISTS edges (
    id        TEXT PRIMARY KEY,
    json      TEXT NOT NULL,
    from_id   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    edge_type TEXT NOT NULL
  )
`;

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_strands_entity ON strands(entity)`,
  `CREATE INDEX IF NOT EXISTS idx_strands_attr   ON strands(attribute)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from      ON edges(from_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to        ON edges(to_id)`,
];

/**
 * Parse a stored `json` cell back into a {@link Strand}. The brands on ids/enums are
 * runtime-erased plain strings, so a single cast at this boundary is correct and is
 * the only place a cast is needed. (The value was produced by `JSON.stringify` over
 * a real Strand, so the shape is faithful.)
 */
function parseStrand(json: string): Strand {
  return JSON.parse(json) as Strand;
}

/**
 * Parse a stored `json` cell back into a FROZEN {@link Edge} view, mirroring the
 * in-memory store's frozen-view read contract so callers cannot mutate stored state
 * through the returned reference.
 */
function parseEdge(json: string): Edge {
  return Object.freeze(JSON.parse(json) as Edge);
}

/** Narrow a SQLite output cell that must be a string (a NOT NULL `json` column). */
function asString(v: unknown): string {
  return v as string;
}

/**
 * Durable, WAL-mode, SQLite-backed {@link StrandStore}. Single-file persistence with
 * the same adjacency / entity / attribute indexing the in-memory backend provides,
 * plus crash-safety. All methods are synchronous (the contract is sync; `node:sqlite`
 * is sync), total, and side-effect-free except the explicit mutators (`putStrand`,
 * `putEdge`, `recomputeOutWeightSum`).
 */
class SqliteStrandStoreImpl implements SqliteStrandStore {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;

  /**
   * Transaction nesting depth. SQLite forbids a nested `BEGIN`, so only the OUTERMOST
   * unit of work issues `BEGIN`/`COMMIT`/`ROLLBACK`; inner re-entrant `beginTxn()` and
   * the inner `BEGIN/COMMIT` in {@link recomputeOutWeightSum} simply enroll in the open
   * transaction (their writes still happen — under the outer txn — but they emit no SQL
   * transaction-control statement). This is the single highest-risk detail of the
   * shared-handle atomicity: get it wrong and either a nested BEGIN throws or an inner
   * COMMIT prematurely commits the outer txn.
   */
  #txnDepth = 0;

  // Lazily-prepared, reused statements (one parse of the SQL each, then bound per call).
  readonly #getStrand;
  readonly #putStrand;
  readonly #getEdge;
  readonly #putEdge;
  readonly #outEdges;
  readonly #inEdges;
  readonly #byEntity;
  readonly #byAttribute;
  readonly #allStrands;
  readonly #allEdges;

  constructor(opts: {
    db: DatabaseSyncType;
    ownsDb: boolean;
    synchronous?: "NORMAL" | "FULL";
  }) {
    this.#db = opts.db;
    this.#ownsDb = opts.ownsDb;

    // DURABILITY: WAL mode + NORMAL sync — committed data survives a crash, and the
    // WAL gives good write throughput. Each put below is its own autocommitted write.
    // Only the OWNER of the handle sets the connection-wide pragmas (a borrowed shared
    // handle already had them set by its owner — re-running them is harmless but the
    // owner is the authoritative place, mirroring the ledger drop-ins).
    if (opts.ownsDb) {
      // WAL: one writer + many concurrent readers; a crash cannot corrupt committed
      // data. This is the durability floor and is NOT negotiable.
      this.#db.exec("PRAGMA journal_mode=WAL");
      // synchronous=NORMAL (the DEFAULT) — under WAL, a power-cut/OS-crash can lose
      // only the LAST committed txn, never corrupt the file or leave a half-applied
      // compound op. FULL (fsync on every commit) is the opt-in zero-loss-on-power-cut
      // knob at a throughput cost; the bank may set { synchronous: "FULL" }. We never
      // SILENTLY weaken durability — NORMAL is the deliberate, documented operating
      // point (see CLAUDE.md GAP LIST) and the default stays NORMAL.
      this.#db.exec(`PRAGMA synchronous=${opts.synchronous ?? "NORMAL"}`);
      // FK off (we manage adjacency ourselves; the contract permits dangling edges).
      this.#db.exec("PRAGMA foreign_keys=OFF");
      // --- PERFORMANCE-ONLY pragmas (none weaken crash-safety) ---------------------
      // 16 MiB page cache (negative => KiB): keeps hot strand/edge pages resident so
      // reads and the write-side index probes avoid re-faulting from the OS cache.
      this.#db.exec("PRAGMA cache_size=-16384");
      // Temp B-trees / sorters live in RAM, not a spill file — helps index maintenance
      // and any ORDER BY/GROUP BY without touching disk.
      this.#db.exec("PRAGMA temp_store=MEMORY");
      // Memory-map up to 256 MiB of the database file: reads become pointer derefs into
      // the mapped region instead of read() syscalls + buffer copies. Pure read-path
      // acceleration; the WAL write path and its durability are unchanged.
      this.#db.exec("PRAGMA mmap_size=268435456");
      // Wait (up to 5s) on a transient lock instead of immediately throwing SQLITE_BUSY
      // (e.g. a reader vs the WAL checkpointer). Operational robustness, not durability.
      this.#db.exec("PRAGMA busy_timeout=5000");
      // Checkpoint the WAL back into the main file roughly every 1000 pages so the WAL
      // does not grow unbounded under a long write burst. Default behavior, made
      // explicit; does not affect per-commit crash-safety.
      this.#db.exec("PRAGMA wal_autocheckpoint=1000");
    }

    // Schema is idempotent so reopening an existing database is a no-op create.
    this.#db.exec(CREATE_STRANDS);
    this.#db.exec(CREATE_EDGES);
    for (const sql of CREATE_INDEXES) this.#db.exec(sql);

    this.#getStrand = this.#db.prepare("SELECT json FROM strands WHERE id = ?");
    this.#putStrand = this.#db.prepare(
      `INSERT INTO strands (id, json, entity, attribute) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         json = excluded.json,
         entity = excluded.entity,
         attribute = excluded.attribute`,
    );
    this.#getEdge = this.#db.prepare("SELECT json FROM edges WHERE id = ?");
    this.#putEdge = this.#db.prepare(
      `INSERT INTO edges (id, json, from_id, to_id, edge_type) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         json = excluded.json,
         from_id = excluded.from_id,
         to_id = excluded.to_id,
         edge_type = excluded.edge_type`,
    );
    this.#outEdges = this.#db.prepare("SELECT json FROM edges WHERE from_id = ?");
    this.#inEdges = this.#db.prepare("SELECT json FROM edges WHERE to_id = ?");
    this.#byEntity = this.#db.prepare("SELECT json FROM strands WHERE entity = ?");
    this.#byAttribute = this.#db.prepare(
      "SELECT json FROM strands WHERE attribute = ?",
    );
    this.#allStrands = this.#db.prepare("SELECT json FROM strands");
    this.#allEdges = this.#db.prepare("SELECT json FROM edges");
  }

  // -------------------------------------------------------------------------
  // Strands
  // -------------------------------------------------------------------------

  getStrand(id: StrandId): Strand | null {
    const row = this.#getStrand.get(id as string);
    if (row === undefined) return null;
    return parseStrand(asString(row.json));
  }

  putStrand(s: Strand): void {
    this.#runPutStrand(s);
  }

  /**
   * Bind one strand to the reused #putStrand statement (shared by put + batch).
   * `attribute` is nullable; a SQL NULL keeps strandsByAttribute(null) from ever
   * matching (matching the in-memory store, which never indexes null attributes).
   */
  #runPutStrand(s: Strand): void {
    this.#putStrand.run(
      s.id as string,
      JSON.stringify(s),
      s.entity as string,
      s.attribute === null ? null : (s.attribute as string),
    );
  }

  putStrandsBatch(strands: Iterable<Strand>): void {
    this.#batched(() => {
      for (const s of strands) this.#runPutStrand(s);
    });
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  getEdge(id: EdgeId): Edge | null {
    const row = this.#getEdge.get(id as string);
    if (row === undefined) return null;
    return parseEdge(asString(row.json));
  }

  putEdge(e: Edge): void {
    this.#runPutEdge(e);
  }

  /** Bind one edge to the reused #putEdge statement (shared by put + batch + recompute). */
  #runPutEdge(e: Edge): void {
    this.#putEdge.run(
      e.id as string,
      JSON.stringify(e),
      e.from as string,
      e.to as string,
      e.edgeType as EdgeType as string,
    );
  }

  putEdgesBatch(edges: Iterable<Edge>): void {
    this.#batched(() => {
      for (const e of edges) this.#runPutEdge(e);
    });
  }

  /**
   * Run `fn` under ONE transaction (one `BEGIN`/`COMMIT`, one durability barrier) when
   * called standalone, turning N writes into N inserts + 1 commit. NESTABLE: if a
   * transaction is already open (`#txnDepth > 0`) the writes simply enroll in it — no
   * inner `BEGIN`/`COMMIT` (which would either throw a nested-BEGIN or prematurely
   * commit the outer compound op). On throw the standalone case rolls the batch back.
   */
  #batched(fn: () => void): void {
    if (this.#txnDepth > 0) {
      fn();
      return;
    }
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  outEdges(id: StrandId): Edge[] {
    return this.#allEdgeRows(this.#outEdges.all(id as string));
  }

  inEdges(id: StrandId): Edge[] {
    return this.#allEdgeRows(this.#inEdges.all(id as string));
  }

  neighbors(id: StrandId): NeighborView[] {
    const views: NeighborView[] = [];
    for (const row of this.#outEdges.all(id as string)) {
      const edge = parseEdge(asString(row.json));
      const dest = this.getStrand(edge.to);
      // Skip dangling edges (destination not yet stored), matching the in-memory
      // store: the edge stays visible via outEdges() but forms no NeighborView.
      if (dest === null) continue;
      views.push({ edge, strand: dest });
    }
    return views;
  }

  // -------------------------------------------------------------------------
  // Seed indexes
  // -------------------------------------------------------------------------

  strandsByEntity(entity: EntityId): Strand[] {
    return this.#allStrandRows(this.#byEntity.all(entity as string));
  }

  strandsByAttribute(attr: AttributeKey): Strand[] {
    return this.#allStrandRows(this.#byAttribute.all(attr as string));
  }

  // -------------------------------------------------------------------------
  // Full scans (offline maintenance only)
  // -------------------------------------------------------------------------

  allStrands(): Iterable<Strand> {
    return this.#allStrandRows(this.#allStrands.all());
  }

  allEdges(): Iterable<Edge> {
    return this.#allEdgeRows(this.#allEdges.all());
  }

  // -------------------------------------------------------------------------
  // Share-normalization maintenance
  // -------------------------------------------------------------------------

  recomputeOutWeightSum(from: StrandId): void {
    const rows = this.#outEdges.all(from as string);
    if (rows.length === 0) return; // no out-edges => no-op (matches the contract)

    const edges = rows.map((r) => parseEdge(asString(r.json)));
    let sum = 0;
    for (const e of edges) sum += e.w;

    // Rewrite every out-edge row carrying the new denominator, under one transaction
    // (or enrolled in the open outer txn — #batched handles both, no nested BEGIN).
    this.#batched(() => {
      for (const e of edges) {
        // Edge views are frozen; build a fresh object carrying the new denominator.
        this.#runPutEdge({ ...e, out_weight_sum: sum });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Optional unit of work
  // -------------------------------------------------------------------------

  /**
   * Begin a real SQLite transaction (or enroll in the open one). The engine remains
   * correct whether or not a txn is opened; this lets the durable backend group a
   * multi-write compound operation (an adjudication, an approve, a disown sweep, a
   * multi-edge writeFact) into one all-or-nothing commit over the shared handle —
   * inner reputation/audit writes on the same handle ride it automatically.
   *
   * NESTABLE: only the OUTERMOST `beginTxn` issues `BEGIN`; a re-entrant `beginTxn`
   * (depth > 0) returns a NO-OP handle whose `commit`/`rollback` only decrement the
   * depth, so the real COMMIT/ROLLBACK fires once, from the outermost handle. A
   * `rollback()` at depth 0 after an inner ROLLBACK already fired is idempotent.
   */
  beginTxn(): StoreTxn {
    const outermost = this.#txnDepth === 0;
    if (outermost) this.#db.exec("BEGIN");
    this.#txnDepth++;
    let settled = false;
    return {
      commit: (): void => {
        if (settled) return;
        settled = true;
        this.#txnDepth--;
        if (this.#txnDepth === 0) this.#db.exec("COMMIT");
      },
      rollback: (): void => {
        if (settled) return;
        settled = true;
        // A rollback abandons the WHOLE unit of work: a SQLite ROLLBACK unwinds every
        // statement since the outermost BEGIN, so we collapse the depth to 0 and emit
        // exactly one ROLLBACK (guarded against a double-rollback from nested handles).
        if (this.#txnDepth > 0) {
          this.#txnDepth = 0;
          this.#db.exec("ROLLBACK");
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Integrity / corruption detection
  // -------------------------------------------------------------------------

  integrityCheck(): boolean {
    // PRAGMA integrity_check returns one row "ok" for a sound database, or one row per
    // problem otherwise. A torn/truncated file or page/index damage yields non-"ok".
    const rows = this.#db.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (rows.length !== 1) return false;
    const first = rows[0];
    if (first === undefined) return false;
    const val = first["integrity_check"];
    return val === "ok";
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    // Only the OWNER closes. A borrowed shared handle is closed by whoever opened it
    // (the engine wiring), exactly like the ledger drop-ins — closing it here would
    // pull the db out from under the reputation/audit ledgers riding the same handle.
    if (this.#ownsDb) this.#db.close();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Map a set of `{ json }` rows to parsed {@link Strand}s. */
  #allStrandRows(rows: ReadonlyArray<Record<string, unknown>>): Strand[] {
    return rows.map((r) => parseStrand(asString(r.json)));
  }

  /** Map a set of `{ json }` rows to FROZEN {@link Edge} views. */
  #allEdgeRows(rows: ReadonlyArray<Record<string, unknown>>): Edge[] {
    return rows.map((r) => parseEdge(asString(r.json)));
  }
}

/**
 * Factory for the durable backend. Returns a {@link SqliteStrandStore} — a
 * {@link StrandStore} (so it is a DROP-IN for `createMemoryStore()` everywhere the
 * engine takes a store) widened with {@link SqliteStrandStore.close},
 * {@link SqliteStrandStore.beginTxn}, and {@link SqliteStrandStore.integrityCheck}.
 *
 * Pass EITHER:
 *  - a `path` STRING — the factory opens + OWNS a WAL-mode handle at that path; its
 *    `close()` shuts it. `":memory:"` gives an ephemeral, non-persistent database.
 *  - `{ db }` — a shared, already-open `DatabaseSync` handle so FACTS + TRUST + AUDIT
 *    live in ONE crash-consistent file and a compound operation's writes across all
 *    three commit together under one {@link SqliteStrandStore.beginTxn}. `close()` is
 *    then a NO-OP — only the single owner of the shared handle may close it. This is
 *    the bank's atomic-durability default.
 *
 * @example
 *   // Owned handle (the simple durable case):
 *   const store = createSqliteStore("/var/lib/idb/web.db");
 *   const db = createIntelligentDb(store, identity); // unchanged, drop-in
 *
 * @example
 *   // Shared handle (facts + trust + audit, one atomic file):
 *   const handle = new DatabaseSync("/var/lib/idb/web.db");
 *   const store = createSqliteStore({ db: handle });
 *   const rep   = createSqliteReputationLedger(repCapOf, { db: handle });
 *   const audit = createSqlitePendingLedger({ db: handle, reputation: rep });
 *   // a compound op over store + rep + audit commits as ONE txn; handle.close() at end.
 *
 * DURABILITY KNOB: `opts.synchronous` (owner-opened paths only) selects the WAL
 * `PRAGMA synchronous` level. DEFAULT `"NORMAL"` is the documented crash-safe/throughput
 * operating point (a power cut can lose only the last committed txn, never corrupt the
 * file or leave a half-applied compound op). Pass `"FULL"` for zero-loss-on-power-cut at
 * a throughput cost. We never silently weaken durability — omit it to keep NORMAL. The
 * `{ db }` (borrowed-handle) overload ignores it: the single owner of the shared handle
 * sets the connection pragmas.
 */
export function createSqliteStore(
  arg: string | { db: DatabaseSyncType },
  opts?: { synchronous?: "NORMAL" | "FULL" },
): SqliteStrandStore {
  if (typeof arg === "string") {
    return new SqliteStrandStoreImpl({
      db: new DatabaseSync(arg),
      ownsDb: true,
      ...(opts?.synchronous !== undefined ? { synchronous: opts.synchronous } : {}),
    });
  }
  return new SqliteStrandStoreImpl({ db: arg.db, ownsDb: false });
}
