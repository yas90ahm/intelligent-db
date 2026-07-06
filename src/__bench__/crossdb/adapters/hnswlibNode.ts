/**
 * adapters/hnswlibNode.ts — the `hnswlib-node` (Hierarchical NSW) native ANN adapter.
 *
 * `hnswlib-node` has no win32-x64/Node-24 prebuilt binary and falls back to
 * `node-gyp rebuild`, which needs an MSVC toolchain — this adapter is wired in only once
 * Visual Studio Build Tools ("Desktop development with C++") are installed on the box, so
 * the native addon actually compiles. It is the ANN-GRAPH counterpart to `faissNode.ts`'s
 * exact-search native index: same deterministic 64-d embeddings, same trust-blind
 * majority-vote-among-top-K recall semantics (no entity filter — mirrors
 * `vector-bruteforce.ts` exactly), but backed by a real Hierarchical Navigable Small World
 * graph instead of an exhaustive scan.
 *
 * DUMB store: recall = MAJORITY value among the top-K approximate nearest neighbours of
 * the cue embedding. Identical poisoned copies sit at (near-)zero distance from each
 * other and from the cue, so HNSW's greedy graph search finds them just as reliably as an
 * exact index for this workload; the fleet's FALSE value fills the retrieved set and wins
 * once A > H — the expected, honest vector-RAG result.
 *
 * CAPACITY: HNSW pre-allocates `maxElements` at `initIndex()`; the index starts generous
 * (`INITIAL_MAX_ELEMENTS`) and `resizeIndex()`s itself (doubling) if a write ever exceeds
 * it, so the adapter is robust to the harness's write volume changing later.
 *
 * footprintBytes reports a REAL on-disk figure: `writeIndexSync()` serializes the graph to
 * a temp file (mirrors the sqlite/lmdb/duckdb adapters' on-disk-file convention) and the
 * file size (+ the JS-side value-string bytes, which HNSW itself does not store) is
 * measured via `util.ts`'s `fileFootprint`.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `hnswlib-node` is CJS, loaded
 * via a runtime dynamic import (mirrors faiss-node/Qdrant/pgvector/Redis) so a missing/
 * unbuildable native module skips only THIS adapter (not the runner).
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM } from "../embeddings.js";
import { tempPath, fileFootprint, cleanupPath } from "../util.js";

/** Top-K neighbours retrieved per recall (large vs H so copy-count, not tier order, decides). */
const TOP_K = 128;
/** Generous starting capacity; doubled on demand if the write volume ever exceeds it. */
const INITIAL_MAX_ELEMENTS = 8192;
/** Search-time breadth (`ef`) — kept well above TOP_K so majority-vote quality isn't ANN-starved. */
const EF_SEARCH = 256;

interface HnswSearchResult {
  distances: number[];
  neighbors: number[];
}
interface HierarchicalNSWLike {
  initIndex(maxElements: number): void;
  resizeIndex(newMaxElements: number): void;
  addPoint(point: number[], label: number): void;
  searchKnn(queryPoint: number[], numNeighbors: number): HnswSearchResult;
  getCurrentCount(): number;
  setEf(ef: number): void;
  writeIndexSync(filename: string): void;
}
interface HnswModule {
  HierarchicalNSW: new (spaceName: "l2" | "ip" | "cosine", numDimensions: number) => HierarchicalNSWLike;
}

export function createHnswlibNodeAdapter(): MemoryAdapter {
  let index: HierarchicalNSWLike | null = null;
  let maxElements = INITIAL_MAX_ELEMENTS;
  let path = "";
  const values: string[] = [];
  let valueBytes = 0;

  return {
    name: "hnswlib-node (HierarchicalNSW)",

    async setup(): Promise<void> {
      const mod = (await import("hnswlib-node")) as unknown as HnswModule;
      const idx = new mod.HierarchicalNSW("l2", EMBED_DIM);
      maxElements = INITIAL_MAX_ELEMENTS;
      idx.initIndex(maxElements);
      idx.setEf(EF_SEARCH);
      index = idx;
      path = tempPath("hnswlib") + ".bin";
      values.length = 0;
      valueBytes = 0;
    },

    writeFact(f: Fact): void {
      if (index === null) return;
      if (index.getCurrentCount() >= maxElements) {
        maxElements *= 2;
        index.resizeIndex(maxElements);
      }
      index.addPoint(Array.from(f.embedding), values.length);
      values.push(f.value);
      valueBytes += f.value.length * 2;
    },

    recall(cue: Cue): RankedFact[] {
      if (index === null) return [];
      const total = index.getCurrentCount();
      if (total === 0) return [];
      const k = Math.min(TOP_K, total);
      const { neighbors } = index.searchKnn(Array.from(cue.embedding), k);

      // Trust-blind majority vote among the retrieved neighbours (copies count as evidence).
      const tally = new Map<string, number>();
      for (const label of neighbors) {
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
      index.writeIndexSync(path);
      return fileFootprint(path) + valueBytes;
    },

    close(): void {
      index = null;
      values.length = 0;
      valueBytes = 0;
      cleanupPath(path);
    },
  };
}
