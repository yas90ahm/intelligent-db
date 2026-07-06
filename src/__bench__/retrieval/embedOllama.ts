/**
 * retrieval/embedOllama.ts — the SHARED nomic-embed-text embedder (via local Ollama),
 * mirroring embed.ts's MiniLM helper exactly (same cache scheme, same batching contract)
 * so the two are drop-in-swappable for the Phase 1c D1/D2 embedder-parity diagnostics
 * (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md).
 *
 * Uses the reference `createOllamaEmbedder` from `src/examples/embedders.ts` (the same
 * production embedder wiring, not a bench-only reimplementation) against a locally running
 * Ollama server's `/api/embed` endpoint. Vectors are cached to a temp JSON file keyed by a
 * hash of the model id + the exact ordered text list, so a re-run with the same corpus
 * skips the (slow) network call. The caller is responsible for removing the cache file
 * when done.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOllamaEmbedder } from "../../examples/embedders.js";
import { ollamaHost } from "./qa/ollama.js";

export const OLLAMA_EMBED_MODEL = "nomic-embed-text";
export const OLLAMA_MODEL_ID = `ollama:${OLLAMA_EMBED_MODEL}`;
export const OLLAMA_EMBED_DIM = 768;

/** Matches embed.ts's transformers batch size — same batching contract, different transport. */
const BATCH = 64;

function cacheKey(texts: readonly string[]): string {
  const h = createHash("sha256");
  h.update(OLLAMA_MODEL_ID);
  h.update(" ");
  for (const t of texts) {
    h.update(t);
    h.update(" ");
  }
  return h.digest("hex").slice(0, 32);
}

export function ollamaCachePathFor(texts: readonly string[]): string {
  return join(tmpdir(), `idb-retrieval-emb-ollama-${cacheKey(texts)}.json`);
}

/**
 * Embed `texts` in order via the local Ollama `nomic-embed-text` model, returning one
 * 768-d vector per text (whatever normalization Ollama's own embedding response carries —
 * unlike embed.ts's MiniLM path, this does not re-normalize, matching how mem0's own
 * Ollama-backed embedder consumes the same model). Uses the on-disk cache when present.
 * Batches the HTTP call to bound request size/memory (same `BATCH=64` as embed.ts).
 */
export async function embedTextsOllama(texts: readonly string[]): Promise<Float32Array[]> {
  const path = ollamaCachePathFor(texts);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as number[][];
      if (Array.isArray(raw) && raw.length === texts.length) {
        return raw.map((r) => Float32Array.from(r));
      }
    } catch {
      /* fall through to recompute */
    }
  }

  const embedder = createOllamaEmbedder({
    baseUrl: ollamaHost(),
    model: OLLAMA_EMBED_MODEL,
    dim: OLLAMA_EMBED_DIM,
    timeoutMs: 60_000,
  });

  const out: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const batch = texts.slice(start, start + BATCH);
    const vecs = await embedder.embed([...batch]);
    for (const v of vecs) out.push(v);
  }

  try {
    writeFileSync(path, JSON.stringify(out.map((v) => Array.from(v))));
  } catch {
    /* cache is best-effort */
  }
  return out;
}
