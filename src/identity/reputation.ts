/**
 * identity/reputation.ts — Pillar 3 of the Source-Identity Layer: the CREDIT
 * SCORE ("reputation, earned slowly, lost fast"), now a calibrated BETA(α,β) model
 * (ARCHITECTURE.md §2 "Trust algorithm" + the Trust-scoring guarantee).
 *
 * Design grounding (CLAUDE.md pillar 3/4 + ARCHITECTURE.md "Trust algorithm"):
 *  - COUNTS NEVER DRIVE WEIGHT, INDEPENDENCE DOES. Weight comes from the
 *    independence-WEIGHTED evidence mass for and against a source, NOT from
 *    headcount. This is the single non-negotiable invariant of this module, and the
 *    Beta model strengthens it: corroboration adds `α += w` where `w` is the
 *    independence weight the CALLER supplies (from the MIS / identity layer), and k
 *    colluders in ONE independence class contribute `w` ONCE total — the ledger
 *    never turns N corroborations from one class into N·w. Headcount is denied at
 *    the caller (one `ratify` per independence class), and the ledger trusts `w`.
 *  - ASYMMETRIC: bad news weighs 4×. A contradiction adds `β += c·w` with `c = 4`,
 *    so the recovery cost from a contradiction strictly EXCEEDS the gain it erased.
 *  - DECAYED: on each access `α ← 1 + (α−1)·λ^Δt`, `β ← 1 + (β−1)·λ^Δt`, half-life
 *    90 days (`λ = 0.5^(1/90)`). Dormant / on-off sources drift toward the prior
 *    Beta(1,1), so "bank trust then defect" is dampened.
 *  - READOUT is a LOWER-CONFIDENCE BOUND: `weight = min(rep_cap, mean − z·sd)` of
 *    Beta(α,β), `z = 1.0`, clamped to [0,1]. A fresh / low-evidence source has high
 *    variance ⇒ LCB ≈ 0 ⇒ whitewashing a fresh identity buys ≈ 0 weight (the
 *    uncertainty penalty). A well-corroborated source approaches but never exceeds
 *    `rep_cap`.
 *
 * Relationship to the stamp: the `reputation` field of {@link IdentityStamp} is the
 * LCB readout produced here (exposed as `scoreOf` and cached on the state's `score`
 * field for audit/serialization). This module owns the *update rule*; the stamp is a
 * snapshot read by the web.
 *
 * What is SIMPLE (implemented fully here):
 *  - the {@link ReputationState} shape (per-source Beta state + audit counts),
 *  - the pure update rules ({@link decay} / {@link applyRatification} /
 *    {@link applyContradiction} / {@link applyCreditReversal}) and the
 *    {@link lcbReadout}.
 *
 * What is LIVE (the stateful pillar):
 *  - {@link ReputationLedger} + {@link createReputationLedger}: a stateful,
 *    in-memory ledger over a `Map<SourceId, ReputationState>`. The identity facade's
 *    `ReputationLedgerPort.scoreOf` reads the EARNED LCB from here.
 *  - {@link ReputationLedger.disownSweep}: the DIRECT-SEED clawback over a source's
 *    asserted strands (echo-collapse + crater + idempotent). The DOWNSTREAM
 *    transitive closure lives in `ratification/disown.ts`.
 *  - {@link ReputationLedger.reverseCredit} / {@link applyCreditReversal}: the
 *    PRECISE per-event credit reversal — subtract EXACTLY the recorded `w` back out
 *    of `α` (clamped at the prior 1, never sub-prior). This is the exact-disown
 *    unwind the corroboration-event ledger drives.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (every type-only import uses `import type`); `exactOptionalPropertyTypes`. No
 * external runtime deps; `node:sqlite` via runtime require (built-in only).
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { asEpochMs } from "../core/types.js";
import type { SourceId, StrandId, EpochMs, Unit } from "../core/types.js";

// ---------------------------------------------------------------------------
// Tunable Beta-model constants (product decision — tune to threat model)
// ---------------------------------------------------------------------------

/**
 * Coefficients for the Beta(α,β) accrual + decay + readout rule. The load-bearing
 * invariants — not the exact numbers — are: `contradictionMultiplier > 1` (bad news
 * heavier than good; recovery costs more than the gain it erased), a finite
 * `halfLifeDays` (dormant sources drift to the prior), and `z >= 0` (the readout is
 * a LOWER-confidence bound that penalizes uncertainty). Numbers are illustrative
 * starting points, exactly like the anchor-cost table.
 */
export interface ReputationParams {
  /**
   * Asymmetry multiplier `c` applied to a contradiction: one contradiction of
   * independence weight `w` adds `c·w` to `β`. `c = 4` makes bad news weigh 4× so
   * the recovery cost STRICTLY exceeds the gain it erased. Must be `> 1`.
   */
  readonly contradictionMultiplier: number;
  /**
   * Exponential-decay half-life in DAYS for the evidence mass `(α−1)` and `(β−1)`:
   * after `halfLifeDays` of dormancy each is halved, pulling the source toward the
   * prior Beta(1,1). `90` days by default.
   */
  readonly halfLifeDays: number;
  /**
   * Standard-deviations of margin subtracted in the LOWER-confidence-bound readout
   * (`mean − z·sd`). The default `z = √3 ≈ 1.732` is CALIBRATED so the uninformative
   * prior Beta(1,1) — whose `mean = 0.5`, `sd = √(1/12)` — reads out EXACTLY 0
   * (`0.5 − √3·√(1/12) = 0`). This makes the architecture's load-bearing invariant
   * mechanical: a FRESH / whitewashed identity (or any source decayed/cratered back
   * to the prior) has the maximal-variance prior and therefore ≈ 0 weight — the
   * uncertainty penalty the LCB exists for. (ARCHITECTURE.md cites `z ≈ 1.0`; we keep
   * z in the same family but pin it to the value that makes "fresh ⇒ exactly 0" hold
   * rather than "fresh ⇒ ~0.21".) Must be `>= 0`; `0` reads out the bare mean.
   */
  readonly z: number;
  /**
   * Floor the LCB readout is clamped to (never below 0). Kept for parity with the
   * stamp contract; a contradicted source can crash to this floor.
   */
  readonly floor: Unit;
}

/**
 * Default Beta-model parameters (ARCHITECTURE.md §2): asymmetric `c = 4`, 90-day
 * half-life, lower-confidence-bound `z = √3` (calibrated so the prior Beta(1,1)
 * reads out exactly 0 — see {@link ReputationParams.z}), floor 0.
 */
export const DEFAULT_REPUTATION_PARAMS: ReputationParams = {
  contradictionMultiplier: 4,
  halfLifeDays: 90,
  z: Math.sqrt(3),
  floor: 0.0,
};

/** Milliseconds in one day, for the decay clock. */
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The per-source reputation state (Beta(α,β) + audit counts)
// ---------------------------------------------------------------------------

/**
 * The reputation state for a single source (passport key) — a BETA(α,β) posterior
 * over "how often this source's claims are independently corroborated".
 *
 * `alpha` (pseudo-corroborations + 1) and `beta` (asymmetric pseudo-contradictions
 * + 1) are the load-bearing state; both start at 1 (the uninformative prior
 * Beta(1,1)). `score` is the CACHED LOWER-CONFIDENCE-BOUND readout (`min(rep_cap,
 * mean − z·sd)`, clamped to [0,1]) at the moment of the last update — the value the
 * stamp's `reputation` field reflects. `ratifiedCount` / `contradictedCount` are
 * AUDIT-ONLY raw track record (NOT a headcount input to weight — weight is driven by
 * the independence-weighted `α`/`β`, by design, since headcount is exactly what the
 * contradiction-bomb abuses).
 */
export interface ReputationState {
  /** The source this state belongs to (its passport key). */
  readonly sourceId: SourceId;
  /** Beta α: 1 + Σ(independence-weighted corroborations). Prior 1. */
  readonly alpha: number;
  /** Beta β: 1 + c·Σ(independence-weighted contradictions). Prior 1. */
  readonly beta: number;
  /**
   * CACHED lower-confidence-bound readout in [0,1] at last update (`min(rep_cap,
   * mean − z·sd)`), the value the stamp exposes. Always recomputed by the ledger on
   * read against the CURRENT rep_cap, so a later cap reduction is honored.
   */
  readonly score: Unit;
  /** AUDIT-ONLY: how many of this source's past claims were later ratified. */
  readonly ratifiedCount: number;
  /** AUDIT-ONLY: how many of this source's past claims were later contradicted. */
  readonly contradictedCount: number;
  /**
   * Witness time of this source's MOST RECENT contradiction, or null if never
   * contradicted. Fail-closed if absent: a contradicted source (contradictedCount>0)
   * with this unset is treated as contradicted-now by the high-impact gate.
   */
  readonly lastContradictionAt: EpochMs | null;
  /** When this state was last updated (witness time) — the decay clock anchor. */
  readonly lastUpdate: EpochMs;
}

/**
 * Construct a fresh state for a never-before-seen source: the uninformative prior
 * Beta(1,1). Its LCB readout is exactly 0 (mean 0.5 but variance is maximal, so
 * `mean − 1·sd` clamps to 0) — the mechanical defeat of the contradiction-bomb and
 * of whitewashing: 500 new keys are 500 zeros.
 */
export function newReputationState(sourceId: SourceId, now: EpochMs): ReputationState {
  return {
    sourceId,
    alpha: 1,
    beta: 1,
    score: 0 as Unit,
    ratifiedCount: 0,
    contradictedCount: 0,
    lastContradictionAt: null,
    lastUpdate: now,
  };
}

// ---------------------------------------------------------------------------
// Pure Beta-model math (SIMPLE — fully implemented)
// ---------------------------------------------------------------------------

/** Clamp a value into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** The decay factor `λ` for a given half-life in days: `0.5^(1/halfLifeDays)`. */
function lambdaOf(halfLifeDays: number): number {
  const h = halfLifeDays > 0 ? halfLifeDays : 1;
  return Math.pow(0.5, 1 / h);
}

/**
 * The LOWER-CONFIDENCE-BOUND readout of a Beta(α,β): `min(repCap, mean − z·sd)`,
 * clamped to [floor, 1]. `mean = α/(α+β)`; `sd = sqrt(α·β / ((α+β)²·(α+β+1)))`.
 *
 * A fresh / low-evidence source has high variance ⇒ a large `z·sd` margin ⇒ LCB ≈ 0
 * (whitewashing worthless). A well-corroborated source has tiny variance ⇒ LCB →
 * mean, but is HARD-CEILINGED at `repCap` so it approaches but never exceeds the cap.
 *
 * @param state  the source's current Beta state.
 * @param repCap the source's reputation ceiling (from `anchors.repCapFor`).
 * @param params reads `z` (margin) and `floor` (lower clamp).
 */
export function lcbReadout(
  state: ReputationState,
  repCap: Unit,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
): Unit {
  const a = state.alpha;
  const b = state.beta;
  const sum = a + b;
  // (α+β) and (α+β+1) are always >= 2 (prior), so the denominator is never 0.
  const mean = a / sum;
  const variance = (a * b) / (sum * sum * (sum + 1));
  // Guard against a tiny negative under sqrt from floating error.
  const sd = Math.sqrt(Math.max(0, variance));
  const lcb = mean - params.z * sd;
  const cap = clamp(repCap, 0, 1);
  const floor = clamp(params.floor, 0, 1);
  const out = clamp(Math.min(cap, lcb), floor, 1);
  // Snap a negligible readout to the floor: with z = √3 the prior Beta(1,1) computes
  // `0.5 − √3·√(1/12)` which is 0 mathematically but ~5e-17 in float — so a fresh /
  // cratered source reads EXACTLY 0 (the "whitewashing buys 0 weight" invariant),
  // never a stray sub-epsilon positive.
  return (Math.abs(out - floor) < 1e-12 ? floor : out) as Unit;
}

/**
 * Recompute the cached `score` field from `α`/`β` against `repCap` — the single
 * place a state's LCB readout is materialized after any α/β change.
 */
function withReadout(
  state: Omit<ReputationState, "score">,
  repCap: Unit,
  params: ReputationParams,
): ReputationState {
  const full: ReputationState = { ...state, score: 0 as Unit };
  return { ...full, score: lcbReadout(full, repCap, params) };
}

/**
 * Apply EXPONENTIAL DECAY to the evidence mass as of `now`: `α ← 1 + (α−1)·λ^Δt`,
 * `β ← 1 + (β−1)·λ^Δt`, where `Δt` is days since `state.lastUpdate` and `λ =
 * 0.5^(1/halfLifeDays)`. Pulls a dormant / on-off source toward the prior Beta(1,1)
 * — so a source that banked trust then went idle drifts back down, and the
 * "bank-then-defect" attack is dampened. Sets `lastUpdate = now` and refreshes the
 * cached `score`. A non-positive `Δt` (same-instant or out-of-order clock) is a
 * no-op on the mass (factor 1), only refreshing the readout.
 *
 * Called FIRST inside every ledger mutation/read so accrual is on the decayed state
 * (decay-before-mutate; pure-decay-for-readout). Pure: returns a NEW state.
 *
 * @param state  the source's current state.
 * @param repCap the source's reputation ceiling (for the refreshed readout).
 * @param now    witness time to decay to.
 * @param params reads `halfLifeDays`, `z`, `floor`.
 */
export function decay(
  state: ReputationState,
  repCap: Unit,
  now: EpochMs,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
): ReputationState {
  const dtDays = ((now as number) - (state.lastUpdate as number)) / MS_PER_DAY;
  // Out-of-order / same-instant: never AMPLIFY mass; factor stays 1.
  const factor = dtDays > 0 ? Math.pow(lambdaOf(params.halfLifeDays), dtDays) : 1;
  const alpha = 1 + (state.alpha - 1) * factor;
  const beta = 1 + (state.beta - 1) * factor;
  return withReadout(
    {
      sourceId: state.sourceId,
      alpha,
      beta,
      ratifiedCount: state.ratifiedCount,
      contradictedCount: state.contradictedCount,
      lastContradictionAt: state.lastContradictionAt,
      lastUpdate: now,
    },
    repCap,
    params,
  );
}

/**
 * Apply ONE corroboration (a past claim later corroborated by an INDEPENDENT
 * anchor): decay to `now`, then `α += clamp(w, 0, 1)`. `w` is the INDEPENDENCE
 * WEIGHT supplied by the caller (from the MIS / identity layer) — NEVER a fixed 1
 * and NEVER derived from a count. k colluders in ONE independence class are collapsed
 * UPSTREAM into a single call with that class's weight, so `α` rises by `w` ONCE; only
 * DISTINCT independent classes produce distinct calls and distinct `w`. This is where
 * headcount is denied. The LCB readout rises slowly (variance shrinks) toward `repCap`.
 *
 * @param state  the source's current state.
 * @param w      the independence weight in (0,1] for this corroboration.
 * @param repCap the source's reputation ceiling, from `anchors.repCapFor`.
 * @param now    witness time of this corroboration.
 * @param params Beta-model coefficients.
 * @returns a NEW state (pure; input untouched). Bumps `ratifiedCount` (audit-only).
 */
export function applyRatification(
  state: ReputationState,
  w: number,
  repCap: Unit,
  now: EpochMs,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
): ReputationState {
  const decayed = decay(state, repCap, now, params);
  const wClamped = clamp(Number.isFinite(w) ? w : 0, 0, 1);
  return withReadout(
    {
      sourceId: decayed.sourceId,
      alpha: decayed.alpha + wClamped,
      beta: decayed.beta,
      ratifiedCount: decayed.ratifiedCount + 1,
      contradictedCount: decayed.contradictedCount,
      lastContradictionAt: decayed.lastContradictionAt,
      lastUpdate: now,
    },
    repCap,
    params,
  );
}

/**
 * Apply ONE contradiction (a past claim later outranked by an independent claim, or
 * its backing stake burned): decay to `now`, then `β += c·clamp(w, 0, 1)` with `c =
 * contradictionMultiplier` (default 4). Bad news weighs 4×, so the LCB drops sharply
 * and recovering the prior readout takes STRICTLY MORE corroboration than the single
 * event removed (asymmetric recovery). No `repCap` gate on losing trust — the cap
 * only ceilings the gain — but the readout still needs `repCap` to re-materialize.
 *
 * @param state  the source's current state.
 * @param w      the independence weight in (0,1] for this contradiction.
 * @param repCap the source's reputation ceiling (for the refreshed readout).
 * @param now    witness time of this contradiction.
 * @param params reads `contradictionMultiplier`, `z`, `floor`, `halfLifeDays`.
 * @returns a NEW state (pure). Bumps `contradictedCount` (audit-only).
 */
export function applyContradiction(
  state: ReputationState,
  w: number,
  repCap: Unit,
  now: EpochMs,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
): ReputationState {
  const decayed = decay(state, repCap, now, params);
  const wClamped = clamp(Number.isFinite(w) ? w : 0, 0, 1);
  const c = params.contradictionMultiplier > 0 ? params.contradictionMultiplier : 1;
  return withReadout(
    {
      sourceId: decayed.sourceId,
      alpha: decayed.alpha,
      beta: decayed.beta + c * wClamped,
      ratifiedCount: decayed.ratifiedCount,
      contradictedCount: decayed.contradictedCount + 1,
      lastContradictionAt: now,
      lastUpdate: now,
    },
    repCap,
    params,
  );
}

/**
 * Apply ONE PRECISE CREDIT REVERSAL (exact disown unwind): decay to `now`, then
 * subtract EXACTLY `w` from `α` (`α ← max(1, α − w)`). Unlike
 * {@link applyContradiction} — which adds asymmetric β mass for a whole-claim
 * contradiction — this is the exact undo of a SPECIFIC corroboration-driven gain:
 * the `α += w` recorded at earning time is reversed by `α -= w`. Clamped at the prior
 * 1 so repeated/over-reversal can never drive `α` below the valid Beta pseudocount.
 * Does NOT bump `contradictedCount` (it is a precise undo, not a contradiction).
 *
 * @param state  the source's current state.
 * @param w      the exact `α`-mass to subtract (the recorded earned `w`).
 * @param repCap the source's reputation ceiling (for the refreshed readout).
 * @param now    witness time of this reversal.
 * @param params Beta-model coefficients (for decay + readout).
 * @returns a NEW state (pure; input untouched).
 */
export function applyCreditReversal(
  state: ReputationState,
  w: number,
  repCap: Unit,
  now: EpochMs,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
): ReputationState {
  const decayed = decay(state, repCap, now, params);
  const d = Number.isFinite(w) ? w : 0;
  const alpha = Math.max(1, decayed.alpha - d);
  return withReadout(
    {
      sourceId: decayed.sourceId,
      alpha,
      beta: decayed.beta,
      ratifiedCount: decayed.ratifiedCount,
      contradictedCount: decayed.contradictedCount,
      lastContradictionAt: decayed.lastContradictionAt,
      lastUpdate: now,
    },
    repCap,
    params,
  );
}

// ---------------------------------------------------------------------------
// Retroactive disown sweep result
// ---------------------------------------------------------------------------

/**
 * Result of a {@link disownSweep}: the strand ids whose reputation contribution was
 * clawed back because the asserting source was disowned. "Clawed back" means the
 * earned credit those strands conferred is reversed and the strands are flagged for
 * the demotion/forgetting pipeline. NOT deletion — contradiction demotes, never
 * deletes; the archive stub is immortal.
 */
export interface DisownSweepResult {
  /** Strand ids whose reputation credit was reversed by this sweep. */
  readonly clawedBack: StrandId[];
}

// ---------------------------------------------------------------------------
// The stateful in-memory ledger (LIVE — wraps the pure Beta rules above)
// ---------------------------------------------------------------------------

/**
 * Default independence weight `w` for a corroboration/contradiction when a caller
 * does not supply one. Kept at 1 so existing single-witness call sites (the engine's
 * ratify verb, the approve flow) accrue a full independent-witness unit; callers
 * sourcing a real MIS weight pass it explicitly. THE HEADCOUNT DENIAL lives at the
 * caller (one call per independence class), never in this default.
 */
const DEFAULT_INDEPENDENCE_WEIGHT = 1;

/**
 * The stateful reputation ledger keyed by {@link SourceId}. Wraps the pure Beta
 * update rules over a per-process `Map<SourceId, ReputationState>`; the identity
 * facade's `ReputationLedgerPort.scoreOf` reads the EARNED LCB from here.
 *
 * The ledger never imports the anchor table — it learns each source's `rep_cap`
 * ONLY through the injected `repCapOf` accessor, keeping it pure dependency
 * injection (like the facade ports).
 *
 * INDEPENDENCE-WEIGHT CONTRACT (the headcount denial): `ratify`/`contradict` take an
 * OPTIONAL `w` (the independence weight from the MIS / identity layer, defaulting to
 * 1). The CALLER must collapse N corroborations from ONE independence class into ONE
 * call with that class's weight; the ledger never multiplies a count by `w`. 500
 * same-class echoes → one `ratify(s, w)` → `α += w` once. Only DISTINCT independent
 * classes add distinct `w`.
 */
export interface ReputationLedger {
  /**
   * Current EARNED reputation in [0,1] for a source — the LOWER-CONFIDENCE-BOUND
   * readout of its Beta(α,β), the value the facade copies into
   * `IdentityStamp.reputation`. An unknown/fresh source has the prior Beta(1,1) whose
   * LCB is exactly 0 (high variance; whitewashing worthless). A known source's stored
   * `α`/`β` are read out against `repCapOf(sourceId)` on EACH read, so a later cap
   * REDUCTION is honored.
   *
   * DECAY-ON-READ (PURE): the stored mass is decayed to the ledger's `now()` ON A COPY
   * before the readout, so a source that earned a high LCB then went DORMANT reads its
   * dormancy-discounted score IMMEDIATELY (the stamp reflects staleness without waiting
   * for the next mutation) — matching ARCHITECTURE.md §2 "Decay on each access". The
   * read is SIDE-EFFECT-FREE: the decayed state is NEVER persisted (only writes persist
   * decay, via decay-before-mutate). A non-positive Δt (synchronous, same-instant reads)
   * is a no-op on the mass, so existing pre-decay readouts are unchanged.
   */
  scoreOf(sourceId: SourceId): Unit;

  /**
   * Record ONE corroboration for a source with independence weight `w` (default 1):
   * decay, then `α += clamp(w,0,1)`. The LCB rises slowly toward the source's current
   * `rep_cap`. Creates a fresh prior-state source first. The caller is responsible for
   * passing ONE call per independence class (headcount denial).
   *
   * @returns the source's resulting {@link ReputationState} after the corroboration.
   */
  ratify(sourceId: SourceId, now: EpochMs, w?: number): ReputationState;

  /**
   * Record ONE contradiction for a source with independence weight `w` (default 1):
   * decay, then `β += c·clamp(w,0,1)` (c = 4 asymmetric). The LCB drops sharply;
   * recovering it takes strictly more corroboration than the event removed.
   *
   * @returns the source's resulting {@link ReputationState} after the contradiction.
   */
  contradict(sourceId: SourceId, now: EpochMs, w?: number): ReputationState;

  /**
   * PRECISE per-event credit reversal: decay, then subtract EXACTLY `w` from `α`
   * (`α ← max(1, α − w)`). This is the exact-disown unwind the corroboration-event
   * ledger drives — NOT the asymmetric {@link contradict}. Materializes a fresh
   * prior-state source if unknown (a no-op from the prior). Does NOT bump
   * `contradictedCount`.
   *
   * @param delta the exact `α`-mass (the recorded `w`) to subtract.
   * @returns the source's resulting {@link ReputationState} after the reversal.
   */
  reverseCredit(sourceId: SourceId, delta: number, now: EpochMs): ReputationState;

  /**
   * Audit read: the raw {@link ReputationState} (α/β + audit counts) for a source, or
   * `null` if unknown. NOT used by the stamp (the stamp reads only the LCB readout).
   */
  stateOf(sourceId: SourceId): ReputationState | null;

  /**
   * RETROACTIVELY DISOWN A BAD SOURCE (CLAUDE.md pillar 4). Craters the disowned
   * source's earned credit. IMPLEMENTED here — the DIRECT-SEED clawback over the
   * passed-in `assertedStrandIds`:
   *   - echo-collapse: dedupe the seed by {@link StrandId} value,
   *   - crater: RESET the disowned source to the prior Beta(1,1) (α=β=1) so its LCB
   *     is provably 0 again, and bump its `contradictedCount`,
   *   - idempotent: a SECOND sweep returns `[]` and re-touches nothing,
   *   - fails CLOSED: an unknown source still records the disown + returns the deduped
   *     seed ids.
   *
   * @param sourceId          the disowned source.
   * @param assertedStrandIds every strand this source asserted (the seed set).
   * @returns the deduped strand ids whose reputation credit was reversed.
   */
  disownSweep(
    sourceId: SourceId,
    assertedStrandIds: readonly StrandId[],
  ): DisownSweepResult;
}

/**
 * Trivial in-memory {@link ReputationLedger}. Authoritative for the process
 * lifetime; swap for a durable backend without touching callers. All math is
 * delegated to the pure Beta functions above — this class owns the Map and the
 * cap-accessor wiring, and persists the decayed-before-mutate state.
 */
class InMemoryReputationLedger implements ReputationLedger {
  /** SourceId -> current Beta state. Absent key === fresh prior Beta(1,1). */
  private readonly book = new Map<SourceId, ReputationState>();
  /** Sources already disowned, for idempotency of {@link disownSweep}. */
  private readonly disowned = new Set<SourceId>();

  constructor(
    private readonly repCapOf: (sourceId: SourceId) => Unit,
    private readonly params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
    private readonly clock: () => EpochMs = () => asEpochMs(Date.now()),
  ) {}

  scoreOf(sourceId: SourceId): Unit {
    const state = this.book.get(sourceId);
    if (state === undefined) return 0 as Unit; // fresh prior => LCB 0
    // DECAY-ON-READ (PURE): decay a COPY of the stored α/β to `now()` before reading
    // out, so a dormant high-LCB source reflects its staleness IMMEDIATELY (not only at
    // the next mutation). The decayed state is NEVER persisted — `decay` returns a fresh
    // object and we discard it after the readout, so the read stays side-effect-free.
    // A non-positive Δt (synchronous same-instant reads) is a no-op on the mass.
    const cap = clamp(this.repCapOf(sourceId), 0, 1) as Unit;
    const decayed = decay(state, cap, this.clock(), this.params);
    return lcbReadout(decayed, cap, this.params);
  }

  ratify(sourceId: SourceId, now: EpochMs, w: number = DEFAULT_INDEPENDENCE_WEIGHT): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyRatification(this.ensure(sourceId, now), w, cap, now, this.params);
    this.book.set(sourceId, next);
    return next;
  }

  contradict(sourceId: SourceId, now: EpochMs, w: number = DEFAULT_INDEPENDENCE_WEIGHT): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyContradiction(this.ensure(sourceId, now), w, cap, now, this.params);
    this.book.set(sourceId, next);
    return next;
  }

  reverseCredit(sourceId: SourceId, delta: number, now: EpochMs): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyCreditReversal(this.ensure(sourceId, now), delta, cap, now, this.params);
    this.book.set(sourceId, next);
    return next;
  }

  stateOf(sourceId: SourceId): ReputationState | null {
    return this.book.get(sourceId) ?? null;
  }

  disownSweep(
    sourceId: SourceId,
    assertedStrandIds: readonly StrandId[],
  ): DisownSweepResult {
    if (this.disowned.has(sourceId)) {
      return { clawedBack: [] };
    }
    this.disowned.add(sourceId);

    // Echo-collapse: dedupe the seed by StrandId identity (a same-id flood counts
    // once). The DOWNSTREAM transitive claw-back lives in `ratification/disown.ts`.
    const seen = new Set<StrandId>();
    const clawedBack: StrandId[] = [];
    for (const id of assertedStrandIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      clawedBack.push(id);
    }

    // Crater the disowned source's EARNED credit: RESET to the prior Beta(1,1) so the
    // LCB is provably 0 again, and record the disown as a contradiction event. Fails
    // CLOSED — even an unknown source is materialized at the prior and recorded.
    const cap = this.repCapOf(sourceId);
    const prior =
      this.book.get(sourceId) ?? newReputationState(sourceId, 0 as EpochMs);
    this.book.set(
      sourceId,
      withReadout(
        {
          sourceId,
          alpha: 1,
          beta: 1,
          ratifiedCount: prior.ratifiedCount,
          contradictedCount: prior.contradictedCount + 1,
          // A disown is a contradiction event: stamp the witness time so the
          // fail-closed high-impact recency gate sees a real contradiction.
          lastContradictionAt: this.clock(),
          lastUpdate: prior.lastUpdate,
        },
        cap,
        this.params,
      ),
    );

    return { clawedBack };
  }

  private ensure(sourceId: SourceId, now: EpochMs): ReputationState {
    return this.book.get(sourceId) ?? newReputationState(sourceId, now);
  }
}

/**
 * Construct a fresh, empty {@link ReputationLedger} (the in-memory implementation).
 *
 * @param repCapOf accessor for a source's reputation ceiling — callers pass
 *                 `(s) => repCapFor(anchorsOf(s))` so the Beta readout respects the
 *                 source's `rep_cap`. Injected (not imported) so the ledger stays
 *                 pure DI, like the facade ports.
 * @param params  the Beta-model coefficients; defaults to
 *                 {@link DEFAULT_REPUTATION_PARAMS}.
 * @param clock   OPTIONAL witness clock the PURE decay-on-read in `scoreOf` decays a
 *                 copy of the stored state to. Defaults to `Date.now()`. Inject a
 *                 controllable clock to exercise dormancy decay deterministically in
 *                 tests; the default keeps Δt ≈ 0 for synchronous callers (unchanged
 *                 pre-decay readouts).
 */
export function createReputationLedger(
  repCapOf: (sourceId: SourceId) => Unit,
  params: ReputationParams = DEFAULT_REPUTATION_PARAMS,
  clock: () => EpochMs = () => asEpochMs(Date.now()),
): ReputationLedger {
  return new InMemoryReputationLedger(repCapOf, params, clock);
}

// ---------------------------------------------------------------------------
// Free-function disown sweep (stable barrel signature; delegates direct clawback)
// ---------------------------------------------------------------------------

/**
 * RETROACTIVELY DISOWN A BAD SOURCE — the free-function form kept for callers
 * written against the original barrel signature. It performs the DIRECT-SEED
 * clawback (echo-collapse + return) over a private throw-away ledger; it does not
 * crater a SHARED ledger (it has none). Use {@link ReputationLedger.disownSweep} on
 * the live ledger to actually reset a source's earned credit.
 */
export function disownSweep(
  sourceId: SourceId,
  assertedStrandIds: StrandId[],
): DisownSweepResult {
  const ledger = createReputationLedger(() => 0 as Unit);
  return ledger.disownSweep(sourceId, assertedStrandIds);
}

// ---------------------------------------------------------------------------
// Durable, SQLite-backed ReputationLedger (DROP-IN — wraps the SAME Beta rules)
// ---------------------------------------------------------------------------

/**
 * Load `node:sqlite`'s {@link DatabaseSync} via a runtime `require` (not a static
 * import). WHY: identical to `store/sqliteStore.ts` — `node:sqlite` is a Node 24+
 * built-in newer than the test transformer's hardcoded built-in list, so a STATIC
 * import gets its `node:` prefix stripped and fails to bundle; a runtime
 * `require("node:sqlite")` is opaque to that analysis (still ZERO external deps —
 * stdlib only). The TYPE is imported separately and erased at runtime.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * The {@link ReputationLedger} a {@link createSqliteReputationLedger} returns,
 * widened with {@link close}. Still assignable to {@link ReputationLedger}, so it is
 * a DROP-IN everywhere the in-memory ledger is accepted.
 */
export interface SqliteReputationLedger extends ReputationLedger {
  /**
   * Close the underlying database handle (no-op when the ledger was handed a
   * borrowed, shared handle — only the path-opening factory owns close).
   */
  close(): void;
}

/** Narrow a SQLite output cell that must be a string (a NOT NULL `json` column). */
function repAsString(v: unknown): string {
  return v as string;
}

/**
 * A LEGACY (multiplicative-model) persisted row shape: `{ score, ... }` with no
 * `alpha`/`beta`. We migrate such a row at READ TIME to the Beta model so a database
 * written by the previous version still loads.
 */
interface LegacyReputationRow {
  readonly sourceId: SourceId;
  readonly score?: number;
  readonly alpha?: number;
  readonly beta?: number;
  readonly ratifiedCount?: number;
  readonly contradictedCount?: number;
  readonly lastContradictionAt?: number | null;
  readonly lastUpdate?: number;
}

/**
 * READ-TIME MIGRATION (no `user_version` ladder exists — see CLAUDE.md "No schema
 * migration"). A row written by the OLD multiplicative model carries `score` but no
 * `alpha`/`beta`. We synthesize a faithful Beta prior from it: a source that had
 * earned `score` is seeded `α = 1 + score`, `β = 1` (one independence unit of net
 * positive evidence scaled by the old score), so its readout is non-zero and
 * monotone in the old score, then immediately re-read out as an LCB. A row that
 * already carries `alpha`/`beta` is taken verbatim. This is the documented one schema
 * risk; it never throws and never loses the source.
 */
function parseReputationRow(json: string, params: ReputationParams, repCap: Unit): ReputationState {
  const row = JSON.parse(json) as LegacyReputationRow;
  const sourceId = row.sourceId;
  const ratifiedCount = row.ratifiedCount ?? 0;
  const contradictedCount = row.contradictedCount ?? 0;
  const lastContradictionAt = (row.lastContradictionAt ?? null) as EpochMs | null;
  const lastUpdate = (row.lastUpdate ?? 0) as EpochMs;
  if (typeof row.alpha === "number" && typeof row.beta === "number") {
    return withReadout(
      { sourceId, alpha: row.alpha, beta: row.beta, ratifiedCount, contradictedCount, lastContradictionAt, lastUpdate },
      repCap,
      params,
    );
  }
  // Legacy multiplicative row: synthesize a Beta prior from the old score.
  const legacyScore = clamp(row.score ?? 0, 0, 1);
  return withReadout(
    { sourceId, alpha: 1 + legacyScore, beta: 1, ratifiedCount, contradictedCount, lastContradictionAt, lastUpdate },
    repCap,
    params,
  );
}

/**
 * Durable, WAL-mode, SQLite-backed {@link ReputationLedger}. Persists every source's
 * {@link ReputationState} as canonical JSON in `reputation(source_id PRIMARY KEY,
 * json)`, upserted on every `ratify`/`contradict`/`reverseCredit`/`disownSweep`, and
 * the disowned-source idempotency set in `reputation_disowned(source_id PRIMARY
 * KEY)`. The Beta MATH is delegated VERBATIM to the same pure functions the
 * in-memory ledger uses; this class only owns disk I/O + the cap accessor + the
 * legacy read-time migration.
 */
class SqliteReputationLedgerImpl implements SqliteReputationLedger {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;

  readonly #get;
  readonly #put;
  readonly #isDisowned;
  readonly #markDisowned;

  readonly #clock: () => EpochMs;

  constructor(
    private readonly repCapOf: (sourceId: SourceId) => Unit,
    db: DatabaseSyncType,
    ownsDb: boolean,
    private readonly params: ReputationParams,
    clock: () => EpochMs = () => asEpochMs(Date.now()),
  ) {
    this.#db = db;
    this.#ownsDb = ownsDb;
    this.#clock = clock;

    if (ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS reputation (
         source_id TEXT PRIMARY KEY,
         json      TEXT NOT NULL
       )`,
    );
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS reputation_disowned (
         source_id TEXT PRIMARY KEY
       )`,
    );

    this.#get = this.#db.prepare(
      "SELECT json FROM reputation WHERE source_id = ?",
    );
    this.#put = this.#db.prepare(
      `INSERT INTO reputation (source_id, json) VALUES (?, ?)
       ON CONFLICT(source_id) DO UPDATE SET json = excluded.json`,
    );
    this.#isDisowned = this.#db.prepare(
      "SELECT 1 FROM reputation_disowned WHERE source_id = ?",
    );
    this.#markDisowned = this.#db.prepare(
      "INSERT OR IGNORE INTO reputation_disowned (source_id) VALUES (?)",
    );
  }

  #read(sourceId: SourceId): ReputationState | null {
    const row = this.#get.get(sourceId as string);
    if (row === undefined) return null;
    const cap = this.repCapOf(sourceId);
    return parseReputationRow(repAsString(row.json), this.params, cap);
  }

  #write(state: ReputationState): void {
    this.#put.run(state.sourceId as string, JSON.stringify(state));
  }

  #ensure(sourceId: SourceId, now: EpochMs): ReputationState {
    return this.#read(sourceId) ?? newReputationState(sourceId, now);
  }

  scoreOf(sourceId: SourceId): Unit {
    const state = this.#read(sourceId);
    if (state === null) return 0 as Unit; // fresh prior => LCB 0
    // DECAY-ON-READ (PURE): decay a COPY of the parsed (already cap-migrated) α/β to
    // `now()` before the readout, so a dormant source's stamp reflects staleness
    // IMMEDIATELY. The decayed copy is NEVER #write-en back — the read is side-effect-
    // free (only mutations persist decay). Non-positive Δt is a no-op on the mass.
    const cap = clamp(this.repCapOf(sourceId), 0, 1) as Unit;
    const decayed = decay(state, cap, this.#clock(), this.params);
    return lcbReadout(decayed, cap, this.params);
  }

  ratify(sourceId: SourceId, now: EpochMs, w: number = DEFAULT_INDEPENDENCE_WEIGHT): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyRatification(this.#ensure(sourceId, now), w, cap, now, this.params);
    this.#write(next);
    return next;
  }

  contradict(sourceId: SourceId, now: EpochMs, w: number = DEFAULT_INDEPENDENCE_WEIGHT): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyContradiction(this.#ensure(sourceId, now), w, cap, now, this.params);
    this.#write(next);
    return next;
  }

  reverseCredit(sourceId: SourceId, delta: number, now: EpochMs): ReputationState {
    const cap = this.repCapOf(sourceId);
    const next = applyCreditReversal(this.#ensure(sourceId, now), delta, cap, now, this.params);
    this.#write(next);
    return next;
  }

  stateOf(sourceId: SourceId): ReputationState | null {
    return this.#read(sourceId);
  }

  disownSweep(
    sourceId: SourceId,
    assertedStrandIds: readonly StrandId[],
  ): DisownSweepResult {
    if (this.#isDisowned.get(sourceId as string) !== undefined) {
      return { clawedBack: [] };
    }
    this.#markDisowned.run(sourceId as string);

    const seen = new Set<StrandId>();
    const clawedBack: StrandId[] = [];
    for (const id of assertedStrandIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      clawedBack.push(id);
    }

    // Crater to the prior Beta(1,1) + record a contradiction. Fails CLOSED.
    const cap = this.repCapOf(sourceId);
    const prior =
      this.#read(sourceId) ?? newReputationState(sourceId, 0 as EpochMs);
    this.#write(
      withReadout(
        {
          sourceId,
          alpha: 1,
          beta: 1,
          ratifiedCount: prior.ratifiedCount,
          contradictedCount: prior.contradictedCount + 1,
          // A disown is a contradiction event: stamp the witness time so the
          // fail-closed high-impact recency gate sees a real contradiction.
          lastContradictionAt: this.#clock(),
          lastUpdate: prior.lastUpdate,
        },
        cap,
        this.params,
      ),
    );

    return { clawedBack };
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

/**
 * Construct a DURABLE, SQLite-backed {@link ReputationLedger} — a DROP-IN for
 * {@link createReputationLedger} whose Beta states survive a process restart.
 *
 * Pass EITHER a `path` (the factory opens + owns its own WAL-mode handle and its
 * `close()` shuts it) OR a shared, already-open `db` handle (so facts + trust + audit
 * live in ONE crash-consistent database file; `close()` is then a no-op).
 *
 * The optional `clock` is the witness clock the PURE decay-on-read in `scoreOf` decays
 * a copy of the persisted state to (default `Date.now()`); inject a controllable clock
 * to exercise dormancy decay deterministically.
 */
export function createSqliteReputationLedger(
  repCapOf: (sourceId: SourceId) => Unit,
  opts: { path: string; params?: ReputationParams; clock?: () => EpochMs } | {
    db: DatabaseSyncType;
    params?: ReputationParams;
    clock?: () => EpochMs;
  },
): SqliteReputationLedger {
  const params = opts.params ?? DEFAULT_REPUTATION_PARAMS;
  const clock = opts.clock ?? (() => asEpochMs(Date.now()));
  if ("path" in opts) {
    return new SqliteReputationLedgerImpl(
      repCapOf,
      new DatabaseSync(opts.path),
      true,
      params,
      clock,
    );
  }
  return new SqliteReputationLedgerImpl(repCapOf, opts.db, false, params, clock);
}
