/**
 * mcp/handler.ts — THE PURE MCP REQUEST HANDLER (zero-dep, fully unit-testable).
 *
 * A REAL Claude/agent connects to a memory server over the Model Context Protocol
 * (MCP), which is JSON-RPC 2.0. This module is the PURE core of that server: it maps
 * a parsed JSON-RPC request + an {@link AgentMemory} to a JSON-RPC response, with NO
 * I/O. The thin stdio transport (mcp/server.ts) frames stdin/stdout around it.
 *
 * We HAND-ROLL a minimal MCP server rather than adding `@modelcontextprotocol/sdk`:
 * the project's hard constraint is ZERO external runtime deps, and the surface we need
 * (initialize + tools/list + tools/call for two tools) is small enough that a minimal
 * conformant handler is preferable to a dependency. The shapes below follow the MCP
 * spec exactly (protocolVersion, capabilities.tools, serverInfo; tool inputSchema as
 * JSON Schema; tools/call result `content: [{type:"text", text}]`).
 *
 * METHODS:
 *   - `initialize`      → { protocolVersion, capabilities: { tools: {} }, serverInfo }
 *   - `notifications/*` → no response (a notification has no id; we return null)
 *   - `tools/list`      → { tools: [ remember, recall ] }
 *   - `tools/call`      → dispatch to memory.remember / memory.recall, returning the
 *                         result (or a cited-facts rendering) as text content.
 *   - unknown method / tool → a JSON-RPC error object (code + message).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`.
 */

import type { AgentMemory } from "../agent/agentMemory.js";
import type { Cue } from "../recall/cueResolver.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 shapes
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request (or notification when `id` is absent). */
export interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC 2.0 error object. */
export interface McpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A JSON-RPC 2.0 response. Exactly one of `result` / `error` is present. */
export interface McpResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: McpError;
}

// Standard JSON-RPC error codes (subset we use).
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** The MCP protocol version this minimal server speaks. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** The advertised server identity. */
export const SERVER_INFO = { name: "intelligent-db", version: "0.0.0" } as const;

// ---------------------------------------------------------------------------
// Tool definitions (advertised by tools/list, dispatched by tools/call)
// ---------------------------------------------------------------------------

/** The two tools a connected agent may call. */
export const TOOLS = [
  {
    name: "remember",
    description:
      "Store a fact in trust-aware memory. Provenance-rooted and recallable later " +
      "by a fuzzy cue. Provide the fact text; optionally an entity and attribute.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, in plain English." },
        entity: {
          type: "string",
          description: "Optional entity the fact is about (derived from text if omitted).",
        },
        attribute: {
          type: "string",
          description: "Optional (entity, attribute) claim key.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description:
      "Recall grounded, cited facts relevant to a question via spreading activation. " +
      "Returns only facts with real provenance (no provenance, no voice).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The natural-language question / cue to recall against.",
        },
      },
      required: ["query"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): McpResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** A tool result with a single text content block (the MCP tool-result shape). */
function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// The pure handler
// ---------------------------------------------------------------------------

/**
 * Handle one parsed JSON-RPC request against an {@link AgentMemory}, returning the
 * JSON-RPC response (or `null` for a notification, which carries no id and expects no
 * reply). Pure except for the memory side effects the dispatched tool performs; no I/O.
 */
export function handleMcpRequest(
  req: McpRequest,
  memory: AgentMemory,
): McpResponse | null {
  const id = req.id ?? null;

  // Notifications (e.g. "notifications/initialized") have no id and need no reply.
  if (req.id === undefined && req.method.startsWith("notifications/")) {
    return null;
  }

  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call":
      return handleToolsCall(id, req.params, memory);

    default:
      // A notification for an unknown method still expects no reply.
      if (req.id === undefined) return null;
      return fail(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

function handleToolsCall(
  id: string | number | null,
  params: unknown,
  memory: AgentMemory,
): McpResponse {
  const p = asRecord(params);
  const name = p["name"];
  const args = asRecord(p["arguments"]);

  if (name === "remember") {
    const text = args["text"];
    if (typeof text !== "string" || text.length === 0) {
      return fail(id, JSONRPC_INVALID_PARAMS, "remember: 'text' (string) is required.");
    }
    const entity = args["entity"];
    const attribute = args["attribute"];
    try {
      const { id: strandId } = memory.remember({
        text,
        ...(typeof entity === "string" ? { entity } : {}),
        ...(typeof attribute === "string" ? { attribute } : {}),
      });
      return ok(id, textResult(`Remembered fact ${String(strandId)}.`));
    } catch (err) {
      return fail(id, JSONRPC_INTERNAL_ERROR, errorMessage(err));
    }
  }

  if (name === "recall") {
    const query = args["query"];
    if (typeof query !== "string" || query.length === 0) {
      return fail(id, JSONRPC_INVALID_PARAMS, "recall: 'query' (string) is required.");
    }
    try {
      const cue: Cue = { text: query };
      const { facts } = memory.recall(cue);
      return ok(id, textResult(renderFacts(facts)));
    } catch (err) {
      return fail(id, JSONRPC_INTERNAL_ERROR, errorMessage(err));
    }
  }

  return fail(id, JSONRPC_METHOD_NOT_FOUND, `Unknown tool: ${String(name)}`);
}

/** Render cited facts as readable text content for a tool result. */
function renderFacts(
  facts: ReadonlyArray<{ text: string; citation: string; activation: number }>,
): string {
  if (facts.length === 0) {
    return "No grounded facts recalled for that cue.";
  }
  return facts
    .map(
      (f, i) =>
        `${i + 1}. ${f.text}\n   [${f.citation}; activation ${f.activation.toFixed(3)}]`,
    )
    .join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
