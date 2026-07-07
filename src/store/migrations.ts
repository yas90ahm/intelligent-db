/**
 * store/migrations.ts — the `PRAGMA user_version` schema migration ladder
 * (Phase 2 Durability spec §1).
 *
 * WHY: the durable SQLite backend previously created every table with
 * `CREATE TABLE IF NOT EXISTS` and never stamped a schema version (see CLAUDE.md
 * "No schema migration / versioning" under KNOWN LIMITATIONS). That is safe only
 * as long as no shipped schema ever needs a real structural change. This module
 * gives the store an explicit, ordered, one-way ladder:
 *
 *   - `PRAGMA user_version` IS the schema version. The schema shipped before this
 *     module existed is retroactively **v1** (every table/index this codebase has
 *     ever created: strands, edges, reputation, reputation_disowned,
 *     ratification_records, plus their indexes) — a fresh db is stamped v1 at
 *     creation, and an OLD db that predates the ladder (user_version defaults to
 *     SQLite's own `0`) is silently brought up to v1 on first open (its schema is
 *     already v1-shaped by construction; the migration only has to STAMP it).
 *   - `MIGRATIONS` is the ordered ladder. Each entry's `up(db)` runs inside the
 *     SAME transaction as every other pending migration, then the whole batch is
 *     stamped in one go — a crash mid-ladder never leaves a partially-migrated,
 *     unstamped db (retry from the untouched original version next open).
 *   - Opening a db whose `user_version` is NEWER than this code's latest known
 *     version REFUSES to open (old code must never silently write a newer schema
 *     out from under a future migration it doesn't know about).
 *
 * APPENDING v2 (the seam this ladder is deliberately shaped for): a future lane
 * adding `strand_vectors` appends ONE more `{ to: 2, up: (db) => {...} }` entry to
 * `MIGRATIONS` below — nothing here needs to change shape. If `strand_vectors`
 * already exists on disk when v2's `up` runs (e.g. a parallel branch created it
 * ad hoc, before the ladder existed), `up` should create it with
 * `CREATE TABLE IF NOT EXISTS` so landing the ladder never conflicts with data
 * that is already there — it just retroactively canonizes the table as "v2".
 *
 * WIRING: `runMigrations(db)` is called from every SQLite-backed store/ledger
 * constructor in this codebase (`SqliteStrandStore`, the SQLite reputation ledger,
 * the SQLite pending ledger) — see each constructor. Running it more than once
 * against the same handle is a cheap no-op (`user_version` is already at
 * `LATEST_SCHEMA_VERSION`), so it is safe regardless of which subsystem happens to
 * construct first against a shared handle.
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

/**
 * One rung of the migration ladder. `to` is the `user_version` this migration
 * lands the db at (migrations must be listed in strictly ascending `to` order,
 * asserted at module load via {@link MIGRATIONS}'s own construction below).
 * `up` receives the raw db handle already inside an open transaction (see
 * {@link runMigrations}) and must be idempotent-safe to re-run in the sense that
 * every DDL statement it issues should be `IF NOT EXISTS` — the ladder's own
 * version stamp is what prevents a double-run, but a stray extra invocation
 * (e.g. a future bug) should still degrade to a no-op, never an error.
 */
export interface Migration {
  readonly to: number;
  readonly up: (db: DatabaseSyncType) => void;
}

/**
 * v1 — "current schema (as shipped today)", retroactively canonized. Every
 * `CREATE TABLE`/`CREATE INDEX` statement here is copied VERBATIM from the
 * individual store/ledger constructors (`store/sqliteStore.ts`,
 * `identity/reputation.ts`, `ratification/pendingLedger.ts`) so this ladder is
 * the single source of truth for "what a v1 database looks like" even though,
 * for back-compat, those constructors also still create their own tables
 * independently (both paths are `IF NOT EXISTS`, so whichever runs first wins
 * and the other is a no-op — no divergence risk).
 */
function migrateToV1(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strands (
      id        TEXT PRIMARY KEY,
      json      TEXT NOT NULL,
      entity    TEXT NOT NULL,
      attribute TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      id        TEXT PRIMARY KEY,
      json      TEXT NOT NULL,
      from_id   TEXT NOT NULL,
      to_id     TEXT NOT NULL,
      edge_type TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_strands_entity ON strands(entity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_strands_attr   ON strands(attribute)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from      ON edges(from_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to        ON edges(to_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation (
      source_id TEXT PRIMARY KEY,
      json      TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation_disowned (
      source_id TEXT PRIMARY KEY
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ratification_records (
      seq  INTEGER PRIMARY KEY,
      json TEXT NOT NULL
    )
  `);
}

/**
 * v2 — the `strand_vectors` sidecar (Phase-1 retrieval spec §2): one OPTIONAL
 * embedding per DISTINCT `content_hash` (never per strand — echoes share a
 * vector), scoped by `model_id` so a vector minted by one embedding model is
 * never silently compared against another. Pure storage, no belief: this table
 * is read ONLY by the seed-selection seam (`recall/cueResolver.ts`'s
 * `createEmbeddingCueResolver`) and written by `api.ts`'s
 * `writeFactWithEmbeddingAsync` accelerator — see `core/types.ts`'s `EmbedderPort`
 * doc for the non-negotiable "seeding only, never belief" constraint.
 * `CREATE TABLE IF NOT EXISTS` per this module's own "APPENDING v2" guidance,
 * so a handle where `store/vectorSidecar.ts` already created the table ad hoc
 * (this lane landed before the ladder call site did) is a no-op here.
 */
function migrateToV2(db: DatabaseSyncType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strand_vectors (
      content_hash TEXT PRIMARY KEY,
      model_id     TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      vec          BLOB NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_strand_vectors_model ON strand_vectors(model_id)`);
}

/**
 * THE LADDER. Append future migrations here in strictly ascending `to` order —
 * see the module doc's "APPENDING v2" note. Never remove or renumber an existing
 * entry: a fielded db's `user_version` is a durable promise about what schema it
 * is at.
 */
export const MIGRATIONS: readonly Migration[] = [
  { to: 1, up: migrateToV1 },
  { to: 2, up: migrateToV2 },
];

/** The newest schema version this build of the code knows how to open/produce. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.to),
  0,
);

// Fail fast at module load if MIGRATIONS is ever edited into a non-ascending or
// duplicated shape — this is a programming error, not a runtime data condition.
(function assertAscending(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!.to;
    const cur = migrations[i]!.to;
    if (cur <= prev) {
      throw new Error(
        `store/migrations.ts: MIGRATIONS must be strictly ascending by 'to' ` +
          `(found ${prev} followed by ${cur}) — this is a code defect, fix the ladder.`,
      );
    }
  }
})(MIGRATIONS);

/** Read `PRAGMA user_version` off a handle (defaults to 0 for a brand-new file). */
export function readUserVersion(db: DatabaseSyncType): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const raw = row?.["user_version"];
  return typeof raw === "number" ? raw : 0;
}

/**
 * REFUSE-TO-OPEN error: thrown when a database's `user_version` is NEWER than
 * this build's {@link LATEST_SCHEMA_VERSION}. Never let old code silently write a
 * newer schema — the only safe move is to stop and demand newer code.
 */
export class UnknownFutureSchemaError extends Error {
  constructor(
    public readonly foundVersion: number,
    public readonly latestKnownVersion: number,
  ) {
    super(
      `refusing to open: database schema is user_version=${foundVersion}, but this ` +
        `build of the code only knows migrations up to v${latestKnownVersion}. Opening ` +
        `with older code risks writing a schema an newer migration doesn't expect. ` +
        `Upgrade the application before opening this database.`,
    );
    this.name = "UnknownFutureSchemaError";
  }
}

/**
 * Run every pending migration against `db`, inside ONE transaction, then stamp
 * `user_version`. Idempotent: called with a db already at
 * {@link LATEST_SCHEMA_VERSION} (or the requested `latest`), this is a single
 * cheap `PRAGMA user_version` read and nothing else.
 *
 * - `user_version < latest`: every migration with `to > current version`, in
 *   ascending order, runs inside one `BEGIN`/`COMMIT` — a crash mid-ladder rolls
 *   back to the ORIGINAL (unstamped) version, safely retryable next open. The
 *   version is stamped to `latest` only after every pending `up()` returns.
 * - `user_version === latest`: no-op.
 * - `user_version > latest`: throws {@link UnknownFutureSchemaError} — REFUSES to
 *   open (never silently downgrade-write a newer schema).
 *
 * Nestable-transaction note: this function issues its own `BEGIN`/`COMMIT`
 * directly against `db` (it is always called at construction time, before any
 * outer application transaction could be open on that handle), mirroring the
 * store's own top-level pragma setup.
 */
export function runMigrations(
  db: DatabaseSyncType,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const latest = migrations.reduce((max, m) => Math.max(max, m.to), 0);
  const current = readUserVersion(db);

  if (current > latest) {
    throw new UnknownFutureSchemaError(current, latest);
  }
  if (current === latest) {
    return;
  }

  const pending = migrations
    .filter((m) => m.to > current)
    .slice()
    .sort((a, b) => a.to - b.to);

  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      migration.up(db);
    }
    // PRAGMA doesn't accept bound parameters; `latest` is our own trusted
    // integer (never user input), so string interpolation here is safe.
    db.exec(`PRAGMA user_version=${latest}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
