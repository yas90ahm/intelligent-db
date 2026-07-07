/**
 * daemon/__tests__/auditChainSqlite.test.ts — the DURABLE (SQLite-backed) daemon
 * audit chain (`../auditChainSqlite.ts`), the fix for the finding that
 * `createDaemonAuditChain()` (in-memory) + `daemon/cli.ts`'s original wiring lost
 * the ENTIRE R8 audit trail on every process exit, including a crash. Proves the
 * property that matters for H4: reopening the SAME file continues the SAME chain
 * (seq/prevHash picked up from disk), `verifyChain()` still recomputes correctly
 * after a reopen, and an at-rest tamper is still caught by name.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { DAEMON_GENESIS_HASH } from "../auditChain.js";
import { createSqliteDaemonAuditChain } from "../auditChainSqlite.js";

const require = createRequire(import.meta.url);
const { DatabaseSync, StatementSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
  StatementSync: new (...args: never[]) => {
    readonly sourceSQL: string;
    get(...args: unknown[]): unknown;
  };
};

let dir = "";
afterEach(() => {
  if (dir !== "") {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows: a deliberately-unclosed handle (the "crash before close()"
      // test below) can hold the file locked briefly — best-effort cleanup
      // only; the OS temp dir gets swept eventually either way.
    }
  }
  dir = "";
});

function freshDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "iddb-daemon-audit-sqlite-"));
  return join(dir, "daemon-audit.db");
}

describe("SqliteDaemonAuditChain: durability across reopen (H4 fix)", () => {
  it("a fresh file starts at the same genesis as the in-memory chain", () => {
    const dbPath = freshDbPath();
    const chain = createSqliteDaemonAuditChain(dbPath);
    expect(chain.chainHead()).toEqual({ seq: -1, headHash: DAEMON_GENESIS_HASH });
    chain.close();
  });

  it("records persist to disk and a REOPENED handle continues the SAME chain", () => {
    const dbPath = freshDbPath();
    const chain1 = createSqliteDaemonAuditChain(dbPath);
    const r0 = chain1.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    const r1 = chain1.recordAuthFailure({ reason: "TIMEOUT" });
    expect(chain1.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    chain1.close();

    // A FRESH process (a fresh DatabaseSync handle over the SAME file) —
    // exactly what happens on a daemon restart or reopen-after-SIGKILL.
    const chain2 = createSqliteDaemonAuditChain(dbPath);
    expect(chain2.records().length).toBe(2);
    expect(chain2.chainHead()).toEqual({ seq: r1.seq, headHash: r1.thisHash });
    expect(chain2.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // The chain CONTINUES (does not restart at genesis) — new records link
    // from the persisted tail.
    const r2 = chain2.recordShutdown({ clean: true });
    expect(r2.seq).toBe(2);
    expect(r2.prevHash).toBe(r1.thisHash);
    expect(chain2.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    chain2.records().forEach((r) => expect(r.seq).toBeGreaterThanOrEqual(0));
    expect(r0.seq).toBe(0);
    chain2.close();
  });

  it("a crash BEFORE close() still leaves committed records readable (WAL) on reopen", () => {
    const dbPath = freshDbPath();
    const chain1 = createSqliteDaemonAuditChain(dbPath);
    chain1.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    chain1.recordAdminVerb({ verb: "revokeToken", actorSourceId: "owner", detail: "fpX" });
    // Deliberately NOT calling chain1.close() — simulates the process being
    // killed before a clean shutdown path runs (H4's actual scenario).

    const chain2 = createSqliteDaemonAuditChain(dbPath);
    expect(chain2.records().length).toBe(2);
    expect(chain2.verifyChain().ok).toBe(true);
    chain2.close();
  });

  it("an at-rest byte-flip is still named at its exact seq after a reopen", () => {
    const dbPath = freshDbPath();
    const chain1 = createSqliteDaemonAuditChain(dbPath);
    chain1.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    chain1.recordAuthFailure({ reason: "MALFORMED" });
    chain1.recordShutdown({ clean: true });
    chain1.close();

    // Directly tamper the persisted row via a raw handle (simulates disk-level
    // corruption / an insider edit — never through the chain's own API).
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT json FROM daemon_audit_records WHERE seq = 1").get() as {
      json: string;
    };
    const rec = JSON.parse(row.json) as { payload: { reason: string } };
    rec.payload.reason = "TIMEOUT"; // was MALFORMED
    raw.prepare("UPDATE daemon_audit_records SET json = ? WHERE seq = 1").run(JSON.stringify(rec));
    raw.close();

    const chain2 = createSqliteDaemonAuditChain(dbPath);
    const result = chain2.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.firstBrokenSeq).toBe(1);
    chain2.close();
  });

  it("perf regression: zero COUNT(*) executions across 300 appends, O(1) seq derivation", () => {
    // RE-AUDIT FIX (finding #11 / observability lane): `#append` used to run an
    // unconditional `SELECT COUNT(*) FROM daemon_audit_records` on EVERY append to
    // derive `seq`, even though it already fetches the persisted tail row one line
    // later to compute `prevHash`. Fixed: `seq` is now derived from that SAME
    // already-fetched tail row (`tail.seq + 1`) instead of a second query. Spy
    // installed at the statement-execution level (not `prepare()`) so it would
    // have caught the OLD code, which prepared its COUNT(*) statement once and
    // reused it via `.get()` on every append.
    const dbPath = freshDbPath();
    const chain = createSqliteDaemonAuditChain(dbPath);

    // Patch `StatementSync.prototype.get` directly (the SHARED prototype every
    // prepared statement instance looks up methods through) rather than wrapping
    // `DatabaseSync.prototype.prepare`: this chain's statements are all prepared
    // ONCE in the constructor (before this spy could ever be installed) and
    // reused thereafter, so a `prepare()`-only spy would never observe their
    // later `.get()` calls at all — silently passing even against the unfixed
    // O(n) code (verified: this exact spy shape, installed after construction,
    // correctly turns red when `#append` is reverted to a cached `COUNT(*)`
    // statement).
    const proto = StatementSync.prototype as unknown as {
      get: (...args: unknown[]) => unknown;
    };
    const origGet = proto.get;
    let countStarCalls = 0;
    proto.get = function (this: { sourceSQL: string }, ...args: unknown[]) {
      if (/count\(\*\)/i.test(this.sourceSQL)) countStarCalls++;
      return origGet.apply(this, args);
    };
    try {
      for (let i = 0; i < 300; i++) {
        chain.recordConnectionAccepted({ fingerprint: `fp${i}`, sourceId: `src${i}` });
      }
    } finally {
      proto.get = origGet;
    }
    expect(countStarCalls).toBe(0);

    const records = chain.records();
    expect(records.length).toBe(300);
    records.forEach((r, i) => expect(r.seq).toBe(i)); // gapless, matches array position
    expect(chain.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    chain.close();
  });

  it("AppendSink-compatible: ships before the local write; a throwing sink aborts (nothing persisted), and does not consume a seq", () => {
    const dbPath = freshDbPath();
    const shipped: string[] = [];
    const chain = createSqliteDaemonAuditChain(dbPath, {
      onAppend: (r) => shipped.push(r.kind),
    });
    chain.recordConnectionAccepted({ fingerprint: "fp", sourceId: "src" });
    expect(shipped).toEqual(["CONNECTION_ACCEPTED"]);
    chain.close();

    const dbPath2 = freshDbPath();
    let armed = true;
    const throwingChain = createSqliteDaemonAuditChain(dbPath2, {
      onAppend: () => {
        if (armed) throw new Error("sink down");
      },
    });
    expect(() => throwingChain.recordAuthFailure({ reason: "TIMEOUT" })).toThrow("sink down");
    expect(throwingChain.records().length).toBe(0);

    // The property that matters (same class of risk an in-memory seq counter
    // without rollback-recovery would get wrong): the ABORTED append must not
    // have consumed seq 0 — deriving `seq` fresh from the persisted tail on
    // every call (never cached) means the next SUCCESSFUL append still lands at
    // seq 0, not seq 1.
    armed = false;
    const real = throwingChain.recordAuthFailure({ reason: "MALFORMED" });
    expect(real.seq).toBe(0);
    expect(real.prevHash).toBe(DAEMON_GENESIS_HASH);
    expect(throwingChain.records().length).toBe(1);
    expect(throwingChain.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    throwingChain.close();
  });
});
