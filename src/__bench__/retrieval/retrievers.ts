/**
 * retrieval/retrievers.ts — the TWO retrievers under comparison.
 *
 *  - IntelligentDB: mirrors the shared graph into a real engine store (nodes via
 *    putStrand so the SHARED_ENTITY relation lives in the entity index exactly as
 *    writeFact represents it; CONFIRMED_LINK relations materialized as edges), wires
 *    the real reputation + identity + ratification layers, runs the engine's
 *    adjudication over the contradiction attributes, and answers a query by seeding
 *    `recall()` with the SHARED seed and returning the lit set ranked by activation.
 *
 *  - TunedHybrid: a real graph+vector baseline (NOT a strawman). Per query it fuses
 *    a vector-kNN channel (top-s by cosine) and a graph-proximity channel (≤h hops
 *    from the SAME shared seed) via Reciprocal Rank Fusion with a tunable k and
 *    fusion weight. Its hyper-parameters are GRID-TUNED on the dev split and frozen.
 *
 * Both consume the same graph, the same embeddings, and the same per-query seed.
 */

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  generatePassport,
  asStrandId,
  EdgeType,
  FactState,
} from "../../index.js";
import type {
  IntelligentDb,
  StrandStore,
  SourceId,
  Unit,
  EpochMs,
  EntityId,
  AttributeKey,
  StrandId,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  ReputationLedger,
  RatificationDeps,
  AnchorBinding,
} from "../../index.js";

import { makeStrand, makeEdge, NOW } from "../fixtures.js";
import type { Dataset, QueryRecord, ContradictionPair } from "./dataset.js";
import {
  cosineRanking,
  graphExpand,
  sharedSeed,
  type SharedGraph,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Shared minimal identity ports (we exercise reputation + adjudication, not the
// full anchor pipeline; rep caps are injected directly).
// ---------------------------------------------------------------------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register: (p) => void known.add(p.sourceId),
    sourceIdOf: (s) => (known.has(s) ? s : null),
    has: (s) => known.has(s),
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  return {
    bind: () => {},
    anchorsOf: (): readonly AnchorBinding[] => [],
    aggregateCost: (): Unit => 0 as Unit,
    independenceBetween: (): Unit => 0 as Unit,
  };
}

export interface IdRetriever {
  /** Ranked fact ids (by activation desc) for a query's shared seed. The FULL lit set. */
  retrieve(query: QueryRecord, cueVec: Float32Array): string[];
  /** After adjudication: for each contradiction attribute, the fact id kept LIVE. */
  liveWinnerOf(pair: ContradictionPair): string | null;
  /** Engine handle (for inspection). */
  readonly engine: IntelligentDb;
  readonly store: StrandStore;
}

/**
 * Build the IntelligentDB retriever over the shared graph: mirror nodes/edges, wire
 * reputation/identity/ratification, pre-earn the trusted sources, then RUN the
 * engine's adjudication on every contradiction attribute (so one side is DEMOTED and
 * the believed value is LIVE).
 */
export function createIdRetriever(graph: SharedGraph, dataset: Dataset): IdRetriever {
  const store: StrandStore = createMemoryStore();

  // 1) Mirror NODES. The strand id IS the fact id; the entity index gives the
  //    SHARED_ENTITY relation (as the real engine represents it), so no SHARED_ENTITY
  //    edges are materialized.
  for (const f of dataset.facts) {
    store.putStrand(
      makeStrand(f.id, f.entity as EntityId, f.sourceId as SourceId, f.sourceClass, { value: f.value }, f.attribute as AttributeKey),
    );
  }
  // 2) Mirror CONFIRMED_LINK edges (materialized threads the walk traverses).
  const touched = new Set<string>();
  for (const e of dataset.edges) {
    if (e.type !== "CONFIRMED_LINK") continue;
    store.putEdge(makeEdge(`e:${e.from}->${e.to}`, asStrandId(e.from), asStrandId(e.to), EdgeType.CONFIRMED_LINK));
    touched.add(e.from);
  }
  for (const id of touched) store.recomputeOutWeightSum(asStrandId(id));

  // 3) Wire reputation + identity + ratification.
  const trusted = new Set<SourceId>(dataset.trustedSources as SourceId[]);
  const repCapOf = (s: SourceId): Unit => (trusted.has(s) ? 0.95 : 0.05) as Unit;
  const clock = (): EpochMs => NOW;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, clock);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSigner: generatePassport() };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  // 4) Pre-earn the trusted (authority) sources to a decisive LCB.
  for (const s of dataset.trustedSources) {
    for (let i = 0; i < 8; i++) reputation.ratify(s as SourceId, NOW, 1 as Unit);
  }

  // 5) Adjudicate every contradiction attribute; record the LIVE winner.
  const liveWinner = new Map<string, string | null>();
  for (const pair of dataset.contradictions) {
    engine.adjudicate(pair.attribute as AttributeKey);
    const t = store.getStrand(asStrandId(pair.trueFactId));
    const fls = store.getStrand(asStrandId(pair.falseFactId));
    const winner =
      t?.fact_state === FactState.LIVE && fls?.fact_state !== FactState.LIVE
        ? pair.trueFactId
        : fls?.fact_state === FactState.LIVE && t?.fact_state !== FactState.LIVE
          ? pair.falseFactId
          : null; // both still live (no decisive resolution) => null
    liveWinner.set(pair.attribute, winner);
  }

  return {
    engine,
    store,
    liveWinnerOf: (pair) => liveWinner.get(pair.attribute) ?? null,
    retrieve(query, cueVec) {
      const seedIds = sharedSeed(graph, query, cueVec);
      const seeds = seedIds.map((id) => ({ strandId: asStrandId(id), energy: 1 as Unit }));
      const res = engine.recall({ seeds });
      return [...res.lit]
        .sort((a, b) => (b.activation - a.activation) || (String(a.strandId) < String(b.strandId) ? -1 : 1))
        .map((l) => String(l.strandId));
    },
  };
}

// ---------------------------------------------------------------------------
// Tuned hybrid baseline
// ---------------------------------------------------------------------------

export interface HybridConfig {
  /** Vector-kNN seed size (top-s by cosine). */
  readonly s: number;
  /** Graph-expansion hop radius from the shared seed. */
  readonly h: number;
  /** RRF damping constant k. */
  readonly k: number;
  /** Fusion weight on the GRAPH channel (vector channel gets 1 - alpha). */
  readonly alpha: number;
}

export const HYBRID_GRID: HybridConfig[] = (() => {
  const out: HybridConfig[] = [];
  for (const s of [5, 10, 20]) {
    for (const h of [1, 2]) {
      for (const k of [10, 30, 60]) {
        for (const alpha of [0.3, 0.5, 0.7]) {
          out.push({ s, h, k, alpha });
        }
      }
    }
  }
  return out;
})();

/**
 * Reciprocal-Rank-Fusion hybrid retrieve: fuse the top-s vector channel and the
 * ≤h-hop graph-proximity channel (rooted at the SHARED seed) by
 *   score(c) = alpha * 1/(k + rankGraph) + (1-alpha) * 1/(k + rankVec)
 * (each term present only when c is in that channel). Returns the fused ranking.
 */
export function hybridRetrieve(
  graph: SharedGraph,
  query: QueryRecord,
  cueVec: Float32Array,
  cfg: HybridConfig,
): string[] {
  const ranking = cosineRanking(graph, cueVec);
  const cosOf = new Map<string, number>();
  ranking.forEach((r) => cosOf.set(r.id, r.sim));

  // Vector channel: top-s by cosine, ranked 1..s.
  const rankVec = new Map<string, number>();
  for (let i = 0; i < Math.min(cfg.s, ranking.length); i++) rankVec.set(ranking[i]!.id, i + 1);

  // Graph channel: ≤h hops from the shared seed, ranked by (hop asc, cosine desc).
  const seeds = sharedSeed(graph, query, cueVec);
  const dist = graphExpand(graph, seeds, cfg.h);
  const graphIds = [...dist.keys()].sort((a, b) => {
    const dh = dist.get(a)! - dist.get(b)!;
    if (dh !== 0) return dh;
    return (cosOf.get(b)! - cosOf.get(a)!) || (a < b ? -1 : 1);
  });
  const rankGraph = new Map<string, number>();
  graphIds.forEach((id, i) => rankGraph.set(id, i + 1));

  const candidates = new Set<string>([...rankVec.keys(), ...rankGraph.keys()]);
  const scored = [...candidates].map((c) => {
    const gv = rankGraph.has(c) ? cfg.alpha / (cfg.k + rankGraph.get(c)!) : 0;
    const vv = rankVec.has(c) ? (1 - cfg.alpha) / (cfg.k + rankVec.get(c)!) : 0;
    return { id: c, score: gv + vv };
  });
  scored.sort((a, b) => (b.score - a.score) || ((cosOf.get(b.id) ?? 0) - (cosOf.get(a.id) ?? 0)) || (a.id < b.id ? -1 : 1));
  return scored.map((x) => x.id);
}
