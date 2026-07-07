/**
 * appendSeqO1.test.ts — REGRESSION for `pending-ledger-append-count-star` (re-audit
 * finding #1 / #8, MEDIUM): `SqlitePendingLedgerImpl#append` and
 * `SqliteCorroborationLedgerImpl.record` each ran an unconditional `SELECT COUNT(*)`
 * over their whole table on EVERY append to derive the next `seq`/append-position —
 * an O(n) full-table scan on the hot write path, despite the O(1)
 * `lastInsertRowid`-style alternative shipping in the SAME wave for
 * `adjudicationProvenance.ts`'s sibling ledger. (The daemon's own audit chain,
 * `daemon/auditChainSqlite.ts`, had the byte-identical pattern for its own `seq`
 * — covered by `daemon/__tests__/auditChainSqlite.test.ts`.)
 *
 * FIX: both ledgers already fetch the persisted TAIL row on every append (to derive
 * `prevHash` / continue the append-position numbering) — `seq`/the append-position is
 * now derived from THAT already-fetched row (`tail.seq + 1`, an indexed
 * `ORDER BY seq DESC LIMIT 1` the audit's own empirical probe measured as flat-O(1)
 * regardless of table size) instead of a second, separate `COUNT(*)` pass. This is
 * read FRESH from disk on every call rather than cached in an in-memory counter, so
 * it stays correct even when `#append`/`record()` runs inside a caller's transaction
 * that later rolls back (`approve()`'s and `ratify()`'s compound ops both wrap these
 * ledgers in `withTxn`) — there is no in-memory counter that could go stale relative
 * to what actually committed.
 *
 * This file proves, at a REALISTIC scale (hundreds of appends, not the single
 * happy-path call a narrow test would use), and driving the REAL production
 * `appendPending`/`record` entry points (never a re-derived internal):
 *   1. SPY: zero `COUNT(*)` executions happen once construction is done — the
 *      exact "no per-append COUNT(*)" claim the re-audit asked to be spied on.
 *   2. PARITY: the SQLite backend's resulting chain/event sequence is byte-for-byte
 *      identical (seq/prevHash/thisHash for the pending ledger; eventId/seq-position
 *      for corroboration) to the in-memory reference implementation driven through
 *      the IDENTICAL sequence of calls, and `verifyChain()` still holds.
 *   3. ROLLBACK SAFETY: an append made inside a transaction that is then rolled back
 *      does NOT advance the next real append's seq/position — the exact class of bug
 *      an in-memory-counter-without-resync design would introduce, which deriving
 *      fresh from the persisted tail on every call structurally cannot.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  createCorroborationLedger,
  createSqliteCorroborationLedger,
  createPendingLedger,
  createSqlitePendingLedger,
} from "../index.js";

import type {
  AttributeKey,
  ContradictionSetId,
  EpochMs,
  PendingRatification,
  SourceId,
  StrandId,
} from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync, StatementSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
  StatementSync: new (...args: never[]) => {
    readonly sourceSQL: string;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
  };
};

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;
const SYSTEM = "src:system" as SourceId;

// --- temp db lifecycle -------------------------------------------------------

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-appendo1-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

function track<T extends { close(): void }>(x: T): T {
  closers.push(() => {
    try {
      x.close();
    } catch {
      // already closed by the test
    }
  });
  return x;
}

beforeEach(() => {
  paths = [];
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const base of paths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- COUNT(*) spy --------------------------------------------------------------
//
// Patches `StatementSync.prototype.get`/`.all` directly (the SHARED prototype
// EVERY prepared statement instance — past or future — looks up its methods
// through), filtering by `this.sourceSQL` at call time. This is deliberately NOT
// a `DatabaseSync.prototype.prepare` wrapper: these ledgers `prepare()` their
// `COUNT(*)` statement ONCE in the constructor and reuse the SAME statement
// object via `.get()` on every append, so a `prepare()`-only spy installed AFTER
// construction (which is where it must be installed, to exclude legitimate
// one-time backfill-index COUNT(*) checks some of these ledgers run at
// construction time) would never see the pre-existing statement's later calls at
// all — silently passing even against the unfixed O(n) code. Patching the
// prototype instead catches every `.get()`/`.all()` call through ANY statement
// object, prepared before or after the spy is installed.
function installCountStarSpy(): { count: number; restore: () => void } {
  const proto = StatementSync.prototype as unknown as {
    sourceSQL?: string;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown;
  };
  const origGet = proto.get;
  const origAll = proto.all;
  const spy = { count: 0 };
  proto.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
    if (/count\(\*\)/i.test(this.sourceSQL)) spy.count++;
    return origGet.apply(this, args);
  };
  proto.all = function (this: { sourceSQL: string }, ...args: unknown[]) {
    if (/count\(\*\)/i.test(this.sourceSQL)) spy.count++;
    return origAll.apply(this, args);
  };
  return {
    get count() {
      return spy.count;
    },
    restore: () => {
      proto.get = origGet;
      proto.all = origAll;
    },
  };
}

function pendingOf(csid: string, members: StrandId[]): PendingRatification {
  return {
    contradictionSetId: csid as ContradictionSetId,
    attribute: ATTR,
    members,
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

const N = 300; // realistic scale — NOT the single-call happy path

// ---------------------------------------------------------------------------
// 1. SqlitePendingLedger — O(1) append, no per-append COUNT(*)
// ---------------------------------------------------------------------------

describe("SqlitePendingLedger#append: O(1) seq derivation", () => {
  it(`spy: zero COUNT(*) executions across ${N} appendPending calls`, () => {
    const path = freshPath("pending-spy");
    const led = track(createSqlitePendingLedger({ path }));

    const spy = installCountStarSpy();
    try {
      for (let i = 0; i < N; i++) {
        led.appendPending(pendingOf(`cset:${i}`, [asStrandId(`s:${i}`)]), SYSTEM);
      }
    } finally {
      spy.restore();
    }
    expect(spy.count).toBe(0);
  });

  it(`parity: ${N} appends match the in-memory ledger byte-for-byte and verifyChain() holds`, () => {
    const path = freshPath("pending-parity");
    const sqliteLed = track(createSqlitePendingLedger({ path }));
    const memLed = createPendingLedger();

    for (let i = 0; i < N; i++) {
      const pending = pendingOf(`cset:${i}`, [asStrandId(`s:${i}`), asStrandId(`s:${i}b`)]);
      const a = sqliteLed.appendPending(pending, SYSTEM);
      const b = memLed.appendPending(pending, SYSTEM);
      expect(a).toEqual(b);
    }

    const sqliteRecords = sqliteLed.records();
    const memRecords = memLed.records();
    expect(sqliteRecords.length).toBe(N);
    expect(sqliteRecords).toEqual(memRecords);
    // seq is gapless and matches array position (the invariant verifyChain() checks).
    sqliteRecords.forEach((r, i) => expect(r.seq).toBe(i));
    expect(sqliteLed.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });

  it("rollback safety: an append inside a rolled-back transaction does not advance the next real seq", () => {
    const path = freshPath("pending-rollback");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    closers.push(() => db.close());
    paths.push(path);
    const led = createSqlitePendingLedger({ db });

    // A few genuine, committed appends first.
    led.appendPending(pendingOf("cset:pre-0", [asStrandId("s:pre-0")]), SYSTEM);
    led.appendPending(pendingOf("cset:pre-1", [asStrandId("s:pre-1")]), SYSTEM);
    expect(led.records().length).toBe(2);

    // Now append INSIDE an explicit transaction that we roll back — mirrors a
    // compound op (`approve()`) crashing mid-way and the store's withTxn rolling
    // the whole write back, undoing this ledger's INSERT along with everything
    // else in the same transaction.
    db.exec("BEGIN");
    const inTxn = led.appendPending(
      pendingOf("cset:doomed", [asStrandId("s:doomed")]),
      SYSTEM,
    );
    expect(inTxn.seq).toBe(2); // would have been seq 2 had it committed
    db.exec("ROLLBACK");

    // The rolled-back row is gone from disk...
    expect(led.records().length).toBe(2);

    // ...and — the property that matters — the NEXT real append reuses seq 2
    // rather than skipping to 3 (which an in-memory counter incremented at the
    // doomed append and never reset would have produced).
    const real = led.appendPending(pendingOf("cset:real-2", [asStrandId("s:real-2")]), SYSTEM);
    expect(real.seq).toBe(2);
    expect(led.records().length).toBe(3);
    expect(led.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });
});

// ---------------------------------------------------------------------------
// 2. SqliteCorroborationLedger — O(1) record(), no per-record COUNT(*)
// ---------------------------------------------------------------------------

describe("SqliteCorroborationLedger.record(): O(1) position derivation", () => {
  it(`spy: zero COUNT(*) executions across ${N} record() calls (after construction)`, () => {
    const path = freshPath("corrob-spy");
    const led = track(createSqliteCorroborationLedger({ path }));

    // Construction itself legitimately runs a few one-time backfill COUNT(*)
    // checks (empty-table fast path) — install the spy AFTER construction so only
    // per-record executions are counted, matching the finding's "per-append"
    // scope precisely.
    const spy = installCountStarSpy();
    try {
      for (let i = 0; i < N; i++) {
        led.record({
          ratifiedStrandId: asStrandId(`r:${i}`),
          corroboratingStrandIds: [asStrandId(`c:${i}`)],
          beneficiarySourceId: `src:b${i}` as SourceId,
          reputationDelta: 0.01,
          corroborationDepthAtEvent: 1,
          at: NOW,
        });
      }
    } finally {
      spy.restore();
    }
    expect(spy.count).toBe(0);
  });

  it(`parity: ${N} events mint the SAME corrob:<n> ids and order as the in-memory ledger`, () => {
    const path = freshPath("corrob-parity");
    const sqliteLed = track(createSqliteCorroborationLedger({ path }));
    const memLed = createCorroborationLedger();

    for (let i = 0; i < N; i++) {
      const input = {
        ratifiedStrandId: asStrandId(`r:${i}`),
        corroboratingStrandIds: [asStrandId(`c:${i}`)],
        beneficiarySourceId: `src:b${i}` as SourceId,
        reputationDelta: 0.02,
        corroborationDepthAtEvent: (i % 5) + 1,
        at: NOW,
      };
      const a = sqliteLed.record(input);
      const b = memLed.record(input);
      expect(a).toEqual(b);
    }

    expect(sqliteLed.all().map((e) => e.eventId)).toEqual(
      memLed.all().map((e) => e.eventId),
    );
    expect(sqliteLed.all()[0]!.eventId).toBe("corrob:0");
    expect(sqliteLed.all()[N - 1]!.eventId).toBe(`corrob:${N - 1}`);
  });

  it("rollback safety: a record() inside a rolled-back transaction does not advance the next eventId", () => {
    const path = freshPath("corrob-rollback");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    closers.push(() => db.close());
    paths.push(path);
    const led = createSqliteCorroborationLedger({ db });

    led.record({
      ratifiedStrandId: asStrandId("r:pre-0"),
      corroboratingStrandIds: [asStrandId("c:pre-0")],
      beneficiarySourceId: "src:pre0" as SourceId,
      reputationDelta: 0.01,
      corroborationDepthAtEvent: 1,
      at: NOW,
    });
    expect(led.all().length).toBe(1);

    db.exec("BEGIN");
    const doomed = led.record({
      ratifiedStrandId: asStrandId("r:doomed"),
      corroboratingStrandIds: [asStrandId("c:doomed")],
      beneficiarySourceId: "src:doomed" as SourceId,
      reputationDelta: 0.01,
      corroborationDepthAtEvent: 1,
      at: NOW,
    });
    expect(doomed.eventId).toBe("corrob:1");
    db.exec("ROLLBACK");

    expect(led.all().length).toBe(1);

    const real = led.record({
      ratifiedStrandId: asStrandId("r:real-1"),
      corroboratingStrandIds: [asStrandId("c:real-1")],
      beneficiarySourceId: "src:real1" as SourceId,
      reputationDelta: 0.01,
      corroborationDepthAtEvent: 1,
      at: NOW,
    });
    // Reuses position 1 rather than skipping to 2 — no in-memory counter to
    // desync from what actually committed.
    expect(real.eventId).toBe("corrob:1");
    expect(led.all().length).toBe(2);
  });
});
