/**
 * daemon/__e2e__/mcpDaemonBacked.e2e.test.ts — PHASE3B_MCP_ASYNC_SPEC.md Tests
 * #2, THE HEADLINE PROOF: a REAL daemon process (spawned child, real
 * socket/named pipe), a REAL MCP stdio server process (`dist/mcp/server.js`,
 * the ACTUAL shipped `intelligent-db-mcp` bin) pointed at it via
 * `MEMORY_DAEMON_SOCKET`/`MEMORY_DAEMON_TOKEN_FILE`, driven over its REAL
 * stdio JSON-RPC protocol — not the in-process `handleMcpRequestAsync` called
 * directly, and not a mock of any of it.
 *
 * The full script this file drives:
 *   1. remember (over MCP, over the daemon) a fact.
 *   2. recall it back — correct citation + fact_state, rendered over the wire.
 *   3. Form a genuine multi-class dispute (a second identity, via a second
 *      real daemon token, contradicts the first over the SAME attribute) —
 *      resolved through adjudicate() on a raw OWNER-grade admin connection
 *      (adjudicate is a trust-mutating verb, deliberately NOT reachable from
 *      the MCP tool surface — see mcp/handler.ts's TOOLS list).
 *   4. list_pending_questions (over MCP) renders the dispute WITH a
 *      confirmation token.
 *   5. resolve_pending WITHOUT the token is REJECTED (never reaches the
 *      daemon: the Wave-2 consent binding is enforced CLIENT-SIDE, inside the
 *      MCP server process, before any wire call); WITH the token it SUCCEEDS.
 *   6. A SECOND, INDEPENDENT MCP server process (its own daemon connection,
 *      its own identity) sees the resolved fact — proving shared daemon
 *      memory, not two private in-process stores.
 *
 * This is deliberately heavier than `mcp/asyncHandlerParity.test.ts` (which
 * drives the same handler in-process, fast, over `syncToAsyncMemory`): this
 * lane exists to catch anything that ONLY manifests across the real process
 * boundary + real transport (the async transport's line-by-line serialization
 * in `mcp/server.ts`'s `main()`, the daemon's own wire dispatch, real stdio
 * buffering) — mirroring why `daemon/__e2e__/securityMatrix.e2e.test.ts` is a
 * separate, heavier lane from `daemon/__tests__/server.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureDaemonBuilt,
  spawnDaemon,
  removeDataDir,
  spawnMcpServer,
  mintTokenViaAdmin,
} from "./support.js";
import type { DaemonProcessHandle, McpProcessHandle } from "./support.js";
import { createRemoteAgentMemory } from "../client.js";
import type { RemoteAgentMemory } from "../client.js";
import type { AttributeKey } from "../../core/types.js";

beforeAll(() => {
  ensureDaemonBuilt();
}, 180_000);

interface ToolCallResult {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly result?: { content: Array<{ type: string; text: string }> };
  readonly error?: { code: number; message: string };
}

async function toolCall(
  mcp: McpProcessHandle,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  return mcp.request({ id, method: "tools/call", params: { name, arguments: args } }) as Promise<ToolCallResult>;
}

function toolText(res: ToolCallResult): string {
  expect(res.error).toBeUndefined();
  return res.result!.content[0]!.text;
}

function extractConfirmationToken(listText: string, csid: string): string {
  const idx = listText.indexOf(`contradictionSetId: ${csid}`);
  expect(idx).toBeGreaterThanOrEqual(0);
  const m = listText.slice(idx).match(/confirmationToken:\s*(\S+)/);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("E2E: MCP server (real stdio) backed by a real daemon (real socket/pipe)", () => {
  let daemon: DaemonProcessHandle;
  let mcp1: McpProcessHandle;
  let mcp2: McpProcessHandle;
  let admin: RemoteAgentMemory;

  const ENTITY = "entity:mcp-e2e-router";
  const ATTR = "mcp-e2e-router#wifi_password";

  beforeAll(async () => {
    daemon = await spawnDaemon();
  }, 20_000);

  afterAll(async () => {
    if (admin !== undefined) await admin.close();
    if (mcp1 !== undefined) await mcp1.stop();
    if (mcp2 !== undefined) await mcp2.stop();
    if (daemon !== undefined) {
      await daemon.stop();
      removeDataDir(daemon.dataDir);
    }
  });

  it("remember -> recall (citation + fact_state over the wire)", async () => {
    mcp1 = spawnMcpServer({ daemon: { socketPath: daemon.endpoint, token: daemon.owner.token } });

    // initialize: proves the real stdio JSON-RPC protocol handshake works
    // end-to-end through the daemon-backed async dispatch, not just in-process.
    const init = await mcp1.request({ id: 1, method: "initialize" });
    expect(init.error).toBeUndefined();
    expect(init.result.serverInfo.name).toBe("intelligent-db");

    const remembered = await toolCall(mcp1, 2, "remember", {
      text: "the wifi password is hunter2",
      entity: ENTITY,
      attribute: ATTR,
    });
    expect(toolText(remembered)).toContain("Remembered fact");

    const recalled = await toolCall(mcp1, 3, "recall", { query: "what is the wifi password?" });
    const recallText = toolText(recalled);
    // Correct citation (the daemon-bound OWNER identity, over the wire) +
    // fact_state: OWNER-grade filing clears quarantine, so this reads LIVE
    // (unlabeled — the label only appears for a non-LIVE state).
    expect(recallText).toContain("hunter2");
    expect(recallText).toContain("source ");
    expect(recallText).not.toContain("[PROVISIONAL]");
    expect(recallText).not.toContain("[DEMOTED]");
  }, 20_000);

  it("a second identity contradicts it -> a genuine dispute forms (adjudicate over a raw OWNER admin connection, NOT the MCP surface)", async () => {
    // A second, INDEPENDENT identity: a fresh EMAIL_OAUTH-grade token, its own
    // independence class by default (H2/R1 — distinct tokens never
    // automatically trust each other). Filed through a SECOND, independent MCP
    // server process — this doubles as the "second MCP client" this test's
    // final assertion needs.
    const secondToken = await mintTokenViaAdmin(
      daemon.endpoint,
      daemon.owner.token,
      "EMAIL_OAUTH",
      "mcp-e2e-second-agent",
    );
    mcp2 = spawnMcpServer({ daemon: { socketPath: daemon.endpoint, token: secondToken } });

    const contradicted = await toolCall(mcp2, 1, "remember", {
      text: "the wifi password is pwned123",
      entity: ENTITY,
      attribute: ATTR,
    });
    expect(toolText(contradicted)).toContain("Remembered fact");

    // adjudicate() is a trust-mutating verb — deliberately NOT one of the five
    // tools the MCP surface exposes (mcp/handler.ts's TOOLS list), so it is
    // driven here over a raw OWNER-grade RemoteAgentMemory connection, exactly
    // as a deployment's own maintenance process would (never through either
    // MCP client — proving the OWNER-gate on trust-mutating verbs is untouched
    // by this lane's wiring).
    admin = createRemoteAgentMemory({ socketPath: daemon.endpoint, token: daemon.owner.token });
    await admin.getDefaultSourceId();
    const outcome = await admin.adjudicate(ATTR as AttributeKey);
    expect(outcome.kind).toBe("DEFERRED");
  }, 20_000);

  it("list_pending_questions returns the dispute WITH a confirmation token; resolve_pending without it is REJECTED, with it SUCCEEDS", async () => {
    const listed = await toolCall(mcp1, 4, "list_pending_questions");
    const listText = toolText(listed);
    expect(listText).toContain("disagree about");
    expect(listText).toContain("hunter2");
    expect(listText).toContain("pwned123");
    expect(listText).toContain("confirmationToken");

    const csidMatch = listText.match(/contradictionSetId:\s*(\S+)/);
    expect(csidMatch).not.toBeNull();
    const csid = csidMatch![1]!;
    const strandIdLines = listText
      .split("\n")
      .filter((l) => l.trimStart().startsWith("strandId:"))
      .map((l) => l.trim().replace(/^strandId:\s*/, ""));
    expect(strandIdLines.length).toBeGreaterThanOrEqual(2);
    const chosenStrandId = strandIdLines[0]!;

    // WITHOUT the confirmation token: rejected LOCALLY, client-side, inside
    // the MCP server process — the Wave-2 consent binding, preserved verbatim
    // for the daemon-backed path (never a wire call to the daemon at all for
    // this rejected attempt).
    const rejected = await toolCall(mcp1, 5, "resolve_pending", {
      contradictionSetId: csid,
      chosenStrandId,
    });
    expect(rejected.error).toBeDefined();
    expect(rejected.error!.message).toContain("confirmationToken");

    // The dispute is UNCHANGED by the rejected attempt. Re-listing re-mints a
    // FRESH token for this still-open csid (single-use tokens re-mint on every
    // listing — see mcp/handler.ts's mintConfirmationToken) — that is the
    // valid one to use below, not the one extracted from the first listing.
    const stillListed = toolText(await toolCall(mcp1, 6, "list_pending_questions"));
    expect(stillListed).toContain("disagree about");

    // WITH the token THIS listing minted: succeeds, over the real wire,
    // through the real daemon.
    const token = extractConfirmationToken(stillListed, csid);
    const resolved = await toolCall(mcp1, 7, "resolve_pending", {
      contradictionSetId: csid,
      chosenStrandId,
      confirmationToken: token,
    });
    expect(toolText(resolved)).toContain(`Resolved dispute ${csid}`);

    // The horn is quiet again, over the SAME connection that just resolved it.
    const quiet = toolText(await toolCall(mcp1, 8, "list_pending_questions"));
    expect(quiet).toContain("No pending questions");
  }, 20_000);

  it("a SECOND MCP client (its own process, its own daemon connection, its own identity) sees the resolved fact: shared daemon memory, not two private stores", async () => {
    const recalledByOther = await toolCall(mcp2, 2, "recall", { query: "what is the wifi password?" });
    const text = toolText(recalledByOther);
    // mcp2 never remembered the WINNING fact itself (mcp1 did, before mcp2
    // even connected) — seeing it here is only possible if both MCP server
    // processes are reading the SAME daemon-backed memory.
    expect(text).toContain("hunter2");
  }, 20_000);
});
