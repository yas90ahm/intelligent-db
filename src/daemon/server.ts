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
import { InvalidQuarantineThresholdError } from "../api.js";
import type { AdjudicateOptions, DisownOptions } from "../api.js";
import type { AgentMemory, RememberInput } from "../agent/agentMemory.js";
import type { SourceRef } from "../identity/sources.js";
import type { TrustRegistry } from "../identity/trustRegistry.js";
import { OffLedgerReputationError } from "../ratification/reconcile.js";
import { UnverifiedLedgerRestoreError } from "../store/backup.js";
import { EncryptedStoreIntegrityError } from "../store/encryptedStore.js";
import { UnknownFutureSchemaError } from "../store/migrations.js";
import { SharedHandleNotWalError } from "../store/sqliteStore.js";

import { fingerprintToken } from "./tokens.js";
import type { TokenStore } from "./tokens.js";
import type { DaemonAuditChain, DaemonLedgerRecord } from "./auditChain.js";
import type { ChainHead as FactChainHead, ChainVerification as FactChainVerification } from "../ratification/pendingLedger.js";
import { daemonLog } from "./log.js";

// ---------------------------------------------------------------------------
// Resource-limit defaults (R5 / H6)
// ---------------------------------------------------------------------------

/**
 * R5: "Connection cap 32, enforced" — daemon-connection-slot-exhaustion fix:
 * this cap now bounds only AUTHENTICATED connections (see `#onConnection`), so
 * it is a genuine reservation for token-holding callers, never a pool an
 * unauthenticated flood can exhaust.
 */
export const DEFAULT_MAX_CONNECTIONS = 32;
/**
 * daemon-connection-slot-exhaustion fix: a SEPARATE, smaller ceiling on
 * sockets that have NOT yet completed the handshake. Without this, an
 * unauthenticated connection was previously indistinguishable from an
 * authenticated one for capacity purposes — a trivial local attacker holding
 * open `maxConnections` silent sockets (each occupying its slot for up to
 * `handshakeTimeoutMs + authFailureDelayMs`) starved every legitimate,
 * token-holding client with `CONNECTION_CAP` forever. This ceiling is
 * independent of (and does not draw down) `maxConnections`.
 */
export const DEFAULT_MAX_PENDING_HANDSHAKES = 8;
/** H6: "max queue depth (default 1024, over → typed backpressure error)". */
export const DEFAULT_MAX_QUEUE_DEPTH = 1024;
/**
 * H1: "5 seconds of handshake silence → connection dropped" — tightened
 * (40%) by the daemon-connection-slot-exhaustion fix: a shorter
 * unauthenticated-handshake window bounds how long a silent/slow-loris socket
 * can occupy one of the `maxPendingHandshakes` slots above, on top of the
 * separate capacity fix. Still generous for a real client (auth is one local
 * round trip) and for a deliberately-throttled/chunked one (the existing
 * slow-loris E2E regression trickles a real ~94-byte auth line one byte
 * every 20ms — ~1.9s — and must keep succeeding).
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;
/** H1: "fixed 1s delay before the failure response". */
export const DEFAULT_AUTH_FAILURE_DELAY_MS = 1000;
/**
 * status-ping-blocks-event-loop fix (a re-audit finding, 2026-07-07):
 * `status`/`ping` is DELIBERATELY dispatched OUTSIDE the FIFO queue, directly
 * on the socket's `data` handler (see {@link STATUS_VERBS}'s doc comment),
 * precisely so a slow/backed-up write path can never stall a health check.
 * But the OPTIONAL `factChainHead` callback (wired by `daemon/cli.ts` — see
 * `DaemonServerOptions.factChainHead`'s doc) opens a FRESH SQLite connection
 * and rebuilds the WHOLE ratification-ledger open-dispute index from scratch
 * on every invocation (`createSqlitePendingLedger`'s constructor — O(n) over
 * the ledger's full history), paid SYNCHRONOUSLY on the single Node.js
 * event-loop thread (`node:sqlite`'s `DatabaseSync` has no async variant).
 * Before this fix, `#dispatchStatusVerb` called it INLINE on every `status`
 * request — so a caller polling `status` frequently (exactly what
 * OPERATIONS.md tells an operator to do) repeatedly re-triggered that O(n)
 * cost directly on the hot request-serving thread, stalling every OTHER
 * connected client's I/O for its duration on every single poll: the more
 * aggressively a caller (or an attacker) polled, the more often the whole
 * daemon stalled — the exact opposite of "never blocks a health check."
 * Fixed: `#dispatchStatusVerb` now reads a CACHED value, refreshed on the
 * daemon's OWN bounded cadence (this constant) via a background timer
 * started in `start()` and cleared in `stop()` — never inline on a request.
 * The cache is warmed SYNCHRONOUSLY once during `start()` (so the very first
 * `status` call already has a value) and refreshed no more often than this
 * interval regardless of how aggressively a client polls `status`/`ping` —
 * decoupling caller poll frequency from the daemon's actual I/O cadence
 * entirely. See `daemon/__tests__/server.test.ts`'s
 * "factChainHead caching" cases for the regression coverage.
 */
export const DEFAULT_FACT_CHAIN_HEAD_REFRESH_MS = 5_000;

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
  readonly #onItemError: (err: unknown, ownerId: number) => void;
  #items: QueueItem[] = [];
  #executing = false;
  #draining = false;
  #currentOwnerId: number | null = null;

  /**
   * @param maxDepth Backpressure ceiling (H6).
   * @param onItemError daemon-auditchain-write-crashes-process fix: invoked
   *   when a queued item's `run()` throws/rejects — the LAST-RESORT backstop
   *   for whatever slips past a caller's own per-item try/catch (every
   *   `DaemonServer` call site wraps its own `run` and turns a failure into a
   *   typed per-connection response; this is defense in depth, not the primary
   *   mechanism). Defaults to a `daemonLog` stderr line so a bare `new
   *   FifoQueue()` is never silently unsafe. MUST NOT throw.
   */
  constructor(
    maxDepth: number = DEFAULT_MAX_QUEUE_DEPTH,
    onItemError: (err: unknown, ownerId: number) => void = (err, ownerId) =>
      daemonLog({
        event: "fifo_queue_item_failed",
        message: err instanceof Error ? err.message : String(err),
        ownerId,
      }),
  ) {
    this.#maxDepth = maxDepth;
    this.#onItemError = onItemError;
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
      } catch (err) {
        // daemon-auditchain-write-crashes-process fix: WITHOUT this catch, a
        // throw/rejection here propagated out of this `async` method, and
        // `enqueue()` invokes it as `void this.#drain()` (fire-and-forget) —
        // an unhandled rejection that, with zero global handlers registered
        // (the pre-fix state), crashes the ENTIRE daemon process on the very
        // next queued item's failure. WORSE: because the throw escaped the
        // `while` loop entirely, `this.#draining` below was NEVER reset to
        // `false`, so even a process that survived the rejection would have
        // its queue wedged forever (`enqueue`'s `if (!this.#draining)` guard
        // would never fire `#drain()` again for this instance). Isolating the
        // failure HERE — one item, not the whole queue — is the fix for both.
        this.#onItemError(err, item.ownerId);
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

const ADMIN_VERBS = new Set([
  "issueToken",
  "revokeToken",
  "revokeAllTokens",
  "reloadTokens",
  // verifychain-never-invoked-by-product fix: an on-demand, OWNER-gated verb
  // that self-verifies BOTH checksum chains (see `#executeAdminVerb`'s
  // "verifyChains" case) — a caller no longer has to know to script this.
  "verifyChains",
]);

function isAdminVerb(method: string): boolean {
  return ADMIN_VERBS.has(method);
}

// ---------------------------------------------------------------------------
// no-health-status-surface fix: a LIGHTLY-AUTHENTICATED status/ping verb —
// reachable by ANY authenticated connection regardless of grade (unlike the
// OWNER-only admin verbs above), since a monitoring/health-check caller need
// not hold a privileged token. Dispatched OUTSIDE the FIFO queue (see
// `#dispatchStatusVerb`): it is a pure read of in-memory counters (plus an
// optional external chain lookup), so it must never be forced to wait behind
// a backlog it exists to report on.
// ---------------------------------------------------------------------------

const STATUS_VERBS = new Set(["status", "ping"]);

function isStatusVerb(method: string): boolean {
  return STATUS_VERBS.has(method);
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
// ratify arbitrary sources/strands). All six mutate durable trust/belief
// state and are gated OWNER-only, mirroring `#dispatchAdminVerb`'s check.
//
// resolvePending-trust-bypass fix (a re-audit finding, 2026-07-07): the first
// pass of this fix (above) gated exactly five verbs and MISSED `resolvePending`
// — which is dispatched through the identical `#dispatchMemoryCall` path (see
// `MEMORY_METHODS.resolvePending` below) and carries PERSONAL-tier
// owner-OVERRIDE semantics: `agent/agentMemory.ts`'s facade implementation
// calls `engine.approve(..., defaultSource.sourceId, undefined,
// { allowAuthorApprover: true })` UNCONDITIONALLY, bypassing the
// distinct-approver (self-approval) and RC-5 anchor-independence gates a
// normal `approve()` enforces. Because `resolvePending` was absent from this
// Set, ANY authenticated connection at ANY grade could force-resolve any open
// dispute with owner-override power — the exact vulnerability class the rest
// of this fix closed, reopened one verb over — AND every resulting ledger
// APPROVAL record was committed with `approverSourceId: defaultSource.sourceId`
// regardless of who actually called, misattributing the decision to OWNER and
// defeating the non-repudiation guarantee CLAUDE.md claims for override
// auditability. Gating `resolvePending` here closes BOTH: only an OWNER-grade
// connection (i.e. an actual holder of the owner token) can reach it at all,
// so the resulting attribution to the facade's singleton OWNER identity is now
// true, not forged. See `daemon/__tests__/trustMutationGate.test.ts`'s
// `resolvePending` cases for the regression coverage this fix closes.
// ---------------------------------------------------------------------------

const TRUST_MUTATING_VERBS = new Set([
  "registerSource",
  "disown",
  "approve",
  "adjudicate",
  "ratify",
  "resolvePending",
]);

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
// raw-error-message-passthrough fix: an ALLOW-LIST of error constructors this
// codebase defines specifically to carry safe, hand-authored, PATH-FREE
// messages suitable for forwarding verbatim to a remote caller. Anything NOT
// an `instanceof` one of these (a raw `node:sqlite`/`node:fs` throw with a
// filesystem path in its message, or any other unclassified internal
// exception) is replaced with a generic message at the transport boundary —
// never forwarded verbatim, so this process's paths / driver-internal text
// can never leak to a daemon client. Every entry below was read at the time
// it was added and confirmed to never interpolate a path/stack/raw-token.
// ---------------------------------------------------------------------------

const SAFE_ERROR_TYPES: readonly (abstract new (...args: never[]) => Error)[] = [
  AnchorValidationError,
  FifoBackpressureError,
  InvalidQuarantineThresholdError,
  OffLedgerReputationError,
  UnverifiedLedgerRestoreError,
  EncryptedStoreIntegrityError,
  UnknownFutureSchemaError,
  SharedHandleNotWalError,
];

function isKnownSafeError(err: unknown): err is Error {
  return err instanceof Error && SAFE_ERROR_TYPES.some((ctor) => err instanceof ctor);
}

const GENERIC_INTERNAL_ERROR_MESSAGE =
  "Internal error while processing this request (see the daemon's own logs for detail).";

/**
 * The client-safe rendering of a caught error: the exact message for a
 * known-safe typed error, else a fixed generic message. Never `err.message`
 * verbatim for anything unrecognized (raw-error-message-passthrough fix).
 */
function safeErrorMessage(err: unknown): string {
  return isKnownSafeError(err) ? err.message : GENERIC_INTERNAL_ERROR_MESSAGE;
}

// ---------------------------------------------------------------------------
// AgentMemory method dispatch table — H2's identity binding lives HERE: every
// handler that names an actor takes it from `actor` (the connection's bound
// SourceId), never from `params`. Params SHAPES below match EXACTLY what
// `daemon/client.ts`'s `createRemoteAgentMemory` sends on the wire per method
// (see that module's `call(...)` invocations) — this is the shared contract.
// ---------------------------------------------------------------------------

type MemoryHandler = (
  memory: AgentMemory,
  params: unknown,
  actor: SourceId,
) => unknown | Promise<unknown>;

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
  /** daemon-connection-slot-exhaustion fix — see {@link DEFAULT_MAX_PENDING_HANDSHAKES}. */
  readonly maxPendingHandshakes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly authFailureDelayMs?: number;
  readonly clock?: () => number;
  /**
   * no-health-status-surface / verifychain-never-invoked-by-product fixes:
   * OPTIONAL read-only access to the fact/ratification chain (a SEPARATE
   * checksum chain from `auditChain` above, living inside the shared memory
   * db — see `daemon/cli.ts`'s wiring). Omit to report the fact chain as
   * unavailable in `status`/`verifyChains` rather than throwing — this server
   * class stays decoupled from SQLite specifics either way.
   */
  readonly factChainHead?: () => FactChainHead;
  readonly verifyFactChain?: () => FactChainVerification;
  /**
   * status-ping-blocks-event-loop fix: how often (ms) the {@link factChainHead}
   * callback above is actually re-invoked in the background, decoupled from
   * how often a caller polls `status`/`ping`. Default
   * {@link DEFAULT_FACT_CHAIN_HEAD_REFRESH_MS}. Irrelevant when `factChainHead`
   * is omitted (nothing to cache).
   */
  readonly factChainHeadRefreshMs?: number;
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
  readonly #maxPendingHandshakes: number;
  readonly #handshakeTimeoutMs: number;
  readonly #authFailureDelayMs: number;
  readonly #clock: () => number;
  readonly #queue: FifoQueue;
  readonly #factChainHead: (() => FactChainHead) | null;
  readonly #verifyFactChain: (() => FactChainVerification) | null;
  readonly #factChainHeadRefreshMs: number;

  #server: net.Server | null = null;
  #endpoint: string | null = null;
  #nextConnId = 1;
  #startedAtMs: number | null = null;
  #socketErrorCount = 0;
  /**
   * status-ping-blocks-event-loop fix: the CACHED result of `#factChainHead()`
   * — `null` when no `factChainHead` was wired, or its most recent invocation
   * threw. Read (never invoked) by `#dispatchStatusVerb`; written only by
   * `#refreshFactChainHeadCache` (once synchronously in `start()`, then on
   * `#factChainHeadTimer`'s own cadence).
   */
  #cachedFactChainHead: FactChainHead | null = null;
  #factChainHeadTimer: ReturnType<typeof setInterval> | null = null;
  readonly #connections = new Map<number, ConnectionState>();
  readonly #fingerprintToConnIds = new Map<string, Set<number>>();
  #shuttingDown = false;
  /**
   * shutdown-close-deadlock fix: EVERY raw socket `net.Server` ever handed to
   * `#onConnection`, tracked from the instant it is accepted — including a
   * socket rejected pre-auth (connection cap / pending-handshake cap), which
   * `#connections` never holds. Reproduced (against the real transport, not a
   * mock): such a rejected socket's server-side half — written to and
   * `.end()`ed, then the CLIENT closes its own side after reading the
   * rejection — can be left forever `readable / !writable` (a stuck half-open
   * handle) on this platform's named-pipe transport, which `net.Server#close`'s
   * callback waits on indefinitely. `stop()` force-destroys every entry here,
   * not only the ones promoted into `#connections`.
   */
  readonly #allSockets = new Set<net.Socket>();

  constructor(opts: DaemonServerOptions) {
    this.#memory = opts.memory;
    this.#tokens = opts.tokens;
    this.#auditChain = opts.auditChain;
    this.#trustRegistry = opts.trustRegistry;
    this.#endpointBase = opts.endpointBase;
    this.#maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#maxPendingHandshakes = opts.maxPendingHandshakes ?? DEFAULT_MAX_PENDING_HANDSHAKES;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#authFailureDelayMs = opts.authFailureDelayMs ?? DEFAULT_AUTH_FAILURE_DELAY_MS;
    this.#clock = opts.clock ?? Date.now;
    this.#queue = new FifoQueue(opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH);
    this.#factChainHead = opts.factChainHead ?? null;
    this.#verifyFactChain = opts.verifyFactChain ?? null;
    this.#factChainHeadRefreshMs = opts.factChainHeadRefreshMs ?? DEFAULT_FACT_CHAIN_HEAD_REFRESH_MS;
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

  /** daemon-connection-slot-exhaustion fix: how many currently-open sockets have
   *  NOT yet completed the handshake (exposed for tests; also read by `#onConnection`). */
  get pendingHandshakeCount(): number {
    return this.#pendingHandshakeCount();
  }

  /** socket-error-swallowed fix: count of post-handshake socket 'error' events observed. */
  get socketErrorCount(): number {
    return this.#socketErrorCount;
  }

  #authenticatedConnectionCount(): number {
    let n = 0;
    for (const c of this.#connections.values()) if (c.authenticated) n++;
    return n;
  }

  #pendingHandshakeCount(): number {
    return this.#connections.size - this.#authenticatedConnectionCount();
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
    this.#startedAtMs = this.#clock();
    // status-ping-blocks-event-loop fix: pay the (potentially expensive)
    // `factChainHead` cost exactly ONCE here, synchronously, BEFORE this
    // method returns (i.e. before any client can possibly connect and poll
    // `status`) — so the very first `status`/`ping` response already has a
    // cached value, then hand refreshing off to a background timer that never
    // runs on a request's own call stack.
    if (this.#factChainHead !== null) {
      this.#refreshFactChainHeadCache();
      this.#factChainHeadTimer = setInterval(
        () => this.#refreshFactChainHeadCache(),
        this.#factChainHeadRefreshMs,
      );
      this.#factChainHeadTimer.unref();
    }
    return { endpoint };
  }

  /**
   * status-ping-blocks-event-loop fix: the ONLY call site that ever invokes
   * the (potentially expensive) `factChainHead` callback — never
   * `#dispatchStatusVerb`. Best-effort: a throw is logged and degrades the
   * cache to `null` (matches the previous per-request error handling), never
   * propagates to whatever background timer or `start()` call triggered it.
   */
  #refreshFactChainHeadCache(): void {
    if (this.#factChainHead === null) return;
    try {
      this.#cachedFactChainHead = this.#factChainHead();
    } catch (err) {
      daemonLog({
        event: "status_fact_chain_head_failed",
        level: "warn",
        message: err instanceof Error ? err.message : String(err),
      });
      this.#cachedFactChainHead = null;
    }
  }

  /** R6: graceful shutdown — stop accepting, drain the queue, close connections, mark the chain. */
  async stop(opts?: { clean?: boolean }): Promise<void> {
    this.#shuttingDown = true;
    if (this.#factChainHeadTimer !== null) {
      clearInterval(this.#factChainHeadTimer);
      this.#factChainHeadTimer = null;
    }
    // zero-structured-logging fix: an unconditional shutdown event (previously
    // this event category only ever appeared as a side effect of the marker
    // WRITE failing — a clean shutdown left no structured trace at all).
    daemonLog({
      event: "daemon_shutdown",
      level: "info",
      clean: opts?.clean ?? true,
      connectionCount: this.#connections.size,
    });
    // shutdown-close-deadlock fix (found while verifying the
    // raw-error-message-passthrough fix's own test — a REAL hang, reproduced
    // reliably against the actual `DaemonServer`/named-pipe transport, not a
    // hypothetical, both under vitest and as a standalone compiled script):
    // `net.Server#close`'s callback fires ONLY once every EXISTING connection
    // has fully closed — it does NOT itself close them, and on this
    // platform's named-pipe transport a socket can be left forever stuck
    // half-open (see `#allSockets`'s doc) rather than ever emitting 'close' on
    // its own. The previous shape here ALSO `await`ed `close()`'s promise
    // BEFORE ever touching a single connection, which alone could hang
    // forever with any client still connected. Both are fixed: `close()`
    // still stops ACCEPTING new connections immediately and synchronously
    // (R6's "stop accepting" happens right here, unchanged); the AWAIT of its
    // connection-drain completion is deferred to AFTER this method has
    // FORCEFULLY destroyed EVERY socket it has ever accepted (`#allSockets`
    // — tracked and pending alike, not only the ones promoted into
    // `#connections`).
    const server = this.#server;
    const closed =
      server !== null ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
    await this.#queue.whenDrained();
    for (const socket of [...this.#allSockets]) {
      this.#destroySocketSafely(socket);
    }
    this.#connections.clear();
    this.#fingerprintToConnIds.clear();
    await closed;
    // daemon-auditchain-write-crashes-process fix: a failed shutdown-marker
    // write must never prevent the CALLER (cli.ts) from reaching its own
    // cleanup (`auditChain.close()`, `memory.close()`) — before this fix, a
    // throw here rejected `stop()`'s promise, which cli.ts's `shutdown()`
    // catches only to `process.exit(1)` WITHOUT ever closing the db handles.
    try {
      this.#auditChain.recordShutdown({ clean: opts?.clean ?? true }, this.#clock());
    } catch (err) {
      daemonLog({
        event: "audit_chain_write_failed",
        phase: "SHUTDOWN_MARKER",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- connection lifecycle ------------------------------------------------

  #onConnection(socket: net.Socket): void {
    // shutdown-close-deadlock fix: track EVERY accepted socket from this
    // instant, regardless of what happens next (rejected, authenticated, or
    // never authenticated) — see `#allSockets`'s doc.
    this.#allSockets.add(socket);
    socket.once("close", () => this.#allSockets.delete(socket));

    if (this.#shuttingDown) {
      socket.destroy();
      return;
    }
    // daemon-connection-slot-exhaustion fix: TWO SEPARATE ceilings. The
    // AUTHENTICATED count (never drawn down by a silent/unauthenticated
    // socket) is checked against `#maxConnections` — the reservation a
    // token-holding caller is guaranteed. A SEPARATE, smaller
    // `#maxPendingHandshakes` bounds sockets that haven't authenticated YET,
    // so an unauthenticated flood can exhaust only its own small pool, never
    // the authenticated reservation.
    const authenticatedCount = this.#authenticatedConnectionCount();
    if (authenticatedCount >= this.#maxConnections) {
      daemonLog({
        event: "connection_rejected",
        level: "warn",
        reason: "CONNECTION_CAP",
        authenticatedCount,
        maxConnections: this.#maxConnections,
      });
      this.#writeLine(socket, authErr(DAEMON_ERR_CONNECTION_CAP));
      socket.end();
      return;
    }
    const pendingCount = this.#connections.size - authenticatedCount;
    if (pendingCount >= this.#maxPendingHandshakes) {
      daemonLog({
        event: "connection_rejected",
        level: "warn",
        reason: "PENDING_HANDSHAKE_CAP",
        pendingCount,
        maxPendingHandshakes: this.#maxPendingHandshakes,
      });
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
    socket.on("error", (err: Error) => {
      // socket-error-swallowed fix: previously discarded entirely (no log, no
      // counter) — the "close" handler still performs cleanup (a socket
      // 'error' is always followed by 'close' in `node:net`), but an operator
      // now has a structured trace + a live counter for post-handshake socket
      // errors (ECONNRESET, EPIPE, ...) instead of total silence.
      this.#socketErrorCount++;
      daemonLog({
        event: "socket_error",
        level: "warn",
        message: err.message,
        resolvedSourceId: state.sourceId !== null ? String(state.sourceId) : undefined,
        fingerprint: state.fingerprint ?? undefined,
      });
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

    // no-health-status-surface fix: lightly-authenticated (any grade), and
    // dispatched OUTSIDE the FIFO queue — see STATUS_VERBS's doc comment.
    if (isStatusVerb(method)) {
      this.#dispatchStatusVerb(state, id);
      return;
    }

    if (isAdminVerb(method)) {
      this.#dispatchAdminVerb(state, id, method, (req.params ?? {}) as Record<string, unknown>);
      return;
    }
    this.#dispatchMemoryCall(state, id, method, req.params);
  }

  // ---- status / health (lightly-authenticated) ------------------------------

  #dispatchStatusVerb(state: ConnectionState, id: number): void {
    const now = this.#clock();
    const uptimeMs = this.#startedAtMs !== null ? Math.max(0, now - this.#startedAtMs) : 0;
    // status-ping-blocks-event-loop fix: NEVER invoke `#factChainHead()` here —
    // read the cache `#refreshFactChainHeadCache` maintains instead, so this
    // handler stays genuinely cheap (in-memory reads only) no matter how
    // often — or how many concurrent connections — call `status`/`ping`.
    this.#writeLine(
      state.socket,
      envOk(id, {
        connectionCount: this.#connections.size,
        queueDepth: this.#queue.depth,
        uptimeMs,
        daemonChainHead: this.#auditChain.chainHead(),
        factChainHead: this.#cachedFactChainHead,
      }),
    );
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

    // daemon-auditchain-write-crashes-process fix: this CONNECTION_ACCEPTED
    // write happens on EVERY successful handshake attempt (the finding's
    // "worst" case — the handshake path triggers an unguarded audit-chain
    // write on every connection). Attempted BEFORE mutating `state` so a write
    // failure leaves the connection cleanly un-authenticated rather than
    // half-bound; R8's whole rationale is post-hoc detectability of who
    // connected, so a broken audit chain fails this handshake CLOSED (a typed
    // auth error) instead of either (a) crashing the daemon (the bug) or
    // (b) silently letting an un-audited connection through.
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    let accepted: DaemonLedgerRecord | null = null;
    try {
      accepted = this.#auditChain.recordConnectionAccepted(
        {
          fingerprint: record.fingerprint,
          sourceId: String(ref.sourceId),
          ...(requestId !== undefined ? { requestId } : {}),
        },
        this.#clock(),
      );
    } catch (err) {
      daemonLog({
        event: "audit_chain_write_failed",
        phase: "CONNECTION_ACCEPTED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (accepted === null) {
      state.dropped = true;
      this.#writeLine(state.socket, authErr("internal error: unable to record connection"));
      this.#endSocketSafely(state.socket);
      return;
    }

    state.authenticated = true;
    state.sourceId = ref.sourceId;
    state.grade = record.grade;
    state.fingerprint = record.fingerprint;
    this.#trackFingerprint(record.fingerprint, state.id);

    // zero-structured-logging fix: the "connect" category — a successful
    // handshake, structurally distinct from the CONNECTION_ACCEPTED audit-
    // chain record above (that is the tamper-evident receipt; this is the
    // operator-facing stderr trace an operator can grep/tail live).
    daemonLog({
      event: "connection_authenticated",
      level: "info",
      fingerprint: record.fingerprint,
      resolvedSourceId: String(ref.sourceId),
      grade: record.grade,
    });

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
    // zero-structured-logging fix: the "reject"/"auth-fail" category —
    // UNCONDITIONAL (previously a log line only ever appeared as a side effect
    // of the AUTH_FAILURE audit-chain WRITE itself failing, below; an ordinary
    // rejected handshake left no operator-visible trace at all).
    // fingerprint-not-raw-token: only ever a sha256 fingerprint here, never
    // `msg.token` (the raw bearer value never reaches this method).
    daemonLog({
      event: "handshake_rejected",
      level: "warn",
      reason,
      fingerprint,
    });
    // daemon-auditchain-write-crashes-process fix: never let a broken audit
    // chain block delivering the (already-decided) failure response — this is
    // already a rejection path, so there's nothing further to fail closed on.
    try {
      this.#auditChain.recordAuthFailure(
        { reason, ...(fingerprint !== undefined ? { fingerprint } : {}) },
        this.#clock(),
      );
    } catch (err) {
      daemonLog({
        event: "audit_chain_write_failed",
        phase: "AUTH_FAILURE",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
      daemonLog({
        event: "trust_mutating_verb_forbidden",
        level: "warn",
        method,
        resolvedSourceId: state.sourceId !== null ? String(state.sourceId) : undefined,
        fingerprint: state.fingerprint ?? undefined,
      });
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
    this.#enqueue(state, id, async () => {
      try {
        const result = await handler(this.#memory, params, state.sourceId!);
        this.#writeLine(state.socket, envOk(id, result));
      } catch (err) {
        const code = err instanceof AnchorValidationError ? DAEMON_ERR_INVALID_ANCHOR : DAEMON_ERR_INTERNAL;
        if (code === DAEMON_ERR_INTERNAL) {
          // zero-structured-logging / raw-error-message-passthrough fixes: a
          // failing data verb previously wrote the error ONLY back to the
          // calling socket, with no log line anywhere (audit finding 2's
          // evidence) and no vetting of the message forwarded to the client.
          daemonLog({
            event: "memory_call_failed",
            level: "error",
            method,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        this.#writeLine(state.socket, envErr(id, code, safeErrorMessage(err)));
      }
    });
  }

  #dispatchAdminVerb(state: ConnectionState, id: number, method: string, params: Record<string, unknown>): void {
    if (state.grade !== AnchorClass.OWNER) {
      daemonLog({
        event: "admin_verb_forbidden",
        level: "warn",
        method,
        resolvedSourceId: state.sourceId !== null ? String(state.sourceId) : undefined,
        fingerprint: state.fingerprint ?? undefined,
      });
      this.#writeLine(
        state.socket,
        envErr(id, DAEMON_ERR_ADMIN_FORBIDDEN, "Admin verbs require an OWNER-grade connection."),
      );
      return;
    }
    this.#enqueue(state, id, () => this.#executeAdminVerb(state, id, method, params));
  }

  #enqueue(state: ConnectionState, requestId: number, run: () => void | Promise<void>): void {
    try {
      this.#queue.enqueue(state.id, async () => {
        await run();
        this.#afterExecute(state.id);
      });
    } catch (err) {
      if (err instanceof FifoBackpressureError) {
        // H6/fifo-backpressure-id-loss fix: echo the REQUEST's own wire `id`
        // (not a hardcoded -1, which the client's `#nextId` sequence never
        // issues) so the submitting connection's pending promise for THIS
        // call resolves instead of silently timing out into a slow, ambiguous
        // UNKNOWN outcome — see daemon/client.ts's `#handleResponseLine`,
        // which drops any response whose `id` has no matching pending entry.
        this.#writeLine(state.socket, envErr(requestId, DAEMON_ERR_BACKPRESSURE, err.message));
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
    // zero-structured-logging fix: the "admin-verb" category — every OWNER-
    // authorized admin-verb INVOCATION (success or failure decided below),
    // not only a failure. Never the raw token — `actorSourceId`/`fingerprint`
    // only.
    daemonLog({
      event: "admin_verb_invoked",
      level: "info",
      verb: method,
      resolvedSourceId: actorSourceId,
      fingerprint: state.fingerprint ?? undefined,
    });
    // daemon-auditchain-write-crashes-process fix: every branch below used to
    // call `#auditChain.record*` completely unguarded — a throw there (e.g. a
    // disk-full/EACCES/corrupt-chain write) propagated straight out of the
    // FIFO queue's `run()` (see FifoQueue#drain's fix) and crashed the whole
    // daemon process, on top of never sending ANY response to this connection.
    // Wrapping the whole method: (a) the process survives (isolated here,
    // never reaching the queue's drain loop uncaught), (b) the connection
    // gets a genuine typed `DAEMON_ERR_INTERNAL` response instead of a hang.
    // The underlying security-relevant MUTATION (token revoke + the R3
    // "immediate effect" connection drop) is performed BEFORE the audit-trail
    // write in each branch, so a broken audit chain can degrade
    // *observability* of an admin action without silently skipping the action
    // itself or its immediate enforcement.
    try {
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
            // R3's "immediate effect" enforcement FIRST — never held hostage
            // to a downstream audit-chain write failure.
            this.#dropConnectionsFor(fingerprint, state.id);
            this.#auditChain.recordRevocation({ fingerprint, revokedBySourceId: actorSourceId }, this.#clock());
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
            this.#dropConnectionsFor(fp, state.id);
            this.#auditChain.recordRevocation({ fingerprint: fp, revokedBySourceId: actorSourceId }, this.#clock());
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
        case "verifyChains": {
          // verifychain-never-invoked-by-product fix: an on-demand escape
          // hatch alongside the mandatory startup check (`daemon/cli.ts`) —
          // self-verifies BOTH checksum chains without an operator having to
          // know to script a call to `verifyChain()` themselves.
          const daemonResult = this.#auditChain.verifyChain();
          let factResult: FactChainVerification | null = null;
          if (this.#verifyFactChain !== null) {
            try {
              factResult = this.#verifyFactChain();
            } catch (err) {
              daemonLog({
                event: "verify_chains_fact_check_failed",
                level: "error",
                message: err instanceof Error ? err.message : String(err),
              });
              factResult = null;
            }
          }
          this.#auditChain.recordAdminVerb(
            {
              verb: "verifyChains",
              actorSourceId,
              detail: `daemon:${String(daemonResult.ok)},fact:${factResult === null ? "unavailable" : String(factResult.ok)}`,
            },
            this.#clock(),
          );
          this.#writeLine(state.socket, envOk(id, { daemonChain: daemonResult, factChain: factResult }));
          return;
        }
        default:
          this.#writeLine(state.socket, envErr(id, DAEMON_ERR_METHOD_NOT_FOUND, `Unknown admin verb: ${method}`));
      }
    } catch (err) {
      daemonLog({
        event: "admin_verb_failed",
        level: "error",
        method,
        message: err instanceof Error ? err.message : String(err),
      });
      this.#writeLine(state.socket, envErr(id, DAEMON_ERR_INTERNAL, safeErrorMessage(err)));
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

  /**
   * shutdown-close-deadlock fix: a FORCEFUL close, used only by `stop()`.
   * `#endSocketSafely`'s graceful `socket.end()` depends on both sides
   * completing a FIN-equivalent exchange — reliably reproduced (against the
   * REAL `net.Server`/named-pipe transport, not a mock) to hang INDEFINITELY
   * when the peer already vanished (e.g. a client that itself called
   * `.destroy()`), leaving the handle "active" forever and `net.Server#close`'s
   * callback (which waits for every connection to fully end) never firing —
   * so `stop()` could hang the whole daemon shutdown forever. At shutdown
   * time there is nothing left to gracefully flush (the process is going
   * away), so a forceful `.destroy()` — which tears down the OS handle
   * immediately regardless of the peer's state — is the correct, safe choice
   * here specifically.
   */
  #destroySocketSafely(socket: net.Socket): void {
    try {
      socket.destroy();
    } catch {
      // best-effort
    }
  }
}
