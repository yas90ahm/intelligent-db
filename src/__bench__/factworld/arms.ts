/**
 * factworld/arms.ts — the memory arms for the entity-attribute QA benchmark.
 *
 * Each arm answers: given a question (entity, attribute), what MEMORY context should the
 * reader LLM see? The arms differ only in how they retrieve/adjudicate the ingested facts.
 *
 *   - bare      : no memory (the model must guess a fictional token → chance floor).
 *   - rag       : vector top-K over ALL assertion statements (no defense → Sybil density wins).
 *   - substrate : the REAL Intelligent DB engine — ingest each value as a provenance-rooted
 *                 strand (true value = 2 disjoint anchor classes; Sybil cluster = 1 shared
 *                 class), run contradiction-adjudication, and return only the LIVE value.
 *   - mem0      : external memory framework (added in arms.mem0.ts).
 */

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  asStrandId,
  asEpochMs,
  FactState,
  FactOrigin,
  Tier,
  AnchorClass,
} from "../../index.js";
import type {
  Strand,
  StrandStore,
  SourceId,
  Unit,
  EpochMs,
  EntityId,
  AttributeKey,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  ContentHash,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedger,
  ReputationLedgerPort,
  StakeLedgerPort,
  RatificationDeps,
  AnchorBinding,
} from "../../index.js";

import { cosine } from "../retrieval/embed.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";
import type { Assertion, FWQuestion } from "./generate.js";

export type FwArmId = "bare" | "rag" | "substrate" | "mem0";

export interface FwArm {
  readonly id: FwArmId;
  /** The memory context (statements) the reader sees for this question. */
  contextFor(q: FWQuestion, qVec: Float32Array): Promise<string[]>;
  close?(): Promise<void>;
}

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const attrKeyOf = (entity: string, attribute: string): string => `${entity}::${attribute}`;

// ---------------------------------------------------------------------------
// bare
// ---------------------------------------------------------------------------

export function bareArm(): FwArm {
  return { id: "bare", contextFor: async () => [] };
}

// ---------------------------------------------------------------------------
// rag — flat vector top-K over every assertion statement (incl. the Sybil cluster)
// ---------------------------------------------------------------------------

export function ragArm(assertions: readonly Assertion[], stmtVecs: readonly Float32Array[], k: number): FwArm {
  return {
    id: "rag",
    async contextFor(_q, qVec) {
      const scored = assertions.map((a, i) => ({ i, s: cosine(qVec, stmtVecs[i]!) }));
      scored.sort((a, b) => b.s - a.s || a.i - b.i);
      return scored.slice(0, k).map((x) => assertions[x.i]!.statement);
    },
  };
}

// ---------------------------------------------------------------------------
// substrate — the real engine: provenance-rooted strands + contradiction adjudication
// ---------------------------------------------------------------------------

function makeRoot(sourceId: string, cls: string, idRaw: string): ProvenanceRoot {
  return {
    rootId: `root:${idRaw}` as ProvenanceRootId,
    independenceClass: cls as IndependenceClassId,
    sourceId: sourceId as SourceId,
    establishedAt: NOW,
  };
}

/**
 * One LIVE OBSERVED strand = one source's assertion of a value. Same-value strands SHARE a
 * content_hash (the engine's value-agreement test is content_hash equality), so two sources
 * asserting the true value become co-asserters whose roots union to R=2.
 */
function makeValueStrand(idRaw: string, entity: string, attrKey: string, value: string, contentHash: string, roots: ProvenanceRoot[]): Strand {
  return {
    id: asStrandId(idRaw),
    entity: entity as EntityId,
    attribute: attrKey as AttributeKey,
    payload: { value },
    content_hash: contentHash as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: roots,
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

function makeSourceRegistry(known: Set<string>): SourceRegistryPort {
  return {
    register: (p) => void known.add(String(p.sourceId)),
    sourceIdOf: (s) => (known.has(String(s)) ? s : null),
    has: (s) => known.has(String(s)),
  };
}

const binding = (cls: AnchorClass): AnchorBinding => ({ anchorClass: cls, realizedCost: 0.5 as Unit, independenceWeight: 0.5 as Unit });

/**
 * Anchor registry over a sourceId→bindings map. `independenceBetween` returns a positive
 * weight iff the two sources' anchor CLASSES are disjoint — so the current value's two
 * sources (DOMAIN + ORGANIZATION) are independent (R=2) while the Sybil cluster (all one
 * class) collapses to a single witness (R=1).
 */
function makeAnchorRegistry(bindings: Map<string, AnchorBinding[]>): AnchorRegistryPort {
  return {
    bind: () => {},
    anchorsOf: (s): readonly AnchorBinding[] => bindings.get(String(s)) ?? [],
    aggregateCost: (anchors): Unit => {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween: (a, b): Unit => {
      const ca = new Set(a.map((x) => x.anchorClass));
      const cb = new Set(b.map((x) => x.anchorClass));
      if (ca.size === 0 || cb.size === 0) return 0 as Unit;
      for (const c of ca) if (cb.has(c)) return 0 as Unit; // share a class ⇒ not independent
      return 0.5 as Unit;
    },
  };
}

/** Map an assertion's role to a concrete anchor class (disjoint classes for the two true sources). */
function anchorClassFor(kind: Assertion["kind"], witnessIndex: number): AnchorClass {
  if (kind === "current") return witnessIndex === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;
  if (kind === "old") return AnchorClass.EMAIL_OAUTH;
  return AnchorClass.EMAIL_OAUTH; // Sybil cluster — all share one class
}

/**
 * Ingest the world into the real engine: one strand per DISTINCT value of each
 * (entity, attribute), carrying every root that asserts it — so the CURRENT true value
 * holds 2 disjoint anchor classes (≥2 independent roots) and the Sybil cluster collapses to
 * ONE class (1 independent root). Trusted (current) sources are pre-earned; old/Sybil
 * sources stay at reputation 0. Then adjudicate every (entity, attribute) so the Sybil
 * cluster + the superseded old value are DEMOTED and only the true value stays LIVE.
 */
export function substrateArm(assertions: readonly Assertion[]): FwArm {
  const store: StrandStore = createMemoryStore();

  // One strand PER ASSERTION (per source); same-value strands share a content_hash so the
  // engine sees them as co-asserters. The two true sources (DOMAIN + ORGANIZATION) thus
  // back the true value with R=2 independent roots; the Sybil cluster (one class) is R=1.
  const trustedSources = new Set<string>(); // high rep_cap (both current sources are legit)
  const earnSources = new Set<string>(); // PRE-EARNED only (the primary; the 2nd is an unearned corroborator)
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const known = new Set<string>();
  const distinctValues = new Map<string, Set<string>>(); // attrKey → set of values
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i]!;
    const attrKey = attrKeyOf(a.entity, a.attribute);
    const contentHash = `chash:${attrKey}:${a.value}`;
    store.putStrand(makeValueStrand(`s:${i}`, a.entity, attrKey, a.value, contentHash, [makeRoot(a.sourceId, a.anchorClass, `${i}`)]));
    const witnessIndex = a.sourceId.includes("true2") ? 1 : 0;
    anchorBindings.set(a.sourceId, [binding(anchorClassFor(a.kind, witnessIndex))]);
    known.add(a.sourceId);
    if (a.kind === "current") {
      trustedSources.add(a.sourceId);
      if (witnessIndex === 0) earnSources.add(a.sourceId); // earn only the primary (true1)
    }
    const vs = distinctValues.get(attrKey) ?? new Set<string>();
    vs.add(a.value);
    distinctValues.set(attrKey, vs);
  }

  // Reputation: current-value sources are credible; old/Sybil sources are not.
  const repCapOf = (s: SourceId): Unit => (trustedSources.has(String(s)) ? 0.95 : 0.05) as Unit;
  const clock = (): EpochMs => NOW;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, clock);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(known),
    anchors: makeAnchorRegistry(anchorBindings),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSource: freshSource().sourceId };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  for (const s of earnSources) for (let r = 0; r < PRIMARY_WARMUP_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);

  // Adjudicate every (entity, attribute) with ≥2 distinct values → demote the losers.
  for (const [attrKey, vals] of distinctValues) if (vals.size >= 2) engine.adjudicate(attrKey as AttributeKey);

  return {
    id: "substrate",
    async contextFor(q) {
      const attrKey = attrKeyOf(q.entity, q.attribute);
      const live = store
        .strandsByAttribute(attrKey as AttributeKey)
        .filter((s) => s.fact_state === FactState.LIVE);
      // The believed current value(s), de-duplicated by value, rendered back as statements.
      const values = [...new Set(live.map((s) => (s.payload as { value: string }).value))];
      return values.map((v) => `${q.entity}'s ${q.attribute} is ${v}.`);
    },
  };
}
