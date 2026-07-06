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
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  ReputationLedger,
  RatificationDeps,
  AnchorBinding,
  WalkConfig,
  ContentHash,
} from "../../index.js";

import { makeStrand, makeEdge, NOW } from "../fixtures.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";
import type { Dataset, QueryRecord, ContradictionPair } from "./dataset.js";
import { cosine } from "./embed.js";
import {
  cosineRanking,
  graphExpand,
  sharedSeed,
  vectorTopK,
  type SharedGraph,
} from "./graph.js";
import type { LocomoConversation } from "./locomo.js";

// ---------------------------------------------------------------------------
// Shared minimal identity ports (we exercise reputation + adjudication, not the
// full anchor pipeline; rep caps are injected directly).
// ---------------------------------------------------------------------------

function makeSourceRegistry(): SourceRegistryPort {
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
  //    `content_hash` normally derives from the fact's own id (`makeStrand`'s
  //    `hash:${idRaw}`, id-keyed, NOT value-keyed); when a fact carries an explicit
  //    `contentHashKey` (a genuinely separate corroborating witness fact meant to
  //    agree on the SAME value as another fact), the strand's `content_hash` is
  //    overridden to that key's hash instead, so the engine's `#deriveAgreementSet`
  //    (same entity + same content_hash + LIVE, `api.ts:1494-1503`) counts it as
  //    agreement rather than a distinct unrelated claim.
  for (const f of dataset.facts) {
    const strand = makeStrand(
      f.id, f.entity as EntityId, f.sourceId as SourceId | null, f.sourceClass, { value: f.value }, f.attribute as AttributeKey,
    );
    store.putStrand(
      f.contentHashKey !== undefined
        ? { ...strand, content_hash: `hash:${f.contentHashKey}` as ContentHash }
        : strand,
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
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSource: freshSource().sourceId };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  // 4) Pre-earn the trusted (authority) sources to a decisive LCB.
  for (const s of dataset.trustedSources) {
    for (let i = 0; i < PRIMARY_WARMUP_RATIFIES; i++) reputation.ratify(s as SourceId, NOW, 1 as Unit);
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

// ===========================================================================
// CYCLE B — LoCoMo arms (same graph, same embeddings, SAME per-query seed)
// ===========================================================================
//
// Fairness: the runner computes ONE seed per query (entity-match ∪ vector top-1) and
// hands the IDENTICAL seed to all three arms. The graph and the embeddings are shared.
// The hybrid is RE-TUNED on the LoCoMo dev split; the ID+rerank blend is tuned on dev.

/**
 * RRF hybrid over a PRECOMPUTED seed (so every arm provably shares the exact seed). The
 * fusion math is identical to {@link hybridRetrieve}; only the seed is injected rather
 * than recomputed from a `QueryRecord`. (Cycle A's `hybridRetrieve` is unchanged.)
 */
export function hybridRetrieveFromSeed(
  graph: SharedGraph,
  seeds: readonly string[],
  cueVec: Float32Array,
  cfg: HybridConfig,
): string[] {
  const ranking = cosineRanking(graph, cueVec);
  const cosOf = new Map<string, number>();
  ranking.forEach((r) => cosOf.set(r.id, r.sim));

  const rankVec = new Map<string, number>();
  for (let i = 0; i < Math.min(cfg.s, ranking.length); i++) rankVec.set(ranking[i]!.id, i + 1);

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

/** A lit strand with the activation energy the walk ended holding. */
export interface LitEnergy {
  readonly id: string;
  readonly energy: number;
}

export interface LocomoIdRetriever {
  /**
   * The FULL lit set (auto-halted) with activation energy, for a precomputed seed.
   * `config` is passed straight through to `recall()` via `cue.config` (adapter-level
   * walk tuning — the engine is untouched); when absent the engine's
   * {@link DEFAULT_WALK_CONFIG} governs the walk.
   */
  retrieveLit(seedIds: readonly string[], config?: WalkConfig): LitEnergy[];
  readonly engine: IntelligentDb;
  readonly store: StrandStore;
}

/**
 * Arm 1 (Pure ID) substrate for ONE LoCoMo conversation: mirror every turn as a strand
 * (entity = speaker, so the engine's bounded entity-index sibling fan carries the
 * SAME-SPEAKER relation) and materialize every SHARED_ENTITY(mention) + CONFIRMED_LINK
 * edge (both directions) so the activation walk can traverse them. No contradictions /
 * reputation pre-earning (LoCoMo plants none); the minimal identity wiring just lets the
 * engine run. `recall` energizes the shared seed and returns the lit set by activation.
 */
export function createLocomoIdRetriever(conv: LocomoConversation): LocomoIdRetriever {
  const store: StrandStore = createMemoryStore();

  for (const t of conv.turns) {
    store.putStrand(
      makeStrand(
        t.id,
        t.speaker as unknown as EntityId,
        `src:${t.speaker}` as SourceId,
        `spk:${t.speaker}`,
        { text: t.text },
        `${t.id}#text` as AttributeKey,
      ),
    );
  }

  const touched = new Set<string>();
  let edgeSeq = 0;
  const addDir = (from: string, to: string, type: EdgeType): void => {
    store.putEdge(makeEdge(`e:${edgeSeq++}:${from}->${to}`, asStrandId(from), asStrandId(to), type));
    touched.add(from);
  };
  for (const e of conv.edges) {
    const type = e.type === "CONFIRMED_LINK" ? EdgeType.CONFIRMED_LINK : EdgeType.SHARED_ENTITY;
    addDir(e.from, e.to, type);
    addDir(e.to, e.from, type);
  }
  for (const id of touched) store.recomputeOutWeightSum(asStrandId(id));

  const trusted = new Set<SourceId>();
  const repCapOf = (s: SourceId): Unit => (trusted.has(s) ? 0.95 : 0.05) as Unit;
  const clock = (): EpochMs => NOW;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, clock);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSource: freshSource().sourceId };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  return {
    engine,
    store,
    retrieveLit(seedIds, config) {
      const present = seedIds.filter((id) => store.getStrand(asStrandId(id)) !== null);
      if (present.length === 0) return [];
      const seeds = present.map((id) => ({ strandId: asStrandId(id), energy: 1 as Unit }));
      // ADAPTER-LEVEL widening: the optional WalkConfig rides through `cue.config`
      // (DEFAULT_WALK_CONFIG when omitted). No engine source is touched.
      const res = config === undefined ? engine.recall({ seeds }) : engine.recall({ seeds, config });
      return [...res.lit]
        .map((l) => ({ id: String(l.strandId), energy: l.activation }))
        .sort((a, b) => (b.energy - a.energy) || (a.id < b.id ? -1 : 1));
    },
  };
}

/**
 * Arm 3 (ID + vector rerank): REORDER pure ID's lit set by a dev-tuned blend of
 *   blend * normalizedActivation + (1 - blend) * cosine(question, turn).
 * `blend = 0` is pure cosine rerank; `blend = 1` is the original activation order. The
 * lit SET (hence the recall ceiling) is unchanged — only the ranking discriminator is
 * added. Activation is min-max normalized within the lit set so the two signals compose.
 */
export function rerankLit(
  lit: readonly LitEnergy[],
  graph: SharedGraph,
  cueVec: Float32Array,
  blend: number,
): string[] {
  if (lit.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of lit) {
    if (l.energy < lo) lo = l.energy;
    if (l.energy > hi) hi = l.energy;
  }
  const span = hi - lo;
  const scored = lit.map((l) => {
    const normE = span > 0 ? (l.energy - lo) / span : 0;
    const cos = cosine(cueVec, graph.vectorOf(l.id));
    return { id: l.id, score: blend * normE + (1 - blend) * cos };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  return scored.map((x) => x.id);
}

/** Candidate blend weights for the ID+rerank arm (tuned on the LoCoMo dev split). */
export const RERANK_BLEND_GRID: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1];

// ===========================================================================
// CYCLE E — MultiSeedID (vector-kNN seeded activation walk)
// ===========================================================================
//
// Diagnosis under test (cycles C+D): PureID's coverage cap is the SEED + walk REACH, not
// the halt and not the graph (oracle ceiling ≈ the full-lit recall). The hybrid wins
// coverage because its vector channel retrieves evidence DIRECTLY. MultiSeedID seeds the
// SAME engine's activation walk at the top-k VECTOR-NEAREST turns to the cue — the SAME
// vector-kNN entry the RRF hybrid consumes — so the walk STARTS near the evidence and
// activation+provenance then expands (multi-hop) and the cosine rerank ranks/filters from
// a good entry. This isolates ID's value-add: given the SAME vector seeds, the ONLY
// difference vs the hybrid is activation-walk+provenance expansion vs k-hop graph+RRF.

/** The vector-kNN seed sweep for MultiSeedID (tuned on the LoCoMo dev split). */
export const MULTISEED_K_GRID: readonly number[] = [1, 3, 5, 10, 20];

/**
 * MultiSeedID retrieve over ONE LoCoMo conversation's ID substrate: seed the activation
 * walk at the top-`k` cosine-nearest turns to the cue (vector-kNN), run the engine's walk
 * (auto-halt; optional adapter-level `config`), then output-rerank the lit set by the
 * cycle-B cosine blend. Returns BOTH the raw lit set (for reachability / cost diagnostics)
 * and the reranked ranking. The engine substrate is UNTOUCHED — only the seed differs from
 * the cycle-B single-seed arm and from the hybrid's graph root.
 */
export function multiSeedRetrieve(
  id: LocomoIdRetriever,
  graph: SharedGraph,
  cueVec: Float32Array,
  k: number,
  blend: number,
  config?: WalkConfig,
): { readonly seed: string[]; readonly lit: LitEnergy[]; readonly ranked: string[] } {
  const seed = vectorTopK(graph, cueVec, k);
  const lit = config === undefined ? id.retrieveLit(seed) : id.retrieveLit(seed, config);
  const ranked = rerankLit(lit, graph, cueVec, blend);
  return { seed, lit, ranked };
}
