/**
 * forgetting/consolidation.ts — ECHO COLLAPSE, CONTRADICTION-SET HANDLING, DEMOTION.
 *
 * This module is the "tidy-up" half of the forgetting floor (CLAUDE.md "Resolved
 * floor: forgetting"). It does two structurally different jobs that must NEVER be
 * conflated:
 *
 *  1. ECHO COLLAPSE (SIMPLE, implemented here).
 *     "Same-root floods collapse to multiplicity 1." Two strands that agree AND
 *     descend from the SAME provenance root (same ProvenanceRoot / same
 *     independence class) are an ECHO, not corroboration. Collapsing them is safe
 *     and purely mechanical: we keep one representative per (entity, attribute,
 *     payload, independence-class) group and discard the duplicate echoes. No
 *     judgement about *truth* is made — only about *sameness of source*.
 *
 *  2. CONTRADICTION ADJUDICATION (HARD CORE — implemented here, in {@link tryConsolidate}).
 *     When several co-equal claims DISAGREE about one (entity, attribute) and they
 *     come from INDEPENDENT roots, picking a winner is the hard theorem boundary
 *     (CLAUDE.md "The hard theorem"). Under "identity is priced, not prevented"
 *     there is *no purely internal rule* that both lets one true witness overturn a
 *     planted false canonical AND stops two fake sources overturning a true
 *     incumbent. Therefore this module MUST NOT decide a winner from inside the
 *     graph. It may only collapse agreeing same-root echoes; any cross-root
 *     adjudication defers to the Source-Identity Layer (the {@link IdentityStamp}s
 *     passed in): {@link tryConsolidate} either AUTO-RESOLVES on a decisive, earned
 *     EXTERNAL reputation margin (never an in-graph majority) or DEFERS to the human
 *     ratify horn — it never picks a winner from inside the graph.
 *
 * THE SAFETY RULE (encoded in types + asserted at the seam below):
 *   collapse/consolidation may ONLY fold together AGREEING, SAME-ROOT echoes
 *   (same ProvenanceRootId.independenceClass). It may NEVER pick a winner among
 *   DISAGREEING, INDEPENDENT roots. "X moved"-style derived facts emerge only from
 *   one strand OUTRANKING another over time — and that outranking is authorized by
 *   the identity layer, never by a bare in-graph majority vote.
 *
 * Demotion NEVER deletes (CLAUDE.md "Contradiction demotes, never deletes"): a
 * losing strand has `fact_state` set to {@link FactState.DEMOTED} and its
 * `outranked_by` pointed at the single {@link EdgeType.OUTRANKS} edge that explains
 * the demotion. The strand stays in the web as history.
 *
 * Dependencies (per scaffold contract):
 *  - core/types.ts          — the shared strand/edge/identity contract (imported).
 *  - store/StrandStore.ts   — the pluggable persistence seam. Not imported here:
 *                             every function in this module is PURE over the
 *                             strands/edges handed to it, so the store can call
 *                             these and then persist the results itself. Keeping
 *                             this module store-agnostic lets a faster backend
 *                             replace the in-memory store without touching
 *                             consolidation logic.
 */

import {
  type AttributeKey,
  type ContradictionSetId,
  type Edge,
  type EdgeId,
  type EpochMs,
  type IdentityStamp,
  type IndependenceClassId,
  type ProvenanceRoot,
  type ProvenanceRootId,
  type Strand,
  type StrandId,
  type Unit,
  EdgeType,
  FactState,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// 1. SAME-ROOT ECHO COLLAPSE  (SIMPLE — fully implemented)
// ---------------------------------------------------------------------------

/**
 * Stable key identifying one ECHO GROUP: strands that make the *same* claim from
 * the *same* independence class are echoes of each other. We group by
 * (entity, attribute, payload-fingerprint, independence-class) and keep exactly
 * one representative per group ("collapse to multiplicity 1").
 *
 * NOTE on independence class: per CLAUDE.md, "same root" is judged over the
 * offline-assigned {@link IndependenceClassId}, never over raw root ids — two roots
 * in the same class are not independent of one another, so they collapse together.
 */
type EchoGroupKey = string;

/**
 * Cheap, deterministic fingerprint of a strand's payload so that two strands with
 * structurally-equal payloads land in the same echo group. JSON.stringify is
 * sufficient for the scaffold; a real backend may swap in `content_hash`. We fall
 * back to the strand's own `content_hash` when the payload is not JSON-encodable.
 */
function payloadFingerprint(strand: Strand): string {
  // Prefer the content hash when present: it is exactly the content-addressing the
  // archive stub already relies on, and is stable across serializations.
  if (strand.content_hash) return String(strand.content_hash);
  try {
    return JSON.stringify(strand.payload);
  } catch {
    // Unserializable payload (cycles, BigInt, etc.): fall back to identity so we
    // never accidentally collapse two genuinely different unhashable payloads.
    return `\u0000strand:${strand.id}`;
  }
}

/**
 * Compute the set of independence classes a strand descends from. A strand with
 * provenance spanning multiple classes is, by definition, NOT a pure single-root
 * echo of anything — collapsing it could silently drop independent corroboration.
 * We therefore only ever treat a strand as an echo candidate when it has EXACTLY
 * ONE independence class behind it.
 */
function soleIndependenceClass(
  provenance: readonly ProvenanceRoot[],
): IndependenceClassId | null {
  if (provenance.length === 0) return null;
  const first = provenance[0]!.independenceClass;
  for (let i = 1; i < provenance.length; i++) {
    if (provenance[i]!.independenceClass !== first) {
      // Mixed independence classes => multi-root => not a collapsible echo.
      return null;
    }
  }
  return first;
}

/**
 * Build the echo-group key for a strand, or `null` if the strand is NOT an
 * echo-collapse candidate (no provenance, or provenance spanning >1 independence
 * class — those carry independent corroboration and must be preserved).
 */
function echoGroupKeyFor(strand: Strand): EchoGroupKey | null {
  const cls = soleIndependenceClass(strand.provenance);
  if (cls === null) return null;
  const attr = strand.attribute === null ? "\u0000" : String(strand.attribute);
  // Tab-delimited; components are ids/hashes that never contain a tab.
  return `${String(strand.entity)}\t${attr}\t${payloadFingerprint(strand)}\t${String(cls)}`;
}

/**
 * Choose which strand survives when several strands collapse into one. We keep the
 * one with the MOST external re-observations (strongest keep-pressure), breaking
 * ties by earliest observation (the original arrival, preserving the grace floor).
 * This is a mechanical tidy-up choice, NOT a truth judgement — every strand in the
 * group agrees, so any survivor carries the same claim.
 */
function preferSurvivor(a: Strand, b: Strand): Strand {
  if (a.external_reobservation_count !== b.external_reobservation_count) {
    return a.external_reobservation_count > b.external_reobservation_count ? a : b;
  }
  if (a.observedAt !== b.observedAt) {
    return a.observedAt <= b.observedAt ? a : b;
  }
  // Final deterministic tie-break on id so the function is total and order-stable.
  return String(a.id) <= String(b.id) ? a : b;
}

/**
 * Collapse SAME-ROOT AGREEING echoes to multiplicity 1.
 *
 * CLAUDE.md: "Same-root floods collapse to multiplicity 1." Two strands agreeing
 * from the *same* root are an echo, not corroboration, so the flood may be folded
 * down to a single representative WITHOUT losing any independent signal.
 *
 * SAFETY (the rule this whole module is built around): this function only ever
 * folds strands that (a) make the SAME claim — same (entity, attribute, payload) —
 * AND (b) descend from a SINGLE shared independence class. It can therefore never
 * drop an independent corroboration and never "picks a winner" among disagreeing
 * sources: members of a collapsed group do not disagree, by construction.
 *
 * Strands that are not echo candidates (no provenance, or mixed independence
 * classes) pass through untouched. The function is PURE: it returns a new array
 * and mutates nothing; the caller (e.g. the StrandStore) persists the result.
 *
 * @param strands the strands to scan for same-root echo floods.
 * @returns a new array with each same-root echo group reduced to one survivor,
 *          preserving input order of the survivors.
 */
export function collapseSameRootEchoes(strands: Strand[]): Strand[] {
  // group key -> chosen survivor so far
  const survivors = new Map<EchoGroupKey, Strand>();
  // group key -> index of the survivor in the output, so a later, stronger
  // member can replace the representative in place and keep output order stable.
  const survivorIndex = new Map<EchoGroupKey, number>();
  const out: Strand[] = [];

  for (const strand of strands) {
    const key = echoGroupKeyFor(strand);

    // Not a collapse candidate: emit as-is, never folded.
    if (key === null) {
      out.push(strand);
      continue;
    }

    const existing = survivors.get(key);
    if (existing === undefined) {
      // First member of this echo group: it occupies a slot.
      survivors.set(key, strand);
      survivorIndex.set(key, out.length);
      out.push(strand);
      continue;
    }

    // Same-root echo of an already-seen claim: collapse to multiplicity 1 by
    // keeping the preferred survivor in the slot the group already owns.
    const winner = preferSurvivor(existing, strand);
    if (winner !== existing) {
      survivors.set(key, winner);
      out[survivorIndex.get(key)!] = winner;
    }
    // The non-survivor is simply not emitted — it was an echo, not new signal.
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. CONTRADICTION SET  (data shape SIMPLE; adjudication HARD)
// ---------------------------------------------------------------------------

/**
 * The cluster of co-equal claims that DISAGREE about one (entity, attribute).
 * Membership is recorded on each strand as `contradiction_set`; this is the
 * inverted view used by adjudication. A contradiction set is the unit the hard
 * theorem operates on: it is the "contradiction-set bomb" surface (CLAUDE.md
 * attack #1) and the thing the identity layer must arbitrate.
 *
 * IMPORTANT: a contradiction set, by definition, holds DISAGREEING members. It
 * therefore must NEVER be resolved by an in-graph majority vote — that is exactly
 * the move the hard theorem forbids. Resolution authority lives in the identity
 * layer (see {@link tryConsolidate}).
 */
export interface ContradictionSet {
  /** Stable id of this contradiction set (mirrors `Strand.contradiction_set`). */
  readonly id: ContradictionSetId;
  /** The co-equal disputed strands, by id. Order is not significant. */
  readonly members: StrandId[];
  /** The (entity, attribute) the members disagree about. */
  readonly attribute: AttributeKey;
}

/** Deterministic id derived from the disputed attribute (scaffold-stable). */
function contradictionSetIdFor(attribute: AttributeKey): ContradictionSetId {
  return `cset:${String(attribute)}` as ContradictionSetId;
}

/**
 * Build a {@link ContradictionSet} from a group of co-equal claiming strands.
 *
 * Pre-condition (caller's responsibility): `strands` are the co-equal claims about
 * ONE (entity, attribute) — typically every strand sharing one
 * {@link AttributeKey}. This function does NOT decide who is right; it merely
 * assembles the dispute surface. The attribute is taken from the members; all
 * members are expected to share it.
 *
 * @param strands the co-equal disputed strands (must be non-empty and share one
 *                non-null {@link AttributeKey}).
 * @returns the assembled contradiction set.
 * @throws if `strands` is empty or the members do not share a single non-null
 *         attribute key (a malformed dispute we must not silently paper over).
 */
export function buildContradictionSet(strands: Strand[]): ContradictionSet {
  if (strands.length === 0) {
    throw new Error(
      "buildContradictionSet: refusing to build a contradiction set from zero strands.",
    );
  }

  const attribute = strands[0]!.attribute;
  if (attribute === null) {
    throw new Error(
      "buildContradictionSet: members must claim a concrete (entity, attribute); got a null attribute.",
    );
  }

  const members: StrandId[] = [];
  for (const s of strands) {
    if (s.attribute !== attribute) {
      throw new Error(
        `buildContradictionSet: heterogeneous attributes (${String(attribute)} vs ${String(
          s.attribute,
        )}); a contradiction set is per single (entity, attribute).`,
      );
    }
    members.push(s.id);
  }

  return {
    id: contradictionSetIdFor(attribute),
    members,
    attribute,
  };
}

// ---------------------------------------------------------------------------
// 3. DEMOTION  (SIMPLE — implemented; demotes, never deletes)
// ---------------------------------------------------------------------------

/**
 * The outcome of demoting one strand because another outranked it. Demotion is the
 * ONLY way a co-equal claim leaves LIVE status via contradiction, and it is
 * non-destructive: the loser is retained as history (CLAUDE.md "kept as history").
 */
export interface DemotionResult {
  /** The strand that lost and was demoted. */
  readonly demoted: StrandId;
  /** The single OUTRANKS edge that explains the demotion (written to `outranked_by`). */
  readonly outranks: EdgeId;
  /** The loser's new fact state — always {@link FactState.DEMOTED}. */
  readonly newState: FactState;
}

/**
 * Demote `loser`, recording that it was outranked by `winnerEdge`.
 *
 * CLAUDE.md: "Contradiction DEMOTES, never deletes." This sets the loser's
 * `fact_state` to {@link FactState.DEMOTED} and points `outranked_by` at the single
 * {@link EdgeType.OUTRANKS} edge that explains the demotion. Derived "X moved"
 * facts emerge precisely from this outranking relationship accumulating over time.
 *
 * This function performs the MECHANICAL state transition only; it does NOT decide
 * *whether* the loser should lose — that authorization is the hard core handled in
 * {@link tryConsolidate} via the identity layer. It mutates `loser` in place (so
 * the store sees the transition) and returns a typed receipt.
 *
 * @param loser      the strand being demoted (mutated: fact_state + outranked_by).
 * @param winnerEdge the OUTRANKS edge from the winning strand to `loser`.
 * @returns a {@link DemotionResult} receipt of the transition.
 * @throws if `winnerEdge` is not an {@link EdgeType.OUTRANKS} edge, or does not
 *         actually point at `loser` (a mis-wired demotion we must not record).
 */
export function demote(loser: Strand, winnerEdge: Edge): DemotionResult {
  if (winnerEdge.edgeType !== EdgeType.OUTRANKS) {
    throw new Error(
      `demote: winnerEdge must be an OUTRANKS edge, got ${winnerEdge.edgeType}.`,
    );
  }
  if (winnerEdge.to !== loser.id) {
    throw new Error(
      `demote: winnerEdge.to (${String(winnerEdge.to)}) does not point at loser (${String(
        loser.id,
      )}); refusing to record a mis-wired demotion.`,
    );
  }

  loser.fact_state = FactState.DEMOTED;
  loser.outranked_by = winnerEdge.id;

  return {
    demoted: loser.id,
    outranks: winnerEdge.id,
    newState: FactState.DEMOTED,
  };
}

/**
 * The outcome of promoting a strand back to LIVE because an `approve()` resolution
 * designated it the winner despite it NOT already being LIVE.
 */
export interface PromotionResult {
  /** The strand that was promoted back to LIVE. */
  readonly promoted: StrandId;
  /** The strand's new fact state — always {@link FactState.LIVE}. */
  readonly newState: FactState;
}

/**
 * Promote `winner` to LIVE, clearing any stale `outranked_by` pointer — the mirror
 * image of {@link demote}.
 *
 * Every PRE-EXISTING `approve()` caller disputes only among strands that are
 * ALREADY LIVE (a fresh DEFERRED multi-class dispute's members are always LIVE —
 * `adjudicate()` only admits LIVE members), so historically the designated winner
 * never needed promoting. That stops being true for a `REOPENED_BY_DISOWN` dispute
 * (`ratification/disown.ts`): it threads the ORIGINAL losing member ids back into
 * the reopened dispute's `members` so a genuinely surviving, non-tainted claim can
 * be picked over the now-tainted original winner — but that pick is currently
 * DEMOTED (from the FIRST resolution). Without this promotion, `approve()` would
 * "succeed" while leaving BOTH the old and the newly-picked winner DEMOTED — the
 * re-decision would be structurally meaningless (nothing ends up LIVE). This
 * transition makes the pick real.
 *
 * Mechanical only, mirroring {@link demote}: it does NOT decide *whether* the
 * promotion is authorized — `approve()`'s distinct-approver + RC-5
 * anchor-independence gates already ran before this is ever called.
 *
 * @param winner the strand being promoted (mutated: fact_state + outranked_by).
 * @returns a {@link PromotionResult} receipt of the transition.
 */
export function promote(winner: Strand): PromotionResult {
  winner.fact_state = FactState.LIVE;
  winner.outranked_by = null;
  return { promoted: winner.id, newState: FactState.LIVE };
}

// ---------------------------------------------------------------------------
// 4. CONSOLIDATION ADJUDICATION  (HARD CORE — theorem-honest implementation)
// ---------------------------------------------------------------------------

/**
 * Map each member strand of a set to the {@link ProvenanceRootId}s behind it.
 * Used to look up the identity-layer stamps that back a strand's claim — the ONLY
 * legitimate source of who-outranks-whom authority (never the in-graph topology).
 */
function rootsOf(strand: Strand): ProvenanceRootId[] {
  return strand.provenance.map((p) => p.rootId);
}

/**
 * The set of independence classes spanned by a collection of strands. If a whole
 * contradiction set collapses to a SINGLE independence class, then its members are
 * NOT independent of each other — the "disagreement" is an intra-root artifact and
 * may be consolidated by the safe same-root rule. If it spans MORE THAN ONE class,
 * the members are independent and the hard theorem applies: NO in-graph rule may
 * pick a winner.
 */
function independenceClassesOf(strands: Iterable<Strand>): Set<IndependenceClassId> {
  const classes = new Set<IndependenceClassId>();
  for (const s of strands) {
    for (const p of s.provenance) classes.add(p.independenceClass);
  }
  return classes;
}

// ---------------------------------------------------------------------------
// 4a. EXTERNAL-SIGNAL STRENGTH (the only legitimate adjudication input)
// ---------------------------------------------------------------------------

/**
 * The externally-witnessed strength of one member's backing, distilled from the
 * Source-Identity stamps behind its provenance roots. EVERY field here is an
 * EXTERNAL signal the web cannot compute about itself (CLAUDE.md "Interface to the
 * web"): reputation (earned slowly / lost fast), anchor cost (priced identity),
 * and posted stake (skin in the game). HEADCOUNT IS DELIBERATELY ABSENT — the hard
 * theorem forbids resolving a dispute by majority, and the contradiction-bomb
 * abuses exactly that. Ties fall through to a deterministic id tiebreak so a flood
 * of weightless fresh echoes still resolves (one survives) WITHOUT a vote.
 */
interface MemberStrength {
  readonly strandId: StrandId;
  /** Best earned reputation across this member's backing sources, in [0,1]. */
  readonly reputation: Unit;
  /** Best priced anchor cost across this member's backing sources, in [0,1]. */
  readonly anchorCost: Unit;
  /** Most stake posted across this member's backing sources. */
  readonly stakePosted: number;
}

/**
 * Distil a member strand's external strength from `stampsByRoot`. A member whose
 * roots have no resolvable stamp degrades to the ZERO stamp (reputation 0, cost 0,
 * stake 0) — it does NOT throw and does NOT borrow strength from anywhere in the
 * graph. This is what makes a flood of fresh same-class echoes collapse to all-zero
 * strength (so the comparator falls through to the deterministic id tiebreak, never
 * to a headcount). We take the BEST stamp per signal across the member's roots: a
 * member is as strong as its strongest legitimate backer.
 */
function memberStrengthOf(
  strand: Strand,
  stampsByRoot: Map<ProvenanceRootId, IdentityStamp>,
): MemberStrength {
  let reputation = 0 as Unit;
  let anchorCost = 0 as Unit;
  let stakePosted = 0;
  for (const rootId of rootsOf(strand)) {
    const stamp = stampsByRoot.get(rootId);
    if (stamp === undefined) continue;
    if (stamp.reputation > reputation) reputation = stamp.reputation;
    if (stamp.anchor_cost > anchorCost) anchorCost = stamp.anchor_cost;
    if (stamp.stake_posted > stakePosted) stakePosted = stamp.stake_posted;
  }
  return { strandId: strand.id, reputation, anchorCost, stakePosted };
}

/**
 * STRICT external-signal comparator: returns negative if `a` is STRONGER than `b`,
 * positive if weaker, 0 only when fully equal AND same id (i.e. the same member).
 *
 * Lexicographic priority (CLAUDE.md trust order — track record dominates price
 * dominates stake): reputation desc -> anchor_cost desc -> stake_posted desc ->
 * StrandId ascending. The final id key makes the order TOTAL and DETERMINISTIC, so
 * the bomb test is stable and a fresh-echo flood (all signals 0) still picks a
 * single, reproducible winner without ever counting members. This is NEVER a
 * majority/headcount comparison — multiplicity of a claim contributes nothing.
 */
function byStrengthDesc(a: MemberStrength, b: MemberStrength): number {
  if (a.reputation !== b.reputation) return b.reputation - a.reputation;
  if (a.anchorCost !== b.anchorCost) return b.anchorCost - a.anchorCost;
  if (a.stakePosted !== b.stakePosted) return b.stakePosted - a.stakePosted;
  // Deterministic, headcount-free tiebreak: ascending id (id-min wins).
  const ai = String(a.strandId);
  const bi = String(b.strandId);
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 4b. PENDING RATIFICATION  (the human horn — defer an independent dispute)
// ---------------------------------------------------------------------------

/**
 * Why a contradiction set was deferred to a human ratifier rather than resolved
 * in-graph:
 *  - `INDEPENDENT_DISPUTE`: the members span >1 independence class, so the hard
 *    theorem forbids any in-graph winner (the original deferral path).
 *  - `REOPENED_BY_DISOWN`: a previously-RESOLVED dispute was RE-OPENED because a
 *    disown removed the tainted strands that had given the winner its decisive
 *    margin, dropping the recomputed margin below threshold (ARCHITECTURE.md §4(c)).
 *    The previously-demoted losers are NOT auto-promoted; the human re-decides.
 */
export type PendingRatificationReason = "INDEPENDENT_DISPUTE" | "REOPENED_BY_DISOWN";

/**
 * A request emitted when a contradiction set spans MORE THAN ONE independence class
 * and therefore CANNOT be adjudicated from inside the web (the hard theorem). This
 * is the Tanaka-shaped human horn: the dispute is escalated to a human / second
 * admin who supplies the missing EXTERNAL signal via the `ratify` verb. The web
 * NEVER decides an independent dispute itself; it only prepares the queue the human
 * sees. The caller persists this; nothing is demoted on this path.
 */
export interface PendingRatification {
  /** The contradiction set awaiting a human decision. */
  readonly contradictionSetId: ContradictionSetId;
  /** The (entity, attribute) the members disagree about. */
  readonly attribute: AttributeKey;
  /**
   * The disputed members, ORDERED strongest-first by the same external-signal
   * comparator used in the safe case. This ordering DECIDES NOTHING — it merely
   * surfaces the most-credible claims at the top of the reviewer's queue. The human
   * remains the sole adjudicator of an independent dispute.
   */
  readonly members: readonly StrandId[];
  /** Why this was deferred (currently always an INDEPENDENT_DISPUTE). */
  readonly reason: PendingRatificationReason;
  /** When the deferral was raised (caller-supplied, so the module stays clock-pure). */
  readonly createdAt: EpochMs;
}

// ---------------------------------------------------------------------------
// 4c. CONSOLIDATION OUTCOME  (the typed result of an adjudication attempt)
// ---------------------------------------------------------------------------

/**
 * The outcome of attempting to adjudicate a contradiction set. A clear union so the
 * caller can branch without re-deriving intent:
 *  - RESOLVED: a single legitimately-strongest source won the SAFE (single
 *    independence class) dispute; every other distinct claim was demoted. Carries
 *    one {@link DemotionResult} per loser (a set may have several).
 *  - DEFERRED: the dispute is genuinely INDEPENDENT (spans >1 independence class);
 *    the safety gate forbids any in-graph winner, so a {@link PendingRatification}
 *    is emitted for a human. NOTHING is demoted.
 *  - NOOP: nothing to adjudicate (fewer than two distinct claims).
 */
export type ConsolidationOutcome =
  | { readonly kind: "RESOLVED"; readonly demotions: DemotionResult[] }
  | { readonly kind: "DEFERRED"; readonly pending: PendingRatification }
  | { readonly kind: "NOOP" };

/**
 * Default OUTRANKS edge-id minter: deterministic in (winner, loser) so two runs of
 * the same adjudication produce the same edge id (testable, idempotent-ish). The
 * caller may inject its own minter (e.g. a uuid source) via {@link tryConsolidate}.
 */
function defaultEdgeIdFor(winner: StrandId, loser: StrandId): EdgeId {
  return `edge:outranks:${String(winner)}->${String(loser)}` as EdgeId;
}

// ---------------------------------------------------------------------------
// 4d. ADJUDICATION POLICY  (the decisive-or-defer gate for INDEPENDENT disputes)
// ---------------------------------------------------------------------------

/**
 * The two reputation thresholds that govern whether a GENUINELY INDEPENDENT
 * (multi-independence-class) dispute may be auto-resolved by EARNED reputation, or
 * must defer to the human ratify horn. This operationalizes the council's
 * "reputation as a pre-filter so the contradiction-bomb never becomes human
 * fatigue": a clear high-rep incumbent vs a weightless fresh flood is resolved
 * automatically; only GENUINE ties (near-peers, or all-weightless floods) reach a
 * human.
 *
 * THEOREM SAFETY (the residual is "priced, not prevented"): auto-resolution leans
 * ONLY on EARNED reputation, which is grounded in external anchors/ratifications
 * (CLAUDE.md "earned slowly, lost fast"). Two FRESH fakes (reputation 0) can never
 * clear {@link minWinnerReputation}; a fake can only auto-win by EARNING higher
 * reputation than the incumbent, which is costly, accountable, and clawable by
 * `disownSweep`. Multiplicity/headcount is NEVER consulted — the ranking is the
 * pure reputation-first comparator, so a 500-member fresh flood is exactly as
 * weightless as one fresh source.
 */
export interface AdjudicationPolicy {
  /**
   * Minimum EARNED reputation gap (top minus runner-up) required to call a winner
   * DECISIVE. Below this, two comparably-credible independents are a genuine tie
   * and DEFER to a human. Expressed in LCB units (the stamp's `reputation` is now the
   * Beta lower-confidence bound — ARCHITECTURE.md §2).
   */
  readonly decisiveMargin: Unit;
  /**
   * Minimum EARNED reputation (LCB) the auto-winner must itself hold. A flood of
   * fresh (LCB 0) sources fails this outright, so no weightless source ever
   * auto-wins; only a genuinely-anchored, corroborated track record clears it.
   */
  readonly minWinnerReputation: Unit;
  /**
   * The HIGH-IMPACT GATE (ARCHITECTURE.md §2 "the LCB alone must NEVER clear a
   * decisive margin for high-impact/irreversible decisions"). When the CALLER marks a
   * decision high-impact (via the {@link HighImpactContext} passed to
   * {@link tryConsolidate}), a decisive LCB margin is NECESSARY but NOT SUFFICIENT:
   * the winner must ALSO clear all three of the thresholds below, else the dispute
   * DEFERS to a human no matter how large the LCB gap. Ordinary (non-high-impact)
   * adjudication ignores these fields entirely and behaves exactly as before on the
   * LCB readout.
   */
  /**
   * Minimum number of distinct INDEPENDENT corroborations the high-impact winner must
   * have earned (its audit `ratifiedCount`). A single lucky corroboration — however
   * high its LCB — cannot clear an irreversible decision. Conservative default 2.
   */
  readonly minCorroborationCount: number;
  /**
   * A RECENCY-CLEAN window in milliseconds: a high-impact winner must have had NO
   * contradiction within this window before `now`. A source contradicted recently is
   * under live dispute and may not clear an irreversible decision on LCB alone.
   * Conservative default 90 days (one decay half-life).
   */
  readonly recencyCleanWindowMs: number;
  /**
   * Minimum number of DISJOINT anchor independence classes the high-impact winner's
   * independence must derive from. ARCHITECTURE.md: "a winner whose independence
   * derives from ≥2 disjoint anchor classes" — one anchor class (even a costly one) is
   * a single point of Sybil failure for an irreversible decision. Conservative
   * default 2.
   */
  readonly minWinnerAnchorClasses: number;
  /**
   * F4a [STRUCTURAL, UNCONDITIONAL]: the minimum number of mutually anchor-INDEPENDENT
   * roots (the agreement-set root union via the engine-supplied `#R`) that must back a
   * MULTI-CLASS (`classes.size > 1`) auto-resolve winner. This is the external SECOND
   * LOCK the hard theorem requires: a single self-stacked / lone actor is R=1 and DEFERS
   * at ANY point on the decay curve, REGARDLESS of `highImpact`. It is checked on the
   * prospective winner BEFORE the decisive/earned admission and is INDEPENDENT of the
   * high-impact gate. Default 2. (Applies ONLY to the multi-class branch — see the inline
   * scope rationale at `tryConsolidate`; the single-class echo-collapse path must NEVER
   * carry a root-floor, which would re-open the contradiction-bomb as a DEFER-DoS.)
   */
  readonly multiClassMinRoots: number;
  /**
   * F4b [POLICY-interim]: the minimum number of in-domain CO-ASSERTERS (agreeing LIVE
   * strands on THIS (entity, attribute/value), via the engine-supplied
   * `attrCorroborationCountOf`) a multi-class auto-resolve winner must show. Re-prices
   * `CrossDomainSpend` from free (a globally-high-Beta source with ZERO track record on
   * the disputed attribute flips it) to one in-domain ratify. Evadable by one throwaway
   * in-domain corroboration — the STRUCTURAL closure is M1 (per-(source, attribute-domain)
   * reputation scoping), a COMMITTED FOLLOW-ON, NOT V2. Default 1 (>= one agreeing strand
   * beyond the winner itself). Does NOT touch the global Beta LCB.
   */
  readonly minAttrCorroboration: number;
  /**
   * M4 [STRUCTURAL, BATCH 4] — the DEPTH-MARGIN a MULTI-CLASS auto-resolve winner's
   * agreement DEPTH must exceed the runner-up's by: `dWin >= dRun + depthMargin`, where
   * `d = independentRootCount(R(value))` (the SAME engine-supplied `#R` agreement basis
   * F4a/F4b read — no third agreement notion). Caps the multi-class auto-resolve so a
   * SHALLOW challenger cannot overturn a DEEP incumbent on reputation magnitude alone:
   * the incumbency term reads `independentRootCount` ONLY (never reputation-magnitude,
   * establishment timestamp, or arrival order — any of which would re-create the
   * first-arrival trap). A deeply-corroborated incumbent is hard to overturn by a shallow
   * challenger (correct); a shallow planted-false "incumbent" is trivially overturned by a
   * DEEPER true challenger (requirement (a) preserved). Default 1 (winner strictly
   * deeper). Enforced ONLY when the engine supplies a REAL per-value `agreementRootCountOf`
   * (the multi-class engine path); inert on the pure module's unit-test default.
   */
  readonly depthMargin: number;
}

/**
 * The evidence a HIGH-IMPACT adjudication needs about the prospective winner — facts
 * the consolidation module CANNOT compute about itself (they live in the identity /
 * reputation layer): the winner's earned corroboration count, when it was last
 * contradicted, and how many disjoint anchor classes its independence derives from.
 * The CALLER (the engine, which sees the ledgers) resolves these per winner StrandId,
 * keeping this module pure. Presence of this context is what flags a decision
 * high-impact; omit it for ordinary adjudication.
 */
export interface HighImpactContext {
  /**
   * The independent-corroboration count the winner has earned (its reputation
   * ledger's audit `ratifiedCount`). Read from the identity layer, never the graph.
   */
  corroborationCountOf(winner: StrandId): number;
  /**
   * The witness time of the winner's MOST RECENT contradiction, or `null` if it has
   * never been contradicted. Used against `recencyCleanWindowMs`.
   */
  lastContradictionAtOf(winner: StrandId): EpochMs | null;
  /**
   * The number of independent MIS ROOTS backing the winning value (the engine supplies
   * `#R`: the agreement-set root-union passed through the identity layer's max-
   * independent-set). Counts mutually anchor-independent ACTORS, not anchor-class
   * costumes — a self-stacked single actor collapses to 1. Used against
   * `minWinnerAnchorClasses`.
   */
  anchorClassCountOf(winner: StrandId): number;
}

/**
 * Conservative defaults for {@link AdjudicationPolicy}, chosen against the
 * anchor-cost table (CLAUDE.md) so that NO fresh/cheap source can ever auto-win an
 * independent dispute:
 *
 *  - `minWinnerReputation = 0.20` sits ABOVE the bare-key `rep_cap` (~0.05) — so a
 *    free/disposable anchor can never reach it no matter how long it behaves — and
 *    well above a fresh source's reputation of exactly 0. Reaching 0.20 requires an
 *    EARNED, anchored track record (phone/domain/KYC-tier, repeatedly ratified),
 *    which is exactly the costly/accountable signal the theorem allows to price the
 *    residual.
 *  - `decisiveMargin = 0.30` means a flood at ~0 cannot win against a winner that
 *    must itself be >= 0.20, and even two ANCHORED sources must be a full 0.30
 *    apart — comfortably more than one ratify-step of noise (reputation moves up
 *    slowly) — so near-peers DEFER to a human rather than auto-resolve.
 *
 * Together they guarantee the only way to auto-win is to OUT-EARN the incumbent,
 * which is costly, accountable, and clawable by `disownSweep` (the accepted
 * residual). Callers may override per their own threat model.
 */
/**
 * The DEFAULT `agreementRootCountOf` sentinel for {@link tryConsolidate} — the pure
 * module's unit-test stand-in that returns exactly `multiClassMinRoots` (2) so F4a is
 * INERT on the default (`2 < 2` is false). The M4 depth-margin gate detects this exact
 * sentinel by IDENTITY and skips itself when it is in force, so M4 is enforced ONLY when
 * the engine supplies a REAL per-value `#R` callback (the multi-class engine path) — it
 * never fires on the pure-module default (where `dWin − dRun = 0 < depthMargin` would
 * otherwise spuriously DEFER every unit-test resolution).
 */
const DEFAULT_AGREEMENT_ROOT_COUNT_OF = (_winner: StrandId): number => 2;

export const DEFAULT_ADJUDICATION_POLICY: AdjudicationPolicy = {
  decisiveMargin: 0.3 as Unit,
  minWinnerReputation: 0.2 as Unit,
  // HIGH-IMPACT GATE defaults (only consulted when a HighImpactContext is supplied):
  // conservative — a high-impact/irreversible decision needs >= 2 independent
  // corroborations, no contradiction within the last 90 days, and a winner anchored
  // in >= 2 disjoint classes, ON TOP OF a decisive LCB margin.
  minCorroborationCount: 2,
  recencyCleanWindowMs: 90 * 86_400_000,
  minWinnerAnchorClasses: 2,
  // F4a [STRUCTURAL, UNCONDITIONAL]: every multi-class auto-resolve winner must be backed
  // by >= 2 mutually anchor-independent roots, regardless of highImpact. The external
  // second lock the hard theorem requires.
  multiClassMinRoots: 2,
  // F4b [POLICY-interim]: the multi-class winner must show >= 1 in-domain co-asserter on
  // the disputed value. Cheap CrossDomainSpend re-pricing; M1 is the structural closure.
  minAttrCorroboration: 1,
  // M4 [STRUCTURAL, BATCH 4]: a multi-class auto-resolve winner must be strictly DEEPER
  // (>= 1 more independent root) than the runner-up — depth-delta only, never magnitude.
  depthMargin: 1,
};

/**
 * Run the shared winner/demote loop: every member making a DIFFERENT claim than the
 * winner is demoted under a freshly minted OUTRANKS edge (winner -> loser). Members
 * echoing the winner's exact claim are not losers (same claim, nothing to demote).
 * Returns the list of demotions (possibly empty — an all-echo set demotes nothing).
 *
 * This is the IDENTICAL mechanical resolution used by both the single-class safe
 * case and the decisive multi-class auto-resolution: the winner is always the
 * reputation-first STRONGEST member, so no inversion is possible and headcount is
 * never consulted.
 */
/**
 * The HIGH-IMPACT GATE (ARCHITECTURE.md §2): given a prospective `winner` and the
 * caller-supplied {@link HighImpactContext}, decide whether the winner may clear an
 * IRREVERSIBLE decision. A decisive LCB margin is necessary but NOT sufficient — the
 * winner must ALSO have (a) >= `minCorroborationCount` independent corroborations,
 * (b) NO contradiction within `recencyCleanWindowMs` before `now` (recency-clean),
 * and (c) independence from >= `minWinnerAnchorClasses` disjoint anchor classes.
 * Returns `true` only when ALL three pass; any failure means the decision DEFERS to a
 * human no matter how large the LCB gap. Conservative / fail-closed: if the caller
 * cannot resolve a piece of evidence it should report the absence (0 count / null /
 * 0 classes), which fails the gate.
 */
function clearsHighImpactGate(
  winner: StrandId,
  now: EpochMs,
  policy: AdjudicationPolicy,
  ctx: HighImpactContext,
): boolean {
  // (a) enough independent corroboration.
  if (ctx.corroborationCountOf(winner) < policy.minCorroborationCount) return false;
  // (b) recency-clean: no contradiction within the window.
  const lastContra = ctx.lastContradictionAtOf(winner);
  if (lastContra !== null) {
    const sinceMs = (now as number) - (lastContra as number);
    if (sinceMs < policy.recencyCleanWindowMs) return false;
  }
  // (c) independence from enough disjoint anchor classes.
  if (ctx.anchorClassCountOf(winner) < policy.minWinnerAnchorClasses) return false;
  return true;
}

function resolveByDemotingLosers(
  winner: Strand,
  memberStrands: readonly Strand[],
  mintEdgeId: (winner: StrandId, loser: StrandId) => EdgeId,
): DemotionResult[] {
  const winnerClaim = payloadFingerprint(winner);
  const demotions: DemotionResult[] = [];
  for (const s of memberStrands) {
    if (s.id === winner.id) continue;
    if (payloadFingerprint(s) === winnerClaim) continue; // same claim => not a loser
    const edge: Edge = {
      id: mintEdgeId(winner.id, s.id),
      from: winner.id,
      to: s.id,
      edgeType: EdgeType.OUTRANKS,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    };
    demotions.push(demote(s, edge));
  }
  return demotions;
}

/**
 * Adjudicate a contradiction set, the THEOREM-HONEST way.
 *
 * THE SAFETY GATE (decisive-or-defer, checked FIRST): if the members span MORE
 * THAN ONE independence class they are mutually INDEPENDENT. Per the hard theorem
 * NO purely internal rule may pick a winner — but EARNED reputation is an EXTERNAL
 * signal (grounded in anchors/ratifications, not the graph). So this function
 * auto-resolves the dispute ONLY when reputation gives a DECISIVE, EARNED winner:
 *  (a) topReputation - secondReputation >= policy.decisiveMargin  (a clear gap), AND
 *  (b) topReputation >= policy.minWinnerReputation                 (genuinely earned).
 * Both gates are over the reputation-first comparator's top two members, so the
 * winner is never a lower-rep member (no inversion) and headcount is never
 * consulted (a 40-member fresh flood is exactly as weightless as one fresh source).
 * If EITHER gate fails — a weightless flood (all rep ~0 fails (b)) or two
 * comparably-high-rep independents (gap < margin fails (a)) — this DEFERS: it
 * returns a {@link PendingRatification} (the human horn) and demotes NOTHING. A true
 * tie always reaches a human; no fresh/low-rep source ever auto-wins.
 *
 * THE SAFE CASE (single independence class): the "disagreement" is a same-root echo
 * artifact. Here we DO resolve — but ONLY by EXTERNAL SIGNAL carried in the stamps:
 * reputation, then anchor cost, then posted stake, then a deterministic id tiebreak
 * (see {@link byStrengthDesc}). The single strongest source becomes the winner; each
 * member making a DIFFERENT claim is a loser and is {@link demote}d under a freshly
 * minted OUTRANKS edge. Members echoing the winner's exact claim are not losers
 * (same claim — nothing to demote). This defuses the contradiction-bomb: a flood of
 * fresh (reputation 0, cost 0, stake 0) echoes has no signal winner and falls
 * through to the id tiebreak — one survives, the rest are demoted WITHOUT a vote —
 * while a genuine high-reputation incumbent beats fresh challengers on reputation
 * alone.
 *
 * PURITY: this module does no store/identity I/O. The caller resolves
 * `set.members` (StrandId[]) to the `members` Strand objects and passes the
 * identity-layer `stampsByRoot`; it persists the returned demotions or pending
 * request. `now` is supplied by the caller so the module stays clock-pure.
 *
 * @param set          the contradiction set to adjudicate.
 * @param members      the resolved member Strand objects (order-agnostic).
 * @param stampsByRoot identity-layer stamps keyed by provenance root id — the ONLY
 *                     legitimate adjudication signal (reputation/anchor_cost/stake).
 * @param now          caller-supplied timestamp for any emitted PendingRatification.
 * @param mintEdgeId   optional OUTRANKS edge-id minter (winner, loser) -> EdgeId;
 *                     defaults to a deterministic generator.
 * @param policy       optional decisive-or-defer thresholds (in LCB units) + the
 *                     high-impact-gate thresholds; defaults to the conservative
 *                     {@link DEFAULT_ADJUDICATION_POLICY}.
 * @param highImpact   optional {@link HighImpactContext}. Its PRESENCE flags this
 *                     decision IRREVERSIBLE: a decisive LCB margin is then necessary
 *                     but NOT sufficient — the winner must also clear the
 *                     count/recency/anchor-class gate, else the dispute DEFERS no
 *                     matter the gap. Omit it for ordinary adjudication (unchanged
 *                     behavior on the LCB readout).
 * @param agreementRootCountOf  F4a [STRUCTURAL, UNCONDITIONAL]: the engine-supplied
 *                     count of mutually anchor-INDEPENDENT roots backing a prospective
 *                     MULTI-CLASS winner (the engine's `#R`). Defaulted to `() => 2` so
 *                     the pure unit suite (which omits it) passes the floor vacuously —
 *                     the engine ALWAYS overrides it on the adjudicate path. A winner
 *                     with `< policy.multiClassMinRoots` roots DEFERS regardless of
 *                     `highImpact`. OD-8: engine-owned evidence, never caller-injected.
 * @param attrCorroborationCountOf  F4b [POLICY-interim]: the engine-supplied count of
 *                     in-domain CO-ASSERTERS on the disputed value (`#deriveAgreementSet`
 *                     size). Defaulted to `() => Infinity` (passes vacuously for the unit
 *                     suite). Checked only on the multi-class decisive path, AFTER the F4a
 *                     structural floor — can only ADD deferrals, never relax the gate.
 * @returns a {@link ConsolidationOutcome}: RESOLVED (with demotions), DEFERRED
 *          (with a PendingRatification), or NOOP.
 * @throws if a member of `set` is missing from `members`, or a provided member is
 *         not actually in `set` (a mis-wired call we must not silently adjudicate).
 */
export function tryConsolidate(
  set: ContradictionSet,
  members: readonly Strand[],
  stampsByRoot: Map<ProvenanceRootId, IdentityStamp>,
  now: EpochMs,
  mintEdgeId: (winner: StrandId, loser: StrandId) => EdgeId = defaultEdgeIdFor,
  policy: AdjudicationPolicy = DEFAULT_ADJUDICATION_POLICY,
  highImpact?: HighImpactContext,
  agreementRootCountOf: (winner: StrandId) => number = DEFAULT_AGREEMENT_ROOT_COUNT_OF,
  attrCorroborationCountOf: (winner: StrandId) => number = () => Infinity,
): ConsolidationOutcome {
  // --- Validate the members match the set (no silent adjudication of garbage) --
  const byId = new Map<StrandId, Strand>();
  for (const m of members) byId.set(m.id, m);
  const memberIds = new Set(set.members);
  for (const id of memberIds) {
    if (!byId.has(id)) {
      throw new Error(
        `tryConsolidate: contradiction set member ${String(id)} was not provided in 'members'; ` +
          "the caller must resolve every member id to its Strand.",
      );
    }
  }
  // Use exactly the set's members (dedup via the id set), in a stable resolved list.
  const memberStrands: Strand[] = [];
  for (const id of memberIds) memberStrands.push(byId.get(id)!);

  // --- NOOP: fewer than two DISTINCT claims => nothing disputes ---------------
  const distinctClaims = new Set<string>();
  for (const s of memberStrands) distinctClaims.add(payloadFingerprint(s));
  if (memberStrands.length < 2 || distinctClaims.size < 2) {
    return { kind: "NOOP" };
  }

  // --- SAFETY GATE (decisive-or-defer, FIRST): independent dispute --------------
  // If the set spans more than one independence class its members are mutually
  // independent; the hard theorem forbids any HEADCOUNT/in-graph winner. We rank by
  // the SAME reputation-first comparator and auto-resolve ONLY when reputation gives
  // a DECISIVE, EARNED winner; otherwise we emit the human horn and demote NOTHING.
  // Build the strongest-first ranking once (also surfaces the human-queue order).
  const ranked = memberStrands
    .map((s) => memberStrengthOf(s, stampsByRoot))
    .sort(byStrengthDesc);

  // The human horn: emit a DEFERRED pending for this dispute (decides nothing).
  const deferPending = (): ConsolidationOutcome => ({
    kind: "DEFERRED",
    pending: {
      contradictionSetId: set.id,
      attribute: set.attribute,
      members: ranked.map((ms) => ms.strandId),
      reason: "INDEPENDENT_DISPUTE",
      createdAt: now,
    },
  });

  const classes = independenceClassesOf(memberStrands);
  if (classes.size > 1) {
    const top = ranked[0]!;
    const second = ranked[1]!;

    // ====================================================================
    // F4a [STRUCTURAL, UNCONDITIONAL] + SCOPE RATIONALE — multi-class ONLY.
    // ====================================================================
    // A multi-class dispute may auto-resolve ONLY if the winning VALUE is backed by
    // >= multiClassMinRoots mutually anchor-INDEPENDENT actors (the agreement-set root
    // union via the engine-supplied agreementRootCountOf == `#R`). A single self-stacked
    // / lone actor is R=1 and DEFERS — at ANY point on the decay curve, REGARDLESS of
    // highImpact. This is the external SECOND LOCK the hard theorem requires: without
    // >= 2 priced, disjoint roots a single source flipping/holding a multi-class dispute
    // is internally indistinguishable between aged-honest and aged-liar, so the only
    // sound action is DEFER. The floor is evaluated BEFORE the decisive/earned admission
    // and INDEPENDENTLY of highImpact (it subsumes the high-impact anchorClassCountOf>=2
    // check for the multi-class case, which reads the same `#R`); it can only ADD
    // deferrals — never a new false CLEAR (the min(distinctClassCount,maxSetSize) clamp
    // inside `#R` is anti-inflationary, reinforcing this direction).
    //
    // MANDATORY SCOPE — `classes.size > 1` ONLY. The single-class echo-collapse path
    // (below) MUST NOT carry this floor. Extending the >= 2-root floor onto the
    // single-class path re-opens the contradiction-bomb as a DEFER-DoS: 500 same-class
    // echoes (R=1 by construction — a same-root flood collapses to one independent root)
    // would each become a mandatory human enqueue — exactly the already-REJECTED `fp-4`
    // (blanket-defer), "trivially evaded by one self-stacked co-asserter." The
    // single-class branch is the SAFE mechanical tidy-up (same-root disagreement is an
    // echo artifact resolved by external stamp signal, demoting losers without a vote);
    // a root-floor there manufactures human fatigue with zero integrity gain. F4a is by
    // definition meaningful only on the multi-class path (OD-1 RESOLVED).
    if (agreementRootCountOf(top.strandId) < policy.multiClassMinRoots) {
      return deferPending();
    }

    // F4b [POLICY-interim]: re-price CrossDomainSpend from free to one in-domain ratify —
    // the multi-class winner must show >= minAttrCorroboration in-domain co-asserter(s) on
    // THIS disputed value (the engine's #deriveAgreementSet size), not merely a globally
    // high reputation earned on throwaway facts elsewhere. EVADABLE by one throwaway
    // in-domain corroboration (the structural closure is M1 — per-(source, attribute-domain)
    // reputation scoping, a COMMITTED FOLLOW-ON, NOT V2). Ordered AFTER the F4a structural
    // floor, so this interim policy can only ADD deferrals, never relax the structural gate.
    if (attrCorroborationCountOf(top.strandId) < policy.minAttrCorroboration) {
      return deferPending();
    }

    // M4 [STRUCTURAL, BATCH 4] — DEPTH-MARGIN gate. A multi-class auto-resolve winner's
    // agreement DEPTH must STRICTLY exceed the runner-up's by `depthMargin`. `d` is the
    // SAME `#R` agreement-root basis F4a reads (no third agreement notion — reuse
    // `agreementRootCountOf` for BOTH top and runner-up). This caps the gate so a SHALLOW
    // challenger cannot overturn a DEEP incumbent on reputation magnitude alone; it reads
    // `independentRootCount` ONLY (no magnitude/age/arrival incumbency term, which would
    // re-create the first-arrival trap). It can only ADD deferrals (integrity-additive).
    //
    // GATED on a REAL engine-supplied `#R`: on the pure module's default sentinel (which
    // returns the same constant for every strand) `dWin − dRun = 0 < depthMargin` would
    // spuriously DEFER, so M4 is skipped when that sentinel is in force — exactly as F4a
    // is meaningful only with the real per-value `#R` from the multi-class engine path.
    if (agreementRootCountOf !== DEFAULT_AGREEMENT_ROOT_COUNT_OF) {
      // The runner-up is the strongest-ranked member asserting a DIFFERENT value than
      // the winner — the competing CLAIM, NOT an agreeing co-asserter (a same-value
      // corroborator shares the winner's depth and is not a challenger). The multi-class
      // branch is only reached with >= 2 distinct claims, so a differing member exists.
      const topFp = payloadFingerprint(byId.get(top.strandId)!);
      const runnerUp = ranked.find((ms) => payloadFingerprint(byId.get(ms.strandId)!) !== topFp);
      if (runnerUp !== undefined) {
        const dWin = agreementRootCountOf(top.strandId);
        const dRun = agreementRootCountOf(runnerUp.strandId);
        if (dWin < dRun + policy.depthMargin) {
          return deferPending();
        }
      }
    }

    // DECISIVE-OR-DEFER (on the LCB readout): auto-resolve only if BOTH gates pass —
    //  (a) a clear EARNED LCB gap top-vs-second (>= decisiveMargin), AND
    //  (b) the winner itself holds genuinely-earned trust (>= minWinnerReputation).
    // A weightless flood (all LCB ~0) fails (b); two comparable high-rep independents
    // fail (a). Either failure DEFERS to the human (a genuine tie).
    const decisiveGap = top.reputation - second.reputation >= policy.decisiveMargin;
    const earnedWinner = top.reputation >= policy.minWinnerReputation;
    if (decisiveGap && earnedWinner) {
      // HIGH-IMPACT GATE: for an irreversible decision the decisive LCB margin is
      // necessary but NOT sufficient — the winner must also clear count + recency +
      // >= 2 disjoint anchor classes, else DEFER no matter the gap.
      if (highImpact !== undefined && !clearsHighImpactGate(top.strandId, now, policy, highImpact)) {
        return deferPending();
      }
      // The winner is ranked[0] of a reputation-DESC sort, so no inversion is possible
      // and headcount is never consulted. Run the IDENTICAL winner/demote loop.
      const winner = byId.get(top.strandId)!;
      const demotions = resolveByDemotingLosers(winner, memberStrands, mintEdgeId);
      // An all-echo set demotes nothing — that is a NOOP, not a vacuous RESOLVED.
      if (demotions.length === 0) return { kind: "NOOP" };
      return { kind: "RESOLVED", demotions };
    }

    // Not decisive: DEFER. The ranked order surfaces the most-credible claims at the
    // top of the reviewer's queue but DECIDES NOTHING — the human adjudicates.
    return deferPending();
  }

  // --- SAFE CASE (single independence class): resolve by EXTERNAL SIGNAL ONLY -
  // Choose the single strongest backer (reputation -> anchor_cost -> stake -> id).
  // NEVER headcount: multiplicity of any claim contributes nothing to selection.
  const winnerStrength = ranked[0]!;
  const winner = byId.get(winnerStrength.strandId)!;

  // HIGH-IMPACT GATE applies to the safe case too: even a same-class resolution of an
  // IRREVERSIBLE decision may not clear on the LCB readout alone — the winner must
  // have earned corroboration, be recency-clean, and span >= 2 disjoint anchor
  // classes, else DEFER to a human.
  if (highImpact !== undefined && !clearsHighImpactGate(winnerStrength.strandId, now, policy, highImpact)) {
    return deferPending();
  }

  // Each member making a DIFFERENT claim than the winner is a loser; members
  // echoing the winner's exact claim are not demoted (same claim, nothing to do).
  const demotions = resolveByDemotingLosers(winner, memberStrands, mintEdgeId);

  // If every other member merely echoed the winner's claim, there is nothing to
  // demote — that is a NOOP, not a vacuous RESOLVED.
  if (demotions.length === 0) return { kind: "NOOP" };
  return { kind: "RESOLVED", demotions };
}
