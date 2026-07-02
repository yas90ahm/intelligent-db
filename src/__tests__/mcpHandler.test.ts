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
  JSONRPC_INVALID_PARAMS,
  REMEMBER_TEXT_MAX_CHARS,
  RECALL_QUERY_MAX_CHARS,
  RESOLVE_ID_MAX_CHARS,
  BoundedLineSplitter,
  MAX_LINE_BYTES,
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

  it("tools/list → the advertised tools with JSON-Schema inputs", () => {
    const mem = createAgentMemory();
    const res = call(mem, { jsonrpc: "2.0", id: 2, method: "tools/list" });

    const result = res.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    const names = result.tools.map((t) => t.name).sort();
    // PHASE 4 added the personal-tier dispute-horn tools alongside remember/recall;
    // the explain feature added the belief-dossier tool (why_do_you_believe_this).
    expect(names).toEqual([
      "list_pending_questions",
      "recall",
      "remember",
      "resolve_pending",
      "why_do_you_believe_this",
    ]);
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

  it("remember with origin 'web' quarantines: recall renders the [PROVISIONAL] label; omitted origin stays LIVE", () => {
    const mem = createAgentMemory();

    // The user's own fact (no origin): owner-stamped, LIVE — the regression pin.
    call(mem, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { text: "Osaka has great food", entity: "osaka" },
      },
    });

    // A fact scraped off a web page: filed under the page's (unverified)
    // publisher ⇒ quarantined PROVISIONAL by the existing ingest gate.
    const remembered = call(mem, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          text: "Osaka is the largest city in Japan",
          entity: "osaka",
          origin: { kind: "web", resourceId: "https://sketchy-claims.example/osaka" },
        },
      },
    });
    expect(remembered.error).toBeUndefined();

    const recalled = call(mem, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "tell me about osaka" } },
    });
    const text = (recalled.result as {
      content: Array<{ type: string; text: string }>;
    }).content[0]!.text;

    // The web-sourced claim is labeled; the user's own fact is NOT.
    const lines = text.split("\n").filter((l) => /^\d+\./.test(l.trim()));
    const webLine = lines.find((l) => l.includes("largest city"));
    const userLine = lines.find((l) => l.includes("great food"));
    expect(webLine).toBeDefined();
    expect(webLine).toContain("[PROVISIONAL]");
    expect(userLine).toBeDefined();
    expect(userLine).not.toContain("[PROVISIONAL]");

    mem.close();
  });

  it("remember origin validation: unknown kind and missing resourceId are invalid params", () => {
    const mem = createAgentMemory();

    const badKind = call(mem, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { text: "x", origin: { kind: "telepathy" } },
      },
    });
    expect(badKind.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(badKind.error?.message).toContain("origin.kind");

    const noResource = call(mem, {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "remember", arguments: { text: "x", origin: { kind: "web" } } },
    });
    expect(noResource.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(noResource.error?.message).toContain("origin.resourceId");

    mem.close();
  });

  it("over-limit remember text is rejected with the limit NAMED and the store left empty", () => {
    const mem = createAgentMemory();
    const oversize = "x".repeat(REMEMBER_TEXT_MAX_CHARS + 1);

    const res = call(mem, {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "remember", arguments: { text: oversize, entity: "flood" } },
    });
    expect(res.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(res.error?.message).toContain(String(REMEMBER_TEXT_MAX_CHARS));

    // Nothing landed: the rejection happened AT the boundary, before the engine.
    const recalled = call(mem, {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "flood" } },
    });
    expect(
      (recalled.result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toContain("No grounded facts");

    mem.close();
  });

  it("over-limit recall query and resolve_pending ids are rejected with named limits", () => {
    const mem = createAgentMemory();

    const bigQuery = call(mem, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "recall",
        arguments: { query: "q".repeat(RECALL_QUERY_MAX_CHARS + 1) },
      },
    });
    expect(bigQuery.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(bigQuery.error?.message).toContain(String(RECALL_QUERY_MAX_CHARS));

    const bigId = call(mem, {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "resolve_pending",
        arguments: {
          contradictionSetId: "c".repeat(RESOLVE_ID_MAX_CHARS + 1),
          chosenStrandId: "strand:ok",
        },
      },
    });
    expect(bigId.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(bigId.error?.message).toContain(String(RESOLVE_ID_MAX_CHARS));

    mem.close();
  });

  it("recall accepts 'cue' as an alias for 'query' (query stays canonical)", () => {
    const mem = createAgentMemory();
    call(mem, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { text: "Kyoto was the old capital of Japan", entity: "kyoto" },
      },
    });

    const viaAlias = call(mem, {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "recall", arguments: { cue: "what was the old capital?" } },
    });
    expect(viaAlias.error).toBeUndefined();
    expect(
      (viaAlias.result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toContain("Kyoto");

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

describe("BoundedLineSplitter — the transport's memory-safety floor (pure state machine)", () => {
  it("splits ordinary lines across chunk boundaries and trims a trailing \\r", () => {
    const s = new BoundedLineSplitter();
    // One line delivered in two chunks, CRLF-terminated, then a second LF line.
    const first = s.push(Buffer.from('{"a":'));
    expect(first.lines).toEqual([]);
    expect(first.overflows).toBe(0);
    const second = s.push(Buffer.from('1}\r\n{"b":2}\n'));
    expect(second.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(second.overflows).toBe(0);
  });

  it("a 2 MiB newline-less stream yields EXACTLY ONE overflow, and the next well-formed line still parses", () => {
    const s = new BoundedLineSplitter();
    let overflows = 0;
    let lines: string[] = [];
    const absorb = (r: { lines: string[]; overflows: number }): void => {
      overflows += r.overflows;
      lines = lines.concat(r.lines);
    };

    // 2 MiB of newline-less garbage, streamed in 64 KiB chunks (as stdin would).
    const chunk = Buffer.alloc(65_536, 0x61); // "a"
    for (let sent = 0; sent < 2 * MAX_LINE_BYTES; sent += chunk.length) {
      absorb(s.push(chunk));
    }
    expect(overflows).toBe(1); // exactly one error event for the whole flood
    expect(lines).toEqual([]);

    // The flood's newline finally arrives, followed by a well-formed line: the
    // splitter recovered and keeps serving.
    absorb(s.push(Buffer.from('\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n')));
    expect(overflows).toBe(1);
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":7,"method":"ping"}']);
  });

  it("a complete-but-oversized single line is one overflow; end() flushes a final unterminated line", () => {
    const small = new BoundedLineSplitter(16); // tiny limit for a cheap direct case
    const r = small.push(Buffer.from("this line is far longer than sixteen bytes\nok\n"));
    expect(r.overflows).toBe(1); // the oversized line, counted once, dropped
    expect(r.lines).toEqual(["ok"]);

    // A valid final line missing its trailing newline still parses at end().
    const tail = small.push(Buffer.from("last"));
    expect(tail.lines).toEqual([]);
    const flushed = small.end();
    expect(flushed.lines).toEqual(["last"]);
    expect(flushed.overflows).toBe(0);
  });
});
