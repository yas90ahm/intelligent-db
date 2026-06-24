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

  constructor(opts: { db: DatabaseSyncType; ownsDb: boolean }) {
    this.#db = opts.db;
    this.#ownsDb = opts.ownsDb;

    // DURABILITY: WAL mode + NORMAL sync — committed data survives a crash, and the
    // WAL gives good write throughput. Each put below is its own autocommitted write.
    // Only the OWNER of the handle sets the connection-wide pragmas (a borrowed shared
    // handle already had them set by its owner — re-running them is harmless but the
    // owner is the authoritative place, mirroring the ledger drop-ins).
    if (opts.ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
      // FK off (we manage adjacency ourselves; the contract permits dangling edges).
      this.#db.exec("PRAGMA foreign_keys=OFF");
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
    // `attribute` is nullable; a SQL NULL keeps strandsByAttribute(null) from ever
    // matching (matching the in-memory store, which never indexes null attributes).
    this.#putStrand.run(
      s.id as string,
      JSON.stringify(s),
      s.entity as string,
      s.attribute === null ? null : (s.attribute as string),
    );
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
    this.#putEdge.run(
      e.id as string,
      JSON.stringify(e),
      e.from as string,
      e.to as string,
      e.edgeType as EdgeType as string,
    );
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

    const writeAll = (): void => {
      for (const e of edges) {
        // Edge views are frozen; build a fresh object carrying the new denominator.
        const updated: Edge = { ...e, out_weight_sum: sum };
        this.#putEdge.run(
          updated.id as string,
          JSON.stringify(updated),
          updated.from as string,
          updated.to as string,
          updated.edgeType as EdgeType as string,
        );
      }
    };

    // When already inside an outer unit of work, just write — the rows enroll in the
    // open transaction; emitting our own BEGIN here would be a forbidden nested BEGIN,
    // and emitting our own COMMIT would prematurely commit the outer compound op.
    if (this.#txnDepth > 0) {
      writeAll();
      return;
    }

    // Standalone call: rewrite each out-edge row under its own atomic transaction.
    this.#db.exec("BEGIN");
    try {
      writeAll();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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
 */
export function createSqliteStore(
  arg: string | { db: DatabaseSyncType },
): SqliteStrandStore {
  if (typeof arg === "string") {
    return new SqliteStrandStoreImpl({ db: new DatabaseSync(arg), ownsDb: true });
  }
  return new SqliteStrandStoreImpl({ db: arg.db, ownsDb: false });
}
