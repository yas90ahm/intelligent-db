/**
 * daemon/protocol.ts — THE WIRE PROTOCOL shared by the daemon server
 * (src/daemon/server.ts, another lane) and its clients (src/daemon/client.ts,
 * this lane): request/response envelopes + line-framing constants.
 *
 * PHASE3_DAEMON_SPEC.md's binding recommendation is to reuse the JSON-RPC
 * line framing already shipped in mcp/server.ts VERBATIM rather than invent a
 * new one — so this module re-exports {@link BoundedLineSplitter} and
 * {@link MAX_LINE_BYTES} from there (H1/H6: the same oversized-line handling
 * a hostile/buggy connection gets on the MCP transport applies to the daemon
 * transport too) instead of duplicating them.
 *
 * KEPT DELIBERATELY MINIMAL AND MOSTLY TYPE-ONLY (H1's handshake shape, the
 * post-handshake request/response envelope, the method name union) so both
 * lanes can build on ONE shared contract without churn. This module owns NO
 * I/O and NO business logic — every shape here is plain, JSON-serializable
 * data. If the server lane lands its own version of this file first, prefer
 * THEIRS and adjust client.ts's imports to match; this file is written to be
 * easy to superset, not precious to keep.
 */

// Reuse the existing bounded line-splitting transport verbatim (see module
// doc) — one line-length ceiling, one parsing state machine, for both the
// stdio MCP transport and the daemon socket/pipe transport.
export { BoundedLineSplitter, MAX_LINE_BYTES } from "../mcp/server.js";

// ---------------------------------------------------------------------------
// Handshake (H1) — the mandatory first line on every connection
// ---------------------------------------------------------------------------

/**
 * The mandatory FIRST line on every daemon connection (H1). Any other first
 * line, malformed JSON, an oversized line, or 5 seconds of handshake silence
 * is a fail-fast per the spec's server-side rules; this shape is what a
 * well-behaved client sends.
 */
export interface DaemonAuthRequest {
  readonly method: "auth";
  readonly token: string;
}

/**
 * The daemon's response to the auth line. On success, `defaultSourceId`
 * surfaces the connection's bound acting identity (H2) — the daemon-side
 * mirror of {@link "../agent/agentMemory".AgentMemory.defaultSourceId} for
 * this connection's resolved SourceId, so a client never has to make a
 * second round trip just to learn its own identity.
 */
export interface DaemonAuthResponse {
  readonly ok: boolean;
  /** Present on success (H1 fail-fast: at most once per connection either way). */
  readonly defaultSourceId?: string;
  /** Present on failure — the raw token is NEVER echoed here or anywhere (R3). */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Post-handshake request / response envelope
// ---------------------------------------------------------------------------

/**
 * The AgentMemory verbs reachable over the wire as one request/response round
 * trip each — one per genuine data operation the facade exposes
 * (agent/agentMemory.ts). Deliberately EXCLUDES `trust` / `engine`: those are
 * rich, multi-method "advanced caller" escape hatches (a whole TrustRegistry /
 * IntelligentDb surface each), out of scope for the v1 daemon transport — see
 * daemon/client.ts's module doc for the disclosed reasoning. An advanced
 * caller who needs them stays on the in-process `createAgentMemory()`, which
 * remains the permanent default (R7).
 */
export type DaemonMethod =
  | "remember"
  | "recall"
  | "ratify"
  | "adjudicate"
  | "disown"
  | "listPending"
  | "pendingQuestions"
  | "resolvePending"
  | "approve"
  | "explain"
  | "beliefTimeline"
  | "registerSource"
  | "stampFor";

/** Every wire-reachable method name, for exhaustiveness checks in tests/dispatchers. */
export const DAEMON_METHODS: readonly DaemonMethod[] = [
  "remember",
  "recall",
  "ratify",
  "adjudicate",
  "disown",
  "listPending",
  "pendingQuestions",
  "resolvePending",
  "approve",
  "explain",
  "beliefTimeline",
  "registerSource",
  "stampFor",
];

/**
 * One AgentMemory-shaped request after a successful handshake. `id` is a
 * CONNECTION-LOCAL correlation id the response echoes back (matching request
 * to response over the single multiplexed connection) — distinct from H5's
 * `requestId`, which is an OPTIONAL client-supplied idempotency-reconciliation
 * token logged (not deduplicated) in the daemon's audit record.
 */
export interface DaemonRequestEnvelope {
  readonly id: number;
  readonly method: DaemonMethod;
  readonly params: unknown;
  /** H5 — optional passthrough, logged for post-hoc reconciliation only. */
  readonly requestId?: string;
}

/** The daemon's response to one {@link DaemonRequestEnvelope}. */
export interface DaemonResponseEnvelope {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: DaemonWireError;
}

/** A typed, serializable error the daemon may report for a failed request. */
export interface DaemonWireError {
  readonly code: string;
  readonly message: string;
}

// Standard wire error codes both lanes may switch on (additive; a client MUST
// tolerate an unrecognized code as a generic failure, never crash on it).
export const DAEMON_ERR_INTERNAL = "INTERNAL";
/** H6 — queue depth exceeded; the submitting connection gets this typed error. */
export const DAEMON_ERR_BACKPRESSURE = "BACKPRESSURE";
/** R5 — the connection cap (32) was already reached. */
export const DAEMON_ERR_CONNECTION_CAP = "CONNECTION_CAP";
/** H1 — no successful auth on this connection yet. */
export const DAEMON_ERR_UNAUTHENTICATED = "UNAUTHENTICATED";
/** R3 — the presented token's fingerprint is on the revocation set. */
export const DAEMON_ERR_REVOKED = "REVOKED";
/** R3 — a non-OWNER-grade connection tried one of the four admin verbs
 * (`issueToken`/`revokeToken`/`revokeAllTokens`/`reloadTokens`). */
export const DAEMON_ERR_ADMIN_FORBIDDEN = "ADMIN_FORBIDDEN";
/** The requested `method` is not one of {@link DAEMON_METHODS} or an admin verb. */
export const DAEMON_ERR_METHOD_NOT_FOUND = "METHOD_NOT_FOUND";
/** H1/H6 — a post-handshake line exceeded {@link MAX_LINE_BYTES} and was discarded. */
export const DAEMON_ERR_OVERSIZED_LINE = "OVERSIZED_LINE";
/** daemon-unauthorized-trust-mutation fix — a non-OWNER-grade connection tried a
 * TRUST-MUTATING `AgentMemory` verb (`registerSource`/`disown`/`approve`/
 * `adjudicate`/`ratify`/`resolvePending` — the last added by the
 * resolvePending-trust-bypass follow-up fix, see `server.ts`'s
 * `TRUST_MUTATING_VERBS`). Distinct from {@link DAEMON_ERR_ADMIN_FORBIDDEN} (which
 * gates the four daemon-management verbs) so callers can tell the two
 * authorization surfaces apart. */
export const DAEMON_ERR_INSUFFICIENT_GRADE = "INSUFFICIENT_GRADE";
/** daemon-unauthorized-trust-mutation fix — `registerSource`'s caller-supplied
 * anchor bindings named an unknown `AnchorClass`, or claimed an
 * `independenceWeight`/`realizedCost` above that class's ANCHOR_TABLE ceiling
 * (a forged high-grade anchor riding a cheap/arbitrary class label). */
export const DAEMON_ERR_INVALID_ANCHOR = "INVALID_ANCHOR";
