/**
 * Re-export of the Phase 1c frozen ranking config from `src/recall/` so bench
 * arms keep their historical import path. The canonical module is
 * `src/recall/frozenPresentationConfig.ts` (also used by the agent facade).
 */
export {
  FROZEN_EMBEDDER_MODEL_ID,
  FROZEN_SCORE_MODE,
  FROZEN_WEIGHTS,
  FROZEN_RRF_K,
  FROZEN_UNION_TOP_N,
  FROZEN_PRESENTATION_OPTIONS,
} from "../recall/frozenPresentationConfig.js";
