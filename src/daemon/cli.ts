#!/usr/bin/env node
/**
 * daemon/cli.ts — THE DAEMON CLI ENTRYPOINT (PHASE3_DAEMON_SPEC.md R6, deliverable 3).
 *
 *   intelligent-db-daemon --db <path> [--socket <path>] [--data-dir <path>]
 *
 * R6: manual, explicit lifecycle — no auto-start, no OS service integration here
 * (OPERATIONS.md documents systemd/Windows-service wrappers as deployment
 * recipes). SIGINT/SIGTERM trigger graceful shutdown: stop accepting, drain the
 * FIFO queue, close connections, close the store, write the SHUTDOWN_MARKER audit
 * record — all via {@link DaemonServer.stop}.
 *
 * R7: daemon mode is reached ONLY by running this binary; nothing here changes
 * `createAgentMemory`'s in-process default.
 *
 * ZERO new runtime deps: `node:path` only, beyond what `daemon/*` already uses.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

import { dirname, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";

import { createAgentMemory } from "../agent/agentMemory.js";
import { createSqlitePendingLedger } from "../ratification/pendingLedger.js";
import type { ChainHead as FactChainHead, ChainVerification as FactChainVerification } from "../ratification/pendingLedger.js";
import { createSqliteDaemonAuditChain } from "./auditChainSqlite.js";
import type { DaemonAuditChain } from "./auditChain.js";
import { createTokenStore, ownerTokenFilePath } from "./tokens.js";
import { DaemonServer } from "./server.js";
import { daemonLog } from "./log.js";

// ---------------------------------------------------------------------------
// daemon-auditchain-write-crashes-process fix: LAST-RESORT process-wide
// backstop. Every known internal throw site (audit-chain writes, the FIFO
// queue's drain loop) is now caught at its own call site (see server.ts) and
// turned into a typed per-connection response or a logged no-op — these
// handlers exist for whatever still slips past that (a future regression, a
// third-party/runtime throw). Before this fix, ZERO such handlers existed
// anywhere in src/, so ANY unguarded throw/rejection took the whole
// multi-client daemon down with it. Logged and SURVIVED, never a bare crash —
// registered at module scope (not inside `main()`) so it is active for the
// entire process lifetime, including during startup.
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err: unknown) => {
  daemonLog({
    event: "uncaught_exception",
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  daemonLog({
    event: "unhandled_rejection",
    message: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});

// ---------------------------------------------------------------------------
// Argument parsing (minimal, dependency-free)
// ---------------------------------------------------------------------------

function argVal(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

const USAGE =
  "usage: intelligent-db-daemon --db <path> [--socket <path>] [--data-dir <path>]\n";

export interface CliConfig {
  readonly dbPath: string;
  readonly dataDir: string;
  readonly endpointBase: string;
  /** Durable (SQLite-backed, R8) daemon audit chain's OWN file — never the memory db. */
  readonly auditDbPath: string;
}

/** Pure argv → config parser (unit-testable without touching the network/fs). */
export function parseArgs(argv: readonly string[]): CliConfig {
  const dbPath = argVal(argv, "--db");
  if (dbPath === undefined || dbPath.length === 0) {
    throw new Error(USAGE);
  }
  const dataDir = argVal(argv, "--data-dir") ?? dirname(dbPath);
  const socketArg = argVal(argv, "--socket");
  const endpointBase =
    socketArg ?? (process.platform === "win32" ? "intelligent-db-daemon" : join(dataDir, "daemon.sock"));
  const auditDbPath = join(dataDir, "daemon-audit.db");
  return { dbPath, dataDir, endpointBase, auditDbPath };
}

// ---------------------------------------------------------------------------
// cli-no-path-preflight fix: the CLI used to hand `--db`/`--socket` straight to
// `createAgentMemory`/`DaemonServer` with zero filesystem preflight. A `--db`
// path whose parent directory doesn't exist yet reached `node:sqlite`'s
// `DatabaseSync` constructor bare and surfaced as an opaque native error
// (reproduced: "unable to open database file" / `ERR_SQLITE_ERROR`, naming
// neither the missing directory nor what to do about it) — and the identical
// shape of problem existed for a POSIX `--socket` path whose parent directory
// is missing (an opaque `ENOENT` from the listener's `bind()`, deep inside
// `server.ts`, only reachable by network I/O, not before it).
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link preflightCliPaths} when a CLI-supplied path's parent
 * directory could not be created or turned out not to be a directory at all
 * (e.g. a plain file already occupies that path). Always names the OFFENDING
 * path plus which CLI flag it came from, and wraps the underlying `node:fs`
 * error rather than letting a bare, unlabeled native error reach the operator.
 */
export class InvalidCliPathError extends Error {
  constructor(
    public readonly kind: "db" | "data-dir" | "socket",
    public readonly path: string,
    cause: unknown,
  ) {
    super(
      `intelligent-db-daemon: invalid --${kind === "data-dir" ? "data-dir" : kind} path ` +
        `${JSON.stringify(path)}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `The parent directory could not be created or is not a directory — check the path and ` +
        `permissions.`,
    );
    this.name = "InvalidCliPathError";
  }
}

/**
 * Ensure `dir` (the directory a CLI-supplied path needs to live under) exists,
 * creating it (and any missing ancestors) if not — mirroring `TokenStore`'s own
 * `mkdirSync(dataDir, { recursive: true })` discipline (`tokens.ts`), just run
 * BEFORE construction instead of inside it, and for every path this CLI takes,
 * not only `dataDir`. Throws {@link InvalidCliPathError} (never a bare native
 * error) if the directory cannot be created, or if something already exists at
 * that path that is not a directory (e.g. a plain file blocking it).
 */
function ensureDirFor(kind: "db" | "data-dir" | "socket", suppliedPath: string, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new InvalidCliPathError(kind, suppliedPath, err);
  }
  let stat;
  try {
    stat = statSync(dir);
  } catch (err) {
    throw new InvalidCliPathError(kind, suppliedPath, err);
  }
  if (!stat.isDirectory()) {
    throw new InvalidCliPathError(kind, suppliedPath, new Error(`${dir} exists and is not a directory`));
  }
}

/**
 * Validate + prepare every filesystem path {@link parseArgs} resolved, BEFORE
 * `main()` constructs anything against them: creates each missing parent
 * directory (`--db`'s, `--data-dir`'s, and — POSIX only — `--socket`'s, since a
 * Windows named-pipe endpoint is a kernel-namespace name, not a filesystem
 * path, and has nothing to preflight) and fails with a clear, typed
 * {@link InvalidCliPathError} naming the exact offending path when a directory
 * cannot be created or turns out to be a file. `parseArgs` itself stays pure
 * (argv → config, no I/O) — this is the deliberate, separate I/O step run right
 * after it in `main()`.
 */
export function preflightCliPaths(config: CliConfig): void {
  ensureDirFor("db", config.dbPath, dirname(config.dbPath));
  ensureDirFor("data-dir", config.dataDir, config.dataDir);
  if (process.platform !== "win32") {
    ensureDirFor("socket", config.endpointBase, dirname(config.endpointBase));
  }
}

// ---------------------------------------------------------------------------
// verifychain-never-invoked-by-product fix: neither checksum chain was ever
// self-verified by SHIPPED code — corruption at rest was only ever caught by
// a human manually scripting a call to `verifyChain()`. Closed two ways: (1)
// MANDATORY at every startup (below, `verifyChainsAtStartup` — refuses to
// serve on failure), and (2) on-demand via the OWNER-gated `verifyChains`
// admin verb (`server.ts`'s `#executeAdminVerb`).
// ---------------------------------------------------------------------------

/** Thrown by {@link verifyChainsAtStartup} when either chain fails self-verification. */
export class ChainVerificationFailedError extends Error {
  constructor(
    public readonly chain: "daemon_audit" | "fact_ratification",
    public readonly firstBrokenSeq: number | null,
  ) {
    super(
      `intelligent-db-daemon: refusing to start — the ${chain} checksum chain failed ` +
        `self-verification at seq ${String(firstBrokenSeq)}. Corruption at rest is not ` +
        `safe to serve from; restore from a known-good snapshot (see OPERATIONS.md).`,
    );
    this.name = "ChainVerificationFailedError";
  }
}

/**
 * Open a SHORT-LIVED second connection to the SAME durable memory db
 * (`dbPath`) whose `ratification_records` table already lives there (see
 * `agent/agentMemory.ts`'s "one shared handle" doc — the default facade wires
 * the pending ledger onto the SAME file when `dbPath` is given), purely to
 * run a READ-ONLY chain operation, then close it. `createSqlitePendingLedger`
 * only ever runs idempotent DDL/pragmas at construction (its own module doc:
 * "safe regardless of which subsystem happens to construct first against a
 * shared handle") — this never mutates the file, so it is safe to run
 * concurrently alongside the daemon's own open handle on the same path.
 */
function withFactChain<T>(dbPath: string, fn: (ledger: { verifyChain(): FactChainVerification; chainHead(): FactChainHead }) => T): T {
  const ledger = createSqlitePendingLedger({ path: dbPath });
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

/**
 * Self-verify BOTH checksum chains — the daemon's own (dedicated file,
 * `auditChain`) and the fact/ratification chain (inside the shared memory db
 * at `dbPath`) — and throw {@link ChainVerificationFailedError} (refuse to
 * serve) if either is inconsistent. Logs loudly via `daemonLog` before
 * throwing either way, so an operator sees WHICH chain and at what seq even
 * if the process then exits non-zero.
 */
export function verifyChainsAtStartup(opts: { auditChain: DaemonAuditChain; dbPath: string }): void {
  const daemonResult = opts.auditChain.verifyChain();
  if (!daemonResult.ok) {
    daemonLog({
      event: "chain_verification_failed",
      level: "error",
      chain: "daemon_audit",
      firstBrokenSeq: daemonResult.firstBrokenSeq,
    });
    throw new ChainVerificationFailedError("daemon_audit", daemonResult.firstBrokenSeq);
  }
  const factResult = withFactChain(opts.dbPath, (l) => l.verifyChain());
  if (!factResult.ok) {
    daemonLog({
      event: "chain_verification_failed",
      level: "error",
      chain: "fact_ratification",
      firstBrokenSeq: factResult.firstBrokenSeq,
    });
    throw new ChainVerificationFailedError("fact_ratification", factResult.firstBrokenSeq);
  }
}

// ---------------------------------------------------------------------------
// Runnable entrypoint
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = parseArgs(argv);
  // cli-no-path-preflight fix: create/validate every filesystem path BEFORE
  // anything is constructed against it — see preflightCliPaths's doc.
  preflightCliPaths(config);

  const memory = createAgentMemory({ dbPath: config.dbPath });
  const tokens = createTokenStore(config.dataDir);
  // R8, durable: its OWN SQLite file (never the memory db) so the daemon's
  // connection/auth/revocation/admin/shutdown trail survives a restart or an
  // unclean (SIGKILL) exit instead of vanishing with the process (see
  // `auditChainSqlite.ts`'s module doc for the gap this closes).
  const auditChain = createSqliteDaemonAuditChain(config.auditDbPath);
  // H2: bind daemon-client identity into the SAME trust registry this memory's
  // identity layer already uses — one swappable trust root, no parallel one.
  const trustRegistry = memory.trust;

  // verifychain-never-invoked-by-product fix: refuse to serve if either
  // checksum chain is already inconsistent at rest — before opening the
  // listener, before any client can connect.
  try {
    verifyChainsAtStartup({ auditChain, dbPath: config.dbPath });
  } catch (err) {
    auditChain.close();
    memory.close();
    throw err;
  }

  const server = new DaemonServer({
    memory,
    tokens,
    auditChain,
    trustRegistry,
    endpointBase: config.endpointBase,
    factChainHead: () => withFactChain(config.dbPath, (l) => l.chainHead()),
    verifyFactChain: () => withFactChain(config.dbPath, (l) => l.verifyChain()),
  });

  const { endpoint } = await server.start();
  process.stderr.write(`intelligent-db-daemon: listening on ${endpoint}\n`);
  process.stderr.write(`intelligent-db-daemon: owner token file: ${ownerTokenFilePath(config.dataDir)}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`intelligent-db-daemon: received ${signal}, shutting down...\n`);
    server
      .stop({ clean: true })
      .then(() => {
        auditChain.close();
        memory.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `intelligent-db-daemon: shutdown error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when invoked directly as a bin (mirrors mcp/server.ts's identical guard).
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return (
      import.meta.url === new URL(`file://${arg}`).href ||
      import.meta.url.endsWith(arg.replace(/\\/g, "/"))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `intelligent-db-daemon fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
