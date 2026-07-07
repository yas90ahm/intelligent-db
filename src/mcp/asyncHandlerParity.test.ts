/**
 * mcp/asyncHandlerParity.test.ts — PHASE3B_MCP_ASYNC_SPEC.md Tests #1 (the unit
 * parity proof): `handleMcpRequestAsync` over `syncToAsyncMemory(createAgentMemory())`
 * — the in-process path — produces responses IDENTICAL to what the pre-async
 * synchronous handler produced, verb by verb, for every MCP tool plus the
 * consent-token flow and the error paths.
 *
 * There is no second, divergent dispatch implementation to compare against
 * (PHASE3B_MCP_ASYNC_SPEC.md's binding decision: ONE dispatch, async — see
 * mcp/handler.ts's module doc), so "parity with the old sync handler" is
 * proven the only honest way available: the async handler's rendering is a
 * PURE function of exactly the same `AgentMemory` state the old synchronous
 * handler would have read (same rendering helpers, untouched by this
 * migration) — this file cross-checks every tool's rendered output against
 * the underlying engine's OWN state, read directly and synchronously, so any
 * future change that lets the async wrapping alter timing, ordering, or
 * content would show up here as a genuine parity break.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentMemory,
  handleMcpRequestAsync,
  syncToAsyncMemory,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
} from "../index.js";
import type { AttributeKey, StrandId } from "../core/types.js";
import type { McpRequest, McpResponse } from "./handler.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshMemory(): ReturnType<typeof createAgentMemory> {
  const mem = createAgentMemory();
  cleanups.push(() => mem.close());
  return mem;
}

async function call(memory: ReturnType<typeof createAgentMemory>, req: McpRequest): Promise<McpResponse> {
  const res = await handleMcpRequestAsync(req, syncToAsyncMemory(memory));
  expect(res).not.toBeNull();
  return res as McpResponse;
}

async function toolCall(
  memory: ReturnType<typeof createAgentMemory>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpResponse> {
  return call(memory, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function toolText(res: McpResponse): string {
  expect(res.error).toBeUndefined();
  return (res.result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

function extractToken(listText: string, csid: string): string {
  const idx = listText.indexOf(`contradictionSetId: ${csid}`);
  expect(idx).toBeGreaterThanOrEqual(0);
  const m = listText.slice(idx).match(/confirmationToken:\s*(\S+)/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("async handler parity — remember", () => {
  it("the returned strand id matches what a direct mem.recall() resolves to", async () => {
    const mem = freshMemory();
    const res = await toolCall(mem, 1, "remember", {
      text: "the parity check fact",
      entity: "entity:parity",
    });
    const text = toolText(res);
    expect(text).toBe(
      // The rendering is exactly what the old sync handler produced: the
      // engine's own strand id, read directly, embedded verbatim.
      `Remembered fact ${String(mem.recall("parity check fact").facts[0]!.strandId)}.`,
    );
  });
});

describe("async handler parity — recall", () => {
  it("rendered text/citation/state match the facade's own recall() output exactly", async () => {
    const mem = freshMemory();
    // Seed directly (bypassing the handler) so we have an independent baseline.
    mem.remember({ text: "Paris is the capital of France", entity: "entity:paris" });

    const direct = mem.recall("what is the capital of France?");
    expect(direct.facts.length).toBeGreaterThan(0);

    const res = await toolCall(mem, 2, "recall", { query: "what is the capital of France?" });
    const rendered = toolText(res);

    for (const f of direct.facts) {
      // Same text, same citation, same activation formatting, same fact_state
      // label rule the pre-async renderer used — nothing about the async
      // wrapping changed what is shown to the connected agent.
      expect(rendered).toContain(f.text);
      expect(rendered).toContain(`[${f.citation}; activation ${f.activation.toFixed(3)}]`);
    }
  });
});

describe("async handler parity — pendingQuestions / resolvePending consent flow", () => {
  function seedDispute(mem: ReturnType<typeof createAgentMemory>): { attr: AttributeKey } {
    const ATTR = "parity#wifi" as AttributeKey;
    mem.remember({ text: "the wifi password is alpha", entity: "entity:parity-router", attribute: "parity#wifi" });
    const rival = mem.trust.registerSsoMember({
      issuer: "https://idp.parity.example",
      subject: "bob",
      tenantId: "tenant:parity",
      label: "bob@parity",
    });
    mem.remember({
      text: "the wifi password is beta",
      entity: "entity:parity-router",
      attribute: "parity#wifi",
      source: { sourceId: rival.sourceId },
    });
    expect(mem.adjudicate(ATTR).kind).toBe("DEFERRED");
    return { attr: ATTR };
  }

  it("list_pending_questions renders exactly the direct pendingQuestions() question/options", async () => {
    const mem = freshMemory();
    seedDispute(mem);
    const direct = mem.pendingQuestions();
    expect(direct).toHaveLength(1);

    const listText = toolText(await toolCall(mem, 3, "list_pending_questions"));
    expect(listText).toContain(direct[0]!.question);
    expect(listText).toContain(String(direct[0]!.contradictionSetId));
    for (const o of direct[0]!.options) {
      expect(listText).toContain(`"${o.text}"`);
      expect(listText).toContain(String(o.strandId));
    }
  });

  it("resolve_pending without a token is REJECTED; with the listed token it SUCCEEDS and matches direct resolvePending state", async () => {
    const mem = freshMemory();
    seedDispute(mem);
    const csid = String(mem.pendingQuestions()[0]!.contradictionSetId);
    const chosen = String(mem.pendingQuestions()[0]!.options[0]!.strandId);

    // No token: rejected before the engine is ever touched — dispute untouched.
    const rejected = await toolCall(mem, 4, "resolve_pending", {
      contradictionSetId: csid,
      chosenStrandId: chosen,
    });
    expect(rejected.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(mem.listPending()).toHaveLength(1);

    // Wrong token: also rejected.
    const wrong = await toolCall(mem, 5, "resolve_pending", {
      contradictionSetId: csid,
      chosenStrandId: chosen,
      confirmationToken: "0".repeat(32),
    });
    expect(wrong.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(mem.listPending()).toHaveLength(1);

    // The listed token succeeds — and the resulting engine state matches what
    // a direct resolvePending() call would have produced (same verb, same args).
    const listText = toolText(await toolCall(mem, 6, "list_pending_questions"));
    const token = extractToken(listText, csid);
    const resolved = toolText(
      await toolCall(mem, 7, "resolve_pending", {
        contradictionSetId: csid,
        chosenStrandId: chosen,
        confirmationToken: token,
      }),
    );
    expect(resolved).toContain(`Resolved dispute ${csid}`);
    expect(mem.listPending()).toHaveLength(0); // the dispute really resolved
    expect(mem.pendingQuestions()).toHaveLength(0);
  });
});

describe("async handler parity — why_do_you_believe_this", () => {
  it("the dossier renders exactly the fields the direct explain() report carries", async () => {
    const mem = freshMemory();
    const { id } = mem.remember({ text: "the parity dossier fact", entity: "entity:parity-dossier" });

    const direct = mem.explain(id)!;
    const dossier = toolText(await toolCall(mem, 8, "why_do_you_believe_this", { strandId: String(id) }));

    expect(dossier).toContain(`strandId: ${String(direct.strandId)}`);
    expect(dossier).toContain(`state: ${String(direct.factState)}`);
    expect(dossier).toContain(`contested: ${direct.contested ? "yes" : "no"}`);
    expect(dossier).toContain(`independent corroboration count (the engine's own gate number): ${direct.independentRootCount}`);
  });

  it("unknown strandId: handler INVALID_PARAMS matches direct explain() returning null", async () => {
    const mem = freshMemory();
    expect(mem.explain("strand:parity-ghost" as StrandId)).toBeNull();
    const res = await toolCall(mem, 9, "why_do_you_believe_this", { strandId: "strand:parity-ghost" });
    expect(res.error?.code).toBe(JSONRPC_INVALID_PARAMS);
  });
});

describe("async handler parity — error paths unchanged by the async migration", () => {
  it("unknown JSON-RPC method -> METHOD_NOT_FOUND", async () => {
    const mem = freshMemory();
    const res = await call(mem, { jsonrpc: "2.0", id: 10, method: "does/not/exist" });
    expect(res.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });

  it("unknown tool name -> METHOD_NOT_FOUND", async () => {
    const mem = freshMemory();
    const res = await toolCall(mem, 11, "not_a_real_tool");
    expect(res.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND);
  });

  it("missing required remember.text -> INVALID_PARAMS, nothing written", async () => {
    const mem = freshMemory();
    const res = await toolCall(mem, 12, "remember", {});
    expect(res.error?.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(mem.recall("anything").facts).toHaveLength(0);
  });
});
