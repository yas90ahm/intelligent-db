/**
 * adapters/faissNode.ts — the FAISS (`faiss-node`) native vector-index adapter.
 *
 * `faiss-node` ships a win32-x64 prebuilt N-API binary (via `prebuild-install`), so unlike
 * `hnswlib-node` it needs no MSVC toolchain on this box. This adapter is the NATIVE-INDEX
 * counterpart to `vectorBruteforce.ts`'s pure-JS stand-in: same deterministic 64-d
 * embeddings, same trust-blind majority-vote-among-top-K recall semantics, same "no
 * provenance/independence model" story — the only difference is the nearest-neighbour
 * search itself runs in FAISS's native `IndexFlatL2` (exact L2 search, no ANN
 * approximation, so results are apples-to-apples with the brute-force cosine index modulo
 * the L2-vs-cosine metric — both operate over the SAME L2-normalized vectors, where L2
 * distance and cosine similarity induce the identical nearest-neighbour ordering).
 *
 * DUMB store: recall = MAJORITY value among the top-K nearest neighbours of the cue
 * embedding (no entity filter — mirrors `vectorBruteforce.ts` exactly, not the
 * entity-filtered Qdrant/pgvector/Redis pattern, so the two in-process vector stands-ins
 * are directly comparable). Identical poisoned copies all sit at the same top distance, so
 * the fleet's FALSE value fills the retrieved set and wins once A > H — the expected,
 * honest vector-RAG result.
 *
 * footprintBytes reports an IN-MEMORY estimate: FAISS's own serialized index size
 * (`index.toBuffer().length`, the native vectors + index metadata) plus the JS-side stored
 * value-string bytes (FAISS has no notion of the string payload).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `faiss-node` is CJS, loaded
 * via a runtime dynamic import (mirrors the Qdrant/pgvector/Redis adapters) so a missing/
 * unbuildable native module skips only THIS adapter (not the runner).
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM } from "../embeddings.js";

/** Top-K neighbours retrieved per recall (large vs H so copy-count, not tier order, decides). */
const TOP_K = 128;

/** Minimal structural typing of the bits of `faiss-node` we use. */
interface FaissSearchResult {
  distances: number[];
  labels: number[];
}
interface FaissIndexLike {
  ntotal(): number;
  add(x: number[]): void;
  search(x: number[], k: number): FaissSearchResult;
  toBuffer(): Buffer;
}
interface FaissModule {
  IndexFlatL2: new (d: number) => FaissIndexLike;
}

export function createFaissNodeAdapter(): MemoryAdapter {
  let index: FaissIndexLike | null = null;
  const values: string[] = [];
  let valueBytes = 0;

  return {
    name: "faiss-node (IndexFlatL2)",

    async setup(): Promise<void> {
      const mod = (await import("faiss-node")) as unknown as FaissModule;
      index = new mod.IndexFlatL2(EMBED_DIM);
      values.length = 0;
      valueBytes = 0;
    },

    writeFact(f: Fact): void {
      if (index === null) return;
      index.add(Array.from(f.embedding));
      values.push(f.value);
      valueBytes += f.value.length * 2;
    },

    recall(cue: Cue): RankedFact[] {
      if (index === null) return [];
      const total = index.ntotal();
      if (total === 0) return [];
      const k = Math.min(TOP_K, total);
      const { labels } = index.search(Array.from(cue.embedding), k);

      // Trust-blind majority vote among the retrieved neighbours (copies count as evidence).
      const tally = new Map<string, number>();
      for (const label of labels) {
        if (label < 0) continue; // FAISS pads short result sets with -1.
        const v = values[label];
        if (v !== undefined) tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const out: RankedFact[] = [];
      for (const [value, count] of tally) out.push({ value, score: count });
      out.sort((a, b) => b.score - a.score);
      return out;
    },

    footprintBytes(): number {
      if (index === null) return valueBytes;
      return index.toBuffer().length + valueBytes;
    },

    close(): void {
      index = null;
      values.length = 0;
      valueBytes = 0;
    },
  };
}
