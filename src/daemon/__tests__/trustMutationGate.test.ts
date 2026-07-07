/**
 * daemon/__tests__/trustMutationGate.test.ts — regression coverage for
 * `daemon-unauthorized-trust-mutation` (PRODUCTION_READINESS_ASSESSMENT.md,
 * CONFIRMED critical): before this fix, `server.ts`'s MEMORY_METHODS dispatched
 * `registerSource`/`disown`/`approve`/`adjudicate`/`ratify` to ANY authenticated
 * connection regardless of `state.grade` — only the four unrelated admin verbs
 * (`issueToken`/`revokeToken`/`revokeAllTokens`/`reloadTokens`) were gated. Any
 * minted, even EMAIL_OAUTH-grade, daemon token could mint itself an OWNER-grade
 * anchor via `registerSource`, or disown/approve/adjudicate/ratify arbitrary
 * sources/strands — defeating the entire trust model from OUTSIDE the engine.
 *
 * These tests exercise the REAL `DaemonServer` over a REAL `node:net` socket
 * (the exact production code path a hostile client would use), asserting:
 *   (1) all five trust-mutating verbs reject a non-OWNER-grade connection with
 *       the typed `INSUFFICIENT_GRADE` error, BEFORE ever reaching the engine;
 *   (2) an OWNER-grade connection is unaffected by the new gate;
 *   (3) `registerSource`'s caller-supplied anchor bindings are validated
 *       against `ANCHOR_TABLE`'s ceilings — a forged high-weight anchor riding
 *       a cheap class name is rejected (`INVALID_ANCHOR`), even from OWNER.
 *
 * ALSO covers the `resolvePending-trust-bypass` follow-up fix (a hostile
 * re-audit finding, 2026-07-07): the FIRST pass above gated exactly five verbs
 * and missed the sixth, `resolvePending` — dispatched through the identical
 * `#dispatchMemoryCall` path but carrying PERSONAL-tier owner-OVERRIDE
 * semantics (`agent/agentMemory.ts`'s facade calls `engine.approve(...,
 * { allowAuthorApprover: true })` unconditionally), so ANY authenticated
 * connection at ANY grade could force-resolve any open dispute with
 * owner-override power, and the resulting ledger record always misattributed
 * the decision to the facade's singleton OWNER identity regardless of who
 * actually called. See the "resolvePending" describe block below: (1) a
 * non-OWNER-grade connection is rejected with `INSUFFICIENT_GRADE` and the
 * dispute is left OPEN and untouched; (2) an OWNER-grade connection still
 * succeeds and the resulting APPROVAL record is attributed to the real
 * `memory.defaultSourceId` — not a forged, caller-controlled, or otherwise
 * hardcoded id (there is no `approver` field on `resolvePending`'s wire
 * params at all, so gating the verb to OWNER-grade is what makes this
 * attribution trustworthy).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnchorClass } from "../../core/types.js";
import { createAgentMemory } from "../../agent/agentMemory.js";
import type { AgentMemory } from "../../agent/agentMemory.js";

import { createTokenStore, readOwnerTokenFile } from "../tokens.js";
import type { TokenStore } from "../tokens.js";
import { createDaemonAuditChain } from "../auditChain.js";
import type { DaemonAuditChain } from "../auditChain.js";
import { DaemonServer } from "../server.js";
import type { DaemonServerOptions } from "../server.js";
import { DAEMON_ERR_INSUFFICIENT_GRADE, DAEMON_ERR_INVALID_ANCHOR } from "../protocol.js";

// ---------------------------------------------------------------------------
// Test harness (mirrors daemon/__tests__/server.test.ts's harness exactly, so
// this suite exercises the identical production wiring).
// ---------------------------------------------------------------------------

let baseCounter = 0;
function nextBase(): string {
  baseCounter += 1;
  return `iddb-daemon-trustgate-${process.pid}-${baseCounter}`;
}

interface Harness {
  readonly server: DaemonServer;
  readonly endpoint: string;
  readonly dataDir: string;
  readonly tokens: TokenStore;
  readonly auditChain: DaemonAuditChain;
  readonly memory: AgentMemory;
}

async function setupServer(
  overrides: Partial<Pick<DaemonServerOptions, "maxConnections" | "maxQueueDepth">> = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "iddb-daemon-trustgate-"));
  const memory = createAgentMemory({});
  const tokens = createTokenStore(dataDir);
  const auditChain = createDaemonAuditChain();
  const server = new DaemonServer({
    memory,
    tokens,
    auditChain,
    trustRegistry: memory.trust,
    endpointBase: nextBase(),
    handshakeTimeoutMs: 300,
    authFailureDelayMs: 30,
    ...overrides,
  });
  const { endpoint } = await server.start();
  return { server, endpoint, dataDir, tokens, auditChain, memory };
}

function connect(endpoint: string): net.Socket {
  return net.createConnection(endpoint);
}

class LineReader {
  #buf = "";
  #queue: string[] = [];
  #waiters: Array<(line: string) => void> = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.#buf.indexOf("\n")) !== -1) {
        const line = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + 1);
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(line);
        else this.#queue.push(line);
      }
    });
  }

  next(timeoutMs = 3000): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("LineReader.next timed out")), timeoutMs);
      this.#waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async nextJson(timeoutMs?: number): Promise<any> {
    return JSON.parse(await this.next(timeoutMs));
  }
}

/**
 * raw-error-message-passthrough fix companion: the CLIENT-facing message for
 * an unrecognized internal error is now a fixed generic string (never the raw
 * engine message) — see `server.ts`'s `safeErrorMessage`. The real message
 * still reaches an operator via the structured `daemonLog` stderr line this
 * lane's `zero-structured-logging` fix added (`event: "memory_call_failed"`).
 * This helper captures those JSON lines during `fn()` so a test can assert on
 * the REAL underlying error without requiring it to leak to the wire.
 */
async function captureDaemonLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: unknown[] }> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await fn();
    const lines = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.trim().length > 0)
      .map((s) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          return null;
        }
      })
      .filter((v): v is unknown => v !== null);
    return { result, lines };
  } finally {
    spy.mockRestore();
  }
}

let harness: Harness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.server.stop({ clean: true });
    harness.memory.close();
    rmSync(harness.dataDir, { recursive: true, force: true });
    harness = null;
  }
});

// ---------------------------------------------------------------------------
// Shared two-connection helper: authenticate an OWNER connection and a fresh
// low-grade (EMAIL_OAUTH) connection, fire the SAME method+params on each.
// ---------------------------------------------------------------------------

interface GateResult {
  readonly lowResp: any;
  readonly ownerResp: any;
  readonly ownerSock: net.Socket;
  readonly lowSock: net.Socket;
}

async function callAsBothGrades(h: Harness, method: string, params: unknown): Promise<GateResult> {
  const owner = readOwnerTokenFile(h.dataDir)!;
  const lowGrade = h.tokens.mint(AnchorClass.EMAIL_OAUTH, `agent-low-${method}`);

  const ownerSock = connect(h.endpoint);
  const ownerReader = new LineReader(ownerSock);
  ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
  await ownerReader.nextJson();

  const lowSock = connect(h.endpoint);
  const lowReader = new LineReader(lowSock);
  lowSock.write(JSON.stringify({ method: "auth", token: lowGrade.raw }) + "\n");
  await lowReader.nextJson();

  lowSock.write(JSON.stringify({ id: 1, method, params }) + "\n");
  const lowResp = await lowReader.nextJson();

  ownerSock.write(JSON.stringify({ id: 1, method, params }) + "\n");
  const ownerResp = await ownerReader.nextJson();

  return { lowResp, ownerResp, ownerSock, lowSock };
}

// ---------------------------------------------------------------------------
// The 5 trust-mutating verbs
// ---------------------------------------------------------------------------

describe("DaemonServer: trust-mutating verb authorization (daemon-unauthorized-trust-mutation)", () => {
  it("registerSource: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER succeeds", async () => {
    harness = await setupServer();
    const { lowResp, ownerResp, ownerSock, lowSock } = await callAsBothGrades(harness, "registerSource", {
      source: { sourceId: "src:daemon-trustgate-register-1", kind: "AGENT", label: "t" },
    });

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    expect(ownerResp.ok).toBe(true);
    expect(ownerResp.result.source_id).toBe("src:daemon-trustgate-register-1");

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("adjudicate: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER succeeds", async () => {
    harness = await setupServer();
    const { lowResp, ownerResp, ownerSock, lowSock } = await callAsBothGrades(harness, "adjudicate", {
      attribute: "daemon-trustgate-attr-nonexistent",
    });

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    // A never-disputed attribute genuinely NOOPs — proves the OWNER call
    // reached the real engine, not merely "didn't get blocked".
    expect(ownerResp.ok).toBe(true);
    expect(ownerResp.result.kind).toBe("NOOP");

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("ratify: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER succeeds (echo-ratifies its own remembered fact)", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const ownerSock = connect(harness.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    ownerSock.write(
      JSON.stringify({ id: 1, method: "remember", params: { text: "ratify-gate probe fact." } }) + "\n",
    );
    const remembered = await ownerReader.nextJson();
    expect(remembered.ok).toBe(true);
    const strandId = remembered.result.id as string;

    const lowGrade = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-low-ratify");
    const lowSock = connect(harness.endpoint);
    const lowReader = new LineReader(lowSock);
    lowSock.write(JSON.stringify({ method: "auth", token: lowGrade.raw }) + "\n");
    await lowReader.nextJson();

    lowSock.write(JSON.stringify({ id: 2, method: "ratify", params: { strandId } }) + "\n");
    const lowResp = await lowReader.nextJson();
    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    ownerSock.write(JSON.stringify({ id: 2, method: "ratify", params: { strandId } }) + "\n");
    const ownerResp = await ownerReader.nextJson();
    expect(ownerResp.ok).toBe(true);

    ownerSock.destroy();
    lowSock.destroy();
  });

  // `disown` and `approve` both throw a BUSINESS-LOGIC error under the plain
  // single-agent facade used by this harness (`createAgentMemory({})` wires no
  // reputation ledger / has no open dispute) REGARDLESS of caller — that is
  // orthogonal, pre-existing behavior, not something this fix changes. What
  // these two cases prove is the precise thing the fix changes: the low-grade
  // call is rejected BEFORE it ever reaches `memory.disown`/`memory.approve`
  // (a DIFFERENT, typed authorization error), while the OWNER call DOES reach
  // them (a business-logic error, never `INSUFFICIENT_GRADE`).

  it("disown: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER call reaches the engine", async () => {
    harness = await setupServer();
    // raw-error-message-passthrough fix: the CLIENT no longer sees the raw
    // engine message (it is not an allow-listed typed error) — proof that the
    // OWNER call genuinely reached `memory.disown` (a business-logic error,
    // never INSUFFICIENT_GRADE) now comes from the structured `daemonLog` line
    // this lane's zero-structured-logging fix emits alongside the sanitized
    // client response.
    const { result, lines } = await captureDaemonLogs(() =>
      callAsBothGrades(harness!, "disown", { sourceId: "src:daemon-trustgate-disown-target" }),
    );
    const { lowResp, ownerResp, ownerSock, lowSock } = result;

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    expect(ownerResp.ok).toBe(false);
    expect(ownerResp.error.code).not.toBe(DAEMON_ERR_INSUFFICIENT_GRADE);
    expect(String(ownerResp.error.message)).not.toMatch(/reputation ledger/i);

    const failedLog = lines.find(
      (l) => (l as { event?: string }).event === "memory_call_failed",
    ) as { method?: string; message?: string } | undefined;
    expect(failedLog).toBeDefined();
    expect(failedLog!.method).toBe("disown");
    expect(failedLog!.message).toMatch(/reputation ledger/i);

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("approve: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER call reaches the engine", async () => {
    harness = await setupServer();
    const { result, lines } = await captureDaemonLogs(() =>
      callAsBothGrades(harness!, "approve", {
        contradictionSetId: "csid:daemon-trustgate-nonexistent",
        winnerStrandId: "strand:none",
      }),
    );
    const { lowResp, ownerResp, ownerSock, lowSock } = result;

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    expect(ownerResp.ok).toBe(false);
    expect(ownerResp.error.code).not.toBe(DAEMON_ERR_INSUFFICIENT_GRADE);
    expect(String(ownerResp.error.message)).not.toMatch(/no open dispute/i);

    const failedLog = lines.find(
      (l) => (l as { event?: string }).event === "memory_call_failed",
    ) as { method?: string; message?: string } | undefined;
    expect(failedLog).toBeDefined();
    expect(failedLog!.method).toBe("approve");
    expect(failedLog!.message).toMatch(/no open dispute/i);

    ownerSock.destroy();
    lowSock.destroy();
  });
});

// ---------------------------------------------------------------------------
// registerSource anchor-ceiling validation (2nd half of the same finding)
// ---------------------------------------------------------------------------

describe("DaemonServer: registerSource anchor-ceiling validation", () => {
  it("a forged anchor binding above its class's ANCHOR_TABLE ceiling is rejected, even from OWNER", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const ownerSock = connect(harness.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    // The exact forgery the audit demonstrated: a cheap class (BARE_KEY,
    // ANCHOR_TABLE ceiling 0.0) claiming OWNER-strength (1.0) weight.
    ownerSock.write(
      JSON.stringify({
        id: 1,
        method: "registerSource",
        params: {
          source: { sourceId: "src:daemon-trustgate-forged-anchor", kind: "AGENT", label: "attacker" },
          anchors: [{ anchorClass: "BARE_KEY", independenceWeight: 1, realizedCost: 1 }],
        },
      }) + "\n",
    );
    const resp = await ownerReader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe(DAEMON_ERR_INVALID_ANCHOR);

    // The forged anchor never landed on the target source.
    ownerSock.write(
      JSON.stringify({ id: 2, method: "stampFor", params: "src:daemon-trustgate-forged-anchor" }) + "\n",
    );
    const stamp = await ownerReader.nextJson();
    expect(stamp.ok).toBe(true);
    expect(stamp.result.anchor_set).toEqual([]);

    ownerSock.destroy();
  });

  it("an unknown anchorClass is rejected", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const ownerSock = connect(harness.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    ownerSock.write(
      JSON.stringify({
        id: 1,
        method: "registerSource",
        params: {
          source: { sourceId: "src:daemon-trustgate-bad-class", kind: "AGENT", label: "attacker" },
          anchors: [{ anchorClass: "NOT_A_REAL_CLASS", independenceWeight: 0.01, realizedCost: 0.01 }],
        },
      }) + "\n",
    );
    const resp = await ownerReader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe(DAEMON_ERR_INVALID_ANCHOR);

    ownerSock.destroy();
  });

  it("an anchor binding at/under its class's ceiling is accepted", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const ownerSock = connect(harness.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    ownerSock.write(
      JSON.stringify({
        id: 1,
        method: "registerSource",
        params: {
          source: { sourceId: "src:daemon-trustgate-legit-anchor", kind: "AGENT", label: "legit" },
          anchors: [{ anchorClass: "EMAIL_OAUTH", independenceWeight: 0.1, realizedCost: 0.1 }],
        },
      }) + "\n",
    );
    const resp = await ownerReader.nextJson();
    expect(resp.ok).toBe(true);
    expect(resp.result.anchor_set).toEqual([{ anchorClass: "EMAIL_OAUTH", independenceWeight: 0.1, realizedCost: 0.1 }]);

    ownerSock.destroy();
  });
});

// ---------------------------------------------------------------------------
// resolvePending-trust-bypass fix — the sixth trust-mutating verb the first
// pass of this gate missed (see the module doc above).
// ---------------------------------------------------------------------------

describe("DaemonServer: resolvePending authorization (resolvePending-trust-bypass fix)", () => {
  /**
   * Forms a REAL, genuine multi-class dispute exactly the way
   * `daemon/__e2e__/mcpDaemonBacked.e2e.test.ts` does: an OWNER-grade
   * connection and an independent EMAIL_OAUTH-grade connection each `remember`
   * a conflicting fact about the SAME (entity, attribute); an OWNER-grade
   * `adjudicate` call then defers it (both anchors clear the default
   * quarantine threshold — 0.10 — so both land LIVE, and distinct daemon-token
   * sourceIds are independent by default, H2/R1). Returns everything a test
   * needs to drive `resolvePending` against the real open dispute.
   */
  async function formGenuineDispute(h: Harness): Promise<{
    csid: string;
    ownerStrandId: string;
    rivalStrandId: string;
    ownerSock: net.Socket;
    ownerReader: LineReader;
  }> {
    const owner = readOwnerTokenFile(h.dataDir)!;
    const ownerSock = connect(h.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    const ATTR = "resolve-pending-gate#wifi_password";
    ownerSock.write(
      JSON.stringify({
        id: 1,
        method: "remember",
        params: { text: "the wifi password is hunter2", entity: "entity:resolve-pending-gate", attribute: ATTR },
      }) + "\n",
    );
    const ownerRemembered = await ownerReader.nextJson();
    expect(ownerRemembered.ok).toBe(true);
    const ownerStrandId = ownerRemembered.result.id as string;

    const rivalGrade = h.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-resolve-pending-rival");
    const rivalSock = connect(h.endpoint);
    const rivalReader = new LineReader(rivalSock);
    rivalSock.write(JSON.stringify({ method: "auth", token: rivalGrade.raw }) + "\n");
    await rivalReader.nextJson();

    rivalSock.write(
      JSON.stringify({
        id: 1,
        method: "remember",
        params: { text: "the wifi password is pwned123", entity: "entity:resolve-pending-gate", attribute: ATTR },
      }) + "\n",
    );
    const rivalRemembered = await rivalReader.nextJson();
    expect(rivalRemembered.ok).toBe(true);
    const rivalStrandId = rivalRemembered.result.id as string;
    rivalSock.destroy();

    ownerSock.write(JSON.stringify({ id: 2, method: "adjudicate", params: { attribute: ATTR } }) + "\n");
    const adjudicated = await ownerReader.nextJson();
    expect(adjudicated.ok).toBe(true);
    expect(adjudicated.result.kind).toBe("DEFERRED");

    ownerSock.write(JSON.stringify({ id: 3, method: "pendingQuestions", params: {} }) + "\n");
    const questions = await ownerReader.nextJson();
    expect(questions.ok).toBe(true);
    expect(questions.result.length).toBeGreaterThanOrEqual(1);
    const csid = questions.result[0].contradictionSetId as string;

    return { csid, ownerStrandId, rivalStrandId, ownerSock, ownerReader };
  }

  it("a non-OWNER-grade connection calling resolvePending is REJECTED with INSUFFICIENT_GRADE, and the dispute is left OPEN", async () => {
    harness = await setupServer();
    const { csid, ownerStrandId, ownerSock, ownerReader } = await formGenuineDispute(harness);

    const lowGrade = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-resolve-pending-attacker");
    const lowSock = connect(harness.endpoint);
    const lowReader = new LineReader(lowSock);
    lowSock.write(JSON.stringify({ method: "auth", token: lowGrade.raw }) + "\n");
    await lowReader.nextJson();

    lowSock.write(
      JSON.stringify({
        id: 10,
        method: "resolvePending",
        params: { contradictionSetId: csid, chosenStrandId: ownerStrandId },
      }) + "\n",
    );
    const resp = await lowReader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    // The dispute is UNCHANGED by the rejected attempt — still open, still
    // answerable, never force-resolved by the low-grade caller.
    ownerSock.write(JSON.stringify({ id: 11, method: "pendingQuestions", params: {} }) + "\n");
    const stillOpen = await ownerReader.nextJson();
    expect(stillOpen.ok).toBe(true);
    expect(stillOpen.result.some((q: { contradictionSetId: string }) => q.contradictionSetId === csid)).toBe(true);

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("an OWNER-grade connection calling resolvePending SUCCEEDS, and the resulting APPROVAL record is attributed to the real memory.defaultSourceId — not a forged/hardcoded one", async () => {
    harness = await setupServer();
    const { csid, ownerStrandId, rivalStrandId, ownerSock, ownerReader } = await formGenuineDispute(harness);

    ownerSock.write(
      JSON.stringify({
        id: 20,
        method: "resolvePending",
        params: { contradictionSetId: csid, chosenStrandId: ownerStrandId },
      }) + "\n",
    );
    const resolved = await ownerReader.nextJson();
    expect(resolved.ok).toBe(true);
    expect(resolved.result.winner).toBe(ownerStrandId);

    // The horn is quiet again over the same connection.
    ownerSock.write(JSON.stringify({ id: 21, method: "pendingQuestions", params: {} }) + "\n");
    const afterward = await ownerReader.nextJson();
    expect(afterward.ok).toBe(true);
    expect(afterward.result.some((q: { contradictionSetId: string }) => q.contradictionSetId === csid)).toBe(false);

    // Real attribution proof: read the loser's dossier (explain is read-only,
    // never gated) and confirm the RESOLVED_BY_APPROVAL entry names the
    // engine's own `defaultSourceId` as approver — the real identity the
    // OWNER-grade gate now guarantees, never a value the wire request could
    // have forged (resolvePending's params carry no approver field at all).
    ownerSock.write(JSON.stringify({ id: 22, method: "explain", params: { target: rivalStrandId } }) + "\n");
    const dossier = await ownerReader.nextJson();
    expect(dossier.ok).toBe(true);
    const approval = dossier.result.disputes.find(
      (d: { status: string }) => d.status === "RESOLVED_BY_APPROVAL",
    );
    expect(approval).toBeDefined();
    expect(approval.approverSourceId).toBe(String(harness.memory.defaultSourceId));
    expect(approval.ownerOverride).toBe(true);

    ownerSock.destroy();
  });
});
