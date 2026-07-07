/**
 * ratification/pendingLedger.ts — THE VAULT AND THE DOORBELL.
 *
 * This module BACKS the `PendingRatification` horn (CLAUDE.md "Still stubbed /
 * open"). The prior council verdict on the Tanaka project was that it is "a vault
 * and a doorbell, never a judge". We adopt its two load-bearing shapes natively in
 * TypeScript — we do NOT import the Python project; we build the Tanaka-SHAPED
 * mechanism in our own stack:
 *
 *   (a) THE VAULT — an append-only, hash-chained ratification LEDGER: a
 *       TAMPER-EVIDENT CHECKSUM CHAIN. Each record chains to the previous by
 *       `prevHash` (genesis = sha256("GENESIS")) and carries its own `thisHash`
 *       over a CANONICAL serialization of its fields. A standalone
 *       {@link PendingLedger.verifyChain} walks the chain, recomputes every hash,
 *       and names the FIRST broken seq — the "money artifact": flip any byte
 *       anywhere and verification reports `ok:false` and points at the break.
 *
 *       HONEST DISCLOSURE (read before trusting the chain): `signerSourceId` on a
 *       record is ASSERTED attribution, and the chain's integrity rests on the
 *       INTEGRITY OF THE WRITING PROCESS and on WHERE the chain is stored. An
 *       actor with live write access to the process or its storage can rewrite
 *       history wholesale — recompute every checksum — and `verifyChain` will
 *       still report `ok:true`. The checksum chain detects ACCIDENTAL corruption
 *       and OUT-OF-BAND tampering with a copy at rest; it does not, by itself,
 *       detect an insider with the pen. Deployments that want insider-tamper
 *       evidence have two composable options, both plain data, both consuming
 *       infrastructure the deployment already owns:
 *         - CHECKPOINTS ({@link PendingLedger.chainHead} — `{seq, headHash}`)
 *           shipped to ACCESS-SEGREGATED external storage on a schedule; a later
 *           head that cannot extend a checkpointed one exposes the rewrite.
 *           Detection granularity = checkpoint frequency.
 *         - REAL-TIME SHIPPING (an {@link AppendSink} passed at construction):
 *           every record is handed to the sink AS IT IS WRITTEN, so the external
 *           copy (an append-only file under a different OS account, the
 *           deployment's SIEM/audit stack, WORM storage) holds the full history
 *           the local writer cannot recall. A local rewrite then diverges from
 *           the already-shipped copy at the first rewritten seq. As shipping
 *           latency approaches zero, detection approaches prevention.
 *
 *   (b) THE DOORBELL — a SECOND-ADMIN PENDING -> approve flow. The web NEVER judges
 *       an independent dispute (the hard theorem, CLAUDE.md). An EXTERNAL approver
 *       — DISTINCT from every source that authored a disputed member — designates
 *       the winner, and the decision is recorded immutably as an APPROVAL
 *       receipt. Self-approval (the approver authored a member) is REJECTED: the
 *       second-admin / distinct gate. An unregistered / anchorless approver is
 *       rejected ("no provenance -> no voice" — registration in the identity
 *       layer with at least one anchor IS the provenance).
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
 * (every type-only import uses `import type`); `node:crypto` only (SHA-256 as a
 * CHECKSUM), no external deps. Hashes are carried as hex STRINGS so a record is
 * plain, serializable JSON with a stable canonical form.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  EdgeType,
  FactState,
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

import { demote, promote } from "../forgetting/consolidation.js";
import type {
  DemotionResult,
  PendingRatification,
  PromotionResult,
} from "../forgetting/consolidation.js";

import type { ReputationLedger } from "../identity/reputation.js";
import { runMigrations } from "../store/migrations.js";
import { assertSharedHandleWal } from "../store/sqliteStore.js";

// ---------------------------------------------------------------------------
// Record shapes (the VAULT's contents)
// ---------------------------------------------------------------------------

/** The three kinds of record the ratification ledger holds. */
export type LedgerRecordKind = "PENDING" | "APPROVAL" | "MUTATION";

/**
 * A1 [MUTATION audit coverage] — the control-plane state transitions journaled as
 * content-addressed MUTATION receipts. Each names the FACT of a trust mutation the
 * undo engine performed, so every effect (disown crater / demotion / reputation move /
 * credit reversal) earns a committed chain record — closing the "hide-a-disown" hole
 * where a demotion had no audit record and could be hidden with `verifyChain` green.
 */
export type MutationOp =
  | "DISOWN_CRATER" // the disowned source's direct-seed reputation crater
  | "DEMOTE" // a strand demoted (covers its OUTRANKS edge by after-state)
  | "PROMOTE" // an approve() winner promoted DEMOTED->LIVE (REOPENED_BY_DISOWN pick)
  | "REPUTATION_CONTRADICT" // a contradict β-bump (adjudicate loser / disown downstream)
  | "REPUTATION_RATIFY" // an approve winner's α-bump
  | "REPUTATION_REVERSE_CREDIT"; // an exact corroboration-credit reversal

/**
 * A1 — a content-addressed MUTATION receipt: the immutable WITNESS that a control-plane
 * trust mutation occurred. It commits to the FACT of a transition (subject + before/after
 * digests), NEVER to a claim's truth (governing invariant 1: the model never witnesses).
 * `refEventId` optionally links the receipt to the driving artifact (a corroboration
 * `eventId`, a `contradictionSetId`, the OUTRANKS edge id) for offline audit. All fields
 * are primitive id/hash strings → plain, stable canonical JSON.
 */
export interface MutationPayload {
  readonly op: MutationOp;
  /** The acted-on subject id (a StrandId, SourceId, or ContradictionSetId), as a string. */
  readonly subjectId: string;
  /** Content-address of the subject's IDENTITY (e.g. a strand's content_hash, a source id hash). */
  readonly subjectHash: string;
  /** Content-address of the PRE-mutation state ({@link EMPTY_STATE_HASH} if none). */
  readonly beforeHash: string;
  /** Content-address of the POST-mutation state. */
  readonly afterHash: string;
  /** OPTIONAL link to the driving artifact (corroboration eventId / dispute id / edge id). */
  readonly refEventId?: string;
  readonly at: EpochMs;
}

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
  /**
   * OD-2 [horn rate-limiting] OPTIONAL cross-attribute dedup key = a fingerprint of the
   * disputed VALUE + the sorted disputing-source set, with `attribute` EXCLUDED (so the
   * SAME source-pair disputing the SAME value across many attributes coalesces to one
   * enqueue). Engine-computed (OD-8). Omitted by legacy callers ⇒ within-attribute dedup
   * falls back to {@link contentHash}. Emitted into the hash preimage ONLY WHEN PRESENT.
   */
  readonly coalesceKey?: string;
  /**
   * OD-2 [horn rate-limiting] OPTIONAL distinct disputing SOURCE ids (as strings) behind
   * this dispute's members, engine-resolved from `provenance[].sourceId` (the ledger has
   * no identity layer — OD-8 engine-owned evidence). Used by the per-source pending cap.
   * Emitted into the hash preimage ONLY WHEN PRESENT.
   */
  readonly disputingSources?: readonly string[];
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
  /**
   * PHASE 4 [owner-override] — present (and `true`) ONLY when this approval was
   * resolved under {@link ApproveContext.allowAuthorApprover}: the PERSONAL-tier
   * owner answered a dispute they may themselves have authored a side of. The
   * flag is COMMITTED into the checksum (emit-only-when-present, exactly like
   * {@link PendingPayload.contentHash}), so the immortal chain records — auditable
   * forever — that this resolution was an owner override rather than a
   * distinct-second-admin decision. Absent on every enterprise approval.
   */
  readonly ownerOverride?: boolean;
}

/**
 * One immutable record in the append-only, hash-chained ledger (the tamper-evident
 * CHECKSUM CHAIN).
 *
 * Tamper-evidence is structural: `thisHash` is sha256 over the CANONICAL
 * serialization of `{seq, prevHash, kind, payload, signerSourceId}` (everything
 * EXCEPT `thisHash`), and `prevHash` chains to the previous record's `thisHash`
 * (genesis = sha256("GENESIS")). Flip any field of a record AT REST and either the
 * recomputed `thisHash` or the chain link fails — and
 * {@link PendingLedger.verifyChain} names the first broken seq.
 *
 * `signerSourceId` is ASSERTED attribution: the id of the actor the writing
 * process says authored the record. It is committed into the checksum (so it
 * cannot be silently edited at rest) but NOT independently proven — see the module
 * doc's honest disclosure about write-access integrity and chain checkpoints.
 */
export interface LedgerRecord {
  /** 0-based position in the append-only chain. */
  readonly seq: number;
  /** sha256 (hex) of the previous record's `thisHash`; genesis = sha256("GENESIS"). */
  readonly prevHash: string;
  readonly kind: LedgerRecordKind;
  readonly payload: PendingPayload | ApprovalPayload | MutationPayload;
  /** The {@link SourceId} of the record's author — ASSERTED attribution (see above). */
  readonly signerSourceId: SourceId;
  /** sha256 (hex) over canonical({seq,prevHash,kind,payload,signerSourceId}). */
  readonly thisHash: string;
}

// ---------------------------------------------------------------------------
// OD-2 — HORN RATE-LIMITING (cross-attribute dedup + per-source pending cap)
// ---------------------------------------------------------------------------

/**
 * The default per-source OPEN-pending cap K (OD-2.1.2): beyond K open disputes naming a
 * single source, a further pending naming that source is coalesced / rejected (no-op).
 * Well above any honest review backlog, far below a flood. Interim tunable; the
 * STRUCTURAL closure (stake-to-enqueue) is a COMMITTED FOLLOW-ON, NOT V2.
 */
const DEFAULT_PER_SOURCE_CAP = 64;

/**
 * OD-2 [horn rate-limiting] OPTIONAL, ADDITIVE evidence the ENGINE supplies so the ledger
 * can bound the human horn WITHOUT importing the identity layer (it sees only StrandIds;
 * the disputing source-pair is engine-owned evidence — OD-8). Omitting `opts` entirely
 * ⇒ EXACTLY today's behavior (unconditional append), so the 272 baseline and existing
 * ledger tests stay green.
 *
 * F4a strictly INCREASES deferrals (`al-c3-05`, Sandbag-the-Doorbell — "the DEFER is the
 * payload"); shipping F4a on an uncapped horn would convert an integrity DEFER into an
 * availability DOS-DEFER = breach. OD-2 is therefore the HARD PREREQUISITE bundled with
 * F4a: it makes the extra deferrals bounded.
 */
export interface AppendPendingOptions {
  /** The distinct disputing SOURCE ids behind this dispute's members (engine-resolved). */
  readonly disputingSources?: readonly SourceId[];
  /**
   * Attribute-INDEPENDENT dispute fingerprint = value content-hash + sorted disputing
   * sources, with `attribute` EXCLUDED; used for cross-attribute dedup. Omitted ⇒ fall
   * back to the in-payload {@link PendingPayload.contentHash} (within-attribute dedup only).
   */
  readonly coalesceKey?: string;
  /** Per-source OPEN-pending cap; defaults to {@link DEFAULT_PER_SOURCE_CAP} if omitted. */
  readonly perSourceCap?: number;
}

/**
 * The OD-2 horn rate-limit decision: scanning the currently-OPEN PENDING records, decide
 * whether the new pending is a DUPLICATE (same coalesce key already open) or a CAP HIT
 * (some disputing source already at its per-source cap). Either way return the EXISTING
 * matching OPEN record (a no-op: the chain is NOT advanced, no second record is
 * minted, callers reading the return get a stable record). Returns `null` when the
 * pending is genuinely new and must be appended.
 *
 * The chain therefore stays a faithful record of DISTINCT disputes; one attacker flooding
 * N attributes from one source collapses to a bounded number of enqueues.
 */
function hornRateLimitDecision(
  openRecords: readonly LedgerRecord[],
  newPayload: PendingPayload,
  opts: AppendPendingOptions,
): LedgerRecord | null {
  // (1) Cross-attribute dedup: explicit coalesceKey, else fall back to contentHash.
  const newKey = newPayload.coalesceKey ?? newPayload.contentHash;
  if (newKey !== undefined) {
    for (const r of openRecords) {
      const p = r.payload as PendingPayload;
      const existingKey = p.coalesceKey ?? p.contentHash;
      if (existingKey !== undefined && existingKey === newKey) {
        return r; // duplicate dispute already OPEN ⇒ no-op
      }
    }
  }

  // (2) Per-source pending cap K: if any disputing source already names >= cap OPEN
  //     pendings, a further pending naming it is coalesced (no-op). Per-source, so one
  //     attacker cannot consume the shared serial human resource.
  const sources = newPayload.disputingSources ?? [];
  if (sources.length > 0) {
    const cap = opts.perSourceCap ?? DEFAULT_PER_SOURCE_CAP;
    for (const s of sources) {
      let count = 0;
      let witness: LedgerRecord | null = null;
      for (const r of openRecords) {
        const ds = (r.payload as PendingPayload).disputingSources;
        if (ds !== undefined && ds.includes(s)) {
          count++;
          if (witness === null) witness = r;
        }
      }
      if (count >= cap && witness !== null) return witness; // cap hit ⇒ no-op
    }
  }

  return null; // genuinely new dispute ⇒ append
}

// ---------------------------------------------------------------------------
// Verification result (the "money artifact")
// ---------------------------------------------------------------------------

/**
 * The result of walking the whole chain. `ok` is true iff EVERY record's chain
 * link and recomputed hash verify; otherwise `firstBrokenSeq` names the earliest
 * seq at which the chain is inconsistent (a flipped byte, a re-ordered record).
 * This is the standalone audit artifact. Remember the scope: this proves the
 * chain is internally consistent AS STORED — not that a writer with live access
 * didn't rewrite it (see the module doc's disclosure + {@link ChainHead}).
 */
export interface ChainVerification {
  readonly ok: boolean;
  readonly firstBrokenSeq: number | null;
}

/**
 * A CHAIN CHECKPOINT — the cheap, plain-data artifact an operator exports to
 * ACCESS-SEGREGATED external storage (object store, another team's bucket, a
 * printout) to get insider-tamper evidence the in-process checksum chain cannot
 * provide by itself. `headHash` is the `thisHash` of the record at `seq`; a later
 * chain whose record at `seq` does not carry exactly this hash has been rewritten.
 * For an EMPTY chain, `seq` is -1 and `headHash` is the genesis anchor
 * (sha256("GENESIS")). No signing, no keys — just data to put somewhere the
 * writing process cannot reach.
 */
export interface ChainHead {
  /** The seq of the last record (-1 for an empty chain). */
  readonly seq: number;
  /** The `thisHash` of that record (the genesis anchor for an empty chain). */
  readonly headHash: string;
}

/**
 * REAL-TIME AUDIT SHIPPING SINK — the insider-tamper mitigation's second half
 * (see the module doc's HONEST DISCLOSURE). When passed at ledger construction,
 * the sink receives EVERY appended {@link LedgerRecord} (PENDING / APPROVAL /
 * MUTATION), in chain order, as plain serializable data. The deployment pipes it
 * wherever its trust actually lives: an append-only file under a different OS
 * account, the company's SIEM, WORM object storage. No formats are invented here
 * and nothing is signed — the guarantee comes from the ACCESS SEGREGATION of the
 * destination, not from math this codebase owns.
 *
 * ORDERING CONTRACT (load-bearing, do not reorder): the sink is invoked BEFORE
 * the record is written locally.
 *   - Sink THROWS ⇒ the local write never happens (the append fails, and inside a
 *     compound op the whole transaction rolls back). FAIL-CLOSED: a deployment
 *     that wires a strict sink gets "no shipped receipt ⇒ no belief change".
 *     A deployment that prefers availability over strict coupling wraps its own
 *     try/catch inside the sink — the choice is the deployment's, not ours.
 *   - Sink SUCCEEDS but the local write later fails/rolls back ⇒ the external
 *     copy holds a receipt for a change that never committed. That is the SAFE
 *     direction: a false alarm an auditor can resolve, never a committed belief
 *     change with no external trace. The dangerous direction (local record with
 *     no shipped receipt) is structurally impossible under this ordering.
 */
export type AppendSink = (record: LedgerRecord) => void;

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
  /** The winning strand designated by the external approver; ENDS UP LIVE. */
  readonly winner: StrandId;
  /** One OUTRANKS edge winner -> loser per demoted member (to be persisted). */
  readonly outranksEdges: readonly Edge[];
  /** One demotion receipt per loser (the loser strand was mutated in place). */
  readonly demotions: readonly DemotionResult[];
  /**
   * Non-null iff the designated winner was NOT already LIVE and had to be promoted
   * (mutated in place — see {@link promote}). This only ever fires for a
   * `REOPENED_BY_DISOWN` dispute whose threaded-back winner is a strand the
   * ORIGINAL resolution demoted; every pre-existing caller disputes only among
   * already-LIVE members, so this is `null` for them. The engine (api.ts) must
   * persist this strand too when non-null.
   */
  readonly winnerPromotion: PromotionResult | null;
  /** The APPROVAL record appended to the immortal ledger for this decision. */
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
   * Returns the live strand object the engine will persist after mutation — or
   * `null` when the id resolves to nothing (defensive-only in practice: strands
   * are never deleted; reachable via external store tampering or a mismatched
   * store/ledger pairing). A `null` loser is SKIPPED fail-closed — no OUTRANKS
   * edge, no demotion, no contradict for that member — mirroring the disown
   * sweep's "a dangling edge / missing strand skips that node, never aborts".
   * Skipping (not throwing) matters: the APPROVAL record is already appended
   * when losers resolve, so a mid-loop throw would strand the chain in a
   * decided-but-unapplied half-state (or, transactionally, leave the dispute
   * permanently un-resolvable — every retry re-throws on the same dangling id).
   */
  memberStrand(memberId: StrandId): Strand | null;
  /**
   * Mint a fresh OUTRANKS edge id for a (winner, loser) pair. Injected so the
   * engine controls id generation (uuid in production); the ledger stays pure of
   * id policy.
   */
  mintEdgeId(winner: StrandId, loser: StrandId): EdgeId;
  /**
   * RC-5 — true MIS anchor-independence between two sources, delegating to the
   * SAME `anchors.independentSources` predicate the Bron–Kerbosch adjacency in
   * `identity.independentRootCount` is built from, WITH the `independenceBetween
   * > 0` fallback. NOT mere key distinctness. The approver must be
   * `independentSources(approver, author) === true` against EVERY disputed-member
   * author. Supplied by the engine so the ledger imports no identity layer.
   */
  independentSources(a: SourceId, b: SourceId): boolean;
  /**
   * RC-5 precondition — does this source hold ANY priced anchor?
   * (`identity.stampFor(sourceId).anchor_cost > 0`). A bare-key approver (false)
   * can never be the external second lock and is rejected even if class-disjoint
   * ("no anchor → no independent voice").
   */
  approverHasAnchors(sourceId: SourceId): boolean;
  /**
   * PHASE 4 [owner-override] — the EXPLICIT, documented POLICY HOOK for the
   * PERSONAL tier. Default `false`/absent (enterprise semantics UNCHANGED —
   * fail-closed everywhere). When `true`, TWO gates — and ONLY these two — are
   * bypassed:
   *
   *   (1) the DISTINCT-APPROVER gate (self-approval rejection), and
   *   (2) the RC-5 anchor-independence-vs-every-member-author check.
   *
   * WHY this is not a weakening of the enterprise gate: in a mom-and-pop
   * PERSONAL deployment the OWNER **is** the trust root — the auto-provisioned
   * OWNER anchor is EXTERNAL_AUTHORITY-grade (independence weight 0.90, the
   * rep_cap-0.98 "window in the wall-with-a-window" tier), and there IS no
   * second admin to ring. The owner often authored one side of the dispute
   * ("you told me X in March"); the owner overriding their OWN remembered claim
   * is the personal tier's ground truth, not self-dealing. The engine sets this
   * flag ONLY for the owner source (the facade's `resolvePending`); every other
   * caller leaves it absent and gets the full second-admin gate.
   *
   * The gates that remain UNCONDITIONAL under this flag: dispute-open,
   * winner-is-member, and registered-with-anchors ("no provenance → no voice" —
   * even the owner must hold a priced anchor). The resulting APPROVAL record
   * carries {@link ApprovalPayload.ownerOverride} `true`, so the audit chain
   * names the override forever.
   */
  readonly allowAuthorApprover?: boolean;
}

// ---------------------------------------------------------------------------
// The ledger interface (swappable; in-memory implementation below)
// ---------------------------------------------------------------------------

/**
 * The append-only ratification ledger: the VAULT (immutable checksum-chained
 * record) plus the DOORBELL (second-admin approve flow). The in-memory
 * implementation ships here; the interface is swappable for a durable backend
 * (mirroring the Tanaka SQLite receipt pattern) without touching callers.
 */
export interface PendingLedger {
  /**
   * THE DOORBELL (ring). Record a deferred independent dispute as a PENDING
   * record, attributed to the SYSTEM source (the engine's own {@link SourceId}).
   * Returns the appended record. This is the only way a dispute enters the queue.
   *
   * OD-2 [horn rate-limiting]: when `opts` carries the engine-resolved disputing sources
   * + coalesce key, a DUPLICATE (same coalesce key already OPEN) or a CAP HIT (a source
   * already at its per-source cap) is a NO-OP that returns the EXISTING matching OPEN
   * record without advancing the chain. Omitting `opts` ⇒ exactly today's unconditional
   * append (back-compatible).
   */
  appendPending(
    pending: PendingRatification,
    systemSource: SourceId,
    opts?: AppendPendingOptions,
  ): LedgerRecord;

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
   * admin rule) and to be REGISTERED in the identity layer with at least one
   * anchor (fail-closed: an unregistered / anchorless approver is rejected — "no
   * provenance -> no voice"), plus RC-5 anchor-independence of every member author.
   * On success: appends an APPROVAL record and RESOLVES the dispute — mints
   * OUTRANKS winner -> each other member, {@link demote}s the losers (DEMOTED +
   * outranked_by, never deleted), and drives reputation (winner ratified, losers
   * contradicted). Returns a {@link ResolvedDispute} PLAN the engine persists.
   *
   * @throws if the dispute is unknown / already resolved, the winner is not a
   *         member, the approver is unregistered/anchorless, not anchor-independent
   *         of an author, or authored any member (self-approval).
   */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: SourceId,
    now: EpochMs,
    ctx: ApproveContext,
  ): ResolvedDispute;

  /**
   * A1 [MUTATION audit coverage] — journal ONE content-addressed MUTATION receipt,
   * attributed to the system source. Appends a `MUTATION` record to the immortal chain
   * (the audit record for an undo-engine EFFECT). Does NOT participate in the doorbell:
   * a MUTATION never appears in {@link listPending} and is inert to the OD-2 dedup/cap
   * scan (those filter strictly on `kind === "PENDING"`). Idempotency / dedup is the
   * CALLER's concern (the compound op emits exactly the transitions it performed).
   * Returns the appended record.
   */
  appendMutation(payload: MutationPayload, signer: SourceId): LedgerRecord;

  /**
   * THE MONEY ARTIFACT. Walk the whole chain: recompute each record's
   * genesis-anchored `prevHash` link and recompute its `thisHash`. Returns
   * `{ok:true, firstBrokenSeq:null}` for an intact chain, or `{ok:false,
   * firstBrokenSeq:k}` naming the FIRST inconsistent record. Standalone and
   * side-effect-free. Scope: internal consistency AS STORED (see the module doc's
   * disclosure — pair with {@link chainHead} checkpoints for insider-tamper evidence).
   */
  verifyChain(): ChainVerification;

  /**
   * The current CHAIN CHECKPOINT `{seq, headHash}` — plain data the operator ships
   * to access-segregated external storage (see {@link ChainHead}). O(1), read-only.
   */
  chainHead(): ChainHead;

  /** Raw read of every record (audit / persistence). Order is chain order. */
  records(): readonly LedgerRecord[];

  /**
   * OPTIONAL: re-derive the incrementally-maintained OPEN-PENDING index
   * (`listPending()` / the OD-2 scan / `approve()`'s dispute lookup) from
   * whatever is ACTUALLY durably persisted right now, discarding any in-memory
   * bookkeeping. Only meaningful for a backend whose `#append()` writes ride an
   * AMBIENT transaction it does not itself own (the shared-handle SQLite
   * ledger): the incremental index is updated the instant a row is inserted,
   * but if that insert's surrounding transaction is later ROLLED BACK by an
   * outer caller (e.g. `api.ts`'s `approve()`, when a LATER store write in the
   * SAME transaction throws), the SQL row disappears while the in-memory index
   * update does not self-undo — a durable-store-vs-in-memory-cache desync of
   * exactly the shape `approve-desync-default-facade` closed at the ledger/store
   * boundary, just one layer deeper. Callers that wrap a ledger call in a
   * transaction THEY may roll back should call this in their catch branch
   * before rethrowing. The in-memory (non-shared-handle) backend has no ambient
   * transaction to desync from, so implementing this is optional (omit it —
   * back-compatible for any existing `PendingLedger` implementer).
   */
  resyncIndex?(): void;
}

// ---------------------------------------------------------------------------
// Canonical serialization (determinism is load-bearing)
// ---------------------------------------------------------------------------

const GENESIS_PREV_HASH = sha256Hex("GENESIS");

/**
 * sha256 of a UTF-8 string, hex (a checksum, nothing more). Exported (additive,
 * non-breaking) so `daemon/auditChain.ts` can reuse the SAME primitive for its
 * separate hash chain per R8 ("same ledger code") without duplicating the
 * checksum computation.
 */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
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
    // OD-2: emit-only-if-present (mirrors contentHash above) so legacy pendings hash
    // EXACTLY as today; disputingSources sorted for an order-independent preimage.
    p.coalesceKey === undefined ? "" : "ck:" + p.coalesceKey,
    p.disputingSources === undefined
      ? ""
      : "ds:" + [...p.disputingSources].map(String).sort().join(","),
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
    // PHASE 4: emit-only-if-present (mirrors canonicalPending's contentHash) so
    // every legacy approval hashes EXACTLY as before; an owner-override approval
    // commits the override flag into its checksum (tamper-evident at rest).
    p.ownerOverride === undefined ? "" : "oo:" + String(p.ownerOverride),
  ];
  return parts.join("");
}

/**
 * A1 — the "no prior state" sentinel `beforeHash` for a {@link MutationPayload} whose
 * subject had no pre-mutation state (e.g. a never-before-seen reputation state). A
 * stable, module-level constant so two runs hash identically.
 */
export const EMPTY_STATE_HASH = sha256Hex("∅");

/**
 * A1 — CANONICAL JSON of a MUTATION payload: explicit, hand-ordered primitive fields,
 * the leading `"MUTATION"` tag domain-separating it from PENDING / APPROVAL. `refEventId`
 * is emitted ONLY-WHEN-PRESENT (the same emit-only-if-present pattern as
 * {@link canonicalPending}'s `contentHash`), so a receipt without a `refEventId` hashes
 * stably. Joined with the SAME `\x01` payload separator the other canonical forms use.
 */
function canonicalMutation(p: MutationPayload): string {
  const parts = [
    "MUTATION",
    p.op,
    p.subjectId,
    p.subjectHash,
    p.beforeHash,
    p.afterHash,
    String(p.at),
    p.refEventId === undefined ? "" : "ref:" + p.refEventId,
  ];
  return parts.join("\x01");
}

/** Canonical serialization of a payload, discriminated by record kind. */
function canonicalPayload(
  kind: LedgerRecordKind,
  payload: PendingPayload | ApprovalPayload | MutationPayload,
): string {
  switch (kind) {
    case "PENDING":
      return canonicalPending(payload as PendingPayload);
    case "APPROVAL":
      return canonicalApproval(payload as ApprovalPayload);
    case "MUTATION":
      return canonicalMutation(payload as MutationPayload);
  }
}

/**
 * The exact preimage of `thisHash`: a canonical serialization of every record
 * field EXCEPT `thisHash` itself. Recomputed verbatim in {@link verifyChain}.
 */
function hashPreimage(
  seq: number,
  prevHash: string,
  kind: LedgerRecordKind,
  payload: PendingPayload | ApprovalPayload | MutationPayload,
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
 * the record's own `thisHash` already commits to (every field EXCEPT `thisHash`).
 * Exported so external audit tooling can recompute a record's checksum over the SAME
 * bytes the chain commits to (one source of truth for "what a record IS"). Additive.
 */
export function recordPreimage(rec: LedgerRecord): string {
  return hashPreimage(rec.seq, rec.prevHash, rec.kind, rec.payload, rec.signerSourceId);
}

/**
 * Build the {@link PendingPayload} both ledger impls append, identically. Applies the
 * content-blindness fingerprint (computed over the BASE payload, so it is stable and
 * UNAFFECTED by the OD-2 fields) and then attaches the OD-2 `coalesceKey` /
 * `disputingSources` ONLY WHEN PRESENT (exactOptionalPropertyTypes: omit, never assign
 * `undefined`). A legacy call (`opts` omitted, plain mode) yields exactly today's payload.
 */
function buildPendingPayload(
  pending: PendingRatification,
  contentBlind: boolean,
  opts: AppendPendingOptions | undefined,
): PendingPayload {
  const basePayload: PendingPayload = {
    contradictionSetId: pending.contradictionSetId,
    attribute: pending.attribute,
    members: [...pending.members],
    reason: pending.reason,
    createdAt: pending.createdAt,
  };
  let payload: PendingPayload = contentBlind
    ? { ...basePayload, contentHash: sha256Hex(canonicalPending(basePayload)) }
    : basePayload;
  if (opts?.coalesceKey !== undefined) {
    payload = { ...payload, coalesceKey: opts.coalesceKey };
  }
  if (opts?.disputingSources !== undefined && opts.disputingSources.length > 0) {
    payload = { ...payload, disputingSources: opts.disputingSources.map(String) };
  }
  return payload;
}

/**
 * THE APPROVER GATES, shared verbatim by both ledger impls (one source of truth so
 * the in-memory and SQLite doorbells can never drift):
 *
 *   4)  DISTINCT-APPROVER GATE (the second-admin rule): the approver must NOT have
 *       authored ANY disputed member. Self-approval is forbidden — an EXTERNAL,
 *       distinct admin judges; the web never does.
 *   4b) PROVENANCE + RC-5 ANCHOR-DISJOINTNESS GATE ("no provenance → no voice"):
 *       the approver must be REGISTERED with ≥1 priced anchor AND be
 *       MIS-independent of EVERY author of EVERY disputed member — a distinct
 *       source ID is not enough (an attacker can mint distinct ids for free; only
 *       a priced, anchor-disjoint actor is the external second lock). Fail-closed.
 *
 * PHASE 4 [owner-override]: when {@link ApproveContext.allowAuthorApprover} is
 * `true` (the PERSONAL tier's owner — see the hook's doc for WHY this is the
 * tier's ground truth, not a weakening), gates (4) and the RC-5 independence loop
 * of (4b) are bypassed. The registered-with-anchors precondition of (4b) remains
 * UNCONDITIONAL — even the owner shows a priced anchor at the door — as do the
 * dispute-open and winner-is-member gates enforced by the callers.
 */
function enforceApproverGates(
  members: readonly StrandId[],
  approverSourceId: SourceId,
  ctx: ApproveContext,
): void {
  const ownerOverride = ctx.allowAuthorApprover === true;

  // 4) DISTINCT-APPROVER GATE — bypassed ONLY under the explicit owner-override.
  if (!ownerOverride) {
    for (const memberId of members) {
      for (const author of ctx.authorsOf(memberId)) {
        if (author === approverSourceId) {
          throw new Error(
            `approve: self-approval rejected — approver ${String(approverSourceId)} authored member ${String(memberId)}.`,
          );
        }
      }
    }
  }

  // 4b-i) REGISTERED-WITH-ANCHORS — UNCONDITIONAL (never bypassed; fail-closed:
  //       an unregistered / anchorless id is rejected, owner-override or not).
  if (!ctx.approverHasAnchors(approverSourceId)) {
    throw new Error(
      `approve: approver ${String(approverSourceId)} holds no priced anchor — no anchor, no independent voice.`,
    );
  }

  // 4b-ii) RC-5 anchor-independence vs EVERY member author — bypassed ONLY under
  //        the explicit owner-override (the owner may have authored a side).
  if (!ownerOverride) {
    for (const memberId of members) {
      for (const author of ctx.authorsOf(memberId)) {
        if (!ctx.independentSources(approverSourceId, author)) {
          throw new Error(
            `approve: approver ${String(approverSourceId)} is not anchor-independent of member author ${String(author)}.`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/**
 * In-memory {@link PendingLedger}: an append-only array of checksum-chained
 * records. Mirrors the Tanaka/SQLite receipt pattern behind a swappable
 * interface; a durable backend can replace it without touching callers.
 */
class InMemoryPendingLedger implements PendingLedger {
  /** The append-only chain. Never mutated in place after append. */
  private readonly chain: LedgerRecord[] = [];
  /** Whether the ledger records content hashes instead of plain pending bodies. */
  private readonly contentBlind: boolean;
  /** The reputation ledger driven on approval (winner up / losers down). */
  private readonly reputation: ReputationLedger | null;
  /** Real-time shipping sink (insider-tamper mitigation); null when unwired. */
  private readonly onAppend: AppendSink | null;

  // -- the incrementally-maintained OPEN-PENDING index (the perf fix) ---------
  //
  // The PRE-FIX shape rebuilt this from scratch — two full passes over `this.chain`
  // — on EVERY `listPending()`, EVERY rate-limited `appendPending()`, and EVERY
  // `approve()`. That is the hot write/dispute path the audit named: a deferred
  // adjudication ALWAYS supplies `opts` (api.ts), so every disputed write scaled
  // with total ledger history. These three structures are updated INCREMENTALLY,
  // exclusively inside `append()` (the chain's single mutation point), so a read
  // never re-derives them from the chain:
  //   - `approvedCsids`  — csids that have EVER had an APPROVAL recorded. Once a
  //     csid is added it is NEVER removed — mirrors the old full-scan's `approved`
  //     set, which was built by walking the WHOLE chain (so a csid stays
  //     permanently "closed" even against a PENDING appended after the approval —
  //     the exact semantics a re-open, which always mints a FRESH csid via a new
  //     adjudication, never collides with).
  //   - `openPendingList` — every currently-open PENDING LedgerRecord, in append
  //     order, sized to the CURRENT open-dispute count (not total history).
  //   - `latestOpenByCsid` — csid -> its most recent OPEN pending payload, for O(1)
  //     `openPendingFor` point lookups (mirrors the old scan's "last PENDING seen
  //     before any APPROVAL" walk).
  private readonly approvedCsids = new Set<string>();
  private readonly openPendingList: LedgerRecord[] = [];
  private readonly latestOpenByCsid = new Map<string, PendingPayload>();

  constructor(opts: {
    contentBlind: boolean;
    reputation: ReputationLedger | null;
    onAppend: AppendSink | null;
  }) {
    this.contentBlind = opts.contentBlind;
    this.reputation = opts.reputation;
    this.onAppend = opts.onAppend;
  }

  records(): readonly LedgerRecord[] {
    return this.chain;
  }

  appendPending(
    pending: PendingRatification,
    systemSource: SourceId,
    opts?: AppendPendingOptions,
  ): LedgerRecord {
    const payload = buildPendingPayload(pending, this.contentBlind, opts);

    // OD-2 [horn rate-limiting]: dedup + per-source cap. Skipped ENTIRELY when opts is
    // omitted (back-compat: exactly today's unconditional append). On a duplicate /
    // cap-hit, return the existing OPEN record WITHOUT advancing the chain. Reads the
    // INCREMENTAL index (O(open count)), never the full chain.
    if (opts !== undefined) {
      const limited = hornRateLimitDecision(this.openPendingRecords(), payload, opts);
      if (limited !== null) return limited;
    }

    return this.append("PENDING", payload, systemSource);
  }

  appendMutation(payload: MutationPayload, signer: SourceId): LedgerRecord {
    return this.append("MUTATION", payload, signer);
  }

  /** The OPEN PENDING records (a PENDING with no later APPROVAL) — the OD-2 scan set.
   *  O(1): reads the incrementally-maintained index, never re-scans the chain. */
  private openPendingRecords(): LedgerRecord[] {
    return this.openPendingList;
  }

  listPending(): readonly PendingPayload[] {
    return this.openPendingRecords().map((r) => r.payload as PendingPayload);
  }

  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: SourceId,
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

    // 3) The approver IS its SourceId — attribution, not proof-of-key. The
    //    PROVENANCE GATE ("no provenance -> no voice") is step 4b's registered-
    //    with-anchors check, which fails CLOSED for an unregistered/anchorless id.
    const approverSourceId = approver;

    // 4 + 4b) THE APPROVER GATES (distinct-approver; registered-with-anchors;
    //    RC-5 anchor-independence) — shared with the SQLite impl; honors the
    //    PHASE-4 owner-override hook exactly as documented on the helper.
    enforceApproverGates(members, approverSourceId, ctx);

    // 5) Record the immutable APPROVAL receipt FIRST (the decision is now permanent
    //    even if a later store write fails — the ledger is the source of truth).
    //    An owner-override resolution is NAMED on the record (emit-only-when-true;
    //    exactOptionalPropertyTypes: omit, never assign undefined).
    const approvalPayload: ApprovalPayload = {
      contradictionSetId,
      winner: winnerStrandId,
      approverSourceId,
      approvedAt: now,
      ...(ctx.allowAuthorApprover === true ? { ownerOverride: true } : {}),
    };
    const record = this.append("APPROVAL", approvalPayload, approver);

    // 6) RESOLVE: mint OUTRANKS winner -> each OTHER member and demote the loser.
    //    Demotion DEMOTES, never deletes (sets DEMOTED + outranked_by). Reputation
    //    is driven against the shared ledger: winner ratified, losers contradicted.
    //
    // PROMOTE THE WINNER IF NEEDED (the disown-reopen-cannot-change-winner fix): a
    // `REOPENED_BY_DISOWN` dispute's `members` can include a strand the ORIGINAL
    // resolution already DEMOTED (see disown.ts's threaded-back `losingMemberIds`).
    // If that strand is picked as winner here, it must actually END UP LIVE for the
    // re-decision to mean anything — every pre-existing caller's members are already
    // LIVE (a fresh DEFERRED dispute only ever forms among LIVE strands), so this is
    // a no-op for them.
    const winnerStrand = ctx.memberStrand(winnerStrandId);
    const winnerPromotion: PromotionResult | null =
      winnerStrand !== null && winnerStrand.fact_state !== FactState.LIVE
        ? promote(winnerStrand)
        : null;

    const outranksEdges: Edge[] = [];
    const demotions: DemotionResult[] = [];
    for (const memberId of members) {
      if (memberId === winnerStrandId) continue;
      const loser = ctx.memberStrand(memberId);
      // DANGLING MEMBER ⇒ fail-closed SKIP (see the memberStrand doc): nothing
      // exists to demote, so no edge / demotion / contradict — never an abort.
      if (loser === null) continue;
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
      winnerPromotion,
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

      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  chainHead(): ChainHead {
    const tail = this.chain.length === 0 ? null : this.chain[this.chain.length - 1]!;
    return tail === null
      ? { seq: -1, headHash: GENESIS_PREV_HASH }
      : { seq: tail.seq, headHash: tail.thisHash };
  }

  // -- internals ------------------------------------------------------------

  /** The open PENDING payload for a dispute, or null if unknown / already approved.
   *  O(1): reads the incrementally-maintained index, never re-scans the chain. */
  private openPendingFor(contradictionSetId: ContradictionSetId): PendingPayload | null {
    const csid = String(contradictionSetId);
    if (this.approvedCsids.has(csid)) return null; // already resolved
    return this.latestOpenByCsid.get(csid) ?? null;
  }

  /**
   * Append one checksum-chained record. Computes the chain link + canonical hash
   * and pushes it. The single mutation point of the chain — and, correspondingly,
   * the single mutation point of the incremental open-PENDING index below. `signer`
   * is the ASSERTED author id committed into the checksum.
   */
  private append(
    kind: LedgerRecordKind,
    payload: PendingPayload | ApprovalPayload | MutationPayload,
    signer: SourceId,
  ): LedgerRecord {
    const seq = this.chain.length;
    const prevHash = seq === 0 ? GENESIS_PREV_HASH : this.chain[seq - 1]!.thisHash;
    const thisHash = sha256Hex(
      hashPreimage(seq, prevHash, kind, payload, signer),
    );

    const record: LedgerRecord = {
      seq,
      prevHash,
      kind,
      payload,
      signerSourceId: signer,
      thisHash,
    };
    // SHIP BEFORE WRITE (see {@link AppendSink}'s ordering contract): a throwing
    // sink aborts the append with the chain unchanged (fail-closed); a shipped
    // record whose local write then fails is the safe, auditor-resolvable
    // direction. Never reorder these two lines.
    this.onAppend?.(record);
    this.chain.push(record);

    // Maintain the incremental open-PENDING index (add on a fresh PENDING, remove
    // on a resolving APPROVAL) — see the field doc comment above for the exact
    // semantics this reproduces from the old O(n) full-chain scan.
    if (kind === "PENDING") {
      const csid = String((payload as PendingPayload).contradictionSetId);
      if (!this.approvedCsids.has(csid)) {
        this.openPendingList.push(record);
        this.latestOpenByCsid.set(csid, payload as PendingPayload);
      }
    } else if (kind === "APPROVAL") {
      const csid = String((payload as ApprovalPayload).contradictionSetId);
      this.approvedCsids.add(csid);
      this.latestOpenByCsid.delete(csid);
      if (this.openPendingList.length > 0) {
        for (let i = this.openPendingList.length - 1; i >= 0; i--) {
          const r = this.openPendingList[i]!;
          if (String((r.payload as PendingPayload).contradictionSetId) === csid) {
            this.openPendingList.splice(i, 1);
          }
        }
      }
    }

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
 * @param opts.onAppend     real-time audit shipping sink (see {@link AppendSink}):
 *                          receives every appended record BEFORE the local write.
 *                          Omit for a local-only chain (back-compatible default).
 */
export function createPendingLedger(
  opts: {
    contentBlind?: boolean;
    reputation?: ReputationLedger | null;
    onAppend?: AppendSink;
  } = {},
): PendingLedger {
  return new InMemoryPendingLedger({
    contentBlind: opts.contentBlind ?? false,
    reputation: opts.reputation ?? null,
    onAppend: opts.onAppend ?? null,
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
 * Durable, WAL-mode, SQLite-backed {@link PendingLedger}: the VAULT (immutable
 * checksum-chained record) + DOORBELL (second-admin approve flow) persisted to disk
 * so the AUDIT TRAIL survives a restart AND stays tamper-evident at rest.
 *
 * Table:
 *  - `ratification_records(seq INTEGER PRIMARY KEY, json)` — `seq` IS the row key, so
 *    the chain ORDER is preserved by the primary key and cannot be re-ordered; the
 *    ledger assigns `seq` (no AUTOINCREMENT needed).
 *
 * Canonicalization + hashing reuse the module-private {@link hashPreimage} /
 * {@link sha256Hex} / {@link GENESIS_PREV_HASH} verbatim (co-located here precisely
 * so the persisted preimage is BYTE-IDENTICAL to the in-memory form), which is what
 * makes `verifyChain()` re-verify true after a reopen and STILL detect a flipped
 * byte in a persisted row (naming the first broken seq).
 */
class SqlitePendingLedgerImpl implements SqlitePendingLedger {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;
  readonly #contentBlind: boolean;
  readonly #reputation: ReputationLedger | null;
  /** Real-time shipping sink (insider-tamper mitigation); null when unwired. */
  readonly #onAppend: AppendSink | null;

  readonly #insertRecord;
  readonly #allRecords;
  readonly #countRecords;
  readonly #lastRecord;

  // -- the incrementally-maintained OPEN-PENDING index (the perf fix) ---------
  // Same shape + semantics as `InMemoryPendingLedger`'s (see its field doc
  // comment): built ONCE from the persisted chain at construction (unavoidable —
  // an existing database's history must be read at least once to know current
  // state), then updated INCREMENTALLY inside `#append()` so `listPending()` /
  // the OD-2 rate-limit scan / `approve()`'s dispute lookup never re-read the
  // whole `ratification_records` table again.
  readonly #approvedCsids = new Set<string>();
  readonly #openPendingList: LedgerRecord[] = [];
  readonly #latestOpenByCsid = new Map<string, PendingPayload>();

  constructor(opts: {
    db: DatabaseSyncType;
    ownsDb: boolean;
    contentBlind: boolean;
    reputation: ReputationLedger | null;
    onAppend: AppendSink | null;
  }) {
    this.#db = opts.db;
    this.#ownsDb = opts.ownsDb;
    this.#contentBlind = opts.contentBlind;
    this.#reputation = opts.reputation;
    this.#onAppend = opts.onAppend;

    if (opts.ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    } else {
      // BORROWED shared handle: VERIFY (never set) that the owner already put it in
      // WAL mode — the SAME gap `store/sqliteStore.ts`'s `{ db }` overload closed in
      // 1e4df69 (`wal-verification follow-ups`, Wave-2). Before this fix, a caller
      // that constructed this ledger's shared-handle overload FIRST against a fresh
      // handle (or any handle whose owner forgot to set WAL) got zero verification —
      // the "one atomic crash-consistent file" story for the AUDIT CHAIN itself
      // silently ran over a default rollback journal, with no symptom short of an
      // actual crash losing committed ratification records. Throws
      // `SharedHandleNotWalError` otherwise.
      assertSharedHandleWal(this.#db, "createSqlitePendingLedger");
    }
    // SCHEMA MIGRATION LADDER (Phase 2 Durability spec §1) — see store/migrations.ts.
    // Idempotent; safe to run here even if a shared handle already ran it via the
    // strand store or the reputation ledger's constructor.
    runMigrations(this.#db);
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ratification_records (
         seq  INTEGER PRIMARY KEY,
         json TEXT NOT NULL
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

    // ONE-TIME index rebuild from whatever this database already holds (empty for
    // a fresh db; a full pass for a reopened one — the same one-time cost class as
    // the migration ladder just above, paid at OPEN time, never per query).
    for (const r of this.#chain()) {
      this.#indexAppendedRecord(r.kind, r.payload, r);
    }
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

  appendPending(
    pending: PendingRatification,
    systemSource: SourceId,
    opts?: AppendPendingOptions,
  ): LedgerRecord {
    const payload = buildPendingPayload(pending, this.#contentBlind, opts);

    // OD-2 [horn rate-limiting]: dedup + per-source cap, INSIDE the same single-writer
    // path as the append so a concurrent writer never double-appends. Skipped entirely
    // when opts is omitted (back-compat). The OPEN-pending scan is the records table
    // filtered to PENDING-without-APPROVAL (the new fields live in the existing payload
    // JSON blob — no schema migration).
    if (opts !== undefined) {
      const limited = hornRateLimitDecision(this.#openPendingRecords(), payload, opts);
      if (limited !== null) return limited;
    }

    return this.#append("PENDING", payload, systemSource);
  }

  appendMutation(payload: MutationPayload, signer: SourceId): LedgerRecord {
    return this.#append("MUTATION", payload, signer);
  }

  /** The OPEN PENDING records (a PENDING with no later APPROVAL) — the OD-2 scan set.
   *  O(1): reads the incrementally-maintained index, never re-reads the table. */
  #openPendingRecords(): LedgerRecord[] {
    return this.#openPendingList;
  }

  /**
   * Maintain the incremental open-PENDING index — add on a fresh PENDING, remove
   * on a resolving APPROVAL — exactly reproducing the semantics the old two-pass
   * full-table scan computed from scratch on every call (see the field doc comment
   * on `#approvedCsids` et al.). Called both at construction (once, per persisted
   * row) and from `#append()` (once, per new row).
   */
  #indexAppendedRecord(
    kind: LedgerRecordKind,
    payload: PendingPayload | ApprovalPayload | MutationPayload,
    record: LedgerRecord,
  ): void {
    if (kind === "PENDING") {
      const csid = String((payload as PendingPayload).contradictionSetId);
      if (!this.#approvedCsids.has(csid)) {
        this.#openPendingList.push(record);
        this.#latestOpenByCsid.set(csid, payload as PendingPayload);
      }
    } else if (kind === "APPROVAL") {
      const csid = String((payload as ApprovalPayload).contradictionSetId);
      this.#approvedCsids.add(csid);
      this.#latestOpenByCsid.delete(csid);
      if (this.#openPendingList.length > 0) {
        for (let i = this.#openPendingList.length - 1; i >= 0; i--) {
          const r = this.#openPendingList[i]!;
          if (String((r.payload as PendingPayload).contradictionSetId) === csid) {
            this.#openPendingList.splice(i, 1);
          }
        }
      }
    }
  }

  listPending(): readonly PendingPayload[] {
    return this.#openPendingRecords().map((r) => r.payload as PendingPayload);
  }

  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: SourceId,
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

    // The approver IS its SourceId (asserted attribution); the provenance gate is
    // the registered-with-anchors check inside the shared gates (fail-closed).
    const approverSourceId = approver;

    // 4 + 4b) THE APPROVER GATES — the SAME shared helper the in-memory impl runs
    //    (one source of truth; honors the PHASE-4 owner-override hook identically).
    enforceApproverGates(members, approverSourceId, ctx);

    const approvalPayload: ApprovalPayload = {
      contradictionSetId,
      winner: winnerStrandId,
      approverSourceId,
      approvedAt: now,
      ...(ctx.allowAuthorApprover === true ? { ownerOverride: true } : {}),
    };
    const record = this.#append("APPROVAL", approvalPayload, approver);

    // PROMOTE THE WINNER IF NEEDED — see the in-memory impl's identical comment
    // (the disown-reopen-cannot-change-winner fix): a `REOPENED_BY_DISOWN`
    // dispute's winner may be a strand the ORIGINAL resolution already DEMOTED.
    const winnerStrand = ctx.memberStrand(winnerStrandId);
    const winnerPromotion: PromotionResult | null =
      winnerStrand !== null && winnerStrand.fact_state !== FactState.LIVE
        ? promote(winnerStrand)
        : null;

    const outranksEdges: Edge[] = [];
    const demotions: DemotionResult[] = [];
    for (const memberId of members) {
      if (memberId === winnerStrandId) continue;
      const loser = ctx.memberStrand(memberId);
      // DANGLING MEMBER ⇒ fail-closed SKIP (see the memberStrand doc) — the
      // SAME rule as the in-memory impl (the shared-gates drift guard applies
      // to resolution semantics too).
      if (loser === null) continue;
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

    return {
      contradictionSetId,
      winner: winnerStrandId,
      outranksEdges,
      demotions,
      winnerPromotion,
      record,
    };
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

      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  chainHead(): ChainHead {
    const tail = this.#lastRecord.get();
    if (tail === undefined) return { seq: -1, headHash: GENESIS_PREV_HASH };
    const rec = this.#parse(pendingAsString((tail as { json: unknown }).json));
    return { seq: rec.seq, headHash: rec.thisHash };
  }

  /**
   * See the interface doc: discard the incremental open-PENDING index and
   * rebuild it from a fresh full read of `ratification_records` — the SAME
   * one-time pass the constructor runs on open, just re-run on demand. A caller
   * invokes this after catching a rollback of a transaction that this ledger's
   * `#append()` participated in (the SQL row is gone; only the in-memory index
   * needs re-deriving to match). O(total records) — an error-path operation,
   * never called on the hot path.
   */
  resyncIndex(): void {
    this.#approvedCsids.clear();
    this.#openPendingList.length = 0;
    this.#latestOpenByCsid.clear();
    for (const r of this.#chain()) {
      this.#indexAppendedRecord(r.kind, r.payload, r);
    }
  }

  // -- internals ------------------------------------------------------------

  /** O(1): reads the incrementally-maintained index, never re-reads the table. */
  #openPendingFor(contradictionSetId: ContradictionSetId): PendingPayload | null {
    const csid = String(contradictionSetId);
    if (this.#approvedCsids.has(csid)) return null;
    return this.#latestOpenByCsid.get(csid) ?? null;
  }

  /**
   * Append one checksum-chained record to DISK. Computes the chain link from the
   * persisted tail and inserts the record JSON. The single mutation point of the
   * chain — exactly like the in-memory ledger's `append`. `signer` is the ASSERTED
   * author id committed into the checksum.
   */
  #append(
    kind: LedgerRecordKind,
    payload: PendingPayload | ApprovalPayload | MutationPayload,
    signer: SourceId,
  ): LedgerRecord {
    const seq = Number((this.#countRecords.get() as { n: number }).n);
    const tail = this.#lastRecord.get();
    const prevHash =
      seq === 0
        ? GENESIS_PREV_HASH
        : this.#parse(pendingAsString((tail as { json: unknown }).json)).thisHash;
    const thisHash = sha256Hex(
      hashPreimage(seq, prevHash, kind, payload, signer),
    );

    const record: LedgerRecord = {
      seq,
      prevHash,
      kind,
      payload,
      signerSourceId: signer,
      thisHash,
    };
    // SHIP BEFORE WRITE (see {@link AppendSink}'s ordering contract): a throwing
    // sink aborts the append with nothing inserted — and inside a compound op's
    // shared-handle transaction, the whole op rolls back (fail-closed). A shipped
    // record whose transaction then rolls back is the safe, auditor-resolvable
    // direction. Never reorder these two lines.
    this.#onAppend?.(record);
    this.#insertRecord.run(seq, JSON.stringify(record));
    // Index AFTER the row is durably inserted: a throwing sink or a failed insert
    // aborts the append with the index left untouched too (fail-closed parity).
    this.#indexAppendedRecord(kind, payload, record);
    return record;
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a DURABLE, SQLite-backed {@link PendingLedger} — a DROP-IN for
 * {@link createPendingLedger} whose checksum-chained AUDIT TRAIL survives a
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
    | {
        path: string;
        contentBlind?: boolean;
        reputation?: ReputationLedger | null;
        onAppend?: AppendSink;
      }
    | {
        db: DatabaseSyncType;
        contentBlind?: boolean;
        reputation?: ReputationLedger | null;
        onAppend?: AppendSink;
      },
): SqlitePendingLedger {
  const contentBlind = opts.contentBlind ?? false;
  const reputation = opts.reputation ?? null;
  const onAppend = opts.onAppend ?? null;
  if ("path" in opts) {
    // Open first, outside the constructor, so a throw INSIDE construction (e.g. the
    // migration ladder's refusal on a future-versioned db) can still close the
    // just-opened handle before propagating (see the identical note in
    // store/sqliteStore.ts's createSqliteStore).
    const handle = new DatabaseSync(opts.path);
    try {
      return new SqlitePendingLedgerImpl({
        db: handle,
        ownsDb: true,
        contentBlind,
        reputation,
        onAppend,
      });
    } catch (err) {
      handle.close();
      throw err;
    }
  }
  return new SqlitePendingLedgerImpl({
    db: opts.db,
    ownsDb: false,
    contentBlind,
    reputation,
    onAppend,
  });
}
