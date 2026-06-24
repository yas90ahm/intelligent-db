/**
 * identity/stake.ts — SECURITY DEPOSIT / STAKING (pillar 4 of the Source-Identity Layer).
 *
 * Design grounding (CLAUDE.md "Source-Identity Layer", pillar 4 "Security deposit"):
 *
 *   > Asserting (especially *contradicting*) requires a posted stake. A bogus
 *   > claim burns the stake and, via the existing "disown a bad source"
 *   > retroactive sweep, claws back reputation across everything that anchor ever
 *   > asserted. Attacking gets *more* expensive the more you do it.
 *
 * And from the anchor-cost table row **Financial stake / bond**:
 *
 *   > Weight scales with deposit size; burns on falsity. Composable with any row
 *   > above.  independence_weight 0.30–0.85 (∝ stake), rep_cap 0.85.
 *
 * Plus the table rule:
 *
 *   > **Stake composes multiplicatively with the row it backs**, so "KYC + large
 *   > bond" is the strongest practical witness short of an external authority.
 *
 * SCOPE OF THIS MODULE (mostly SIMPLE — implemented fully here):
 *   - Post a stake for a source (the deposit that authorizes its assertions,
 *     and is *required* before a CONTRADICTING assertion is admitted).
 *   - Burn a source's stake on detected falsity (returns the burned amount so the
 *     caller can record the loss). The burn ZEROES the source's posted balance.
 *   - Query how much a source currently has posted.
 *   - Compute the stake-scaled independence weight and COMPOSE it MULTIPLICATIVELY
 *     with the base anchor-row weight it backs.
 *
 * EXPLICITLY OUT OF SCOPE (left to reputation.ts):
 *   - The retroactive "disown a bad source" sweep that claws back reputation
 *     across every strand that anchor ever asserted. This module only exposes
 *     `burn()`; the *consequences* of a burn (the reputation sweep) live in
 *     identity/reputation.ts. Keeping the accounting (here) separate from the
 *     reputation sweep (there) honors the design split between the two pillars.
 *
 * This module performs pure in-memory accounting (a ledger keyed by SourceId) and
 * a couple of pure numeric helpers. It has no algorithmic "cracks" — the staking
 * accounting is simple by design — so there are no TODO(crack-*) stubs here.
 */

import type { SourceId, Unit, EpochMs } from "../core/types.js";
import { AnchorClass } from "../core/types.js";
import { stakeIndependenceWeight } from "./anchors.js";

// ---------------------------------------------------------------------------
// Stake-class constants (mirror the anchor-cost table FINANCIAL_STAKE row)
// ---------------------------------------------------------------------------

/**
 * Lower bound of the FINANCIAL_STAKE independence-weight band (CLAUDE.md anchor
 * table: "0.30–0.85 (∝ stake)"). A minimal posted stake realizes this floor.
 */
export const FINANCIAL_STAKE_WEIGHT_MIN: Unit = 0.3;

/**
 * Upper bound of the FINANCIAL_STAKE independence-weight band (CLAUDE.md anchor
 * table: "0.30–0.85 (∝ stake)"). No deposit, however large, weighs past this.
 */
export const FINANCIAL_STAKE_WEIGHT_MAX: Unit = 0.85;

/**
 * The anchor class this module backs. A posted stake binds a source to the
 * {@link AnchorClass.FINANCIAL_STAKE} row of the anchor-cost table; its realized
 * independence weight is computed by {@link financialStakeWeight} and composed
 * multiplicatively with whatever other row it backs.
 */
export const STAKE_ANCHOR_CLASS = AnchorClass.FINANCIAL_STAKE;

// ---------------------------------------------------------------------------
// Stake record + ledger contract
// ---------------------------------------------------------------------------

/**
 * A single posted security deposit (CLAUDE.md "Security deposit — staking makes
 * lying cost something"). One per source while it has skin in the game; re-posting
 * accumulates into a single live balance for the source (see {@link StakeLedger.post}).
 */
export interface Stake {
  /** The source (passport key) that put up the deposit. */
  readonly sourceId: SourceId;
  /** Currently-posted amount (in the staking currency's units; non-negative). */
  readonly amount: number;
  /** When the current balance was last posted to (witness/file time). */
  readonly postedAt: EpochMs;
}

/**
 * In-memory ledger of posted security deposits, keyed by {@link SourceId}.
 *
 * This is the authoritative record of "who currently has skin in the game and how
 * much". The web reads `stake_posted` for an {@link IdentityStamp} from here (via
 * {@link StakeLedger.posted}); the reputation layer calls {@link StakeLedger.burn}
 * when a claim is proven false, then runs its own retroactive disown sweep.
 *
 * The ledger is a pluggable contract (like StrandStore): this file ships the
 * trivial in-memory implementation, but a durable/atomic backend could replace it
 * without changing callers.
 */
export interface StakeLedger {
  /**
   * Post (add) `amount` to `sourceId`'s deposit, stamping the time as `now`.
   *
   * Posting a stake is the precondition for asserting — and *mandatory* before a
   * CONTRADICTING assertion is admitted (CLAUDE.md: "Asserting (especially
   * *contradicting*) requires a posted stake"). Re-posting accumulates: the source
   * ends with the sum of all live posts, and `postedAt` advances to `now`.
   *
   * @param sourceId the staking source's passport key
   * @param amount   deposit to add; must be finite and > 0
   * @param now      current time, stamped onto the resulting {@link Stake}
   * @returns the source's resulting consolidated {@link Stake} after the post
   * @throws RangeError if `amount` is not a finite number strictly greater than 0
   */
  post(sourceId: SourceId, amount: number, now: EpochMs): Stake;

  /**
   * Burn (forfeit) the ENTIRE posted balance of `sourceId` — the penalty for a
   * bogus claim (CLAUDE.md: "A bogus claim burns the stake"). The source's posted
   * balance is zeroed; this method returns the amount that was burned so the caller
   * can record the loss and trigger the retroactive disown sweep in reputation.ts.
   *
   * Burning a source with no posted stake is a no-op that returns 0 (idempotent —
   * a double-burn cannot forfeit more than was posted).
   *
   * @param sourceId the source whose deposit is forfeited
   * @returns the amount burned (>= 0); 0 if nothing was posted
   */
  burn(sourceId: SourceId): number;

  /**
   * Read the amount `sourceId` currently has posted (0 if none). This is the value
   * the Source-Identity Layer copies into `IdentityStamp.stake_posted`.
   *
   * @param sourceId the source to query
   * @returns the current posted balance (>= 0)
   */
  posted(sourceId: SourceId): number;
}

// ---------------------------------------------------------------------------
// In-memory ledger implementation (the SIMPLE part — fully implemented)
// ---------------------------------------------------------------------------

/**
 * Trivial in-memory {@link StakeLedger}. Authoritative record of posted deposits
 * for the lifetime of the process; swap for a durable backend later without
 * touching callers.
 *
 * Invariants this implementation upholds:
 *   - A source's posted balance is always >= 0.
 *   - `posted(s)` equals the sum of all live `post(s, …)` minus a `burn(s)` reset.
 *   - `burn` zeroes the balance and reports exactly what was forfeited.
 */
class InMemoryStakeLedger implements StakeLedger {
  /** SourceId -> current consolidated stake. Absent key === zero posted. */
  private readonly book = new Map<SourceId, Stake>();

  post(sourceId: SourceId, amount: number, now: EpochMs): Stake {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new RangeError(
        `StakeLedger.post: amount must be a finite number > 0, got ${String(amount)}`,
      );
    }
    const prior = this.book.get(sourceId);
    const next: Stake = {
      sourceId,
      amount: (prior?.amount ?? 0) + amount,
      postedAt: now,
    };
    this.book.set(sourceId, next);
    return next;
  }

  burn(sourceId: SourceId): number {
    const prior = this.book.get(sourceId);
    if (prior === undefined) return 0;
    // Forfeit the whole balance: remove the entry so posted() reads 0 afterward.
    this.book.delete(sourceId);
    return prior.amount;
  }

  posted(sourceId: SourceId): number {
    return this.book.get(sourceId)?.amount ?? 0;
  }
}

/**
 * Construct a fresh, empty {@link StakeLedger} (the in-memory implementation).
 *
 * @returns a new ledger with no posted stakes
 */
export function createStakeLedger(): StakeLedger {
  return new InMemoryStakeLedger();
}

// ---------------------------------------------------------------------------
// Stake-scaled independence weight (the multiplicative composition)
// ---------------------------------------------------------------------------

/**
 * Map a posted stake amount to the FINANCIAL_STAKE row's realized independence
 * weight in the band [{@link FINANCIAL_STAKE_WEIGHT_MIN},
 * {@link FINANCIAL_STAKE_WEIGHT_MAX}] = [0.30, 0.85] (CLAUDE.md anchor table:
 * "0.30–0.85 (∝ stake)").
 *
 * The actual shape of "∝ stake" (the curve from amount to position within the
 * band) is the anchors module's responsibility — it owns the anchor-cost table
 * and its tuning knobs. This helper simply delegates to
 * {@link stakeIndependenceWeight} so there is a single source of truth for the
 * curve, and is re-exported here for ergonomics from the staking module.
 *
 * @param stake the source's currently-posted stake amount (>= 0)
 * @returns the realized independence weight in [0.30, 0.85]; the MIN floor for a
 *          zero/near-zero stake, asymptotically approaching the MAX ceiling
 */
export function financialStakeWeight(stake: number): Unit {
  return stakeIndependenceWeight(stake);
}

/**
 * Compose a posted stake MULTIPLICATIVELY with the base anchor-row weight it backs
 * (CLAUDE.md table rule: "Stake composes multiplicatively with the row it backs",
 * making "KYC + large bond" the strongest practical witness short of an external
 * authority).
 *
 * The composition multiplies the base row's weight by an *amplification* factor
 * derived from the stake's own realized independence weight. Concretely the stake
 * weight `sw ∈ [0.30, 0.85]` is turned into a multiplier `1 + sw` so that:
 *   - a minimal stake (`sw ≈ 0.30`) lifts the backed row by ~1.30×, and
 *   - a maximal stake (`sw ≈ 0.85`) lifts it by ~1.85×,
 * i.e. more skin in the game multiplies the witness's strength, never weakens it,
 * and the lift is monotone increasing in stake. The result is clamped to the [0,1]
 * Unit range so a stacked stake can never push a backed weight out of bounds
 * (no self-stacking past the legal ceiling — see the table's anti-self-stack rule).
 *
 * NOTE: this is composition of a *single* source's stake with *its own* backing
 * row. It is NOT the cross-source independence (set-disjointness) computation,
 * which lives in anchors.ts.
 *
 * @param baseWeight the backed anchor row's independence weight, in [0,1]
 * @param stake      the source's currently-posted stake amount (>= 0)
 * @returns the composed independence weight in [0,1]
 */
export function stakeMultiplier(baseWeight: number, stake: number): number {
  const sw = financialStakeWeight(stake);
  const composed = baseWeight * (1 + sw);
  return clampUnit(composed);
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Clamp a number into the [0,1] {@link Unit} range. Pure, total. */
function clampUnit(x: number): Unit {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
