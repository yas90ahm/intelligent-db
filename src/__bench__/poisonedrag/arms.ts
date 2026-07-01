/**
 * poisonedrag/arms.ts — memory arms over the PoisonedRAG knowledge base.
 *
 *   - bare      : no retrieval (model's prior only).
 *   - rag       : cosine top-K over the whole KB (poison crafted to match the query → it
 *                 crowds out the gold → the model emits the attacker's answer).
 *   - substrate : the real Intelligent DB engine. Each query's gold passages back the
 *                 CORRECT value with ≥2 disjoint anchor roots (primary pre-earned); the 5
 *                 poison docs share ONE anchor class (a Sybil cluster). Adjudication demotes
 *                 the poison; retrieval = cosine top-N with the demoted poison filtered out.
 *   - mem0      : external framework (poisonedrag/mem0Arm.ts).
 *
 * Same retrieval embeddings for rag/substrate; substrate only ADDS the provenance defense.
 */

import {
  createIntelligentDb, createMemoryStore, createSourceIdentityLayer, createReputationLedger,
  createPendingLedger, generatePassport, asStrandId, asEpochMs, FactState, FactOrigin, Tier, AnchorClass,
} from "../../index.js";
import type {
  Strand, StrandStore, SourceId, Unit, EpochMs, EntityId, AttributeKey, ProvenanceRoot,
  ProvenanceRootId, IndependenceClassId, ContentHash, AnchorBinding, KeyRegistryPort,
  AnchorRegistryPort, ReputationLedger, ReputationLedgerPort, StakeLedgerPort, RatificationDeps,
} from "../../index.js";

import { cosine } from "../retrieval/embed.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";
import type { KBPassage, PRQuestion } from "./data.js";

export type PrArmId = "bare" | "rag" | "substrate" | "mem0";

export interface PrArm {
  readonly id: PrArmId;
  contextFor(q: PRQuestion, qVec: Float32Array): Promise<string[]>;
  close?(): Promise<void>;
}

const NOW: EpochMs = asEpochMs(1_700_000_000_000);

function cosTopK(vecs: readonly Float32Array[], qVec: Float32Array, k: number, keep?: (i: number) => boolean): number[] {
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < vecs.length; i++) {
    if (keep && !keep(i)) continue;
    scored.push({ i, s: cosine(qVec, vecs[i]!) });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

export function bareArm(): PrArm {
  return { id: "bare", contextFor: async () => [] };
}

export function ragArm(passages: readonly KBPassage[], vecs: readonly Float32Array[], k: number): PrArm {
  return {
    id: "rag",
    async contextFor(_q, qVec) {
      return cosTopK(vecs, qVec, k).map((i) => passages[i]!.text);
    },
  };
}

// ---------------------------------------------------------------------------
// substrate — adjudicate gold (independent) vs poison (Sybil) per query, then filter
// ---------------------------------------------------------------------------

function makeRoot(sourceId: string, cls: string, idRaw: string): ProvenanceRoot {
  return { rootId: `root:${idRaw}` as ProvenanceRootId, independenceClass: cls as IndependenceClassId, sourceId: sourceId as SourceId, establishedAt: NOW };
}
function makeStrand(idRaw: string, attrKey: string, value: string, contentHash: string, roots: ProvenanceRoot[]): Strand {
  return {
    id: asStrandId(idRaw), entity: attrKey as EntityId, attribute: attrKey as AttributeKey, payload: { value },
    content_hash: contentHash as ContentHash, origin: FactOrigin.OBSERVED, fact_state: FactState.LIVE, tier: Tier.WARM,
    provenance: roots, outEdges: [], inEdges: [], outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 }, salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0, observedAt: NOW, external_reobservation_count: 0, contradiction_set: null,
    co_equal_claim_cardinality: 0, last_tier_reason: null, register: null,
  };
}
const bind = (c: AnchorClass): AnchorBinding => ({ anchorClass: c, realizedCost: 0.5 as Unit, independenceWeight: 0.5 as Unit });

/**
 * Build the ID arm. TopN is the candidate pool retrieved by cosine; after dropping the
 * demoted poison, the top-K survivors (gold + negatives) become the context.
 */
export function substrateArm(passages: readonly KBPassage[], vecs: readonly Float32Array[], topN: number, k: number, applyDemotedFilter = true): PrArm {
  const store: StrandStore = createMemoryStore();
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const known = new Set<string>();
  const earn = new Set<string>(); // pre-earned primary gold sources
  const poisonStrandToPassage = new Map<string, string>(); // strandId → poison passage id

  const byQuery = new Map<string, { gold: KBPassage[]; poison: KBPassage[] }>();
  for (const p of passages) {
    if (p.kind !== "gold" && p.kind !== "poison") continue;
    const g = byQuery.get(p.query_id) ?? { gold: [], poison: [] };
    (p.kind === "gold" ? g.gold : g.poison).push(p);
    byQuery.set(p.query_id, g);
  }

  let si = 0;
  for (const [qid, g] of byQuery) {
    const correctCH = `ch:${qid}:correct`;
    // CORRECT value — gold passages as co-asserters with ≥2 disjoint anchor roots.
    let goldCount = 0;
    for (let i = 0; i < g.gold.length; i++) {
      const gp = g.gold[i]!;
      const cls = i === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;
      store.putStrand(makeStrand(`s:${si++}`, qid, "correct", correctCH, [makeRoot(gp.source, `cls:gold:${qid}:${i}`, `${si}`)]));
      anchorBindings.set(gp.source, [bind(cls)]);
      known.add(gp.source);
      if (i === 0) earn.add(gp.source); // primary pre-earned
      goldCount++;
    }
    // If only one gold passage, add an unearned independent corroborator (2nd anchor root).
    if (goldCount === 1) {
      const cs = `src:corrob:${qid}`;
      store.putStrand(makeStrand(`s:${si++}`, qid, "correct", correctCH, [makeRoot(cs, `cls:corrob:${qid}`, `${si}`)]));
      anchorBindings.set(cs, [bind(AnchorClass.ORGANIZATION)]);
      known.add(cs);
    }
    // INCORRECT value — the Sybil cluster, all one class.
    const poisonCH = `ch:${qid}:incorrect`;
    for (const pp of g.poison) {
      const id = `s:${si++}`;
      store.putStrand(makeStrand(id, qid, "incorrect", poisonCH, [makeRoot(pp.source, `cls:sybil:${qid}`, `${si}`)]));
      anchorBindings.set(pp.source, [bind(AnchorClass.EMAIL_OAUTH)]);
      known.add(pp.source);
      poisonStrandToPassage.set(id, pp.id);
    }
  }

  // identity + reputation wiring
  const keys: KeyRegistryPort = { register: () => {}, sourceIdOf: (s) => (known.has(String(s)) ? s : null), has: (s) => known.has(String(s)) };
  const anchors: AnchorRegistryPort = {
    bind: () => {},
    anchorsOf: (s) => anchorBindings.get(String(s)) ?? [],
    aggregateCost: () => 0.5 as Unit,
    independenceBetween: (a, b) => {
      const ca = new Set(a.map((x) => x.anchorClass));
      const cb = new Set(b.map((x) => x.anchorClass));
      if (ca.size === 0 || cb.size === 0) return 0 as Unit;
      for (const c of ca) if (cb.has(c)) return 0 as Unit;
      return 0.5 as Unit;
    },
  };
  const repCapOf = (s: SourceId): Unit => (earn.has(String(s)) ? 0.95 : 0.05) as Unit;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, () => NOW);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stake: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({ keys, anchors, reputation: reputationPort, stake });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSigner: generatePassport() };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  for (const s of earn) for (let r = 0; r < PRIMARY_WARMUP_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);

  // Adjudicate each query (gold vs poison) → demote the Sybil cluster.
  for (const qid of byQuery.keys()) engine.adjudicate(qid as AttributeKey);

  // Collect the poison passage ids whose strand was demoted.
  const demotedPoison = new Set<string>();
  for (const [strandId, passageId] of poisonStrandToPassage) {
    if (store.getStrand(asStrandId(strandId))?.fact_state === FactState.DEMOTED) demotedPoison.add(passageId);
  }

  return {
    id: "substrate",
    async contextFor(_q, qVec) {
      // candidate pool, then (unless ablated) drop demoted poison, then take top-K.
      // applyDemotedFilter=false is the SURGICAL ablation: everything identical — same store,
      // same pre-earned reputation, same adjudication that DEMOTED the poison — only the
      // trust FILTER is off, so the (still-demoted) poison is surfaced anyway. Isolates the
      // filter as the single variable.
      const cand = cosTopK(vecs, qVec, topN);
      const kept: string[] = [];
      for (const i of cand) {
        if (applyDemotedFilter && demotedPoison.has(passages[i]!.id)) continue;
        kept.push(passages[i]!.text);
        if (kept.length >= k) break;
      }
      return kept;
    },
  };
}
