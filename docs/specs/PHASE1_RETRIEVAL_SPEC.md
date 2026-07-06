# Phase 1 — Retrieval Win (spec)

Owner: product. Status: approved for implementation. Gate: LoCoMo recall@20 >= 0.484
(mem0's measured number) with Sybil crossdb 24/24 and FactWorld 0.0% ASR unchanged.

## The thesis constraint (non-negotiable)

The differentiator is that BELIEF comes from provenance and trust, never from similarity.
Embeddings may only ever propose WHERE TO LOOK (seeding). They must never influence:
edge weights, fact_state, adjudication, independence counting, reputation, eviction,
or what the walk does after seeding. If an implementation choice would let similarity
leak into belief, the choice is wrong.

## 1. EmbedderPort — optional, injected, zero-dep core preserved

```ts
// core/types.ts
export interface EmbedderPort {
  /** Batch-embed. Deterministic for identical inputs within a session. */
  embed(texts: string[]): Promise<Float32Array[]>
  readonly dim: number
  /** Identifies the model so stored vectors are never mixed across models. */
  readonly modelId: string
}
```

- `createIntelligentDb(..., { embedder?: EmbedderPort })`. Absent => behavior is
  bit-for-bit today's. The library ships NO embedder implementation in the core
  (zero runtime deps). Ship reference implementations in `src/examples/embedders.ts`
  (NOT exported from the barrel): an Ollama HTTP embedder (nomic-embed-text) and the
  hashing-trick embedder already used by the crossdb bench.

## 2. Vector sidecar — storage

- New table `strand_vectors(content_hash TEXT PRIMARY KEY, model_id TEXT, dim INT,
  vec BLOB)` in the SQLite store; in-memory Map for the memory store.
- Populated inside `writeFact`'s existing `withTxn` (embed BEFORE the txn opens —
  no awaits inside the transaction; on embedder failure, write the fact WITHOUT a
  vector and continue: embeddings are an accelerator, never a gate).
- Keyed by `content_hash` so echoes share one vector. `model_id` mismatch at open
  => that vector is ignored (and lazily re-embedded on next write of same hash).
- Brute-force cosine scan is ACCEPTABLE at this phase (0.004ms recall + a few ms
  scan at 100k vectors is fine; benchmark it). No ANN library. If scan cost at 1M
  exceeds 20ms p50, add a coarse int8 pre-filter — still zero-dep.

## 3. Seed selection — the only integration point

Today `recall(cue)` seeds from entity/lexical match. New behavior when an embedder
is configured:

1. Embed the cue (cache per-session).
2. Cosine top-K (default K=16) over the sidecar => candidate strands.
3. UNION with the existing lexical/entity seeds (never replace — lexical exact
   match is evidence-grade and must not be losable to a similarity miss).
4. Seed energy: existing seeds keep their current energy; embedding-proposed seeds
   get `seedEnergy * cosineScore` clamped to <= the lexical seed energy (similarity
   may never outrank an exact entity hit).
5. Everything downstream (walk, share-normalization, halting, bridge sweep,
   rendering with fact_state labels) is UNCHANGED.

Config on `WalkConfig`: `{ embedSeedK?: number; embedSeedEnergyCap?: number }`.

## 4. Walk improvements (independent of embeddings)

a. **Reinforcement-by-summation (flagged)**: `WalkConfig.reinforcement: 'dominance'
   | 'summation'` (default 'dominance' — no silent behavior change). Summation:
   a strand's firing energy is the SUM of incoming path deliveries, clamped by a
   per-strand cap equal to the max single-path delivery times `summationCap`
   (default 2.0), preserving monotone-non-increasing termination (prove it in a
   test: total dispensed energy is still bounded by seed energy * gamma-geometric
   series; the clamp prevents cycle amplification).
b. **Graded novelty**: `noveltyOf` 0/1 => saturating curve
   `novelty = 1 - exp(-newIndependentRoots / tau)` (tau default 1.0, config knob).
   Affects halting EWMA only — ordering/stopping contract unchanged.

## 5. Adversarial gates (run before ANY commit to main claims)

1. Full default suite (460) green; typecheck green.
2. `CROSSDB_BENCH` Sybil: IntelligentDB still 24/24. Run WITH the Ollama embedder
   configured — a poisoned strand may win a seed slot; it must still surface only
   with its true fact_state/provenance, and the poison metric must not move.
3. FactWorld substrate: still 0.0% ASR (embedder on).
4. New test: adversarial embedding-stuffing — an attacker writes strands whose
   payloads are near-duplicates of the cue (cosine ~1.0). Assert: they seed, but
   a LIVE incumbent with independent provenance still outranks them in the
   rendered answer, and PROVISIONAL floods stay labeled.

## 6. Measurement

Re-run LoCoMo (RETRIEVAL_BENCH + MEM0_BENCH, same-run vs mem0) with a new
`EmbedSeeded` arm (TunedHybrid + embedder seeding). Report all four metrics.
Then sweep `embedSeedK` in {8, 16, 32} and reinforcement modes; pick the winner;
freeze it as the new tuned default. Publish before/after in BENCH_RERUN.
