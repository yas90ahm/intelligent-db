/**
 * ratification/adjudicationProvenance.ts — THE ADJUDICATION-PROVENANCE LEDGER.
 *
 * Closes the THRESHOLD-EFFECTS channel of the undo-engine hardening (ARCHITECTURE.md
 * §4(c)). When an adjudication RESOLVES a dispute (single-class, or decisive
 * multi-class) it does so on a MARGIN — the LCB gap that cleared the decisive
 * threshold. A tainted strand that merely TIPPED that margin would, under the bare
 * disown sweep, be invisible: the loser stays demoted even though the input that beat
 * it was fraudulent. This ledger records, at resolution time, an
 * {@link AdjudicationProvenance} `{ contradictionSetId, winner, margin,
 * contributingStrandIds, at }`, so on disown the sweep can recompute the winner's
 * effective margin with the tainted contributing strands removed and — if it drops
 * below the decisive threshold — RE-OPEN the dispute (transition it back to a PENDING
 * ratification so a human re-decides). The previously-demoted losers are NOT
 * auto-promoted.
 *
 * SHAPE: mirrors `corroboration.ts` / `weakInfluence.ts` — a swappable interface + an
 * in-memory implementation + a SQLite drop-in + a factory. Pure, append-only,
 * deterministic. The RE-OPEN idempotency guard ({@link markReopened}) lives WITH the
 * ledger so a re-sweep re-opens each dispute at most once.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`.
 * No external runtime deps.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  AdjudicationProvenance,
  ContradictionSetId,
  StrandId,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** The input to {@link AdjudicationProvenanceLedger.record}: exactly an {@link AdjudicationProvenance}. */
export type AdjudicationProvenanceInput = AdjudicationProvenance;

// ---------------------------------------------------------------------------
// The ledger interface (swappable; in-memory implementation below)
// ---------------------------------------------------------------------------

/**
 * The append-only adjudication-provenance ledger. Deterministic, append-only, with an
 * index over each record's `contributingStrandIds` so the disown sweep can find — in
 * O(matches) — every resolved adjudication a tainted strand contributed a margin to.
 *
 * The RE-OPEN idempotency guard ({@link markReopened}) is owned here so a re-sweep
 * re-opens each dispute at most once, durable across any number of sweeps.
 */
export interface AdjudicationProvenanceLedger {
  /** Record one adjudication-provenance entry. Append-only: never mutated afterwards. */
  record(record: AdjudicationProvenanceInput): AdjudicationProvenance;

  /** Every recorded entry, in append order. Never mutated after append. */
  all(): readonly AdjudicationProvenance[];

  /**
   * Every adjudication record whose `contributingStrandIds` INTERSECT the given set,
   * deduped by `contradictionSetId` (keeping the most recent), in stable append order
   * — the query the disown sweep runs against the tainted strand set to find disputes
   * whose margins may have collapsed.
   */
  recordsContributedBy(
    strandIds: Iterable<StrandId>,
  ): readonly AdjudicationProvenance[];

  /**
   * Mark a contradiction set as RE-OPENED by a disown. Returns `true` the FIRST time,
   * `false` afterwards — the idempotency gate so a re-sweep re-opens nothing more.
   */
  markReopened(contradictionSetId: ContradictionSetId): boolean;

  /** Whether a contradiction set has already been re-opened by a disown. */
  isReopened(contradictionSetId: ContradictionSetId): boolean;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Trivial in-memory {@link AdjudicationProvenanceLedger}: an append-only array plus a
 * `Map<StrandId, AdjudicationProvenance[]>` index by contributing strand, and a
 * `Set<ContradictionSetId>` of already-reopened disputes. Mirrors the sibling ledgers.
 */
class InMemoryAdjudicationProvenanceLedger
  implements AdjudicationProvenanceLedger
{
  private readonly chain: AdjudicationProvenance[] = [];
  private readonly byContributor = new Map<StrandId, AdjudicationProvenance[]>();
  /** record identity -> its append (chain) position, so `recordsContributedBy`'s
   *  index-driven merge can reconstruct "most recent per csid, first-hit order"
   *  without re-walking the full chain. */
  private readonly posOf = new Map<AdjudicationProvenance, number>();
  private readonly reopened = new Set<ContradictionSetId>();

  record(record: AdjudicationProvenanceInput): AdjudicationProvenance {
    const finalRecord: AdjudicationProvenance = {
      contradictionSetId: record.contradictionSetId,
      attribute: record.attribute,
      winner: record.winner,
      margin: record.margin,
      contributingStrandIds: [...record.contributingStrandIds],
      at: record.at,
    };
    this.posOf.set(finalRecord, this.chain.length);
    this.chain.push(finalRecord);
    const seen = new Set<StrandId>();
    for (const sid of finalRecord.contributingStrandIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const bucket = this.byContributor.get(sid);
      if (bucket === undefined) {
        this.byContributor.set(sid, [finalRecord]);
      } else {
        bucket.push(finalRecord);
      }
    }
    return finalRecord;
  }

  all(): readonly AdjudicationProvenance[] {
    return this.chain;
  }

  recordsContributedBy(
    strandIds: Iterable<StrandId>,
  ): readonly AdjudicationProvenance[] {
    // POINT LOOKUPS via the maintained `byContributor` index — O(distinct target ids
    // + matches), never a full walk of `this.chain`. Each per-strand bucket is
    // already in append order; merging several buckets (one per requested strand
    // id) is resolved against the recorded append position so the result reproduces
    // the SAME "most recent record per contradictionSetId, ordered by first hit"
    // semantics the old full-scan produced.
    const latest = new Map<ContradictionSetId, AdjudicationProvenance>();
    const firstPos = new Map<ContradictionSetId, number>();
    for (const sid of new Set(strandIds)) {
      const bucket = this.byContributor.get(sid);
      if (bucket === undefined) continue;
      for (const rec of bucket) {
        const pos = this.posOf.get(rec)!;
        const csid = rec.contradictionSetId;
        const curFirst = firstPos.get(csid);
        if (curFirst === undefined || pos < curFirst) firstPos.set(csid, pos);
        const curLatest = latest.get(csid);
        if (curLatest === undefined || this.posOf.get(curLatest)! < pos) {
          latest.set(csid, rec);
        }
      }
    }
    const order = [...firstPos.entries()].sort((a, b) => a[1] - b[1]).map(([csid]) => csid);
    return order.map((csid) => latest.get(csid)!);
  }

  markReopened(contradictionSetId: ContradictionSetId): boolean {
    if (this.reopened.has(contradictionSetId)) return false;
    this.reopened.add(contradictionSetId);
    return true;
  }

  isReopened(contradictionSetId: ContradictionSetId): boolean {
    return this.reopened.has(contradictionSetId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh, empty {@link AdjudicationProvenanceLedger} (in-memory).
 */
export function createAdjudicationProvenanceLedger(): AdjudicationProvenanceLedger {
  return new InMemoryAdjudicationProvenanceLedger();
}

// ---------------------------------------------------------------------------
// Durable, SQLite-backed implementation (DROP-IN behind the SAME interface)
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` — identical
 * rationale to the sibling ledgers (the `node:` built-in is newer than the test
 * transformer's list, so a static import fails to bundle).
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** The ledger the SQLite factory returns, widened with {@link close}. */
export interface SqliteAdjudicationProvenanceLedger
  extends AdjudicationProvenanceLedger {
  /** Close the underlying handle (no-op for a borrowed, shared handle). */
  close(): void;
}

/** Narrow a SQLite output cell that must be a string (a NOT NULL `json` column). */
function adjAsString(v: unknown): string {
  return v as string;
}

/**
 * Durable, WAL-mode, SQLite-backed {@link AdjudicationProvenanceLedger}. Append-only
 * records live in `adjudication_provenance(seq INTEGER PRIMARY KEY AUTOINCREMENT,
 * json)` preserving append order, and the reopened set in
 * `adjudication_reopened(contradiction_set_id PRIMARY KEY)`. Intersection filtering is
 * done in JS over the parsed records, mirroring the in-memory ledger.
 */
class SqliteAdjudicationProvenanceLedgerImpl
  implements SqliteAdjudicationProvenanceLedger
{
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;

  readonly #insert;
  readonly #insertStrand;
  readonly #all;
  readonly #isReopened;
  readonly #markReopened;

  constructor(db: DatabaseSyncType, ownsDb: boolean) {
    this.#db = db;
    this.#ownsDb = ownsDb;

    if (ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS adjudication_provenance (
         seq  INTEGER PRIMARY KEY AUTOINCREMENT,
         json TEXT NOT NULL
       )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS adjudication_reopened (
         contradiction_set_id TEXT PRIMARY KEY
       )`,
    );
    // INDEXED CHILD TABLE (the perf fix): one row per (contributing strand, record
    // seq), so `recordsContributedBy` becomes an indexed JOIN over the requested
    // strand ids instead of a full-table scan + JS-side filter over every
    // adjudication ever recorded.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS adjudication_provenance_strands (
         strand_id TEXT NOT NULL,
         seq       INTEGER NOT NULL,
         PRIMARY KEY (strand_id, seq)
       )`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_adjudication_provenance_strands_strand
         ON adjudication_provenance_strands (strand_id)`,
    );

    this.#insert = this.#db.prepare(
      "INSERT INTO adjudication_provenance (json) VALUES (?)",
    );
    this.#insertStrand = this.#db.prepare(
      `INSERT OR IGNORE INTO adjudication_provenance_strands (strand_id, seq)
       VALUES (?, ?)`,
    );
    this.#all = this.#db.prepare(
      "SELECT json FROM adjudication_provenance ORDER BY seq",
    );
    this.#isReopened = this.#db.prepare(
      "SELECT 1 FROM adjudication_reopened WHERE contradiction_set_id = ?",
    );
    this.#markReopened = this.#db.prepare(
      "INSERT OR IGNORE INTO adjudication_reopened (contradiction_set_id) VALUES (?)",
    );

    // BACKFILL for a database written by a pre-index version of this ledger: if the
    // child index table is empty but records already exist, populate it once from
    // the existing rows so a reopened, already-populated ledger is indexed too
    // (never silently missing pre-upgrade records from `recordsContributedBy`). A
    // ledger that already has ANY child rows was opened at least once under this
    // code path already, so `record()` has kept it in sync — skip re-deriving it
    // every open.
    const childCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM adjudication_provenance_strands").get() as { n: number }).n,
    );
    if (childCount === 0) {
      const existing = this.#db
        .prepare("SELECT seq, json FROM adjudication_provenance")
        .all() as Array<{ seq: unknown; json: unknown }>;
      for (const row of existing) {
        const parsed = this.#parse(adjAsString(row.json));
        const seen = new Set<string>();
        for (const sid of parsed.contributingStrandIds) {
          const key = String(sid);
          if (seen.has(key)) continue;
          seen.add(key);
          this.#insertStrand.run(key, Number(row.seq));
        }
      }
    }
  }

  #parse(json: string): AdjudicationProvenance {
    return JSON.parse(json) as AdjudicationProvenance;
  }

  #chain(): AdjudicationProvenance[] {
    return this.#all.all().map((r) => this.#parse(adjAsString(r.json)));
  }

  record(record: AdjudicationProvenanceInput): AdjudicationProvenance {
    const finalRecord: AdjudicationProvenance = {
      contradictionSetId: record.contradictionSetId,
      attribute: record.attribute,
      winner: record.winner,
      margin: record.margin,
      contributingStrandIds: [...record.contributingStrandIds],
      at: record.at,
    };
    const info = this.#insert.run(JSON.stringify(finalRecord));
    const seq = Number(info.lastInsertRowid);
    const seen = new Set<StrandId>();
    for (const sid of finalRecord.contributingStrandIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      this.#insertStrand.run(String(sid), seq);
    }
    return finalRecord;
  }

  all(): readonly AdjudicationProvenance[] {
    return this.#chain();
  }

  recordsContributedBy(
    strandIds: Iterable<StrandId>,
  ): readonly AdjudicationProvenance[] {
    // POINT LOOKUP via the indexed `adjudication_provenance_strands` child table —
    // an indexed JOIN keyed by `strand_id IN (...)`, never a full scan of
    // `adjudication_provenance`. Rows come back ordered by `seq` (append order), so
    // reducing to "most recent record per contradictionSetId, first-hit order" over
    // this bounded candidate set reproduces the old full-scan semantics exactly.
    const ids = [...new Set(strandIds)];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.#db.prepare(
      `SELECT DISTINCT e.json AS json, e.seq AS seq
         FROM adjudication_provenance e
         JOIN adjudication_provenance_strands s ON s.seq = e.seq
        WHERE s.strand_id IN (${placeholders})
        ORDER BY e.seq`,
    );
    const rows = stmt.all(...ids.map((id) => String(id))) as Array<{
      json: unknown;
      seq: unknown;
    }>;
    const candidates = rows.map((r) => this.#parse(adjAsString(r.json)));
    const latest = new Map<ContradictionSetId, AdjudicationProvenance>();
    const order: ContradictionSetId[] = [];
    for (const rec of candidates) {
      if (!latest.has(rec.contradictionSetId)) order.push(rec.contradictionSetId);
      latest.set(rec.contradictionSetId, rec);
    }
    return order.map((csid) => latest.get(csid)!);
  }

  markReopened(contradictionSetId: ContradictionSetId): boolean {
    if (this.#isReopened.get(contradictionSetId as string) !== undefined) return false;
    this.#markReopened.run(contradictionSetId as string);
    return true;
  }

  isReopened(contradictionSetId: ContradictionSetId): boolean {
    return this.#isReopened.get(contradictionSetId as string) !== undefined;
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a DURABLE, SQLite-backed {@link AdjudicationProvenanceLedger} — a DROP-IN
 * for {@link createAdjudicationProvenanceLedger} whose records + reopened set survive
 * a restart.
 *
 * Pass EITHER a `path` (own + close its WAL-mode handle) OR a shared, already-open
 * `db` handle (`close()` is then a no-op — only the owner may close).
 */
export function createSqliteAdjudicationProvenanceLedger(
  opts: { path: string } | { db: DatabaseSyncType },
): SqliteAdjudicationProvenanceLedger {
  if ("path" in opts) {
    return new SqliteAdjudicationProvenanceLedgerImpl(
      new DatabaseSync(opts.path),
      true,
    );
  }
  return new SqliteAdjudicationProvenanceLedgerImpl(opts.db, false);
}

export type { AdjudicationProvenance };
