/**
 * forgetting/tiers.ts — Tier movement HOT -> WARM -> COLD -> ARCHIVE.
 *
 * Implements CLAUDE.md's "Resolved floor: forgetting". The single load-bearing
 * idea here is a SPLIT:
 *
 *   - **Decay sets PRESSURE.** A cheap, monotone, self-computable score
 *     ({@link decayPressure}) says how *eager* the system is to move a strand
 *     downward. This is just salience/recency arithmetic; the web is allowed to
 *     compute it about itself.
 *
 *   - **Gates set PERMISSION.** Pressure alone may move a strand down the warm
 *     tiers, but crossing BELOW COLD (the irreversible-ish step toward the
 *     immortal ARCHIVE stub) requires passing EVERY one of a fixed set of gates
 *     ({@link EvictionGate}). Several of those gates depend on quantities the web
 *     CANNOT witness about itself (independent-source count, provenance
 *     independence) and are therefore READ FROM the Source-Identity {@link
 *     IdentityStamp}, never self-derived (CLAUDE.md "the two quantities the web
 *     cannot compute about itself ... are read from this stamp instead").
 *
 * Hard invariants preserved from the design:
 *   - Forgetting is DOWNWARD MOVEMENT, never deletion. The archive stub
 *     (content hash + independent roots + timestamps) is immortal.
 *   - NEVER delete (and, here, never evict below COLD) while any provenance edge
 *     points at the strand — handled by the caller's store, and additionally
 *     guarded here via the gate result so the decision is auditable.
 *   - New OBSERVED strands are pinned WARM during an un-forgeable grace window
 *     (PAST_GRACE_FLOOR gate).
 *   - Every move stamps a {@link ReasonCode} (CLAUDE.md: "reason_code stamped on
 *     every stop/tier-move"). The caller writes `Strand.last_tier_reason`.
 *
 * The multi-gate eviction body is the HARD CORE of this module and is fully
 * implemented ({@link evaluateEviction} → {@link evaluateGates}, the fail-closed
 * anti-poisoning floor). The gate RESULT TYPES, the enumerated conditions, the
 * simple decay-pressure score, and tier-stepping are all implemented and tested.
 *
 * Depends on:
 *   - core/types.ts  (Strand, Tier, EpochMs, IdentityStamp, ReasonCode, ...)
 *   - store/StrandStore.ts  (the caller resolves neighbors/edges from the store
 *     and passes them in as {@link NeighborView}; this module does no I/O).
 */

import {
  type Strand,
  type EpochMs,
  type IdentityStamp,
  type StrandId,
  type Unit,
  type ProvenanceRoot,
  Tier,
  ReasonCode,
  FactState,
  FactOrigin,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Neighbor view (the slice of the graph the gates need, resolved by the caller)
// ---------------------------------------------------------------------------

/**
 * A read-only projection of one neighbor of the strand under evaluation, as
 * resolved from the {@link import("../store/StrandStore.js")} by the caller.
 *
 * The eviction gates compare a strand against its INDEPENDENT neighbors only
 * (echoes from the same root corroborate nothing — CLAUDE.md). To let the gate
 * decide independence WITHOUT the web witnessing its own identity, the caller
 * supplies, per neighbor, the neighbor's provenance roots; independence is then
 * judged across independence-classes, and the per-source independence weights are
 * taken from the identity stamp — never invented here.
 */
export interface NeighborView {
  readonly id: StrandId;
  /** The neighbor's fact state — a DEMOTED neighbor is not a live witness. */
  readonly fact_state: FactState;
  /** Observed vs derived — only OBSERVED neighbors can witness independence. */
  readonly origin: FactOrigin;
  /** The neighbor's provenance roots (carry independence-class ids). */
  readonly provenance: readonly ProvenanceRoot[];
  /**
   * Echo-discounted unique value this neighbor already covers, in description
   * bits (CLAUDE.md `description_value`). Used to compute how much UNIQUE value
   * the strand under evaluation adds over its independent neighbors.
   */
  readonly description_value: number;
  /**
   * True iff a CONFIRMED edge between this neighbor and the strand under
   * evaluation is a CROSS_WEB_BRIDGE — relevant to the NOT_EARNED_BRIDGE gate.
   */
  readonly bridgesToSubject: boolean;
}

// ---------------------------------------------------------------------------
// Eviction evidence (caller-resolved, identity-layer-sourced — never self-computed)
// ---------------------------------------------------------------------------

/**
 * The caller-resolved evidence bundle a BELOW-COLD eviction decision needs but
 * forgetting must NOT compute about itself (CLAUDE.md §"the two quantities the
 * web cannot compute about itself ... are read from this stamp instead").
 *
 * Forgetting is a PURE function of (strand, neighbors, evidence): it performs no
 * store/identity I/O. The layer-aware orchestrator resolves each field and passes
 * it in, exactly as it already resolves {@link NeighborView}s. Every field is the
 * canonical `null` sentinel when the caller could not resolve it — and a null
 * field always makes the relevant gate FAIL (the strand is KEPT). An attacker
 * must never be able to archive a true strand by WITHHOLDING or STALING evidence.
 */
export interface EvictionEvidence {
  /**
   * The Source-Identity stamp for this strand's source, or `null` for
   * anonymous / bare-key input. A null stamp cannot satisfy
   * {@link EvictionGate.FRESH_INDEPENDENCE_STAMP} ⇒ that gate fails (kept).
   */
  readonly stamp: IdentityStamp | null;
  /**
   * The temporally-discounted INDEPENDENT-source count, READ FROM the identity
   * layer (`SourceIdentityLayer.independentRootCount(strand.provenance)`), NEVER
   * self-computed inside forgetting. `null` ⇒ unknown/unavailable ⇒
   * {@link EvictionGate.INDEP_SOURCE_COUNT_LE_1} fails (kept). A corroborated
   * strand (count >= 2) also fails this gate (kept).
   */
  readonly independentSourceCount: number | null;
  /**
   * The WINNER's fact_state, resolved by the caller by following this strand's
   * OUTRANKS edge (`strand.outranked_by`) to the winning strand. `null` ⇒ this
   * strand is not outranked OR the winner could not be resolved. When
   * `strand.outranked_by` is set but this is `null`, the winner is unknown ⇒
   * {@link EvictionGate.NOT_OUTRANKED_SIDE} fails (kept, fail-closed).
   */
  readonly outrankerState: FactState | null;
}

// ---------------------------------------------------------------------------
// Eviction gate enumeration (the fixed AND-conditions to go below COLD)
// ---------------------------------------------------------------------------

/**
 * The complete, fixed set of permission conditions. To move a strand BELOW COLD
 * (toward ARCHIVE), ALL gates must PASS. {@link EvictionDecision.failedGates}
 * lists exactly the gates that did NOT pass, so the decision is fully auditable.
 *
 * The order mirrors CLAUDE.md's clause list:
 *   "Eviction below COLD requires ALL of: low echo-discounted unique value vs
 *    independent neighbors; fresh independence stamp; not the outranked side of
 *    an active contradiction; not an earned bridge; temporally-discounted
 *    independent-source count <= 1; past a grace floor."
 */
export enum EvictionGate {
  /**
   * The strand's echo-discounted UNIQUE value versus its INDEPENDENT neighbors
   * is low — i.e. dropping it loses little reconstructable information. PASS ⇒
   * the strand is informationally redundant and may be let go.
   */
  LOW_UNIQUE_VALUE = "LOW_UNIQUE_VALUE",
  /**
   * The independence stamp is FRESH (the layer's view of this source's
   * independence is current, not stale). A stale stamp must not authorize
   * forgetting, because independence may have changed. PASS ⇒ stamp is recent.
   */
  FRESH_INDEPENDENCE_STAMP = "FRESH_INDEPENDENCE_STAMP",
  /**
   * The strand is NOT the outranked (losing) side of an ACTIVE contradiction.
   * The losing side of a live dispute is retained as visible history and must
   * not be evicted while the dispute is live. PASS ⇒ not an active loser.
   */
  NOT_OUTRANKED_SIDE = "NOT_OUTRANKED_SIDE",
  /**
   * The strand is NOT an EARNED cross-web bridge
   * ({@link BridgeAccounting.earned_bridge_value} > 0). Earned bridges are the
   * rare threads that make distant memory relevant and are protected. PASS ⇒
   * not an earned bridge.
   */
  NOT_EARNED_BRIDGE = "NOT_EARNED_BRIDGE",
  /**
   * The TEMPORALLY-DISCOUNTED INDEPENDENT-source count is <= 1, READ FROM the
   * {@link IdentityStamp} (NOT self-computed by the web). With <= 1 truly
   * independent source the strand is uncorroborated and eligible. PASS ⇒
   * independent-source count <= 1.
   */
  INDEP_SOURCE_COUNT_LE_1 = "INDEP_SOURCE_COUNT_LE_1",
  /**
   * The strand is PAST its grace floor
   * (`Strand.observedAt + GRACE_WINDOW_MS < now`). Freshly observed strands are
   * pinned WARM during an un-forgeable grace window. PASS ⇒ grace has elapsed.
   */
  PAST_GRACE_FLOOR = "PAST_GRACE_FLOOR",
}

/** Every gate, in canonical order — iterate this to evaluate/report all gates. */
export const ALL_EVICTION_GATES: readonly EvictionGate[] = [
  EvictionGate.LOW_UNIQUE_VALUE,
  EvictionGate.FRESH_INDEPENDENCE_STAMP,
  EvictionGate.NOT_OUTRANKED_SIDE,
  EvictionGate.NOT_EARNED_BRIDGE,
  EvictionGate.INDEP_SOURCE_COUNT_LE_1,
  EvictionGate.PAST_GRACE_FLOOR,
];

// ---------------------------------------------------------------------------
// Eviction decision result type
// ---------------------------------------------------------------------------

/**
 * The full, auditable outcome of an eviction evaluation.
 *
 * `allowed` is `true` only when the strand may move to `toTier`. When moving
 * BELOW COLD, `allowed` is true iff `failedGates` is empty. For purely
 * pressure-driven moves within the warm tiers (HOT/WARM/COLD), the gates do not
 * apply and `failedGates` is empty.
 */
export interface EvictionDecision {
  /** Whether the move to `toTier` is permitted. */
  readonly allowed: boolean;
  /** The tier the strand should occupy after this decision (>= current; never up). */
  readonly toTier: Tier;
  /** The reason stamped on the move (or the reason the move was blocked). */
  readonly reason: ReasonCode;
  /** Exactly the gates that did NOT pass; empty when `allowed` is true. */
  readonly failedGates: readonly EvictionGate[];
}

// ---------------------------------------------------------------------------
// Tunable forgetting constants
// ---------------------------------------------------------------------------

/**
 * Forgetting tunables. Like the anchor-cost table, these are product/policy
 * knobs, not laws. Defaults are conservative (slow to forget).
 */
export interface ForgettingConfig {
  /** Un-forgeable grace window for freshly OBSERVED strands, in ms. */
  readonly graceWindowMs: number;
  /** Below this echo-discounted unique value, LOW_UNIQUE_VALUE passes (in bits). */
  readonly uniqueValueFloorBits: number;
  /** Max age (ms) of the identity stamp for FRESH_INDEPENDENCE_STAMP to pass. */
  readonly stampFreshnessMs: number;
  /** Pressure at/above which a strand is eligible to step one tier down. */
  readonly pressureToStepDown: number;
  /** Salience half-life proxy used by decayPressure (ms); larger = slower decay. */
  readonly salienceHalfLifeMs: number;
}

/** Default forgetting configuration. Grounded in CLAUDE.md's "slow to forget" stance. */
export const DEFAULT_FORGETTING_CONFIG: ForgettingConfig = {
  graceWindowMs: 7 * 24 * 60 * 60 * 1000, // one week un-forgeable grace
  uniqueValueFloorBits: 1.0,
  stampFreshnessMs: 30 * 24 * 60 * 60 * 1000, // stamp considered stale after ~30 days
  pressureToStepDown: 0.75,
  salienceHalfLifeMs: 14 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// nextTierDown — pure tier stepping
// ---------------------------------------------------------------------------

/**
 * One step downward in the tier lattice, per CLAUDE.md's required mapping:
 *
 *   HOT -> WARM, WARM -> COLD, COLD -> ARCHIVE, ARCHIVE -> ARCHIVE.
 *
 * (The prompt's "HOT->WARM->WARM->COLD->COLD->ARCHIVE->ARCHIVE" describes the
 * stickiness of repeated calls: WARM and COLD each absorb pressure before
 * yielding the next step; ARCHIVE is a fixed point — the immortal stub, never
 * stepped past, because forgetting is movement, never deletion.)
 *
 * Pure and total. Never returns a tier ABOVE the input (forgetting is one-way).
 */
export function nextTierDown(t: Tier): Tier {
  switch (t) {
    case Tier.HOT:
      return Tier.WARM;
    case Tier.WARM:
      return Tier.COLD;
    case Tier.COLD:
      return Tier.ARCHIVE;
    case Tier.ARCHIVE:
      return Tier.ARCHIVE; // fixed point: the immortal stub
    default: {
      // Exhaustiveness guard — if Tier gains a variant, this fails to compile.
      const _never: never = t;
      return _never;
    }
  }
}

// ---------------------------------------------------------------------------
// decayPressure — SIMPLE, fully implemented (decay sets PRESSURE)
// ---------------------------------------------------------------------------

/**
 * Compute the downward-tier PRESSURE on a strand in [0, 1]. This is the cheap,
 * self-computable half of the split: pressure says how eager the system is to
 * move a strand down; it confers NO permission to cross below COLD (that is the
 * gates' job).
 *
 * Pressure rises with staleness and falls with keep-signals the web is allowed
 * to read about itself:
 *   - time since last real retrieval (`salience.last_fire_time`), exponentially
 *     discounted by a half-life proxy → the dominant term;
 *   - inverse of real `fire_count` (frequently-retrieved strands resist);
 *   - inverse of `external_reobservation_count` (re-observed strands resist —
 *     CLAUDE.md: external re-observation raises keep-pressure);
 *   - the strand's own `salience.s` and decay rate λ.
 *
 * Pinning: a strand still inside its un-forgeable grace window contributes ZERO
 * pressure (it cannot be moved by pressure alone), so freshly observed strands
 * stay pinned WARM. DEMOTED strands accrue pressure normally (they are history,
 * but history may still cool), while still being protected from BELOW-COLD
 * eviction by the contradiction/bridge/independence gates downstream.
 *
 * Pure and total; clamped to [0, 1]. Monotone non-decreasing in elapsed idle
 * time, mirroring the activation walk's monotonicity discipline.
 *
 * @param strand the strand to score
 * @param now    current logical time
 * @param cfg    forgetting tunables (defaults to {@link DEFAULT_FORGETTING_CONFIG})
 * @returns pressure in [0, 1]; 0 while grace-pinned
 */
export function decayPressure(
  strand: Strand,
  now: EpochMs,
  cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG,
): number {
  // Grace pin: freshly OBSERVED strands exert no pressure until grace elapses.
  if (
    strand.origin === FactOrigin.OBSERVED &&
    !isPastGraceFloor(strand, now, cfg)
  ) {
    return 0;
  }

  const sal = strand.salience;

  // Idle time since the last REAL retrieval (never speculative pops).
  const idleMs = Math.max(0, (now as number) - (sal.last_fire_time as number));

  // Exponential staleness in [0, 1): 0 when just fired, → 1 as idle grows.
  // Half-life proxy: at idleMs == salienceHalfLifeMs, staleness ≈ 0.5.
  const halfLife = Math.max(1, cfg.salienceHalfLifeMs);
  const staleness = 1 - Math.pow(2, -(idleMs / halfLife));

  // Salience decay multiplier from the strand's own λ over the idle window:
  // a high-λ strand cools faster, raising effective staleness.
  const lambdaBoost = 1 - Math.exp(-Math.max(0, sal.lambda) * (idleMs / halfLife));

  // Keep-signals the web may read about itself: real retrievals and external
  // re-observations both resist forgetting. Diminishing returns via 1/(1+n).
  const retrievalResist = 1 / (1 + Math.max(0, sal.fire_count));
  const reobserveResist = 1 / (1 + Math.max(0, strand.external_reobservation_count));

  // Raw salience also resists: a high-s strand is "loud" and clings on.
  const salienceResist = 1 / (1 + Math.max(0, sal.s));

  // Blend: staleness dominates; the three resist terms pull pressure back down.
  // Weights are illustrative policy, summing to 1 across the resist terms.
  const resist =
    0.5 * retrievalResist + 0.3 * reobserveResist + 0.2 * salienceResist;

  // staleness (pushes up) tempered by resist (pushes down), nudged by lambdaBoost.
  const raw = staleness * (0.5 + 0.5 * lambdaBoost) * resist;

  return clampUnit(raw);
}

// ---------------------------------------------------------------------------
// evaluateEviction — HARD CORE (gates set PERMISSION). Marked crack.
// ---------------------------------------------------------------------------

/**
 * Decide whether and where a strand may move down a tier.
 *
 * Two regimes:
 *
 *  1. **Pressure-driven move within the warm tiers (HOT/WARM/COLD).** If the
 *     strand is above COLD and its {@link decayPressure} clears
 *     `cfg.pressureToStepDown`, it may step one tier down with reason
 *     {@link ReasonCode.NOVELTY_EXHAUSTED}. No gates apply; `failedGates` empty.
 *     (Grace-pinned strands have pressure 0 and therefore never move here.)
 *
 *  2. **BELOW-COLD eviction (COLD -> ARCHIVE).** This is irreversible-ish (next
 *     stop is the immortal stub) and requires ALL {@link EvictionGate}s to pass.
 *     Any failed gate blocks the move and is listed in `failedGates`. Eviction
 *     is also ABSOLUTELY forbidden while any provenance edge points at the
 *     strand — checked by the caller's store before calling, and reflected here
 *     so the decision stays auditable.
 *
 * Every returned decision carries a stamped {@link ReasonCode}; the caller
 * writes it to `Strand.last_tier_reason` when it applies the move.
 *
 * The per-gate evaluation body is the HARD ALGORITHMIC CORE of forgetting and is
 * NOT implemented here — see {@link evaluateGates}. This wrapper IS implemented:
 * it handles tier selection, the grace pin, the pressure path, and assembling
 * the decision from the gate results.
 *
 * @param strand    the strand under consideration
 * @param neighbors its INDEPENDENT-candidate neighbors, resolved from the store
 * @param evidence  the caller-resolved {@link EvictionEvidence} bundle: the
 *                  Source-Identity stamp, the identity-layer independent-source
 *                  count, and the OUTRANKS winner's fact_state. Forgetting never
 *                  computes these about itself; any null field FAILS its gate so
 *                  withholding/staling evidence only ever KEEPS the strand.
 * @param now       current logical time
 * @param cfg       forgetting tunables
 * @returns a fully-populated {@link EvictionDecision}
 */
export function evaluateEviction(
  strand: Strand,
  neighbors: readonly NeighborView[],
  evidence: EvictionEvidence,
  now: EpochMs,
  cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG,
): EvictionDecision {
  const current = strand.tier;

  // ARCHIVE is the immortal fixed point — nothing moves past it, ever.
  if (current === Tier.ARCHIVE) {
    return {
      allowed: false,
      toTier: Tier.ARCHIVE,
      reason: ReasonCode.CONVERGED,
      failedGates: [],
    };
  }

  const pressure = decayPressure(strand, now, cfg);

  // --- Regime 1: pressure-driven step within the warm tiers (above COLD). ---
  if (current === Tier.HOT || current === Tier.WARM) {
    if (pressure >= cfg.pressureToStepDown) {
      return {
        allowed: true,
        toTier: nextTierDown(current),
        reason: ReasonCode.NOVELTY_EXHAUSTED,
        failedGates: [],
      };
    }
    // Not enough pressure to move yet: stay put.
    return {
      allowed: false,
      toTier: current,
      reason: ReasonCode.CONVERGED,
      failedGates: [],
    };
  }

  // --- Regime 2: BELOW-COLD eviction (current === Tier.COLD). ---
  // Requires ALL gates to pass. Pressure must also be present, but gates govern.
  const failedGates = evaluateGates(strand, neighbors, evidence, now, cfg);
  const allowed = failedGates.length === 0 && pressure >= cfg.pressureToStepDown;

  return {
    allowed,
    toTier: allowed ? nextTierDown(current) : current,
    // CONVERGED when permitted (the strand has informationally converged into
    // its independent neighbors); TRUNCATED-adjacent blocks reuse NOVELTY_*.
    reason: allowed ? ReasonCode.CONVERGED : ReasonCode.NOVELTY_EXHAUSTED,
    failedGates,
  };
}

/**
 * Evaluate every {@link EvictionGate} for a BELOW-COLD eviction and return the
 * gates that did NOT pass (empty ⇒ eviction permitted by the gate layer).
 *
 * THIS IS THE ANTI-POISONING FLOOR — every gate is adversary-facing (CLAUDE.md
 * "treat every prune rule as adversary-facing") and FAILS CLOSED: a gate passes
 * ONLY on present, fresh, trustworthy evidence; any missing/null/stale/uncertain
 * input makes the gate FAIL so the strand is KEPT. An attacker must never archive
 * a true strand by WITHHOLDING or STALING evidence — when in doubt, keep.
 *
 *   - LOW_UNIQUE_VALUE: the strand's echo-discounted UNIQUE reconstruction value
 *     vs its INDEPENDENT neighbors is below `cfg.uniqueValueFloorBits`.
 *     "Independent neighbor" = OBSERVED + LIVE + independence-class set DISJOINT
 *     from the strand's own classes. Neighbors that share an independence-class
 *     WITH EACH OTHER collapse to multiplicity 1 (echo-discount) before their
 *     coverage is summed. No qualifying neighbor ⇒ full unique value ⇒ FAIL.
 *   - FRESH_INDEPENDENCE_STAMP: stamp non-null AND the freshest provenance root's
 *     `establishedAt` is within `cfg.stampFreshnessMs` of `now` (the stamp itself
 *     carries no timestamp, so freshness is derived from provenance).
 *   - NOT_OUTRANKED_SIDE: if `strand.outranked_by` is set, FAIL iff the WINNER is
 *     still LIVE (active dispute ⇒ losing side retained as live history) or the
 *     winner's state is unknown; PASS if not outranked, or the winner resolved to
 *     a non-LIVE state.
 *   - NOT_EARNED_BRIDGE: fail if `strand.bridge.earned_bridge_value > 0`.
 *   - INDEP_SOURCE_COUNT_LE_1: the identity-layer count (READ FROM the layer and
 *     passed in via {@link EvictionEvidence.independentSourceCount}, NEVER
 *     self-computed) is finite AND <= 1. >= 2 (corroborated) or null ⇒ FAIL.
 *   - PAST_GRACE_FLOOR: delegate to {@link isPastGraceFloor}.
 *
 * @returns the list of FAILED gates (canonical order); empty ⇒ all passed
 */
function evaluateGates(
  strand: Strand,
  neighbors: readonly NeighborView[],
  evidence: EvictionEvidence,
  now: EpochMs,
  cfg: ForgettingConfig,
): readonly EvictionGate[] {
  const failed: EvictionGate[] = [];

  // --- LOW_UNIQUE_VALUE -----------------------------------------------------
  // PASS iff the echo-discounted unique reconstruction value the strand adds
  // over its INDEPENDENT neighbors is below the floor. Fail-closed: any neighbor
  // that cannot be affirmatively confirmed as an independent live witness is
  // DROPPED from coverage (withholding/staling a neighbor only RAISES uniqueBits,
  // making the gate more likely to FAIL ⇒ keep).
  if (!lowUniqueValuePasses(strand, neighbors, cfg)) {
    failed.push(EvictionGate.LOW_UNIQUE_VALUE);
  }

  // --- FRESH_INDEPENDENCE_STAMP ---------------------------------------------
  // PASS iff stamp non-null AND the freshest provenance root is within the
  // freshness window. Null stamp / no provenance / stale ⇒ FAIL (kept).
  if (!freshIndependenceStampPasses(strand, evidence.stamp, now, cfg)) {
    failed.push(EvictionGate.FRESH_INDEPENDENCE_STAMP);
  }

  // --- NOT_OUTRANKED_SIDE ---------------------------------------------------
  // Not outranked at all ⇒ PASS. Otherwise FAIL CLOSED via an ALLOWLIST: the
  // gate passes ONLY when the winner is affirmatively resolved to a SETTLED,
  // no-longer-active state (the winner itself was later DEMOTED, or archived to
  // COLD), meaning the contradiction against this strand is no longer live.
  // Every other winner state is an ACTIVE or UNCERTAIN dispute and KEEPS the
  // losing side as live history:
  //   - LIVE        → active dispute (winner standing) ⇒ FAIL.
  //   - PROVISIONAL → unresolved superposition, not yet ratified ⇒ FAIL.
  //   - null        → winner unknown / unresolved by the caller ⇒ FAIL.
  // A denylist (fail only on LIVE) would fail OPEN for PROVISIONAL/unknown, so
  // an allowlist is required to honor "when in doubt, keep".
  if (strand.outranked_by !== null) {
    const winnerSettled =
      evidence.outrankerState === FactState.DEMOTED ||
      evidence.outrankerState === FactState.COLD;
    if (!winnerSettled) {
      failed.push(EvictionGate.NOT_OUTRANKED_SIDE);
    }
  }

  // --- NOT_EARNED_BRIDGE — single field read (unchanged) --------------------
  if (strand.bridge.earned_bridge_value > 0) {
    failed.push(EvictionGate.NOT_EARNED_BRIDGE);
  }

  // --- INDEP_SOURCE_COUNT_LE_1 ----------------------------------------------
  // The count is READ FROM the identity layer and passed in — NEVER computed
  // here. null/non-finite (unknown) ⇒ FAIL; >= 2 (corroborated) ⇒ FAIL (kept).
  const c = evidence.independentSourceCount;
  if (c === null || !Number.isFinite(c) || c > 1) {
    failed.push(EvictionGate.INDEP_SOURCE_COUNT_LE_1);
  }

  // --- PAST_GRACE_FLOOR — time-only (unchanged) -----------------------------
  if (!isPastGraceFloor(strand, now, cfg)) {
    failed.push(EvictionGate.PAST_GRACE_FLOOR);
  }

  // Keep canonical order for stable, auditable output.
  return ALL_EVICTION_GATES.filter((g) => failed.includes(g));
}

// ---------------------------------------------------------------------------
// Gate predicate helpers (pure; no store/identity I/O — evidence is passed in)
// ---------------------------------------------------------------------------

/**
 * LOW_UNIQUE_VALUE predicate. Returns true iff the strand's echo-discounted
 * UNIQUE reconstruction value over its INDEPENDENT neighbors is strictly below
 * `cfg.uniqueValueFloorBits`.
 *
 * A neighbor qualifies as an INDEPENDENT WITNESS iff it is OBSERVED and LIVE and
 * its independence-class set is DISJOINT from the strand's own classes (a strand
 * cannot be corroborated by an echo of its own roots, and a DEMOTED/DERIVED
 * neighbor is not a live witness). Surviving neighbors are then ECHO-DISCOUNTED:
 * neighbors sharing an independence-class WITH EACH OTHER collapse to multiplicity
 * 1 — per class-group we keep the single highest-`description_value` representative
 * — before summing coverage. `coverage` is capped at `strand.description_value`,
 * and `uniqueBits = max(0, description_value - coverage)`, clamped so malformed
 * (negative) values can't underflow into a spurious PASS.
 *
 * NOTE (fail-closed corner): if the strand itself has no provenance, its class set
 * is empty and every neighbor is trivially "disjoint"; coverage only ever REDUCES
 * uniqueBits, and such a strand is already KEPT by the freshness + count gates, so
 * this is documented rather than special-cased.
 */
function lowUniqueValuePasses(
  strand: Strand,
  neighbors: readonly NeighborView[],
  cfg: ForgettingConfig,
): boolean {
  const strandClasses = new Set<string>(
    strand.provenance.map((p) => p.independenceClass as string),
  );

  // Qualify: OBSERVED + LIVE + has provenance + class-disjoint from the strand's
  // own classes. A neighbor with NO provenance is, by the governing invariant
  // ("no provenance → no voice"), never a witness — it must not be able to
  // launder coverage (an attacker could otherwise plant a provenance-less,
  // huge-description_value neighbor that vacuously "disjoint"-qualifies and fully
  // covers a genuinely unique strand, forcing its eviction). Requiring at least
  // one independence class is strictly more conservative (it only ever RAISES
  // uniqueBits ⇒ keeps), so it stays fail-closed.
  const qualifying = neighbors.filter((n) => {
    if (n.origin !== FactOrigin.OBSERVED) return false;
    if (n.fact_state !== FactState.LIVE) return false;
    if (n.provenance.length === 0) return false;
    for (const p of n.provenance) {
      if (strandClasses.has(p.independenceClass as string)) return false;
    }
    return true;
  });

  // Echo-discount: collapse neighbors that share an independence-class WITH EACH
  // OTHER to multiplicity 1. Group by each neighbor's class signature and keep
  // the single highest-description_value representative per class-group.
  const repByClass = new Map<string, number>();
  for (const n of qualifying) {
    // A neighbor with multiple classes is keyed by every class it carries so it
    // collapses against any other neighbor sharing ANY of them.
    const sig = n.provenance.map((p) => p.independenceClass as string);
    const keys = sig.length > 0 ? sig : [""]; // no-provenance neighbor: one bucket
    for (const k of keys) {
      const prev = repByClass.get(k);
      if (prev === undefined || n.description_value > prev) {
        repByClass.set(k, n.description_value);
      }
    }
  }

  let coverage = 0;
  for (const v of repByClass.values()) coverage += Math.max(0, v);

  const dv = strand.description_value;
  coverage = Math.min(coverage, Math.max(0, dv));
  const uniqueBits = Math.max(0, dv - coverage);

  return uniqueBits < cfg.uniqueValueFloorBits;
}

/**
 * FRESH_INDEPENDENCE_STAMP predicate. Returns true iff the stamp is non-null AND
 * the strand has provenance AND the FRESHEST provenance root's `establishedAt` is
 * within `cfg.stampFreshnessMs` of `now`. {@link IdentityStamp} carries no
 * timestamp, so freshness is derived from provenance establishment time. Null
 * stamp / empty provenance / stale ⇒ false (kept).
 */
function freshIndependenceStampPasses(
  strand: Strand,
  stamp: IdentityStamp | null,
  now: EpochMs,
  cfg: ForgettingConfig,
): boolean {
  if (stamp === null) return false;
  if (strand.provenance.length === 0) return false;

  let freshest = -Infinity;
  for (const root of strand.provenance) {
    const at = root.establishedAt as number;
    if (at > freshest) freshest = at;
  }
  if (!Number.isFinite(freshest)) return false;

  const age = (now as number) - freshest;
  return age <= cfg.stampFreshnessMs;
}

// ---------------------------------------------------------------------------
// Small fully-implemented helpers
// ---------------------------------------------------------------------------

/**
 * True iff the strand is PAST its un-forgeable grace window. DERIVED strands
 * have no observation grace (they were never observed from outside), so only the
 * grace floor of OBSERVED strands binds; here we apply the floor uniformly off
 * `observedAt`, which a DERIVED strand sets to its derivation time.
 *
 * Pure and total. (Simple, fully implemented — used by both the decay pin and
 * the PAST_GRACE_FLOOR gate.)
 */
export function isPastGraceFloor(
  strand: Strand,
  now: EpochMs,
  cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG,
): boolean {
  const floor = (strand.observedAt as number) + cfg.graceWindowMs;
  return (now as number) > floor;
}

/** Clamp a number into the [0, 1] {@link Unit} range. Pure, total. */
function clampUnit(x: number): Unit {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
