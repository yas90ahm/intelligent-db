/**
 * recall/cueResolver.ts — THE CUE→SEED STEP (the missing entry point of recall).
 *
 * The engine's {@link IntelligentDb.recall} takes SEED STRAND IDS ({@link WalkSeed} =
 * `{ strandId, energy }`): the spreading-activation MATCHING is solved, but choosing
 * WHICH strands to seed the walk from — given a fuzzy English cue — did not exist.
 * Today a caller must seed by an exact entity via `store.strandsByEntity`. That makes
 * recall "name the entity → get its activated cluster", not "ask in English → relevant
 * grounded facts". This module closes that gap.
 *
 * THE SEAM (pluggable by design). {@link CueResolver} is the swap point: the default
 * {@link createLexicalCueResolver} is the HONEST ZERO-DEP baseline — a token inverted
 * index plus an exact-entity boost, ranked by match strength. A future
 * `createEmbeddingCueResolver(store, embedder)` can replace it with the IDENTICAL
 * signature (resolve + index), swapping lexical token overlap for semantic similarity;
 * lexical is the baseline, semantic is a future swap. We do NOT pretend the lexical
 * resolver understands synonyms — its recall of the right strands rests on shared
 * tokens, the exact-entity boost, and (downstream) the activation walk's SPREADING,
 * which recovers same-entity siblings a cue did not directly token-match.
 *
 * LIFECYCLE. `index(strand)` is the hook the facade calls on EVERY remember, so the
 * inverted index stays current; the resolver also REBUILDS itself from
 * `store.allStrands()` at construction, so it survives a SQLite reopen (the facade's
 * persistence case). Keeping `index` on the interface lets a future embedding resolver
 * maintain its OWN structures (a vector store) behind the same seam.
 *
 * Zero external deps: this is pure in-process data structures over the shared types.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax` ⇒
 * every type-only import uses `import type`.
 */

import type {
  ContentHash,
  Strand,
  StrandId,
  EntityId,
  AttributeKey,
  Activation,
  EmbedderPort,
  WalkConfig,
} from "../core/types.js";
import type { StrandStore } from "../store/StrandStore.js";
import type { VectorSidecar } from "../store/vectorSidecar.js";
import type { WalkSeed } from "../traversal/walk.js";

// ---------------------------------------------------------------------------
// Public cue shape + the pluggable seam
// ---------------------------------------------------------------------------

/**
 * A cue: the agent's fuzzy request for memory. Any subset of the three channels may
 * be supplied. `text` is the natural-language question (the lexical channel);
 * `entities` / `attributes` are EXACT keys the caller already knows (the precise
 * channel, e.g. it already resolved "Berlin" to `entity:berlin`). A cue with only
 * `text` is the "ask in English" path; a cue with `entities` is the legacy
 * name-the-entity path; both may be combined.
 */
export interface Cue {
  /** The natural-language cue text, tokenized + matched against the inverted index. */
  readonly text?: string;
  /** Exact entities to seed from (full-energy exact-entity boost). */
  readonly entities?: readonly EntityId[];
  /** Exact (entity, attribute) claim keys to seed from (full-energy boost). */
  readonly attributes?: readonly AttributeKey[];
}

/**
 * THE SWAP POINT. A cue resolver turns a {@link Cue} into the {@link WalkSeed}s the
 * engine's activation walk starts from, and maintains whatever index it needs via the
 * `index` lifecycle hook the facade calls on every remember.
 *
 * The default is {@link createLexicalCueResolver} (zero-dep lexical). A semantic
 * resolver implements the SAME interface — `resolve` over embeddings, `index` to add
 * a strand's vector — so the facade can swap it in with no other change.
 */
export interface CueResolver {
  /**
   * Resolve a cue to a ranked, de-duplicated set of {@link WalkSeed}s. Energy is
   * proportional to match strength; exact-entity / exact-attribute matches always
   * carry full energy `1.0`. Returns at most `topK` seeds (a configurable cap).
   */
  resolve(cue: Cue): WalkSeed[];
  /**
   * Lifecycle hook: incorporate a freshly remembered strand into the resolver's
   * index. The facade calls this on every `remember`. Idempotent per strand id.
   */
  index(strand: Strand): void;
}

// ---------------------------------------------------------------------------
// Options + defaults
// ---------------------------------------------------------------------------

/** Tunables for {@link createLexicalCueResolver}. */
export interface LexicalCueResolverOptions {
  /** Maximum number of seeds returned by `resolve` (default 8). */
  readonly topK?: number;
  /** Override the built-in stopword set (lowercase tokens dropped before matching). */
  readonly stopwords?: ReadonlySet<string>;
  /**
   * Minimum energy a lexically-matched seed carries (default 0.15). Ensures even a
   * weak single-token match injects enough energy to actually fire its seed and let
   * the walk spread — without it a low-strength match could round to ~0 and starve.
   */
  readonly energyFloor?: number;
}

/** Default number of seeds the lexical resolver returns. */
export const DEFAULT_TOP_K = 8;

/** Default energy floor for a lexically-matched (non-exact) seed. */
export const DEFAULT_ENERGY_FLOOR = 0.15;

/**
 * A small, built-in English stopword set. Deliberately conservative — only the most
 * common function words that carry no entity/attribute signal. Kept tiny so domain
 * terms are never accidentally dropped. Overridable via
 * {@link LexicalCueResolverOptions.stopwords}.
 */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "of", "on", "or", "she", "that", "the", "their", "them", "they",
  "this", "to", "was", "were", "what", "when", "where", "which", "who",
  "whom", "whose", "why", "will", "with", "you", "your", "do", "does",
  "did", "about", "me", "my", "we", "our", "us", "how",
]);

// ---------------------------------------------------------------------------
// Tokenization (shared by index + resolve so they agree on the vocabulary)
// ---------------------------------------------------------------------------

/**
 * Tokenize a piece of text into the normalized token set used by BOTH indexing and
 * resolution: lowercase, split on any run of non-alphanumerics, drop empties and
 * stopwords. Returns a de-duplicated array (set semantics — a token counts once).
 */
export function tokenize(
  text: string,
  stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS,
): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    if (stopwords.has(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

/**
 * The full token vocabulary of a strand for indexing purposes: the tokens of its
 * payload text (via {@link strandText}) PLUS the tokens of its entity id and
 * attribute key. Indexing the entity/attribute makes a cue that names a slug or an
 * attribute fragment find the strand even when the payload phrasing differs.
 */
function strandTokens(
  strand: Strand,
  stopwords: ReadonlySet<string>,
): string[] {
  const parts: string[] = [strandText(strand), String(strand.entity)];
  if (strand.attribute !== null && strand.attribute !== undefined) {
    parts.push(String(strand.attribute));
  }
  return tokenize(parts.join(" "), stopwords);
}

/**
 * Extract a human-readable text from a strand's payload for matching/citation. The
 * payload is opaque (`unknown`) by contract, but the facade stores `{ text }`, so we
 * prefer a string `text` field; otherwise fall back to a JSON rendering. Pure.
 */
export function strandText(strand: { readonly payload: unknown }): string {
  const p = strand.payload;
  if (typeof p === "string") return p;
  if (p !== null && typeof p === "object") {
    const t = (p as { text?: unknown }).text;
    if (typeof t === "string") return t;
    try {
      return JSON.stringify(p);
    } catch {
      return String(p);
    }
  }
  return p === null || p === undefined ? "" : String(p);
}

// ---------------------------------------------------------------------------
// The zero-dep lexical resolver
// ---------------------------------------------------------------------------

/**
 * Create the default ZERO-DEP lexical cue resolver over a {@link StrandStore}.
 *
 * It maintains a token INVERTED INDEX (`normalized token → Set<StrandId>`), updated
 * incrementally by {@link CueResolver.index} (the facade's per-remember hook) and
 * rebuilt from `store.allStrands()` at construction so it survives a persistent-store
 * reopen. On `resolve(cue)`:
 *   1. EXACT-ENTITY / EXACT-ATTRIBUTE BOOST: any `cue.entities` / `cue.attributes`
 *      pull their strands straight from the store's indexes at FULL energy `1.0`.
 *   2. LEXICAL MATCH: tokenize `cue.text`, union the candidate strands from the
 *      inverted index, SCORE each by the count of DISTINCT matched tokens (more
 *      matched tokens ⇒ stronger), rank descending, take the top-K.
 *   3. ENERGY: a lexical seed's energy = `matchedTokens / maxMatchedTokens` (∈ (0,1]),
 *      clamped up to `energyFloor`. Exact matches override to `1.0`. De-dup by
 *      strand id keeping the MAX energy.
 *
 * The walk then SPREADS from these seeds across shared-entity siblings, so a cue that
 * token-hits one fact lights its whole entity cluster — the resolver supplies the
 * entry points; the engine supplies the spread.
 */
export function createLexicalCueResolver(
  store: StrandStore,
  opts?: LexicalCueResolverOptions,
): CueResolver {
  const topK = opts?.topK ?? DEFAULT_TOP_K;
  const stopwords = opts?.stopwords ?? DEFAULT_STOPWORDS;
  const energyFloor = opts?.energyFloor ?? DEFAULT_ENERGY_FLOOR;

  /** token → set of strand ids containing it. */
  const invertedIndex = new Map<string, Set<StrandId>>();
  /** strand ids already indexed (idempotency for the per-remember hook). */
  const indexed = new Set<StrandId>();

  function indexStrand(strand: Strand): void {
    if (indexed.has(strand.id)) return;
    indexed.add(strand.id);
    for (const token of strandTokens(strand, stopwords)) {
      let bucket = invertedIndex.get(token);
      if (bucket === undefined) {
        bucket = new Set<StrandId>();
        invertedIndex.set(token, bucket);
      }
      bucket.add(strand.id);
    }
  }

  // Rebuild from the store so the resolver is correct immediately after a reopen of a
  // persistent backend (the facade re-creates the resolver on construct; replaying
  // allStrands restores the index that lives only in memory).
  for (const strand of store.allStrands()) {
    indexStrand(strand);
  }

  function clampEnergy(e: number): Activation {
    if (e <= 0) return energyFloor as Activation;
    if (e < energyFloor) return energyFloor as Activation;
    if (e > 1) return 1 as Activation;
    return e as Activation;
  }

  return {
    index(strand: Strand): void {
      indexStrand(strand);
    },

    resolve(cue: Cue): WalkSeed[] {
      // Accumulate the best energy seen per strand across all channels.
      const best = new Map<StrandId, number>();
      const bump = (id: StrandId, energy: number): void => {
        const prev = best.get(id);
        if (prev === undefined || energy > prev) best.set(id, energy);
      };

      // 1) EXACT-ENTITY / EXACT-ATTRIBUTE BOOST — full energy 1.0.
      if (cue.entities !== undefined) {
        for (const entity of cue.entities) {
          for (const s of store.strandsByEntity(entity)) bump(s.id, 1);
        }
      }
      if (cue.attributes !== undefined) {
        for (const attr of cue.attributes) {
          for (const s of store.strandsByAttribute(attr)) bump(s.id, 1);
        }
      }

      // 2) LEXICAL MATCH — score by distinct matched-token count.
      if (cue.text !== undefined) {
        const cueTokens = tokenize(cue.text, stopwords);
        if (cueTokens.length > 0) {
          const matchCount = new Map<StrandId, number>();
          for (const token of cueTokens) {
            const bucket = invertedIndex.get(token);
            if (bucket === undefined) continue;
            for (const id of bucket) {
              matchCount.set(id, (matchCount.get(id) ?? 0) + 1);
            }
          }
          // Normalize energy by the strongest match so the best seed reads ~1.0.
          let maxMatched = 0;
          for (const c of matchCount.values()) if (c > maxMatched) maxMatched = c;
          if (maxMatched > 0) {
            for (const [id, count] of matchCount) {
              bump(id, clampEnergy(count / maxMatched));
            }
          }
        }
      }

      // 3) Rank, cap, emit. Sort by energy desc, then strand id for determinism.
      const ranked = [...best.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });

      const seeds: WalkSeed[] = [];
      for (const [id, energy] of ranked) {
        if (seeds.length >= topK) break;
        seeds.push({ strandId: id, energy: clampEnergy(energy) });
      }
      return seeds;
    },
  };
}

// ---------------------------------------------------------------------------
// Embedding-augmented resolver (Phase-1 retrieval spec §3) — the seed-UNION seam
// ---------------------------------------------------------------------------

/**
 * Default cosine top-K candidates pulled from the vector sidecar (spec §3).
 *
 * FROZEN TUNED DEFAULT (spec §6 measurement, 2026-07-06): the real-LoCoMo
 * `EmbedSeeded` sweep (`src/__bench__/retrieval/locomoEmbedSeededRunner.test.ts`,
 * artifact `.arbor/sessions/retrieval-quality/experiments/1.1.1.1.1.embedseeded/`)
 * swept `embedSeedK` in {8, 16, 32} x `reinforcement` in {dominance, summation} on
 * TunedHybrid-with-embedder-seeding and selected the winner by mean recall@20 on
 * the LoCoMo dev split. **16 won** (K=32 measured byte-identical to K=16 — beyond
 * ~16 candidates the extra cosine matches are either duplicates the content-hash
 * union already collapsed or too weak to change the ranking; K=8 measurably
 * trails both). This CONFIRMS 16 — already the shipped default before this
 * measurement — is the right value; no change was made. Recorded here so the
 * choice is measurement-backed, not merely a guess. (The sweep's `reinforcement`
 * half of the winner — `summation` — is NOT frozen as the global default; see
 * `DEFAULT_WALK_CONFIG`'s doc for why.)
 */
export const DEFAULT_EMBED_SEED_K = 16;

/**
 * Default hard ceiling on an embedding-proposed seed's energy, IN ADDITION to
 * the mandatory dynamic clamp (never outrank a lexical/entity hit). `1` = no
 * extra ceiling beyond the dynamic clamp. Not varied by the spec §6 sweep (held
 * at 1 throughout); no measurement basis to change it from today's default.
 */
export const DEFAULT_EMBED_SEED_ENERGY_CAP = 1;

/** Options for {@link createEmbeddingCueResolver}. */
export interface EmbeddingCueResolverOptions {
  /**
   * The lexical/entity baseline to union embedding candidates INTO. Defaults to
   * a fresh {@link createLexicalCueResolver} over the same store. Supplying an
   * already-populated resolver here means embedding candidates union with
   * exactly what that resolver would have returned alone.
   */
  readonly base?: CueResolver;
  /** Default cosine top-K (overridable per-call). Default {@link DEFAULT_EMBED_SEED_K}. */
  readonly embedSeedK?: number;
  /** Default energy ceiling (overridable per-call). Default {@link DEFAULT_EMBED_SEED_ENERGY_CAP}. */
  readonly embedSeedEnergyCap?: number;
}

/**
 * A {@link CueResolver} widened with an ADDITIONAL async entry point that
 * performs the embedder-seeded union. The base sync `resolve` is UNTOUCHED —
 * see {@link createEmbeddingCueResolver}'s doc for why the embedder is never on
 * that path.
 */
export interface EmbeddingSeededCueResolver extends CueResolver {
  /**
   * Resolve a cue exactly like {@link CueResolver.resolve}, PLUS an embedder-
   * seeded union (Phase-1 retrieval spec §3):
   *   1. Embed `cue.text` (cached per resolver instance/session; a failed embed
   *      degrades to the lexical/entity result alone — never a gate).
   *   2. Cosine top-K (`embedSeedK`, default 16) over the vector sidecar,
   *      scoped to `embedder.modelId` (a mismatched-model vector is ignored by
   *      the sidecar itself).
   *   3. Map each match's `content_hash` back to its strand id(s) (echoes share
   *      one vector — every strand with that hash is proposed) and UNION them
   *      into the lexical/entity seed set — NEVER replacing an existing seed's
   *      energy, only adding new ones or raising to a MAX.
   *   4. Energy: an embedding-proposed seed's energy is its cosine score,
   *      clamped to `<= embedSeedEnergyCap` (a static config ceiling) AND
   *      `<= the strongest lexical/entity seed energy this cue produced` (or 1
   *      when there were none) — similarity may NEVER outrank an exact
   *      entity/lexical hit.
   */
  resolveWithEmbeddings(
    cue: Cue,
    config?: Pick<WalkConfig, "embedSeedK" | "embedSeedEnergyCap">,
  ): Promise<WalkSeed[]>;
}

/**
 * Create the embedder-seeded {@link CueResolver}. THE SEAM this module's header
 * doc anticipated: identical construction shape to
 * {@link createLexicalCueResolver} plus the embedder + vector sidecar.
 *
 * WHY `resolve` stays SYNC and embedding lives on a SEPARATE async method
 * ({@link EmbeddingSeededCueResolver.resolveWithEmbeddings}): `EmbedderPort.embed`
 * is inherently async (an HTTP/model call), but {@link CueResolver.resolve} — and
 * every synchronous caller across this codebase (the activation walk, the
 * facade's `recall`) — is a hard, load-bearing SYNC contract (see
 * `store/StrandStore.ts`'s "Synchrony" note). Rather than infect that contract
 * with `Promise`, this resolver keeps `resolve`/`index` byte-identical to the
 * lexical baseline (so passing an `EmbeddingSeededCueResolver` anywhere a
 * `CueResolver` is expected is a no-op change) and exposes the embedder-seeded
 * union as an ADDITIONAL opt-in async entry point a caller invokes explicitly
 * before building the `RecallCue` it hands `engine.recall`. This is a
 * deliberate, conservative resolution of the tension between the spec's async
 * embedder and the engine's sync-core invariant — documented, not silent.
 *
 * `index(strand)` maintains a `content_hash -> Set<StrandId>` map (so a cosine
 * match on a shared payload resolves to every strand carrying that hash — the
 * spec's "echoes share one vector") IN ADDITION TO delegating to `base.index`,
 * and rebuilds itself from `store.allStrands()` at construction, mirroring the
 * lexical resolver's reopen-survival behavior.
 */
export function createEmbeddingCueResolver(
  store: StrandStore,
  embedder: EmbedderPort,
  vectors: VectorSidecar,
  opts?: EmbeddingCueResolverOptions,
): EmbeddingSeededCueResolver {
  const base = opts?.base ?? createLexicalCueResolver(store);
  const defaultK = opts?.embedSeedK ?? DEFAULT_EMBED_SEED_K;
  const defaultCap = opts?.embedSeedEnergyCap ?? DEFAULT_EMBED_SEED_ENERGY_CAP;

  /** content_hash -> every strand id currently sharing that hash (echoes). */
  const byContentHash = new Map<ContentHash, Set<StrandId>>();
  /** Per-session query-embedding cache (spec §3 step 1), keyed by raw cue text. */
  const queryCache = new Map<string, Float32Array>();

  function indexContentHash(strand: Strand): void {
    let bucket = byContentHash.get(strand.content_hash);
    if (bucket === undefined) {
      bucket = new Set<StrandId>();
      byContentHash.set(strand.content_hash, bucket);
    }
    bucket.add(strand.id);
  }

  for (const strand of store.allStrands()) indexContentHash(strand);

  async function embedCue(text: string): Promise<Float32Array | null> {
    const cached = queryCache.get(text);
    if (cached !== undefined) return cached;
    try {
      const [vec] = await embedder.embed([text]);
      if (vec === undefined) return null;
      queryCache.set(text, vec);
      return vec;
    } catch {
      // FAIL-OPEN (spec §2): embeddings are an accelerator, never a gate — a
      // failed cue embedding degrades to the lexical/entity result alone.
      return null;
    }
  }

  return {
    index(strand: Strand): void {
      base.index(strand);
      indexContentHash(strand);
    },

    // UNCHANGED sync contract — see the factory doc's "WHY resolve stays sync".
    resolve(cue: Cue): WalkSeed[] {
      return base.resolve(cue);
    },

    async resolveWithEmbeddings(
      cue: Cue,
      config?: Pick<WalkConfig, "embedSeedK" | "embedSeedEnergyCap">,
    ): Promise<WalkSeed[]> {
      const k = config?.embedSeedK ?? defaultK;
      const cap = config?.embedSeedEnergyCap ?? defaultCap;

      // 1) BASELINE — existing lexical/entity seeds. UNION never replace: every
      //    lexical/exact seed keeps EXACTLY the energy the baseline gave it.
      const lexicalSeeds = base.resolve(cue);
      const combined = new Map<StrandId, number>();
      let lexicalCap = 0;
      for (const seed of lexicalSeeds) {
        combined.set(seed.strandId, seed.energy);
        if (seed.energy > lexicalCap) lexicalCap = seed.energy;
      }
      // No lexical/entity seed at all: nothing to "outrank" this cue, so the
      // DYNAMIC clamp degrades to full energy — the STATIC embedSeedEnergyCap
      // ceiling below still applies regardless.
      if (lexicalSeeds.length === 0) lexicalCap = 1;

      // 2) EMBED the cue + cosine TOP-K over the sidecar (skip entirely when
      //    there is no text to embed, or K is non-positive — the cue's exact/
      //    lexical channels still work with no embedder cost).
      if (cue.text !== undefined && cue.text.trim().length > 0 && k > 0) {
        const queryVec = await embedCue(cue.text);
        if (queryVec !== null) {
          const matches = vectors.topK(queryVec, embedder.modelId, k);
          for (const match of matches) {
            const strandIds = byContentHash.get(match.contentHash);
            if (strandIds === undefined) continue; // vector has no live strand (stale)
            // 3+4) UNION + ENERGY CLAMP: seedEnergy = cosineScore, clamped to
            //    <= embedSeedEnergyCap AND <= lexicalCap — similarity may NEVER
            //    outrank an exact lexical/entity hit.
            const cosineScore = Math.max(0, match.score);
            const proposed = Math.min(cosineScore, cap, lexicalCap);
            if (proposed <= 0) continue;
            for (const strandId of strandIds) {
              const existing = combined.get(strandId);
              if (existing === undefined || proposed > existing) {
                combined.set(strandId, proposed);
              }
            }
          }
        }
      }

      // Rank energy desc, id asc — the same determinism rule the lexical
      // resolver uses, so the union's output order is reproducible.
      const ranked = [...combined.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      return ranked.map(([strandId, energy]) => ({
        strandId,
        energy: energy as Activation,
      }));
    },
  };
}
