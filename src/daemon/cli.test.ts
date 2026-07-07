/**
 * daemon/cli.test.ts — `parseArgs` (pure argv parsing) and
 * `verifyChainsAtStartup` (`verifychain-never-invoked-by-product` fix):
 * neither checksum chain was ever self-verified by shipped code before this
 * fix — corruption at rest was only ever caught by a human manually
 * scripting a call to `verifyChain()`. These tests drive the REAL exported
 * `verifyChainsAtStartup` against a REAL SQLite-backed daemon audit chain
 * and a REAL fact/ratification chain (via `createAgentMemory({dbPath})`),
 * tampering persisted rows through a raw second connection exactly as
 * `auditChainSqlite.test.ts` does — never a re-derived mock of the chain
 * primitives.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { createAgentMemory } from "../agent/agentMemory.js";
import type { AttributeKey } from "../core/types.js";
import { createSqliteDaemonAuditChain } from "./auditChainSqlite.js";
import { parseArgs, verifyChainsAtStartup, ChainVerificationFailedError } from "./cli.js";

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
      /* best-effort (Windows may briefly lock a just-closed handle) */
    }
  }
  dir = "";
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "iddb-daemon-cli-"));
  return dir;
}

// ---------------------------------------------------------------------------
// parseArgs — pure, previously untested
// ---------------------------------------------------------------------------

describe("cli: parseArgs", () => {
  it("requires --db; throws a usage message when absent", () => {
    expect(() => parseArgs([])).toThrow(/usage: intelligent-db-daemon/);
    expect(() => parseArgs(["--socket", "x"])).toThrow(/usage/);
  });

  it("derives dataDir from dirname(--db) when --data-dir is omitted", () => {
    const cfg = parseArgs(["--db", join("some", "nested", "mem.db")]);
    expect(cfg.dbPath).toBe(join("some", "nested", "mem.db"));
    expect(cfg.dataDir).toBe(join("some", "nested"));
    expect(cfg.auditDbPath).toBe(join(cfg.dataDir, "daemon-audit.db"));
  });

  it("--data-dir and --socket override their respective defaults", () => {
    const cfg = parseArgs(["--db", "mem.db", "--data-dir", "custom-dir", "--socket", "custom-sock"]);
    expect(cfg.dataDir).toBe("custom-dir");
    expect(cfg.endpointBase).toBe("custom-sock");
  });
});

// ---------------------------------------------------------------------------
// verifyChainsAtStartup — the mandatory startup self-verification
// ---------------------------------------------------------------------------

describe("cli: verifyChainsAtStartup (verifychain-never-invoked-by-product)", () => {
  it("does NOT throw when both the daemon audit chain and the fact chain are clean", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "mem.db");
    const auditDbPath = join(dataDir, "daemon-audit.db");

    const mem = createAgentMemory({ dbPath });
    mem.remember({ text: "a clean fact" });
    mem.close();

    const auditChain = createSqliteDaemonAuditChain(auditDbPath);
    auditChain.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });

    expect(() => verifyChainsAtStartup({ auditChain, dbPath })).not.toThrow();
    auditChain.close();
  });

  it("throws ChainVerificationFailedError('daemon_audit', seq) when the DAEMON chain is tampered", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "mem.db");
    const auditDbPath = join(dataDir, "daemon-audit.db");

    const mem = createAgentMemory({ dbPath });
    mem.close();

    const auditChain1 = createSqliteDaemonAuditChain(auditDbPath);
    auditChain1.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    auditChain1.recordAuthFailure({ reason: "MALFORMED" });
    auditChain1.close();

    // Tamper seq 0 via a raw second connection (never through the chain's own API).
    const raw = new DatabaseSync(auditDbPath);
    const row = raw.prepare("SELECT json FROM daemon_audit_records WHERE seq = 0").get() as { json: string };
    const rec = JSON.parse(row.json) as { payload: { sourceId: string } };
    rec.payload.sourceId = "forged-src";
    raw.prepare("UPDATE daemon_audit_records SET json = ? WHERE seq = 0").run(JSON.stringify(rec));
    raw.close();

    const auditChain2 = createSqliteDaemonAuditChain(auditDbPath);
    let caught: unknown;
    try {
      verifyChainsAtStartup({ auditChain: auditChain2, dbPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChainVerificationFailedError);
    expect((caught as ChainVerificationFailedError).chain).toBe("daemon_audit");
    expect((caught as ChainVerificationFailedError).firstBrokenSeq).toBe(0);
    auditChain2.close();
  });

  it("throws ChainVerificationFailedError('fact_ratification', seq) when the FACT chain is tampered", () => {
    const dataDir = freshDir();
    const dbPath = join(dataDir, "mem.db");
    const auditDbPath = join(dataDir, "daemon-audit.db");

    // A REAL ratification record: a genuine multi-class dispute that defers
    // to the pending ledger (mirrors quarantineIngest/disputeHorn's harness).
    const mem = createAgentMemory({ dbPath });
    const ATTR = "cli-verify#wifi_password" as AttributeKey;
    mem.remember({ text: "the wifi password is hunter2", entity: "entity:cli-verify", attribute: ATTR });
    const rival = mem.trust.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "tenant:acme",
    });
    mem.remember({
      text: "the wifi password is pwned123",
      entity: "entity:cli-verify",
      attribute: ATTR,
      source: { sourceId: rival.sourceId },
    });
    const outcome = mem.adjudicate(ATTR);
    expect(outcome.kind).toBe("DEFERRED");
    mem.close();

    // Tamper the persisted PENDING row via a raw second connection.
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT json FROM ratification_records WHERE seq = 0").get() as { json: string };
    const rec = JSON.parse(row.json) as { payload: { attribute: string } };
    rec.payload.attribute = "forged#attribute";
    raw.prepare("UPDATE ratification_records SET json = ? WHERE seq = 0").run(JSON.stringify(rec));
    raw.close();

    const auditChain = createSqliteDaemonAuditChain(auditDbPath);
    let caught: unknown;
    try {
      verifyChainsAtStartup({ auditChain, dbPath });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChainVerificationFailedError);
    expect((caught as ChainVerificationFailedError).chain).toBe("fact_ratification");
    expect((caught as ChainVerificationFailedError).firstBrokenSeq).toBe(0);
    auditChain.close();
  });
});
