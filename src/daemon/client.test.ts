/**
 * daemon/client.test.ts — unit tests for the CLIENT lane's deliverable:
 * interface completeness, UNKNOWN semantics on forced disconnect,
 * reconnect-with-backoff (fake timers), and envelope round-trip. All against
 * a FAKE {@link ConnectionLike} (an EventEmitter) — no real socket/pipe I/O,
 * so these run fast and deterministically everywhere (including CI without a
 * daemon process).
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DaemonClientCore,
  DaemonAuthError,
  DaemonRemoteUnsupportedError,
  DaemonRequestError,
  DaemonUnknownOutcomeError,
  backoffDelayMs,
  createRemoteAgentMemory,
} from "./client.js";
import type { ConnectFn, ConnectionLike } from "./client.js";
import { DAEMON_METHODS } from "./protocol.js";
import type { DaemonAuthResponse, DaemonRequestEnvelope, DaemonResponseEnvelope } from "./protocol.js";

import { createAgentMemory } from "../agent/agentMemory.js";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

class FakeConnection extends EventEmitter implements ConnectionLike {
  readonly written: string[] = [];
  destroyed = false;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Test helper: simulate the daemon sending one line. */
  emitLine(obj: unknown): void {
    this.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }

  /** Test helper: simulate a disconnect. */
  emitClose(): void {
    this.emit("close");
  }

  /** Parse every JSON-RPC-ish line this connection was asked to write, past the auth line. */
  requestsWritten(): DaemonRequestEnvelope[] {
    return this.written.slice(1).map((l) => JSON.parse(l) as DaemonRequestEnvelope);
  }

  authLineWritten(): { method: string; token: string } {
    return JSON.parse(this.written[0]!) as { method: string; token: string };
  }
}

function okAuth(defaultSourceId = "src:test-owner"): DaemonAuthResponse {
  return { ok: true, defaultSourceId };
}

function okResponse(id: number, result: unknown): DaemonResponseEnvelope {
  return { id, ok: true, result };
}

function errResponse(id: number, code: string, message: string): DaemonResponseEnvelope {
  return { id, ok: false, error: { code, message } };
}

/** A connect factory that hands out FakeConnections, recording every attempt. */
function fakeConnectFactory(): { connect: ConnectFn; conns: FakeConnection[]; attempts: number } {
  const conns: FakeConnection[] = [];
  const state = { attempts: 0 };
  const connect: ConnectFn = () => {
    state.attempts++;
    const c = new FakeConnection();
    conns.push(c);
    return c;
  };
  return {
    connect,
    conns,
    get attempts(): number {
      return state.attempts;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Interface completeness — every AgentMemory data verb is proxied
// ---------------------------------------------------------------------------

describe("interface completeness", () => {
  it("DAEMON_METHODS covers every AgentMemory data verb except trust/engine/defaultSourceId/close", () => {
    const mem = createAgentMemory();
    try {
      const facadeMethods = Object.keys(mem).filter((k) => {
        if (k === "trust" || k === "engine" || k === "defaultSourceId" || k === "close") return false;
        return typeof (mem as unknown as Record<string, unknown>)[k] === "function";
      });
      for (const m of facadeMethods) {
        expect(DAEMON_METHODS, `AgentMemory.${m} should be a DaemonMethod`).toContain(m);
      }
      // And nothing in DAEMON_METHODS names something the facade doesn't have.
      for (const m of DAEMON_METHODS) {
        expect(facadeMethods, `DaemonMethod ${m} should exist on AgentMemory`).toContain(m);
      }
    } finally {
      mem.close();
    }
  });

  it("createRemoteAgentMemory exposes every DAEMON_METHODS name as a callable function", () => {
    const { connect } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({ socketPath: "unused", token: "t", connect });
    for (const m of DAEMON_METHODS) {
      expect(typeof (remote as unknown as Record<string, unknown>)[m]).toBe("function");
    }
    expect(typeof remote.getDefaultSourceId).toBe("function");
    expect(typeof remote.close).toBe("function");
    void remote.close();
  });

  it("trust/engine throw DaemonRemoteUnsupportedError on any member call (documented v1 scope limit)", () => {
    const { connect } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({ socketPath: "unused", token: "t", connect });
    expect(() => remote.trust.registerOwner()).toThrow(DaemonRemoteUnsupportedError);
    expect(() => (remote.engine as unknown as { writeFact: () => void }).writeFact()).toThrow(
      DaemonRemoteUnsupportedError,
    );
    void remote.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Envelope round-trip
// ---------------------------------------------------------------------------

describe("envelope round-trip", () => {
  it("handshakes, sends a well-formed request envelope, and resolves on a matching response", async () => {
    const { connect, conns } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({ socketPath: "unused", token: "sekret", connect });

    // Let the (synchronous) connect attempt happen; then hand back the auth response.
    await Promise.resolve();
    expect(conns).toHaveLength(1);
    expect(conns[0]!.authLineWritten()).toEqual({ method: "auth", token: "sekret" });
    conns[0]!.emitLine(okAuth("src:owner-1"));

    const p = remote.remember({ text: "Berlin is the capital of Germany" }, "req-42");
    await Promise.resolve();
    await Promise.resolve();

    const reqs = conns[0]!.requestsWritten();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.method).toBe("remember");
    expect(reqs[0]!.params).toEqual({ text: "Berlin is the capital of Germany" });
    expect(reqs[0]!.requestId).toBe("req-42"); // H5 passthrough
    expect(typeof reqs[0]!.id).toBe("number");

    conns[0]!.emitLine(okResponse(reqs[0]!.id, { id: "strand:abc" }));
    const result = await p;
    expect(result).toEqual({ id: "strand:abc" });

    expect(await remote.getDefaultSourceId()).toBe("src:owner-1");
    await remote.close();
  });

  it("surfaces a daemon-reported failure as a typed DaemonRequestError, never a fabricated result", async () => {
    const { connect, conns } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({ socketPath: "unused", token: "t", connect });
    await Promise.resolve();
    conns[0]!.emitLine(okAuth());

    const p = remote.recall("what is the capital?");
    await Promise.resolve();
    await Promise.resolve();
    const [req] = conns[0]!.requestsWritten();
    conns[0]!.emitLine(errResponse(req!.id, "BAD_INPUT", "cue too long"));

    await expect(p).rejects.toBeInstanceOf(DaemonRequestError);
    await expect(p).rejects.toMatchObject({ code: "BAD_INPUT" });
    await remote.close();
  });

  it("rejects the handshake wait with DaemonAuthError on a rejected auth line", async () => {
    const { connect, conns } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({
      socketPath: "unused",
      token: "wrong",
      connect,
      reconnect: { initialDelayMs: 100_000 }, // keep it from immediately retrying mid-assert
    });
    // Register the readiness wait FIRST (as a real caller would, right after
    // construction) so the failed auth line has a waiter to reject.
    const pending = remote.getDefaultSourceId();
    conns[0]!.emitLine({ ok: false, error: "bad token" } satisfies DaemonAuthResponse);
    await expect(pending).rejects.toBeInstanceOf(DaemonAuthError);
    await remote.close();
  });
});

// ---------------------------------------------------------------------------
// 3. UNKNOWN semantics on forced disconnect (R6/H4)
// ---------------------------------------------------------------------------

describe("UNKNOWN outcome on disconnect", () => {
  it("an in-flight request resolves to a typed UNKNOWN, never a fabricated success/failure", async () => {
    const { connect, conns } = fakeConnectFactory();
    const remote = createRemoteAgentMemory({ socketPath: "unused", token: "t", connect });
    await Promise.resolve();
    conns[0]!.emitLine(okAuth());

    const p = remote.remember({ text: "in flight when the daemon dies" });
    await Promise.resolve();
    await Promise.resolve();
    expect(conns[0]!.requestsWritten()).toHaveLength(1); // genuinely sent, no response yet

    conns[0]!.emitClose(); // the daemon (or the pipe) drops mid-request

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonUnknownOutcomeError);
    expect((caught as DaemonUnknownOutcomeError).outcome).toBe("UNKNOWN");
    await remote.close();
  });

  it("DaemonClientCore.request rejects UNKNOWN directly (unit-level, no facade indirection)", async () => {
    const { connect, conns } = fakeConnectFactory();
    const core = new DaemonClientCore({ connect, token: "t" });
    await Promise.resolve();
    conns[0]!.emitLine(okAuth());

    const p = core.request("recall", { text: "x" });
    await Promise.resolve();
    await Promise.resolve();
    conns[0]!.emitClose();

    await expect(p).rejects.toBeInstanceOf(DaemonUnknownOutcomeError);
    core.close();
  });

  it("close() fails every outstanding request UNKNOWN and stops future reconnects", async () => {
    const { connect, conns } = fakeConnectFactory();
    const core = new DaemonClientCore({ connect, token: "t" });
    await Promise.resolve();
    conns[0]!.emitLine(okAuth());

    const p = core.request("listPending", undefined);
    await Promise.resolve();
    core.close();
    await expect(p).rejects.toBeInstanceOf(DaemonUnknownOutcomeError);
    expect(conns[0]!.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Reconnect-with-backoff (fake timers)
// ---------------------------------------------------------------------------

describe("reconnect-with-backoff", () => {
  it("backoffDelayMs grows exponentially and saturates at maxDelayMs", () => {
    const opts = { initialDelayMs: 100, factor: 2, maxDelayMs: 1000 };
    expect(backoffDelayMs(0, opts)).toBe(100);
    expect(backoffDelayMs(1, opts)).toBe(200);
    expect(backoffDelayMs(2, opts)).toBe(400);
    expect(backoffDelayMs(3, opts)).toBe(800);
    expect(backoffDelayMs(4, opts)).toBe(1000); // saturated
    expect(backoffDelayMs(10, opts)).toBe(1000);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a refused connection at exactly the backoff cadence, then succeeds", async () => {
    let attempts = 0;
    const conns: FakeConnection[] = [];
    const connect: ConnectFn = () => {
      attempts++;
      if (attempts <= 2) throw new Error("ECONNREFUSED");
      const c = new FakeConnection();
      conns.push(c);
      return c;
    };

    const core = new DaemonClientCore({
      connect,
      token: "t",
      reconnect: { initialDelayMs: 100, factor: 2, maxDelayMs: 10_000 },
    });

    // Attempt 1 happens synchronously at construction and fails immediately.
    expect(attempts).toBe(1);

    // Attempt 2 is scheduled after backoffDelayMs(1) = 100ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);

    // Attempt 3 is scheduled after backoffDelayMs(2) = 200ms, and succeeds.
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    expect(conns).toHaveLength(1);

    conns[0]!.emitLine(okAuth("src:reconnected"));
    expect(core.isReady).toBe(true);
    core.close();
  });

  it("a request issued while disconnected queues, then flushes once reconnected", async () => {
    let attempts = 0;
    const conns: FakeConnection[] = [];
    const connect: ConnectFn = () => {
      attempts++;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      const c = new FakeConnection();
      conns.push(c);
      return c;
    };
    const core = new DaemonClientCore({
      connect,
      token: "t",
      reconnect: { initialDelayMs: 50 },
    });
    expect(attempts).toBe(1); // failed immediately, nothing to send to

    const p = core.request("stampFor", "src:x");
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toBe(2);
    expect(conns).toHaveLength(1);
    expect(conns[0]!.requestsWritten()).toHaveLength(0); // still pre-handshake

    conns[0]!.emitLine(okAuth());
    // Auth response is handled synchronously off the 'data' event; the queued
    // request should now have been flushed onto the wire.
    const written = conns[0]!.requestsWritten();
    expect(written).toHaveLength(1);
    expect(written[0]!.method).toBe("stampFor");

    conns[0]!.emitLine(okResponse(written[0]!.id, { anchor_set: [] }));
    await expect(p).resolves.toEqual({ anchor_set: [] });
    core.close();
  });

  it("reconnects with backoff again after a later disconnect (attempt counter resets on success)", async () => {
    let attempts = 0;
    const conns: FakeConnection[] = [];
    const connect: ConnectFn = () => {
      attempts++;
      const c = new FakeConnection();
      conns.push(c);
      return c;
    };
    const core = new DaemonClientCore({ connect, token: "t", reconnect: { initialDelayMs: 100 } });
    expect(attempts).toBe(1);
    conns[0]!.emitLine(okAuth());
    expect(core.isReady).toBe(true);

    conns[0]!.emitClose(); // drop after a successful run
    expect(core.isReady).toBe(false);
    expect(attempts).toBe(1); // reconnect not yet scheduled to fire

    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2); // first retry after the FIRST disconnect uses attempt=1 delay again

    conns[1]!.emitLine(okAuth());
    expect(core.isReady).toBe(true);
    core.close();
  });
});
