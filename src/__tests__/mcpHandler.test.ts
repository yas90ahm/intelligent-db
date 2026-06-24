/**
 * mcpHandler.test.ts — the PURE MCP request handler (JSON-RPC 2.0 / MCP).
 *
 * Drives handleMcpRequest with framed initialize / tools/list / tools/call objects
 * and asserts valid MCP responses, plus a tools/call remember-then-recall ROUND-TRIP
 * of a fact. Also exercises the line transport's processLine (parse + dispatch).
 */

import { describe, it, expect } from "vitest";

import {
  createAgentMemory,
  handleMcpRequest,
  mcpProcessLine,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  JSONRPC_METHOD_NOT_FOUND,
} from "../index.js";
import type { McpRequest, McpResponse } from "../index.js";

function call(memory: ReturnType<typeof createAgentMemory>, req: McpRequest): McpResponse {
  const res = handleMcpRequest(req, memory);
  expect(res).not.toBeNull();
  return res as McpResponse;
}

describe("MCP handler (pure JSON-RPC 2.0)", () => {
  it("initialize → protocolVersion + capabilities.tools + serverInfo", () => {
    const mem = createAgentMemory();
    const res = call(mem, { jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();
    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo).toEqual(MCP_SERVER_INFO);
    mem.close();
  });

  it("tools/list → the two tools with JSON-Schema inputs", () => {
    const mem = createAgentMemory();
    const res = call(mem, { jsonrpc: "2.0", id: 2, method: "tools/list" });

    const result = res.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["recall", "remember"]);
    expect(result.tools.length).toBe(MCP_TOOLS.length);
    for (const t of result.tools) expect(t.inputSchema).toBeDefined();
    mem.close();
  });

  it("a notification (no id) yields no response", () => {
    const mem = createAgentMemory();
    const res = handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      mem,
    );
    expect(res).toBeNull();
    mem.close();
  });

  it("unknown method → JSON-RPC method-not-found error", () => {
    const mem = createAgentMemory();
    const res = call(mem, { jsonrpc: "2.0", id: 3, method: "does/not/exist" });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    mem.close();
  });

  it("tools/call remember then recall ROUND-TRIPS a fact", () => {
    const mem = createAgentMemory();

    const remembered = call(mem, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { text: "Tokyo is the capital of Japan", entity: "tokyo" },
      },
    });
    const rememberContent = (remembered.result as {
      content: Array<{ type: string; text: string }>;
    }).content;
    expect(rememberContent[0]!.type).toBe("text");
    expect(rememberContent[0]!.text).toContain("Remembered fact");

    const recalled = call(mem, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "what is the capital of Japan?" } },
    });
    const recallText = (recalled.result as {
      content: Array<{ type: string; text: string }>;
    }).content[0]!.text;
    expect(recallText).toContain("Tokyo is the capital of Japan");
    expect(recallText).toContain("source "); // cited

    mem.close();
  });

  it("tools/call with a missing required param → invalid-params error", () => {
    const mem = createAgentMemory();
    const res = call(mem, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "remember", arguments: {} },
    });
    expect(res.error).toBeDefined();
    mem.close();
  });

  it("tools/call unknown tool → method-not-found error", () => {
    const mem = createAgentMemory();
    const res = call(mem, {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(res.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    mem.close();
  });

  it("transport processLine: parses a JSON line and dispatches; blank line is ignored", () => {
    const mem = createAgentMemory();

    expect(mcpProcessLine("   ", mem)).toBeNull();

    const line = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" });
    const res = mcpProcessLine(line, mem);
    expect(res?.id).toBe(99);
    expect(res?.error).toBeUndefined();

    // A malformed line becomes a JSON-RPC error with a null id (id unrecoverable).
    const bad = mcpProcessLine("{ not json", mem);
    expect(bad?.id).toBeNull();
    expect(bad?.error).toBeDefined();

    mem.close();
  });
});
