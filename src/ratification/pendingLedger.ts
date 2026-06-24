/**
 * ratification/pendingLedger.ts — THE VAULT AND THE DOORBELL.
 *
 * This module BACKS the `PendingRatification` horn (CLAUDE.md "Still stubbed /
 * open"). The prior council verdict on the Tanaka project was that it is "a vault
 * and a doorbell, never a judge". We adopt its two load-bearing shapes natively in
 * TypeScript — we do NOT import the Python project; we build the Tanaka-SHAPED
 * mechanism in our own stack:
 *
 *   (a) THE VAULT — an append-only, hash-chained, Ed25519-SIGNED ratification
 *       LEDGER. An immortal, tamper-evident record. Each record chains to the
 *       previous by `prevHash` (genesis = sha256("GENESIS")), carries its own
 *       `thisHash` over a CANONICAL serialization of its fields, and a detached
 *       Ed25519 `sig` over that hash by the signer's passport key. A standalone
 *       {@link PendingLedger.verifyChain} walks the chain, recomputes every hash,
 *       checks every signature, and names the FIRST broken seq — the "money
 *       artifact": flip any byte anywhere and verification reports `ok:false` and
 *       points at the break.
 *
 *   (b) THE DOORBELL — a SECOND-ADMIN PENDING -> approve flow. The web NEVER judges
 *       an independent dispute (the hard theorem, CLAUDE.md). An EXTERNAL approver
 *       — DISTINCT from every source that authored a disputed member — designates
 *       the winner, and the decision is recorded immutably as a signed APPROVAL
 *       receipt. Self-approval (the approver authored a member) is REJECTED: the
 *       second-admin / distinct gate. An unverifiable / forged signer is rejected
 *       ("no provenance -> no voice").
 *
 * PURITY BOUNDARY: this module is STATEFUL INFRA (an append-only array behind a
 * swappable interface) and is deliberately separate from the PURE
 * forgetting/consolidation.ts. It performs NO StrandStore I/O: `approve` returns a
 * {@link ResolvedDispute} PLAN (mint these OUTRANKS edges, demote these losers,
 * reputation-up the winner / down the losers) that the engine (api.ts) applies to
 * the store. The ledger owns the immutable record + the distinct-approver gate; the
 * engine owns the store writes. Consolidation stays pure.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (every type-only import uses `import type`); `node:crypto` only, no external deps.
 * Signatures and hashes are carried as base64url STRINGS so a record is plain,
 * serializable JSON with a stable canonical form (no Uint8Array in the record body).
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  EdgeType,
} from "../core/types.js";

import type {
  AttributeKey,
  ContradictionSetId,
  Edge,
  EdgeId,
  EpochMs,
  SourceId,
  Strand,
  StrandId,
  Unit,
} from "../core/types.js";

import { sign, verify, sourceIdFromPublicKey } from "../identity/keys.js";
import type { KeyPair, Passport } from "../identity/keys.js";

import { demote } from "../forgetting/consolidation.js";
import type {
  DemotionResult,
  PendingRatification,
} from "../forgetting/consolidation.js";

import type { ReputationLedger } from "../identity/reputation.js";

// ---------------------------------------------------------------------------
// Record shapes (the VAULT's contents)
// ---------------------------------------------------------------------------

/** The two kinds of record the ratification ledger holds. */
export type LedgerRecordKind = "PENDING" | "APPROVAL";

/**
 * The body of a PENDING record: the deferred independent dispute, exactly as the
 * pure consolidation layer emitted it. Carries member ids (reputation-ranked, for a
 * human reviewer) — NOT claim bodies. An optional `contentHash` supports the
 * CONTENT-BLINDNESS option: the ledger can be the immortal record of THAT a dispute
 * existed and its members' content fingerprint, while the human reviews the claim
 * bodies out-of-band in our UI. The ledger never needs the payloads to do its job.
 */
export interface PendingPayload {
  readonly contradictionSetId: ContradictionSetId;
  readonly attribute: AttributeKey;
  /** Disputed members, reputation-ranked strongest-first (decides nothing here). */
  readonly members: readonly StrandId[];
  readonly reason: PendingRatification["reason"];
  readonly createdAt: EpochMs;
  /**
   * OPTIONAL content fingerprint for the content-blind mode. Omitted when the
   * ledger is run in plain mode; present when only a hash of the disputed content
   * is recorded and bodies are reviewed out-of-band.
   */
  readonly contentHash?: string;
}

/**
 * The body of an APPROVAL record: an EXTERNAL approver's immutable decision that
 * `winner` outranks the other members of `contradictionSetId`. `approverSourceId`
 * is the distinct second admin who rang the doorbell; the web picked nothing.
 */
export interface ApprovalPayload {
  readonly contradictionSetId: ContradictionSetId;
  readonly winner: StrandId;
  readonly approverSourceId: SourceId;
  readonly approvedAt: EpochMs;
}

/**
 * One immutable record in the append-only, hash-chained, signed ledger.
 *
 * Tamper-evidence is structural: `thisHash` is sha256 over the CANONICAL
 * serialization of `{seq, prevHash, kind, payload, signerSourceId}` (everything
 * EXCEPT `thisHash`/`sig`), `prevHash` chains to the previous record's `thisHash`
 * (genesis = sha256("GENESIS")), and `sig` is a detached Ed25519 signature over the
 * UTF-8 bytes of `thisHash` by the signer's passport key. Flip any field and either
 * the recomputed `thisHash`, the chain link, or the signature check fails — and
 * {@link PendingLedger.verifyChain} names the first broken seq.
 */
export interface LedgerRecord {
  /** 0-based position in the append-only chain. */
  readonly seq: number;
  /** sha256 (hex) of the previous record's `thisHash`; genesis = sha256("GENESIS"). */
  readonly prevHash: string;
  readonly kind: LedgerRecordKind;
  readonly payload: PendingPayload | ApprovalPayload;
  /** The {@link SourceId} of the signer (derived from its passport public key). */
  readonly signerSourceId: SourceId;
  /** sha256 (hex) over canonical({seq,prevHash,kind,payload,signerSourceId}). */
  readonly thisHash: string;
  /** Detached Ed25519 signature over utf8(thisHash), base64url. */
  readonly sig: string;
}

// ---------------------------------------------------------------------------
// Verification result (the "money artifact")
// ---------------------------------------------------------------------------

/**
 * The result of walking the whole chain. `ok` is true iff EVERY record's chain
 * link, recomputed hash, and signature verify; otherwise `firstBrokenSeq` names the
 * earliest seq at which the chain is inconsistent (a flipped byte, a re-ordered
 * record, a forged or unknown signer). This is the standalone audit artifact.
 */
export interface ChainVerification {
  readonly ok: boolean;
  readonly firstBrokenSeq: number | null;
}

// ---------------------------------------------------------------------------
// Resolution plan (emitted by approve; applied by the engine — purity boundary)
// ---------------------------------------------------------------------------

/**
 * The store-mutation PLAN an {@link PendingLedger.approve} produces. The ledger
 * computed WHO won (from the external approver) and demoted the losers IN MEMORY
 * (via the pure {@link demote}); the engine PERSISTS this: put each demoted loser,
 * put each minted OUTRANKS edge, and drive reputation. The winner stays LIVE; the
 * losers are DEMOTED + `outranked_by` set (never deleted). Reputation is driven
 * here against the injected ledger (winner ratified, losers contradicted) because
 * the reputation ledger is shared stateful infra, not store I/O.
 */
export interface ResolvedDispute {
  readonly contradictionSetId: ContradictionSetId;
  /** The winning strand designated by the external approver; stays LIVE. */
  readonly winner: StrandId;
  /** One OUTRANKS edge winner -> loser per demoted member (to be persisted). */
  readonly outranksEdges: readonly Edge[];
  /** One demotion receipt per loser (the loser strand was mutated in place). */
  readonly demotions: readonly DemotionResult[];
  /** The signed APPROVAL record appended to the immortal ledger for this decision. */
  readonly record: LedgerRecord;
}

// ---------------------------------------------------------------------------
// Approver context (how the gate resolves who authored a member)
// ---------------------------------------------------------------------------

/**
 * The collaborator context {@link PendingLedger.approve} needs to RESOLVE a
 * dispute. It is supplied by the engine (api.ts), which alone can read the
 * StrandStore. Keeping this a narrow injected port preserves the ledger's purity
 * boundary (no StrandStore import here).
 */
export interface ApproveContext {
  /**
   * The author {@link SourceId}s behind a disputed member strand (its
   * `provenance[].sourceId`, nulls dropped). Used by the DISTINCT-APPROVER GATE:
   * if the approver authored ANY member, the approval is a self-approval and is
   * REJECTED.
   */
  authorsOf(memberId: StrandId): readonly SourceId[];
  /**
   * Resolve a disputed member id to its Strand so the loser can be {@link demote}d.
   * Returns the live strand object the engine will persist after mutation.
   */
  memberStrand(memberId: StrandId): Strand;
  /**
   * Mint a fresh OUTRANKS edge id for a (winner, loser) pair. Injected so the
   * engine controls id generation (uuid in production); the ledger stays pure of
   * id policy.
   */
  mintEdgeId(winner: StrandId, loser: StrandId): EdgeId;
}

// ---------------------------------------------------------------------------
// The ledger interface (swappable; in-memory implementation below)
// ---------------------------------------------------------------------------

/**
 * The append-only ratification ledger: the VAULT (immutable signed record) plus the
 * DOORBELL (second-admin approve flow). The in-memory implementation ships here;
 * the interface is swappable for a durable backend (mirroring the Tanaka SQLite
 * receipt pattern) without touching callers.
 */
export interface PendingLedger {
  /**
   * THE DOORBELL (ring). Record a deferred independent dispute as a signed PENDING
   * record, signed by the SYSTEM signer (the engine's own passport). Returns the
   * appended record. This is the only way a dispute enters the queue.
   */
  appendPending(pending: PendingRatification, systemSigner: KeyPair): LedgerRecord;

  /**
   * The OPEN disputes awaiting a human decision: every PENDING whose
   * `contradictionSetId` has no later APPROVAL. Members are already
   * reputation-ranked (from the {@link PendingRatification}). For a human reviewer.
   */
  listPending(): readonly PendingPayload[];

  /**
   * THE DOORBELL (answer). An EXTERNAL approver designates `winnerStrandId` as the
   * winner of `contradictionSetId`. REQUIRES the approver to be DISTINCT from every
   * source that authored a disputed member (rejects self-approval — the second
   * admin rule) and to present a VERIFIABLE passport (rejects forged provenance).
   * On success: appends a signed APPROVAL record and RESOLVES the dispute — mints
   * OUTRANKS winner -> each other member, {@link demote}s the losers (DEMOTED +
   * outranked_by, never deleted), and drives reputation (winner ratified, losers
   * contradicted). Returns a {@link ResolvedDispute} PLAN the engine persists.
   *
   * @throws if the dispute is unknown / already resolved, the winner is not a
   *         member, the approver's passport fails verification, or the approver
   *         authored any member (self-approval).
   */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    now: EpochMs,
    ctx: ApproveContext,
  ): ResolvedDispute;

  /**
   * THE MONEY ARTIFACT. Walk the whole chain: recompute each record's
   * genesis-anchored `prevHash` link, recompute its `thisHash`, and verify its
   * signature against the signer's registered public key. Returns `{ok:true,
   * firstBrokenSeq:null}` for an intact chain, or `{ok:false, firstBrokenSeq:k}`
   * naming the FIRST inconsistent record. Standalone and side-effect-free.
   */
  verifyChain(): ChainVerification;

  /** Raw read of every record (audit / persistence). Order is chain order. */
  records(): readonly LedgerRecord[];
}

// ---------------------------------------------------------------------------
// Canonical serialization (determinism is load-bearing)
// ---------------------------------------------------------------------------

const GENESIS_PREV_HASH = sha256Hex("GENESIS");

/** sha256 of a UTF-8 string, hex. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** UTF-8 bytes of a string as a Uint8Array (the message the signer signs). */
function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

/**
 * CANONICAL JSON of a PENDING payload: explicit, hand-ordered field list over
 * primitive id/number fields only (NEVER `JSON.stringify` of a free-form object,
 * whose key order is not contractually stable). `contentHash` is emitted only when
 * present, as a final, clearly-delimited field. Members are joined in their given
 * order (the order IS part of the record). All components are ids/hashes that never
 * contain the `` unit separator used here.
 */
function canonicalPending(p: PendingPayload): string {
  const parts = [
    "PENDING",
    String(p.contradictionSetId),
    String(p.attribute),
    p.members.map((m) => String(m)).join(","),
    String(p.reason),
    String(p.createdAt),
    p.contentHash === undefined ? "" : "ch:" + p.contentHash,
  ];
  return parts.join("");
}

/** CANONICAL JSON of an APPROVAL payload (explicit ordered primitive fields). */
function canonicalApproval(p: ApprovalPayload): string {
  const parts = [
    "APPROVAL",
    String(p.contradictionSetId),
    String(p.winner),
    String(p.approverSourceId),
    String(p.approvedAt),
  ];
  return parts.join("");
}

/** Canonical serialization of a payload, discriminated by record kind. */
function canonicalPayload(kind: LedgerRecordKind, payload: PendingPayload | ApprovalPayload): string {
  return kind === "PENDING"
    ? canonicalPending(payload as PendingPayload)
    : canonicalApproval(payload as ApprovalPayload);
}

/**
 * The exact preimage of `thisHash`: a canonical serialization of every record
 * field EXCEPT `thisHash` and `sig`. Recomputed verbatim in {@link verifyChain}.
 */
function hashPreimage(
  seq: number,
  prevHash: string,
  kind: LedgerRecordKind,
  payload: PendingPayload | ApprovalPayload,
  signerSourceId: SourceId,
): string {
  return [
    String(seq),
    prevHash,
    kind,
    canonicalPayload(kind, payload),
    String(signerSourceId),
  ].join("");
}

/**
 * The CANONICAL preimage of a {@link LedgerRecord} -- the exact, hand-ordered string
 * the record's own `thisHash` already commits to (every field EXCEPT `thisHash`/`sig`).
 * Exported so the Merkle layer (`merkleLog.ts`) can hash leaves over the SAME bytes
 * the chain commits to, making a Merkle leaf BYTE-IDENTICAL to what `verifyChain`
 * already protects (one source of truth for "what a record IS"). Additive.
 */
export function recordPreimage(rec: LedgerRecord): string {
  return hashPreimage(rec.seq, rec.prevHash, rec.kind, rec.payload, rec.signerSourceId);
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * In-memory {@link PendingLedger}: an append-only array of records plus a registry
 * of signer public keys (so {@link verifyChain} can re-verify every signature
 * standalone). Mirrors the Tanaka/SQLite receipt pattern behind a swappable
 * interface; a durable backend can replace it without touching callers.
 */
class InMemoryPendingLedger implements PendingLedger {
  /** The append-only chain. Never mutated in place after append. */
  private readonly chain: LedgerRecord[] = [];
  /** SourceId -> SPKI public key PEM, registered on every append for verification. */
  private readonly signerKeys = new Map<SourceId, string>();
  /** Whether the ledger records content hashes instead of plain pending bodies. */
  private readonly contentBlind: boolean;
  /** The reputation ledger driven on approval (winner up / losers down). */
  private readonly reputation: ReputationLedger | null;

  constructor(opts: { contentBlind: boolean; reputation: ReputationLedger | null }) {
    this.contentBlind = opts.contentBlind;
    this.reputation = opts.reputation;
  }

  records(): readonly LedgerRecord[] {
    return this.chain;
  }

  appendPending(pending: PendingRatification, systemSigner: KeyPair): LedgerRecord {
    const basePayload: PendingPayload = {
      contradictionSetId: pending.contradictionSetId,
      attribute: pending.attribute,
      members: [...pending.members],
      reason: pending.reason,
      createdAt: pending.createdAt,
    };
    // Content-blindness option: record only a content fingerprint of the dispute
    // (the human reviews bodies out-of-band). Built from the immutable members +
    // attribute so the same dispute always fingerprints the same.
    const payload: PendingPayload = this.contentBlind
      ? {
          ...basePayload,
          contentHash: sha256Hex(
            canonicalPending(basePayload),
          ),
        }
      : basePayload;

    return this.append("PENDING", payload, systemSigner);
  }

  listPending(): readonly PendingPayload[] {
    // A dispute is OPEN iff it has a PENDING and no later APPROVAL. Approvals are
    // terminal, so a single pass collecting approved set ids then filtering pendings
    // is sufficient.
    const approved = new Set<string>();
    for (const r of this.chain) {
      if (r.kind === "APPROVAL") {
        approved.add(String((r.payload as ApprovalPayload).contradictionSetId));
      }
    }
    const open: PendingPayload[] = [];
    for (const r of this.chain) {
      if (r.kind !== "PENDING") continue;
      const p = r.payload as PendingPayload;
      if (!approved.has(String(p.contradictionSetId))) open.push(p);
    }
    return open;
  }

  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    now: EpochMs,
    ctx: ApproveContext,
  ): ResolvedDispute {
    // 1) Find the OPEN pending for this dispute (unknown / already-resolved => throw).
    const pending = this.openPendingFor(contradictionSetId);
    if (pending === null) {
      throw new Error(
        `approve: no open dispute for ${String(contradictionSetId)} (unknown or already resolved).`,
      );
    }

    // 2) The winner must be a member of the dispute.
    const members = pending.members;
    if (!members.some((m) => m === winnerStrandId)) {
      throw new Error(
        `approve: winner ${String(winnerStrandId)} is not a member of ${String(contradictionSetId)}.`,
      );
    }

    // 3) PROVENANCE GATE ("no provenance -> no voice"): the approver must present a
    //    VERIFIABLE passport. We prove control of the key by checking a signature
    //    over the approver's own derived source id, and confirm the public key
    //    actually derives the claimed source id (no forged signerSourceId).
    const approverSourceId = sourceIdFromPublicKey(approver.publicKeyPem);
    if (approverSourceId !== approver.sourceId) {
      throw new Error(
        "approve: approver passport is inconsistent (public key does not derive its sourceId).",
      );
    }
    const proof = sign(approver.privateKeyPem, utf8(String(approverSourceId)));
    if (!verify(approver.publicKeyPem, utf8(String(approverSourceId)), proof)) {
      throw new Error("approve: approver signature did not verify (forged / no provenance).");
    }

    // 4) DISTINCT-APPROVER GATE (the second-admin rule): the approver must NOT have
    //    authored ANY disputed member. Self-approval is forbidden — an EXTERNAL,
    //    distinct admin judges; the web never does.
    for (const memberId of members) {
      for (const author of ctx.authorsOf(memberId)) {
        if (author === approverSourceId) {
          throw new Error(
            `approve: self-approval rejected — approver ${String(approverSourceId)} authored member ${String(memberId)}.`,
          );
        }
      }
    }

    // 5) Record the immutable APPROVAL receipt FIRST (the decision is now permanent
    //    even if a later store write fails — the ledger is the source of truth).
    const approvalPayload: ApprovalPayload = {
      contradictionSetId,
      winner: winnerStrandId,
      approverSourceId,
      approvedAt: now,
    };
    const record = this.append("APPROVAL", approvalPayload, approver);

    // 6) RESOLVE: mint OUTRANKS winner -> each OTHER member and demote the loser.
    //    Demotion DEMOTES, never deletes (sets DEMOTED + outranked_by). Reputation
    //    is driven against the shared ledger: winner ratified, losers contradicted.
    const outranksEdges: Edge[] = [];
    const demotions: DemotionResult[] = [];
    for (const memberId of members) {
      if (memberId === winnerStrandId) continue;
      const loser = ctx.memberStrand(memberId);
      const edge: Edge = {
        id: ctx.mintEdgeId(winnerStrandId, memberId),
        from: winnerStrandId,
        to: memberId,
        edgeType: EdgeType.OUTRANKS,
        link_confidence: 1 as Unit,
        provenance_independence: 1 as Unit,
        recency: 1 as Unit,
        w: 1 as Unit,
        out_weight_sum: 1 as Unit,
      };
      outranksEdges.push(edge);
      // The live member object the engine will persist is mutated in place by the
      // pure `demote` (fact_state -> DEMOTED + outranked_by set). Never deleted.
      demotions.push(demote(loser, edge));
      // Drive reputation DOWN for each loser's authors (a contradicted claim).
      if (this.reputation !== null) {
        for (const author of ctx.authorsOf(memberId)) {
          this.reputation.contradict(author, now);
        }
      }
    }

    // Drive reputation UP for the winner's authors (an externally-ratified claim).
    if (this.reputation !== null) {
      for (const author of ctx.authorsOf(winnerStrandId)) {
        this.reputation.ratify(author, now);
      }
    }

    return {
      contradictionSetId,
      winner: winnerStrandId,
      outranksEdges,
      demotions,
      record,
    };
  }

  verifyChain(): ChainVerification {
    let expectedPrev = GENESIS_PREV_HASH;
    for (let i = 0; i < this.chain.length; i++) {
      const r = this.chain[i]!;

      // (a) seq must be the chain position (no re-ordering / gaps).
      if (r.seq !== i) return { ok: false, firstBrokenSeq: i };

      // (b) chain link: prevHash must equal the previous record's thisHash
      //     (genesis-anchored for seq 0).
      if (r.prevHash !== expectedPrev) return { ok: false, firstBrokenSeq: i };

      // (c) recompute thisHash over the canonical preimage; any flipped field shows.
      const recomputed = sha256Hex(
        hashPreimage(r.seq, r.prevHash, r.kind, r.payload, r.signerSourceId),
      );
      if (recomputed !== r.thisHash) return { ok: false, firstBrokenSeq: i };

      // (d) signature: a known signer key must verify the sig over utf8(thisHash).
      const pem = this.signerKeys.get(r.signerSourceId);
      if (pem === undefined) return { ok: false, firstBrokenSeq: i };
      let sigBytes: Uint8Array;
      try {
        sigBytes = new Uint8Array(Buffer.from(r.sig, "base64url"));
      } catch {
        return { ok: false, firstBrokenSeq: i };
      }
      if (!verify(pem, utf8(r.thisHash), sigBytes)) {
        return { ok: false, firstBrokenSeq: i };
      }

      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  // -- internals ------------------------------------------------------------

  /** The open PENDING payload for a dispute, or null if unknown / already approved. */
  private openPendingFor(contradictionSetId: ContradictionSetId): PendingPayload | null {
    let pending: PendingPayload | null = null;
    for (const r of this.chain) {
      if (
        r.kind === "PENDING" &&
        (r.payload as PendingPayload).contradictionSetId === contradictionSetId
      ) {
        pending = r.payload as PendingPayload;
      }
      if (
        r.kind === "APPROVAL" &&
        (r.payload as ApprovalPayload).contradictionSetId === contradictionSetId
      ) {
        return null; // already resolved
      }
    }
    return pending;
  }

  /**
   * Append one signed, hash-chained record. Registers the signer's public key (so
   * verifyChain can re-verify standalone), computes the chain link + canonical
   * hash, signs it, and pushes it. The single mutation point of the chain.
   */
  private append(
    kind: LedgerRecordKind,
    payload: PendingPayload | ApprovalPayload,
    signer: KeyPair,
  ): LedgerRecord {
    // Register the signer's verifying key (idempotent on its sourceId).
    const passport: Passport = { sourceId: signer.sourceId, publicKeyPem: signer.publicKeyPem };
    this.signerKeys.set(passport.sourceId, passport.publicKeyPem);

    const seq = this.chain.length;
    const prevHash = seq === 0 ? GENESIS_PREV_HASH : this.chain[seq - 1]!.thisHash;
    const thisHash = sha256Hex(
      hashPreimage(seq, prevHash, kind, payload, signer.sourceId),
    );
    const sigBytes = sign(signer.privateKeyPem, utf8(thisHash));
    const sig = Buffer.from(sigBytes).toString("base64url");

    const record: LedgerRecord = {
      seq,
      prevHash,
      kind,
      payload,
      signerSourceId: signer.sourceId,
      thisHash,
      sig,
    };
    this.chain.push(record);
    return record;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh, empty {@link PendingLedger} (the in-memory VAULT + DOORBELL).
 *
 * @param opts.contentBlind when true, PENDING records carry only a `contentHash`
 *                          fingerprint of the dispute (bodies reviewed out-of-band);
 *                          defaults to false (plain member ids recorded).
 * @param opts.reputation   the shared {@link ReputationLedger} driven on approval
 *                          (winner's authors ratified, losers' authors contradicted);
 *                          MUST be the same instance backing the identity facade so
 *                          the next stamp reflects the change. Null => no rep drive.
 */
export function createPendingLedger(
  opts: { contentBlind?: boolean; reputation?: ReputationLedger | null } = {},
): PendingLedger {
  return new InMemoryPendingLedger({
    contentBlind: opts.contentBlind ?? false,
    reputation: opts.reputation ?? null,
  });
}

// ---------------------------------------------------------------------------
// Durable, SQLite-backed implementation (DROP-IN — SAME canonical form + chain)
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` (not a static
 * import) — identical rationale to `store/sqliteStore.ts`: the `node:` built-in is
 * newer than the test transformer's hardcoded list, so a static import fails to
 * bundle; the runtime require is opaque to that analysis (ZERO external deps).
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * The {@link PendingLedger} a {@link createSqlitePendingLedger} returns, widened with
 * {@link close}. Still assignable to {@link PendingLedger}, so it is a DROP-IN for
 * the in-memory ledger everywhere.
 */
export interface SqlitePendingLedger extends PendingLedger {
  /** Close the underlying handle (no-op for a borrowed, shared handle). */
  close(): void;
}

/** Narrow a SQLite output cell that must be a string (a NOT NULL column). */
function pendingAsString(v: unknown): string {
  return v as string;
}

/**
 * Durable, WAL-mode, SQLite-backed {@link PendingLedger}: the VAULT (immutable signed
 * record) + DOORBELL (second-admin approve flow) persisted to disk so the AUDIT TRAIL
 * survives a restart AND stays tamper-evident.
 *
 * Tables:
 *  - `ratification_records(seq INTEGER PRIMARY KEY, json)` — `seq` IS the row key, so
 *    the chain ORDER is preserved by the primary key and cannot be re-ordered; the
 *    ledger assigns `seq` (no AUTOINCREMENT needed).
 *  - `signer_keys(source_id PRIMARY KEY, pubkey_pem)` — the registered verifying keys.
 *    This table is the #1 reopen trap: WITHOUT it, after a restart {@link verifyChain}
 *    has no pubkeys and reports a valid chain as broken at seq 0 ("unknown signer").
 *    It is written in the SAME `append` as the record it authorizes.
 *
 * Canonicalization + hashing reuse the module-private {@link hashPreimage} /
 * {@link sha256Hex} / {@link utf8} / {@link GENESIS_PREV_HASH} verbatim (co-located
 * here precisely so the persisted preimage is BYTE-IDENTICAL to the in-memory form),
 * which is what makes `verifyChain()` re-verify true after a reopen and STILL detect a
 * flipped byte in a persisted row (naming the first broken seq).
 */
class SqlitePendingLedgerImpl implements SqlitePendingLedger {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;
  readonly #contentBlind: boolean;
  readonly #reputation: ReputationLedger | null;

  readonly #insertRecord;
  readonly #allRecords;
  readonly #countRecords;
  readonly #lastRecord;
  readonly #upsertKey;
  readonly #getKey;

  constructor(opts: {
    db: DatabaseSyncType;
    ownsDb: boolean;
    contentBlind: boolean;
    reputation: ReputationLedger | null;
  }) {
    this.#db = opts.db;
    this.#ownsDb = opts.ownsDb;
    this.#contentBlind = opts.contentBlind;
    this.#reputation = opts.reputation;

    if (opts.ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ratification_records (
         seq  INTEGER PRIMARY KEY,
         json TEXT NOT NULL
       )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS signer_keys (
         source_id  TEXT PRIMARY KEY,
         pubkey_pem TEXT NOT NULL
       )`,
    );

    this.#insertRecord = this.#db.prepare(
      "INSERT INTO ratification_records (seq, json) VALUES (?, ?)",
    );
    this.#allRecords = this.#db.prepare(
      "SELECT json FROM ratification_records ORDER BY seq",
    );
    this.#countRecords = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM ratification_records",
    );
    this.#lastRecord = this.#db.prepare(
      "SELECT json FROM ratification_records ORDER BY seq DESC LIMIT 1",
    );
    this.#upsertKey = this.#db.prepare(
      `INSERT INTO signer_keys (source_id, pubkey_pem) VALUES (?, ?)
       ON CONFLICT(source_id) DO UPDATE SET pubkey_pem = excluded.pubkey_pem`,
    );
    this.#getKey = this.#db.prepare(
      "SELECT pubkey_pem FROM signer_keys WHERE source_id = ?",
    );
  }

  #parse(json: string): LedgerRecord {
    return JSON.parse(json) as LedgerRecord;
  }

  #chain(): LedgerRecord[] {
    return this.#allRecords.all().map((r) => this.#parse(pendingAsString(r.json)));
  }

  records(): readonly LedgerRecord[] {
    return this.#chain();
  }

  appendPending(pending: PendingRatification, systemSigner: KeyPair): LedgerRecord {
    const basePayload: PendingPayload = {
      contradictionSetId: pending.contradictionSetId,
      attribute: pending.attribute,
      members: [...pending.members],
      reason: pending.reason,
      createdAt: pending.createdAt,
    };
    const payload: PendingPayload = this.#contentBlind
      ? { ...basePayload, contentHash: sha256Hex(canonicalPending(basePayload)) }
      : basePayload;
    return this.#append("PENDING", payload, systemSigner);
  }

  listPending(): readonly PendingPayload[] {
    const chain = this.#chain();
    const approved = new Set<string>();
    for (const r of chain) {
      if (r.kind === "APPROVAL") {
        approved.add(String((r.payload as ApprovalPayload).contradictionSetId));
      }
    }
    const open: PendingPayload[] = [];
    for (const r of chain) {
      if (r.kind !== "PENDING") continue;
      const p = r.payload as PendingPayload;
      if (!approved.has(String(p.contradictionSetId))) open.push(p);
    }
    return open;
  }

  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    now: EpochMs,
    ctx: ApproveContext,
  ): ResolvedDispute {
    const pending = this.#openPendingFor(contradictionSetId);
    if (pending === null) {
      throw new Error(
        `approve: no open dispute for ${String(contradictionSetId)} (unknown or already resolved).`,
      );
    }

    const members = pending.members;
    if (!members.some((m) => m === winnerStrandId)) {
      throw new Error(
        `approve: winner ${String(winnerStrandId)} is not a member of ${String(contradictionSetId)}.`,
      );
    }

    const approverSourceId = sourceIdFromPublicKey(approver.publicKeyPem);
    if (approverSourceId !== approver.sourceId) {
      throw new Error(
        "approve: approver passport is inconsistent (public key does not derive its sourceId).",
      );
    }
    const proof = sign(approver.privateKeyPem, utf8(String(approverSourceId)));
    if (!verify(approver.publicKeyPem, utf8(String(approverSourceId)), proof)) {
      throw new Error("approve: approver signature did not verify (forged / no provenance).");
    }

    for (const memberId of members) {
      for (const author of ctx.authorsOf(memberId)) {
        if (author === approverSourceId) {
          throw new Error(
            `approve: self-approval rejected — approver ${String(approverSourceId)} authored member ${String(memberId)}.`,
          );
        }
      }
    }

    const approvalPayload: ApprovalPayload = {
      contradictionSetId,
      winner: winnerStrandId,
      approverSourceId,
      approvedAt: now,
    };
    const record = this.#append("APPROVAL", approvalPayload, approver);

    const outranksEdges: Edge[] = [];
    const demotions: DemotionResult[] = [];
    for (const memberId of members) {
      if (memberId === winnerStrandId) continue;
      const loser = ctx.memberStrand(memberId);
      const edge: Edge = {
        id: ctx.mintEdgeId(winnerStrandId, memberId),
        from: winnerStrandId,
        to: memberId,
        edgeType: EdgeType.OUTRANKS,
        link_confidence: 1 as Unit,
        provenance_independence: 1 as Unit,
        recency: 1 as Unit,
        w: 1 as Unit,
        out_weight_sum: 1 as Unit,
      };
      outranksEdges.push(edge);
      demotions.push(demote(loser, edge));
      if (this.#reputation !== null) {
        for (const author of ctx.authorsOf(memberId)) {
          this.#reputation.contradict(author, now);
        }
      }
    }

    if (this.#reputation !== null) {
      for (const author of ctx.authorsOf(winnerStrandId)) {
        this.#reputation.ratify(author, now);
      }
    }

    return { contradictionSetId, winner: winnerStrandId, outranksEdges, demotions, record };
  }

  verifyChain(): ChainVerification {
    const chain = this.#chain();
    let expectedPrev = GENESIS_PREV_HASH;
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i]!;

      if (r.seq !== i) return { ok: false, firstBrokenSeq: i };
      if (r.prevHash !== expectedPrev) return { ok: false, firstBrokenSeq: i };

      const recomputed = sha256Hex(
        hashPreimage(r.seq, r.prevHash, r.kind, r.payload, r.signerSourceId),
      );
      if (recomputed !== r.thisHash) return { ok: false, firstBrokenSeq: i };

      const keyRow = this.#getKey.get(r.signerSourceId as string);
      if (keyRow === undefined) return { ok: false, firstBrokenSeq: i };
      const pem = pendingAsString(keyRow.pubkey_pem);
      let sigBytes: Uint8Array;
      try {
        sigBytes = new Uint8Array(Buffer.from(r.sig, "base64url"));
      } catch {
        return { ok: false, firstBrokenSeq: i };
      }
      if (!verify(pem, utf8(r.thisHash), sigBytes)) {
        return { ok: false, firstBrokenSeq: i };
      }

      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  // -- internals ------------------------------------------------------------

  #openPendingFor(contradictionSetId: ContradictionSetId): PendingPayload | null {
    let pending: PendingPayload | null = null;
    for (const r of this.#chain()) {
      if (
        r.kind === "PENDING" &&
        (r.payload as PendingPayload).contradictionSetId === contradictionSetId
      ) {
        pending = r.payload as PendingPayload;
      }
      if (
        r.kind === "APPROVAL" &&
        (r.payload as ApprovalPayload).contradictionSetId === contradictionSetId
      ) {
        return null;
      }
    }
    return pending;
  }

  /**
   * Append one signed, hash-chained record to DISK. Registers the signer's public
   * key in `signer_keys` (so {@link verifyChain} re-verifies standalone after a
   * reopen with empty process memory), computes the chain link from the persisted
   * tail, signs the canonical hash, and inserts the record JSON. The single mutation
   * point of the chain — exactly like the in-memory ledger's `append`.
   */
  #append(
    kind: LedgerRecordKind,
    payload: PendingPayload | ApprovalPayload,
    signer: KeyPair,
  ): LedgerRecord {
    const passport: Passport = {
      sourceId: signer.sourceId,
      publicKeyPem: signer.publicKeyPem,
    };
    this.#upsertKey.run(passport.sourceId as string, passport.publicKeyPem);

    const seq = Number((this.#countRecords.get() as { n: number }).n);
    const tail = this.#lastRecord.get();
    const prevHash =
      seq === 0
        ? GENESIS_PREV_HASH
        : this.#parse(pendingAsString((tail as { json: unknown }).json)).thisHash;
    const thisHash = sha256Hex(
      hashPreimage(seq, prevHash, kind, payload, signer.sourceId),
    );
    const sigBytes = sign(signer.privateKeyPem, utf8(thisHash));
    const sig = Buffer.from(sigBytes).toString("base64url");

    const record: LedgerRecord = {
      seq,
      prevHash,
      kind,
      payload,
      signerSourceId: signer.sourceId,
      thisHash,
      sig,
    };
    this.#insertRecord.run(seq, JSON.stringify(record));
    return record;
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a DURABLE, SQLite-backed {@link PendingLedger} — a DROP-IN for
 * {@link createPendingLedger} whose hash-chained, signed AUDIT TRAIL survives a
 * restart and stays tamper-evident: after close + reopen, {@link verifyChain} returns
 * `ok:true` on an untampered chain and STILL detects a flipped byte in a persisted row
 * (naming the first broken seq).
 *
 * Pass EITHER a `path` (own + close its WAL-mode handle) OR a shared, already-open
 * `db` handle (facts + trust + audit in ONE crash-consistent file — the bank's
 * atomic-durability default; `close()` is then a no-op — only the owner may close).
 */
export function createSqlitePendingLedger(
  opts:
    | { path: string; contentBlind?: boolean; reputation?: ReputationLedger | null }
    | { db: DatabaseSyncType; contentBlind?: boolean; reputation?: ReputationLedger | null },
): SqlitePendingLedger {
  const contentBlind = opts.contentBlind ?? false;
  const reputation = opts.reputation ?? null;
  if ("path" in opts) {
    return new SqlitePendingLedgerImpl({
      db: new DatabaseSync(opts.path),
      ownsDb: true,
      contentBlind,
      reputation,
    });
  }
  return new SqlitePendingLedgerImpl({
    db: opts.db,
    ownsDb: false,
    contentBlind,
    reputation,
  });
}
