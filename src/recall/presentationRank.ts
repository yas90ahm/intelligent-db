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
 * §3 — the presentation score:
 *   `score = wCos * cosine(cue, strand) + wWalk * normalizedWalkEnergy + wState * stateWeight`
 *   - `normalizedWalkEnergy` is `walkEnergy` min-max normalized WITHIN the
 *     candidate set at hand (0 for a union-added candidate the walk never
 *     lit — this falls out of the min-max normalization for free, since a
 *     union-added candidate's raw `walkEnergy` is exactly 0 and 0 always
 *     participates in the observed minimum).
 *   - `stateWeight` ({@link STATE_WEIGHT}): LIVE 1.0, PROVISIONAL 0.85,
 *     DEMOTED 0.4 — config-overridable constants. A PRESENTATION nudge only:
 *     it reads `fact_state`, it never sets it, and exists so a quarantined
 *     (PROVISIONAL) flood cannot crowd the top ranks ahead of a LIVE
 *     incumbent purely on cosine/energy.
 *   - Weights ({@link PresentationWeights}) default to
 *     {@link DEFAULT_PRESENTATION_WEIGHTS} — the middle point of the spec's
 *     own sweep grid (`wCos in {0.5,0.7,0.9}`, `wWalk in {0.1,0.3,0.5}`,
 *     `wState` fixed at 0.1). NOTE: this default is NOT yet frozen by a
 *     LoCoMo DEV-split measurement sweep (spec §6) — that sweep, and
 *     freezing the tuned weights before TEST is scored, is a follow-on step
 *     gated on the spec's adversarial gates (§5) re-passing in blend mode.
 *     Fully config-overridable via {@link RecallOptions.weights} today.
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
}

/**
 * §3 — score every candidate: `wCos*cosine + wWalk*normalizedWalkEnergy +
 * wState*stateWeight`. `normalizedWalkEnergy` min-max normalizes `walkEnergy`
 * ACROSS THIS CANDIDATE SET (not globally) — see this module's header doc
 * for why union-added candidates fall out at exactly 0 for free. Does NOT
 * sort; {@link rankForPresentation} does the union + score + sort together.
 */
export function scorePresentation(
  candidates: readonly PresentationCandidate[],
  weights: PresentationWeights = DEFAULT_PRESENTATION_WEIGHTS,
): ScoredCandidate[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candidates) {
    if (c.walkEnergy < lo) lo = c.walkEnergy;
    if (c.walkEnergy > hi) hi = c.walkEnergy;
  }
  const span = hi - lo;

  return candidates.map((c) => {
    const normalizedWalkEnergy = span > 0 ? (c.walkEnergy - lo) / span : c.walkEnergy > 0 ? 1 : 0;
    const stateWeight = stateWeightOf(c.factState);
    const score =
      weights.wCos * c.cosine + weights.wWalk * normalizedWalkEnergy + weights.wState * stateWeight;
    return { ...c, normalizedWalkEnergy, stateWeight, score };
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
 * `rankMode: 'blend'`: builds the §2 union, computes the §3 score with
 * `options.weights` merged over {@link DEFAULT_PRESENTATION_WEIGHTS}, and
 * sorts by score descending (ties broken by `strandId` ascending, for
 * determinism).
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
  const unionSet = buildUnionCandidateSet(walkLit, cosineTopN);
  const scored = scorePresentation(unionSet, weights);
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
