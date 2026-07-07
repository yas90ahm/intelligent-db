/**
 * examples/embedders.ts — REFERENCE {@link EmbedderPort} IMPLEMENTATIONS.
 *
 * The core ships NO embedder (zero runtime deps — see core/types.ts's
 * `EmbedderPort` doc and docs/specs/PHASE1_RETRIEVAL_SPEC.md §1). This module is
 * the reference wiring a caller opts into; it is DELIBERATELY not exported from
 * the barrel (`src/index.ts`) — a deployment picks (or replaces) its embedder,
 * the library does not ship one as a default dependency.
 *
 * Two implementations:
 *
 *   - {@link createOllamaEmbedder} — a local Ollama HTTP embedder (default model
 *     `nomic-embed-text`, 768-d). Uses the global `fetch` (Node 18+ built-in —
 *     still zero runtime deps) against Ollama's batch `/api/embed` endpoint. A
 *     network/model failure THROWS; the caller (`api.ts`'s
 *     `writeFactWithEmbeddingAsync`) catches it and writes the fact WITHOUT a vector
 *     — embeddings are an accelerator, never a gate (spec §2).
 *
 *   - {@link createHashingEmbedder} — the deterministic hashing-trick embedder
 *     already used by the cross-DB benchmark (`__bench__/crossdb/embeddings.ts`),
 *     generalized to a configurable dimension and wrapped in the async
 *     `EmbedderPort` shape. No network, no model weights, no randomness —
 *     byte-identical vectors for identical text on any machine. Useful for
 *     tests and for the adversarial embedding-stuffing gate (spec §5.4), where
 *     a fast, offline, reproducible embedding is what the test needs, not
 *     semantic quality.
 *
 * THE THESIS CONSTRAINT applies to BOTH: an embedder here may only ever help
 * `recall` pick WHERE TO LOOK (seeding). Nothing in this module — or anything
 * that consumes it — may let a cosine score influence `fact_state`,
 * adjudication, independence counting, reputation, or eviction.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`
 * ⇒ every type-only import uses `import type`. Zero external runtime deps: only
 * the global `fetch`/`AbortController` (Node built-ins) and no `node:` imports
 * are needed here.
 */

import type { EmbedderPort } from "../core/types.js";

// ---------------------------------------------------------------------------
// Ollama HTTP embedder
// ---------------------------------------------------------------------------

/** Options for {@link createOllamaEmbedder}. Every field is optional. */
export interface OllamaEmbedderOptions {
  /** Ollama's HTTP base URL. Default `"http://localhost:11434"`. */
  readonly baseUrl?: string;
  /** Model name Ollama serves. Default `"nomic-embed-text"`. */
  readonly model?: string;
  /** Output vector dimensionality (informational; not validated against the
   * server's actual response length). Default 768 (nomic-embed-text's native
   * dimension). */
  readonly dim?: number;
  /** Per-request abort timeout in ms. Default 30000. */
  readonly timeoutMs?: number;
  /** Override `fetch` (e.g. for tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Default Ollama embeddings HTTP base URL. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Default Ollama embedding model — a small, local, CPU-friendly embedder. */
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
/** `nomic-embed-text`'s native output dimensionality. */
export const DEFAULT_OLLAMA_DIM = 768;

/**
 * A reference {@link EmbedderPort} over a locally running Ollama server's batch
 * `/api/embed` endpoint (`{ model, input: string[] }` → `{ embeddings: number[][] }`,
 * one embedding per input in order). `modelId` is prefixed `ollama:` so a vector
 * sidecar keyed by `model_id` never confuses an Ollama-minted vector with one
 * from a different embedder (e.g. the hashing-trick reference below), even if
 * both happened to share a bare model name.
 *
 * FAILS LOUD (throws) on a network error, a non-2xx response, or a response
 * shape mismatch — it is the CALLER's job (per the spec's "embeddings are an
 * accelerator, never a gate") to catch this and proceed without a vector. This
 * module does not swallow errors itself, so a caller that forgets to catch
 * finds out immediately rather than silently losing embeddings.
 */
export function createOllamaEmbedder(opts?: OllamaEmbedderOptions): EmbedderPort {
  const baseUrl = opts?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const model = opts?.model ?? DEFAULT_OLLAMA_MODEL;
  const dim = opts?.dim ?? DEFAULT_OLLAMA_DIM;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const doFetch = opts?.fetchImpl ?? fetch;

  return {
    dim,
    modelId: `ollama:${model}`,

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `createOllamaEmbedder: /api/embed returned ${res.status} ${res.statusText}: ${body}`,
          );
        }
        const json = (await res.json()) as { embeddings?: unknown };
        const embeddings = json.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
          throw new Error(
            `createOllamaEmbedder: expected ${texts.length} embeddings, got ` +
              `${Array.isArray(embeddings) ? embeddings.length : typeof embeddings}`,
          );
        }
        return embeddings.map((row) => Float32Array.from(row as number[]));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Hashing-trick embedder (deterministic, zero-network, zero-deps)
// ---------------------------------------------------------------------------

/** Options for {@link createHashingEmbedder}. */
export interface HashingEmbedderOptions {
  /** Output vector dimensionality. Default 64 (matches the crossdb bench). */
  readonly dim?: number;
}

/** FNV-1a 32-bit hash of a string — deterministic, fast, no deps. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Lowercase alnum tokenization (matches the engine's lexical cue tokenizer shape). */
function hashingTokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

/**
 * Map arbitrary text to a fixed-dim, L2-normalized Float32 vector via the
 * hashing trick: each token hashes to a dimension index and a sign,
 * accumulated, then L2-normalized so cosine similarity reduces to a dot
 * product. Deterministic — the same text always yields the same vector, on
 * any machine, with no model weights and no randomness. An empty/no-token text
 * yields a zero vector (cosine with it is 0 per {@link "../store/vectorSidecar".cosineSimilarity}).
 */
function hashEmbed(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (const tok of hashingTokenize(text)) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = ((h >>> 8) & 1) === 1 ? 1 : -1;
    v[idx] = (v[idx] ?? 0) + sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += (v[i] ?? 0) * (v[i] ?? 0);
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  }
  return v;
}

/**
 * A reference {@link EmbedderPort} implementing the SAME deterministic
 * "hashing trick" already used by the cross-DB benchmark
 * (`__bench__/crossdb/embeddings.ts`) — not a semantic embedding, a stable,
 * cheap, reproducible stand-in whose job is to give a consistent geometry for
 * nearest-neighbor recall over. Useful for tests (including the adversarial
 * embedding-stuffing gate, spec §5.4) that need fast, offline, byte-reproducible
 * vectors rather than semantic quality. `embed` is `async` only to satisfy the
 * {@link EmbedderPort} contract — the computation itself is synchronous and
 * never throws.
 */
export function createHashingEmbedder(opts?: HashingEmbedderOptions): EmbedderPort {
  const dim = opts?.dim ?? 64;

  return {
    dim,
    modelId: `hashing-trick:${dim}`,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => hashEmbed(t, dim));
    },
  };
}
