/**
 * factworld/embedderSeededSubstrateBlend.test.ts — Phase 1b adversarial gate §4
 * (docs/specs/PHASE1B_RANKING_SPEC.md): "FactWorld substrate quick arm: 0.0% ASR
 * with blend mode active on the recall path."
 *
 * UPDATED for Phase 1c (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "re-run all
 * gates on the frozen config"): the re-rank step now uses the FROZEN Phase 1c
 * presentation config (`../frozenPresentationConfig.js` — scoreMode 'rrf', k=60,
 * wState=0.1, unionTopN=128, embedder nomic-embed-text) instead of
 * DEFAULT_PRESENTATION_WEIGHTS.
 *
 * IDENTICAL substrate + poisoned-condition wiring to `embedderSeededSubstrate.test.ts`
 * (same `buildSubstrate`, same worst-case cosine-only seeding via
 * `createEmbeddingCueResolver` with an EMPTY `base` resolver) with ONE addition:
 * after `engine.recall()` returns, the lit set is re-ranked through the real
 * `rankRecallResult(..., FROZEN_PRESENTATION_OPTIONS)` — union-widened against the
 * SAME vector sidecar the seeding step populated — before the believed-LIVE-value
 * check that computes ASR. If similarity could ever leak into belief, the poisoned
 * Sybil cluster's dense near-duplicate statements — now ALSO scored by raw cosine
 * in the presentation layer — could crowd the adjudicated LIVE gold value out of
 * the answer; the thesis constraint says it cannot, so ASR must stay 0.0% either
 * way (this is the "quick arm": no LLM judge, adjudication-only, the same
 * no-LLM substrate check `substrate.validate.test.ts` runs, extended to blend).
 *
 * Requires a live Ollama server (`nomic-embed-text` pulled). Gated behind
 * FACTWORLD_BENCH=1 (the existing suite's own flag family). To run:
 *
 *     FACTWORLD_BENCH=1 npx vitest run src/__bench__/factworld/embedderSeededSubstrateBlend.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  createMemoryVectorSidecar,
  createEmbeddingCueResolver,
  rankRecallResult,
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
import { FROZEN_PRESENTATION_OPTIONS } from "../frozenPresentationConfig.js";

const RUN = process.env["FACTWORLD_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\factworld\\embedder-seeded-substrate-blend";
const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const attrKeyOf = (entity: string, attribute: string): string => `${entity}::${attribute}`;
const EMBED_SEED_K = 64;

// ---------------------------------------------------------------------------
// Substrate construction — IDENTICAL to embedderSeededSubstrate.test.ts (kept
// duplicated deliberately so this file never risks the already-passing walk-mode
// gate; see that file's header for the modeling rationale).
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
  "FactWorld substrate — WITH the Ollama embedder configured, rankMode='blend' (Phase 1b spec §4 gate)",
  () => {
    it(
      "engine.recall() seeded PURELY by cosine similarity, THEN re-ranked in blend mode, still surfaces only the adjudicated-LIVE gold value — 0.0% ASR",
      async () => {
        const world = generateFactWorld({ entities: 5, condition: "poison", poisonRate: 1.0, sybilK: 8, seed: 7 });
        const { engine, store } = buildSubstrate(world.assertions);

        const embedder: EmbedderPort = createOllamaEmbedder();
        const vectors = createMemoryVectorSidecar();
        const emptyBase: CueResolver = { index(): void {}, resolve: (): WalkSeed[] => [] };
        const embResolver = createEmbeddingCueResolver(store, embedder, vectors, { base: emptyBase });

        // Populate the REAL vector sidecar via ONE batched Ollama call over every
        // distinct strand's rendered statement — this is ALSO what blend mode's
        // union term reads, so honest AND poisoned statements alike must be in it.
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
        let blendWidenedAtLeastOnce = false;
        for (const q of world.questions) {
          const attrKey = attrKeyOf(q.entity, q.attribute);
          const cueText = `${q.entity} ${q.attribute}`;
          const seeds = await embResolver.resolveWithEmbeddings(
            { text: cueText },
            { embedSeedK: EMBED_SEED_K, embedSeedEnergyCap: 1 },
          );
          if (seeds.length === 0) continue; // nothing to seed for this (entity,attribute) — skip, not a false pass
          const res = engine.recall({ seeds });

          // BLEND MODE: re-rank the walk's lit set through the real Phase 1b module,
          // union-widened against the same sidecar the seeding step populated.
          const cueVector = (await embedder.embed([cueText]))[0]!;
          const blended = rankRecallResult(store, res, { vectors, modelId: embedder.modelId, cueVector }, FROZEN_PRESENTATION_OPTIONS);
          if (blended.lit.length > res.lit.length) blendWidenedAtLeastOnce = true;

          const liveValues = new Set<string>();
          for (const lit of blended.lit) {
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
          // exactly one believed value, and it is gold — belief unchanged by blend mode.
          expect(liveValues.size).toBe(1);
          expect(liveValues.has(q.gold)).toBe(true);
        }

        expect(poisonedChecked).toBeGreaterThan(world.questions.length * 0.7); // poison condition actually poisoned
        expect(totalChecked).toBe(world.questions.length);
        // NOTE: blendWidenedAtLeastOnce is reported (not gated) — on this small substrate
        // the worst-case cosine-only seeding (EMBED_SEED_K=64) can already retrieve every
        // strand for a given (entity,attribute) into the walk's own lit set, so blend's
        // union sometimes has nothing left to add. That is a real, honest substrate-size
        // property, not a test bug; the gate below (ASR) is what this file actually proves.
        const asr = asrHits / poisonedChecked;

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(
          `${OUT_DIR}/metrics.json`,
          JSON.stringify({ poisonedChecked, totalChecked, asrHits, asr, blendWidenedAtLeastOnce, embedSeedK: EMBED_SEED_K }, null, 2),
        );
        writeFileSync(
          `${OUT_DIR}/results.md`,
          [
            "# FactWorld substrate quick arm — rankMode='blend' (Phase 1b spec §4 gate)",
            "",
            `Poisoned questions checked: ${poisonedChecked}/${totalChecked}. ASR: **${(asr * 100).toFixed(1)}%**.`,
            "",
            "Belief (adjudicated LIVE value) is computed from the BLEND-mode re-ranked/widened lit set, not the raw walk — proving similarity-driven presentation widening never leaks into the believed value.",
            "",
          ].join("\n"),
        );

        expect(asr).toBe(0);

        void asStrandId; // referenced for type-consistency of the import; no-op
      },
      600_000,
    );
  },
);
