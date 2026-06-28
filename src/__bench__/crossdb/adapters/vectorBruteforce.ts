/**
 * adapters/vectorBruteforce.ts — a ZERO-DEP exact-cosine k-NN vector store.
 *
 * This stands in for the VECTOR-DB CLASS in the comparison. The native vector engine
 * the round targeted, `hnswlib-node`, has NO prebuilt binary for win32-x64 / Node 24
 * and falls back to `node-gyp rebuild` (which needs an MSVC toolchain this box lacks),
 * so it is SKIPPED. To still show what a trust-blind nearest-neighbour store does under
 * the attack, this pure-JS brute-force index recalls by cosine similarity over the
 * SAME deterministic embeddings every vector engine would use.
 *
 * DUMB store: recall = MAJORITY value among the top-K nearest neighbours of the cue
 * embedding. Identical poisoned copies all sit at the same top similarity, so the
 * fleet's FALSE value fills the retrieved set and wins once A > H — the expected,
 * honest vector-RAG result (more retrieved copies dominate top-k; CLAUDE.md's "fuzzy
 * nearest-neighbour with no stable structure ... can't resist hallucination").
 *
 * footprintBytes reports an IN-MEMORY estimate: the dense embedding bytes
 * (N x EMBED_DIM x 4) plus the stored value-string bytes.
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { EMBED_DIM, cosine } from "../embeddings.js";

/** Top-K neighbours retrieved per recall (large vs H so copy-count, not tier order, decides). */
const TOP_K = 128;

export function createVectorBruteforceAdapter(): MemoryAdapter {
  const embeddings: Float32Array[] = [];
  const values: string[] = [];
  let valueBytes = 0;

  return {
    name: "vector-bruteforce (in-proc)",

    setup(): void {
      embeddings.length = 0;
      values.length = 0;
      valueBytes = 0;
    },

    writeFact(f: Fact): void {
      embeddings.push(f.embedding);
      values.push(f.value);
      valueBytes += f.value.length * 2;
    },

    recall(cue: Cue): RankedFact[] {
      // Exact top-K by cosine (brute force — no ANN index; latency is O(N) per recall).
      const scored: Array<{ i: number; sim: number }> = [];
      for (let i = 0; i < embeddings.length; i++) {
        scored.push({ i, sim: cosine(cue.embedding, embeddings[i]!) });
      }
      scored.sort((a, b) => b.sim - a.sim);
      const k = Math.min(TOP_K, scored.length);

      // Majority vote among the K nearest (trust-blind: copies count as evidence).
      const tally = new Map<string, number>();
      for (let j = 0; j < k; j++) {
        const v = values[scored[j]!.i]!;
        tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const out: RankedFact[] = [];
      for (const [value, count] of tally) out.push({ value, score: count });
      out.sort((a, b) => b.score - a.score);
      return out;
    },

    footprintBytes(): number {
      return embeddings.length * EMBED_DIM * 4 + valueBytes;
    },

    close(): void {
      embeddings.length = 0;
      values.length = 0;
    },
  };
}
