/**
 * mcp/resolvePendingConsent.test.ts — regression coverage for
 * `resolve-pending-no-consent-binding` (PRODUCTION_READINESS_ASSESSMENT.md,
 * CONFIRMED high): `resolve_pending` had NO technical binding that a human
 * actually reviewed the dispute before it fired — a prompt-injected relaying
 * agent could call `resolve_pending` directly, skipping `list_pending_questions`
 * entirely, and silently resolve any open dispute (the owner-override policy
 * hook makes this worse in the personal tier: no self-approval/anchor gate
 * stands in the way once the daemon's actor is the owner).
 *
 * Fixed AT THE MCP BOUNDARY (`mcp/handler.ts`), never touching
 * `AgentMemory.resolvePending`'s own semantics: `list_pending_questions` mints
 * a fresh, single-use, short-TTL confirmation token per open question;
 * `resolve_pending` now REQUIRES a matching, unexpired token or is rejected.
 *
 * These tests drive the REAL, exported `handleMcpRequest` against a REAL
 * `AgentMemory` (never a re-derived mock of the fix) — the exact production
 * code path a connected agent uses.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createAgentMemory } from "../agent/agentMemory.js";
import type { AttributeKey } from "../core/types.js";
import { handleMcpRequest } from "./handler.js";
import type { McpRequest, McpResponse } from "./handler.js";

const ENTITY = "entity:consent-router";
const ATTR = "consent-router#wifi_password" as AttributeKey;

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

/** ONE genuine two-class LIVE dispute, deferred to the horn (mirrors disputeHorn.test.ts). */
function makeDisputedMemory() {
  const mem = createAgentMemory();
  cleanups.push(() => mem.close());

  const { id: ownerFactId } = mem.remember({
    text: "the wifi password is hunter2",
    entity: ENTITY,
    attribute: "consent-router#wifi_password",
  });
  const rival = mem.trust.registerSsoMember({
    issuer: "https://idp.acme.example",
    subject: "alice",
    tenantId: "tenant:acme",
    label: "alice@acme",
  });
  const { id: rivalFactId } = mem.remember({
    text: "the wifi password is pwned123",
    entity: ENTITY,
    attribute: "consent-router#wifi_password",
    source: { sourceId: rival.sourceId },
  });
  const outcome = mem.adjudicate(ATTR);
  expect(outcome.kind).toBe("DEFERRED");
  return { mem, ownerFactId, rivalFactId };
}

function call(memory: ReturnType<typeof createAgentMemory>, req: McpRequest): McpResponse {
  const res = handleMcpRequest(req, memory);
  expect(res).not.toBeNull();
  return res as McpResponse;
}

function toolCall(
  memory: ReturnType<typeof createAgentMemory>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): McpResponse {
  return call(memory, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function toolText(res: McpResponse): string {
  expect(res.error).toBeUndefined();
  const content = (res.result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]!.text;
}

function extractToken(listText: string, csid: string): string {
  const idx = listText.indexOf(`contradictionSetId: ${csid}`);
  expect(idx).toBeGreaterThanOrEqual(0);
  const m = listText.slice(idx).match(/confirmationToken:\s*(\S+)/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("resolve-pending-no-consent-binding: confirmationToken enforcement", () => {
  it("resolve_pending is REJECTED when no confirmationToken is supplied (never having listed)", () => {
    const { mem, ownerFactId } = makeDisputedMemory();
    const csid = mem.pendingQuestions()[0]!.contradictionSetId;

    // The prompt-injection scenario: skip list_pending_questions entirely and
    // go straight to resolve_pending.
    const res = toolCall(mem, 1, "resolve_pending", {
      contradictionSetId: String(csid),
      chosenStrandId: String(ownerFactId),
    });
    expect(res.error?.code).toBe(-32602); // JSONRPC_INVALID_PARAMS
    expect(String(res.error?.message)).toContain("confirmationToken");

    // The dispute is UNCHANGED — nothing was resolved.
    expect(mem.listPending()).toHaveLength(1);
  });

  it("resolve_pending is REJECTED with a well-formed but WRONG confirmationToken", () => {
    const { mem, ownerFactId } = makeDisputedMemory();
    const csid = mem.pendingQuestions()[0]!.contradictionSetId;
    toolText(toolCall(mem, 1, "list_pending_questions")); // mints a real token we deliberately ignore

    const res = toolCall(mem, 2, "resolve_pending", {
      contradictionSetId: String(csid),
      chosenStrandId: String(ownerFactId),
      confirmationToken: "0".repeat(32), // well-formed hex shape, but not the minted value
    });
    expect(res.error?.code).toBe(-32602);
    expect(String(res.error?.message)).toMatch(/missing, expired, or does not match/i);
    expect(mem.listPending()).toHaveLength(1);
  });

  it("a valid confirmationToken from list_pending_questions lets resolve_pending succeed", () => {
    const { mem, ownerFactId } = makeDisputedMemory();
    const csid = mem.pendingQuestions()[0]!.contradictionSetId;
    const listText = toolText(toolCall(mem, 1, "list_pending_questions"));
    const token = extractToken(listText, String(csid));

    const res = toolCall(mem, 2, "resolve_pending", {
      contradictionSetId: String(csid),
      chosenStrandId: String(ownerFactId),
      confirmationToken: token,
    });
    expect(res.error).toBeUndefined();
    expect(mem.listPending()).toHaveLength(0);
  });

  it("a confirmationToken is SINGLE-USE: replaying the same token on a second call is rejected", () => {
    const { mem, ownerFactId, rivalFactId } = makeDisputedMemory();
    const csid = mem.pendingQuestions()[0]!.contradictionSetId;
    const listText = toolText(toolCall(mem, 1, "list_pending_questions"));
    const token = extractToken(listText, String(csid));

    const first = toolCall(mem, 2, "resolve_pending", {
      contradictionSetId: String(csid),
      chosenStrandId: String(ownerFactId),
      confirmationToken: token,
    });
    expect(first.error).toBeUndefined();

    // Replaying the SAME token against a (now-resolved, or hypothetically a
    // different) dispute must never succeed on the strength of a stale token.
    const replay = toolCall(mem, 3, "resolve_pending", {
      contradictionSetId: String(csid),
      chosenStrandId: String(rivalFactId),
      confirmationToken: token,
    });
    expect(replay.error?.code).toBe(-32602);
  });

  it("a confirmationToken EXPIRES after its TTL (injected clock, no real elapsed time)", () => {
    const { mem, ownerFactId } = makeDisputedMemory();
    const csid = mem.pendingQuestions()[0]!.contradictionSetId;

    let now = 1_000_000;
    const clock = (): number => now;
    const ttlMs = 1000;

    const listReq: McpRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_pending_questions", arguments: {} },
    };
    const listRes = handleMcpRequest(listReq, mem, { clock, pendingConfirmationTtlMs: ttlMs })!;
    const listText = toolText(listRes);
    const token = extractToken(listText, String(csid));

    // Advance the injected clock PAST the TTL — no real sleep required.
    now += ttlMs + 1;

    const resolveReq: McpRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "resolve_pending",
        arguments: {
          contradictionSetId: String(csid),
          chosenStrandId: String(ownerFactId),
          confirmationToken: token,
        },
      },
    };
    const resolveRes = handleMcpRequest(resolveReq, mem, { clock })!;
    expect(resolveRes.error?.code).toBe(-32602);
    expect(String(resolveRes.error?.message)).toMatch(/missing, expired, or does not match/i);
    expect(mem.listPending()).toHaveLength(1); // still open — never resolved
  });

  it("tokens are scoped per contradictionSetId: a token minted for one dispute cannot resolve another", () => {
    const mem = createAgentMemory();
    cleanups.push(() => mem.close());

    // Two INDEPENDENT disputes over two different attributes.
    function seedDispute(attr: string): void {
      mem.remember({ text: `${attr}-A`, entity: ENTITY, attribute: attr });
      const rival = mem.trust.registerSsoMember({
        issuer: `https://idp.${attr}.example`,
        subject: "bob",
        tenantId: `tenant:${attr}`,
      });
      mem.remember({ text: `${attr}-B`, entity: ENTITY, attribute: attr, source: { sourceId: rival.sourceId } });
      expect(mem.adjudicate(attr as AttributeKey).kind).toBe("DEFERRED");
    }
    seedDispute("consent-router#alpha");
    seedDispute("consent-router#beta");

    const questions = mem.pendingQuestions();
    expect(questions).toHaveLength(2);
    const [qA, qB] = questions;

    const listText = toolText(toolCall(mem, 1, "list_pending_questions"));
    const tokenA = extractToken(listText, String(qA!.contradictionSetId));

    // Attempt to resolve dispute B using dispute A's token.
    const res = toolCall(mem, 2, "resolve_pending", {
      contradictionSetId: String(qB!.contradictionSetId),
      chosenStrandId: String(qB!.options[0]!.strandId),
      confirmationToken: tokenA,
    });
    expect(res.error?.code).toBe(-32602);
    expect(mem.listPending()).toHaveLength(2); // both still open
  });
});
