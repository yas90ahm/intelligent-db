/**
 * __torture__/harness.ts — shared engine-wiring for the crash-torture suite
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4).
 *
 * Deliberately mirrors `src/__tests__/atomicCompound.test.ts`'s `wire()` helper: ONE
 * shared `DatabaseSync` handle backs the StrandStore + every ledger (reputation,
 * pending/audit, corroboration, adjudication-provenance, weak-influence), so every
 * compound engine op's writes ride the SAME SQLite transaction (the atomic-compound-
 * writes hardening this suite exists to torture). Used by BOTH the kill-loop's child
 * worker (`killWorker.ts`, performing the randomized ops that get SIGKILLed) and the
 * parent's post-kill reopen + invariant scan (`invariantChecker.ts`), so "the state a
 * torture cycle produced" and "the state the checker inspects" are the exact same
 * wiring shape — no drift between what was tortured and what was checked.
 *
 * IDENTITY REGISTRATION IS DELIBERATELY NOT PERSISTED: `SourceRegistryPort` /
 * `AnchorRegistryPort` are plain in-memory maps (same as the rest of this codebase's
 * test substrate — see CLAUDE.md "Registry claims are configuration, not proof").
 * Across a kill + reopen, a FRESH process re-registers the exact same deterministic
 * roster (see `roster.ts`) before resuming the loop, so identity/anchor state is
 * reconstructed byte-identically every restart with no need to persist it — only
 * REPUTATION (SQLite-backed) and the STRAND/EDGE/LEDGER state need to survive the
 * kill, and those do, by construction.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  createIntelligentDb,
  createSourceIdentityLayer,
  createSqliteStore,
  createSqliteReputationLedger,
  createSqlitePendingLedger,
  createSqliteCorroborationLedger,
  createSqliteAdjudicationProvenanceLedger,
  createSqliteWeakInfluenceLedger,
  independenceBetween,
  repCapFor,
  sourceIdFor,
} from "../index.js";

import type {
  AdjudicationProvenanceLedger,
  AnchorBinding,
  AnchorRegistryPort,
  CorroborationLedger,
  IntelligentDb,
  PendingLedger,
  RatificationDeps,
  ReputationLedger,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRegistryPort,
  SourceRef,
  SqliteStrandStore,
  StakeLedgerPort,
  Unit,
  WeakInfluenceLedger,
} from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** Everything one torture cycle (or the post-kill checker) needs, over one handle. */
export interface Wired {
  readonly db: DatabaseSyncType;
  readonly store: SqliteStrandStore;
  readonly identity: SourceIdentityLayer;
  readonly reputation: ReputationLedger;
  readonly ledger: PendingLedger;
  readonly corroboration: CorroborationLedger;
  readonly adjudicationProvenance: AdjudicationProvenanceLedger;
  readonly weakInfluence: WeakInfluenceLedger;
  readonly ratification: RatificationDeps;
  readonly engine: IntelligentDb;
  readonly anchors: AnchorRegistryPort;
  readonly sources: SourceRegistryPort;
  readonly systemSource: SourceId;
}

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: SourceRef): void {
      known.add(p.sourceId);
    },
    sourceIdOf(s: SourceId): SourceId | null {
      return known.has(s) ? s : null;
    },
    has(s: SourceId): boolean {
      return known.has(s);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(s: SourceId, anchors: readonly AnchorBinding[]): void {
      book.set(s, [...(book.get(s) ?? []), ...anchors]);
    },
    anchorsOf(s: SourceId): readonly AnchorBinding[] {
      return book.get(s) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

/**
 * Open (or create) the db at `dbPath` and wire a FULL engine over it: StrandStore +
 * reputation + pending/audit + corroboration + adjudication-provenance +
 * weak-influence ledgers, all sharing ONE `DatabaseSync` handle (so every compound
 * op's writes enroll in one SQLite transaction). `createSqliteStore` /
 * `createSqlite*Ledger` each run the migration ladder on first touch of the shared
 * handle (idempotent past the first).
 */
export function wireEngine(dbPath: string): Wired {
  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  // WAL is this codebase's actual durability floor (CLAUDE.md: "persistence is
  // SQLite/WAL with atomic compound writes") — REQUIRED here explicitly because the
  // shared-handle `createSqliteStore({ db })` overload deliberately does NOT set
  // connection-wide pragmas itself (only the handle's OWNER may; see
  // `store/sqliteStore.ts`'s constructor comment), and this harness IS that owner.
  // Skipping this would silently torture the DEFAULT rollback-journal mode instead
  // of the WAL configuration the spec's torn-write/WAL-archive scenarios name.
  db.exec("PRAGMA journal_mode=WAL");

  const sources = makeSourceRegistry();
  const anchors = makeAnchorRegistry();
  const repCapOf = (s: SourceId): Unit => repCapFor([...anchors.anchorsOf(s)]);
  const reputation = createSqliteReputationLedger(repCapOf, { db });

  const reputationPort: ReputationLedgerPort = {
    scoreOf: (s: SourceId): Unit => reputation.scoreOf(s),
  };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };

  const identity = createSourceIdentityLayer({
    sources,
    anchors,
    reputation: reputationPort,
    stake: stakePort,
  });

  const store = createSqliteStore({ db });
  const systemSource = sourceIdFor("torture", "system");
  const ledger = createSqlitePendingLedger({ db, reputation });
  const corroboration = createSqliteCorroborationLedger({ db });
  const adjudicationProvenance = createSqliteAdjudicationProvenanceLedger({ db });
  const weakInfluence = createSqliteWeakInfluenceLedger({ db });

  const ratification: RatificationDeps = {
    ledger,
    systemSource,
    corroboration,
    adjudicationProvenance,
    weakInfluence,
  };

  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  return {
    db,
    store,
    identity,
    reputation,
    ledger,
    corroboration,
    adjudicationProvenance,
    weakInfluence,
    ratification,
    engine,
    anchors,
    sources,
    systemSource,
  };
}

/** Best-effort close: an unclean process kill never reaches this, which is the point. */
export function closeWired(w: Wired): void {
  try {
    w.db.close();
  } catch {
    // already closed / handle invalid — fine, this is best-effort cleanup only.
  }
}
