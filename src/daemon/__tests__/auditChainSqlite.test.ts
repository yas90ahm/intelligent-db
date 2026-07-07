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
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
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

  it("AppendSink-compatible: ships before the local write; a throwing sink aborts (nothing persisted)", () => {
    const dbPath = freshDbPath();
    const shipped: string[] = [];
    const chain = createSqliteDaemonAuditChain(dbPath, {
      onAppend: (r) => shipped.push(r.kind),
    });
    chain.recordConnectionAccepted({ fingerprint: "fp", sourceId: "src" });
    expect(shipped).toEqual(["CONNECTION_ACCEPTED"]);
    chain.close();

    const dbPath2 = freshDbPath();
    const throwingChain = createSqliteDaemonAuditChain(dbPath2, {
      onAppend: () => {
        throw new Error("sink down");
      },
    });
    expect(() => throwingChain.recordAuthFailure({ reason: "TIMEOUT" })).toThrow("sink down");
    expect(throwingChain.records().length).toBe(0);
    throwingChain.close();
  });
});
