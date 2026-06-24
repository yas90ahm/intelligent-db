/**
 * mcp/server.ts — THE THIN STDIO TRANSPORT for the minimal MCP server.
 *
 * A runnable bin entry: it constructs an {@link AgentMemory} (durable when the
 * `MEMORY_DB` env var names a SQLite path, else in-memory), reads line-delimited
 * JSON-RPC requests from stdin via `node:readline`, pipes each through the PURE
 * {@link handleMcpRequest}, and writes each response as one JSON line to stdout. All
 * protocol logic lives in the pure handler; this file is only the I/O seam, so it
 * stays trivially correct and the handler stays fully unit-testable.
 *
 * ZERO external deps: `node:readline` over `process.stdin` / `process.stdout`. No MCP
 * SDK — a hand-rolled minimal server keeps the zero-dep constraint (see handler.ts).
 *
 * REGISTERING WITH A CLAUDE/AGENT CLIENT (usage note):
 *   - Build first: `npm run build` (compiles to dist/).
 *   - Claude Code CLI:
 *       claude mcp add intelligent-db -- node /abs/path/to/dist/mcp/server.js
 *     (set a durable store with:  -e MEMORY_DB=/abs/path/to/memory.db)
 *   - Or a client `mcpServers` JSON block:
 *       {
 *         "mcpServers": {
 *           "intelligent-db": {
 *             "command": "node",
 *             "args": ["/abs/path/to/dist/mcp/server.js"],
 *             "env": { "MEMORY_DB": "/abs/path/to/memory.db" }
 *           }
 *         }
 *       }
 *   - Or via the package bin:  npx intelligent-db-mcp   (after `npm link` / install).
 *
 * The server then exposes two tools to the agent: `remember` and `recall`.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`.
 */

import { createInterface } from "node:readline";

import { createAgentMemory } from "../agent/agentMemory.js";
import type { AgentMemory } from "../agent/agentMemory.js";
import { handleMcpRequest } from "./handler.js";
import type { McpRequest, McpResponse } from "./handler.js";
import { JSONRPC_INTERNAL_ERROR } from "./handler.js";

/**
 * Process ONE raw stdin line: parse it as JSON-RPC, dispatch through the pure
 * handler, and return the response to write (or `null` for a notification / blank
 * line, which produces no output). A parse error becomes a JSON-RPC error response
 * with a null id (we cannot recover the request id from unparseable input).
 */
export function processLine(line: string, memory: AgentMemory): McpResponse | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let req: McpRequest;
  try {
    req = JSON.parse(trimmed) as McpRequest;
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  return handleMcpRequest(req, memory);
}

/**
 * The runnable transport. Wires an {@link AgentMemory} and pumps stdin → handler →
 * stdout, one JSON line per message. Resolves when stdin closes (the client
 * disconnected), after closing the store.
 */
export async function main(): Promise<void> {
  const dbPath = process.env["MEMORY_DB"];
  const memory: AgentMemory = createAgentMemory(
    dbPath !== undefined && dbPath.length > 0 ? { dbPath } : {},
  );

  const rl = createInterface({ input: process.stdin, terminal: false });

  await new Promise<void>((resolve) => {
    rl.on("line", (line: string) => {
      const response = processLine(line, memory);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    });
    rl.on("close", () => {
      resolve();
    });
  });

  memory.close();
}

// Run only when invoked directly as a bin (not when imported by a test).
// import.meta.url vs argv[1] is the standard ESM "is this the entry module" check.
const invokedDirectly = (() => {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${arg}`).href || import.meta.url.endsWith(arg.replace(/\\/g, "/"));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `intelligent-db-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
