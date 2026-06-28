/**
 * retrieval/graph.ts — the ONE shared graph + the ONE shared seeding protocol.
 *
 * A single immutable graph object is built from the dataset and the (already
 * computed) fact embeddings. BOTH retrievers consume THIS object: same nodes, same
 * typed edges (SHARED_ENTITY + CONFIRMED_LINK), same vectors. The per-query SEED is
 * derived here too, by ONE protocol used by both systems, so fairness is auditable.
 *
 * SEEDING PROTOCOL (identical for both systems):
 *   sharedSeed(q) = { all nodes whose `entity` exactly equals a cue entity }  (entity-match)
 *                 ∪ { the single highest-cosine node to the cue text }        (vector top-1)
 * The IntelligentDB walk energizes sharedSeed(q) as its seeds; the tuned hybrid uses
 * sharedSeed(q) as its graph-expansion root (and the global cosine ranking as its
 * vector channel). Neither system sees any signal the other does not.
 */

import { cosine } from "./embed.js";
import type { Dataset, FactRecord, QueryRecord } from "./dataset.js";

export interface SharedGraph {
  readonly facts: readonly FactRecord[];
  readonly idIndex: ReadonlyMap<string, number>;
  /** factId -> its embedding (aligned to `facts` by index). */
  readonly vectorOf: (id: string) => Float32Array;
  /** Undirected adjacency (union of SHARED_ENTITY + CONFIRMED_LINK) for proximity. */
  readonly neighborsOf: (id: string) => readonly string[];
  /** entity -> the fact ids about it. */
  readonly entityFacts: (entity: string) => readonly string[];
}

export function buildGraph(dataset: Dataset, factVectors: readonly Float32Array[]): SharedGraph {
  const idIndex = new Map<string, number>();
  dataset.facts.forEach((f, i) => idIndex.set(f.id, i));

  const adj = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = adj.get(id);
    if (s === undefined) {
      s = new Set<string>();
      adj.set(id, s);
    }
    return s;
  };
  for (const e of dataset.edges) {
    ensure(e.from).add(e.to);
    ensure(e.to).add(e.from); // undirected for proximity
  }

  const entityMap = new Map<string, string[]>();
  for (const f of dataset.facts) {
    const arr = entityMap.get(f.entity) ?? [];
    arr.push(f.id);
    entityMap.set(f.entity, arr);
  }

  return {
    facts: dataset.facts,
    idIndex,
    vectorOf: (id) => factVectors[idIndex.get(id)!]!,
    neighborsOf: (id) => [...(adj.get(id) ?? [])],
    entityFacts: (entity) => entityMap.get(entity) ?? [],
  };
}

// ---------------------------------------------------------------------------
// The shared seeding protocol
// ---------------------------------------------------------------------------

/** The entity-match component of the seed: every node whose entity the cue names. */
export function entityMatchSeed(graph: SharedGraph, query: QueryRecord): string[] {
  const out: string[] = [];
  for (const e of query.cueEntities) out.push(...graph.entityFacts(e));
  return out;
}

/** The single highest-cosine node to the cue (the vector top-1 component). */
export function vectorTop1(graph: SharedGraph, cueVec: Float32Array): string {
  let bestId = graph.facts[0]!.id;
  let bestSim = -Infinity;
  for (const f of graph.facts) {
    const sim = cosine(cueVec, graph.vectorOf(f.id));
    if (sim > bestSim) {
      bestSim = sim;
      bestId = f.id;
    }
  }
  return bestId;
}

/** SHARED SEED = entity-match nodes ∪ { vector top-1 }. Deterministic, de-duplicated. */
export function sharedSeed(graph: SharedGraph, query: QueryRecord, cueVec: Float32Array): string[] {
  const set = new Set<string>(entityMatchSeed(graph, query));
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/** Global cosine ranking of EVERY node to the cue (descending). The vector channel. */
export function cosineRanking(graph: SharedGraph, cueVec: Float32Array): Array<{ id: string; sim: number }> {
  const scored = graph.facts.map((f) => ({ id: f.id, sim: cosine(cueVec, graph.vectorOf(f.id)) }));
  scored.sort((a, b) => (b.sim - a.sim) || (a.id < b.id ? -1 : 1));
  return scored;
}

/**
 * Breadth-first graph expansion from `seeds` over the undirected adjacency, returning
 * each reachable node's HOP distance (seeds = 0) up to `maxHops`. The tuned hybrid's
 * graph-proximity channel.
 */
export function graphExpand(graph: SharedGraph, seeds: readonly string[], maxHops: number): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      frontier.push(s);
    }
  }
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of graph.neighborsOf(id)) {
        if (!dist.has(nb)) {
          dist.set(nb, hop);
          next.push(nb);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return dist;
}
