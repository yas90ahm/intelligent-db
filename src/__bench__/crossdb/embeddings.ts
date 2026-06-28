/**
 * embeddings.ts — a DETERMINISTIC synthetic embedding for the cross-DB benchmark.
 *
 * Every vector engine in the harness embeds the SAME text the SAME way, so the
 * comparison is offline-fair: no cloud model, no randomness, byte-identical across
 * runs and machines. We use the classic "hashing trick": each token is hashed to a
 * dimension index and a sign, accumulated, then the vector is L2-normalized so a
 * cosine similarity is just a dot product.
 *
 * This is intentionally NOT a semantic embedding — it is a stable, cheap, reproducible
 * stand-in whose only job is to give the vector-store adapters a consistent geometry to
 * do nearest-neighbour recall over. The poisoning result does not depend on embedding
 * quality (a trust-blind nearest-neighbour store is poisoned by copy-count regardless).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; this module has none.
 */

/** Embedding dimensionality (fixed across every vector engine for a fair compare). */
export const EMBED_DIM = 64;

/** FNV-1a 32-bit hash of a string — deterministic, fast, no deps. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stays in uint32 range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase alnum tokenization (matches the engine's lexical cue tokenizer shape). */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

/**
 * Map arbitrary text to a fixed-dim, L2-normalized Float32 vector via the hashing
 * trick. Deterministic: the same text always yields the same vector. An empty/no-token
 * text yields a zero vector (norm 0 ⇒ left as zeros; cosine with it is 0).
 */
export function embed(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok);
    const idx = h % EMBED_DIM;
    const sign = ((h >>> 8) & 1) === 1 ? 1 : -1;
    v[idx] = (v[idx] ?? 0) + sign;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += (v[i] ?? 0) * (v[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i++) v[i] = (v[i] ?? 0) / norm;
  }
  return v;
}

/** Cosine similarity of two L2-normalized vectors = their dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
