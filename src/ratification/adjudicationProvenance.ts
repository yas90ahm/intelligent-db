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
    const targets = new Set<StrandId>(strandIds);
    // contradictionSetId -> the LAST (most recent) intersecting record.
    const latest = new Map<ContradictionSetId, AdjudicationProvenance>();
    const order: ContradictionSetId[] = [];
    for (const rec of this.chain) {
      let hit = false;
      for (const sid of rec.contributingStrandIds) {
        if (targets.has(sid)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      if (!latest.has(rec.contradictionSetId)) order.push(rec.contradictionSetId);
      latest.set(rec.contradictionSetId, rec);
    }
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

    this.#insert = this.#db.prepare(
      "INSERT INTO adjudication_provenance (json) VALUES (?)",
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
    this.#insert.run(JSON.stringify(finalRecord));
    return finalRecord;
  }

  all(): readonly AdjudicationProvenance[] {
    return this.#chain();
  }

  recordsContributedBy(
    strandIds: Iterable<StrandId>,
  ): readonly AdjudicationProvenance[] {
    const targets = new Set<StrandId>(strandIds);
    const latest = new Map<ContradictionSetId, AdjudicationProvenance>();
    const order: ContradictionSetId[] = [];
    for (const rec of this.#chain()) {
      let hit = false;
      for (const sid of rec.contributingStrandIds) {
        if (targets.has(sid)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
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
