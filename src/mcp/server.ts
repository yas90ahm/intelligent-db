#!/usr/bin/env node
/**
 * mcp/server.ts — THE THIN STDIO TRANSPORT for the minimal MCP server.
 *
 * A runnable bin entry (the shebang above survives `tsc` into dist/, so the
 * advertised bin is directly executable on POSIX): it constructs an
 * {@link AsyncAgentMemory} — in-process (durable when `MEMORY_DB` names a
 * SQLite path, else in-memory) wrapped via {@link syncToAsyncMemory}, or
 * daemon-backed via `daemon/client.ts`'s `createRemoteAgentMemory` (see
 * "DAEMON-BACKED MEMORY" below) — reads line-delimited JSON-RPC requests from
 * stdin through a BOUNDED line splitter ({@link BoundedLineSplitter} — a
 * hostile or buggy client streaming an endless newline-less line must not
 * buffer unbounded memory), pipes each line through the PURE
 * {@link handleMcpRequestAsync}, and writes each response as one JSON line to
 * stdout. All protocol logic lives in the pure handler; this file is only the
 * I/O seam, so it stays trivially correct and the handler stays fully
 * unit-testable.
 *
 * ASYNC, SERIALIZED DISPATCH (PHASE3B_MCP_ASYNC_SPEC.md): `processLine` is
 * `async` and every response is fully AWAITED before the next line is even
 * looked at — requests are dispatched strictly ONE AT A TIME, in submission
 * order, over this single stdio connection (mirroring the daemon's own FIFO
 * queue). Because raw stdin `"data"` events can fire faster than an awaited
 * dispatch resolves, each batch of lines is chained onto one serial promise
 * queue rather than kicked off independently — see `main()`'s `enqueue`.
 *
 * ZERO external deps: raw `process.stdin` / `process.stdout`. No MCP
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
 * The server then exposes five tools to the agent: `remember`, `recall`,
 * `list_pending_questions`, `resolve_pending` (the personal-tier dispute horn:
 * when the user should decide between conflicting memories, the agent asks them and
 * calls `resolve_pending` with their choice), and `why_do_you_believe_this`.
 *
 * DAEMON-BACKED MEMORY (PHASE3_DAEMON_SPEC.md deliverable 2 + PHASE3B_MCP_ASYNC_SPEC.md,
 * opt-in, R7: the in-process default above is unchanged and permanent). Setting BOTH
 * `MEMORY_DAEMON_SOCKET` (the daemon's Unix socket path / Windows named pipe)
 * and `MEMORY_DAEMON_TOKEN_FILE` (a file containing the bearer token — never
 * the token itself in an env var, mirroring how the daemon's own token file
 * is user-private) opts a server instance into daemon-backed memory instead
 * of `MEMORY_DB`. Startup performs a real handshake round trip over
 * `daemon/client.ts`'s `createRemoteAgentMemory` to validate the daemon is
 * reachable and the token is accepted, bounded by `DAEMON_STARTUP_TIMEOUT_MS`
 * — a daemon that is unreachable or rejects the token fails startup fast with
 * a clear error rather than silently falling back to in-process memory. Once
 * validated, the SAME kind of `RemoteAgentMemory` connection serves every
 * request for the life of this process: `RemoteAgentMemory` already satisfies
 * {@link AsyncAgentMemory} structurally (see `mcp/asyncMemory.ts`'s module
 * doc), so it is handed straight to `handleMcpRequestAsync` — no bridge, no
 * adapter, no separate dispatch path from the in-process case. Multiple MCP
 * server processes pointed at the SAME daemon share the SAME underlying
 * memory (see the daemon's own multi-client story, OPERATIONS.md §7).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`.
 */

import { readFile } from "node:fs/promises";

import { createAgentMemory } from "../agent/agentMemory.js";
import { createRemoteAgentMemory } from "../daemon/client.js";
import { syncToAsyncMemory } from "./asyncMemory.js";
import type { AsyncAgentMemory } from "./asyncMemory.js";
import { handleMcpRequestAsync } from "./handler.js";
import type { McpRequest, McpResponse } from "./handler.js";
import { JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS } from "./handler.js";

// ---------------------------------------------------------------------------
// Bounded line splitting — the transport's memory-safety floor
// ---------------------------------------------------------------------------

/**
 * The maximum bytes one stdin line may hold (1 MiB). A line-delimited transport
 * with no line bound is a memory-exhaustion vector: a client (hostile or merely
 * buggy — e.g. one that forgot the trailing newline on a huge payload) streaming
 * a newline-less line would make an unbounded reader buffer it all. Beyond this
 * limit the splitter DISCARDS until the next newline and the transport emits
 * exactly ONE invalid-params error naming the limit, then keeps serving.
 * Comfortably above the handler's own largest cap (remember text, 64 KiB chars)
 * plus JSON-RPC framing.
 */
export const MAX_LINE_BYTES = 1_048_576;

/**
 * A PURE, unit-testable line-splitting state machine over raw stdin chunks —
 * what `node:readline` did, minus the unbounded buffering. Feed it Buffers via
 * {@link push}; it returns complete lines (split on `\n`, one trailing `\r`
 * trimmed) and the number of OVERFLOW EVENTS (lines that exceeded
 * `maxLineBytes`). An oversized line is counted EXACTLY ONCE — at the moment the
 * limit is crossed (or, for a line that arrived whole, at its newline) — then
 * discarded to the next newline, after which normal parsing resumes. Call
 * {@link end} at stream end to flush a final unterminated line.
 */
export class BoundedLineSplitter {
  /** Bytes of the current (incomplete) line buffered so far. */
  #pending: Buffer = Buffer.alloc(0);
  /** True while discarding an oversized line, until its newline arrives. */
  #discarding = false;
  readonly #max: number;

  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.#max = maxLineBytes;
  }

  /** Feed one raw chunk; get every completed line + the overflow-event count. */
  push(chunk: Buffer): { lines: string[]; overflows: number } {
    const lines: string[] = [];
    let overflows = 0;
    const data =
      this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#pending = Buffer.alloc(0);

    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) break;
      if (this.#discarding) {
        // The oversized line (already reported when the limit was crossed) ends
        // here; resume normal parsing from the byte after the newline.
        this.#discarding = false;
      } else {
        const end = nl > start && data[nl - 1] === 0x0d ? nl - 1 : nl; // trim \r
        if (end - start > this.#max) {
          // A whole line that arrived complete but oversized: one error, dropped.
          overflows += 1;
        } else {
          lines.push(data.subarray(start, end).toString("utf8"));
        }
      }
      start = nl + 1;
    }

    const rest = data.subarray(start);
    if (this.#discarding) {
      // Still inside the oversized line: keep discarding, buffer nothing.
    } else if (rest.length > this.#max) {
      // The incomplete line just crossed the limit: report ONCE, then discard
      // until its newline finally shows up.
      overflows += 1;
      this.#discarding = true;
    } else if (rest.length > 0) {
      // Copy (not subarray) so the big concat buffer is releasable immediately.
      this.#pending = Buffer.from(rest);
    }
    return { lines, overflows };
  }

  /** Flush at stream end: a final valid line with no trailing newline still parses. */
  end(): { lines: string[]; overflows: number } {
    const lines: string[] = [];
    if (!this.#discarding && this.#pending.length > 0) {
      let buf = this.#pending;
      if (buf[buf.length - 1] === 0x0d) buf = buf.subarray(0, buf.length - 1);
      if (buf.length > 0) lines.push(buf.toString("utf8"));
    }
    this.#pending = Buffer.alloc(0);
    this.#discarding = false;
    return { lines, overflows: 0 };
  }
}

/**
 * The single error response an overflow event produces: id null (the request id
 * is unrecoverable from a discarded line), invalid-params, the limit named.
 */
function overflowResponse(): McpResponse {
  return {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: JSONRPC_INVALID_PARAMS,
      message:
        `Line exceeded MAX_LINE_BYTES (${MAX_LINE_BYTES} bytes) and was ` +
        `discarded up to the next newline.`,
    },
  };
}

/**
 * Process ONE raw stdin line: parse it as JSON-RPC, dispatch through the pure,
 * ASYNC handler, and return the response to write (or `null` for a notification /
 * blank line, which produces no output). A parse error becomes a JSON-RPC error
 * response with a null id (we cannot recover the request id from unparseable input).
 */
export async function processLine(
  line: string,
  memory: AsyncAgentMemory,
): Promise<McpResponse | null> {
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

  return handleMcpRequestAsync(req, memory);
}

// ---------------------------------------------------------------------------
// Daemon-backed memory switch (opt-in; PHASE3_DAEMON_SPEC.md deliverable 2 +
// PHASE3B_MCP_ASYNC_SPEC.md — full per-request dispatch is WIRED end-to-end:
// see the module doc's "DAEMON-BACKED MEMORY" section)
// ---------------------------------------------------------------------------

/** How long startup waits for the daemon handshake before giving up. */
export const DAEMON_STARTUP_TIMEOUT_MS = 8_000;

/** Daemon opt-in config, resolved from env (mirrors the `MEMORY_DB` pattern). */
export interface DaemonMemoryConfig {
  readonly socketPath: string;
  readonly token: string;
}

/**
 * Read `MEMORY_DAEMON_SOCKET` / `MEMORY_DAEMON_TOKEN_FILE` from the
 * environment. Returns `null` when daemon mode is not requested (the
 * default). Throws a plain, descriptive `Error` for a half-configured or
 * unreadable/empty token file — never silently falls back to in-process when
 * the operator clearly tried to opt in.
 */
export async function resolveDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonMemoryConfig | null> {
  const socketPath = env["MEMORY_DAEMON_SOCKET"];
  if (socketPath === undefined || socketPath.length === 0) return null;

  const tokenFile = env["MEMORY_DAEMON_TOKEN_FILE"];
  if (tokenFile === undefined || tokenFile.length === 0) {
    throw new Error(
      "MEMORY_DAEMON_SOCKET is set but MEMORY_DAEMON_TOKEN_FILE is not — both are " +
        "required to opt into daemon-backed memory (the raw token is never read from " +
        "an env var, mirroring the daemon's own user-private token file).",
    );
  }
  let raw: string;
  try {
    raw = await readFile(tokenFile, "utf8");
  } catch (err) {
    throw new Error(
      `MEMORY_DAEMON_TOKEN_FILE ${tokenFile} could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const token = raw.trim();
  if (token.length === 0) {
    throw new Error(`MEMORY_DAEMON_TOKEN_FILE ${tokenFile} is empty.`);
  }
  return { socketPath, token };
}

/**
 * Validate the daemon is reachable and the token is accepted: a real
 * handshake round trip over {@link createRemoteAgentMemory}, bounded by
 * `timeoutMs` so a stale/unreachable socket path fails fast rather than
 * hanging (reconnect-with-backoff would otherwise retry forever). Always
 * closes the probing connection before returning/throwing.
 */
export async function validateDaemonConnectivity(
  config: DaemonMemoryConfig,
  timeoutMs: number = DAEMON_STARTUP_TIMEOUT_MS,
): Promise<void> {
  const remote = createRemoteAgentMemory({ socketPath: config.socketPath, token: config.token });
  try {
    await Promise.race([
      remote.getDefaultSourceId(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `daemon at ${config.socketPath} did not complete the handshake within ` +
                `${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    await remote.close();
  }
}

/**
 * The runnable transport. Wires an {@link AsyncAgentMemory} and pumps stdin →
 * handler → stdout, one JSON line per message. Resolves when stdin closes (the
 * client disconnected), after closing the memory.
 *
 * Backing choice: `MEMORY_DAEMON_SOCKET` + `MEMORY_DAEMON_TOKEN_FILE` opt into
 * the daemon path — connectivity is validated first (fail-fast, unchanged),
 * then a real `RemoteAgentMemory` connection serves every request for the life
 * of this process (PHASE3B_MCP_ASYNC_SPEC.md: no bridge, no adapter — it
 * already satisfies {@link AsyncAgentMemory} structurally). Otherwise this is
 * the original in-process behavior (`MEMORY_DB` durable / in-memory default,
 * R7's permanent default), wrapped once via {@link syncToAsyncMemory}.
 */
export async function main(): Promise<void> {
  const daemonConfig = await resolveDaemonConfig();
  let memory: AsyncAgentMemory;
  if (daemonConfig !== null) {
    // Fail fast (clear error, bounded wait) BEFORE committing to this backing —
    // see validateDaemonConnectivity's doc. The long-lived connection actually
    // serving requests below is constructed fresh, separately.
    await validateDaemonConnectivity(daemonConfig);
    memory = createRemoteAgentMemory({ socketPath: daemonConfig.socketPath, token: daemonConfig.token });
  } else {
    const dbPath = process.env["MEMORY_DB"];
    memory = syncToAsyncMemory(
      createAgentMemory(dbPath !== undefined && dbPath.length > 0 ? { dbPath } : {}),
    );
  }

  const splitter = new BoundedLineSplitter();
  const handleBatch = async (batch: { lines: string[]; overflows: number }): Promise<void> => {
    // Exactly ONE error per overflow event (an oversized line was discarded).
    for (let i = 0; i < batch.overflows; i++) {
      process.stdout.write(JSON.stringify(overflowResponse()) + "\n");
    }
    for (const line of batch.lines) {
      const response = await processLine(line, memory);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    }
  };

  // Requests are dispatched strictly ONE AT A TIME, in submission order (see
  // the module doc): raw stdin "data" events fire synchronously and can arrive
  // faster than a prior batch's awaited dispatch resolves, so every batch is
  // chained onto ONE serial promise queue rather than kicked off independently.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (batch: { lines: string[]; overflows: number }): void => {
    queue = queue.then(() => handleBatch(batch));
  };

  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => {
      enqueue(splitter.push(chunk));
    });
    process.stdin.on("end", () => {
      enqueue(splitter.end()); // a final line without a trailing newline still serves
      queue.then(() => resolve());
    });
  });
  await queue;

  await memory.close();
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
