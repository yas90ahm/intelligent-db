/**
 * frozenPresentationConfig.ts — Phase 1c frozen ranking config
 * (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "Protocol": "FREEZE ONE config
 * (mode, weights, embedder, unionTopN)"), measured on the real LoCoMo DEV split via
 * `src/__bench__/retrieval/locomoCalibrationRunner.test.ts`:
 *
 *   - DEV sweep: the Phase 1c finer linear grid (wCos in {0.8,0.9,1.0}, wWalk in
 *     {0.0,0.05,0.1,0.3}, wState fixed 0.1) PLUS the new 'rrf' scoreMode, per
 *     embedder (MiniLM vs nomic-embed-text via Ollama) — 26 combos total.
 *   - RAW DEV winner (by recall@20 alone, ignoring shippability): nomic-embed-text,
 *     'linear', wCos=0.8/wWalk=0.1/wState=0.1 (DEV recall@20 = 0.493) — but this
 *     FAILS the stuffing-gate eligibility check below, so it does not ship.
 *   - STUFFING-GATE ELIGIBILITY (spec gate note, checked over the WHOLE grid, not
 *     just `wWalk=0`): does the LIVE incumbent (cosine 0.6, strong walk energy)
 *     still rank top-5 against 8 cosine-EXACTLY-1.0 attacker candidates? Empirically
 *     the ENTIRE Phase 1c linear grid fails this (a cosine-1.0-vs-0.6 gap needs
 *     `wWalk > wCos*(0.4-0.15*wState)`, and the grid's max wWalk=0.3 falls just short
 *     for every wCos tested) — ONLY `'rrf'` passes, exactly the scale-free
 *     robustness against a raw-magnitude-dominated attacker the spec's design
 *     rationale predicts for rank fusion vs a hand-tuned linear mix.
 *   - FROZEN (best ELIGIBLE config): nomic-embed-text, `'rrf'` scoreMode, `k=60`,
 *     `wState=0.1` (wCos/wWalk unused — RRF ignores them), unionTopN=128 (1b's
 *     frozen width, reused verbatim) — DEV recall@20 = 0.477.
 *   - TEST (same run): Calibrated recall@20 = 0.481 vs the 0.484 gate (mem0,
 *     same-run TEST number 0.484) — FALL SHORT by 0.003, reported honestly (the
 *     un-shippable raw linear winner would have exceeded 0.484 at 0.493; the one
 *     config that actually passes the adversarial stuffing gate falls just short —
 *     see the experiment's results.md for the full table).
 *
 * Full numbers: `.arbor/sessions/retrieval-quality/experiments/1.1.1.1.5.calibration/`.
 *
 * This module is the SINGLE SOURCE the frozen-config adversarial gates
 * (`src/__bench__/crossdb/embedderSybilGateBlend.test.ts`,
 * `src/__tests__/embeddingStuffingBlend.test.ts`,
 * `src/__bench__/factworld/embedderSeededSubstrateBlend.test.ts`) import so
 * "re-run the gates on the frozen config" is literally true — the same object, not
 * a re-typed copy that could drift from the measured winner.
 */

import type { PresentationScoreMode, PresentationWeights, RecallOptions } from "../index.js";

export const FROZEN_EMBEDDER_MODEL_ID = "ollama:nomic-embed-text";
export const FROZEN_SCORE_MODE: PresentationScoreMode = "rrf";
export const FROZEN_WEIGHTS: PresentationWeights = { wCos: 0, wWalk: 0, wState: 0.1 };
export const FROZEN_RRF_K = 60;
export const FROZEN_UNION_TOP_N = 128;

/** Full `RecallOptions` for the frozen Phase 1c config, `rankMode: 'blend'` explicit. */
export const FROZEN_PRESENTATION_OPTIONS: RecallOptions = {
  rankMode: "blend",
  scoreMode: FROZEN_SCORE_MODE,
  weights: FROZEN_WEIGHTS,
  rrfK: FROZEN_RRF_K,
  unionTopN: FROZEN_UNION_TOP_N,
};
