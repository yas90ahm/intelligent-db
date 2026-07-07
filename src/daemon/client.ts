/**
 * daemon/client.ts — THE DAEMON CLIENT: `createRemoteAgentMemory`.
 *
 * Deliverable 1 (client portion) of PHASE3_DAEMON_SPEC.md: an
 * {@link AgentMemory}-shaped adapter that proxies every genuine data
 * operation the facade exposes (agent/agentMemory.ts) as ONE request/response
 * round trip over a single daemon socket/named-pipe connection, instead of
 * calling straight into an in-process engine. R7 remains true either way: the
 * in-process `createAgentMemory()` stays the permanent default; this module
 * is a pure opt-in alternative backing, selected explicitly by the caller
 * (mcp/server.ts's startup switch, deliverable 2).
 *
 * ── THE SYNC/ASYNC SEAM (read before wiring this into anything) ─────────────
 * A real socket/pipe round trip is inherently asynchronous in Node. `node:net`
 * has no non-blocking-compatible way to make socket I/O appear synchronous on
 * the calling thread without either (a) a native addon (forbidden — zero new
 * runtime deps, and R2 already rules out the native-addon path for a
 * different reason) or (b) a `worker_threads` + `Atomics.wait` blocking
 * bridge. `AgentMemory`'s methods are SYNCHRONOUS (`remember(): {id}`, not
 * `Promise<{id}>`), matching the in-process engine's synchronous
 * `node:sqlite` calls (PHASE3_DAEMON_PROPOSAL.md §4). This module ships the
 * ASYNC shape — {@link createRemoteAgentMemory} returns
 * {@link RemoteAgentMemory}, an honestly-typed async mirror of `AgentMemory`
 * (every method returns a `Promise`, backed by {@link DaemonClientCore} — a
 * plain `node:net`-only connection engine with an injectable transport for
 * tests) — and DELIBERATELY DOES NOT ship a worker-thread synchronous bridge.
 *
 * That bridge was attempted and REJECTED after empirical testing on this
 * Node 24 runtime: a `worker_threads` Worker performing real socket I/O
 * (`net.connect` + JSON parsing + object allocation) while the MAIN thread
 * blocks in `Atomics.wait` reproducibly STALLS — the worker makes NO
 * progress on its connection until the main thread's event loop actually
 * ticks (a real `setTimeout` callback firing), even after hundreds of
 * milliseconds of wall-clock time spent either busy-spinning OR chunked
 * `Atomics.wait` calls on the main thread. This matches a documented V8/libuv
 * hazard: `Atomics.wait` parks the calling thread at a level that does not
 * reach the periodic interrupt/safepoint checks other isolates need (e.g. for
 * GC) — a trivial worker (one `setTimeout` + `postMessage`, no allocation
 * pressure) validated the primitive fine in isolation, but a worker doing
 * REAL I/O work reproducibly did not. Shipping that bridge would have meant
 * an intermittently-hanging daemon client — worse than the honest async-only
 * design PHASE3B_MCP_ASYNC_SPEC.md settled on instead: rather than bridge
 * this module DOWN to a synchronous `AgentMemory` shape, `mcp/handler.ts`'s
 * dispatch went UP to an async shape (`AsyncAgentMemory`,
 * `handleMcpRequestAsync` — the SINGLE dispatch implementation for both the
 * in-process and daemon-backed paths). `RemoteAgentMemory` below already
 * satisfies `mcp/asyncMemory.ts`'s narrow `AsyncAgentMemory` contract
 * STRUCTURALLY for the five MCP-surface verbs (`remember`/`recall`/
 * `pendingQuestions`/`resolvePending`/`explain`) plus `close` — every extra
 * parameter (`requestId`, H5) is optional, so `mcp/server.ts` hands this
 * object straight to `handleMcpRequestAsync` with zero glue. That structural
 * fit is verified where it actually matters: `mcp/server.ts`'s `main()`
 * assigns `createRemoteAgentMemory(...)`'s return value into an
 * explicitly-typed `let memory: AsyncAgentMemory;` binding — a REAL
 * TypeScript structural check that errors at that exact assignment if the two
 * interfaces ever diverge. (An earlier revision of this module also exported a
 * standalone `type __AssertRemoteAgentMemorySatisfiesAsyncAgentMemory = ...`
 * conditional-type alias here as a second, "belt and suspenders" proof — a
 * re-audit found it was dead code: nothing ever referenced the alias, so
 * TypeScript never actually evaluated it, and a genuine interface divergence
 * would have produced zero diagnostics from it — a fake safety net sitting
 * beside the real one above. Removed rather than fixed in place: the real
 * check already exists and needs no help.) The in-process path needs one
 * trivial adapter (`syncToAsyncMemory`, in `mcp/asyncMemory.ts`) since
 * `AgentMemory` itself stays synchronous; this module needs none.
 *
 * `trust` / `engine` are NOT proxied remotely: both are rich, multi-method
 * "advanced caller" escape hatches (a whole `TrustRegistry` / `IntelligentDb`
 * surface each — dozens of methods), out of scope for a v1 daemon transport
 * built around the ergonomic facade's own data verbs. Both resolve to an
 * object that throws a clear, typed {@link DaemonRemoteUnsupportedError} on
 * any member access-and-call; an advanced caller who needs them uses the
 * in-process `createAgentMemory()`.
 *
 * ZERO new runtime dependencies: `node:net` only (`node:crypto` is not even
 * needed here — token bytes are opaque strings this module never hashes;
 * R3's fingerprinting is the daemon's job).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`.
 */

import * as net from "node:net";

import { BoundedLineSplitter } from "./protocol.js";
import { daemonLog } from "./log.js";
import type {
  DaemonAuthRequest,
  DaemonAuthResponse,
  DaemonMethod,
  DaemonRequestEnvelope,
  DaemonResponseEnvelope,
} from "./protocol.js";

import type { AgentMemory } from "../agent/agentMemory.js";
import type { IntelligentDb } from "../api.js";
import type { TrustRegistry } from "../identity/trustRegistry.js";
import type { SourceId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Typed errors (never fabricated success/failure — R6/H4)
// ---------------------------------------------------------------------------

/**
 * R6/H4 — the connection dropped (or never connected) while a request's
 * outcome was unknown: it may have been applied, partially applied, or never
 * received. NEVER thrown to mean "failed" — only to mean "we cannot say."
 * Callers that need retry safety must reason about idempotency themselves
 * (H5: v1 logs `requestId` for reconciliation; it does not deduplicate).
 */
export class DaemonUnknownOutcomeError extends Error {
  readonly outcome = "UNKNOWN" as const;
  readonly method: string;
  readonly requestId: string | undefined;

  constructor(method: string, requestId: string | undefined, detail: string) {
    super(
      `daemon request "${method}" outcome UNKNOWN: ${detail} (the operation may ` +
        `or may not have been applied — never assume success or failure).`,
    );
    this.name = "DaemonUnknownOutcomeError";
    this.method = method;
    this.requestId = requestId;
  }
}

/** A request the daemon actively rejected (a real, known answer: it failed). */
export class DaemonRequestError extends Error {
  readonly code: string;
  constructor(method: string, code: string, message: string) {
    super(`daemon request "${method}" failed [${code}]: ${message}`);
    this.name = "DaemonRequestError";
    this.code = code;
  }
}

/** The handshake itself was rejected (bad/rotated token, revoked, etc.). */
export class DaemonAuthError extends Error {
  constructor(detail: string) {
    super(`daemon auth failed: ${detail}`);
    this.name = "DaemonAuthError";
  }
}

/** `trust` / `engine` member access on a remote-backed AgentMemory (see module doc). */
export class DaemonRemoteUnsupportedError extends Error {
  constructor(member: string) {
    super(
      `AgentMemory.${member} is not reachable over the v1 daemon transport — ` +
        `"trust"/"engine" are advanced, multi-method escape hatches out of scope ` +
        `for the wire protocol (see daemon/client.ts's module doc). Use the ` +
        `in-process createAgentMemory() for this call.`,
    );
    this.name = "DaemonRemoteUnsupportedError";
  }
}

// ---------------------------------------------------------------------------
// Reconnect-with-backoff (R6) — one pure formula, shared verbatim by BOTH the
// async core below AND the synchronous bridge's worker body (interpolated via
// `.toString()`, never hand-copied, so the two can never numerically drift).
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
  /** Delay before the first retry, ms. Default 200. */
  readonly initialDelayMs?: number;
  /** Ceiling on any single retry delay, ms. Default 10_000. */
  readonly maxDelayMs?: number;
  /** Exponential growth factor per attempt. Default 2. */
  readonly factor?: number;
}

/**
 * Pure exponential backoff: attempt 0 waits `initialDelayMs`, attempt 1 waits
 * `initialDelayMs * factor`, etc., capped at `maxDelayMs`. No jitter (kept
 * deterministic on purpose — easy to assert on exactly with fake timers).
 */
export function backoffDelayMs(attempt: number, opts?: ReconnectOptions): number {
  const initial = opts?.initialDelayMs ?? 200;
  const max = opts?.maxDelayMs ?? 10_000;
  const factor = opts?.factor ?? 2;
  const raw = initial * Math.pow(factor, Math.max(0, attempt));
  return Math.min(max, raw);
}

// ---------------------------------------------------------------------------
// Transport seam (injectable for tests — no real socket needed to unit-test
// the reconnect/handshake/UNKNOWN state machine)
// ---------------------------------------------------------------------------

/** The minimal duplex-stream surface {@link DaemonClientCore} needs. */
export interface ConnectionLike {
  write(data: string): boolean;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  destroy(): void;
}

/** Opens ONE fresh connection attempt. Called again by the backoff loop. */
export type ConnectFn = () => ConnectionLike;

/** A real `node:net` connection to a socket path / Windows named pipe. */
export function netConnectFn(socketPath: string): ConnectFn {
  return () => net.connect(socketPath) as unknown as ConnectionLike;
}

// ---------------------------------------------------------------------------
// DaemonClientCore — the async connection engine (main-thread, fully
// unit-testable: fake ConnectionLike + fake timers, no real I/O required)
// ---------------------------------------------------------------------------

export interface DaemonClientCoreOptions {
  readonly connect: ConnectFn;
  readonly token: string;
  readonly reconnect?: ReconnectOptions;
  /** Per-request ceiling (covers waiting-to-connect + in-flight), ms. Default 10_000. */
  readonly requestTimeoutMs?: number;
  /** Bound on requests queued while disconnected, before REJECTING new ones. Default 256. */
  readonly maxQueuedRequests?: number;
}

interface PendingEntry {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: unknown) => void;
}

interface QueuedSend {
  readonly id: number;
  readonly envelope: DaemonRequestEnvelope;
}

interface ReadyWaiter {
  readonly resolve: (sourceId: string) => void;
  readonly reject: (e: unknown) => void;
}

/**
 * The connection state machine: connect → handshake → ready; on disconnect,
 * every IN-FLIGHT request resolves UNKNOWN (never fabricated success/failure)
 * and a reconnect is scheduled with exponential backoff. Requests issued
 * while disconnected are QUEUED (bounded) and flushed once ready — a request
 * that never got a chance to be SENT is not "in flight" in the H4 sense, so
 * it is not force-failed on a disconnect that happens before it is sent; it
 * keeps waiting up to its own `requestTimeoutMs`.
 */
export class DaemonClientCore {
  readonly #opts: DaemonClientCoreOptions;
  #conn: ConnectionLike | null = null;
  #splitter = new BoundedLineSplitter();
  #nextId = 1;
  #ready = false;
  #closed = false;
  #defaultSourceId: string | null = null;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #pending = new Map<number, PendingEntry>();
  #waitingToSend: QueuedSend[] = [];
  #readyWaiters: ReadyWaiter[] = [];

  constructor(opts: DaemonClientCoreOptions) {
    this.#opts = opts;
    this.#doConnect();
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** Resolves with the handshake-bound default SourceId once (re)connected. */
  waitUntilReady(): Promise<string> {
    if (this.#ready && this.#defaultSourceId !== null) {
      return Promise.resolve(this.#defaultSourceId);
    }
    if (this.#closed) return Promise.reject(new Error("DaemonClientCore: closed"));
    return new Promise((resolve, reject) => {
      this.#readyWaiters.push({ resolve, reject });
    });
  }

  /** Issue one request; resolves with the daemon's `result`, or throws/rejects typed. */
  request(method: DaemonMethod, params: unknown, requestId?: string): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("DaemonClientCore: request after close()"));
    }
    const timeoutMs = this.#opts.requestTimeoutMs ?? 10_000;
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#pending.delete(id);
        this.#waitingToSend = this.#waitingToSend.filter((w) => w.id !== id);
        reject(new DaemonUnknownOutcomeError(method, requestId, `request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const settleResolve = (v: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const settleReject = (e: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      };

      this.#pending.set(id, { resolve: settleResolve, reject: settleReject });

      const envelope: DaemonRequestEnvelope =
        requestId !== undefined ? { id, method, params, requestId } : { id, method, params };

      if (this.#conn !== null && this.#ready) {
        this.#send(id, envelope, method, requestId, settleReject);
        return;
      }

      const cap = this.#opts.maxQueuedRequests ?? 256;
      if (this.#waitingToSend.length >= cap) {
        this.#pending.delete(id);
        settleReject(
          new DaemonUnknownOutcomeError(method, requestId, `local queue at capacity (${cap})`),
        );
        return;
      }
      this.#waitingToSend.push({ id, envelope });
    });
  }

  /** Graceful client-side shutdown: fail everything outstanding, stop retrying. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const waiters = this.#readyWaiters.splice(0);
    for (const w of waiters) w.reject(new Error("DaemonClientCore: closed"));
    for (const [, entry] of this.#pending) {
      entry.reject(new DaemonUnknownOutcomeError("(closed)", undefined, "client closed"));
    }
    this.#pending.clear();
    this.#waitingToSend = [];
    if (this.#conn !== null) {
      try {
        this.#conn.destroy();
      } catch {
        /* already gone */
      }
      this.#conn = null;
    }
  }

  // -- internals --------------------------------------------------------------

  #send(
    id: number,
    envelope: DaemonRequestEnvelope,
    method: string,
    requestId: string | undefined,
    reject: (e: unknown) => void,
  ): void {
    const conn = this.#conn;
    if (conn === null) {
      reject(new DaemonUnknownOutcomeError(method, requestId, "not connected"));
      this.#pending.delete(id);
      return;
    }
    try {
      conn.write(JSON.stringify(envelope) + "\n");
    } catch (err) {
      // zero-structured-logging fix (mcp/daemon-client layer): mirror the
      // daemon server's own `daemonLog` for a genuine dispatch failure (never
      // for the routine, expected UNKNOWN-outcome paths elsewhere in this
      // class — those aren't failures of THIS client, they're an honestly
      // reported unknown remote outcome).
      daemonLog({
        event: "daemon_client_dispatch_error",
        level: "error",
        method,
        message: err instanceof Error ? err.message : String(err),
      });
      this.#pending.delete(id);
      reject(
        new DaemonUnknownOutcomeError(
          method,
          requestId,
          `write failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  #scheduleConnect(delayMs: number): void {
    if (this.#closed) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#doConnect();
    }, delayMs);
  }

  #doConnect(): void {
    if (this.#closed) return;
    let conn: ConnectionLike;
    try {
      conn = this.#opts.connect();
    } catch (err) {
      daemonLog({
        event: "daemon_client_connect_failed",
        level: "warn",
        attempt: this.#attempt,
        message: err instanceof Error ? err.message : String(err),
      });
      this.#scheduleConnect(backoffDelayMs(this.#attempt, this.#opts.reconnect));
      this.#attempt += 1;
      return;
    }
    this.#conn = conn;
    this.#splitter = new BoundedLineSplitter();
    let handshakeSettled = false;

    conn.on("data", (chunk: Buffer) => {
      const { lines } = this.#splitter.push(chunk);
      for (const line of lines) {
        if (!handshakeSettled) {
          handshakeSettled = true;
          this.#handleAuthResponse(line);
          continue;
        }
        this.#handleResponseLine(line);
      }
    });
    conn.on("close", () => {
      this.#handleDisconnect();
    });
    conn.on("error", () => {
      // 'close' always follows in Node's net.Socket; the disconnect handler
      // there does the actual UNKNOWN-outcome + reconnect work.
    });

    const authReq: DaemonAuthRequest = { method: "auth", token: this.#opts.token };
    try {
      conn.write(JSON.stringify(authReq) + "\n");
    } catch {
      // 'close'/'error' will follow from a dead connection; nothing else to do.
    }
  }

  #handleAuthResponse(line: string): void {
    let parsed: DaemonAuthResponse;
    try {
      parsed = JSON.parse(line) as DaemonAuthResponse;
    } catch (err) {
      daemonLog({
        event: "daemon_client_handshake_parse_error",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      this.#conn?.destroy();
      this.#conn = null;
      this.#scheduleConnect(backoffDelayMs(this.#attempt, this.#opts.reconnect));
      this.#attempt += 1;
      return;
    }
    if (!parsed.ok) {
      const err = new DaemonAuthError(parsed.error ?? "rejected");
      // zero-structured-logging fix (mcp/daemon-client layer): the raw token
      // is NEVER logged here (mirrors the daemon server's own R3 discipline) —
      // only the daemon's own rejection reason string.
      daemonLog({
        event: "daemon_client_auth_rejected",
        level: "warn",
        reason: parsed.error ?? "rejected",
      });
      // Surface the auth failure to anyone currently blocked on readiness, but
      // keep retrying in the background (a rotated token file can become
      // valid later) — mirrors R6's "reconnect-with-backoff" as a standing
      // background policy, not a one-shot attempt.
      const waiters = this.#readyWaiters.splice(0);
      for (const w of waiters) w.reject(err);
      this.#conn?.destroy();
      this.#conn = null;
      this.#scheduleConnect(backoffDelayMs(this.#attempt, this.#opts.reconnect));
      this.#attempt += 1;
      return;
    }
    this.#ready = true;
    this.#attempt = 0;
    this.#defaultSourceId = parsed.defaultSourceId ?? null;
    daemonLog({
      event: "daemon_client_connected",
      level: "info",
      resolvedSourceId: this.#defaultSourceId ?? undefined,
    });

    const waiters = this.#readyWaiters.splice(0);
    for (const w of waiters) w.resolve(this.#defaultSourceId ?? "");

    // Flush anything queued while disconnected.
    const queued = this.#waitingToSend;
    this.#waitingToSend = [];
    for (const q of queued) {
      const entry = this.#pending.get(q.id);
      if (entry === undefined) continue; // already timed out / cancelled
      this.#send(q.id, q.envelope, q.envelope.method, q.envelope.requestId, entry.reject);
    }
  }

  #handleResponseLine(line: string): void {
    let parsed: DaemonResponseEnvelope;
    try {
      parsed = JSON.parse(line) as DaemonResponseEnvelope;
    } catch {
      return; // a well-behaved daemon never sends this; drop defensively
    }
    const entry = this.#pending.get(parsed.id);
    if (entry === undefined) return;
    this.#pending.delete(parsed.id);
    if (parsed.ok) entry.resolve(parsed.result);
    else {
      entry.reject(
        new DaemonRequestError(
          "(daemon-reported)",
          parsed.error?.code ?? "INTERNAL",
          parsed.error?.message ?? "unknown error",
        ),
      );
    }
  }

  #handleDisconnect(): void {
    const wasReady = this.#ready;
    this.#ready = false;
    this.#conn = null;
    if (wasReady) {
      // Only log a genuine disconnect of a PREVIOUSLY-ready connection — a
      // failed initial connect/handshake already logs its own event above,
      // and would otherwise double-log here too (`conn.on("close", ...)`
      // fires for that case as well).
      daemonLog({ event: "daemon_client_disconnected", level: "warn" });
    }
    // Every IN-FLIGHT request (already sent, no response yet) is UNKNOWN —
    // never fabricated success/failure (R6/H4).
    for (const [, entry] of this.#pending) {
      entry.reject(
        new DaemonUnknownOutcomeError(
          "(in-flight)",
          undefined,
          "connection lost before a response arrived",
        ),
      );
    }
    this.#pending.clear();
    // NOT-yet-sent requests keep waiting for the next successful reconnect
    // (bounded by their own per-request timeout) — nothing was attempted yet.
    if (!this.#closed) {
      this.#scheduleConnect(backoffDelayMs(this.#attempt, this.#opts.reconnect));
      this.#attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteAgentMemory — the async mirror of AgentMemory (the primary deliverable)
// ---------------------------------------------------------------------------

/**
 * The async mirror of {@link AgentMemory}: one method per genuine data
 * operation the facade exposes, each an `async` request/response round trip,
 * each accepting an OPTIONAL trailing `requestId` (H5 passthrough — logged
 * for post-hoc reconciliation, never deduplicated). `trust` / `engine` are
 * deliberately NOT mirrored (see the module doc); `defaultSourceId` is a
 * method (`getDefaultSourceId`), not a property, because it is only known
 * after the async handshake resolves.
 */
export interface RemoteAgentMemory {
  remember(
    input: Parameters<AgentMemory["remember"]>[0],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["remember"]>>;
  recall(
    cue: Parameters<AgentMemory["recall"]>[0],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["recall"]>>;
  ratify(
    strandId: Parameters<AgentMemory["ratify"]>[0],
    source?: Parameters<AgentMemory["ratify"]>[1],
    requestId?: string,
  ): Promise<void>;
  adjudicate(
    attribute: Parameters<AgentMemory["adjudicate"]>[0],
    opts?: Parameters<AgentMemory["adjudicate"]>[1],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["adjudicate"]>>;
  disown(
    sourceId: Parameters<AgentMemory["disown"]>[0],
    opts?: Parameters<AgentMemory["disown"]>[1],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["disown"]>>;
  listPending(requestId?: string): Promise<ReturnType<AgentMemory["listPending"]>>;
  pendingQuestions(requestId?: string): Promise<ReturnType<AgentMemory["pendingQuestions"]>>;
  resolvePending(
    contradictionSetId: Parameters<AgentMemory["resolvePending"]>[0],
    chosenStrandId: Parameters<AgentMemory["resolvePending"]>[1],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["resolvePending"]>>;
  approve(
    contradictionSetId: Parameters<AgentMemory["approve"]>[0],
    winnerStrandId: Parameters<AgentMemory["approve"]>[1],
    approver: Parameters<AgentMemory["approve"]>[2],
    at?: Parameters<AgentMemory["approve"]>[3],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["approve"]>>;
  explain(
    target: Parameters<AgentMemory["explain"]>[0],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["explain"]>>;
  beliefTimeline(
    entity: Parameters<AgentMemory["beliefTimeline"]>[0],
    attribute: Parameters<AgentMemory["beliefTimeline"]>[1],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["beliefTimeline"]>>;
  registerSource(
    source: Parameters<AgentMemory["registerSource"]>[0],
    anchors?: Parameters<AgentMemory["registerSource"]>[1],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["registerSource"]>>;
  stampFor(
    sourceId: Parameters<AgentMemory["stampFor"]>[0],
    requestId?: string,
  ): Promise<ReturnType<AgentMemory["stampFor"]>>;

  /** Resolves once handshaken (H2: the connection's bound acting identity). */
  getDefaultSourceId(): Promise<SourceId>;

  /** NOT reachable remotely (see module doc) — throws synchronously. */
  readonly trust: TrustRegistry;
  /** NOT reachable remotely (see module doc) — throws synchronously. */
  readonly engine: IntelligentDb;

  /** Close the connection; stop reconnecting; fail everything outstanding UNKNOWN. */
  close(): Promise<void>;
}

export interface RemoteAgentMemoryOptions {
  /** The daemon's Unix socket path / Windows named pipe path. */
  readonly socketPath: string;
  /** The bearer token (raw; this module never logs or hashes it — R3 is the daemon's job). */
  readonly token: string;
  readonly reconnect?: ReconnectOptions;
  readonly requestTimeoutMs?: number;
  readonly maxQueuedRequests?: number;
  /** Injectable transport for tests; defaults to a real `node:net` connection. */
  readonly connect?: ConnectFn;
}

/** Build the throws-on-every-access proxy used for the unsupported `trust`/`engine` slots. */
function makeUnsupportedProxy<T extends object>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop): unknown {
        if (typeof prop === "symbol") return undefined;
        return (): never => {
          throw new DaemonRemoteUnsupportedError(`${name}.${String(prop)}`);
        };
      },
    },
  ) as T;
}

/**
 * Build a {@link RemoteAgentMemory}: one `DaemonClientCore` connection,
 * proxying every AgentMemory data verb as an async round trip. Connects
 * (and re-connects, with backoff) automatically in the background; a call
 * issued before the first successful handshake queues (bounded) rather than
 * failing immediately.
 */
export function createRemoteAgentMemory(opts: RemoteAgentMemoryOptions): RemoteAgentMemory {
  const core = new DaemonClientCore({
    connect: opts.connect ?? netConnectFn(opts.socketPath),
    token: opts.token,
    ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.maxQueuedRequests !== undefined ? { maxQueuedRequests: opts.maxQueuedRequests } : {}),
  });

  const call = (method: DaemonMethod, params: unknown, requestId?: string): Promise<unknown> =>
    core.request(method, params, requestId);

  return {
    remember: (input, requestId) =>
      call("remember", input, requestId) as ReturnType<RemoteAgentMemory["remember"]>,
    recall: (cue, requestId) => call("recall", cue, requestId) as ReturnType<RemoteAgentMemory["recall"]>,
    ratify: async (strandId, source, requestId) => {
      await call("ratify", { strandId, source }, requestId);
    },
    adjudicate: (attribute, adjOpts, requestId) =>
      call("adjudicate", { attribute, opts: adjOpts }, requestId) as ReturnType<
        RemoteAgentMemory["adjudicate"]
      >,
    disown: (sourceId, disownOpts, requestId) =>
      call("disown", { sourceId, opts: disownOpts }, requestId) as ReturnType<
        RemoteAgentMemory["disown"]
      >,
    listPending: (requestId) =>
      call("listPending", undefined, requestId) as ReturnType<RemoteAgentMemory["listPending"]>,
    pendingQuestions: (requestId) =>
      call("pendingQuestions", undefined, requestId) as ReturnType<
        RemoteAgentMemory["pendingQuestions"]
      >,
    resolvePending: (contradictionSetId, chosenStrandId, requestId) =>
      call("resolvePending", { contradictionSetId, chosenStrandId }, requestId) as ReturnType<
        RemoteAgentMemory["resolvePending"]
      >,
    approve: (contradictionSetId, winnerStrandId, approver, at, requestId) =>
      call("approve", { contradictionSetId, winnerStrandId, approver, at }, requestId) as ReturnType<
        RemoteAgentMemory["approve"]
      >,
    explain: (target, requestId) =>
      call("explain", { target }, requestId) as ReturnType<RemoteAgentMemory["explain"]>,
    beliefTimeline: (entity, attribute, requestId) =>
      call("beliefTimeline", { entity, attribute }, requestId) as ReturnType<
        RemoteAgentMemory["beliefTimeline"]
      >,
    registerSource: (source, anchors, requestId) =>
      call("registerSource", { source, anchors }, requestId) as ReturnType<
        RemoteAgentMemory["registerSource"]
      >,
    stampFor: (sourceId, requestId) =>
      call("stampFor", sourceId, requestId) as ReturnType<RemoteAgentMemory["stampFor"]>,

    getDefaultSourceId: async () => (await core.waitUntilReady()) as SourceId,

    trust: makeUnsupportedProxy<TrustRegistry>("trust"),
    engine: makeUnsupportedProxy<IntelligentDb>("engine"),

    close: async () => {
      core.close();
    },
  };
}
