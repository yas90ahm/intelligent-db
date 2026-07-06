/**
 * daemon/__tests__/server.test.ts — DaemonServer integration tests over REAL
 * `node:net` connections: the H1 handshake matrix, admin-verb authorization
 * (R3), and the connection cap (R5/H6). Windows named-pipe path (R9) is
 * exercised directly (this machine is Windows); the POSIX socket-file path is
 * written per spec and gated behind `process.platform` (see `server.ts`'s
 * `recoverStaleSocket`), not exercised here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  overrides: Partial<Pick<DaemonServerOptions, "maxConnections" | "maxQueueDepth">> = {},
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

describe("DaemonServer: connection cap (R5/H6)", () => {
  it("refuses a connection beyond maxConnections with a typed error, before handshake", async () => {
    harness = await setupServer({ maxConnections: 1 });

    const first = connect(harness.endpoint);
    await new Promise<void>((resolve) => first.once("connect", () => resolve()));
    // Wait for the SERVER side to actually register the accepted connection
    // (client-side 'connect' can fire a tick before the server's own
    // 'connection' handler runs) before relying on connectionCount.
    await waitForConnectionCount(harness, 1);

    const second = connect(harness.endpoint);
    const secondReader = new LineReader(second);
    const resp = await secondReader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe(DAEMON_ERR_CONNECTION_CAP);
    await waitClose(second);

    first.destroy();
  });
});
