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
 */

import { describe, it, expect, afterEach } from "vitest";
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
    const { lowResp, ownerResp, ownerSock, lowSock } = await callAsBothGrades(harness, "disown", {
      sourceId: "src:daemon-trustgate-disown-target",
    });

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    expect(ownerResp.ok).toBe(false);
    expect(ownerResp.error.code).not.toBe(DAEMON_ERR_INSUFFICIENT_GRADE);
    expect(String(ownerResp.error.message)).toMatch(/reputation ledger/i);

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("approve: non-OWNER rejected with INSUFFICIENT_GRADE; OWNER call reaches the engine", async () => {
    harness = await setupServer();
    const { lowResp, ownerResp, ownerSock, lowSock } = await callAsBothGrades(harness, "approve", {
      contradictionSetId: "csid:daemon-trustgate-nonexistent",
      winnerStrandId: "strand:none",
    });

    expect(lowResp.ok).toBe(false);
    expect(lowResp.error.code).toBe(DAEMON_ERR_INSUFFICIENT_GRADE);

    expect(ownerResp.ok).toBe(false);
    expect(ownerResp.error.code).not.toBe(DAEMON_ERR_INSUFFICIENT_GRADE);
    expect(String(ownerResp.error.message)).toMatch(/no open dispute/i);

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
