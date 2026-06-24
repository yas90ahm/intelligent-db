/**
 * identity/anchors.ts — THE ANCHOR-COST TABLE as data, plus the independence
 * (set-disjointness) and rep_cap rules from CLAUDE.md's Source-Identity Layer.
 *
 * Design grounding (see CLAUDE.md "Anchor-cost table" and its "Rules for the
 * table"):
 *
 *  - An **anchor** measures independence against scarce external roots, never
 *    declared. Each passport key binds to one or more anchors (domain, verified
 *    human, org, device attestation, posted stake) — things costly/rate-limited
 *    in the real world.
 *
 *  - **Independence between two sources = set-disjointness of their anchor
 *    sets, weighted by anchor cost.** Two sources sharing ANY anchor are not
 *    independent on that anchor; independence is driven by their NON-OVERLAPPING
 *    costly anchors. This is "identity is priced, not prevented" made
 *    mechanical: the web is handed the price and weighs cheap identities cheap.
 *
 *  - **`rep_cap` binds the ceiling.** It is the maximum reputation a source
 *    rooted ONLY in that class may ever earn — a cheap anchor can never climb to
 *    high trust no matter how long it behaves. A KYC source is not born trusted;
 *    it can merely eventually reach 0.90.
 *
 *  - **Stake composes MULTIPLICATIVELY with the row it backs.** Its weight
 *    scales with the deposit size (0.30–0.85 ∝ stake) and burns on falsity, so
 *    "KYC + large bond" is the strongest practical witness short of an external
 *    authority.
 *
 *  - **No self-stacking.** A single source must not fake one expensive anchor by
 *    stacking ten cheap ones; a single source's own aggregate is SUBLINEAR in
 *    its anchor count.
 *
 *  - The whole table is **one swappable trust root** (like a Certificate
 *    Authority set). Changing which classes you accept and their weights IS the
 *    security policy. That is the intended knob.
 *
 * This module is mostly a SIMPLE part: the table and the disjointness math are
 * implemented fully. The only genuinely non-trivial self-stacking cap is left as
 * a marked stub where its precise sublinear shape is a tuning decision.
 *
 * Depends only on the shared contract in core/types.ts; no runtime deps.
 */

import {
  AnchorClass,
  type AnchorBinding,
  type Unit,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// AnchorSpec + the table
// ---------------------------------------------------------------------------

/**
 * One row of the anchor-cost table: the static policy for an anchor class.
 *
 * `independenceWeight` is what one anchor of this class contributes to the
 * independence score between two sources whose anchor sets are disjoint.
 *
 * `repCap` is the maximum reputation a source rooted ONLY in this class may ever
 * earn — a ceiling, not a starting point (reputation still has to be earned up
 * to it).
 *
 * `stakeScaled`, when true, marks a class whose realized `independenceWeight`
 * is not the fixed table number but a function of the posted stake (see
 * {@link stakeIndependenceWeight}). Only FINANCIAL_STAKE sets this.
 */
export interface AnchorSpec {
  /** The class this row describes. */
  class: AnchorClass;
  /**
   * Independence contribution in [0,1] of one disjoint anchor of this class.
   * For stake-scaled rows this is the FLOOR of the scaled range; the realized
   * value is computed from the deposit by {@link stakeIndependenceWeight}.
   */
  independenceWeight: Unit;
  /** Reputation ceiling in [0,1] for a source rooted only in this class. */
  repCap: Unit;
  /** True iff `independenceWeight` scales with posted stake (FINANCIAL_STAKE). */
  stakeScaled?: boolean;
}

/** Lower bound of the FINANCIAL_STAKE independence-weight range (∝ stake). */
export const STAKE_INDEPENDENCE_MIN: Unit = 0.3;
/** Upper bound of the FINANCIAL_STAKE independence-weight range (∝ stake). */
export const STAKE_INDEPENDENCE_MAX: Unit = 0.85;

/**
 * The anchor-cost table, transcribed EXACTLY from CLAUDE.md. Every row is
 * present, keyed by {@link AnchorClass}. Numbers are the design's illustrative
 * starting points — they are the security policy and are meant to be tuned.
 *
 * | class                | independence_weight | rep_cap |
 * |----------------------|---------------------|---------|
 * | BARE_KEY             | 0.00                | 0.05    |
 * | EMAIL_OAUTH          | 0.10                | 0.30    |
 * | PHONE_SIM            | 0.20                | 0.40    |
 * | DOMAIN               | 0.35                | 0.60    |
 * | HARDWARE_ATTESTATION | 0.45                | 0.65    |
 * | VERIFIED_HUMAN       | 0.70                | 0.90    |
 * | ORGANIZATION         | 0.75                | 0.92    |
 * | FINANCIAL_STAKE      | 0.30–0.85 (∝ stake) | 0.85    |
 * | EXTERNAL_AUTHORITY   | 0.90                | 0.98    |
 */
export const ANCHOR_TABLE: Record<AnchorClass, AnchorSpec> = {
  [AnchorClass.BARE_KEY]: {
    class: AnchorClass.BARE_KEY,
    independenceWeight: 0.0,
    repCap: 0.05,
  },
  [AnchorClass.EMAIL_OAUTH]: {
    class: AnchorClass.EMAIL_OAUTH,
    independenceWeight: 0.1,
    repCap: 0.3,
  },
  [AnchorClass.PHONE_SIM]: {
    class: AnchorClass.PHONE_SIM,
    independenceWeight: 0.2,
    repCap: 0.4,
  },
  [AnchorClass.DOMAIN]: {
    class: AnchorClass.DOMAIN,
    independenceWeight: 0.35,
    repCap: 0.6,
  },
  [AnchorClass.HARDWARE_ATTESTATION]: {
    class: AnchorClass.HARDWARE_ATTESTATION,
    independenceWeight: 0.45,
    repCap: 0.65,
  },
  [AnchorClass.VERIFIED_HUMAN]: {
    class: AnchorClass.VERIFIED_HUMAN,
    independenceWeight: 0.7,
    repCap: 0.9,
  },
  [AnchorClass.ORGANIZATION]: {
    class: AnchorClass.ORGANIZATION,
    independenceWeight: 0.75,
    repCap: 0.92,
  },
  [AnchorClass.FINANCIAL_STAKE]: {
    class: AnchorClass.FINANCIAL_STAKE,
    // Floor of the 0.30–0.85 ∝-stake range; realized value via stakeIndependenceWeight.
    independenceWeight: STAKE_INDEPENDENCE_MIN,
    repCap: 0.85,
    stakeScaled: true,
  },
  [AnchorClass.EXTERNAL_AUTHORITY]: {
    class: AnchorClass.EXTERNAL_AUTHORITY,
    independenceWeight: 0.9,
    repCap: 0.98,
  },
};

// ---------------------------------------------------------------------------
// Stake → independence weight (the ∝-stake row, fully implemented)
// ---------------------------------------------------------------------------

/**
 * Reference deposit at which a FINANCIAL_STAKE anchor realizes its FULL weight
 * ({@link STAKE_INDEPENDENCE_MAX}). Below this, weight scales up from the floor;
 * at or above it, weight saturates. This is a policy knob, not a law of nature.
 */
export const STAKE_SATURATION_DEPOSIT = 1000;

/**
 * Map a posted stake (deposit size, same units as {@link STAKE_SATURATION_DEPOSIT})
 * to the realized independence weight of a FINANCIAL_STAKE anchor, in the design's
 * 0.30–0.85 range.
 *
 * Behaviour (CLAUDE.md "Weight scales with deposit size"):
 *  - stake <= 0           → the floor (STAKE_INDEPENDENCE_MIN, 0.30).
 *  - 0 < stake < sat      → linearly interpolated between floor and max.
 *  - stake >= saturation  → the max (STAKE_INDEPENDENCE_MAX, 0.85); never higher.
 *
 * Pure and total; clamps into [STAKE_INDEPENDENCE_MIN, STAKE_INDEPENDENCE_MAX].
 *
 * @param stake Posted deposit backing the source's assertions.
 * @returns Realized independence weight for the stake anchor, in [0.30, 0.85].
 */
export function stakeIndependenceWeight(stake: number): Unit {
  if (!Number.isFinite(stake) || stake <= 0) {
    return STAKE_INDEPENDENCE_MIN;
  }
  const span = STAKE_INDEPENDENCE_MAX - STAKE_INDEPENDENCE_MIN;
  const fraction = Math.min(stake / STAKE_SATURATION_DEPOSIT, 1);
  return STAKE_INDEPENDENCE_MIN + span * fraction;
}

// ---------------------------------------------------------------------------
// rep_cap rule (fully implemented)
// ---------------------------------------------------------------------------

/**
 * The reputation ceiling for a source given its full anchor set.
 *
 * `rep_cap` binds the ceiling: a source can only ever earn up to the BEST cap
 * among its anchors. A source rooted only in cheap classes therefore stays
 * permanently low-trust no matter how long it behaves; binding a costlier anchor
 * raises the ceiling (but reputation still has to be earned up to it — this
 * function returns the ceiling, not the current reputation).
 *
 * An empty anchor set is treated as a bare key (CLAUDE.md: bare-key is the
 * default for anonymous input), yielding the BARE_KEY cap of 0.05.
 *
 * @param anchors The source's anchor bindings.
 * @returns The maximum reputation this source may ever earn, in [0,1].
 */
export function repCapFor(anchors: AnchorBinding[]): Unit {
  if (anchors.length === 0) {
    return ANCHOR_TABLE[AnchorClass.BARE_KEY].repCap;
  }
  let cap = 0;
  for (const binding of anchors) {
    const spec = ANCHOR_TABLE[binding.anchorClass];
    if (spec.repCap > cap) {
      cap = spec.repCap;
    }
  }
  return cap;
}

/**
 * Aggregate (SUBLINEAR) anchor cost for ONE source — the "price" of its identity
 * the stamp carries. Sublinear in the source's anchor count so a source cannot
 * self-stack ten cheap anchors to fake one expensive one (CLAUDE.md "Rules for the
 * table"): the realized cost is the source's STRONGEST SINGLE realized anchor cost,
 * never a sum. An empty anchor set prices at 0 (bare/anonymous input).
 *
 * Pure and total; result in [0,1] (each `realizedCost` already is).
 *
 * @param anchors The source's anchor bindings.
 * @returns The sublinear aggregate anchor cost in [0,1].
 */
export function aggregateAnchorCost(anchors: readonly AnchorBinding[]): Unit {
  let best = 0;
  for (const a of anchors) {
    if (a.realizedCost > best) best = a.realizedCost;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Independence = set-disjointness, weighted by cost (fully implemented)
// ---------------------------------------------------------------------------

/**
 * The independence between two sources, as the set-disjointness of their anchor
 * sets weighted by anchor cost — NOT an addition of their individual costs.
 *
 * Mechanics (CLAUDE.md "Rules for the table"):
 *
 *  1. **Shared anchors carry NO independence.** Any anchor class present in BOTH
 *     sources is an echo on that axis: it is excluded from the score entirely.
 *     Independence is driven only by their NON-OVERLAPPING (disjoint) anchors.
 *
 *  2. **Weighted by cost.** Each disjoint anchor contributes its own realized
 *     `independenceWeight` (already stake-scaled by the stamp producer for
 *     FINANCIAL_STAKE bindings). Costlier disjoint anchors move the score more.
 *
 *  3. **Sublinear in own count.** A source's disjoint contribution is combined
 *     SUBLINEARLY so it cannot self-stack ten cheap anchors to fake one
 *     expensive one. We combine per source with a probabilistic-OR-style
 *     "noisy-OR" reduction — adding a second cheap anchor yields diminishing
 *     marginal independence, and the combined value can never exceed the single
 *     strongest disjoint anchor by much. (See {@link combineSublinear}.)
 *
 *  4. **The pair score is the MIN of the two sides' disjoint strengths.** Two
 *     sources are only as independent as the weaker of their non-overlapping
 *     roots: a lone strong anchor on one side does not, by itself, make the pair
 *     independent if the other side brings nothing disjoint. This is the
 *     "caps at the cost of their cheapest shared root being absent" intuition —
 *     mutual disjoint backing is required, not one-sided.
 *
 * Result is in [0,1]: 0 = pure echo (identical or empty anchor sets), → 1 as
 * both sides bring strong, fully-disjoint, costly anchors.
 *
 * Pure and total.
 *
 * @param a Anchor bindings of source A.
 * @param b Anchor bindings of source B.
 * @returns Independence between A and B in [0,1].
 */
export function independenceBetween(
  a: AnchorBinding[],
  b: AnchorBinding[],
): Unit {
  const classesA = new Set(a.map((x) => x.anchorClass));
  const classesB = new Set(b.map((x) => x.anchorClass));

  // Rule 1: a class present in BOTH sets is a shared root (echo) on that axis
  // and contributes nothing. Keep only each side's disjoint bindings.
  const disjointA = a.filter((x) => !classesB.has(x.anchorClass));
  const disjointB = b.filter((x) => !classesA.has(x.anchorClass));

  // Rule 2 + 3: per side, combine the disjoint anchors' weights sublinearly,
  // then apply the LADDER-AWARE self-stack cap so a pile of cheap disjoint
  // anchors can never forge the weight of a costlier class the source does not
  // actually hold (CLAUDE.md "Don't let a source self-stack ten cheap anchors to
  // fake one expensive one"). The cap is keyed off the disjoint bindings that are
  // actually being combined on each side.
  const strengthA = applySelfStackCap(
    disjointA,
    combineSublinear(disjointA.map((x) => x.independenceWeight)),
  );
  const strengthB = applySelfStackCap(
    disjointB,
    combineSublinear(disjointB.map((x) => x.independenceWeight)),
  );

  // Rule 4: the pair is only as independent as the weaker disjoint side.
  return Math.min(strengthA, strengthB);
}

/**
 * Combine a set of per-anchor independence weights for ONE source into a single
 * sublinear strength in [0,1].
 *
 * Uses a noisy-OR reduction: `1 - Π(1 - w_i)`. Properties this gives us, all of
 * which the design demands:
 *  - Monotone: adding an anchor never lowers the strength.
 *  - Bounded by 1: never exceeds full independence.
 *  - SUBLINEAR / diminishing returns: stacking many cheap anchors approaches but
 *    cannot leap past a single expensive one (e.g. ten 0.10 email anchors give
 *    ~0.65, still below a lone 0.70 KYC), so self-stacking can't forge a costly
 *    root. This is the anti-self-stacking guarantee in CLAUDE.md's rules.
 *
 * NOTE: noisy-OR is the SIMPLE, defensible default. A stricter "no stack of
 * cheap anchors may ever reach the weight of the next class up" cap — which
 * would require knowing the per-class ladder spacing — is the genuinely
 * non-trivial tuning piece and is deferred below.
 *
 * @param weights Per-anchor independence weights, each in [0,1].
 * @returns Combined sublinear strength in [0,1].
 */
export function combineSublinear(weights: number[]): Unit {
  let complement = 1;
  for (const w of weights) {
    const clamped = w < 0 ? 0 : w > 1 ? 1 : w;
    complement *= 1 - clamped;
  }
  return 1 - complement;
}

/**
 * Hard sublinear SELF-STACKING CAP — ladder-aware, LOAD-BEARING.
 *
 * GUARANTEE: a single source's combined independence from a stack of anchors all
 * in classes STRICTLY BELOW some class C can never reach
 * `ANCHOR_TABLE[C].independenceWeight`. Stacking cheap anchors can never forge
 * the weight of a costlier class the source does NOT hold. The noisy-OR in
 * {@link combineSublinear} only gives diminishing returns (ten 0.10 emails →
 * ~0.65, which WOULD cross DOMAIN's 0.35 and even HARDWARE's 0.45); this adds the
 * strict ladder ceiling that closes that gap.
 *
 * THE CURVE (and why it satisfies the guarantee):
 *
 *   ceiling = max over the source's bindings of `binding.independenceWeight`
 *           = the realized weight of the source's STRONGEST SINGLE anchor
 *   capped  = min(combined, ceiling)
 *
 * Justification against the anchor-cost table (BARE_KEY 0 / EMAIL 0.10 /
 * PHONE 0.20 / DOMAIN 0.35 / HARDWARE 0.45 / VERIFIED_HUMAN 0.70 / ORG 0.75 /
 * STAKE 0.30–0.85 ∝ stake / EXTERNAL 0.90):
 *
 *  - A source's noisy-OR over its disjoint anchors converges toward but never
 *    reaches 1. Clamping it to its OWN strongest single realized weight makes a
 *    stack worth AT MOST that one best anchor — never more. So if the source
 *    holds NO anchor in class C or above, its strongest weight is some w < the
 *    weight of C, and therefore its combined value is < C's weight too. A stack
 *    of classes all strictly below C can never reach C's weight. ∎
 *  - This uses the REALIZED `independenceWeight` carried on each binding, which
 *    the stamp producer already stake-scaled for FINANCIAL_STAKE rows. So a large
 *    bond raises the ceiling exactly as much as the bond is worth — "KYC + large
 *    bond" stays the strongest practical witness, never clamped below its bond.
 *
 * Effect on real cases:
 *  - 10× EMAIL stack: combineSublinear ≈ 1−0.9¹⁰ ≈ 0.651, but the ceiling is the
 *    strongest single EMAIL weight 0.10 ⇒ capped to 0.10. Never reaches DOMAIN's
 *    0.35. (The whole point of TASK B.)
 *  - A genuine single DOMAIN: combined = 0.35, ceiling = 0.35 ⇒ min = 0.35,
 *    UNAFFECTED. A single strong anchor is never penalized.
 *  - Empty stack: max over no bindings = 0, combined from combineSublinear([]) is
 *    already 0 ⇒ stays 0 (a bare/echo side contributes no independence).
 *
 * Pure and total. The result is in [0,1] because `combined` and every
 * `independenceWeight` already are.
 *
 * @param anchors A single source's (disjoint) anchor bindings being combined.
 * @param combined The noisy-OR combined strength from {@link combineSublinear}.
 * @returns The capped combined strength in [0,1].
 */
export function applySelfStackCap(
  anchors: AnchorBinding[],
  combined: Unit,
): Unit {
  // Ceiling = the source's strongest SINGLE realized anchor weight. With no
  // bindings the ceiling is 0 (nothing disjoint to contribute).
  let ceiling = 0;
  for (const binding of anchors) {
    const w = binding.independenceWeight;
    if (w > ceiling) ceiling = w;
  }
  return combined < ceiling ? combined : ceiling;
}
