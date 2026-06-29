/**
 * ratification/disown.ts — THE DOWNSTREAM TRANSITIVE-CLOSURE half of the disown
 * sweep (CLAUDE.md pillar 4: "claws back reputation across everything that anchor
 * ever asserted ... including credit conferred on OTHER sources that used these
 * strands as a witness").
 *
 * Design grounding (CLAUDE.md, Source-Identity Layer pillar 4 + "wall with a
 * window"):
 *  - The DIRECT-SEED clawback (crater the disowned source, dedupe its seed, fail
 *    closed, idempotent) is already done in `identity/reputation.ts`'s pure
 *    `ReputationLedger.disownSweep`. That stays pure — it sees only the seed set.
 *  - THIS module is the STORE-AWARE orchestrator. When a source is disowned, every
 *    DERIVED fact whose existence transitively RESTS ON one of the disowned
 *    strands is tainted ("a derived fact is never its own witness"): the web
 *    computed it from input that has just been declared fraudulent, so it must be
 *    DEMOTED (never deleted — the archive stub is immortal). And every downstream
 *    SOURCE that earned credit FUNDED BY the disowned root has that credit clawed
 *    back — but BOUNDED BY INDEPENDENCE CLASS, so a source that merely AGREED
 *    COINCIDENTALLY (a genuinely independent class, not actually derived from the
 *    disowned root) is NOT punished. That bound is the whole point: the spec
 *    forbids punishing coincidental independent agreement.
 *
 * Two SEPARATE decisions, never conflated:
 *  - DEMOTION ("existence rests on"): any strand reachable from the seed through
 *    DERIVATION edges is demoted. Its existence leaned on tainted input.
 *  - CONTRADICTION ("credit funded by"): a downstream source's reputation is clawed
 *    back ONLY when that source has a provenance root in the TAINTED independence
 *    class set. A DERIVATION-reachable strand backed by a genuinely independent
 *    class is demoted (its existence rested on tainted input) but its source's
 *    reputation is NOT clawed (it agreed independently).
 *
 * HARD REQUIREMENTS honored here:
 *  - IDEMPOTENT: delegated to `ledger.disownSweep`'s `disowned` set — a second
 *    sweep returns an empty seed clawback and we early-return a no-op.
 *  - TERMINATES on cycles: a `visited` set means every strand is processed once
 *    (DERIVATION cycles, abnormal but possible, are bounded).
 *  - DEMOTE-NEVER-DELETE: we only flip `fact_state`/`outranked_by` via `demote`
 *    and re-`putStrand`; `content_hash` + `provenance` (the archive stub) are
 *    untouched, and the store has no delete by design.
 *  - DETERMINISTIC: the frontier is expanded in a stable `(content_hash, id)` order
 *    and in-edges are sorted by edge id before processing.
 *  - FAILS CLOSED: a dangling edge / missing strand skips that NODE only; the
 *    sweep never aborts and never silently no-ops a first-call disown.
 *  - DEDUPE BY ROOT (echo-collapse): the seed and the frontier are deduped by
 *    `content_hash` first, so a same-root flood counts once.
 *
 * HONESTY — what is reversed exactly vs. what stays a documented residual: see
 * {@link downstreamDisownSweep} and the BOUNDED `CORROBORATION_CREDIT_SUBSTRATE_SPEC`
 * below. The graph-reachable path ships COMPLETE and never throws; corroboration
 * credit is reversed EXACTLY over the recorded DERIVATION + corroboration closure
 * (seed ∪ demoted-downstream), while re-observed / uncited influence is a
 * priced-not-prevented residual (SAFE-DEFER) — clearly marked, not faked.
 */

import {
  type AdjudicationProvenance,
  type ContradictionSetId,
  type Edge,
  type EdgeId,
  type EpochMs,
  type IndependenceClassId,
  type ReviewQueueEntry,
  type SourceId,
  type Strand,
  type StrandId,
  type Unit,
  EdgeType,
} from "../core/types.js";
import type { StoreTxn, StrandStore } from "../store/StrandStore.js";
import type { ReputationLedger } from "../identity/reputation.js";
import type { CorroborationLedger } from "./corroboration.js";
import type { WeakInfluenceLedger } from "./weakInfluence.js";
import type { AdjudicationProvenanceLedger } from "./adjudicationProvenance.js";
import type { MutationPayload, PendingLedger } from "./pendingLedger.js";
import type { KeyPair } from "../identity/keys.js";
import { demote } from "../forgetting/consolidation.js";
import {
  hashReputationState,
  hashStrandState,
  hashSubjectId,
  mutationReceipt,
} from "./mutationReceipt.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * The receipt of a {@link downstreamDisownSweep}. Everything is the DEDUPED,
 * deterministic set actually acted on — `demotedDownstream` excludes the seed
 * (the seed's reputation clawback is the direct sweep's job), and
 * `contradictedSources` is the echo-collapsed set of downstream sources whose
 * credit was reversed (each contradicted exactly once no matter how many tainted
 * strands funded it).
 */
export interface DownstreamDisownResult {
  /** The deduped seed strand ids whose DIRECT reputation credit was clawed back. */
  readonly seedClawedBack: StrandId[];
  /** Downstream (non-seed) strand ids demoted because their existence rested on tainted input. */
  readonly demotedDownstream: StrandId[];
  /** Downstream sources whose reputation was clawed back (bounded by tainted independence class). */
  readonly contradictedSources: SourceId[];
  /**
   * Corroboration events reversed by this sweep (the precise per-event credit
   * reversals). Each entry is the `eventId` of an event whose `corroboratingStrandIds`
   * intersected the tainted CLOSURE (seed ∪ demoted-downstream); each is reversed
   * EXACTLY ONCE across any number of sweeps. Empty when no corroboration ledger is
   * wired or none intersected.
   */
  readonly reversedCorroborationEventIds: string[];
  /**
   * WEAK-INFLUENCE review queue (HARDENING 1, uncited-influence channel). For each
   * distinct work that CONSULTED a tainted seed strand (recorded as a
   * {@link "../core/types".WeakInfluenceEdge}, NOT a DERIVATION edge), a typed
   * {@link ReviewQueueEntry} flagged for HUMAN review — NEVER an auto-demotion
   * (uncited influence is unprovable). Empty when no weak-influence ledger is wired
   * or nothing consulted the tainted set; deduped by influenced strand; idempotent
   * across re-sweeps.
   */
  readonly reviewQueued: ReviewQueueEntry[];
  /**
   * RE-OPENED disputes (HARDENING 3, threshold-effects channel). The contradiction
   * sets whose recorded adjudication margin dropped BELOW the decisive threshold once
   * the tainted strands were removed from the winner's support — each transitioned
   * back to a PENDING ratification (reason `REOPENED_BY_DISOWN`) for a human to
   * re-decide. Empty when no adjudication-provenance / pending ledger is wired or no
   * margin collapsed; idempotent across re-sweeps.
   */
  readonly reopenedDisputes: ContradictionSetId[];
  /**
   * SURVIVED-DEMOTION strands (HARDENING 4, false-disown-as-suppression protection).
   * Derived strands that were DERIVATION-reachable from the tainted set but were KEPT
   * LIVE because they retained sufficient NON-tainted, genuinely-independent support
   * (their existence does not solely rest on the tainted input). Blocks disowning a
   * rival to demote their downstream work.
   */
  readonly survivedDemotion: StrandId[];
  /** Total distinct strands processed (seed + downstream) — the visited-set size. */
  readonly visitedCount: number;
}

/**
 * The OPTIONAL hardening ledgers + policy a {@link downstreamDisownSweep} may be
 * given. Every field is optional and back-compatible: omitting all of them preserves
 * the original graph-reachable + corroboration-reversal behavior EXACTLY. Supplying
 * them activates the four undo-engine hardenings (ARCHITECTURE.md §4).
 */
export interface DisownHardeningDeps {
  /**
   * The CORROBORATION-EVENT ledger (HARDENING 2's substrate, already used by the
   * precise credit reversal). When supplied, intersecting events are reversed exactly
   * once. (Kept here as the canonical place to pass it; the positional `corroboration`
   * parameter remains for back-compat.)
   */
  readonly corroboration?: CorroborationLedger;
  /**
   * The WEAK-INFLUENCE ledger (HARDENING 1). When supplied, consulted-but-not-cited
   * works of any tainted seed strand are queued for HUMAN review (never auto-demoted).
   */
  readonly weakInfluence?: WeakInfluenceLedger;
  /**
   * The ADJUDICATION-PROVENANCE ledger (HARDENING 3). When supplied together with
   * {@link pending}, disputes whose decisive margin collapses once tainted strands are
   * removed are RE-OPENED.
   */
  readonly adjudicationProvenance?: AdjudicationProvenanceLedger;
  /**
   * The PENDING (ratification) ledger to append a `REOPENED_BY_DISOWN` request to when
   * a margin collapses. Required (with a {@link systemSigner}) for HARDENING 3 to
   * actually transition a dispute back to PENDING.
   */
  readonly pending?: PendingLedger;
  /** The system signer for the re-opened PENDING record (HARDENING 3). */
  readonly systemSigner?: KeyPair;
  /**
   * The decisive margin threshold a re-opened dispute's surviving margin is checked
   * against (HARDENING 3). Defaults to {@link DEFAULT_DECISIVE_MARGIN}. A surviving
   * margin strictly BELOW this re-opens the dispute.
   */
  readonly decisiveMargin?: number;
  /**
   * Recompute the winner's SURVIVING margin after removing the tainted contributing
   * strands (HARDENING 3). Injected so a caller with the per-source α-contributions can
   * supply an exact recompute; defaults to {@link defaultSurvivingMargin}, a
   * deterministic, fail-safe (biased-toward-reopening) proportional model.
   */
  readonly survivingMargin?: (
    record: AdjudicationProvenance,
    taintedStrandIds: ReadonlySet<StrandId>,
  ) => number;
  /**
   * HARDENING 4 — enable the FALSE-DISOWN-AS-SUPPRESSION protection (the
   * independent-support-survives test). DEFAULT `false` (OFF) so the
   * graph-reachable demote-every-derivative contract is UNCHANGED for existing
   * callers; set `true` to spare a derived strand whose independent corroboration
   * survives removal of the tainted set. Opt-in because it deliberately RELAXES the
   * demotion closure — a policy choice, not a silent default.
   */
  readonly checkSurvivingSupport?: boolean;
  /**
   * Minimum number of DISTINCT NON-tainted, genuinely-independent surviving support
   * classes a derived strand must retain to be SPARED demotion when
   * {@link checkSurvivingSupport} is on (HARDENING 4). Defaults to 2: a strand needs
   * REAL independent corroboration (>= 2 disjoint surviving classes) to survive — a
   * single-rooted derived fact whose one class merely happens to be untainted still
   * rests on the tainted derivation and is demoted (matching the prior contract).
   */
  readonly minSurvivingSupport?: number;
}

/** Default decisive-margin threshold for re-opening (mirrors the adjudication policy). */
export const DEFAULT_DECISIVE_MARGIN = 0.3;

/**
 * Default SURVIVING-MARGIN recompute (HARDENING 3): a deterministic, fail-safe model
 * that biases TOWARD re-opening (fail-safe to a human, per the plan's risk note).
 * Without per-source α-contributions the sweep cannot prove the surviving margin
 * exactly, so it models the recorded margin as supported EQUALLY by the recorded
 * contributing strands and scales it by the fraction that SURVIVE the taint:
 *
 *   surviving = margin · (survivingContributors / totalContributors)
 *
 * If the winner strand itself is tainted, the surviving margin is 0 (the winner's own
 * support is fraudulent). With no recorded contributors the margin is taken as-is
 * (nothing to remove). Monotone: more tainted contributors ⇒ lower surviving margin.
 */
export function defaultSurvivingMargin(
  record: AdjudicationProvenance,
  taintedStrandIds: ReadonlySet<StrandId>,
): number {
  if (taintedStrandIds.has(record.winner)) return 0;
  const contributors = record.contributingStrandIds;
  if (contributors.length === 0) return record.margin;
  let surviving = 0;
  for (const sid of contributors) {
    if (!taintedStrandIds.has(sid)) surviving++;
  }
  return record.margin * (surviving / contributors.length);
}

/**
 * Default OUTRANKS edge-id minter for a downstream demotion stub: deterministic in
 * (winner, loser) so two runs produce the same edge id. `winner` is the disown
 * sentinel (or the seed strand) and `loser` is the demoted downstream strand.
 */
function defaultMintEdgeId(winner: StrandId, loser: StrandId): EdgeId {
  return `edge:disown-outranks:${String(winner)}->${String(loser)}` as EdgeId;
}

/**
 * The deterministic "disown sentinel" — the synthetic winner of every downstream
 * demotion. A tainted derived strand is outranked not by a peer claim but by the
 * fact that its provenance was disowned; this sentinel names that authority so the
 * minted OUTRANKS edge has a stable, non-colliding `from`.
 */
function disownSentinelFor(sourceId: SourceId): StrandId {
  return `strand:disown-sentinel:${String(sourceId)}` as StrandId;
}

// ---------------------------------------------------------------------------
// BOUNDED (was crack-A): corroboration-credit attribution over the recorded closure
// ---------------------------------------------------------------------------

/**
 * BOUNDED — CORROBORATION-CREDIT ATTRIBUTION (formerly the `TODO(crack-A)`).
 *
 * The reversal is EXACT over the RECORDED DERIVATION + corroboration closure
 * (seed ∪ demoted-downstream taint); re-observed / uncited influence remains a
 * priced-not-prevented residual (SAFE-DEFER, not DEFENDED). The substrate that
 * carries it is the CORROBORATION-EVENT LEDGER in `ratification/corroboration.ts`.
 *
 * The problem it addresses: when a source B earned reputation BECAUSE its claim AGREED
 * WITH (was corroborated by) disowned source A's strand — yet B's own strand carries
 * NO DERIVATION edge to A's strand (B observed independently, then was credited for
 * matching) — the graph holds no edge recording "B's bump was funded by agreement
 * with A." Faking that reversal would claw back credit from a source that agreed
 * COINCIDENTALLY and independently (the exact thing pillar 4 forbids), so it is
 * never guessed — only reversed where the recorded funding link intersects the taint.
 *
 * THE MECHANISM (live): the credit's link to A's strand is RECORDED AT EARNING TIME.
 * A corroboration-driven reputation gain is recorded as an append-only event
 * `{ eventId, ratifiedStrandId, corroboratingStrandIds[], beneficiarySourceId,
 * reputationDelta, at }` carrying the EXACT applied delta (see
 * `reputation.ratifyWithCorroboration` / the `api.ratify` earning path). On disown,
 * {@link downstreamDisownSweep} looks up corroboration events whose
 * `corroboratingStrandIds` intersect the TAINTED CLOSURE (seed ∪ demoted-downstream,
 * `taintedStrandIds`) and, for each, calls `ledger.reverseCredit(beneficiarySourceId,
 * reputationDelta)` EXACTLY ONCE — bounded (a beneficiary with no matching event is
 * untouched), precise (exactly the recorded delta, clamped at floor 0), and idempotent
 * (each event reversed at most once across any number of sweeps, via the ledger's
 * `markReversed` guard). The intersection IS the F3 guard: coincidental independent
 * agreement (no recorded funding link into the closure) is never punished.
 *
 * THE BOUNDARY (OD-7, the documented residual): this reverses laundering routed
 * through the DEMOTED DERIVATION closure ONLY. Re-observation laundering (which emits
 * no corroboration event and even HEALS the independent-root count), bond-withdrawal
 * credit, and coincidental agreers with no recorded funding link are OUTSIDE the
 * recorded sigma-algebra — reported SAFE-DEFER, a priced-not-prevented residual, NOT
 * "disown is exact" in the unqualified sense.
 */
export const CORROBORATION_CREDIT_SUBSTRATE_SPEC: string =
  "BOUNDED — exact over the recorded DERIVATION + corroboration closure (seed ∪ " +
  "demoted-downstream taint): corroboration-event ledger (ratification/corroboration.ts) — " +
  "append-only { eventId, ratifiedStrandId, corroboratingStrandIds[], beneficiarySourceId, " +
  "reputationDelta, at } recorded with the EXACT applied delta when a corroboration-driven gain " +
  "is earned, so a disown reverses exactly the reputationDelta on each beneficiary whose " +
  "corroboratingStrandIds intersect the tainted closure — bounded, precise, idempotent, never " +
  "punishing coincidental independent agreement. Re-observed / uncited influence remains a " +
  "priced-not-prevented residual (SAFE-DEFER), not DEFENDED.";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * HARDENING 4 — INDEPENDENT-SUPPORT-SURVIVES test (false-disown-as-suppression).
 *
 * A derived strand is DERIVATION-reachable from the tainted set, but disown taints
 * ONLY work authored by the disowned key (and its class). If the derived strand still
 * has GENUINELY-INDEPENDENT support that SURVIVES removal of the tainted set — a
 * provenance root whose `independenceClass` is NOT tainted AND whose `sourceId` is not
 * the disowned key — then its existence does NOT solely rest on the tainted input and
 * it must be KEPT LIVE (demoting it would let an attacker suppress a rival's
 * downstream work by disowning the rival). Counts DISTINCT surviving independence
 * classes (collapsing same-class echoes), and a strand keeps LIVE iff that count is
 * `>= minSurvivingSupport`.
 *
 * @returns the number of distinct NON-tainted, non-disowned-source surviving support
 *          classes backing `derived`.
 */
function survivingIndependentSupport(
  derived: Strand,
  disowned: SourceId,
  taintedClasses: ReadonlySet<IndependenceClassId>,
): number {
  const surviving = new Set<IndependenceClassId>();
  for (const root of derived.provenance) {
    if (root.sourceId === disowned) continue; // the disowned key's own root never counts
    if (taintedClasses.has(root.independenceClass)) continue; // tainted class never counts
    surviving.add(root.independenceClass);
  }
  return surviving.size;
}

/** A stable string fingerprint for echo-collapse: prefer content_hash, else id. */
function rootFingerprint(strand: Strand): string {
  return strand.content_hash
    ? `h:${String(strand.content_hash)}`
    : `i:${String(strand.id)}`;
}

/** Deterministic comparator over strands: (content_hash, id) ascending. */
function byHashThenId(a: Strand, b: Strand): number {
  const af = rootFingerprint(a);
  const bf = rootFingerprint(b);
  if (af < bf) return -1;
  if (af > bf) return 1;
  const ai = String(a.id);
  const bi = String(b.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** Deterministic comparator over edges by id ascending. */
function byEdgeId(a: Edge, b: Edge): number {
  const ai = String(a.id);
  const bi = String(b.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Run `fn` inside ONE store transaction so the ENTIRE disown sweep — the direct-seed
 * crater, every downstream demotion + OUTRANKS stub, every `contradict`, and every
 * precise corroboration `reverseCredit`/`markReversed` — is ALL-OR-NOTHING. A crash
 * mid-sweep must not leave a partial sweep (some derived strands demoted but their
 * tainted sources not contradicted, or credit half-reversed). When the store, the
 * reputation ledger, and the corroboration ledger ride the SAME shared db handle, all
 * their writes enroll in this transaction. NO-OP for the in-memory backend (no
 * `beginTxn`), which is already atomic-per-call — exactly what the contract permits.
 */
function withSweepTxn<T>(store: StrandStore, fn: () => T): T {
  const begin = store.beginTxn?.bind(store);
  if (begin === undefined) return fn();
  const txn: StoreTxn = begin();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    txn.rollback();
    throw err;
  }
  txn.commit();
  return result;
}

// ---------------------------------------------------------------------------
// The store-aware downstream-disown orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the FULL disown sweep for a fraudulent source: the direct-seed crater
 * (delegated to the pure ledger) PLUS the downstream transitive closure over the
 * provenance/DERIVATION graph.
 *
 * Flow:
 *  1. DIRECT SEED (authoritative idempotency): call
 *     `ledger.disownSweep(sourceId, assertedStrandIds)`. If it returns an EMPTY
 *     clawback, this source was already disowned — early-return a complete no-op
 *     (idempotent), touching nothing downstream either.
 *  2. TAINT ROOTS: the deduped seed strands (resolved from the store), deduped by
 *     `content_hash` so a same-root flood counts once. The TAINTED INDEPENDENCE
 *     CLASS SET = the independence classes of the seed strands' roots whose
 *     `sourceId === sourceId` (the classes the disowned source actually sourced).
 *  3. DOWNSTREAM WALK: BFS following `store.inEdges(t)` filtered to
 *     {@link EdgeType.DERIVATION}. A DERIVATION edge points derived-fact -> the
 *     strands it was computed from, so a strand tainted-as-a-witness `t` is reached
 *     by the edges ENTERING `t`; each such edge's `from` is a DERIVED strand that
 *     RESTED ON `t` — the downstream taint frontier. Each frontier strand:
 *       - DEMOTE (never delete): mint a synthetic OUTRANKS edge (disown sentinel ->
 *         strand), `putEdge`, `demote`, `putStrand`. Archive stub intact.
 *       - CONTRADICT its backing sources IFF bounded by the tainted class: a source
 *         is contradicted only if it has a provenance root whose `independenceClass`
 *         is in the tainted set. A genuinely-independent-class backer is demoted but
 *         NOT contradicted (coincidental agreement is not punished).
 *  4. CONTINUE the BFS from each demoted strand (its derived children are tainted
 *     too), guarded by a `visited` set → terminates on cycles, each strand once.
 *
 * Fails closed: a missing strand or dangling edge skips only that node; the sweep
 * never throws on the graph-reachable path and never silently no-ops a first call.
 *
 * @param sourceId          the disowned source (passport key).
 * @param assertedStrandIds every strand this source asserted (the seed set the
 *                          caller enumerates from the store by
 *                          `provenance.sourceId === sourceId`).
 * @param store             the strand web to traverse.
 * @param ledger            the reputation ledger to crater + claw back over.
 * @param now               witness time of the disown.
 * @param mintEdgeId        optional OUTRANKS edge-id minter for the demotion stubs.
 * @param corroboration     optional {@link CorroborationLedger}. When supplied, the
 *                          sweep ALSO reverses the precise per-event corroboration
 *                          credits whose `corroboratingStrandIds` intersect the
 *                          tainted seed set — bounded, exact, idempotent. Omit it for
 *                          the (back-compatible) graph-reachable-only behavior. May
 *                          ALSO be supplied via `hardening.corroboration`.
 * @param hardening         optional {@link DisownHardeningDeps} activating the four
 *                          undo-engine hardenings (weak-influence review queue,
 *                          adjudication re-opening, false-disown survival check). Every
 *                          field is back-compatible; omitting them preserves the prior
 *                          behavior exactly.
 * @returns a {@link DownstreamDisownResult} receipt.
 */
export function downstreamDisownSweep(
  sourceId: SourceId,
  assertedStrandIds: readonly StrandId[],
  store: StrandStore,
  ledger: ReputationLedger,
  now: EpochMs,
  mintEdgeId: (winner: StrandId, loser: StrandId) => EdgeId = defaultMintEdgeId,
  corroboration?: CorroborationLedger,
  hardening?: DisownHardeningDeps,
): DownstreamDisownResult {
  // Resolve the corroboration ledger from either the positional param or hardening.
  const corrob = corroboration ?? hardening?.corroboration;
  const weakInfluence = hardening?.weakInfluence;
  const adjProvenance = hardening?.adjudicationProvenance;
  const pending = hardening?.pending;
  const systemSigner = hardening?.systemSigner;
  const decisiveMargin = hardening?.decisiveMargin ?? DEFAULT_DECISIVE_MARGIN;
  const survivingMargin = hardening?.survivingMargin ?? defaultSurvivingMargin;
  const checkSurvivingSupport = hardening?.checkSurvivingSupport === true;
  const minSurvivingSupport = hardening?.minSurvivingSupport ?? 2;
  // ATOMIC: the whole sweep is ONE all-or-nothing unit of work over the shared handle
  // (crater + every demotion/edge + every contradict + every precise credit reversal).
  // A mid-sweep crash leaves either the FULL sweep or NONE — never a half-clawed state.
  // A1 [Merkle MUTATION coverage] — journal each control-plane effect as a signed,
  // content-addressed MUTATION receipt INSIDE this same sweep transaction (so a receipt
  // + the mutation it describes commit or roll back as ONE unit). Emitted ONLY when a
  // ratification ledger + system signer are wired (latent-journaling gate); with no
  // ledger there is nowhere to journal and the path is byte-identical to today.
  const emitMut = (payload: MutationPayload): void => {
    if (pending !== undefined && systemSigner !== undefined) {
      pending.appendMutation(payload, systemSigner);
    }
  };

  return withSweepTxn(store, () => {
  // --- 1. DIRECT SEED + authoritative idempotency ----------------------------
  // Capture the disowned source's PRE-crater reputation state for the receipt.
  const craterBefore = ledger.stateOf(sourceId);
  const direct = ledger.disownSweep(sourceId, assertedStrandIds);
  const seedClawedBack = direct.clawedBack;

  // A second sweep of an already-disowned source craters nothing further and must
  // not re-walk the graph — a clean idempotent no-op.
  if (seedClawedBack.length === 0) {
    return {
      seedClawedBack: [],
      demotedDownstream: [],
      contradictedSources: [],
      reversedCorroborationEventIds: [],
      reviewQueued: [],
      reopenedDisputes: [],
      survivedDemotion: [],
      visitedCount: 0,
    };
  }

  // A1 — the direct-seed crater happened: journal it (before/after reputation state).
  emitMut(
    mutationReceipt(
      "DISOWN_CRATER",
      String(sourceId),
      hashSubjectId(String(sourceId)),
      hashReputationState(craterBefore),
      hashReputationState(ledger.stateOf(sourceId)),
      now,
    ),
  );

  // --- 2. TAINT ROOTS (dedupe by content_hash) + tainted class set ------------
  const visited = new Set<StrandId>();
  const seedStrands: Strand[] = [];
  const seenFingerprints = new Set<string>();
  const taintedClasses = new Set<IndependenceClassId>();

  for (const id of seedClawedBack) {
    if (visited.has(id)) continue;
    visited.add(id);
    const strand = store.getStrand(id);
    if (strand === null) continue; // fail closed: skip the node, never abort

    const fp = rootFingerprint(strand);
    if (!seenFingerprints.has(fp)) {
      seenFingerprints.add(fp);
      seedStrands.push(strand);
    }
    // The tainted independence classes are the classes the DISOWNED source sourced.
    for (const root of strand.provenance) {
      if (root.sourceId === sourceId) taintedClasses.add(root.independenceClass);
    }
  }

  // Fail-closed fallback: if none of the seed strands recorded the disowned source
  // as a root's sourceId (e.g. provenance sourceId left null), treat EVERY class on
  // the seed strands as tainted. Better to over-demote downstream than to silently
  // let a fraudulent root's derivatives stand — and contradiction is still bounded
  // to these seed-derived classes (a wholly-unrelated independent class never
  // appears here).
  if (taintedClasses.size === 0) {
    for (const strand of seedStrands) {
      for (const root of strand.provenance) taintedClasses.add(root.independenceClass);
    }
  }

  // --- 3 + 4. DOWNSTREAM BFS over DERIVATION edges (backward) -----------------
  const demotedDownstream: StrandId[] = [];
  const contradictedSources = new Set<SourceId>();
  const survivedDemotion: StrandId[] = [];
  const sentinel = disownSentinelFor(sourceId);

  // HARDENING 3: the FULL tainted strand closure (seed + every demoted downstream
  // strand) — the set a margin recompute checks adjudication contributors against.
  const taintedStrandIds = new Set<StrandId>(seedClawedBack);

  // Frontier seeded with the deduped seed strands, expanded in deterministic order.
  let frontier: Strand[] = [...seedStrands].sort(byHashThenId);

  while (frontier.length > 0) {
    const nextFrontier: Strand[] = [];
    const nextSeenFp = new Set<string>();

    for (const tainted of frontier) {
      // Edges ENTERING `tainted`, restricted to DERIVATION, in deterministic order.
      const inEdges = store
        .inEdges(tainted.id)
        .filter((e) => e.edgeType === EdgeType.DERIVATION)
        .sort(byEdgeId);

      for (const edge of inEdges) {
        const derivedId = edge.from; // the strand that RESTED ON `tainted`
        if (visited.has(derivedId)) continue; // cycle-safe: each strand once
        visited.add(derivedId);

        const derived = store.getStrand(derivedId);
        if (derived === null) continue; // fail closed: dangling edge, skip node

        // -- HARDENING 4: false-disown-as-suppression protection --------------
        // If this derived strand retains sufficient GENUINELY-INDEPENDENT support
        // that SURVIVES removal of the tainted set, its existence does NOT solely
        // rest on the tainted input — keep it LIVE and do NOT continue the BFS
        // through it (its derivatives are not tainted via this surviving strand).
        // Reputation reversal stays a SEPARATE, class-bounded decision (untouched).
        if (
          checkSurvivingSupport &&
          survivingIndependentSupport(derived, sourceId, taintedClasses) >=
            minSurvivingSupport
        ) {
          survivedDemotion.push(derived.id);
          continue;
        }

        // This derived strand's existence rests on tainted input: it joins the
        // tainted closure (for the adjudication margin recompute) and is demoted.
        taintedStrandIds.add(derived.id);

        // -- DEMOTE (existence rests on tainted input; never delete) ----------
        const stubEdge: Edge = {
          id: mintEdgeId(sentinel, derived.id),
          from: sentinel,
          to: derived.id,
          edgeType: EdgeType.OUTRANKS,
          link_confidence: 1 as Unit,
          provenance_independence: 1 as Unit,
          recency: 1 as Unit,
          w: 1 as Unit,
          out_weight_sum: 1 as Unit,
        };
        const demoteBefore = hashStrandState(derived); // pre-mutation audit state
        store.putEdge(stubEdge);
        demote(derived, stubEdge); // mutates fact_state + outranked_by in place
        store.putStrand(derived);
        demotedDownstream.push(derived.id);

        // A1 — journal the demotion (its OUTRANKS edge is covered by the after-state's
        // `outranked_by` + the edge id in `refEventId`; no separate per-edge receipt).
        emitMut(
          mutationReceipt(
            "DEMOTE",
            String(derived.id),
            String(derived.content_hash),
            demoteBefore,
            hashStrandState(derived),
            now,
            String(stubEdge.id),
          ),
        );

        // -- CONTRADICT downstream sources, BOUNDED BY TAINTED CLASS ----------
        // Only claw back credit from a source whose OWN provenance class is in the
        // tainted set. A backer in a genuinely independent class merely co-occurs
        // (coincidental agreement) and is NOT punished, even though `derived` is
        // demoted because its EXISTENCE rested on tainted input.
        for (const root of derived.provenance) {
          if (root.sourceId === null) continue;
          if (!taintedClasses.has(root.independenceClass)) continue;
          contradictedSources.add(root.sourceId);
        }

        // -- Continue the BFS from this newly-tainted derived strand ----------
        const fp = rootFingerprint(derived);
        if (!nextSeenFp.has(fp)) {
          nextSeenFp.add(fp);
          nextFrontier.push(derived);
        }
      }
    }

    frontier = nextFrontier.sort(byHashThenId);
  }

  // -- Drive the actual reputation clawback for each downstream source (once) ---
  // Deterministic order so the ledger sees a reproducible sequence.
  const contradicted: SourceId[] = [...contradictedSources].sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
  );
  for (const s of contradicted) {
    const before = ledger.stateOf(s);
    const post = ledger.contradict(s, now);
    // A1 — journal the downstream contradict (before/after reputation state).
    emitMut(
      mutationReceipt(
        "REPUTATION_CONTRADICT",
        String(s),
        hashSubjectId(String(s)),
        hashReputationState(before),
        hashReputationState(post),
        now,
      ),
    );
  }

  // --- 5. PRECISE CORROBORATION-CREDIT REVERSAL (bounded, over the tainted closure) ----
  // For each corroboration event whose `corroboratingStrandIds` intersect the FULL
  // TAINTED CLOSURE (`taintedStrandIds` = seed ∪ every demoted-downstream strand),
  // reverse EXACTLY the recorded `reputationDelta` on its beneficiary — bounded (a
  // beneficiary with no intersecting event is untouched), precise (the exact earned
  // delta, clamped at the floor by `reverseCredit`), and IDEMPOTENT (the ledger's
  // `markReversed` guard means each event is reversed at most once across any number
  // of sweeps — a second disown, or a different disowned source intersecting the same
  // event, reverses nothing more). The intersection IS the F3 guard: a coincidental
  // independent agreer whose event names no strand in the closure is never clawed
  // (re-observed/uncited influence is the documented priced-not-prevented residual).
  const reversedCorroborationEventIds: string[] = [];
  if (corrob !== undefined) {
    // The tainted closure is the disowned source's seed ∪ demoted-downstream strands.
    // Walk the intersecting events in the ledger's stable append order for determinism.
    for (const ev of corrob.eventsIntersecting(taintedStrandIds)) {
      if (!corrob.markReversed(ev.eventId)) continue; // already reversed: skip
      const before = ledger.stateOf(ev.beneficiarySourceId);
      const post = ledger.reverseCredit(ev.beneficiarySourceId, ev.reputationDelta, now);
      reversedCorroborationEventIds.push(ev.eventId);
      // A1 — journal the exact credit reversal (refEventId = the corroboration eventId).
      emitMut(
        mutationReceipt(
          "REPUTATION_REVERSE_CREDIT",
          String(ev.beneficiarySourceId),
          hashSubjectId(String(ev.beneficiarySourceId)),
          hashReputationState(before),
          hashReputationState(post),
          now,
          ev.eventId,
        ),
      );
    }
  }

  // --- 6. HARDENING 1: WEAK-INFLUENCE REVIEW QUEUE (uncited-influence channel) --
  // A work that CONSULTED a strand in the tainted closure (recorded as a weak-influence
  // edge, NOT a DERIVATION edge) cannot be proven to depend on it — so it is queued for
  // a HUMAN to review, never auto-demoted. Deduped by influenced strand (the ledger
  // does this), idempotent across re-sweeps (the ledger's `markReviewed` guard).
  const reviewQueued: ReviewQueueEntry[] = [];
  if (weakInfluence !== undefined) {
    for (const edge of weakInfluence.edgesConsulting(taintedStrandIds)) {
      if (!weakInfluence.markReviewed(edge.strandId, String(sourceId))) continue;
      reviewQueued.push({
        strandId: edge.strandId,
        reason: "WEAK_INFLUENCE_REVIEW",
        disownedSource: sourceId,
        at: now,
      });
    }
  }

  // --- 7. HARDENING 3: ADJUDICATION RE-OPENING (threshold-effects channel) ------
  // For each RESOLVED adjudication whose recorded `contributingStrandIds` intersect
  // the tainted closure, recompute the winner's SURVIVING margin with the tainted
  // contributors removed. If it drops BELOW the decisive threshold, the dispute was
  // merely TIPPED by tainted input: RE-OPEN it as a PENDING ratification (reason
  // `REOPENED_BY_DISOWN`) so a human re-decides. Idempotent via `markReopened`.
  const reopenedDisputes: ContradictionSetId[] = [];
  if (adjProvenance !== undefined) {
    for (const rec of adjProvenance.recordsContributedBy(taintedStrandIds)) {
      const surviving = survivingMargin(rec, taintedStrandIds);
      if (surviving >= decisiveMargin) continue; // still decisive: do NOT re-open
      if (!adjProvenance.markReopened(rec.contradictionSetId)) continue; // already re-opened
      // Transition the dispute back to PENDING for a human (losers NOT auto-promoted).
      if (pending !== undefined && systemSigner !== undefined) {
        pending.appendPending(
          {
            contradictionSetId: rec.contradictionSetId,
            attribute: rec.attribute,
            members: [rec.winner],
            reason: "REOPENED_BY_DISOWN",
            createdAt: now,
          },
          systemSigner,
        );
      }
      reopenedDisputes.push(rec.contradictionSetId);
    }
  }

  return {
    seedClawedBack,
    demotedDownstream,
    contradictedSources: contradicted,
    reversedCorroborationEventIds,
    reviewQueued,
    reopenedDisputes,
    survivedDemotion,
    visitedCount: visited.size,
  };
  });
}
