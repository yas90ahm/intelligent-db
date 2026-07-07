/**
 * daemon/server.ts — THE DAEMON TRANSPORT (PHASE3_DAEMON_SPEC.md, deliverable 1
 * server portion): `node:net` unix-socket/named-pipe listener, handshake-first
 * auth (H1), identity binding (H2), a single FIFO write-serialization queue
 * (R4/H3), admin verbs (R3), resource limits (H6), graceful shutdown (R6), and
 * stale-socket recovery on start (R6).
 *
 * WIRE PROTOCOL: `daemon/protocol.ts` (a small, shared, mostly-type-only
 * contract module both this file and `daemon/client.ts`'s
 * `createRemoteAgentMemory` build against) — line-delimited JSON, ONE
 * request/response per line, reusing `mcp/server.ts`'s
 * {@link "./protocol".BoundedLineSplitter} / {@link "./protocol".MAX_LINE_BYTES}
 * verbatim (re-exported from there by `protocol.ts`):
 *
 *   1. The FIRST line on every connection MUST be a {@link DaemonAuthRequest}
 *      (`{"method":"auth","token":"..."}`, an OPTIONAL extra `requestId` for
 *      H5). Any other first line, malformed JSON, an oversized line, 5s of
 *      silence, or an unknown/revoked token → the connection is DROPPED after
 *      a fixed 1s rate-limiting delay (H1), responding with a
 *      {@link DaemonAuthResponse} `{ok:false, error:"..."}` — the raw token is
 *      NEVER echoed (R3). Success responds `{ok:true, defaultSourceId}` (H2:
 *      the connection's bound acting identity). Exactly ONE auth attempt is
 *      honored per connection.
 *   2. Every subsequent line is a {@link DaemonRequestEnvelope}
 *      (`{id,method,params,requestId?}`) where `method` is either one of the
 *      four ADMIN VERBS (`issueToken`/`revokeToken`/`revokeAllTokens`/
 *      `reloadTokens` — OWNER-grade connections only, R3; NOT part of
 *      `protocol.ts`'s {@link DaemonMethod} union, since those are
 *      daemon-management verbs, not `AgentMemory` data verbs) or one of
 *      {@link DAEMON_METHODS} — the FULL `AgentMemory` surface
 *      `daemon/client.ts`'s `createRemoteAgentMemory` proxies one round trip
 *      per call. The response is a {@link DaemonResponseEnvelope}
 *      (`{id,ok,result?,error?}`).
 *
 * H2 IDENTITY BINDING: the connection's resolved {@link SourceId} (bound once,
 * at handshake, via `trustRegistry.registerDaemonClient`) is substituted for
 * the ACTOR on every call that takes one (`remember`'s `source`, `ratify`'s
 * `source`, `approve`'s `approver`) — whatever the request payload says is
 * IGNORED for that purpose. Enforced by construction: the dispatch table below
 * never reads an actor/source/approver field out of `params` for identity.
 *
 * H3 SERIALIZATION: every dispatched call — admin verb or AgentMemory method —
 * runs through ONE {@link FifoQueue}, which enforces (by a runtime-checked
 * invariant, not merely by convention) that at most one item executes at a
 * time, strictly in submission order, even though the queue's own drain loop
 * is `async` (future-proofing a handler that legitimately needs an `await`).
 *
 * ZERO new runtime deps: `node:net`, `node:crypto` (a pipe-suffix's randomness),
 * `node:fs` (stale-socket recovery) only.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";

import {
  BoundedLineSplitter,
  MAX_LINE_BYTES,
  DAEMON_ERR_INTERNAL,
  DAEMON_ERR_BACKPRESSURE,
  DAEMON_ERR_CONNECTION_CAP,
  DAEMON_ERR_REVOKED,
  DAEMON_ERR_ADMIN_FORBIDDEN,
  DAEMON_ERR_METHOD_NOT_FOUND,
  DAEMON_ERR_OVERSIZED_LINE,
  DAEMON_ERR_INSUFFICIENT_GRADE,
  DAEMON_ERR_INVALID_ANCHOR,
} from "./protocol.js";
import type { DaemonAuthResponse, DaemonResponseEnvelope } from "./protocol.js";

import { AnchorClass } from "../core/types.js";
import type {
  AnchorBinding,
  AttributeKey,
  ContradictionSetId,
  EpochMs,
  SourceId,
  StrandId,
} from "../core/types.js";
import { ANCHOR_TABLE, STAKE_INDEPENDENCE_MAX } from "../identity/anchors.js";
import type { Cue } from "../recall/cueResolver.js";
import type { AdjudicateOptions, DisownOptions } from "../api.js";
import type { AgentMemory, RememberInput } from "../agent/agentMemory.js";
import type { SourceRef } from "../identity/sources.js";
import type { TrustRegistry } from "../identity/trustRegistry.js";

import { fingerprintToken } from "./tokens.js";
import type { TokenStore } from "./tokens.js";
import type { DaemonAuditChain } from "./auditChain.js";

// ---------------------------------------------------------------------------
// Resource-limit defaults (R5 / H6)
// ---------------------------------------------------------------------------

/** R5: "Connection cap 32, enforced". */
export const DEFAULT_MAX_CONNECTIONS = 32;
/** H6: "max queue depth (default 1024, over → typed backpressure error)". */
export const DEFAULT_MAX_QUEUE_DEPTH = 1024;
/** H1: "5 seconds of handshake silence → connection dropped". */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
/** H1: "fixed 1s delay before the failure response". */
export const DEFAULT_AUTH_FAILURE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// The FIFO queue (H3) — exported standalone so its invariant is unit-testable
// independent of sockets.
// ---------------------------------------------------------------------------

export class FifoBackpressureError extends Error {
  constructor(public readonly maxDepth: number) {
    super(`Daemon request queue at capacity (${maxDepth}); request rejected.`);
    this.name = "FifoBackpressureError";
  }
}

interface QueueItem {
  readonly ownerId: number;
  readonly run: () => void | Promise<void>;
}

/**
 * A single-worker FIFO: {@link enqueue}d tasks run strictly in submission order,
 * ONE AT A TIME. `#executing` is the H3 runtime guard: it is set immediately
 * before a task starts and cleared immediately after, and the drain loop
 * REFUSES to pop a second task while it is `true` — the exact "queue depth is 1
 * while a request executes" invariant, checked on every iteration rather than
 * assumed from the code's shape (so a future bug that makes the drain loop
 * re-entrant is caught, not silently trusted).
 */
export class FifoQueue {
  readonly #maxDepth: number;
  #items: QueueItem[] = [];
  #executing = false;
  #draining = false;
  #currentOwnerId: number | null = null;

  constructor(maxDepth: number = DEFAULT_MAX_QUEUE_DEPTH) {
    this.#maxDepth = maxDepth;
  }

  get depth(): number {
    return this.#items.length;
  }

  get isExecuting(): boolean {
    return this.#executing;
  }

  get currentOwnerId(): number | null {
    return this.#currentOwnerId;
  }

  /** Whether any item (queued OR currently executing) belongs to `ownerId`. */
  hasOwner(ownerId: number): boolean {
    return this.#currentOwnerId === ownerId || this.#items.some((i) => i.ownerId === ownerId);
  }

  /**
   * Enqueue one task, tagged with its owning connection id (used to prune /
   * detect ownership on revocation). Throws {@link FifoBackpressureError}
   * SYNCHRONOUSLY (H6) when the queue is already at `maxDepth` — the caller
   * responds to the SUBMITTING connection only; every other connection is
   * unaffected.
   */
  enqueue(ownerId: number, run: () => void | Promise<void>): void {
    if (this.#items.length >= this.#maxDepth) {
      throw new FifoBackpressureError(this.#maxDepth);
    }
    this.#items.push({ ownerId, run });
    if (!this.#draining) {
      this.#draining = true;
      void this.#drain();
    }
  }

  /** Remove every NOT-YET-STARTED item owned by `ownerId`, never touching a
   * currently-executing one. */
  pruneOwner(ownerId: number): void {
    this.#items = this.#items.filter((i) => i.ownerId !== ownerId);
  }

  /** Resolves once the queue is fully drained (used by graceful shutdown, R6). */
  async whenDrained(): Promise<void> {
    while (this.#draining || this.#items.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async #drain(): Promise<void> {
    while (this.#items.length > 0) {
      if (this.#executing) {
        // H3's runtime guard: this line is UNREACHABLE under a correctly
        // sequential drain loop. It exists so a future regression that makes
        // this loop re-entrant (two overlapping drains touching `#items`) is
        // CAUGHT — never silently permitted to interleave two compound writes.
        throw new Error(
          "FifoQueue invariant violated: a second item began executing before " +
            "the first finished (queue depth must be exactly 1 while executing).",
        );
      }
      const item = this.#items.shift()!;
      this.#executing = true;
      this.#currentOwnerId = item.ownerId;
      try {
        await item.run();
      } finally {
        this.#executing = false;
        this.#currentOwnerId = null;
      }
    }
    this.#draining = false;
  }
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

interface ConnectionState {
  readonly id: number;
  readonly socket: net.Socket;
  readonly splitter: BoundedLineSplitter;
  authAttempted: boolean;
  authenticated: boolean;
  /** True once a handshake failure has been recorded — ignore anything further. */
  dropped: boolean;
  sourceId: SourceId | null;
  grade: AnchorClass | null;
  fingerprint: string | null;
  revoked: boolean;
  pendingCloseAfterDrain: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Admin verbs (R3) — daemon-management verbs, NOT part of protocol.ts's
// AgentMemory-only DaemonMethod union, but riding the SAME envelope shape.
// ---------------------------------------------------------------------------

const ADMIN_VERBS = new Set(["issueToken", "revokeToken", "revokeAllTokens", "reloadTokens"]);

function isAdminVerb(method: string): boolean {
  return ADMIN_VERBS.has(method);
}

function parseGrade(v: unknown): AnchorClass | null {
  if (typeof v !== "string") return null;
  return (Object.values(AnchorClass) as string[]).includes(v) ? (v as AnchorClass) : null;
}

// ---------------------------------------------------------------------------
// daemon-unauthorized-trust-mutation fix: TRUST-MUTATING AgentMemory verbs
// require the SAME per-grade (OWNER-only) authorization check as the four
// admin verbs above. Before this fix, MEMORY_METHODS dispatched
// registerSource/disown/approve/adjudicate/ratify to ANY authenticated
// connection regardless of `state.grade` — defeating the entire trust model
// from outside the engine (any minted, even EMAIL_OAUTH-grade, token could
// mint itself an OWNER anchor via registerSource, or disown/approve/adjudicate/
// ratify arbitrary sources/strands). All five mutate durable trust/belief
// state and are gated OWNER-only, mirroring `#dispatchAdminVerb`'s check.
// ---------------------------------------------------------------------------

const TRUST_MUTATING_VERBS = new Set(["registerSource", "disown", "approve", "adjudicate", "ratify"]);

function isTrustMutatingVerb(method: string): boolean {
  return TRUST_MUTATING_VERBS.has(method);
}

/** Thrown by the `registerSource` handler when a caller-supplied anchor binding
 * is invalid; mapped to {@link DAEMON_ERR_INVALID_ANCHOR} by `#dispatchMemoryCall`. */
class AnchorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorValidationError";
  }
}

/**
 * daemon-unauthorized-trust-mutation fix (2nd half): `registerSource`'s wire
 * `anchors` are free-form caller-supplied data — `TrustRegistry.bind()` (the
 * path they land on) is purely additive/unvalidated against `ANCHOR_TABLE`, so
 * without this check a caller could submit e.g.
 * `{anchorClass:'OWNER', independenceWeight:1, realizedCost:1}` and mint a
 * stronger anchor than OWNER's OWN canonical ceiling (0.9) permits, onto ANY
 * source id (not even necessarily the caller's own). Reject the WHOLE
 * `registerSource` call (never silently clamp — a silent clamp would still let
 * a forged low-cost class name carry inflated weight through unnoticed) if any
 * binding names an unknown `AnchorClass`, or claims an `independenceWeight`/
 * `realizedCost` above that class's `ANCHOR_TABLE` ceiling.
 */
function validateAnchorBindings(anchors: readonly AnchorBinding[]): void {
  for (const a of anchors) {
    const spec = ANCHOR_TABLE[a.anchorClass];
    if (spec === undefined) {
      throw new AnchorValidationError(`registerSource: unknown anchorClass ${JSON.stringify(a.anchorClass)}.`);
    }
    // FINANCIAL_STAKE is deliberately stake-scaled: ANCHOR_TABLE's row stores
    // the FLOOR of its 0.30-0.85 range (the realized value depends on posted
    // deposit size), so its true ceiling is STAKE_INDEPENDENCE_MAX, not the
    // table row's own independenceWeight.
    const ceiling =
      a.anchorClass === AnchorClass.FINANCIAL_STAKE ? STAKE_INDEPENDENCE_MAX : spec.independenceWeight;
    if (a.independenceWeight > ceiling || a.realizedCost > ceiling) {
      throw new AnchorValidationError(
        `registerSource: anchor binding for ${a.anchorClass} exceeds its ANCHOR_TABLE ceiling ` +
          `(independenceWeight/realizedCost must be <= ${ceiling}).`,
      );
    }
    if (a.independenceWeight < 0 || a.realizedCost < 0) {
      throw new AnchorValidationError(`registerSource: anchor binding for ${a.anchorClass} has a negative weight/cost.`);
    }
  }
}

// ---------------------------------------------------------------------------
// AgentMemory method dispatch table — H2's identity binding lives HERE: every
// handler that names an actor takes it from `actor` (the connection's bound
// SourceId), never from `params`. Params SHAPES below match EXACTLY what
// `daemon/client.ts`'s `createRemoteAgentMemory` sends on the wire per method
// (see that module's `call(...)` invocations) — this is the shared contract.
// ---------------------------------------------------------------------------

type MemoryHandler = (memory: AgentMemory, params: unknown, actor: SourceId) => unknown;

const MEMORY_METHODS: Record<string, MemoryHandler> = {
  remember: (memory, params, actor) => {
    const input = params as RememberInput;
    // H2: the request's own `source` (if any) is DISCARDED — the connection's
    // bound identity is the only actor a daemon-served remember() may file under.
    return memory.remember({ ...input, source: { sourceId: actor } });
  },
  recall: (memory, params) => memory.recall(params as string | Cue),
  ratify: (memory, params, actor) => {
    const p = params as { strandId: StrandId };
    memory.ratify(p.strandId, { sourceId: actor });
    return null;
  },
  adjudicate: (memory, params) => {
    const p = params as { attribute: AttributeKey; opts?: AdjudicateOptions };
    return memory.adjudicate(p.attribute, p.opts);
  },
  disown: (memory, params) => {
    const p = params as { sourceId: SourceId; opts?: DisownOptions };
    return memory.disown(p.sourceId, p.opts);
  },
  listPending: (memory) => memory.listPending(),
  pendingQuestions: (memory) => memory.pendingQuestions(),
  resolvePending: (memory, params) => {
    const p = params as { contradictionSetId: ContradictionSetId; chosenStrandId: StrandId };
    return memory.resolvePending(p.contradictionSetId, p.chosenStrandId);
  },
  approve: (memory, params, actor) => {
    const p = params as { contradictionSetId: ContradictionSetId; winnerStrandId: StrandId; at?: EpochMs };
    // H2: `approver` is FORCED to the connection's bound identity — a payload
    // can never claim to approve as some other source (any client-supplied
    // `approver` field is simply never read here).
    return memory.approve(p.contradictionSetId, p.winnerStrandId, actor, p.at);
  },
  explain: (memory, params) => {
    const p = params as { target: StrandId };
    return memory.explain(p.target);
  },
  beliefTimeline: (memory, params) => {
    const p = params as { entity: string; attribute: string };
    return memory.beliefTimeline(p.entity, p.attribute);
  },
  registerSource: (memory, params) => {
    const p = params as { source: SourceRef; anchors?: readonly AnchorBinding[] };
    if (p.anchors !== undefined) validateAnchorBindings(p.anchors);
    return memory.registerSource(p.source, p.anchors);
  },
  stampFor: (memory, params) => memory.stampFor(params as SourceId),
};

// ---------------------------------------------------------------------------
// Response helpers (protocol.ts shapes)
// ---------------------------------------------------------------------------

function envOk(id: number, result: unknown): DaemonResponseEnvelope {
  return { id, ok: true, result };
}

function envErr(id: number, code: string, message: string): DaemonResponseEnvelope {
  return { id, ok: false, error: { code, message } };
}

function authOk(sourceId: string): DaemonAuthResponse {
  return { ok: true, defaultSourceId: sourceId };
}

function authErr(reason: string): DaemonAuthResponse {
  return { ok: false, error: reason };
}

// ---------------------------------------------------------------------------
// Endpoint computation (R9: random-suffix pipe name on Windows)
// ---------------------------------------------------------------------------

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * R9: on Windows, mint a FRESH high-entropy random suffix at every daemon start
 * and append it to `base` (a friendly pipe name/prefix) — the resulting
 * endpoint is written ONLY into the user-private token file (R1), never
 * advertised anywhere else, so discovering it requires reading that file. On
 * POSIX, `base` is used verbatim as the socket file path (whose OS permission
 * bits are the isolation mechanism — see `tokens.ts`'s R1 doc).
 */
export function computeEndpoint(base: string): string {
  if (process.platform !== "win32") return base;
  const name = base.startsWith(WINDOWS_PIPE_PREFIX)
    ? base.slice(WINDOWS_PIPE_PREFIX.length)
    : base;
  const suffix = randomBytes(16).toString("hex");
  return `${WINDOWS_PIPE_PREFIX}${name}-${suffix}`;
}

/**
 * R6 stale-socket recovery (POSIX only — Windows pipes never leave a stale
 * filesystem entry, and {@link computeEndpoint} mints a fresh name every start
 * anyway, so there is nothing to recover there). Gated on `process.platform`
 * per this lane's brief: try-connect; ECONNREFUSED ⇒ remove the stale file and
 * let `listen` create a fresh one; a successful connect ⇒ a live daemon already
 * owns this path, so refuse to start rather than stealing the socket.
 */
export async function recoverStaleSocket(path: string): Promise<void> {
  if (process.platform === "win32") return;
  if (!existsSync(path)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(path);
    const settle = (v: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(v);
    };
    probe.once("connect", () => settle(true));
    probe.once("error", () => settle(false));
  });
  if (alive) {
    throw new Error(`daemon: socket ${path} is already in use by a live daemon.`);
  }
  unlinkSync(path);
}

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

export interface DaemonServerOptions {
  readonly memory: AgentMemory;
  readonly tokens: TokenStore;
  readonly auditChain: DaemonAuditChain;
  readonly trustRegistry: TrustRegistry;
  /** POSIX: the socket file path. Windows: a friendly pipe-name prefix. */
  readonly endpointBase: string;
  readonly maxConnections?: number;
  readonly maxQueueDepth?: number;
  readonly handshakeTimeoutMs?: number;
  readonly authFailureDelayMs?: number;
  readonly clock?: () => number;
}

export interface DaemonStartResult {
  readonly endpoint: string;
}

export class DaemonServer {
  readonly #memory: AgentMemory;
  readonly #tokens: TokenStore;
  readonly #auditChain: DaemonAuditChain;
  readonly #trustRegistry: TrustRegistry;
  readonly #endpointBase: string;
  readonly #maxConnections: number;
  readonly #handshakeTimeoutMs: number;
  readonly #authFailureDelayMs: number;
  readonly #clock: () => number;
  readonly #queue: FifoQueue;

  #server: net.Server | null = null;
  #endpoint: string | null = null;
  #nextConnId = 1;
  readonly #connections = new Map<number, ConnectionState>();
  readonly #fingerprintToConnIds = new Map<string, Set<number>>();
  #shuttingDown = false;

  constructor(opts: DaemonServerOptions) {
    this.#memory = opts.memory;
    this.#tokens = opts.tokens;
    this.#auditChain = opts.auditChain;
    this.#trustRegistry = opts.trustRegistry;
    this.#endpointBase = opts.endpointBase;
    this.#maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#authFailureDelayMs = opts.authFailureDelayMs ?? DEFAULT_AUTH_FAILURE_DELAY_MS;
    this.#clock = opts.clock ?? Date.now;
    this.#queue = new FifoQueue(opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH);
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get queueDepth(): number {
    return this.#queue.depth;
  }

  get endpoint(): string | null {
    return this.#endpoint;
  }

  /** R6: bind + listen. Stale-socket recovery (POSIX) + owner-token provisioning (R1/R9). */
  async start(): Promise<DaemonStartResult> {
    const endpoint = computeEndpoint(this.#endpointBase);
    await recoverStaleSocket(endpoint);
    // R1/R9: mint (first run) or reload (subsequent runs) the owner token,
    // (re)writing the endpoint into the user-private token file.
    this.#tokens.ensureOwnerToken(endpoint);

    this.#server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(endpoint, () => {
        this.#server!.removeAllListeners("error");
        resolve();
      });
    });
    this.#endpoint = endpoint;
    return { endpoint };
  }

  /** R6: graceful shutdown — stop accepting, drain the queue, close connections, mark the chain. */
  async stop(opts?: { clean?: boolean }): Promise<void> {
    this.#shuttingDown = true;
    const server = this.#server;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#queue.whenDrained();
    for (const conn of this.#connections.values()) {
      this.#endSocketSafely(conn.socket);
    }
    this.#connections.clear();
    this.#fingerprintToConnIds.clear();
    this.#auditChain.recordShutdown({ clean: opts?.clean ?? true }, this.#clock());
  }

  // ---- connection lifecycle ------------------------------------------------

  #onConnection(socket: net.Socket): void {
    if (this.#shuttingDown) {
      socket.destroy();
      return;
    }
    if (this.#connections.size >= this.#maxConnections) {
      this.#writeLine(socket, authErr(DAEMON_ERR_CONNECTION_CAP));
      socket.end();
      return;
    }

    const id = this.#nextConnId++;
    const state: ConnectionState = {
      id,
      socket,
      splitter: new BoundedLineSplitter(),
      authAttempted: false,
      authenticated: false,
      dropped: false,
      sourceId: null,
      grade: null,
      fingerprint: null,
      revoked: false,
      pendingCloseAfterDrain: false,
      handshakeTimer: null,
    };
    this.#connections.set(id, state);
    state.handshakeTimer = setTimeout(() => this.#failHandshake(state, "TIMEOUT"), this.#handshakeTimeoutMs);

    socket.on("data", (chunk: Buffer) => this.#onData(state, chunk));
    socket.on("close", () => this.#onClose(state));
    socket.on("error", () => {
      /* the "close" handler performs cleanup; nothing else to do here */
    });
  }

  #onClose(state: ConnectionState): void {
    if (state.handshakeTimer !== null) clearTimeout(state.handshakeTimer);
    this.#connections.delete(state.id);
    if (state.fingerprint !== null) {
      const set = this.#fingerprintToConnIds.get(state.fingerprint);
      if (set !== undefined) {
        set.delete(state.id);
        if (set.size === 0) this.#fingerprintToConnIds.delete(state.fingerprint);
      }
    }
  }

  #onData(state: ConnectionState, chunk: Buffer): void {
    if (state.dropped) return; // already tearing down — ignore anything further
    const { lines, overflows } = state.splitter.push(chunk);
    if (overflows > 0) {
      if (!state.authenticated) {
        this.#failHandshake(state, "OVERSIZED_LINE");
        return;
      }
      for (let i = 0; i < overflows; i++) {
        this.#writeLine(
          state.socket,
          envErr(
            -1,
            DAEMON_ERR_OVERSIZED_LINE,
            `Line exceeded MAX_LINE_BYTES (${MAX_LINE_BYTES} bytes) and was discarded.`,
          ),
        );
      }
    }
    for (const line of lines) {
      if (state.dropped || state.socket.destroyed) break;
      this.#onLine(state, line);
    }
  }

  #onLine(state: ConnectionState, line: string): void {
    const trimmed = line.trim();
    if (!state.authenticated) {
      if (trimmed.length === 0) {
        this.#failHandshake(state, "MALFORMED");
        return;
      }
      this.#handleHandshakeLine(state, trimmed);
      return;
    }
    if (trimmed.length === 0) return;

    let req: { id?: unknown; method?: unknown; params?: unknown; requestId?: unknown };
    try {
      req = JSON.parse(trimmed) as typeof req;
    } catch (err) {
      this.#writeLine(
        state.socket,
        envErr(-1, DAEMON_ERR_INTERNAL, `Parse error: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }
    const id = typeof req.id === "number" ? req.id : -1;
    const method = typeof req.method === "string" ? req.method : undefined;
    if (method === undefined) {
      this.#writeLine(state.socket, envErr(id, DAEMON_ERR_METHOD_NOT_FOUND, "Missing 'method'."));
      return;
    }

    if (state.revoked) {
      this.#writeLine(state.socket, envErr(id, DAEMON_ERR_REVOKED, "This connection's token has been revoked."));
      return;
    }

    if (isAdminVerb(method)) {
      this.#dispatchAdminVerb(state, id, method, (req.params ?? {}) as Record<string, unknown>);
      return;
    }
    this.#dispatchMemoryCall(state, id, method, req.params);
  }

  // ---- handshake (H1) -------------------------------------------------------

  #handleHandshakeLine(state: ConnectionState, trimmed: string): void {
    if (state.authAttempted) {
      // Defensive: should be unreachable (the connection is dropped after the
      // first attempt either way), but never allow a second try.
      this.#failHandshake(state, "MALFORMED");
      return;
    }
    state.authAttempted = true;

    let msg: { method?: string; token?: string; requestId?: string };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      this.#failHandshake(state, "MALFORMED");
      return;
    }
    if (
      msg === null ||
      typeof msg !== "object" ||
      msg.method !== "auth" ||
      typeof msg.token !== "string" ||
      msg.token.length === 0
    ) {
      this.#failHandshake(state, "WRONG_FIRST_METHOD");
      return;
    }

    const record = this.#tokens.verify(msg.token);
    if (record === null) {
      this.#failHandshake(state, "UNKNOWN_OR_REVOKED_TOKEN", fingerprintToken(msg.token));
      return;
    }

    if (state.handshakeTimer !== null) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    }

    const ref = this.#trustRegistry.registerDaemonClient({
      tokenFingerprint: record.fingerprint,
      grade: record.grade,
      ...(record.label !== undefined ? { label: record.label } : {}),
    });
    state.authenticated = true;
    state.sourceId = ref.sourceId;
    state.grade = record.grade;
    state.fingerprint = record.fingerprint;
    this.#trackFingerprint(record.fingerprint, state.id);

    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    this.#auditChain.recordConnectionAccepted(
      {
        fingerprint: record.fingerprint,
        sourceId: String(ref.sourceId),
        ...(requestId !== undefined ? { requestId } : {}),
      },
      this.#clock(),
    );

    this.#writeLine(state.socket, authOk(String(ref.sourceId)));
  }

  #failHandshake(
    state: ConnectionState,
    reason: "MALFORMED" | "OVERSIZED_LINE" | "WRONG_FIRST_METHOD" | "TIMEOUT" | "UNKNOWN_OR_REVOKED_TOKEN",
    fingerprint?: string,
  ): void {
    if (state.dropped) return; // never double-record / double-respond (H1: exactly one attempt)
    state.dropped = true;
    if (state.handshakeTimer !== null) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    }
    this.#auditChain.recordAuthFailure(
      { reason, ...(fingerprint !== undefined ? { fingerprint } : {}) },
      this.#clock(),
    );
    // H1: fixed 1s delay before the failure response (rate-limits a repeated-
    // failure loop from new connections), then drop — no retry on this connection.
    setTimeout(() => {
      this.#writeLine(state.socket, authErr("authentication failed"));
      this.#endSocketSafely(state.socket);
    }, this.#authFailureDelayMs);
  }

  #trackFingerprint(fingerprint: string, connId: number): void {
    let set = this.#fingerprintToConnIds.get(fingerprint);
    if (set === undefined) {
      set = new Set();
      this.#fingerprintToConnIds.set(fingerprint, set);
    }
    set.add(connId);
  }

  // ---- request dispatch (H3 — through the ONE FifoQueue) --------------------

  #dispatchMemoryCall(state: ConnectionState, id: number, method: string, params: unknown): void {
    const handler = MEMORY_METHODS[method];
    if (handler === undefined) {
      this.#writeLine(state.socket, envErr(id, DAEMON_ERR_METHOD_NOT_FOUND, `Unknown method: ${method}`));
      return;
    }
    // daemon-unauthorized-trust-mutation fix: the SAME per-grade authorization
    // check `#dispatchAdminVerb` applies to the four admin verbs, applied here
    // to the five TRUST-MUTATING AgentMemory verbs (registerSource/disown/
    // approve/adjudicate/ratify) — checked BEFORE enqueueing, so a rejected
    // call never even occupies a FIFO slot.
    if (isTrustMutatingVerb(method) && state.grade !== AnchorClass.OWNER) {
      this.#writeLine(
        state.socket,
        envErr(
          id,
          DAEMON_ERR_INSUFFICIENT_GRADE,
          `Method '${method}' mutates trust state and requires an OWNER-grade connection.`,
        ),
      );
      return;
    }
    this.#enqueue(state, () => {
      try {
        const result = handler(this.#memory, params, state.sourceId!);
        this.#writeLine(state.socket, envOk(id, result));
      } catch (err) {
        const code = err instanceof AnchorValidationError ? DAEMON_ERR_INVALID_ANCHOR : DAEMON_ERR_INTERNAL;
        this.#writeLine(state.socket, envErr(id, code, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  #dispatchAdminVerb(state: ConnectionState, id: number, method: string, params: Record<string, unknown>): void {
    if (state.grade !== AnchorClass.OWNER) {
      this.#writeLine(
        state.socket,
        envErr(id, DAEMON_ERR_ADMIN_FORBIDDEN, "Admin verbs require an OWNER-grade connection."),
      );
      return;
    }
    this.#enqueue(state, () => this.#executeAdminVerb(state, id, method, params));
  }

  #enqueue(state: ConnectionState, run: () => void): void {
    try {
      this.#queue.enqueue(state.id, () => {
        run();
        this.#afterExecute(state.id);
      });
    } catch (err) {
      if (err instanceof FifoBackpressureError) {
        // H6: typed backpressure — ONLY the submitting connection is told.
        this.#writeLine(state.socket, envErr(-1, DAEMON_ERR_BACKPRESSURE, err.message));
        return;
      }
      throw err;
    }
  }

  #afterExecute(connId: number): void {
    const conn = this.#connections.get(connId);
    if (conn !== undefined && conn.pendingCloseAfterDrain && !this.#queue.hasOwner(connId)) {
      this.#endSocketSafely(conn.socket);
    }
  }

  #executeAdminVerb(state: ConnectionState, id: number, method: string, params: Record<string, unknown>): void {
    const actorSourceId = String(state.sourceId!);
    switch (method) {
      case "issueToken": {
        const grade = parseGrade(params["grade"]) ?? AnchorClass.EMAIL_OAUTH;
        const label = typeof params["label"] === "string" ? params["label"] : undefined;
        const minted = this.#tokens.mint(grade, label);
        this.#auditChain.recordAdminVerb(
          { verb: "issueToken", actorSourceId, detail: minted.record.fingerprint },
          this.#clock(),
        );
        // The RAW token is returned ONLY here, in the direct response to the
        // requesting OWNER connection — never logged, audited, or persisted
        // beyond this one response (R3).
        this.#writeLine(
          state.socket,
          envOk(id, { token: minted.raw, fingerprint: minted.record.fingerprint, grade: minted.record.grade }),
        );
        return;
      }
      case "revokeToken": {
        const fingerprint = params["fingerprint"];
        if (typeof fingerprint !== "string") {
          this.#writeLine(state.socket, envErr(id, DAEMON_ERR_INTERNAL, "revokeToken requires 'fingerprint'."));
          return;
        }
        const revoked = this.#tokens.revoke(fingerprint);
        if (revoked) {
          this.#auditChain.recordRevocation({ fingerprint, revokedBySourceId: actorSourceId }, this.#clock());
          this.#dropConnectionsFor(fingerprint, state.id);
        }
        this.#auditChain.recordAdminVerb(
          { verb: "revokeToken", actorSourceId, detail: fingerprint },
          this.#clock(),
        );
        this.#writeLine(state.socket, envOk(id, { revoked }));
        return;
      }
      case "revokeAllTokens": {
        const { revokedFingerprints, newOwnerToken } = this.#tokens.revokeAllTokens(
          state.fingerprint,
          this.#endpoint ?? this.#endpointBase,
        );
        for (const fp of revokedFingerprints) {
          this.#auditChain.recordRevocation({ fingerprint: fp, revokedBySourceId: actorSourceId }, this.#clock());
          this.#dropConnectionsFor(fp, state.id);
        }
        this.#auditChain.recordAdminVerb(
          { verb: "revokeAllTokens", actorSourceId, detail: `count:${revokedFingerprints.length}` },
          this.#clock(),
        );
        this.#writeLine(
          state.socket,
          envOk(id, {
            revokedCount: revokedFingerprints.length,
            ownerToken: newOwnerToken.raw,
            ownerFingerprint: newOwnerToken.record.fingerprint,
          }),
        );
        return;
      }
      case "reloadTokens": {
        this.#tokens.reloadTokens();
        this.#auditChain.recordAdminVerb({ verb: "reloadTokens", actorSourceId }, this.#clock());
        this.#writeLine(state.socket, envOk(id, { ok: true }));
        return;
      }
      default:
        this.#writeLine(state.socket, envErr(id, DAEMON_ERR_METHOD_NOT_FOUND, `Unknown admin verb: ${method}`));
    }
  }

  /** R3: revocation takes effect IMMEDIATELY — drop matching connections (except `exceptConnId`). */
  #dropConnectionsFor(fingerprint: string, exceptConnId: number): void {
    const ids = this.#fingerprintToConnIds.get(fingerprint);
    if (ids === undefined) return;
    for (const connId of [...ids]) {
      if (connId === exceptConnId) continue;
      const conn = this.#connections.get(connId);
      if (conn === undefined) continue;
      conn.revoked = true;
      this.#queue.pruneOwner(connId); // queued-not-started requests are simply dropped
      if (this.#queue.hasOwner(connId)) {
        // An in-flight request for this connection is currently executing; let
        // it finish and deliver its response (R3: "in-flight request completes
        // — it was authorized when dequeued"), then close.
        conn.pendingCloseAfterDrain = true;
      } else {
        this.#endSocketSafely(conn.socket);
      }
    }
  }

  // ---- I/O helpers ------------------------------------------------------------

  #writeLine(socket: net.Socket, response: DaemonAuthResponse | DaemonResponseEnvelope): void {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // best-effort — a write racing a close is not a server fault.
    }
  }

  #endSocketSafely(socket: net.Socket): void {
    try {
      socket.end();
    } catch {
      // best-effort
    }
  }
}
