/**
 * reasoning/arms.ts — the memory/retrieval ARMS under comparison.
 *
 * THE THESIS: does giving a capable model a good MEMORY make it more accurate than the same
 * model with NO memory? Headline contrast = `bare` (no memory) vs `substrate` (Intelligent
 * DB). `rag`/`hybrid` are controls ("is it ID specifically, or would any retrieval do?").
 *
 * Clean, leakage-free setup: the model's memory is a STUDY BANK of already-solved problems;
 * we evaluate on HELD-OUT problems not in the bank. Each arm answers the same question —
 * "given this unseen problem, which K studied problems should be recalled as exemplars?" —
 * over the SAME query embedding and SAME bank, so the only variable is HOW it recalls.
 *
 * POISONED-BANK variant: when the bank contains adversarial wrong-answer twins (see
 * poison.ts), only `substrate` can defend — it wires reputation + runs the engine's
 * contradiction adjudication so poison is DEMOTED and never recalled; rag/hybrid recall by
 * cosine and have no such defense.
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
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedger,
  ReputationLedgerPort,
  StakeLedgerPort,
  RatificationDeps,
  AnchorBinding,
} from "../../index.js";

import { makeStrand, makeEdge, NOW } from "../fixtures.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";
import { cosine } from "../retrieval/embed.js";
import type { BenchItem } from "./datasets.js";
import { hash32, type BankEntry } from "./poison.js";

export type ArmId = "bare" | "rag" | "substrate" | "hybrid" | "mem0";

/** The unseen test problem, in both forms arms may need (vector for ours, text for mem0). */
export interface QueryCtx {
  readonly item: BenchItem;
  readonly vec: Float32Array;
}

/** An arm: given the UNSEEN problem, return ranked study-bank indices to recall. */
export interface Arm {
  readonly id: ArmId;
  /** Ranked study-bank indices to use as exemplars, best first, ≤ k. Async (mem0 is a subprocess). */
  exemplars(query: QueryCtx, k: number): Promise<number[]>;
  /** Optional resource release (mem0 sidecar process). */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// shared cosine helpers (ties broken by id-hash, so legit/poison twins — which can share a
// vector — are not systematically favored either way)
// ---------------------------------------------------------------------------

function tieKeysOf(ids: readonly string[]): number[] {
  return ids.map((id) => hash32(id));
}

function cosineTopKQuery(vecs: readonly Float32Array[], q: Float32Array, k: number, tie: readonly number[]): number[] {
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < vecs.length; i++) scored.push({ i, s: cosine(q, vecs[i]!) });
  scored.sort((a, b) => b.s - a.s || tie[a.i]! - tie[b.i]! || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

function cosineTopKExclSelf(vecs: readonly Float32Array[], idx: number, k: number, tie: readonly number[]): number[] {
  const q = vecs[idx]!;
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < vecs.length; i++) {
    if (i === idx) continue;
    scored.push({ i, s: cosine(q, vecs[i]!) });
  }
  scored.sort((a, b) => b.s - a.s || tie[a.i]! - tie[b.i]! || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

// ---------------------------------------------------------------------------
// bare + rag
// ---------------------------------------------------------------------------

export function bareArm(): Arm {
  return { id: "bare", exemplars: async () => [] };
}

export function ragArm(pool: readonly BenchItem[], poolVecs: readonly Float32Array[]): Arm {
  const tie = tieKeysOf(pool.map((p) => p.id));
  return { id: "rag", exemplars: async (query, k) => cosineTopKQuery(poolVecs, query.vec, k, tie) };
}

// ---------------------------------------------------------------------------
// hybrid (in-repo TunedHybrid: RRF of vector-kNN + multi-hop graph proximity)
// ---------------------------------------------------------------------------

export interface HybridConfig {
  readonly s: number;
  readonly h: number;
  readonly k: number;
  readonly alpha: number;
  readonly knn: number;
}

export const DEFAULT_HYBRID: HybridConfig = { s: 20, h: 2, k: 10, alpha: 0.5, knn: 8 };

export function hybridArm(
  pool: readonly BenchItem[],
  poolVecs: readonly Float32Array[],
  cfg: HybridConfig = DEFAULT_HYBRID,
): Arm {
  const tie = tieKeysOf(pool.map((p) => p.id));
  const adj: number[][] = [];
  for (let i = 0; i < pool.length; i++) adj.push(cosineTopKExclSelf(poolVecs, i, cfg.knn, tie));

  return {
    id: "hybrid",
    async exemplars(query, k) {
      const q = query.vec;
      const vec = cosineTopKQuery(poolVecs, q, cfg.s, tie);
      const rankVec = new Map<number, number>();
      vec.forEach((i, idx) => rankVec.set(i, idx + 1));

      const dist = new Map<number, number>();
      let frontier = cosineTopKQuery(poolVecs, q, 3, tie);
      for (const i of frontier) dist.set(i, 0);
      for (let hop = 0; hop < cfg.h && frontier.length > 0; hop++) {
        const next: number[] = [];
        for (const u of frontier) {
          for (const v of adj[u]!) {
            if (!dist.has(v)) {
              dist.set(v, hop + 1);
              next.push(v);
            }
          }
        }
        frontier = next;
      }
      const graphIds = [...dist.keys()].sort(
        (a, b) => (dist.get(a)! - dist.get(b)!) || (cosine(q, poolVecs[b]!) - cosine(q, poolVecs[a]!)) || tie[a]! - tie[b]!,
      );
      const rankGraph = new Map<number, number>();
      graphIds.forEach((i, idx) => rankGraph.set(i, idx + 1));

      const cand = new Set<number>([...rankVec.keys(), ...rankGraph.keys()]);
      const scored = [...cand].map((i) => {
        const gv = rankGraph.has(i) ? cfg.alpha / (cfg.k + rankGraph.get(i)!) : 0;
        const vv = rankVec.has(i) ? (1 - cfg.alpha) / (cfg.k + rankVec.get(i)!) : 0;
        return { i, score: gv + vv };
      });
      scored.sort((a, b) => b.score - a.score || (cosine(q, poolVecs[b.i]!) - cosine(q, poolVecs[a.i]!)) || tie[a.i]! - tie[b.i]!);
      return scored.slice(0, k).map((x) => x.i);
    },
  };
}

// ---------------------------------------------------------------------------
// substrate (Intelligent DB: activation walk + reputation + contradiction adjudication)
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

export interface SubstrateConfig {
  readonly knn: number;
  readonly seeds: number;
  readonly blend: number;
}

export const DEFAULT_SUBSTRATE: SubstrateConfig = { knn: 8, seeds: 5, blend: 0.2 };

/**
 * Build the Intelligent DB memory over the study BANK. One strand per entry, with the
 * entry's trusted/adversarial source, its per-problem entity, and the contradiction
 * attribute. kNN CONFIRMED_LINK threads carry recall. Trusted sources are pre-earned to a
 * decisive reputation; then every attribute shared by ≥2 entries (a legit/poison twin pair)
 * is adjudicated — trusted wins, poison is DEMOTED. Recall seeds at the cosine-nearest
 * studied problems and returns the lit set FILTERED to LIVE strands, cosine-reranked, so
 * demoted poison is never recalled.
 */
export function substrateArm(
  bank: readonly BankEntry[],
  bankVecs: readonly Float32Array[],
  cfg: SubstrateConfig = DEFAULT_SUBSTRATE,
): Arm {
  const store: StrandStore = createMemoryStore();
  const tie = tieKeysOf(bank.map((e) => e.item.id));

  for (let i = 0; i < bank.length; i++) {
    const e = bank[i]!;
    // SAME independence class for every entry, so a legit/poison twin pair is an ECHO
    // dispute (resolved purely by the external reputation signal: trusted ≫ adversary) —
    // not a genuinely-independent dispute, which would hit the ≥2-independent-root
    // structural lock and DEFER. A poison source is not an independent witness.
    store.putStrand(
      makeStrand(
        `it:${i}`,
        e.entity as EntityId,
        e.sourceId as SourceId,
        "study",
        { i },
        e.attribute as AttributeKey,
      ),
    );
  }

  // kNN memory threads (both directions), CONFIRMED_LINK so the walk traverses them.
  const touched = new Set<number>();
  let edgeSeq = 0;
  for (let i = 0; i < bank.length; i++) {
    for (const j of cosineTopKExclSelf(bankVecs, i, cfg.knn, tie)) {
      store.putEdge(makeEdge(`e:${edgeSeq++}:${i}->${j}`, asStrandId(`it:${i}`), asStrandId(`it:${j}`), EdgeType.CONFIRMED_LINK));
      touched.add(i);
    }
  }
  for (const i of touched) store.recomputeOutWeightSum(asStrandId(`it:${i}`));

  // Reputation + identity + ratification: trusted sources are credible, adversary is not.
  const trustedIds = new Set<string>(bank.filter((e) => e.trusted).map((e) => e.sourceId));
  const repCapOf = (s: SourceId): Unit => (trustedIds.has(s) ? 0.95 : 0.05) as Unit;
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
  const engine: IntelligentDb = createIntelligentDb(store, identity, null, reputation, ratification);

  // Pre-earn the trusted source(s) to a decisive LCB so adjudication resolves in their favor.
  for (const s of trustedIds) for (let r = 0; r < PRIMARY_WARMUP_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);

  // Adjudicate every contradiction (attribute shared by ≥2 entries) → poison DEMOTED.
  const attrCount = new Map<string, number>();
  for (const e of bank) attrCount.set(e.attribute, (attrCount.get(e.attribute) ?? 0) + 1);
  for (const [attr, c] of attrCount) if (c >= 2) engine.adjudicate(attr as AttributeKey);

  const idxOf = (strandId: string): number => Number(strandId.slice("it:".length));
  const isLive = (i: number): boolean => store.getStrand(asStrandId(`it:${i}`))?.fact_state === FactState.LIVE;

  return {
    id: "substrate",
    async exemplars(query, k) {
      const q = query.vec;
      const seedIdx = cosineTopKQuery(bankVecs, q, cfg.seeds, tie);
      if (seedIdx.length === 0) return [];
      const seeds = seedIdx.map((i) => ({ strandId: asStrandId(`it:${i}`), energy: 1 as Unit }));
      const res = engine.recall({ seeds });

      // Filter to LIVE (demoted poison removed), then cosine-rerank the lit set.
      const lit = [...res.lit]
        .map((l) => ({ i: idxOf(String(l.strandId)), e: l.activation }))
        .filter((l) => l.i >= 0 && l.i < bank.length && isLive(l.i));
      if (lit.length === 0) return seedIdx.filter((i) => isLive(i)).slice(0, k);
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of lit) {
        if (l.e < lo) lo = l.e;
        if (l.e > hi) hi = l.e;
      }
      const span = hi - lo;
      const scored = lit.map((l) => {
        const normE = span > 0 ? (l.e - lo) / span : 0;
        return { i: l.i, score: cfg.blend * normE + (1 - cfg.blend) * cosine(q, bankVecs[l.i]!) };
      });
      scored.sort((a, b) => b.score - a.score || tie[a.i]! - tie[b.i]!);
      return scored.slice(0, k).map((x) => x.i);
    },
  };
}
