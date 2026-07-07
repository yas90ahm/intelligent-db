/**
 * daemon/__tests__/server.test.ts — DaemonServer integration tests over REAL
 * `node:net` connections: the H1 handshake matrix, admin-verb authorization
 * (R3), and the connection cap (R5/H6). Windows named-pipe path (R9) is
 * exercised directly (this machine is Windows); the POSIX socket-file path is
 * written per spec and gated behind `process.platform` (see `server.ts`'s
 * `recoverStaleSocket`), not exercised here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnchorClass } from "../../core/types.js";
import { createAgentMemory } from "../../agent/agentMemory.js";
import type { AgentMemory } from "../../agent/agentMemory.js";

import { createTokenStore, readOwnerTokenFile, fingerprintToken } from "../tokens.js";
import type { TokenStore } from "../tokens.js";
import { createDaemonAuditChain } from "../auditChain.js";
import type { DaemonAuditChain } from "../auditChain.js";
import { DaemonServer } from "../server.js";
import type { DaemonServerOptions } from "../server.js";
import { MAX_LINE_BYTES, DAEMON_ERR_ADMIN_FORBIDDEN, DAEMON_ERR_CONNECTION_CAP } from "../protocol.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let baseCounter = 0;
function nextBase(): string {
  baseCounter += 1;
  return `iddb-daemon-test-${process.pid}-${baseCounter}`;
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
  overrides: Partial<
    Pick<
      DaemonServerOptions,
      "maxConnections" | "maxQueueDepth" | "maxPendingHandshakes" | "factChainHead" | "verifyFactChain"
    >
  > = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "iddb-daemon-srv-"));
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

function waitClose(socket: net.Socket, timeoutMs = 3000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitClose timed out")), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
// H1 — handshake matrix
// ---------------------------------------------------------------------------

describe("DaemonServer: H1 handshake matrix", () => {
  it("malformed JSON as the first line -> dropped after the fixed delay, audited", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    socket.write("this is not json\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    expect(typeof resp.error).toBe("string");
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    expect(failures.length).toBe(1);
    expect((failures[0]!.payload as { reason: string }).reason).toBe("MALFORMED");
  });

  it("a first line that is valid JSON but not an auth method -> WRONG_FIRST_METHOD, dropped", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    socket.write(JSON.stringify({ id: 1, method: "ping" }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    expect((failures[0]!.payload as { reason: string }).reason).toBe("WRONG_FIRST_METHOD");
  });

  it("auth method with a missing token -> WRONG_FIRST_METHOD, dropped", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    socket.write(JSON.stringify({ method: "auth" }) + "\n");
    await reader.nextJson();
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    expect((failures[0]!.payload as { reason: string }).reason).toBe("WRONG_FIRST_METHOD");
  });

  it("an unknown/revoked token -> UNKNOWN_OR_REVOKED_TOKEN, dropped, fingerprint audited (never raw)", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    const badToken = "f".repeat(64);
    socket.write(JSON.stringify({ method: "auth", token: badToken }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    const payload = failures[0]!.payload as { reason: string; fingerprint?: string };
    expect(payload.reason).toBe("UNKNOWN_OR_REVOKED_TOKEN");
    expect(payload.fingerprint).toBe(fingerprintToken(badToken));
    // R3: never the raw token itself anywhere in the audited record.
    expect(JSON.stringify(failures[0])).not.toContain(badToken);
  });

  it("an oversized first line -> OVERSIZED_LINE, dropped (reuses BoundedLineSplitter's limit)", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    // No trailing newline needed: BoundedLineSplitter flags overflow as soon as
    // the buffered, incomplete line crosses MAX_LINE_BYTES.
    socket.write("x".repeat(MAX_LINE_BYTES + 1024));
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    expect((failures[0]!.payload as { reason: string }).reason).toBe("OVERSIZED_LINE");
  });

  it("5s (here: configured short) handshake silence -> TIMEOUT, dropped, audited", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);
    // Send nothing.
    const resp = await reader.nextJson(3000);
    expect(resp.ok).toBe(false);
    await waitClose(socket);

    const failures = harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE");
    expect((failures[0]!.payload as { reason: string }).reason).toBe("TIMEOUT");
  });

  it("a valid token -> handshake succeeds, CONNECTION_ACCEPTED audited with requestId when supplied, connection stays open", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);

    socket.write(JSON.stringify({ method: "auth", token: owner.token, requestId: "req-1" }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(typeof resp.defaultSourceId).toBe("string");

    const accepted = harness.auditChain.records().find((r) => r.kind === "CONNECTION_ACCEPTED");
    expect(accepted).toBeDefined();
    const payload = accepted!.payload as { fingerprint: string; sourceId: string; requestId?: string };
    expect(payload.fingerprint).toBe(fingerprintToken(owner.token));
    expect(payload.requestId).toBe("req-1");
    expect(JSON.stringify(accepted)).not.toContain(owner.token); // fingerprint-never-raw

    // The connection survives and serves a real request (recall on empty memory).
    // Per daemon/protocol.ts's shared wire contract, `recall`'s params is the
    // cue itself (a plain string), matching daemon/client.ts's `call("recall", cue, ...)`.
    socket.write(JSON.stringify({ id: 7, method: "recall", params: "anything" }) + "\n");
    const recallResp = await reader.nextJson();
    expect(recallResp.id).toBe(7);
    expect(recallResp.ok).toBe(true);
    expect(recallResp.result.facts).toEqual([]);

    socket.destroy();
  });

  it("one failed attempt is never retried on the same connection", async () => {
    harness = await setupServer();
    const socket = connect(harness.endpoint);
    const reader = new LineReader(socket);
    socket.write("bad\n");
    await reader.nextJson();
    // A second line sent right after (before the socket fully closes) must not
    // resurrect the handshake — the connection is already being torn down.
    socket.write(JSON.stringify({ method: "auth", token: "x".repeat(64) }) + "\n");
    await waitClose(socket);
    // Only ONE auth failure was ever audited for this connection.
    expect(harness.auditChain.records().filter((r) => r.kind === "AUTH_FAILURE").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R3 — admin verbs, OWNER-grade only
// ---------------------------------------------------------------------------

describe("DaemonServer: admin-verb authorization (R3)", () => {
  it("a non-OWNER-grade connection is forbidden from admin verbs; OWNER succeeds", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const lowGrade = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-low");

    const ownerSock = connect(harness.endpoint);
    const ownerReader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await ownerReader.nextJson();

    const lowSock = connect(harness.endpoint);
    const lowReader = new LineReader(lowSock);
    lowSock.write(JSON.stringify({ method: "auth", token: lowGrade.raw }) + "\n");
    await lowReader.nextJson();

    lowSock.write(JSON.stringify({ id: 1, method: "reloadTokens", params: {} }) + "\n");
    const forbidden = await lowReader.nextJson();
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe(DAEMON_ERR_ADMIN_FORBIDDEN);

    ownerSock.write(JSON.stringify({ id: 1, method: "reloadTokens", params: {} }) + "\n");
    const okResp = await ownerReader.nextJson();
    expect(okResp.ok).toBe(true);
    expect(okResp.result.ok).toBe(true);

    ownerSock.destroy();
    lowSock.destroy();
  });

  it("issueToken mints a live token; revokeToken invalidates it with immediate effect", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const ownerSock = connect(harness.endpoint);
    const reader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await reader.nextJson();

    ownerSock.write(
      JSON.stringify({
        id: 1,
        method: "issueToken",
        params: { grade: "DOMAIN", label: "agent-new" },
      }) + "\n",
    );
    const issued = await reader.nextJson();
    expect(issued.ok).toBe(true);
    expect(typeof issued.result.token).toBe("string");
    expect(issued.result.grade).toBe("DOMAIN");
    expect(harness.tokens.verify(issued.result.token as string)).not.toBeNull();

    ownerSock.write(
      JSON.stringify({
        id: 2,
        method: "revokeToken",
        params: { fingerprint: issued.result.fingerprint },
      }) + "\n",
    );
    const revoked = await reader.nextJson();
    expect(revoked.result.revoked).toBe(true);
    expect(harness.tokens.verify(issued.result.token as string)).toBeNull();

    const revocation = harness.auditChain.records().find((r) => r.kind === "REVOCATION");
    expect(revocation).toBeDefined();
    expect((revocation!.payload as { fingerprint: string }).fingerprint).toBe(issued.result.fingerprint);

    ownerSock.destroy();
  });

  it("revokeAllTokens spares the caller and re-mints the owner token file", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-a");
    harness.tokens.mint(AnchorClass.DOMAIN, "agent-b");

    const ownerSock = connect(harness.endpoint);
    const reader = new LineReader(ownerSock);
    ownerSock.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
    await reader.nextJson();

    ownerSock.write(JSON.stringify({ id: 1, method: "revokeAllTokens", params: {} }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(resp.result.revokedCount).toBe(2); // the two agent tokens, NOT the owner (spared)
    expect(typeof resp.result.ownerToken).toBe("string");
    expect(resp.result.ownerToken).not.toBe(owner.token);

    // The sparED connection's OWN (old) token still verifies.
    expect(harness.tokens.verify(owner.token)).not.toBeNull();

    ownerSock.destroy();
  });
});

// ---------------------------------------------------------------------------
// R5/H6 — connection cap
// ---------------------------------------------------------------------------

async function waitForConnectionCount(h: Harness, n: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (h.server.connectionCount < n) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for connectionCount >= ${n} (still ${h.server.connectionCount})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Fully authenticate one fresh connection with `token`; returns the open socket + reader. */
async function authenticate(endpoint: string, token: string): Promise<{ socket: net.Socket; reader: LineReader }> {
  const socket = connect(endpoint);
  const reader = new LineReader(socket);
  socket.write(JSON.stringify({ method: "auth", token }) + "\n");
  const resp = await reader.nextJson();
  expect(resp.ok).toBe(true);
  return { socket, reader };
}

describe("DaemonServer: connection cap (R5/H6, daemon-connection-slot-exhaustion)", () => {
  it("maxConnections caps AUTHENTICATED connections; a further authenticated attempt is rejected", async () => {
    harness = await setupServer({ maxConnections: 2, maxPendingHandshakes: 8 });
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const agentA = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-a");
    const agentB = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-b");

    const first = await authenticate(harness.endpoint, owner.token);
    const second = await authenticate(harness.endpoint, agentA.raw);

    // A third AUTHENTICATED attempt genuinely exceeds the reservation.
    const thirdSocket = connect(harness.endpoint);
    const thirdReader = new LineReader(thirdSocket);
    thirdSocket.write(JSON.stringify({ method: "auth", token: agentB.raw }) + "\n");
    const resp = await thirdReader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe(DAEMON_ERR_CONNECTION_CAP);
    await waitClose(thirdSocket);

    first.socket.destroy();
    second.socket.destroy();
  });

  it(
    "daemon-connection-slot-exhaustion fix: a flood of UNAUTHENTICATED (silent) sockets never " +
      "draws down the authenticated reservation — a legitimate, token-holding caller still connects",
    async () => {
      // Before the fix, every accepted socket (auth'd or not) counted against
      // the SAME `maxConnections` ceiling, so a trivial local attacker opening
      // silent connections and never sending a byte could starve every real
      // client with CONNECTION_CAP forever. Here `maxConnections: 1` but
      // `maxPendingHandshakes` is generous enough to admit the flood as
      // PENDING — the regression is that the flood must NOT block the one
      // legitimate authenticated slot.
      harness = await setupServer({ maxConnections: 1, maxPendingHandshakes: 5 });
      const owner = readOwnerTokenFile(harness.dataDir)!;

      const floodSockets: net.Socket[] = [];
      for (let i = 0; i < 4; i++) {
        const s = connect(harness.endpoint);
        floodSockets.push(s);
        await new Promise<void>((resolve) => s.once("connect", () => resolve()));
      }
      await waitForConnectionCount(harness, 4);
      // None of the flood ever sent a byte — all 4 are still pending, none
      // authenticated, and (the regression) the AUTHENTICATED reservation is
      // still fully available:
      expect(harness.server.pendingHandshakeCount).toBe(4);

      const legit = await authenticate(harness.endpoint, owner.token);
      expect(harness.server.pendingHandshakeCount).toBe(4);
      expect(harness.server.connectionCount).toBe(5);

      legit.socket.destroy();
      for (const s of floodSockets) s.destroy();
    },
  );

  it(
    "daemon-connection-slot-exhaustion fix: a SEPARATE maxPendingHandshakes ceiling still bounds " +
      "the unauthenticated pool itself (its own, smaller resource limit)",
    async () => {
      harness = await setupServer({ maxConnections: 32, maxPendingHandshakes: 2 });

      const a = connect(harness.endpoint);
      const b = connect(harness.endpoint);
      await Promise.all(
        [a, b].map((s) => new Promise<void>((resolve) => s.once("connect", () => resolve()))),
      );
      await waitForConnectionCount(harness, 2);
      expect(harness.server.pendingHandshakeCount).toBe(2);

      // A third, still-unauthenticated connection exceeds the PENDING cap even
      // though `maxConnections` (32) is nowhere near exhausted.
      const thirdSocket = connect(harness.endpoint);
      const thirdReader = new LineReader(thirdSocket);
      const resp = await thirdReader.nextJson();
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe(DAEMON_ERR_CONNECTION_CAP);
      await waitClose(thirdSocket);

      a.destroy();
      b.destroy();
    },
  );
});

// ---------------------------------------------------------------------------
// shutdown-close-deadlock — stop() must never hang, even with abruptly
// destroyed clients and pre-auth-rejected sockets outstanding
// ---------------------------------------------------------------------------

describe("DaemonServer: stop() completes promptly (shutdown-close-deadlock)", () => {
  it(
    "stop() resolves quickly even when live connections were abruptly destroyed and a " +
      "pre-auth-rejected connection is outstanding (found via the raw-error-message-passthrough test)",
    async () => {
      // Reproduces the exact shape that hung indefinitely pre-fix: TWO real
      // authenticated connections, client-side ABRUPTLY `.destroy()`ed (no
      // graceful FIN exchange) with ZERO delay before `stop()` runs, PLUS a
      // THIRD connection that was rejected pre-auth (CONNECTION_CAP) and
      // whose server-side half is left half-open on this platform's
      // named-pipe transport unless `stop()` force-closes it too.
      harness = await setupServer({ maxConnections: 2, maxPendingHandshakes: 8 });
      const owner = readOwnerTokenFile(harness.dataDir)!;
      const agentA = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-a");
      const agentB = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-b");

      const first = await authenticate(harness.endpoint, owner.token);
      const second = await authenticate(harness.endpoint, agentA.raw);

      const thirdSocket = connect(harness.endpoint);
      const thirdReader = new LineReader(thirdSocket);
      thirdSocket.write(JSON.stringify({ method: "auth", token: agentB.raw }) + "\n");
      const resp = await thirdReader.nextJson();
      expect(resp.ok).toBe(false);
      await waitClose(thirdSocket);

      // Zero delay, matching the reproduced hang exactly.
      first.socket.destroy();
      second.socket.destroy();

      const start = Date.now();
      const stopPromise = harness.server.stop({ clean: true });
      const timedOut = await Promise.race([
        stopPromise.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
      ]);
      expect(timedOut).toBe(false);
      expect(Date.now() - start).toBeLessThan(5000);

      // `afterEach` would otherwise call stop() again on an already-stopped
      // server; mark it handled by clearing the harness (stop() is expected
      // to be idempotent-safe to call once here — clearing avoids a second call).
      await stopPromise;
      harness.memory.close();
      rmSync(harness.dataDir, { recursive: true, force: true });
      harness = null;
    },
  );
});

// ---------------------------------------------------------------------------
// no-health-status-surface — the lightly-authenticated status/ping verb
// ---------------------------------------------------------------------------

describe("DaemonServer: status/ping verb (no-health-status-surface)", () => {
  it("status: ANY authenticated connection (not just OWNER) gets connectionCount/queueDepth/uptimeMs/daemonChainHead", async () => {
    harness = await setupServer();
    const lowGrade = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-status-probe");
    const { socket, reader } = await authenticate(harness.endpoint, lowGrade.raw);

    await new Promise((resolve) => setTimeout(resolve, 20)); // ensure uptimeMs > 0
    socket.write(JSON.stringify({ id: 1, method: "status" }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(typeof resp.result.connectionCount).toBe("number");
    expect(resp.result.connectionCount).toBeGreaterThanOrEqual(1);
    expect(typeof resp.result.queueDepth).toBe("number");
    expect(typeof resp.result.uptimeMs).toBe("number");
    expect(resp.result.uptimeMs).toBeGreaterThan(0);
    expect(resp.result.daemonChainHead).toEqual(harness.auditChain.chainHead());
    // No factChainHead was wired for this harness — reported unavailable, never invented.
    expect(resp.result.factChainHead).toBeNull();

    socket.destroy();
  });

  it("ping is an alias for status (same payload shape)", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket, reader } = await authenticate(harness.endpoint, owner.token);

    socket.write(JSON.stringify({ id: 1, method: "ping" }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(typeof resp.result.connectionCount).toBe("number");
    expect(typeof resp.result.daemonChainHead.headHash).toBe("string");

    socket.destroy();
  });

  it("status reports the wired factChainHead when the caller (cli.ts) supplies one", async () => {
    const fakeFactChainHead = { seq: 42, headHash: "deadbeef" };
    harness = await setupServer({ factChainHead: () => fakeFactChainHead });
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket, reader } = await authenticate(harness.endpoint, owner.token);

    socket.write(JSON.stringify({ id: 1, method: "status" }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.result.factChainHead).toEqual(fakeFactChainHead);

    socket.destroy();
  });

  it("status is dispatched OUTSIDE the FIFO queue: it answers immediately even with the queue backed up", async () => {
    harness = await setupServer({ maxQueueDepth: 1 });
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket, reader } = await authenticate(harness.endpoint, owner.token);

    // Fill the single queue slot with a real in-flight call, then ask for
    // status WHILE it is still executing — status must not queue behind it.
    socket.write(JSON.stringify({ id: 1, method: "recall", params: "anything" }) + "\n");
    socket.write(JSON.stringify({ id: 2, method: "status" }) + "\n");
    const first = await reader.nextJson();
    const second = await reader.nextJson();
    // Whichever ordering the transport delivers, both must succeed — status
    // was never itself rejected/backpressured by the queue's own depth cap.
    expect([first.id, second.id].sort()).toEqual([1, 2]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    socket.destroy();
  });
});

// ---------------------------------------------------------------------------
// verifychain-never-invoked-by-product — the on-demand verifyChains admin verb
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fifo-backpressure-id-loss — the rejected request's OWN wire id is echoed
// ---------------------------------------------------------------------------

describe("DaemonServer: fifo-backpressure-id-loss fix", () => {
  it("a BACKPRESSURE rejection echoes the REJECTED request's own wire id, never a hardcoded -1", async () => {
    harness = await setupServer({ maxQueueDepth: 2 });
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket, reader } = await authenticate(harness.endpoint, owner.token);

    // Flood far more requests than the tiny queue depth, back-to-back on ONE
    // connection, without awaiting between writes — a real flood over the
    // real socket (mirrors the E2E H6 backpressure test's technique).
    const TOTAL = 30;
    for (let i = 0; i < TOTAL; i++) {
      socket.write(JSON.stringify({ id: i, method: "recall", params: "flood" }) + "\n");
    }

    let backpressureId: number | null = null;
    let seen = 0;
    while (seen < TOTAL && backpressureId === null) {
      const resp = await reader.nextJson(5000);
      seen += 1;
      if (!resp.ok && resp.error?.code === "BACKPRESSURE") {
        backpressureId = resp.id;
      }
    }

    expect(backpressureId).not.toBeNull();
    // The pre-fix bug hardcoded -1 (a value the client's own id sequence,
    // starting at 0 here / 1 in the real client, never produces) — proving
    // the fix threads the REAL rejected request's id, not a sentinel that
    // never matches any pending entry client-side.
    expect(backpressureId).not.toBe(-1);
    expect(backpressureId).toBeGreaterThanOrEqual(0);
    expect(backpressureId).toBeLessThan(TOTAL);

    socket.destroy();
  });
});

// ---------------------------------------------------------------------------
// socket-error-swallowed — post-handshake socket errors are counted + logged
// ---------------------------------------------------------------------------

describe("DaemonServer: socket-error-swallowed fix", () => {
  it("socketErrorCount stays 0 with no errors, and the getter reflects real observed errors", async () => {
    harness = await setupServer();
    expect(harness.server.socketErrorCount).toBe(0);
    const { socket } = await authenticate(harness.endpoint, readOwnerTokenFile(harness.dataDir)!.token);
    expect(harness.server.socketErrorCount).toBe(0);
    socket.destroy();
  });

  it("a post-handshake socket error is counted and logged (never silently discarded)", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket } = await authenticate(harness.endpoint, owner.token);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Force a genuine socket-level error: fire many requests, then abruptly
    // destroy the client's connection without reading any response — the
    // server's subsequent attempt(s) to write a queued response onto the
    // now-gone peer surface as a real 'error' event (EPIPE), not merely
    // 'close' (reliably reproduced this way — verified over repeated runs).
    // Deliberately plain `.destroy()`, not `resetAndDestroy()`: the latter is
    // TCP-only and was found (during this fix's own verification) to trigger
    // an unrelated low-level write-completion escape over this platform's
    // named-pipe transport — a footgun in the TEST technique, not in the
    // daemon code under test, so avoided here.
    for (let i = 0; i < 20; i++) {
      socket.write(JSON.stringify({ id: i, method: "recall", params: "x" }) + "\n");
    }
    socket.destroy();

    // Give the server a moment to observe the broken connection.
    const deadline = Date.now() + 2000;
    while (harness.server.socketErrorCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const loggedLines = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();

    expect(harness.server.socketErrorCount).toBeGreaterThan(0);
    const socketErrorLine = loggedLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((r) => r?.["event"] === "socket_error");
    expect(socketErrorLine).toBeDefined();
    expect(socketErrorLine!["level"]).toBe("warn");
    expect(typeof socketErrorLine!["message"]).toBe("string");
  });
});

describe("DaemonServer: verifyChains admin verb (verifychain-never-invoked-by-product)", () => {
  it("verifyChains is OWNER-only and reports both chains' verification result", async () => {
    const fakeVerify = { ok: true, firstBrokenSeq: null };
    harness = await setupServer({ verifyFactChain: () => fakeVerify });
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const lowGrade = harness.tokens.mint(AnchorClass.EMAIL_OAUTH, "agent-verify-probe");

    const low = await authenticate(harness.endpoint, lowGrade.raw);
    low.socket.write(JSON.stringify({ id: 1, method: "verifyChains", params: {} }) + "\n");
    const forbidden = await low.reader.nextJson();
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe(DAEMON_ERR_ADMIN_FORBIDDEN);

    const owned = await authenticate(harness.endpoint, owner.token);
    owned.socket.write(JSON.stringify({ id: 1, method: "verifyChains", params: {} }) + "\n");
    const resp = await owned.reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(resp.result.daemonChain.ok).toBe(true);
    expect(resp.result.factChain).toEqual(fakeVerify);

    low.socket.destroy();
    owned.socket.destroy();
  });

  it("verifyChains reports factChain: null when no fact-chain verifier was wired", async () => {
    harness = await setupServer();
    const owner = readOwnerTokenFile(harness.dataDir)!;
    const { socket, reader } = await authenticate(harness.endpoint, owner.token);

    socket.write(JSON.stringify({ id: 1, method: "verifyChains", params: {} }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    expect(resp.result.daemonChain.ok).toBe(true);
    expect(resp.result.factChain).toBeNull();

    socket.destroy();
  });
});
