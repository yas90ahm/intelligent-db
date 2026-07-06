/**
 * longmemeval/arms.ts — the memory arms compared per LongMemEval question.
 *
 *   - idb : the REAL Intelligent DB engine. Every turn of the question's haystack is
 *     mirrored as a strand (entity = role, so the engine's same-speaker sibling fan
 *     applies exactly as `writeFact` would produce it); CONFIRMED_LINK (session
 *     adjacency) + SHARED_ENTITY (mention overlap) edges are materialized. Retrieval is
 *     `retrieval/retrievers.ts`'s MultiSeedID: seed the activation walk at the top-K
 *     vector-nearest turns to the question, let the engine's activation walk expand
 *     multi-hop, then cosine-rerank the lit set (frozen config, same numbers the LoCoMo
 *     QA cycle uses — not re-tuned here). Reused verbatim via structural typing: this
 *     module's retriever object satisfies `retrievers.ts`'s `LocomoIdRetriever`
 *     interface, so `multiSeedRetrieve`/`rerankLit` need no changes.
 *   - rag : flat vector top-K over every turn (no walk, no provenance) — the same-shape
 *     control every other bench in this repo uses.
 *
 * No contradiction/adjudication machinery is wired (LongMemEval plants none — this is a
 * clean-bank recall+use test, not an adversarial one), mirroring `createLocomoIdRetriever`.
 */

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  asStrandId,
  EdgeType,
} from "../../index.js";
import type {
  IntelligentDb,
  StrandStore,
  SourceId,
  Unit,
  EpochMs,
  EntityId,
  AttributeKey,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  ReputationLedger,
  RatificationDeps,
  AnchorBinding,
  WalkConfig,
} from "../../index.js";

import { makeStrand, makeEdge, NOW } from "../fixtures.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { cosine } from "../retrieval/embed.js";
import type { SharedGraph } from "../retrieval/graph.js";
import { vectorTop1 } from "../retrieval/graph.js";
import { multiSeedRetrieve, rerankLit, type LitEnergy } from "../retrieval/retrievers.js";
import type { LmeConversation, LmeItem } from "./dataset.js";

// ---------------------------------------------------------------------------
// shared per-question seed (entity-match cue entities ∪ vector top-1)
// ---------------------------------------------------------------------------

export function lmeSeed(graph: SharedGraph, item: LmeItem, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of item.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

// ---------------------------------------------------------------------------
// idb — real engine substrate (mirrors retrieval/retrievers.ts's createLocomoIdRetriever)
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

export interface LmeIdRetriever {
  retrieveLit(seedIds: readonly string[], config?: WalkConfig): LitEnergy[];
  readonly engine: IntelligentDb;
  readonly store: StrandStore;
}

export function createLmeIdRetriever(conv: LmeConversation): LmeIdRetriever {
  const store: StrandStore = createMemoryStore();

  for (const t of conv.turns) {
    store.putStrand(
      makeStrand(t.id, t.role as unknown as EntityId, `src:${t.role}` as SourceId, `spk:${t.role}`, { text: t.text }, `${t.id}#text` as AttributeKey),
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
      const res = config === undefined ? engine.recall({ seeds }) : engine.recall({ seeds, config });
      return [...res.lit]
        .map((l) => ({ id: String(l.strandId), energy: l.activation }))
        .sort((a, b) => (b.energy - a.energy) || (a.id < b.id ? -1 : 1));
    },
  };
}

/** Frozen configs (reused from the LoCoMo QA cycle — NOT re-tuned on this benchmark). */
export const FROZEN_MULTISEED_K = 20;
export const FROZEN_RERANK_BLEND = 0.2;

/** IDB arm's top-K memory texts for one question. */
export function idbMemories(
  idr: LmeIdRetriever,
  graph: SharedGraph,
  cueVec: Float32Array,
  turnText: ReadonlyMap<string, string>,
  k: number,
): string[] {
  const ranked = multiSeedRetrieve(idr, graph, cueVec, FROZEN_MULTISEED_K, FROZEN_RERANK_BLEND).ranked;
  return ranked.slice(0, k).map((id) => turnText.get(id) ?? "").filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// rag — flat vector top-K over every turn
// ---------------------------------------------------------------------------

export function ragMemories(
  conv: LmeConversation,
  turnVec: ReadonlyMap<string, Float32Array>,
  cueVec: Float32Array,
  turnText: ReadonlyMap<string, string>,
  k: number,
): string[] {
  const scored = conv.turns.map((t) => ({ id: t.id, s: cosine(cueVec, turnVec.get(t.id)!) }));
  scored.sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
  return scored.slice(0, k).map((x) => turnText.get(x.id) ?? "").filter((t) => t.length > 0);
}

export { rerankLit };
