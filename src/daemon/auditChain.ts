/**
 * daemon/auditChain.ts — THE DAEMON'S OWN, SEPARATE HASH CHAIN (PHASE3_DAEMON_SPEC.md
 * R8).
 *
 * R8's ruling: daemon transport events (connection accepted, auth failure,
 * revocation, admin verb, shutdown marker) go to a DEDICATED hash chain — distinct
 * genesis, own `chainHead()` — so the fact/ratification chain
 * (`ratification/pendingLedger.ts`) stays semantically pure. This module REUSES that
 * chain's checksum primitive verbatim (`sha256Hex`, exported additively from
 * `pendingLedger.ts` for exactly this reuse) and mirrors its algorithm shape
 * EXACTLY — genesis-anchored `prevHash` linking, a `thisHash` computed over an
 * explicit hand-ordered canonical preimage (never free-form `JSON.stringify`),
 * a `verifyChain()` that names the first broken seq, an O(1) `chainHead()`
 * checkpoint — with a DISTINCT genesis string and daemon-specific record kinds, so
 * the two chains can never be confused or spliced together.
 *
 * FINGERPRINT-NEVER-RAW (R3): every payload below carries only a token FINGERPRINT
 * (sha256 hex) where a token is referenced — never the raw bearer value. This is
 * enforced structurally (the payload types have no field a raw token could occupy)
 * and is the exact property `__tests__/auditChain.test.ts`'s grep-style assertion
 * checks over every serialized record.
 *
 * "AppendSink-compatible" (R8): {@link DaemonAppendSink} mirrors the SAME shape and
 * ordering contract as `ratification/pendingLedger.ts`'s `AppendSink` (ship BEFORE
 * the local write; a throwing sink aborts the append) so the daemon chain is
 * shippable through an identical real-time-shipping mechanism — a sibling type,
 * not a literal reuse of the fact-chain's narrower `LedgerRecord` shape (whose
 * `kind` is fixed to `"PENDING"|"APPROVAL"|"MUTATION"`, incompatible with the
 * daemon's own record kinds below).
 *
 * ZERO new runtime deps: `node:crypto` via the imported `sha256Hex` only.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

import { sha256Hex } from "../ratification/pendingLedger.js";
// Re-exported (not just imported) so a durable implementation
// (`daemon/auditChainSqlite.ts`) can recompute/verify the EXACT same checksum
// over a persisted record without duplicating the hash primitive (mirrors
// `ratification/pendingLedger.ts`'s own re-export for the identical reason).
export { sha256Hex };

// ---------------------------------------------------------------------------
// Record kinds + payloads (R8's enumerated daemon event set)
// ---------------------------------------------------------------------------

export type DaemonRecordKind =
  | "CONNECTION_ACCEPTED"
  | "AUTH_FAILURE"
  | "REVOCATION"
  | "ADMIN_VERB"
  | "SHUTDOWN_MARKER";

/** H2 + H5: a successful handshake — fingerprint, resolved SourceId, timestamp,
 * and the client-supplied `requestId` ONLY when the client actually sent one
 * (emit-only-if-present, mirroring pendingLedger's `contentHash` discipline). */
export interface ConnectionAcceptedPayload {
  readonly fingerprint: string;
  readonly sourceId: string;
  readonly at: number;
  readonly requestId?: string;
}

/** H1: a failed/rejected handshake. NEVER carries the raw token, even on failure —
 * only whichever fingerprint could be computed (absent if the line didn't parse
 * far enough to extract one) and a short, fixed reason tag. */
export interface AuthFailurePayload {
  readonly reason:
    | "MALFORMED"
    | "OVERSIZED_LINE"
    | "WRONG_FIRST_METHOD"
    | "TIMEOUT"
    | "UNKNOWN_OR_REVOKED_TOKEN";
  readonly at: number;
  readonly fingerprint?: string;
}

/** R3: a token was revoked (single revoke or as part of revokeAllTokens). */
export interface RevocationPayload {
  readonly fingerprint: string;
  readonly revokedBySourceId: string;
  readonly at: number;
}

/** R3: an admin verb was invoked over an authenticated OWNER-grade connection. */
export interface AdminVerbPayload {
  readonly verb:
    | "issueToken"
    | "revokeToken"
    | "revokeAllTokens"
    | "reloadTokens"
    // verifychain-never-invoked-by-product fix: the on-demand chain-verification
    // admin verb (`server.ts`'s `#executeAdminVerb`, "verifyChains" case).
    | "verifyChains";
  readonly actorSourceId: string;
  readonly at: number;
  /** Optional detail — e.g. the affected fingerprint. NEVER a raw token. */
  readonly detail?: string;
}

/** R6: graceful (or unclean) shutdown marker. */
export interface ShutdownMarkerPayload {
  readonly clean: boolean;
  readonly at: number;
}

export type DaemonPayload =
  | ConnectionAcceptedPayload
  | AuthFailurePayload
  | RevocationPayload
  | AdminVerbPayload
  | ShutdownMarkerPayload;

/**
 * One immutable record in the daemon's OWN checksum chain. Same tamper-evidence
 * shape as `ratification/pendingLedger.ts`'s `LedgerRecord`: `thisHash` commits to
 * `{seq, prevHash, kind, payload}` and `prevHash` chains to the previous record's
 * `thisHash` (genesis = {@link DAEMON_GENESIS_HASH}, DISTINCT from the fact chain's).
 */
export interface DaemonLedgerRecord {
  readonly seq: number;
  readonly prevHash: string;
  readonly kind: DaemonRecordKind;
  readonly payload: DaemonPayload;
  readonly thisHash: string;
}

export interface DaemonChainVerification {
  readonly ok: boolean;
  readonly firstBrokenSeq: number | null;
}

export interface DaemonChainHead {
  readonly seq: number;
  readonly headHash: string;
}

/**
 * R8 "AppendSink-compatible": same ship-before-write ordering contract as
 * `ratification/pendingLedger.ts`'s `AppendSink` — invoked BEFORE the local
 * append; a throwing sink aborts the append (fail-closed).
 */
export type DaemonAppendSink = (record: DaemonLedgerRecord) => void;

// ---------------------------------------------------------------------------
// Genesis (DISTINCT from the fact/ratification chain's `sha256("GENESIS")`)
// ---------------------------------------------------------------------------

/** The daemon audit chain's own genesis anchor — never equal to the fact chain's. */
export const DAEMON_GENESIS_HASH = sha256Hex("DAEMON_AUDIT_CHAIN_GENESIS");

// ---------------------------------------------------------------------------
// Canonical serialization (mirrors pendingLedger's discipline: explicit,
// hand-ordered primitive fields — never free-form JSON.stringify)
// ---------------------------------------------------------------------------

export function canonicalPayload(kind: DaemonRecordKind, payload: DaemonPayload): string {
  switch (kind) {
    case "CONNECTION_ACCEPTED": {
      const p = payload as ConnectionAcceptedPayload;
      return [
        "CONNECTION_ACCEPTED",
        p.fingerprint,
        p.sourceId,
        String(p.at),
        p.requestId === undefined ? "" : "rid:" + p.requestId,
      ].join("\x01");
    }
    case "AUTH_FAILURE": {
      const p = payload as AuthFailurePayload;
      return [
        "AUTH_FAILURE",
        p.reason,
        String(p.at),
        p.fingerprint === undefined ? "" : "fp:" + p.fingerprint,
      ].join("\x01");
    }
    case "REVOCATION": {
      const p = payload as RevocationPayload;
      return ["REVOCATION", p.fingerprint, p.revokedBySourceId, String(p.at)].join("\x01");
    }
    case "ADMIN_VERB": {
      const p = payload as AdminVerbPayload;
      return [
        "ADMIN_VERB",
        p.verb,
        p.actorSourceId,
        String(p.at),
        p.detail === undefined ? "" : "detail:" + p.detail,
      ].join("\x01");
    }
    case "SHUTDOWN_MARKER": {
      const p = payload as ShutdownMarkerPayload;
      return ["SHUTDOWN_MARKER", String(p.clean), String(p.at)].join("\x01");
    }
  }
}

export function hashPreimage(
  seq: number,
  prevHash: string,
  kind: DaemonRecordKind,
  payload: DaemonPayload,
): string {
  return [String(seq), prevHash, kind, canonicalPayload(kind, payload)].join("\x01");
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export interface DaemonAuditChain {
  recordConnectionAccepted(p: Omit<ConnectionAcceptedPayload, "at">, now?: number): DaemonLedgerRecord;
  recordAuthFailure(p: Omit<AuthFailurePayload, "at">, now?: number): DaemonLedgerRecord;
  recordRevocation(p: Omit<RevocationPayload, "at">, now?: number): DaemonLedgerRecord;
  recordAdminVerb(p: Omit<AdminVerbPayload, "at">, now?: number): DaemonLedgerRecord;
  recordShutdown(p: Omit<ShutdownMarkerPayload, "at">, now?: number): DaemonLedgerRecord;
  /** Walk the whole chain; `{ok:false, firstBrokenSeq}` names the first break. */
  verifyChain(): DaemonChainVerification;
  /** O(1) checkpoint `{seq, headHash}` (`seq:-1`, genesis hash, when empty). */
  chainHead(): DaemonChainHead;
  /** Raw read of every record, in chain order. */
  records(): readonly DaemonLedgerRecord[];
}

class InMemoryDaemonAuditChain implements DaemonAuditChain {
  readonly #chain: DaemonLedgerRecord[] = [];
  readonly #onAppend: DaemonAppendSink | null;
  readonly #clock: () => number;

  constructor(opts: { onAppend: DaemonAppendSink | null; clock: () => number }) {
    this.#onAppend = opts.onAppend;
    this.#clock = opts.clock;
  }

  records(): readonly DaemonLedgerRecord[] {
    return this.#chain;
  }

  recordConnectionAccepted(
    p: Omit<ConnectionAcceptedPayload, "at">,
    now?: number,
  ): DaemonLedgerRecord {
    return this.#append("CONNECTION_ACCEPTED", { ...p, at: now ?? this.#clock() });
  }

  recordAuthFailure(p: Omit<AuthFailurePayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("AUTH_FAILURE", { ...p, at: now ?? this.#clock() });
  }

  recordRevocation(p: Omit<RevocationPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("REVOCATION", { ...p, at: now ?? this.#clock() });
  }

  recordAdminVerb(p: Omit<AdminVerbPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("ADMIN_VERB", { ...p, at: now ?? this.#clock() });
  }

  recordShutdown(p: Omit<ShutdownMarkerPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("SHUTDOWN_MARKER", { ...p, at: now ?? this.#clock() });
  }

  verifyChain(): DaemonChainVerification {
    let expectedPrev = DAEMON_GENESIS_HASH;
    for (let i = 0; i < this.#chain.length; i++) {
      const r = this.#chain[i]!;
      if (r.seq !== i) return { ok: false, firstBrokenSeq: i };
      if (r.prevHash !== expectedPrev) return { ok: false, firstBrokenSeq: i };
      const recomputed = sha256Hex(hashPreimage(r.seq, r.prevHash, r.kind, r.payload));
      if (recomputed !== r.thisHash) return { ok: false, firstBrokenSeq: i };
      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  chainHead(): DaemonChainHead {
    const tail = this.#chain.length === 0 ? null : this.#chain[this.#chain.length - 1]!;
    return tail === null ? { seq: -1, headHash: DAEMON_GENESIS_HASH } : { seq: tail.seq, headHash: tail.thisHash };
  }

  #append(kind: DaemonRecordKind, payload: DaemonPayload): DaemonLedgerRecord {
    const seq = this.#chain.length;
    const prevHash = seq === 0 ? DAEMON_GENESIS_HASH : this.#chain[seq - 1]!.thisHash;
    const thisHash = sha256Hex(hashPreimage(seq, prevHash, kind, payload));
    const record: DaemonLedgerRecord = { seq, prevHash, kind, payload, thisHash };
    // Ship-before-write (same ordering contract as pendingLedger's AppendSink):
    // a throwing sink aborts the append with the chain unchanged.
    this.#onAppend?.(record);
    this.#chain.push(record);
    return record;
  }
}

/**
 * Construct a fresh, empty {@link DaemonAuditChain}.
 * @param opts.onAppend real-time shipping sink (R8's "shippable through the same
 *                      AppendSink interface"); omit for a local-only chain.
 * @param opts.clock    injectable clock for deterministic tests; defaults to `Date.now`.
 */
export function createDaemonAuditChain(opts?: {
  onAppend?: DaemonAppendSink;
  clock?: () => number;
}): DaemonAuditChain {
  return new InMemoryDaemonAuditChain({
    onAppend: opts?.onAppend ?? null,
    clock: opts?.clock ?? Date.now,
  });
}
