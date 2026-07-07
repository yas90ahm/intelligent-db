/**
 * poisonedrag/noTrustArm.ts — the ABLATION control arm: the substrate's IDENTICAL retrieval
 * pipeline with the TRUST/PROVENANCE LAYER DISABLED.
 *
 * This is the scientific control for "is the defense actually the trust layer, or is it
 * retrieval (or anything else)?". It builds the SAME store, the SAME provenance-rooted
 * strands (gold = independent co-asserters, poison = a one-class Sybil cluster), the SAME
 * identity/reputation/ratification wiring, and the SAME cosine candidate-pool → take-K
 * retrieval as `substrateArm`. The ONLY thing removed is the trust decision:
 *
 *   1. NO pre-earned reputation (no `reputation.ratify` warm-up) — every source reads ~0.
 *   2. NO `engine.adjudicate(...)` — the contradiction is never resolved, so the Sybil
 *      cluster is NEVER demoted. `demotedPoison` therefore stays EMPTY.
 *
 * With nothing demoted, the (byte-identical) `contextFor` filter removes nothing, so the
 * poison passages crowd into the top-K exactly as in the plain `rag` arm. Expectation:
 * substrate-NOTRUST ASR ≈ rag ASR (~90%+), while full `substrate` stays low — isolating the
 * trust/provenance layer as the sole cause of the defense.
 *
 * Own file, no edits to arms.ts — exports `substrateNoTrustArm` with the same PrArm shape.
 */

import {
  createIntelligentDb, createMemoryStore, createSourceIdentityLayer, createReputationLedger,
  createPendingLedger, asStrandId, asEpochMs, FactState, FactOrigin, Tier, AnchorClass,
} from "../../index.js";
import type {
  Strand, StrandStore, SourceId, Unit, EpochMs, EntityId, AttributeKey, ProvenanceRoot,
  ProvenanceRootId, IndependenceClassId, ContentHash, AnchorBinding, SourceRegistryPort,
  AnchorRegistryPort, ReputationLedger, ReputationLedgerPort, StakeLedgerPort, RatificationDeps,
} from "../../index.js";

import { cosine } from "../retrieval/embed.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import type { KBPassage, PRQuestion } from "./data.js";
import type { PrArm } from "./arms.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);

function cosTopK(vecs: readonly Float32Array[], qVec: Float32Array, k: number): number[] {
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < vecs.length; i++) scored.push({ i, s: cosine(qVec, vecs[i]!) });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

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
    co_equal_claim_cardinality: 0, last_tier_reason: null,
  };
}
const bind = (c: AnchorClass): AnchorBinding => ({ anchorClass: c, realizedCost: 0.5 as Unit, independenceWeight: 0.5 as Unit });

/**
 * The ablation arm. Mirrors `substrateArm` EXACTLY except for the two trust-disabling
 * omissions documented in the file header. The retrieval body is identical: a cosine
 * candidate pool of size `topN`, drop the demoted poison (which is empty here), take K.
 */
export function substrateNoTrustArm(passages: readonly KBPassage[], vecs: readonly Float32Array[], topN: number, k: number): PrArm {
  const store: StrandStore = createMemoryStore();
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const known = new Set<string>();
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
    let goldCount = 0;
    for (let i = 0; i < g.gold.length; i++) {
      const gp = g.gold[i]!;
      const cls = i === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;
      store.putStrand(makeStrand(`s:${si++}`, qid, "correct", correctCH, [makeRoot(gp.source, `cls:gold:${qid}:${i}`, `${si}`)]));
      anchorBindings.set(gp.source, [bind(cls)]);
      known.add(gp.source);
      goldCount++;
    }
    if (goldCount === 1) {
      const cs = `src:corrob:${qid}`;
      store.putStrand(makeStrand(`s:${si++}`, qid, "correct", correctCH, [makeRoot(cs, `cls:corrob:${qid}`, `${si}`)]));
      anchorBindings.set(cs, [bind(AnchorClass.ORGANIZATION)]);
      known.add(cs);
    }
    const poisonCH = `ch:${qid}:incorrect`;
    for (const pp of g.poison) {
      const id = `s:${si++}`;
      store.putStrand(makeStrand(id, qid, "incorrect", poisonCH, [makeRoot(pp.source, `cls:sybil:${qid}`, `${si}`)]));
      anchorBindings.set(pp.source, [bind(AnchorClass.EMAIL_OAUTH)]);
      known.add(pp.source);
      poisonStrandToPassage.set(id, pp.id);
    }
  }

  // Identity + reputation wiring is built IDENTICALLY to substrateArm so the only difference
  // is behavioral (no pre-earn, no adjudicate), never structural.
  const sources: SourceRegistryPort = { register: () => {}, sourceIdOf: (s) => (known.has(String(s)) ? s : null), has: (s) => known.has(String(s)) };
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
  // TRUST DISABLED #1: every source flattened to the bare-key ceiling — nobody is credible.
  const repCapOf = (_s: SourceId): Unit => 0.05 as Unit;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, () => NOW);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stake: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({ sources, anchors, reputation: reputationPort, stake });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSource: freshSource().sourceId };
  // The engine IS wired (same machinery) — we simply never drive the trust verbs.
  createIntelligentDb(store, identity, null, reputation, ratification);

  // TRUST DISABLED #2: NO pre-earn warm-up and NO engine.adjudicate(...) calls. With the
  // contradiction never adjudicated, no Sybil strand is ever demoted.
  const demotedPoison = new Set<string>();
  for (const [strandId, passageId] of poisonStrandToPassage) {
    if (store.getStrand(asStrandId(strandId))?.fact_state === FactState.DEMOTED) demotedPoison.add(passageId);
  }

  return {
    id: "substrate", // same PrArmId surface; the runner labels the row "substrate-notrust"
    async contextFor(_q: PRQuestion, qVec: Float32Array) {
      // IDENTICAL retrieval body to substrateArm: candidate pool, drop demoted (empty), take K.
      const cand = cosTopK(vecs, qVec, topN);
      const kept: string[] = [];
      for (const i of cand) {
        if (demotedPoison.has(passages[i]!.id)) continue;
        kept.push(passages[i]!.text);
        if (kept.length >= k) break;
      }
      return kept;
    },
  };
}
