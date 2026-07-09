/**
 * multihoprag/arms.ts — idb (activation-walk over kNN chunk graph) vs rag (flat vector top-K).
 *
 * Corpus chunks become strands; CONFIRMED_LINK edges connect each chunk to its cosine-kNN
 * neighbors (same pattern as reasoning/arms.ts substrateArm). Retrieval seeds at the
 * top-S vector-nearest chunks to the query, walks, then cosine-reranks the lit set.
 * No contradiction machinery — MultiHop-RAG is a clean multi-hop retrieval+QA test.
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
} from "../../index.js";

import { makeStrand, makeEdge, NOW } from "../fixtures.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { cosine } from "../retrieval/embed.js";
import type { MhrChunk } from "./dataset.js";

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

export const FROZEN_KNN = 8;
export const FROZEN_SEEDS = 8;
export const FROZEN_BLEND = 0.2;

function cosineTopK(vecs: readonly Float32Array[], q: Float32Array, k: number): number[] {
  const scored = vecs.map((v, i) => ({ i, s: cosine(q, v) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

function cosineTopKExclSelf(vecs: readonly Float32Array[], i: number, k: number): number[] {
  const scored: Array<{ j: number; s: number }> = [];
  for (let j = 0; j < vecs.length; j++) {
    if (j === i) continue;
    scored.push({ j, s: cosine(vecs[i]!, vecs[j]!) });
  }
  scored.sort((a, b) => b.s - a.s || a.j - b.j);
  return scored.slice(0, k).map((x) => x.j);
}

export interface MhrIdbIndex {
  readonly engine: IntelligentDb;
  readonly store: StrandStore;
  readonly chunks: readonly MhrChunk[];
  readonly vecs: readonly Float32Array[];
  retrieve(queryVec: Float32Array, k: number): string[];
}

/** Build one shared IDB index over all corpus chunks (call once per run). */
export function buildIdbIndex(chunks: readonly MhrChunk[], vecs: readonly Float32Array[]): MhrIdbIndex {
  if (chunks.length !== vecs.length) throw new Error("chunks/vecs length mismatch");
  const store: StrandStore = createMemoryStore();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    store.putStrand(
      makeStrand(
        c.id,
        c.docId as unknown as EntityId,
        `src:${c.source}` as SourceId,
        `doc:${c.docId}`,
        { text: c.text },
        `${c.id}#text` as AttributeKey,
      ),
    );
  }

  const touched = new Set<string>();
  let edgeSeq = 0;
  for (let i = 0; i < chunks.length; i++) {
    for (const j of cosineTopKExclSelf(vecs, i, FROZEN_KNN)) {
      const from = chunks[i]!.id;
      const to = chunks[j]!.id;
      store.putEdge(makeEdge(`e:${edgeSeq++}:${from}->${to}`, asStrandId(from), asStrandId(to), EdgeType.CONFIRMED_LINK));
      touched.add(from);
    }
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
  const idIndex = new Map<string, number>();
  chunks.forEach((c, i) => idIndex.set(c.id, i));

  return {
    engine,
    store,
    chunks,
    vecs,
    retrieve(queryVec, k) {
      const seedIdx = cosineTopK(vecs, queryVec, FROZEN_SEEDS);
      if (seedIdx.length === 0) return [];
      const seeds = seedIdx.map((i) => ({ strandId: asStrandId(chunks[i]!.id), energy: 1 as Unit }));
      const res = engine.recall({ seeds });
      const lit = [...res.lit].map((l) => {
        const id = String(l.strandId);
        const idx = idIndex.get(id) ?? -1;
        return { id, idx, energy: l.activation as number, cos: idx >= 0 ? cosine(queryVec, vecs[idx]!) : 0 };
      });
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of lit) {
        if (l.energy < lo) lo = l.energy;
        if (l.energy > hi) hi = l.energy;
      }
      const span = hi - lo;
      const scored = lit.map((l) => {
        const normE = span > 0 ? (l.energy - lo) / span : 0;
        return { id: l.id, idx: l.idx, score: (1 - FROZEN_BLEND) * normE + FROZEN_BLEND * l.cos };
      });
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      return scored
        .slice(0, k)
        .map((s) => (s.idx >= 0 ? chunks[s.idx]!.text : ""))
        .filter((t) => t.length > 0);
    },
  };
}

export function ragRetrieve(
  chunks: readonly MhrChunk[],
  vecs: readonly Float32Array[],
  queryVec: Float32Array,
  k: number,
): string[] {
  const idxs = cosineTopK(vecs, queryVec, k);
  return idxs.map((i) => chunks[i]!.text);
}
