/**
 * trustWarmup.ts — the single warm-up constant shared by every benchmark's substrate arm.
 *
 * A "primary gold" source is pre-earned by calling `reputation.ratify(s, NOW, 1)` this many
 * times so its lower-confidence-bound reputation clears the engine's decisive-or-defer gate:
 * top reputation >= `minWinnerReputation` (0.20, above the bare-key 0.05 ceiling) AND a
 * top-minus-second LCB gap >= `decisiveMargin` (0.30) over a fresh (reputation 0) challenger,
 * so a multi-class dispute RESOLVES for the gold instead of DEFERRing (see
 * `forgetting/consolidation.ts`). The value is reverse-engineered to those two policy
 * thresholds under the Beta(alpha,beta) ledger with the gold's `rep_cap` (0.95); disclosed as
 * such in `docs/INTEGRITY_AUDIT.md` §4.
 *
 * This was previously duplicated as a bare literal — 12 in the poisoning arms but 8 in
 * `retrieval/retrievers.ts` (the §4 inconsistency). Unified here so every clean-warm-up site
 * reads the same number from one place.
 *
 * NOTE: the deliberately ASYMMETRIC counts in `generalization/costlyIndependent.arm.ts`
 * (`TRUE_PRIMARY_RATIFIES = 2`, `POISON_PRIMARY_RATIFIES = 10`) are NOT this constant — that
 * bench sweeps a barely-earned truth against a reputation-buying attacker on purpose, and must
 * stay independent of the clean warm-up value.
 */
export const PRIMARY_WARMUP_RATIFIES = 12;
