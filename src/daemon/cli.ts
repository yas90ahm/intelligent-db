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

import { createAgentMemory } from "../agent/agentMemory.js";
import { createDaemonAuditChain } from "./auditChain.js";
import { createTokenStore, ownerTokenFilePath } from "./tokens.js";
import { DaemonServer } from "./server.js";

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
  return { dbPath, dataDir, endpointBase };
}

// ---------------------------------------------------------------------------
// Runnable entrypoint
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const config = parseArgs(argv);

  const memory = createAgentMemory({ dbPath: config.dbPath });
  const tokens = createTokenStore(config.dataDir);
  const auditChain = createDaemonAuditChain();
  // H2: bind daemon-client identity into the SAME trust registry this memory's
  // identity layer already uses — one swappable trust root, no parallel one.
  const trustRegistry = memory.trust;

  const server = new DaemonServer({
    memory,
    tokens,
    auditChain,
    trustRegistry,
    endpointBase: config.endpointBase,
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
