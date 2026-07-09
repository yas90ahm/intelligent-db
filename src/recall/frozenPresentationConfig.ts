/**
 * frozenPresentationConfig.ts — Phase 1c frozen ranking config
 * (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "Protocol": "FREEZE ONE config
 * (mode, weights, embedder, unionTopN)"), measured on the real LoCoMo DEV split via
 * `src/__bench__/retrieval/locomoCalibrationRunner.test.ts`:
 *
 *   - FROZEN (best ELIGIBLE config): nomic-embed-text, `'rrf'` scoreMode, `k=60`,
 *     `wState=0.1` (wCos/wWalk unused — RRF ignores them), unionTopN=128 —
 *     TEST recall@20 = 0.481 vs mem0 0.484 (0.003 short; stuffing-gate eligible).
 *   - The entire Phase 1c linear grid fails the embedding-stuffing gate; ONLY
 *     `'rrf'` ships. Do NOT substitute a linear cosine mix.
 *
 * Full numbers: `.arbor/sessions/retrieval-quality/experiments/1.1.1.1.5.calibration/`.
 *
 * This module is the SINGLE SOURCE the frozen-config adversarial gates and the
 * agent-facade opt-in blend path import so "re-run the gates on the frozen
 * config" / "opt-in blend uses the calibrated winner" stay literally true.
 * Default PERSONAL recall remains walk-mode; callers pass `rankMode: 'blend'`
 * to apply these options.
 */

import type { PresentationScoreMode, PresentationWeights, RecallOptions } from "./presentationRank.js";

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
