/**
 * ratification/corroboration.ts — THE CORROBORATION-EVENT LEDGER.
 *
 * This module is the SUBSTRATE that was missing from the disown sweep — the
 * residual the `TODO(crack-A)` in `ratification/disown.ts` named and refused to
 * fake. It closes the one credit-reversal the provenance/DERIVATION graph alone
 * could NOT close:
 *
 *   When a source B earned reputation BECAUSE its claim AGREED WITH (was
 *   corroborated by) source A's strand — but B has no DERIVATION edge to A (B
 *   observed independently, then got credited for matching) — the graph holds NO
 *   record linking B's rep-bump to A's strand. So when A is disowned, the
 *   graph-reachable sweep cannot reverse that specific credit, and must NOT GUESS
 *   (guessing would punish coincidental independent agreement, which pillar 4
 *   forbids). The fix is to RECORD the link AT EARNING TIME — which is exactly what
 *   this ledger does.
 *
 * SHAPE (mirrors `pendingLedger.ts`: a swappable interface + an in-memory
 * implementation + a factory). NO StrandStore / crypto I/O — this is pure,
 * append-only, deterministic bookkeeping.
 *
 * Each event records the EXACT applied reputation delta:
 *   { eventId, ratifiedStrandId, corroboratingStrandIds[], beneficiarySourceId,
 *     reputationDelta, at }
 * written at the MOMENT a corroboration-driven reputation gain is applied, so a
 * later disown can look up events whose `corroboratingStrandIds` intersect the
 * tainted (disowned) strand set and reverse EXACTLY `reputationDelta` on
 * `beneficiarySourceId` — bounded, precise, idempotent, and never punishing
 * coincidental independent agreement (a beneficiary with no matching event is
 * untouched).
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (every type-only import uses `import type`). No external deps.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { EpochMs, SourceId, StrandId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Event shape (exactly the substrate spec)
// ---------------------------------------------------------------------------

/**
 * One append-only corroboration event: a record that `beneficiarySourceId` earned
 * `reputationDelta` of reputation BECAUSE `ratifiedStrandId` agreed with the
 * strands in `corroboratingStrandIds`. The `reputationDelta` is the ACTUAL applied
 * score change at earning time (RECORD FIDELITY), so a disown can reverse exactly
 * that much — no more, no less.
 */
export interface CorroborationEvent {
  /** Deterministic id, minted `corrob:<seq>` when omitted on input, else taken as given. */
  readonly eventId: string;
  /** The strand whose ratification/corroboration earned the credit. */
  readonly ratifiedStrandId: StrandId;
  /** The specific strands that corroborated it (the link the graph could not hold). */
  readonly corroboratingStrandIds: readonly StrandId[];
  /** The source whose reputation was raised by this corroboration. */
  readonly beneficiarySourceId: SourceId;
  /**
   * The EXACT reputation credit applied at earning time. Under the BETA(α,β) model
   * (ARCHITECTURE.md §2) this is the independence-weighted α-MASS added to the
   * beneficiary's Beta state (`after.alpha − before.alpha`, i.e. the `w` applied),
   * NOT a readout difference — so a later disown reverses it via
   * `reverseCredit(beneficiary, reputationDelta)` = `α −= w` EXACTLY. (Record
   * fidelity: the value written IS the α-mass that was added, no more, no less.)
   */
  readonly reputationDelta: number;
  /**
   * The MIS corroboration DEPTH (`#R` — the engine's independent-root count over the
   * agreement set) recorded AT THIS EVENT, i.e. the `depth` argument this event's
   * `reputation.ratify` call passed. NOT an increment/delta — the RAW snapshot value
   * `#R` computed at earning time (`ReputationState.corroborationDepth` is stored
   * MONOTONE-MAX over every such snapshot for the beneficiary, per
   * `applyRatification`).
   *
   * WHY this must be recorded (closes the depth-floor-under-reversal defect): `α`
   * (an additive evidence mass, `w` per event, typically <= 1) and
   * `corroborationDepth` (a `Math.max` over independent-root-count SNAPSHOTS, up to
   * `MAX_EXACT_ROOTS`) are NOT commensurable — one ratify call can snapshot a large
   * depth (e.g. 10, because many OTHER independent agreeing strands already existed)
   * while contributing only `w = 1` of fresh α. Subtracting the SAME `w` from both on
   * reversal (the pre-fix behavior) barely moves a well-corroborated source's floor
   * and, in the other direction, can erode an UNRELATED, still-valid event's depth
   * contribution (both re-audit-caught defects). Recording the raw per-event depth
   * lets a disown recompute the beneficiary's TRUE surviving floor as the max over
   * every OTHER, still-unreversed event's recorded depth — see
   * `disown.ts`'s corroboration-reversal step and
   * {@link CorroborationLedger.eventsByBeneficiary}.
   *
   * Defaults to `0` for a legacy/hand-rolled event that never named a depth (a safe
   * default: it never raises the recomputed floor, so an old event is inert for this
   * purpose exactly as it was before this field existed).
   */
  readonly corroborationDepthAtEvent: number;
  /** Witness time the credit was earned. */
  readonly at: EpochMs;
}

/**
 * The input to {@link CorroborationLedger.record}: a {@link CorroborationEvent}
 * whose `eventId` is OPTIONAL. When omitted, the ledger mints a deterministic
 * `corrob:<seq>` id from the append position; when supplied, it is taken verbatim.
 * `corroborationDepthAtEvent` is also OPTIONAL on input (defaults to `0`, see the
 * field doc) so every pre-existing caller that never named a depth keeps compiling
 * and behaving byte-identically.
 */
export type CorroborationEventInput = Omit<
  CorroborationEvent,
  "eventId" | "corroborationDepthAtEvent"
> & {
  readonly eventId?: string;
  readonly corroborationDepthAtEvent?: number;
};

// ---------------------------------------------------------------------------
// The ledger interface (swappable; in-memory implementation below)
// ---------------------------------------------------------------------------

/**
 * The append-only corroboration-event ledger. Deterministic, append-only (no
 * mutation/removal after a record), with an index over corroborating strands so the
 * disown sweep can find — in O(matches) — every event a tainted strand funded.
 *
 * Idempotency of REVERSAL is owned here too (via {@link markReversed}) so a second
 * disown — even of a DIFFERENT source intersecting the same event — reverses each
 * event at most once. The reversal-bookkeeping lives with the events, not in a
 * caller-local set, so it is durable across any number of sweeps.
 */
export interface CorroborationLedger {
  /**
   * Append one corroboration event. Mints `corrob:<seq>` for a missing `eventId`.
   * Append-only: the returned event is pushed and never mutated afterwards.
   *
   * @returns the recorded event (with its final, possibly-minted `eventId`).
   */
  record(event: CorroborationEventInput): CorroborationEvent;

  /** Every recorded event, in append (chain) order. Never mutated after append. */
  all(): readonly CorroborationEvent[];

  /**
   * Every event whose `corroboratingStrandIds` includes `strandId`, in append order.
   * O(matches) via the maintained index.
   */
  eventsByCorroboratingStrand(strandId: StrandId): readonly CorroborationEvent[];

  /**
   * Every event whose `corroboratingStrandIds` INTERSECT the given set, deduped by
   * `eventId` and returned in stable append order. This is the query the disown
   * sweep uses against the tainted (disowned-source seed) strand set.
   */
  eventsIntersecting(strandIds: Iterable<StrandId>): readonly CorroborationEvent[];

  /**
   * Wave-2 [explain-full-ledger-scans]: every event naming `strandId` in EITHER
   * role — as the `ratifiedStrandId` OR within `corroboratingStrandIds` —
   * deduped by `eventId`, in stable append order. `ratifiedStrandId` is a
   * DISTINCT role from `corroboratingStrandIds` (the agreement-set derivation
   * always EXCLUDES the ratified strand itself), so this is a genuinely
   * separate lookup from {@link eventsByCorroboratingStrand} /
   * {@link eventsIntersecting} — not a rename. O(matches) via a maintained
   * ratified-strand index alongside the existing corroborator index; never a
   * full `all()` scan. This is the point-lookup `explain()` uses.
   */
  eventsInvolving(strandId: StrandId): readonly CorroborationEvent[];

  /**
   * Every event whose `beneficiarySourceId` equals `sourceId`, in stable append
   * order — the query a disown's precise credit reversal uses to recompute a
   * beneficiary's TRUE surviving `corroborationDepth` floor (the max
   * `corroborationDepthAtEvent` over every OTHER, still-unreversed event for the
   * SAME beneficiary) once one of its events is reversed. O(matches) via a
   * maintained beneficiary index, never a full `all()` scan.
   */
  eventsByBeneficiary(sourceId: SourceId): readonly CorroborationEvent[];

  /**
   * Mark an event as REVERSED (its credit clawed back). Returns `true` the FIRST
   * time an event is marked, `false` on every subsequent call for the same id —
   * the idempotency guard the disown sweep uses so each event is reversed at most
   * once across any number of sweeps.
   */
  markReversed(eventId: string): boolean;

  /** Whether an event has already been reversed (audit; `markReversed` is the gate). */
  isReversed(eventId: string): boolean;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * Trivial in-memory {@link CorroborationLedger}: an append-only array plus a
 * `Map<StrandId, CorroborationEvent[]>` index maintained on each `record`, and a
 * `Set<string>` of reversed event ids. Mirrors `InMemoryPendingLedger` behind the
 * swappable interface; a durable backend can replace it without touching callers.
 */
class InMemoryCorroborationLedger implements CorroborationLedger {
  /** The append-only chain of events. Never mutated in place after push. */
  private readonly chain: CorroborationEvent[] = [];
  /** corroborating StrandId -> the events it appears in (append order). */
  private readonly byCorroborator = new Map<StrandId, CorroborationEvent[]>();
  /** ratified StrandId -> the events it was ratified in (append order). */
  private readonly byRatified = new Map<StrandId, CorroborationEvent[]>();
  /** beneficiarySourceId -> the events it earned (append order) — the index the
   *  disown sweep's surviving-depth recompute reads (see `eventsByBeneficiary`). */
  private readonly byBeneficiary = new Map<SourceId, CorroborationEvent[]>();
  /** eventId -> its append (chain) position, so a multi-bucket merge can restore
   *  the SAME stable append order the old full-chain scan produced. */
  private readonly posOf = new Map<string, number>();
  /** Event ids already reversed by a disown sweep (idempotency guard). */
  private readonly reversed = new Set<string>();

  record(event: CorroborationEventInput): CorroborationEvent {
    const eventId = event.eventId ?? `corrob:${this.chain.length}`;
    // Freeze the corroborating set into an own array so later caller mutation of the
    // input cannot reach into the ledger (append-only fidelity).
    const finalEvent: CorroborationEvent = {
      eventId,
      ratifiedStrandId: event.ratifiedStrandId,
      corroboratingStrandIds: [...event.corroboratingStrandIds],
      beneficiarySourceId: event.beneficiarySourceId,
      reputationDelta: event.reputationDelta,
      corroborationDepthAtEvent: event.corroborationDepthAtEvent ?? 0,
      at: event.at,
    };
    this.posOf.set(eventId, this.chain.length);
    this.chain.push(finalEvent);

    // Maintain the corroborator index. A strand listed twice in one event indexes
    // that event once (dedupe within the event).
    const seen = new Set<StrandId>();
    for (const sid of finalEvent.corroboratingStrandIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const bucket = this.byCorroborator.get(sid);
      if (bucket === undefined) {
        this.byCorroborator.set(sid, [finalEvent]);
      } else {
        bucket.push(finalEvent);
      }
    }

    // Wave-2 [explain-full-ledger-scans]: maintain the ratified-strand index
    // too (a genuinely separate role from corroborator — see the interface
    // doc on `eventsInvolving`).
    const ratifiedBucket = this.byRatified.get(finalEvent.ratifiedStrandId);
    if (ratifiedBucket === undefined) {
      this.byRatified.set(finalEvent.ratifiedStrandId, [finalEvent]);
    } else {
      ratifiedBucket.push(finalEvent);
    }

    // The beneficiary index (the depth-floor-reversal recompute's lookup).
    const beneficiaryBucket = this.byBeneficiary.get(finalEvent.beneficiarySourceId);
    if (beneficiaryBucket === undefined) {
      this.byBeneficiary.set(finalEvent.beneficiarySourceId, [finalEvent]);
    } else {
      beneficiaryBucket.push(finalEvent);
    }

    return finalEvent;
  }

  all(): readonly CorroborationEvent[] {
    return this.chain;
  }

  eventsByCorroboratingStrand(strandId: StrandId): readonly CorroborationEvent[] {
    return this.byCorroborator.get(strandId) ?? [];
  }

  eventsIntersecting(strandIds: Iterable<StrandId>): readonly CorroborationEvent[] {
    // POINT LOOKUPS via the maintained `byCorroborator` index — O(distinct target ids
    // + matches), never a full walk of `this.chain`. Each per-strand bucket is
    // already in append order (entries are pushed in `record()` order), but merging
    // several buckets (one per requested strand id) can interleave, so the merged
    // candidates are re-sorted by their recorded append position to reproduce the
    // EXACT "first-match, stable append order" the old full-scan produced.
    const seenEvents = new Set<string>();
    const out: CorroborationEvent[] = [];
    for (const sid of new Set(strandIds)) {
      const bucket = this.byCorroborator.get(sid);
      if (bucket === undefined) continue;
      for (const ev of bucket) {
        if (seenEvents.has(ev.eventId)) continue;
        seenEvents.add(ev.eventId);
        out.push(ev);
      }
    }
    out.sort((a, b) => this.posOf.get(a.eventId)! - this.posOf.get(b.eventId)!);
    return out;
  }

  eventsInvolving(strandId: StrandId): readonly CorroborationEvent[] {
    // POINT LOOKUPS via the maintained `byRatified` + `byCorroborator` indexes —
    // O(matches), never a full walk of `this.chain`.
    const seenEvents = new Set<string>();
    const out: CorroborationEvent[] = [];
    for (const bucket of [
      this.byRatified.get(strandId) ?? [],
      this.byCorroborator.get(strandId) ?? [],
    ]) {
      for (const ev of bucket) {
        if (seenEvents.has(ev.eventId)) continue;
        seenEvents.add(ev.eventId);
        out.push(ev);
      }
    }
    out.sort((a, b) => this.posOf.get(a.eventId)! - this.posOf.get(b.eventId)!);
    return out;
  }

  eventsByBeneficiary(sourceId: SourceId): readonly CorroborationEvent[] {
    return this.byBeneficiary.get(sourceId) ?? [];
  }

  markReversed(eventId: string): boolean {
    if (this.reversed.has(eventId)) return false;
    this.reversed.add(eventId);
    return true;
  }

  isReversed(eventId: string): boolean {
    return this.reversed.has(eventId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh, empty {@link CorroborationLedger} (the in-memory
 * implementation). Deterministic and append-only.
 */
export function createCorroborationLedger(): CorroborationLedger {
  return new InMemoryCorroborationLedger();
}

// ---------------------------------------------------------------------------
// Durable, SQLite-backed implementation (DROP-IN behind the SAME interface)
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` (not a static
 * import) — identical rationale to `store/sqliteStore.ts`: the `node:` built-in is
 * newer than the test transformer's hardcoded list, so a static import fails to
 * bundle; the runtime require is opaque to that analysis (ZERO external deps).
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * The {@link CorroborationLedger} a {@link createSqliteCorroborationLedger} returns,
 * widened with {@link close}. Still assignable to {@link CorroborationLedger}, so it
 * is a DROP-IN for the in-memory ledger everywhere.
 */
export interface SqliteCorroborationLedger extends CorroborationLedger {
  /** Close the underlying handle (no-op for a borrowed, shared handle). */
  close(): void;
}

/** Narrow a SQLite output cell that must be a string (a NOT NULL `json` column). */
function corrobAsString(v: unknown): string {
  return v as string;
}

/**
 * Durable, WAL-mode, SQLite-backed {@link CorroborationLedger}. Append-only events
 * live in `corroboration_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id
 * UNIQUE, json)` — the `seq` column preserving the APPEND ORDER that both the minted
 * `corrob:<seq>` id and `eventsIntersecting`'s "stable append order" depend on — and
 * the reversed set in `reversed_events(event_id PRIMARY KEY)`. Every read/write hits
 * disk, so events + the reversed set survive a reopen. Membership filtering
 * (`eventsIntersecting`, `eventsByCorroboratingStrand`) is done in JS over the parsed
 * `corroboratingStrandIds`, mirroring the in-memory ledger's walk for byte-parity.
 */
class SqliteCorroborationLedgerImpl implements SqliteCorroborationLedger {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;

  readonly #insert;
  readonly #insertStrand;
  readonly #insertRatified;
  readonly #insertBeneficiary;
  readonly #count;
  readonly #all;
  readonly #isReversed;
  readonly #markReversed;

  constructor(db: DatabaseSyncType, ownsDb: boolean) {
    this.#db = db;
    this.#ownsDb = ownsDb;

    if (ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS corroboration_events (
         seq      INTEGER PRIMARY KEY AUTOINCREMENT,
         event_id TEXT NOT NULL UNIQUE,
         json     TEXT NOT NULL
       )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS reversed_events (
         event_id TEXT PRIMARY KEY
       )`,
    );
    // INDEXED CHILD TABLE (the perf fix): one row per (corroborating strand, event),
    // so `eventsIntersecting`/`eventsByCorroboratingStrand` become an indexed JOIN
    // instead of a full-table scan + JS-side filter over every event ever recorded.
    // `seq` mirrors the parent event's append position so a multi-strand query can
    // restore the SAME stable append order the old full-scan produced.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS corroboration_event_strands (
         strand_id TEXT NOT NULL,
         event_id  TEXT NOT NULL,
         seq       INTEGER NOT NULL,
         PRIMARY KEY (strand_id, event_id)
       )`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_corroboration_event_strands_strand
         ON corroboration_event_strands (strand_id)`,
    );
    // Wave-2 [explain-full-ledger-scans]: a SEPARATE indexed child table for the
    // `ratifiedStrandId` role — genuinely distinct from `corroboratingStrandIds`
    // (the agreement-set derivation always EXCLUDES the ratified strand itself,
    // so one strand id can never appear in both tables for the SAME event). This
    // is what `eventsInvolving` (the point lookup `explain()` uses) joins against.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS corroboration_events_ratified (
         ratified_strand_id TEXT NOT NULL,
         event_id            TEXT NOT NULL,
         seq                  INTEGER NOT NULL,
         PRIMARY KEY (ratified_strand_id, event_id)
       )`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_corroboration_events_ratified_strand
         ON corroboration_events_ratified (ratified_strand_id)`,
    );
    // The depth-floor-reversal recompute's index: one row per (beneficiary, event),
    // so `eventsByBeneficiary` is an indexed JOIN, never a full scan.
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS corroboration_events_beneficiary (
         beneficiary_source_id TEXT NOT NULL,
         event_id               TEXT NOT NULL,
         seq                    INTEGER NOT NULL,
         PRIMARY KEY (beneficiary_source_id, event_id)
       )`,
    );
    this.#db.exec(
      `CREATE INDEX IF NOT EXISTS idx_corroboration_events_beneficiary_source
         ON corroboration_events_beneficiary (beneficiary_source_id)`,
    );

    this.#insert = this.#db.prepare(
      "INSERT INTO corroboration_events (event_id, json) VALUES (?, ?)",
    );
    this.#insertStrand = this.#db.prepare(
      `INSERT OR IGNORE INTO corroboration_event_strands (strand_id, event_id, seq)
       VALUES (?, ?, ?)`,
    );
    this.#insertRatified = this.#db.prepare(
      `INSERT OR IGNORE INTO corroboration_events_ratified (ratified_strand_id, event_id, seq)
       VALUES (?, ?, ?)`,
    );
    this.#insertBeneficiary = this.#db.prepare(
      `INSERT OR IGNORE INTO corroboration_events_beneficiary (beneficiary_source_id, event_id, seq)
       VALUES (?, ?, ?)`,
    );
    this.#count = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM corroboration_events",
    );
    this.#all = this.#db.prepare(
      "SELECT json FROM corroboration_events ORDER BY seq",
    );
    this.#isReversed = this.#db.prepare(
      "SELECT 1 FROM reversed_events WHERE event_id = ?",
    );
    this.#markReversed = this.#db.prepare(
      "INSERT OR IGNORE INTO reversed_events (event_id) VALUES (?)",
    );

    // BACKFILL for a database written by a pre-index version of this ledger: if a
    // child index table is empty but events already exist, populate it once from
    // the existing rows so a reopened, already-populated ledger is indexed too
    // (never silently missing pre-upgrade events). A ledger that already has ANY
    // rows in a given child table was opened at least once under the code path
    // that maintains it, so `record()` has kept it in sync — skip re-deriving it
    // every open. The two child tables are backfilled INDEPENDENTLY (each gated
    // on its OWN count, not a shared flag): a database that already had
    // `corroboration_event_strands` populated by a pre-Wave-2 build would
    // otherwise never get `corroboration_events_ratified` backfilled at all.
    const strandChildCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM corroboration_event_strands").get() as { n: number }).n,
    );
    const ratifiedChildCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM corroboration_events_ratified").get() as { n: number }).n,
    );
    const beneficiaryChildCount = Number(
      (this.#db.prepare("SELECT COUNT(*) AS n FROM corroboration_events_beneficiary").get() as { n: number }).n,
    );
    if (strandChildCount === 0 || ratifiedChildCount === 0 || beneficiaryChildCount === 0) {
      const existing = this.#db
        .prepare("SELECT seq, event_id, json FROM corroboration_events")
        .all() as Array<{ seq: unknown; event_id: unknown; json: unknown }>;
      for (const row of existing) {
        const parsed = this.#parse(corrobAsString(row.json));
        if (strandChildCount === 0) {
          const seen = new Set<string>();
          for (const sid of parsed.corroboratingStrandIds) {
            const key = String(sid);
            if (seen.has(key)) continue;
            seen.add(key);
            this.#insertStrand.run(key, String(row.event_id), Number(row.seq));
          }
        }
        if (ratifiedChildCount === 0) {
          this.#insertRatified.run(
            String(parsed.ratifiedStrandId),
            String(row.event_id),
            Number(row.seq),
          );
        }
        if (beneficiaryChildCount === 0) {
          this.#insertBeneficiary.run(
            String(parsed.beneficiarySourceId),
            String(row.event_id),
            Number(row.seq),
          );
        }
      }
    }
  }

  /** Parses a persisted row, normalizing a pre-`corroborationDepthAtEvent` legacy
   *  row (written before this field existed) to the safe default `0` — inert for
   *  the depth-floor recompute exactly as it was before the field existed. */
  #parse(json: string): CorroborationEvent {
    const parsed = JSON.parse(json) as CorroborationEvent;
    return typeof parsed.corroborationDepthAtEvent === "number"
      ? parsed
      : { ...parsed, corroborationDepthAtEvent: 0 };
  }

  #chain(): CorroborationEvent[] {
    return this.#all.all().map((r) => this.#parse(corrobAsString(r.json)));
  }

  record(event: CorroborationEventInput): CorroborationEvent {
    // Mint `corrob:<append-position>` from the persisted row count when no id is
    // supplied (continues from the count after a reopen, never colliding).
    const n = Number((this.#count.get() as { n: number }).n);
    const eventId = event.eventId ?? `corrob:${n}`;
    const finalEvent: CorroborationEvent = {
      eventId,
      ratifiedStrandId: event.ratifiedStrandId,
      corroboratingStrandIds: [...event.corroboratingStrandIds],
      beneficiarySourceId: event.beneficiarySourceId,
      reputationDelta: event.reputationDelta,
      corroborationDepthAtEvent: event.corroborationDepthAtEvent ?? 0,
      at: event.at,
    };
    this.#insert.run(eventId, JSON.stringify(finalEvent));
    // Maintain the indexed child table: a strand listed twice in one event indexes
    // that event once (dedupe within the event, mirroring the in-memory impl).
    const seen = new Set<StrandId>();
    for (const sid of finalEvent.corroboratingStrandIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      this.#insertStrand.run(String(sid), eventId, n);
    }
    // The beneficiary index (the depth-floor-reversal recompute's lookup).
    this.#insertBeneficiary.run(String(finalEvent.beneficiarySourceId), eventId, n);
    // Wave-2 [explain-full-ledger-scans]: maintain the separate ratified-strand
    // index too.
    this.#insertRatified.run(String(finalEvent.ratifiedStrandId), eventId, n);
    return finalEvent;
  }

  all(): readonly CorroborationEvent[] {
    return this.#chain();
  }

  eventsByCorroboratingStrand(strandId: StrandId): readonly CorroborationEvent[] {
    return this.#eventsForStrands([strandId]);
  }

  eventsIntersecting(strandIds: Iterable<StrandId>): readonly CorroborationEvent[] {
    return this.#eventsForStrands([...new Set(strandIds)]);
  }

  /**
   * POINT LOOKUP via the indexed `corroboration_event_strands` child table (the perf
   * fix) — an indexed JOIN keyed by `strand_id IN (...)`, never a full scan of
   * `corroboration_events`. Results are deduped by `event_id` and ordered by the
   * recorded append `seq`, reproducing the exact "first-match, stable append order"
   * the old full-chain scan produced.
   */
  #eventsForStrands(ids: readonly StrandId[]): CorroborationEvent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.#db.prepare(
      `SELECT DISTINCT e.json AS json, e.seq AS seq
         FROM corroboration_events e
         JOIN corroboration_event_strands s ON s.event_id = e.event_id
        WHERE s.strand_id IN (${placeholders})
        ORDER BY e.seq`,
    );
    const rows = stmt.all(...ids.map((id) => String(id))) as Array<{
      json: unknown;
      seq: unknown;
    }>;
    return rows.map((r) => this.#parse(corrobAsString(r.json)));
  }

  eventsInvolving(strandId: StrandId): readonly CorroborationEvent[] {
    // POINT LOOKUP: a UNION of two indexed subqueries — one against the
    // ratified-strand child table, one against the corroborator child table —
    // never a full scan of `corroboration_events`. UNION (not UNION ALL)
    // dedupes the (json, seq) pair naturally (seq is unique per event, so this
    // can only collapse the SAME event, never merge two different ones).
    const stmt = this.#db.prepare(
      `SELECT json, seq FROM corroboration_events
        WHERE event_id IN (
          SELECT event_id FROM corroboration_events_ratified WHERE ratified_strand_id = ?
        )
       UNION
       SELECT json, seq FROM corroboration_events
        WHERE event_id IN (
          SELECT event_id FROM corroboration_event_strands WHERE strand_id = ?
        )
       ORDER BY seq`,
    );
    const sid = String(strandId);
    const rows = stmt.all(sid, sid) as Array<{ json: unknown; seq: unknown }>;
    return rows.map((r) => this.#parse(corrobAsString(r.json)));
  }

  eventsByBeneficiary(sourceId: SourceId): readonly CorroborationEvent[] {
    // POINT LOOKUP via the indexed `corroboration_events_beneficiary` child table —
    // never a full scan of `corroboration_events`.
    const stmt = this.#db.prepare(
      `SELECT json, seq FROM corroboration_events
        WHERE event_id IN (
          SELECT event_id FROM corroboration_events_beneficiary WHERE beneficiary_source_id = ?
        )
       ORDER BY seq`,
    );
    const rows = stmt.all(String(sourceId)) as Array<{ json: unknown; seq: unknown }>;
    return rows.map((r) => this.#parse(corrobAsString(r.json)));
  }

  markReversed(eventId: string): boolean {
    if (this.#isReversed.get(eventId) !== undefined) return false;
    this.#markReversed.run(eventId);
    return true;
  }

  isReversed(eventId: string): boolean {
    return this.#isReversed.get(eventId) !== undefined;
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a DURABLE, SQLite-backed {@link CorroborationLedger} — a DROP-IN for
 * {@link createCorroborationLedger} whose events + reversed set survive a restart.
 *
 * Pass EITHER a `path` (own + close its WAL-mode handle) OR a shared, already-open
 * `db` handle (facts + trust + audit in ONE crash-consistent file; `close()` is then
 * a no-op — only the owner may close the shared handle).
 */
export function createSqliteCorroborationLedger(
  opts: { path: string } | { db: DatabaseSyncType },
): SqliteCorroborationLedger {
  if ("path" in opts) {
    return new SqliteCorroborationLedgerImpl(new DatabaseSync(opts.path), true);
  }
  return new SqliteCorroborationLedgerImpl(opts.db, false);
}
