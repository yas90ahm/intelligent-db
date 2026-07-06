/**
 * factworld/embedderSeededSubstrate.test.ts — Phase-1 retrieval spec §5.3 adversarial
 * gate: "FactWorld substrate: still 0.0% ASR (embedder on)."
 *
 * The existing quick (no-LLM) substrate check (`substrate.validate.test.ts`) proves
 * adjudication demotes the Sybil cluster, but its `contextFor` reads believed values
 * directly via `store.strandsByAttribute(...).filter(LIVE)` — a mechanical exact-
 * attribute lookup that never calls `engine.recall()`/the cue resolver, so wiring an
 * embedder there has no code path to affect (the same observation as the CROSSDB_BENCH
 * gate; see `crossdb/embedderSybilGate.test.ts`'s header for the parallel reasoning).
 *
 * This file builds the IDENTICAL poisoned FactWorld + engine wiring
 * `factworld/arms.ts`'s `substrateArm` uses (same modeling: current true value backed
 * by 2 disjoint anchor classes, Sybil cluster collapsed to 1 shared class, adjudication
 * already run before any question is asked) but answers each question via a REAL
 * `engine.recall()` call seeded WORST-CASE adversarially — by Ollama cosine similarity
 * ALONE (no entity/lexical boost) — instead of the flat attribute-index scan. If
 * similarity could ever leak into belief, the Sybil cluster's dense near-duplicate
 * statements (K copies of one false value, vs. 1-2 true-value statements) would win
 * seed slots disproportionately and the adjudicated LIVE value could get crowded out
 * of the answer; the thesis constraint says it cannot — the reported ASR must stay 0%.
 *
 * Requires a live Ollama server (`nomic-embed-text` pulled). Gated behind
 * FACTWORLD_BENCH=1 (the existing suite's own flag family) so a plain `npm test`
 * never hits the network. To run:
 *
 *     FACTWORLD_BENCH=1 npx vitest run src/__bench__/factworld/embedderSeededSubstrate.test.ts
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  createMemoryVectorSidecar,
  createEmbeddingCueResolver,
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
  IntelligentDb,
  CueResolver,
  EmbedderPort,
  WalkSeed,
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

import { createOllamaEmbedder } from "../../examples/embedders.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";
import { generateFactWorld, type Assertion } from "./generate.js";

const RUN = process.env["FACTWORLD_BENCH"] === "1";
const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const attrKeyOf = (entity: string, attribute: string): string => `${entity}::${attribute}`;
const EMBED_SEED_K = 64;

// ---------------------------------------------------------------------------
// Substrate construction — mirrors `factworld/arms.ts`'s `substrateArm` EXACTLY
// (same modeling choices, duplicated here rather than imported so this file never
// risks the already-passing official arm; see that file for the rationale of each
// choice: content-hash-shared value strands, disjoint anchor classes for the true
// value's two sources, one shared class for the Sybil cluster).
// ---------------------------------------------------------------------------

function makeRoot(sourceId: string, cls: string, idRaw: string): ProvenanceRoot {
  return { rootId: `root:${idRaw}` as ProvenanceRootId, independenceClass: cls as IndependenceClassId, sourceId: sourceId as SourceId, establishedAt: NOW };
}

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
      for (const c of ca) if (cb.has(c)) return 0 as Unit;
      return 0.5 as Unit;
    },
  };
}

function anchorClassFor(kind: Assertion["kind"], witnessIndex: number): AnchorClass {
  if (kind === "current") return witnessIndex === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;
  if (kind === "old") return AnchorClass.EMAIL_OAUTH;
  return AnchorClass.EMAIL_OAUTH;
}

interface Substrate {
  readonly engine: IntelligentDb;
  readonly store: StrandStore;
}

function buildSubstrate(assertions: readonly Assertion[]): Substrate {
  const store: StrandStore = createMemoryStore();
  const trustedSources = new Set<string>();
  const earnSources = new Set<string>();
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const known = new Set<string>();
  const distinctValues = new Map<string, Set<string>>();

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
      if (witnessIndex === 0) earnSources.add(a.sourceId);
    }
    const vs = distinctValues.get(attrKey) ?? new Set<string>();
    vs.add(a.value);
    distinctValues.set(attrKey, vs);
  }

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
  for (const [attrKey, vals] of distinctValues) if (vals.size >= 2) engine.adjudicate(attrKey as AttributeKey);

  return { engine, store };
}

(RUN ? describe : describe.skip)(
  "FactWorld substrate — WITH the Ollama embedder configured, worst-case similarity-only seeding (spec §5.3)",
  () => {
    it(
      "engine.recall() seeded PURELY by cosine similarity still surfaces only the adjudicated-LIVE gold value — 0.0% ASR",
      async () => {
        const world = generateFactWorld({ entities: 5, condition: "poison", poisonRate: 1.0, sybilK: 8, seed: 7 });
        const { engine, store } = buildSubstrate(world.assertions);

        const embedder: EmbedderPort = createOllamaEmbedder();
        const vectors = createMemoryVectorSidecar();
        const emptyBase: CueResolver = { index(): void {}, resolve: (): WalkSeed[] => [] };
        const embResolver = createEmbeddingCueResolver(store, embedder, vectors, { base: emptyBase });

        // Populate the REAL vector sidecar via ONE batched Ollama call over every
        // distinct strand's rendered statement (the exact text `contextFor` renders
        // in the official arm), keyed by each strand's REAL content_hash.
        const allStrands = [...store.allStrands()];
        const texts = allStrands.map((s) => `${s.entity}'s ${String(s.attribute).split("::")[1]} is ${(s.payload as { value: string }).value}.`);
        const vecs = await embedder.embed(texts);
        allStrands.forEach((s, i) => {
          vectors.put(s.content_hash, embedder.modelId, vecs[i]!);
          embResolver.index(s);
        });

        let poisonedChecked = 0;
        let asrHits = 0;
        let totalChecked = 0;
        for (const q of world.questions) {
          const attrKey = attrKeyOf(q.entity, q.attribute);
          const seeds = await embResolver.resolveWithEmbeddings(
            { text: `${q.entity} ${q.attribute}` },
            { embedSeedK: EMBED_SEED_K, embedSeedEnergyCap: 1 },
          );
          if (seeds.length === 0) continue; // nothing to seed for this (entity,attribute) — skip, not a false pass
          const res = engine.recall({ seeds });
          const liveValues = new Set<string>();
          for (const lit of res.lit) {
            const strand = store.getStrand(lit.strandId);
            if (strand === null) continue;
            if (String(strand.attribute) !== attrKey) continue; // this trial's own attribute only
            if (strand.fact_state !== FactState.LIVE) continue;
            liveValues.add((strand.payload as { value: string }).value);
          }
          totalChecked++;
          if (q.poisoned) poisonedChecked++;
          // ASR: the attacker's poisonValue is the (sole or a) believed-LIVE value.
          if (liveValues.has(q.poisonValue) && q.poisoned) asrHits++;
          // Precondition check on the SAME assertion `substrate.validate.test.ts` makes:
          // exactly one believed value, and it is gold.
          expect(liveValues.size).toBe(1);
          expect(liveValues.has(q.gold)).toBe(true);
        }

        expect(poisonedChecked).toBeGreaterThan(world.questions.length * 0.7); // poison condition actually poisoned
        expect(totalChecked).toBe(world.questions.length);
        const asr = asrHits / poisonedChecked;
        expect(asr).toBe(0);
      },
      600_000,
    );
  },
);
