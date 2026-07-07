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
import { runMigrations } from "./migrations.js";
import { snapshotDb } from "./backup.js";
import type { ChainHeadLike, SnapshotManifest } from "./backup.js";

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

  /**
   * `db.snapshot(destPath)` (Phase 2 Durability spec §2): an online, consistent,
   * compact backup copy via `VACUUM INTO` plus a fsynced sidecar manifest
   * (`<destPath>.manifest.json`). See {@link "./backup.js".snapshotDb} for the
   * full contract (this is a thin delegate over the store's own handle) and its
   * module doc for why `VACUUM INTO` is the portable floor rather than a
   * fallback. Pass `chainHead` (the ratification ledger's `chainHead()`, if one
   * is wired) so the manifest can prove consistency with the audit chain later.
   */
  snapshot(
    destPath: string,
    opts?: { readonly chainHead?: ChainHeadLike | null; readonly now?: () => number },
  ): SnapshotManifest;
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
 * REFUSE-TO-OPEN error: thrown by the `{ db }` (borrowed shared-handle) overload of
 * every durable, WAL-verifying constructor (`createSqliteStore`, and — sharing this
 * exported helper per its own doc — `createSqliteReputationLedger` /
 * `createSqlitePendingLedger`) when the handle it was given is not actually in WAL
 * journal mode.
 *
 * WHY THIS EXISTS: the OWNED-path constructor (a plain string path) has always
 * verified `PRAGMA journal_mode=WAL` actually took before trusting the store's crash-
 * safety claims (see the constructor below). The shared-handle recipe this codebase
 * documents as "the bank's atomic-durability default" (facts + trust + audit riding
 * one `DatabaseSync`) used to skip that verification ENTIRELY for a borrowed handle —
 * so following the documented recipe verbatim silently ran the whole compound-write
 * atomicity story over a default ROLLBACK journal, not WAL, with no symptom short of
 * an actual crash losing data. See CLAUDE.md's durability pillar.
 */
export class SharedHandleNotWalError extends Error {
  constructor(
    public readonly caller: string,
    public readonly foundJournalMode: string,
  ) {
    super(
      `${caller}: a shared { db } handle was passed but it is not in WAL journal mode ` +
        `(PRAGMA journal_mode reports "${foundJournalMode}"). The shared-handle overload ` +
        `is a BORROWER: by design it never issues PRAGMA journal_mode=WAL itself (only the ` +
        `code that OWNS the handle — the first thing to open it — should set connection-wide ` +
        `pragmas; a borrower silently re-running it could race another borrower's already-open ` +
        `transaction). It only VERIFIES. Fix: run 'PRAGMA journal_mode=WAL' on the handle (and ` +
        `confirm it reports back "wal") immediately after opening it with 'new DatabaseSync(path)', ` +
        `BEFORE constructing ${caller} (or any other shared-handle store/ledger) against it.`,
    );
    this.name = "SharedHandleNotWalError";
  }
}

/**
 * Verify (never SET) that a BORROWED `db` handle is already in WAL journal mode, or
 * legitimately `:memory:` (non-durable by design, e.g. a test substrate) — throwing
 * {@link SharedHandleNotWalError} otherwise. Every `{ db }`-overload constructor that
 * durably persists to this handle calls this ONCE from its own constructor so the
 * shared-handle recipe's "one atomic crash-consistent file" claim actually holds
 * whichever subsystem happens to construct first against a fresh handle — this
 * function does not care which. Read-only: issues `PRAGMA journal_mode` (a bare read,
 * no `=WAL` request), never writes the pragma — mirroring "the owner of the handle
 * must set it; the borrower verifies."
 *
 * @param db `DatabaseSyncType` the caller only holds by BORROW (`ownsDb === false`).
 * @param caller a short label for the constructing factory, used in the thrown
 *   error's message (e.g. `"createSqliteStore"`).
 */
export function assertSharedHandleWal(db: DatabaseSyncType, caller: string): void {
  const row = db.prepare("PRAGMA journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const mode = String(row?.["journal_mode"] ?? "").toLowerCase();
  if (mode !== "wal" && mode !== "memory") {
    throw new SharedHandleNotWalError(caller, mode);
  }
}

/**
 * SET `journal_mode=WAL` on an OWNED handle (a handle this constructor itself just
 * opened via a bare path — never a borrowed shared handle, see
 * {@link assertSharedHandleWal} for that half) and VERIFY the request actually took,
 * throwing a descriptive error otherwise.
 *
 * WHY A SHARED HELPER (closes `wal-verification-inconsistent-across-constructors`):
 * `createSqliteStore`'s owned-path branch has always done this (request + read back +
 * throw on refusal), but the reputation ledger and pending ledger's owned-path
 * constructors historically each re-implemented (or omitted) the same read-back —
 * `store/vectorSidecar.ts`'s owned-path constructor set the pragma and never verified
 * it took at all. Factoring the ONE check here means every owned-path SQLite
 * constructor in this codebase enforces the identical crash-safety floor with the
 * identical failure message, instead of three near-duplicate (and one entirely
 * missing) copies drifting apart. `:memory:` legitimately reports `"memory"` (no
 * journal to speak of, non-durable by design — the fast test substrate) and is
 * accepted; anything else that isn't `"wal"` is refused (the most common real cause is
 * a network filesystem silently downgrading to a rollback journal).
 *
 * @param db the just-opened, OWNED `DatabaseSyncType` (never a borrowed shared handle).
 * @param caller a short label for the constructing factory, used in the thrown error's
 *   message (e.g. `"createSqliteVectorSidecar"`).
 */
export function assertOwnedWal(db: DatabaseSyncType, caller: string): void {
  const journalRow = db.prepare("PRAGMA journal_mode=WAL").get() as
    | Record<string, unknown>
    | undefined;
  const journalMode = String(journalRow?.["journal_mode"] ?? "").toLowerCase();
  if (journalMode !== "wal" && journalMode !== "memory") {
    throw new Error(
      `${caller}: PRAGMA journal_mode=WAL did not take (database reports ` +
        `"${journalMode}"). WAL is the crash-safety floor and cannot be silently ` +
        `downgraded. The usual cause is a network filesystem (SMB/NFS), where ` +
        `SQLite refuses WAL — move the database to a local disk.`,
    );
  }
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

  /**
   * TRUE from the moment an inner (or outer) `rollback()` collapses the open unit of
   * work until the next OUTERMOST `beginTxn()` clears it. An inner rollback abandons
   * the WHOLE transaction (SQLite ROLLBACK unwinds everything since the outermost
   * BEGIN), so a still-outstanding outer `commit()` MUST NOT report success on work
   * that was already rolled back — it throws loudly instead (see {@link beginTxn}).
   * Without this flag the outer commit silently decremented `#txnDepth` to -1, which
   * POISONED the store: every later `beginTxn()` saw depth !== 0, never issued BEGIN
   * again, and every "atomic" compound op thereafter ran as N autocommitted writes.
   */
  #txnAborted = false;

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
      // data. This is the durability floor and is NOT negotiable — so we VERIFY the
      // pragma actually took instead of trusting it (see assertOwnedWal's doc for why
      // a `:memory:` database legitimately reports "memory" instead, and why a
      // network filesystem is the usual silent-refusal cause). Factored into the
      // shared helper so every owned-path SQLite constructor in this codebase (this
      // store, the vector sidecar, and the reputation/pending ledgers) enforces the
      // identical check instead of near-duplicate copies drifting apart.
      assertOwnedWal(this.#db, "createSqliteStore");
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
    } else {
      // BORROWED shared handle: this constructor must NEVER set connection-wide
      // pragmas on someone else's handle (see assertSharedHandleWal's doc) — it only
      // VERIFIES the owner already put it in WAL mode. Without this, the documented
      // shared-handle recipe (facts + trust + audit riding one DatabaseSync) silently
      // runs over the DEFAULT rollback journal, not WAL, with no symptom short of an
      // actual crash losing committed data.
      assertSharedHandleWal(this.#db, "createSqliteStore");
    }

    // SCHEMA MIGRATION LADDER (Phase 2 Durability spec §1): stamps a fresh db at
    // LATEST_SCHEMA_VERSION and brings an old (pre-ladder, unstamped => user_version 0)
    // db forward inside one transaction before any table below is touched. Runs
    // regardless of ownsDb: a borrowed shared handle may be constructed here BEFORE
    // any other subsystem has touched it, so this store cannot assume someone else
    // already ran it. Idempotent — a second call against an up-to-date handle is one
    // cheap PRAGMA read.
    runMigrations(this.#db);

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
   *
   * LOUD-THROW CONTRACT (commit-after-rollback): an inner `rollback()` abandons the
   * WHOLE unit of work (SQLite ROLLBACK unwinds everything since the outermost
   * BEGIN), so an outer `commit()` issued AFTER an inner rollback THROWS —
   * "commit after inner rollback: this unit of work was already rolled back" —
   * rather than silently reporting success on rolled-back work. A `commit()` with no
   * open transaction at all likewise throws ("commit with no open transaction").
   * The next OUTERMOST `beginTxn()` clears the aborted flag and issues a real BEGIN,
   * so the store is never left in the depth<0 poisoned state where every later
   * "transaction" silently ran as autocommitted writes.
   */
  beginTxn(): StoreTxn {
    // Depth can never go negative under the contract above; if it somehow did, a
    // silent BEGIN-skip would turn every future compound op into N autocommitted
    // writes with zero atomicity — assert loudly rather than limp.
    if (this.#txnDepth < 0) {
      throw new Error(
        `beginTxn: transaction depth is ${this.#txnDepth} (internal invariant broken)`,
      );
    }
    const outermost = this.#txnDepth === 0;
    if (outermost) {
      this.#txnAborted = false; // a fresh outermost unit of work starts clean
      this.#db.exec("BEGIN");
    }
    this.#txnDepth++;
    let settled = false;
    return {
      commit: (): void => {
        if (settled) return;
        settled = true;
        if (this.#txnDepth === 0) {
          // An inner rollback already collapsed this unit of work (or there was
          // never an open transaction). Committing now would report success on
          // work that is NOT in the database — throw loudly instead.
          throw new Error(
            this.#txnAborted
              ? "commit after inner rollback: this unit of work was already rolled back"
              : "commit with no open transaction",
          );
        }
        this.#txnDepth--;
        if (this.#txnDepth === 0) this.#db.exec("COMMIT");
      },
      rollback: (): void => {
        if (settled) return;
        settled = true;
        // A rollback abandons the WHOLE unit of work: a SQLite ROLLBACK unwinds every
        // statement since the outermost BEGIN, so we collapse the depth to 0 and emit
        // exactly one ROLLBACK (guarded against a double-rollback from nested handles).
        // `#txnAborted` marks the collapse so a still-outstanding outer commit()
        // throws instead of "succeeding" on rolled-back work.
        if (this.#txnDepth > 0) {
          this.#txnDepth = 0;
          this.#txnAborted = true;
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
  // Snapshot / backup
  // -------------------------------------------------------------------------

  snapshot(
    destPath: string,
    opts?: { readonly chainHead?: ChainHeadLike | null },
  ): SnapshotManifest {
    return snapshotDb(this.#db, destPath, opts);
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
 *    the bank's atomic-durability default. The CALLER that opened the handle owns
 *    putting it in WAL mode (this overload only VERIFIES — see
 *    {@link assertSharedHandleWal} — and throws {@link SharedHandleNotWalError} if the
 *    handle is not already WAL/`:memory:` when construction runs).
 *
 * @example
 *   // Owned handle (the simple durable case):
 *   const store = createSqliteStore("/var/lib/idb/web.db");
 *   const db = createIntelligentDb(store, identity); // unchanged, drop-in
 *
 * @example
 *   // Shared handle (facts + trust + audit, one atomic file):
 *   const handle = new DatabaseSync("/var/lib/idb/web.db");
 *   handle.exec("PRAGMA journal_mode=WAL"); // the OWNER sets it; every borrower verifies
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
 *
 * NETWORK PATHS ARE REJECTED BY DEFAULT: a path that names a network share
 * (Windows UNC `\\server\share\…` or the `//server/share/…` spelling) is refused
 * unless `opts.allowNetworkPath` is explicitly `true` — see the flag's doc for the
 * corruption risk being guarded.
 */
export function createSqliteStore(
  arg: string | { db: DatabaseSyncType },
  opts?: {
    synchronous?: "NORMAL" | "FULL";
    /**
     * OPT-IN escape hatch for opening the database on a NETWORK PATH (Windows UNC
     * `\\server\share\…` or `//…`). DEFAULT `false`: such paths are REJECTED,
     * because SQLite's locking + WAL shared-memory machinery is well documented to
     * be unreliable over network filesystems (SMB/NFS) — file locks may not be
     * honored across clients and the WAL/SHM files may not be coherently shared, so
     * a second writer (or even a flaky client) can SILENTLY CORRUPT the database
     * file, defeating every durability guarantee this store makes. Setting this
     * flag `true` says "I understand the corruption risk and accept it" (e.g. a
     * strictly single-client share); the journal-mode verification above still runs
     * and will refuse a share where WAL itself did not take.
     */
    allowNetworkPath?: boolean;
  },
): SqliteStrandStore {
  if (typeof arg === "string") {
    // FAIL-CLOSED network-path guard (see the option doc): reject UNC-shaped paths
    // unless the caller explicitly accepted the risk. `\\?\C:\…` extended-length
    // local paths also start with `\\` — spell those as plain `C:\…` instead; the
    // conservative refusal is deliberate (the cost of a false reject is a renamed
    // path; the cost of a false accept is silent database corruption).
    if (
      (arg.startsWith("\\\\") || arg.startsWith("//")) &&
      opts?.allowNetworkPath !== true
    ) {
      throw new Error(
        `createSqliteStore: ${JSON.stringify(arg)} looks like a network (UNC) path. ` +
          `SQLite over a network filesystem risks silent database corruption ` +
          `(unreliable locks + WAL shared memory). Use a local disk path, or pass ` +
          `{ allowNetworkPath: true } to accept the risk explicitly.`,
      );
    }
    // Open the handle FIRST, outside the constructor, so a throw INSIDE construction
    // (e.g. the migration ladder's UnknownFutureSchemaError refusal) can still close
    // the just-opened handle before propagating — otherwise the handle leaks (no
    // reference survives the throw to close it later), which on Windows also blocks
    // deleting/reopening the file (a locked handle) until process exit.
    const handle = new DatabaseSync(arg);
    try {
      return new SqliteStrandStoreImpl({
        db: handle,
        ownsDb: true,
        ...(opts?.synchronous !== undefined ? { synchronous: opts.synchronous } : {}),
      });
    } catch (err) {
      handle.close();
      throw err;
    }
  }
  return new SqliteStrandStoreImpl({ db: arg.db, ownsDb: false });
}
