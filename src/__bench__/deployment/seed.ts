/**
 * deployment/seed.ts — STREAMING on-disk web seeding + tiny stats helpers for the
 * DEPLOYMENT-PROFILE benchmark.
 *
 * Unlike fixtures.buildWeb (which seeds an IN-MEMORY store and materializes the whole
 * web in one pass), this seeds the DURABLE SQLite/WAL backend and NEVER holds the
 * whole web in memory: strands and the cluster-chain edges are generated and flushed
 * in CHUNKS of ~10k via `putStrandsBatch` / `putEdgesBatch`, so a 1M-strand web costs
 * O(chunk) RAM, not O(N). This is exactly how a real bulk-ingest user streams data.
 *
 * WEB SHAPE (the "web of dense local clusters" of CLAUDE.md): N strands grouped into
 * clusters of `CLUSTER_SIZE`. Every strand in a cluster shares ONE entity, so the
 * activation walk DERIVES the cluster's intra-links for free from the store's entity
 * index (writeFact no longer materializes the SHARED_ENTITY clique) — NO intra-cluster
 * edges are stored. Consecutive cluster HUBS (strand c*CLUSTER_SIZE) are chained by ONE
 * materialized CONFIRMED_LINK edge so a recall seeded at hub 0 can spread cluster→cluster
 * until the walk's pop-cap / energy-decay backstop stops it. Because each cluster is its
 * own entity, `strandsByEntity(E)` is O(CLUSTER_SIZE) (bounded), NOT O(N) — the property
 * that makes recall O(local web) rather than O(total facts).
 *
 * Determinism: every id/entity/class is index-derived (no Math.random, no wall clock),
 * so a web of size N is byte-identical run-to-run.
 */

import { EdgeType } from "../../index.js";
import type {
  AttributeKey,
  EntityId,
  SourceId,
  Strand,
  StrandId,
  Edge,
} from "../../index.js";
import type { SqliteStrandStore } from "../../index.js";

import { makeStrand, makeEdge } from "../fixtures.js";

/** Cluster size (strands per shared-entity local web). */
export const CLUSTER_SIZE = 16;
/** Flush chunk size — bounds peak RAM during seeding regardless of N. */
export const CHUNK = 10_000;

/** Entity id for cluster `c` of the size-`n` web. */
export function clusterEntity(n: number, c: number): EntityId {
  return `dep:${n}:ent:${c}` as EntityId;
}

/** Strand id for index `i` of the size-`n` web. */
export function strandId(n: number, i: number): StrandId {
  return `dep:${n}:s:${i}` as StrandId;
}

/** The walk seed: hub of cluster 0. */
export function seedStrandId(n: number): StrandId {
  return strandId(n, 0);
}

/** The hub strand id of cluster `c` (index c*CLUSTER_SIZE). */
export function hubId(n: number, c: number): StrandId {
  return strandId(n, c * CLUSTER_SIZE);
}

export interface SeedResult {
  /** Total strands written. */
  readonly strands: number;
  /** Total chain edges written. */
  readonly edges: number;
  /** Number of clusters. */
  readonly clusters: number;
  /** Wall-clock ms spent seeding. */
  readonly seedMs: number;
}

/**
 * STREAM-seed a size-`n` web into an already-open durable SQLite store. Strands and
 * chain edges are generated and committed in CHUNK-sized batches so peak memory stays
 * O(CHUNK). Each `putStrandsBatch` / `putEdgesBatch` is ONE transaction (one durability
 * barrier), so the whole ingest is fully durable on return.
 */
export function seedWeb(store: SqliteStrandStore, n: number): SeedResult {
  const src = "src:dep" as SourceId;
  const attr: AttributeKey | null = null;
  const t0 = performance.now();

  // 1) Strands, streamed in chunks (never hold all N at once).
  let buf: Strand[] = [];
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / CLUSTER_SIZE);
    buf.push(
      makeStrand(
        `dep:${n}:s:${i}`,
        clusterEntity(n, c),
        src,
        `cls:${n}:${i}`,
        { i },
        attr,
      ),
    );
    if (buf.length >= CHUNK) {
      store.putStrandsBatch(buf);
      buf = [];
    }
  }
  if (buf.length > 0) store.putStrandsBatch(buf);

  // 2) Chain edges: hub(c) -> hub(c+1), one CONFIRMED_LINK per consecutive pair.
  const clusters = Math.ceil(n / CLUSTER_SIZE);
  let ebuf: Edge[] = [];
  let edges = 0;
  for (let c = 0; c + 1 < clusters; c++) {
    ebuf.push(
      makeEdge(
        `dep:${n}:chain:${c}`,
        hubId(n, c),
        hubId(n, c + 1),
        EdgeType.CONFIRMED_LINK,
      ),
    );
    edges++;
    if (ebuf.length >= CHUNK) {
      store.putEdgesBatch(ebuf);
      ebuf = [];
    }
  }
  if (ebuf.length > 0) store.putEdgesBatch(ebuf);

  return { strands: n, edges, clusters, seedMs: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// Tiny stats helpers
// ---------------------------------------------------------------------------

/** Nearest-rank percentile (q in [0,1]) over a numeric sample. Sorts a copy. */
export function percentile(sample: readonly number[], q: number): number {
  if (sample.length === 0) return NaN;
  const a = [...sample].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[idx]!;
}

export function maxOf(sample: readonly number[]): number {
  let m = -Infinity;
  for (const v of sample) if (v > m) m = v;
  return m;
}

export function meanOf(sample: readonly number[]): number {
  if (sample.length === 0) return NaN;
  let s = 0;
  for (const v of sample) s += v;
  return s / sample.length;
}

/** A tiny deterministic LCG so the mixed workload's read/write mix is reproducible. */
export function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
