/**
 * daemon/__tests__/auditChainCrashSafety.test.ts — regression coverage for
 * `daemon-auditchain-write-crashes-process` (PRODUCTION_READINESS_ASSESSMENT.md,
 * CONFIRMED critical): before this fix, every `#auditChain.record*` call site in
 * `server.ts` was unguarded, and `FifoQueue#drain` had a `try/finally` with NO
 * `catch` — a throwing audit-chain write (disk-full/EACCES/corruption) propagated
 * out of the queue's `run()`, which `enqueue()` invokes as `void this.#drain()`
 * (fire-and-forget). With zero `unhandledRejection`/`uncaughtException` handlers
 * anywhere in `src/` (confirmed by the audit), this crashed the WHOLE daemon
 * process — worst, on the HANDSHAKE path, meaning every single connection
 * attempt could kill the daemon for every other connected client.
 *
 * These tests exercise the REAL, exported production classes
 * ({@link FifoQueue}, {@link DaemonServer}) — never a re-derived mock of the
 * bug — injecting a genuinely throwing audit-chain write and asserting the
 * process survives and the affected caller gets a typed error.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentMemory } from "../../agent/agentMemory.js";
import type { AgentMemory } from "../../agent/agentMemory.js";
import { createTokenStore, readOwnerTokenFile } from "../tokens.js";
import type { TokenStore } from "../tokens.js";
import { createDaemonAuditChain } from "../auditChain.js";
import type { DaemonAuditChain, DaemonLedgerRecord } from "../auditChain.js";
import { DaemonServer, FifoQueue } from "../server.js";

// ---------------------------------------------------------------------------
// Part 1: FifoQueue#drain — a throwing item is isolated, never wedges the
// queue (a standalone unit test, independent of sockets, per the class's own
// design goal).
// ---------------------------------------------------------------------------

describe("FifoQueue: a throwing/rejecting item is isolated (daemon-auditchain-write-crashes-process)", () => {
  it(
    "a synchronously-throwing item does not stop later items, and the queue is NOT permanently wedged",
    async () => {
      const errors: unknown[] = [];
      const q = new FifoQueue(10, (err) => {
        errors.push(err);
      });
      let secondRan = false;
      q.enqueue(1, () => {
        throw new Error("boom");
      });
      q.enqueue(2, () => {
        secondRan = true;
      });

      // Pre-fix, this NEVER resolves: `#draining` is left `true` forever once
      // the uncaught throw escapes the `while` loop, so `whenDrained()`'s
      // `while (this.#draining || ...)` spins forever and this test times out.
      await q.whenDrained();

      expect(errors.length).toBe(1);
      expect((errors[0] as Error).message).toBe("boom");
      expect(secondRan).toBe(true);
      expect(q.depth).toBe(0);
      expect(q.isExecuting).toBe(false);

      // The queue keeps working AFTER the failure too (not merely "the two
      // items already in flight happened to finish") — proves `#draining` was
      // genuinely reset to `false`, not just coincidentally not-yet-observed.
      let thirdRan = false;
      q.enqueue(3, () => {
        thirdRan = true;
      });
      await q.whenDrained();
      expect(thirdRan).toBe(true);
    },
    3000,
  );

  it(
    "an async item that REJECTS is isolated the same way",
    async () => {
      const errors: unknown[] = [];
      const q = new FifoQueue(10, (err) => {
        errors.push(err);
      });
      let secondRan = false;
      q.enqueue(1, async () => {
        throw new Error("async boom");
      });
      q.enqueue(2, () => {
        secondRan = true;
      });
      await q.whenDrained();
      expect(errors.length).toBe(1);
      expect((errors[0] as Error).message).toBe("async boom");
      expect(secondRan).toBe(true);
    },
    3000,
  );

  it("the default onItemError (no callback supplied) never throws — a bare `new FifoQueue()` stays safe", async () => {
    const q = new FifoQueue(10);
    let secondRan = false;
    q.enqueue(1, () => {
      throw new Error("boom with no handler supplied");
    });
    q.enqueue(2, () => {
      secondRan = true;
    });
    await q.whenDrained();
    expect(secondRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2: DaemonServer over a REAL socket — an injected throwing AppendSink
// (simulating a disk-full audit-chain write) never crashes the daemon.
// ---------------------------------------------------------------------------

let baseCounter = 0;
function nextBase(): string {
  baseCounter += 1;
  return `iddb-daemon-auditcrash-${process.pid}-${baseCounter}`;
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

/** A DaemonAuditChain whose CONNECTION_ACCEPTED writes always throw (simulating
 * a disk-full/corrupt-chain failure) — every OTHER record kind passes through
 * to a real in-memory chain, matching production shape exactly. */
function makeConnectionAcceptedThrowingChain(): DaemonAuditChain {
  const real = createDaemonAuditChain();
  return {
    recordConnectionAccepted(): DaemonLedgerRecord {
      throw new Error("simulated audit-chain write failure (disk full)");
    },
    recordAuthFailure: (...args) => real.recordAuthFailure(...args),
    recordRevocation: (...args) => real.recordRevocation(...args),
    recordAdminVerb: (...args) => real.recordAdminVerb(...args),
    recordShutdown: (...args) => real.recordShutdown(...args),
    verifyChain: () => real.verifyChain(),
    chainHead: () => real.chainHead(),
    records: () => real.records(),
  };
}

/** A DaemonAuditChain whose ADMIN_VERB writes always throw. */
function makeAdminVerbThrowingChain(): DaemonAuditChain {
  const real = createDaemonAuditChain();
  return {
    recordConnectionAccepted: (...args) => real.recordConnectionAccepted(...args),
    recordAuthFailure: (...args) => real.recordAuthFailure(...args),
    recordRevocation: (...args) => real.recordRevocation(...args),
    recordAdminVerb(): DaemonLedgerRecord {
      throw new Error("simulated audit-chain write failure (disk full)");
    },
    recordShutdown: (...args) => real.recordShutdown(...args),
    verifyChain: () => real.verifyChain(),
    chainHead: () => real.chainHead(),
    records: () => real.records(),
  };
}

interface Harness {
  readonly server: DaemonServer;
  readonly endpoint: string;
  readonly dataDir: string;
  readonly tokens: TokenStore;
  readonly memory: AgentMemory;
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

async function setupWithChain(auditChain: DaemonAuditChain): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "iddb-daemon-auditcrash-"));
  const memory = createAgentMemory({});
  const tokens = createTokenStore(dataDir);
  const server = new DaemonServer({
    memory,
    tokens,
    auditChain,
    trustRegistry: memory.trust,
    endpointBase: nextBase(),
    handshakeTimeoutMs: 300,
    authFailureDelayMs: 30,
  });
  const { endpoint } = await server.start();
  return { server, endpoint, dataDir, tokens, memory };
}

describe("DaemonServer: a throwing audit-chain write never crashes the process (daemon-auditchain-write-crashes-process)", () => {
  it(
    "CONNECTION_ACCEPTED write fails on EVERY successful handshake -> typed auth error each time, daemon stays up",
    async () => {
      harness = await setupWithChain(makeConnectionAcceptedThrowingChain());
      const owner = readOwnerTokenFile(harness.dataDir)!;

      // Exactly the finding's "worst case": every single connection attempt
      // hits the broken audit write. Prove the daemon survives THREE in a row
      // (never a hang, never a crash), each getting a typed failure response.
      for (let i = 0; i < 3; i++) {
        const socket = connect(harness.endpoint);
        const reader = new LineReader(socket);
        socket.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
        const resp = await reader.nextJson();
        expect(resp.ok).toBe(false);
        expect(typeof resp.error).toBe("string");
        socket.destroy();
      }

      // The daemon process/instance is still fully alive: an UNRELATED failure
      // path (bad token -> recordAuthFailure, which this chain does NOT break)
      // still completes normally, proving the server, not just the socket, is
      // still running.
      const badSocket = connect(harness.endpoint);
      const badReader = new LineReader(badSocket);
      badSocket.write(JSON.stringify({ method: "auth", token: "f".repeat(64) }) + "\n");
      const badResp = await badReader.nextJson();
      expect(badResp.ok).toBe(false);
      await waitClose(badSocket);
    },
    10_000,
  );

  it(
    "ADMIN_VERB write fails -> typed INTERNAL error (not a crash); the connection's queue keeps draining afterward",
    async () => {
      harness = await setupWithChain(makeAdminVerbThrowingChain());
      const owner = readOwnerTokenFile(harness.dataDir)!;
      const socket = connect(harness.endpoint);
      const reader = new LineReader(socket);
      socket.write(JSON.stringify({ method: "auth", token: owner.token }) + "\n");
      await reader.nextJson();

      // reloadTokens' own logic succeeds; only the audit write throws.
      socket.write(JSON.stringify({ id: 1, method: "reloadTokens", params: {} }) + "\n");
      const first = await reader.nextJson();
      expect(first.ok).toBe(false);
      expect(first.error.code).toBe("INTERNAL");
      expect(String(first.error.message)).toMatch(/simulated audit-chain write failure/i);

      // Fire a SECOND admin verb right after: proves the FIFO queue was not
      // wedged by the first failure (the FifoQueue#drain fix) — the pre-fix
      // bug would leave `#draining` stuck and this would hang forever.
      socket.write(JSON.stringify({ id: 2, method: "reloadTokens", params: {} }) + "\n");
      const second = await reader.nextJson();
      expect(second.ok).toBe(false);
      expect(second.error.code).toBe("INTERNAL");

      // And a completely ordinary memory call on the SAME connection still
      // works — the daemon (and this connection's session) is fully healthy.
      socket.write(JSON.stringify({ id: 3, method: "recall", params: "anything" }) + "\n");
      const recallResp = await reader.nextJson();
      expect(recallResp.ok).toBe(true);

      socket.destroy();
    },
    10_000,
  );
});
