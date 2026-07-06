/**
 * recall/presentationRank.ts — Phase 1b: BLENDED PRESENTATION RANKING
 * (docs/specs/PHASE1B_RANKING_SPEC.md, Design §1-4).
 *
 * THE THESIS LINE (unchanged, sharpened — see the spec):
 *   - BELIEF (`fact_state`, adjudication, independence, reputation, eviction)
 *     NEVER reads similarity. This module writes NOTHING and calls none of
 *     that machinery; it only re-orders / widens the OUTPUT of an
 *     ALREADY-COMPLETED activation walk.
 *   - PRESENTATION — the order in which already-surfaced, correctly-labeled
 *     candidates are returned to the caller — MAY use similarity. Ordering a
 *     reading list is not witnessing; every item still carries its real
 *     `fact_state` and provenance regardless of rank.
 *
 * §1 — `RankMode`: `'walk' | 'blend'`, threaded via {@link RecallOptions}.
 *   `'walk'` (the default — ABSENT `rankMode` behaves identically) is a pure
 *   passthrough: the walk's own lit set, in the walk's own order, completely
 *   untouched. `'blend'` opts into the union + score below.
 *
 * §2 — the UNION candidate set: (walk lit set) UNION (cosine top-N over the
 *   `strand_vectors` sidecar, default N=64 — {@link DEFAULT_UNION_TOP_N}),
 *   DEDUPED BY CONTENT_HASH. The union may only ADD candidates — it never
 *   removes or re-states anything the walk surfaced: every walk-lit
 *   candidate keeps EXACTLY the `factState` / `walkEnergy` the walk gave it;
 *   a cosine match landing on a content_hash the walk already surfaced only
 *   ANNOTATES that existing candidate with a cosine score for scoring
 *   purposes — it is never duplicated or restated as a second entry.
 *
 * §3 — the presentation score (RE-DERIVED for Phase 1c,
 *   `docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md`, to stay coherent across BOTH
 *   {@link PresentationScoreMode}s):
 *
 *   1. A RAW FUSION SCORE that never reads `fact_state`:
 *      - `'linear'` mode: `raw = wCos * cosine(cue, strand) + wWalk * normalizedWalkEnergy`.
 *      - `'rrf'` mode (reciprocal-rank fusion): `raw = 1/(k + cosineRank) + 1/(k +
 *        walkRank)`, where `cosineRank`/`walkRank` are 1-indexed ORDINAL ranks
 *        (ties broken by `strandId` ascending) of this candidate within the
 *        CURRENT candidate set by cosine / raw walk energy descending, and `k`
 *        defaults to {@link DEFAULT_RRF_K} (60). Rank fusion is scale-free — it
 *        never needs `cosine` and `walkEnergy` to share a distribution, unlike the
 *        hand-tuned linear mix.
 *   2. `stateWeight` ({@link STATE_WEIGHT}: LIVE 1.0, PROVISIONAL 0.85, DEMOTED
 *      0.4 — config-overridable constants) applies as a POST-FUSION MULTIPLIER,
 *      IDENTICALLY in both modes: `score = raw * (1 - wState * (1 - stateWeight))`.
 *      At `wState=0` the multiplier is exactly 1 (no effect); at `wState=1` it
 *      collapses to `stateWeight` itself. LIVE always multiplies by exactly 1
 *      regardless of `wState` — the nudge only ever discounts non-LIVE
 *      candidates, never boosts LIVE above its own raw fusion score. A
 *      multiplier (not Phase 1b's additive term) is what keeps the nudge
 *      meaningful alongside RRF's small, bounded `raw` range (`<= 2/(k+1)`) — an
 *      additive `wState*stateWeight` term of Phase-1b's magnitude would swamp an
 *      RRF fusion score outright. It reads `fact_state`, it never sets it, and
 *      exists so a quarantined (PROVISIONAL) flood cannot crowd the top ranks
 *      ahead of a LIVE incumbent purely on cosine/energy.
 *   - `normalizedWalkEnergy` is `walkEnergy` min-max normalized WITHIN the
 *     candidate set at hand (0 for a union-added candidate the walk never
 *     lit — this falls out of the min-max normalization for free, since a
 *     union-added candidate's raw `walkEnergy` is exactly 0 and 0 always
 *     participates in the observed minimum). RRF mode still reports this field
 *     for transparency but ranks on raw `walkEnergy` order (order-invariant
 *     under the monotonic normalization).
 *   - Weights ({@link PresentationWeights}) default to
 *     {@link DEFAULT_PRESENTATION_WEIGHTS}. Phase 1b's sweep grid: wCos in
 *     {0.5,0.7,0.9}, wWalk in {0.1,0.3,0.5}, wState fixed 0.1. Phase 1c's finer
 *     grid: wCos in {0.8,0.9,1.0}, wWalk in {0.0,0.05,0.1,0.3}, wState fixed 0.1,
 *     PLUS the `'rrf'` {@link PresentationScoreMode} as an alternative to the
 *     whole linear grid — see `docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md`
 *     for the frozen winner.
 *     Fully config-overridable via {@link RecallOptions.weights} /
 *     {@link RecallOptions.scoreMode} / {@link RecallOptions.rrfK}.
 *
 * §4 — rendering/labels unchanged: this module never touches `Strand`,
 *   never computes `fact_state`, and returns plain data the caller renders
 *   exactly as it always has (`CitedFact.fact_state`, provenance, and
 *   dispute surfacing are all read downstream, untouched by this module).
 *
 * ZERO external deps. Pure functions operate on plain candidate arrays so
 * they are trivially unit-testable without a store; {@link cosineTopNCandidates}
 * and {@link rankRecallResult} are the concrete integration with a real
 * {@link StrandStore} + {@link VectorSidecar} for a caller (bench arm or
 * agent facade) that wants to actually run blend mode end-to-end.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`
 * ⇒ every type-only import uses `import type`.
 */

import { FactState } from "../core/types.js";
import type { ContentHash, LitStrand, StrandId } from "../core/types.js";
import type { StrandStore } from "../store/StrandStore.js";
import type { VectorSidecar } from "../store/vectorSidecar.js";
import type { RecallResult } from "../api.js";

// ---------------------------------------------------------------------------
// §1 — rankMode + RecallOptions
// ---------------------------------------------------------------------------

/** Presentation ranking mode (spec §1). Default `'walk'` — zero behavior change. */
export type RankMode = "walk" | "blend";

/**
 * Phase 1c (`docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md`): how a `'blend'`-mode
 * raw fusion score is computed BEFORE the §3 stateWeight post-fusion multiplier.
 * `'linear'` (default) is the Phase 1b hand-tuned weighted sum
 * (`wCos*cosine + wWalk*normalizedWalkEnergy`); `'rrf'` is reciprocal-rank fusion
 * over the candidate's cosine rank and walk-energy rank. Only meaningful when
 * `rankMode: 'blend'` — ignored (never read) in `'walk'` mode.
 */
export type PresentationScoreMode = "linear" | "rrf";

/** Default RRF constant `k` (spec: "k=60 default"). */
export const DEFAULT_RRF_K = 60;

/** Weights for the §3 presentation score. All three are dimensionless, additive terms. */
export interface PresentationWeights {
  /** Weight on `cosine(cue, strand)`. */
  readonly wCos: number;
  /** Weight on the min-max normalized walk energy. */
  readonly wWalk: number;
  /** Weight on the fact_state nudge ({@link STATE_WEIGHT}). */
  readonly wState: number;
}

/**
 * The frozen middle point of the spec §3 sweep grid — see this module's
 * header doc for why it is a documented placeholder, not yet a
 * measurement-frozen default.
 */
export const DEFAULT_PRESENTATION_WEIGHTS: PresentationWeights = {
  wCos: 0.7,
  wWalk: 0.3,
  wState: 0.1,
};

/**
 * Default union candidate count (spec §2's `N=64`) pulled from the
 * `strand_vectors` sidecar in blend mode.
 */
export const DEFAULT_UNION_TOP_N = 64;

/**
 * Options threaded through the presentation-ranking layer (spec §1-3).
 * Absent (or `rankMode: 'walk'`) ⇒ byte-identical to today's behavior.
 */
export interface RecallOptions {
  /** `'walk'` (default) or `'blend'`. */
  readonly rankMode?: RankMode;
  /** Override the union candidate count (default {@link DEFAULT_UNION_TOP_N}). */
  readonly unionTopN?: number;
  /** Override any subset of {@link DEFAULT_PRESENTATION_WEIGHTS}. */
  readonly weights?: Partial<PresentationWeights>;
  /** `'linear'` (default) or `'rrf'` — only meaningful when `rankMode: 'blend'`. */
  readonly scoreMode?: PresentationScoreMode;
  /** RRF constant `k` (default {@link DEFAULT_RRF_K}); ignored outside `'rrf'` scoreMode. */
  readonly rrfK?: number;
}

// ---------------------------------------------------------------------------
// §3 — stateWeight constants
// ---------------------------------------------------------------------------

/**
 * The presentation-only `fact_state` nudge (spec §3): LIVE 1.0, PROVISIONAL
 * 0.85, DEMOTED 0.4. `COLD` carries no spec value; it falls back to
 * DEMOTED's weight (0.4) — a conservative floor, never a crash, since an
 * evicted strand should never outrank a LIVE/PROVISIONAL one on this term.
 * Reads `fact_state`; never sets it. Config-overridable via
 * {@link stateWeightOf}'s `overrides` param.
 */
export const STATE_WEIGHT: Readonly<Record<FactState, number>> = {
  [FactState.LIVE]: 1.0,
  [FactState.PROVISIONAL]: 0.85,
  [FactState.DEMOTED]: 0.4,
  [FactState.COLD]: 0.4,
};

/** Resolve a candidate's stateWeight, honoring any caller override table. */
export function stateWeightOf(
  factState: FactState,
  overrides?: Partial<Readonly<Record<FactState, number>>>,
): number {
  const fromOverride = overrides?.[factState];
  if (fromOverride !== undefined) return fromOverride;
  const base = STATE_WEIGHT[factState];
  return base !== undefined ? base : STATE_WEIGHT[FactState.DEMOTED];
}

// ---------------------------------------------------------------------------
// §2 — candidate shapes + the union
// ---------------------------------------------------------------------------

/** One strand the activation walk itself lit, as presentation-ranking input. */
export interface WalkLitCandidate {
  readonly strandId: StrandId;
  readonly contentHash: ContentHash;
  readonly factState: FactState;
  /** Raw activation energy the walk ended holding for this strand. */
  readonly walkEnergy: number;
}

/** One cosine top-N match from the vector sidecar, mapped back to a strand. */
export interface CosineCandidate {
  readonly strandId: StrandId;
  readonly contentHash: ContentHash;
  readonly factState: FactState;
  /** cosine(cue, strand) — expected in [0, 1] (the sidecar never returns negative-clamped scores here). */
  readonly cosine: number;
}

/** One candidate in the (post-union) presentation set, before scoring. */
export interface PresentationCandidate {
  readonly strandId: StrandId;
  readonly contentHash: ContentHash;
  readonly factState: FactState;
  readonly walkEnergy: number;
  readonly cosine: number;
  /** `true` iff the activation walk itself lit this strand (vs. union-added-only). */
  readonly litByWalk: boolean;
}

/**
 * §2 — build the union candidate set: `walkLit UNION cosineTopN`, deduped by
 * `content_hash`. ADD-ONLY: every `walkLit` candidate is preserved verbatim
 * (never removed, never re-stated — its `factState`/`walkEnergy`/`litByWalk`
 * are exactly what the walk reported); a `cosineTopN` entry whose
 * `content_hash` the walk already surfaced only ANNOTATES the existing
 * candidate's cosine score (kept at the max seen) rather than adding a
 * second entry for the same content. A `cosineTopN` entry on a genuinely NEW
 * `content_hash` is appended as a fresh, `litByWalk: false` candidate with
 * `walkEnergy: 0` (the walk never lit it).
 *
 * Order: `walkLit`'s own order first (so callers relying on it for
 * tie-breaking see it preserved), then newly union-added candidates in
 * `cosineTopN`'s order. Downstream scoring/sorting reorders regardless, but
 * this keeps the union step itself deterministic and easy to unit-test.
 *
 * Multiple `walkLit` (or `cosineTopN`) entries sharing one `content_hash`
 * (echoes) collapse to the FIRST one seen — the presentation candidate set
 * is one entry per distinct content, matching the spec's "deduped by
 * content_hash" wording (distinct from the SEED-union in
 * `recall/cueResolver.ts`, which is strand-id-keyed by design).
 */
export function buildUnionCandidateSet(
  walkLit: readonly WalkLitCandidate[],
  cosineTopN: readonly CosineCandidate[],
): PresentationCandidate[] {
  const byHash = new Map<string, PresentationCandidate>();
  const order: string[] = [];

  for (const w of walkLit) {
    const key = String(w.contentHash);
    if (byHash.has(key)) continue; // echo within the walk's own lit set: first-seen wins
    byHash.set(key, {
      strandId: w.strandId,
      contentHash: w.contentHash,
      factState: w.factState,
      walkEnergy: w.walkEnergy,
      cosine: 0,
      litByWalk: true,
    });
    order.push(key);
  }

  for (const c of cosineTopN) {
    const key = String(c.contentHash);
    const existing = byHash.get(key);
    if (existing === undefined) {
      byHash.set(key, {
        strandId: c.strandId,
        contentHash: c.contentHash,
        factState: c.factState,
        walkEnergy: 0,
        cosine: c.cosine,
        litByWalk: false,
      });
      order.push(key);
    } else if (c.cosine > existing.cosine) {
      // ANNOTATE ONLY: never touch factState/walkEnergy/litByWalk — the walk's
      // own report (or an earlier union add) stands exactly as surfaced.
      byHash.set(key, { ...existing, cosine: c.cosine });
    }
  }

  return order.map((k) => {
    const v = byHash.get(k);
    if (v === undefined) throw new Error("presentationRank: unreachable — order/byHash desync");
    return v;
  });
}

// ---------------------------------------------------------------------------
// §3 — scoring
// ---------------------------------------------------------------------------

/** A {@link PresentationCandidate} plus its computed presentation score. */
export interface ScoredCandidate extends PresentationCandidate {
  readonly normalizedWalkEnergy: number;
  readonly stateWeight: number;
  readonly score: number;
  /** 1-indexed ordinal cosine rank within the candidate set — `'rrf'` scoreMode only. */
  readonly cosineRank?: number;
  /** 1-indexed ordinal walk-energy rank within the candidate set — `'rrf'` scoreMode only. */
  readonly walkRank?: number;
}

/**
 * §3 step 2 — the shared post-fusion stateWeight multiplier, identical in both
 * {@link PresentationScoreMode}s: `1 - wState * (1 - stateWeight)`. `wState=0` ⇒
 * multiplier exactly 1 (no-op); LIVE (`stateWeight=1`) ⇒ multiplier exactly 1
 * regardless of `wState` (the nudge only ever discounts non-LIVE candidates).
 */
function stateMultiplier(stateWeight: number, wState: number): number {
  return 1 - wState * (1 - stateWeight);
}

/**
 * Min-max normalize `walkEnergy` ACROSS `candidates` (not globally) — see this
 * module's header doc for why union-added candidates fall out at exactly 0 for
 * free. Shared by both {@link scorePresentation} and {@link scorePresentationRrf}.
 */
function normalizeWalkEnergies(candidates: readonly PresentationCandidate[]): Map<string, number> {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candidates) {
    if (c.walkEnergy < lo) lo = c.walkEnergy;
    if (c.walkEnergy > hi) hi = c.walkEnergy;
  }
  const span = hi - lo;
  const out = new Map<string, number>();
  for (const c of candidates) {
    out.set(String(c.strandId), span > 0 ? (c.walkEnergy - lo) / span : c.walkEnergy > 0 ? 1 : 0);
  }
  return out;
}

/**
 * 1-indexed ORDINAL ranks of `candidates` by `keyFn` descending, ties broken by
 * `strandId` ascending (deterministic — no two candidates share a rank). Used by
 * {@link scorePresentationRrf} for the cosine-rank / walk-energy-rank fusion inputs.
 */
function ordinalRanks(
  candidates: readonly PresentationCandidate[],
  keyFn: (c: PresentationCandidate) => number,
): Map<string, number> {
  const sorted = [...candidates].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (kb !== ka) return kb - ka;
    const sa = String(a.strandId);
    const sb = String(b.strandId);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const ranks = new Map<string, number>();
  sorted.forEach((c, i) => ranks.set(String(c.strandId), i + 1));
  return ranks;
}

/**
 * §3, `'linear'` scoreMode: `raw = wCos*cosine + wWalk*normalizedWalkEnergy`,
 * then `score = raw * stateMultiplier`. `normalizedWalkEnergy` min-max
 * normalizes `walkEnergy` across this candidate set. Does NOT sort;
 * {@link rankForPresentation} does the union + score + sort together.
 */
export function scorePresentation(
  candidates: readonly PresentationCandidate[],
  weights: PresentationWeights = DEFAULT_PRESENTATION_WEIGHTS,
): ScoredCandidate[] {
  const normEnergyById = normalizeWalkEnergies(candidates);

  return candidates.map((c) => {
    const normalizedWalkEnergy = normEnergyById.get(String(c.strandId))!;
    const stateWeight = stateWeightOf(c.factState);
    const raw = weights.wCos * c.cosine + weights.wWalk * normalizedWalkEnergy;
    const score = raw * stateMultiplier(stateWeight, weights.wState);
    return { ...c, normalizedWalkEnergy, stateWeight, score };
  });
}

/**
 * §3, `'rrf'` scoreMode (Phase 1c): reciprocal-rank fusion of the candidate's
 * cosine rank and walk-energy rank — `raw = 1/(k+cosineRank) + 1/(k+walkRank)` —
 * then `score = raw * stateMultiplier` (identical post-fusion treatment to
 * {@link scorePresentation}). `wCos`/`wWalk` are NOT read here — RRF replaces the
 * hand-tuned linear mix entirely; only `wState` carries over. Does NOT sort;
 * {@link rankForPresentation} does the union + score + sort together.
 */
export function scorePresentationRrf(
  candidates: readonly PresentationCandidate[],
  weights: PresentationWeights = DEFAULT_PRESENTATION_WEIGHTS,
  k: number = DEFAULT_RRF_K,
): ScoredCandidate[] {
  const normEnergyById = normalizeWalkEnergies(candidates);
  const cosineRanks = ordinalRanks(candidates, (c) => c.cosine);
  const walkRanks = ordinalRanks(candidates, (c) => c.walkEnergy);

  return candidates.map((c) => {
    const normalizedWalkEnergy = normEnergyById.get(String(c.strandId))!;
    const stateWeight = stateWeightOf(c.factState);
    const cosineRank = cosineRanks.get(String(c.strandId))!;
    const walkRank = walkRanks.get(String(c.strandId))!;
    const raw = 1 / (k + cosineRank) + 1 / (k + walkRank);
    const score = raw * stateMultiplier(stateWeight, weights.wState);
    return { ...c, normalizedWalkEnergy, stateWeight, cosineRank, walkRank, score };
  });
}

// ---------------------------------------------------------------------------
// The orchestrator: mode dispatch (walk = passthrough, blend = union + score)
// ---------------------------------------------------------------------------

/**
 * §1-3 orchestrator over plain candidate arrays (no store/sidecar needed —
 * see {@link rankRecallResult} for the real end-to-end integration).
 *
 * `rankMode` absent or `'walk'`: a PURE PASSTHROUGH — returns `walkLit`
 * mapped 1:1, in `walkLit`'s OWN ORDER, completely ignoring `cosineTopN`
 * (no union, no scoring beyond a cosmetic `score = walkEnergy` so the
 * return shape is uniform). This is what makes "byte-identical when
 * `rankMode` is absent" a structural guarantee, not a coincidence: the
 * blend-mode code path is never even reached.
 *
 * `rankMode: 'blend'`: builds the §2 union, computes the §3 score — dispatched
 * on `options.scoreMode` (default `'linear'`) to {@link scorePresentation} or
 * {@link scorePresentationRrf}, with `options.weights` merged over
 * {@link DEFAULT_PRESENTATION_WEIGHTS} and `options.rrfK` merged over
 * {@link DEFAULT_RRF_K} — and sorts by score descending (ties broken by
 * `strandId` ascending, for determinism).
 */
export function rankForPresentation(
  walkLit: readonly WalkLitCandidate[],
  cosineTopN: readonly CosineCandidate[],
  options?: RecallOptions,
): ScoredCandidate[] {
  const mode: RankMode = options?.rankMode ?? "walk";

  if (mode === "walk") {
    return walkLit.map((w) => ({
      strandId: w.strandId,
      contentHash: w.contentHash,
      factState: w.factState,
      walkEnergy: w.walkEnergy,
      cosine: 0,
      litByWalk: true,
      normalizedWalkEnergy: 0,
      stateWeight: stateWeightOf(w.factState),
      score: w.walkEnergy,
    }));
  }

  const weights: PresentationWeights = {
    ...DEFAULT_PRESENTATION_WEIGHTS,
    ...options?.weights,
  };
  const scoreMode: PresentationScoreMode = options?.scoreMode ?? "linear";
  const unionSet = buildUnionCandidateSet(walkLit, cosineTopN);
  const scored =
    scoreMode === "rrf"
      ? scorePresentationRrf(unionSet, weights, options?.rrfK ?? DEFAULT_RRF_K)
      : scorePresentation(unionSet, weights);
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.strandId) < String(b.strandId) ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Real integration: a StrandStore + VectorSidecar + RecallResult
// ---------------------------------------------------------------------------

/**
 * Resolve the cosine top-N over a real {@link VectorSidecar} into
 * {@link CosineCandidate}s, by scanning the store ONCE to map
 * `content_hash -> strand ids` (the store carries no content_hash index —
 * see `recall/cueResolver.ts`'s `createEmbeddingCueResolver` for the same
 * pattern on the seed-selection side). This scan is BLEND-MODE-ONLY: it
 * never runs on the default `'walk'` path, so it costs nothing when the
 * feature is off (the default).
 *
 * A vector whose `content_hash` has no live strand (stale — the strand was
 * evicted/never existed) is silently skipped, mirroring the sidecar's own
 * "accelerator, never a gate" philosophy.
 */
export function cosineTopNCandidates(
  store: StrandStore,
  vectors: VectorSidecar,
  modelId: string,
  cueVector: Float32Array,
  n: number = DEFAULT_UNION_TOP_N,
): CosineCandidate[] {
  const matches = vectors.topK(cueVector, modelId, n);
  if (matches.length === 0) return [];

  const byHash = new Map<string, Array<{ strandId: StrandId; factState: FactState }>>();
  for (const strand of store.allStrands()) {
    const key = String(strand.content_hash);
    let bucket = byHash.get(key);
    if (bucket === undefined) {
      bucket = [];
      byHash.set(key, bucket);
    }
    bucket.push({ strandId: strand.id, factState: strand.fact_state });
  }

  const out: CosineCandidate[] = [];
  for (const m of matches) {
    const bucket = byHash.get(String(m.contentHash));
    if (bucket === undefined) continue; // stale vector, no live strand
    const cosine = Math.max(0, m.score);
    for (const b of bucket) {
      out.push({ strandId: b.strandId, contentHash: m.contentHash, factState: b.factState, cosine });
    }
  }
  return out;
}

/** The cosine wiring {@link rankRecallResult} needs to run blend mode for real. */
export interface CosineDeps {
  readonly vectors: VectorSidecar;
  readonly modelId: string;
  /** Precomputed cue embedding — `recall`/`RecallResult` stay fully SYNC (see header doc). */
  readonly cueVector: Float32Array;
}

/**
 * §1-4 end-to-end: given an ALREADY-COMPLETED {@link RecallResult} (i.e. the
 * output of `IntelligentDb.recall` — completely unmodified, since the walk
 * itself never reads similarity), re-rank its `lit` set for presentation.
 *
 * `rankMode` absent/`'walk'`, OR `cosine` deps absent (no embedder/vector
 * sidecar wired, or no precomputed cue vector supplied): returns `result`
 * UNCHANGED (`===`-identity not guaranteed, but every field byte-identical)
 * — blend mode FAILS OPEN to walk-mode ordering rather than erroring, the
 * same "accelerator, never a gate" posture the embedder-seeding machinery
 * uses elsewhere in this codebase.
 *
 * `rankMode: 'blend'` with cosine deps present: builds the union (§2),
 * scores (§3), and returns a NEW `RecallResult` whose `lit` reflects the
 * blended order (union-added strands carry `activation: 0` — the walk
 * never lit them, so there is no other honest number to report). `halt`,
 * `unresolvedSeeds`, and `seedsResolved` are passed through UNCHANGED —
 * this function only touches presentation of the lit set, never the
 * traversal's own halt accounting.
 *
 * A dangling `strandId` in `result.lit` (should not happen, but the store
 * is the source of truth) is skipped rather than invented into a candidate.
 */
export function rankRecallResult(
  store: StrandStore,
  result: RecallResult,
  cosine: CosineDeps | null,
  options?: RecallOptions,
): RecallResult {
  const mode: RankMode = options?.rankMode ?? "walk";
  if (mode === "walk" || cosine === null) {
    return result;
  }

  const walkLit: WalkLitCandidate[] = [];
  for (const l of result.lit) {
    const strand = store.getStrand(l.strandId);
    if (strand === null) continue; // dangling id: skip, never invent
    walkLit.push({
      strandId: l.strandId,
      contentHash: strand.content_hash,
      factState: strand.fact_state,
      walkEnergy: l.activation,
    });
  }

  const n = options?.unionTopN ?? DEFAULT_UNION_TOP_N;
  const cosineTopN = cosineTopNCandidates(store, cosine.vectors, cosine.modelId, cosine.cueVector, n);
  const ranked = rankForPresentation(walkLit, cosineTopN, options);

  const lit: LitStrand[] = ranked.map((r) => ({ strandId: r.strandId, activation: r.walkEnergy }));
  return { ...result, lit };
}
