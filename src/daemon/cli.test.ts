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

import { existsSync, statSync, writeFileSync } from "node:fs";

import { createAgentMemory } from "../agent/agentMemory.js";
import type { AttributeKey } from "../core/types.js";
import { createSqliteDaemonAuditChain } from "./auditChainSqlite.js";
import {
  parseArgs,
  preflightCliPaths,
  verifyChainsAtStartup,
  ChainVerificationFailedError,
  InvalidCliPathError,
} from "./cli.js";

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
// preflightCliPaths — cli-no-path-preflight
// ---------------------------------------------------------------------------

describe("cli: preflightCliPaths (cli-no-path-preflight)", () => {
  it("creates a --db path's missing, nested parent directory rather than leaving it to a bare node:sqlite error", () => {
    const root = freshDir();
    const dbPath = join(root, "deeply", "nested", "not-yet-created", "mem.db");
    const cfg = parseArgs(["--db", dbPath]);
    expect(existsSync(cfg.dataDir)).toBe(false);

    expect(() => preflightCliPaths(cfg)).not.toThrow();

    expect(existsSync(cfg.dataDir)).toBe(true);
    expect(statSync(cfg.dataDir).isDirectory()).toBe(true);
    // The db file itself is NOT created (that's node:sqlite's job at construction
    // time) — only the directory it will live in.
    expect(existsSync(dbPath)).toBe(false);

    // And construction against the now-existing directory succeeds.
    const mem = createAgentMemory({ dbPath });
    mem.close();
  });

  it("throws a typed InvalidCliPathError (never a bare native error) when a plain file blocks the --db directory", () => {
    const root = freshDir();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const dbPath = join(blocker, "nested", "mem.db");
    const cfg = parseArgs(["--db", dbPath]);

    let caught: unknown;
    try {
      preflightCliPaths(cfg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidCliPathError);
    expect((caught as InvalidCliPathError).kind).toBe("db");
    expect((caught as InvalidCliPathError).path).toBe(dbPath);
    expect((caught as InvalidCliPathError).message).toContain(JSON.stringify(dbPath));
  });

  it("also creates a missing --data-dir when it differs from dirname(--db)", () => {
    const root = freshDir();
    const dbPath = join(root, "db-lives-here", "mem.db");
    const dataDir = join(root, "a-totally-different-data-dir");
    const cfg = parseArgs(["--db", dbPath, "--data-dir", dataDir]);
    expect(existsSync(dataDir)).toBe(false);

    preflightCliPaths(cfg);

    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(root, "db-lives-here"))).toBe(true);
  });

  it("is idempotent: calling it twice on an already-valid config does not throw", () => {
    const root = freshDir();
    const dbPath = join(root, "again", "mem.db");
    const cfg = parseArgs(["--db", dbPath]);
    preflightCliPaths(cfg);
    expect(() => preflightCliPaths(cfg)).not.toThrow();
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
