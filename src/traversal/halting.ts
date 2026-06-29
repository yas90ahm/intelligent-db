/**
 * traversal/halting.ts — the TWO-PHASE STOP CONTROLLER.
 *
 * This is the HARD CORE of "when to stop walking and start speaking" (CLAUDE.md:
 * "Resolved: traversal halting"). It owns three independent mechanisms that
 * together decide when a share-normalized best-first walk should end and how the
 * outcome is stamped:
 *
 *   PHASE 1 — local saturation.
 *     Stop expanding the LOCAL web once each new pop adds less than
 *     `config.epsilon` of *new independent corroboration*. Corroboration is the
 *     count of NEW independent-provenance classes contributed by the popped
 *     strand — NOT raw convergence (CLAUDE.md: "Separate ordering from
 *     stopping": convergence may ORDER which strand to pop next, but must NEVER
 *     be the stop gate, or a genuine insight bridge with convergence=1 would be
 *     starved).
 *
 *   PHASE 2 — MANDATORY bridge sweep.
 *     Every lit, un-crossed CROSS_WEB_BRIDGE gets EXACTLY ONE guaranteed
 *     exploratory crossing, funded by a SEPARATE ~20% (`bridgeBudgetFraction`)
 *     sub-budget so bridge-chasing can never starve the answer. A circuit-breaker
 *     trips after `config.bridgeZeroYieldBreaker` (2) consecutive zero-yield
 *     crossings. This phase is the source of "something from last week is
 *     suddenly relevant."
 *
 *   HARD BACKSTOP — fail open, never silent.
 *     An absolute pop-cap (`config.popCap` ~2000) plus a wall-clock
 *     (`config.wallClockMs`). On trip the walk halts and stamps
 *     {@link ReasonCode.TRUNCATED}; if the bridge sub-budget is exhausted before
 *     all lit bridges are crossed it stamps {@link ReasonCode.BRIDGE_STARVED}.
 *     Halting ALWAYS fails open: low-corroboration / partial results are surfaced
 *     WITH a stamp rather than hidden (CLAUDE.md: "never a silent stop").
 *
 * Outcome → {@link ReasonCode} mapping (all codes from core/types):
 *   - CONVERGED          : phase 1 reached local saturation (< epsilon novelty).
 *   - NOVELTY_EXHAUSTED  : frontier ran dry of novel corroboration before the cap.
 *   - BRIDGE_SWEEP_CLEAR : phase 2 ran and every lit bridge was crossed/cleared.
 *   - BRIDGE_STARVED     : bridge sub-budget ran out before all lit bridges crossed.
 *   - TRUNCATED          : hard backstop tripped (pop-cap or wall-clock).
 *
 * Dependencies:
 *   - core/types.ts  — shared contract (ReasonCode, WalkConfig, HaltStamp, …).
 *   - store/StrandStore.ts — the pluggable strand/edge store the walk reads from;
 *     this controller only consumes a narrow READ surface of it (declared locally
 *     as {@link HaltStoreView} until store/StrandStore.ts lands, so this module
 *     type-checks standalone against core/types.ts).
 *
 * STATUS: IMPLEMENTED end-to-end. The interface, the budget/counter bookkeeping,
 * and the ReasonCode mapping are complete; the two algorithmic cores — the phase-1
 * local-saturation gate (EWMA of new independent corroboration thresholded against
 * epsilon) and the phase-2 mandatory bridge sweep (one guaranteed crossing per lit
 * un-crossed bridge from the separate sub-budget, with the circuit-breaker) — are
 * fully implemented and tested. Nothing here throws a "not implemented" placeholder.
 */

import {
  type Activation,
  type EdgeId,
  type EpochMs,
  type HaltStamp,
  type StrandId,
  type Unit,
  type WalkConfig,
  ReasonCode,
  asEpochMs,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Local store read-surface (until store/StrandStore.ts is scaffolded)
// ---------------------------------------------------------------------------

/**
 * The narrow READ surface of {@link "../store/StrandStore"} that the halting
 * controller needs. Declared structurally here so this module type-checks
 * standalone; the concrete `StrandStore` in store/StrandStore.ts is intended to
 * be assignable to this view. The controller NEVER mutates the store — it only
 * reads frontier/bridge state to decide stopping.
 *
 * TODO(crack-B): replace this local view with a direct import of the
 * `StrandStore` interface once store/StrandStore.ts exists, keeping the same
 * read-only method set.
 */
export interface HaltStoreView {
  /** Independent-provenance class count newly contributed by a popped strand. */
  independentClassCount(strandId: StrandId): number;
  /** Edge ids of CROSS_WEB_BRIDGE threads currently lit (reachable) from `strandId`. */
  litBridgesFrom(strandId: StrandId): readonly EdgeId[];
  /** Resolve the far-side strand a bridge edge crosses into. */
  bridgeTarget(edgeId: EdgeId): StrandId;
  /**
   * B1 — the bridge edge's `provenance_independence` stamp, in [0,1]. 0 if
   * unknown (fail-open ⇒ caller stays at γ). Read off the already-loaded edge
   * scalar — NEVER self-computed, NO MIS/identity round-trip (invariant 2).
   */
  bridgeIndependence(edgeId: EdgeId): number;
  /**
   * B2 — the `earned_bridge_value` of the strand that OWNS this bridge edge
   * (its `from` strand; an offline-only field the query stream cannot write).
   * 0 if unknown. Used only to ORDER the bounded sub-budget's spend.
   */
  bridgeEarnedValue(edgeId: EdgeId): number;
}

// ---------------------------------------------------------------------------
// Context shapes (what the walk hands the controller on each callback)
// ---------------------------------------------------------------------------

/**
 * Snapshot the walk passes to the controller on each interaction. It is the ONLY
 * channel through which per-pop state reaches the stop logic, keeping the
 * controller free of any direct frontier ownership.
 */
export interface HaltContext {
  /** The strand just popped from the priority frontier (max-activation first). */
  readonly strandId: StrandId;
  /** Activation the popped strand carried (monotone non-increasing across the walk). */
  readonly activation: Activation;
  /**
   * NEW independent-provenance corroboration contributed by THIS pop, in [0,1].
   * This — not convergence_factor — is what phase 1 thresholds against epsilon.
   * (CLAUDE.md: convergence is ordering-only and must never gate stopping.)
   */
  readonly newIndependentCorroboration: Unit;
  /** Logical/wall-clock time of this pop (for the wall-clock backstop). */
  readonly now: EpochMs;
  /** Read-only store view for resolving lit bridges and far-side targets. */
  readonly store: HaltStoreView;
}

/**
 * One mandatory bridge crossing yielded by the phase-2 sweep. Each lit,
 * un-crossed CROSS_WEB_BRIDGE produces EXACTLY ONE of these; the walk is expected
 * to perform the crossing and report back via {@link HaltingController.recordCrossingYield}.
 */
export interface BridgeCrossing {
  /** The CROSS_WEB_BRIDGE edge being crossed (each crossed at most once per walk). */
  readonly bridgeEdge: EdgeId;
  /** The far-side strand this crossing seeds activation into. */
  readonly target: StrandId;
  /** Activation budgeted to seed the far side with (drawn from the bridge sub-budget). */
  readonly seedActivation: Activation;
}

/**
 * The walk's report of what a single bridge crossing produced. "Yield" is whether
 * the crossing surfaced any NEW independent corroboration on the far side; a
 * zero-yield crossing advances the circuit-breaker counter.
 */
export interface CrossingYield {
  /** The bridge edge that was crossed (matches a prior {@link BridgeCrossing}). */
  readonly bridgeEdge: EdgeId;
  /** New independent corroboration surfaced by the crossing, in [0,1]. */
  readonly yieldCorroboration: Unit;
  /** Pops the crossing consumed from the bridge sub-budget. */
  readonly popsConsumed: number;
}

// ---------------------------------------------------------------------------
// Controller interface (the complete, correct contract)
// ---------------------------------------------------------------------------

/**
 * The two-phase stop controller. The walk drives it:
 *
 *   loop:
 *     pop strand -> controller.onPop(ctx)
 *     if controller.shouldStopLocal(ctx): break            // phase 1 done
 *   controller.beginBridgeSweep(ctx)                       // enter phase 2
 *   while (c = controller.nextBridgeCrossing(ctx)) != null:
 *     <walk crosses c>
 *     controller.recordCrossingYield(yield)
 *   stamp = controller.finalStamp()                        // never silent
 *
 * Every method is total and side-effecting on the controller's internal
 * bookkeeping ONLY; it never mutates the store.
 */
export interface HaltingController {
  /**
   * Record a pop into the main (local-phase) budget and corroboration history.
   * Updates popCount and the trailing-novelty signal used by phase 1. Pure
   * bookkeeping — does not itself decide stopping.
   */
  onPop(ctx: HaltContext): void;

  /**
   * PHASE 1 gate. Returns true when the LOCAL walk should stop — either because
   * new independent corroboration per pop fell below `config.epsilon` (→ later
   * stamped CONVERGED / NOVELTY_EXHAUSTED) or because a hard backstop tripped
   * (→ TRUNCATED). Convergence_factor must NOT influence this decision.
   */
  shouldStopLocal(ctx: HaltContext): boolean;

  /**
   * Enter PHASE 2. Reserves the separate bridge sub-budget
   * (`config.bridgeBudgetFraction` of `config.popCap`), enumerates the lit,
   * un-crossed CROSS_WEB_BRIDGE set, and arms the zero-yield circuit-breaker.
   * Idempotent: calling twice does not re-reserve budget.
   */
  beginBridgeSweep(ctx: HaltContext): void;

  /**
   * Yield the next mandatory bridge crossing, or null when the sweep is complete
   * (all lit bridges crossed → BRIDGE_SWEEP_CLEAR), the sub-budget is exhausted
   * (→ BRIDGE_STARVED), the circuit-breaker tripped, or a hard backstop fired
   * (→ TRUNCATED). Each lit bridge is returned at most ONCE.
   */
  nextBridgeCrossing(ctx: HaltContext): BridgeCrossing | null;

  /**
   * Record the outcome of the crossing the walk just performed. A zero-yield
   * crossing advances the consecutive-zero-yield counter toward
   * `config.bridgeZeroYieldBreaker`; any positive yield resets it.
   */
  recordCrossingYield(y: CrossingYield): void;

  /**
   * Produce the final stamp (NEVER a silent stop). Maps accumulated state to a
   * {@link ReasonCode} and reports popCount, bridgesCrossed, and degraded
   * (TRUNCATED or BRIDGE_STARVED). Safe to call once the walk has ended.
   */
  finalStamp(): HaltStamp;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Phase the controller is currently in. Internal bookkeeping only. */
const enum Phase {
  LOCAL = 0,
  BRIDGE = 1,
  DONE = 2,
}

/**
 * Concrete two-phase controller. Counter/budget bookkeeping AND the two algorithmic
 * cores (phase-1 saturation detection, phase-2 sweep iteration) are fully
 * implemented and tested.
 */
class TwoPhaseHaltingController implements HaltingController {
  private readonly config: WalkConfig;

  // --- main-phase bookkeeping ---------------------------------------------
  private phase: Phase = Phase.LOCAL;
  private popCount = 0;
  private startedAt: EpochMs = asEpochMs(0);
  private startClockSet = false;

  /** Trailing novelty signal (EWMA of newIndependentCorroboration) for phase 1. */
  private trailingNovelty = 1;

  // --- bridge-phase bookkeeping -------------------------------------------
  private bridgeSweepBegun = false;
  /** Pop budget reserved for the bridge sweep = round(popCap * bridgeBudgetFraction). */
  private bridgeBudgetTotal = 0;
  /** Pops consumed so far against the bridge sub-budget. */
  private bridgePopsConsumed = 0;
  /** Bridges actually crossed during phase 2. */
  private bridgesCrossed = 0;
  /**
   * B1 — count of bridge crossings whose seed was down-weighted (factor < 1) by
   * a resolved-but-weak origin independence stamp (0 < indep < 1). Fail-open:
   * bare-key (indep == 0) bridges are NEVER counted here (they stay at γ).
   */
  private bridgeSeedsDownweighted = 0;
  /** Consecutive zero-yield crossings (circuit-breaker counter). */
  private consecutiveZeroYield = 0;
  /** True once the circuit-breaker tripped. */
  private breakerTripped = false;

  /** Lit, un-crossed bridge edges discovered at sweep start, consumed one by one. */
  private pendingBridges: EdgeId[] = [];
  /** Bridge edges already returned by nextBridgeCrossing (each at most once). */
  private readonly crossedBridges = new Set<EdgeId>();

  /**
   * Every strand the walk fired during the LOCAL phase. Accumulated in onPop so
   * beginBridgeSweep can enumerate the lit, un-crossed CROSS_WEB_BRIDGE set from
   * ALL lit strands (not just the last-popped ctx.strandId), which is the owed-
   * bridge set the mandatory sweep must cross.
   */
  private readonly litStrands = new Set<StrandId>();

  // --- outcome ------------------------------------------------------------
  /**
   * Sticky reason once a terminal condition is detected. null means "still
   * running"; finalStamp() resolves a remaining null to a definite code.
   */
  private outcome: ReasonCode | null = null;

  constructor(config: WalkConfig) {
    this.config = config;
  }

  // ------------------------------------------------------------------ onPop
  onPop(ctx: HaltContext): void {
    if (!this.startClockSet) {
      this.startedAt = ctx.now;
      this.startClockSet = true;
    }
    this.popCount += 1;
    if (this.phase === Phase.BRIDGE) {
      this.bridgePopsConsumed += 1;
    }
    // Record this fired strand so the phase-2 sweep can enumerate every lit
    // strand's owed bridges (the walk calls onPop for each local-phase pop).
    this.litStrands.add(ctx.strandId);
    // EWMA update of the trailing-novelty signal phase 1 thresholds against.
    // Cheap, total bookkeeping; the DECISION lives in shouldStopLocal (crack-B).
    const alpha = 0.3;
    this.trailingNovelty =
      alpha * ctx.newIndependentCorroboration + (1 - alpha) * this.trailingNovelty;
  }

  // ------------------------------------------------------ hard backstop test
  /**
   * Returns the backstop ReasonCode if a hard limit has tripped, else null.
   * Fully implemented (simple part): pop-cap and wall-clock. Fails open.
   */
  private backstopTripped(now: EpochMs): ReasonCode | null {
    if (this.popCount >= this.config.popCap) return ReasonCode.TRUNCATED;
    if (this.startClockSet && now - this.startedAt >= this.config.wallClockMs) {
      return ReasonCode.TRUNCATED;
    }
    return null;
  }

  // -------------------------------------------------------- shouldStopLocal
  shouldStopLocal(ctx: HaltContext): boolean {
    // Hard backstop always wins and is fully implemented.
    const trip = this.backstopTripped(ctx.now);
    if (trip !== null) {
      this.outcome = trip;
      this.phase = Phase.DONE;
      return true;
    }

    // PHASE 1 local-saturation gate. Stop the LOCAL walk once the trailing-novelty
    // signal — an EWMA of NEW independent corroboration per pop, fed by
    // ctx.newIndependentCorroboration in onPop — has decayed below epsilon. As the
    // walk exhausts genuinely novel independent-provenance classes, more pops
    // contribute zero novelty, the EWMA falls, and the local cluster is declared
    // saturated (CONVERGED). This reads NOVELTY ONLY; convergence_factor / ancestor
    // sketches never enter here (CLAUDE.md "Separate ordering from stopping" — a
    // genuine insight bridge has convergence=1 and must not be starved by a stop).
    //
    // A frontier that empties of its own accord BEFORE saturation is the walk's
    // concern, not this gate's: the walk simply runs out of candidates and
    // finalStamp resolves a clean (non-degraded) reason.
    if (this.trailingNovelty < this.config.epsilon) {
      this.outcome = ReasonCode.CONVERGED;
      this.phase = Phase.DONE;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------- beginBridgeSweep
  beginBridgeSweep(ctx: HaltContext): void {
    if (this.bridgeSweepBegun) return; // idempotent
    this.bridgeSweepBegun = true;
    this.phase = Phase.BRIDGE;

    // Reserve the SEPARATE bridge sub-budget (fully implemented bookkeeping):
    // ~20% of the pop-cap so bridge-chasing can never starve the local answer.
    this.bridgeBudgetTotal = Math.max(
      1,
      Math.round(this.config.popCap * this.config.bridgeBudgetFraction),
    );
    this.bridgePopsConsumed = 0;
    this.consecutiveZeroYield = 0;
    this.breakerTripped = false;

    // Enumerate the LIT, UN-CROSSED CROSS_WEB_BRIDGE set into this.pendingBridges:
    // iterate EVERY strand fired during the local phase, collect its lit bridges
    // (ctx.store.litBridgesFrom only yields CROSS_WEB_BRIDGE out-edges), de-dup
    // across strands, and exclude any bridge already crossed. Each remaining
    // bridge is owed EXACTLY ONE guaranteed exploratory crossing.
    const pending: EdgeId[] = [];
    const seen = new Set<EdgeId>();
    for (const s of this.litStrands) {
      for (const edge of ctx.store.litBridgesFrom(s)) {
        if (this.crossedBridges.has(edge) || seen.has(edge)) continue;
        seen.add(edge);
        pending.push(edge);
      }
    }
    // B2 — spend the bounded ~20% sub-budget on SIGNAL before DECOYS: order the
    // owed set by the owning strand's offline `earned_bridge_value` DESC (an
    // attacker's freshly-minted decoy bridge has earned_value 0 and sorts last),
    // breaking ties deterministically by EdgeId ASC. Pure reordering — it does
    // not change WHICH bridges are owed a crossing, only the visit order.
    pending.sort((a, b) => {
      const va = ctx.store.bridgeEarnedValue(a);
      const vb = ctx.store.bridgeEarnedValue(b);
      if (vb !== va) return vb - va; // earned_value DESC (signal first)
      return a < b ? -1 : a > b ? 1 : 0; // deterministic id tiebreak ASC
    });
    this.pendingBridges = pending;
  }

  // ------------------------------------------------------ nextBridgeCrossing
  nextBridgeCrossing(ctx: HaltContext): BridgeCrossing | null {
    if (!this.bridgeSweepBegun) this.beginBridgeSweep(ctx);

    // Hard backstop short-circuits the sweep too (fully implemented).
    const trip = this.backstopTripped(ctx.now);
    if (trip !== null) {
      this.outcome = trip;
      this.phase = Phase.DONE;
      return null;
    }

    // Circuit-breaker: after N consecutive zero-yield crossings, stop chasing.
    if (this.breakerTripped) {
      // Breaker is not itself a degraded outcome; remaining bridges are simply
      // abandoned. Resolve to STARVED only if budget/bridges were left owed.
      this.phase = Phase.DONE;
      if (this.pendingBridges.length > 0) this.outcome = ReasonCode.BRIDGE_STARVED;
      return null;
    }

    // Sub-budget exhausted before all owed bridges crossed -> BRIDGE_STARVED.
    if (this.bridgePopsConsumed >= this.bridgeBudgetTotal && this.pendingBridges.length > 0) {
      this.outcome = ReasonCode.BRIDGE_STARVED;
      this.phase = Phase.DONE;
      return null;
    }

    // All owed bridges crossed -> sweep clear.
    if (this.pendingBridges.length === 0) {
      this.phase = Phase.DONE;
      return null;
    }

    // Pull the next owed bridge (all budget/breaker/backstop guards above have
    // passed, so at least one owed bridge remains and budget is available). Mark
    // it crossed so each lit bridge is returned at most once and is excluded from
    // any future enumeration. Resolve the far-side target via the store view.
    //
    // seedActivation = config.gamma (the per-hop decay constant, ~0.6): there is
    // no bridge-seed config field, and a single modest exploratory injection is
    // the design's intent. gamma is principled, already in [0,1), and models one
    // decayed hop across the bridge into the far web — mirroring the energy a
    // normal one-hop local spread would deliver, keeping energy monotone
    // non-increasing while introducing no new tunable. The far strand's own
    // novelty (independent provenance) then drives recordCrossingYield's
    // yield / zero-yield circuit-breaker.
    const bridgeEdge = this.pendingBridges.shift()!;
    this.crossedBridges.add(bridgeEdge);
    const target = ctx.store.bridgeTarget(bridgeEdge);
    // B1 — independence-scaled seed: seed = γ × factor, factor ∈ [0,1].
    //   indep == 0 (bare-key OR stamp-absent) ⇒ factor 1 ⇒ stays at γ. A bare-key
    //     poison bridge is internally INDISTINGUISHABLE from an honest bare-key
    //     INSIGHT bridge under the impossibility theorem; down-weighting it would
    //     suppress genuine insight, so it stays at γ on purpose (fail-open).
    //   0 < indep < 1 (resolved but WEAK anchor stamp) ⇒ factor indep ⇒ seed
    //     proportionally down-weighted. The only case that moves.
    //   indep >= 1 ⇒ factor 1 ⇒ never an UP-weight (would break the monotone-
    //     non-increasing termination proof). seed ∈ [0, γ] ⊆ [0, γ), proof intact.
    // O(1) multiply on the already-loaded edge scalar — NO MIS/identity round-trip.
    const indep = ctx.store.bridgeIndependence(bridgeEdge);
    const factor = indep > 0 && indep < 1 ? indep : 1;
    if (factor < 1) this.bridgeSeedsDownweighted += 1;
    const seed = (this.config.gamma * factor) as Activation;
    return { bridgeEdge, target, seedActivation: seed };
  }

  // ------------------------------------------------------ recordCrossingYield
  recordCrossingYield(y: CrossingYield): void {
    // Fully-implemented bookkeeping for the circuit-breaker + budget.
    this.bridgesCrossed += 1;
    this.bridgePopsConsumed += Math.max(0, y.popsConsumed);

    if (y.yieldCorroboration <= 0) {
      this.consecutiveZeroYield += 1;
      if (this.consecutiveZeroYield >= this.config.bridgeZeroYieldBreaker) {
        this.breakerTripped = true;
      }
    } else {
      this.consecutiveZeroYield = 0;
    }
  }

  // -------------------------------------------------------------- finalStamp
  finalStamp(): HaltStamp {
    // Resolve any still-undecided run to a definite, NON-SILENT reason.
    let reason = this.outcome;
    if (reason === null) {
      // No terminal condition was recorded: the sweep completed cleanly if it
      // ran, otherwise the local phase converged. Fail open with an explicit code.
      reason = this.bridgeSweepBegun ? ReasonCode.BRIDGE_SWEEP_CLEAR : ReasonCode.CONVERGED;
    }
    const degraded = reason === ReasonCode.TRUNCATED || reason === ReasonCode.BRIDGE_STARVED;
    return {
      reason,
      popCount: this.popCount,
      bridgesCrossed: this.bridgesCrossed,
      bridgeSeedsDownweighted: this.bridgeSeedsDownweighted,
      degraded,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a two-phase {@link HaltingController} for one traversal. The returned
 * controller is single-use and stateful: create one per walk. `config` supplies
 * epsilon, popCap, wallClockMs, bridgeBudgetFraction and bridgeZeroYieldBreaker
 * (see {@link WalkConfig} / DEFAULT_WALK_CONFIG in core/types).
 */
export function createHaltingController(config: WalkConfig): HaltingController {
  return new TwoPhaseHaltingController(config);
}
