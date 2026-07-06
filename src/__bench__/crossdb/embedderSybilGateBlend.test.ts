/**
 * crossdb/embedderSybilGateBlend.test.ts — Phase 1b adversarial gate §2
 * (docs/specs/PHASE1B_RANKING_SPEC.md): "Sybil crossdb gate (the embedderSybilGate
 * variant): 24/24 must hold with rankMode='blend' on the recall path."
 *
 * UPDATED for Phase 1c (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "re-run all
 * gates on the frozen config"): the re-rank step now uses the FROZEN Phase 1c
 * presentation config (`../frozenPresentationConfig.js` — scoreMode 'rrf', k=60,
 * wState=0.1, unionTopN=128, embedder nomic-embed-text, the same embedder
 * `createOllamaEmbedder()` already defaults to here) instead of the
 * DEFAULT_PRESENTATION_WEIGHTS this gate ran with in Phase 1b.
 *
 * IDENTICAL scenario/wiring to `embedderSybilGate.test.ts` (same `buildCheapSybilAttack`
 * generator, same H=3 honest / A in {5,50,200} / 8-trials-each = 24 trials, same
 * worst-case seeding: `engine.recall()` seeded PURELY by Ollama cosine similarity, no
 * entity/lexical boost at all) with ONE addition: after the walk completes, the lit
 * set is re-ranked through `rankRecallResult(..., FROZEN_PRESENTATION_OPTIONS)` — the
 * REAL presentation-ranking module (`recall/presentationRank.ts`), union-widened
 * against the SAME vector sidecar the seeding step already populated — before the
 * winning value is computed.
 *
 * This is the load-bearing check the spec's thesis line makes: presentation ranking
 * MAY reorder/widen what is shown, but the WINNING VALUE — max independence-weighted
 * root count over provenance (`identity.independentRootCount`) — must be governed
 * identically whether the lit set arrives in walk order or blend order. If similarity
 * could ever flip belief, blend mode's cosine-heavy score would let a poisoned
 * near-duplicate outrank the true value's provenance; the thesis constraint says it
 * cannot, so the gate stays 24/24 either way.
 *
 * Requires a live Ollama server (`nomic-embed-text` pulled). Gated behind
 * CROSSDB_BENCH=1 (same flag family as the walk-mode gate). To run:
 *
 *     CROSSDB_BENCH=1 npx vitest run src/__bench__/crossdb/embedderSybilGateBlend.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createMemoryVectorSidecar,
  createEmbeddingCueResolver,
  rankRecallResult,
  asStrandId,
} from "../../index.js";
import type {
  StrandStore,
  IntelligentDb,
  CueResolver,
  EmbedderPort,
  WalkSeed,
  EntityId,
  AttributeKey,
  SourceId,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  EpochMs,
} from "../../index.js";
import type { WriteFactInput } from "../../api.js";

import { createOllamaEmbedder } from "../../examples/embedders.js";
import { makeIdentity, bareStamp, NOW } from "../fixtures.js";
import { buildCheapSybilAttack } from "./attack.js";
import { FROZEN_PRESENTATION_OPTIONS } from "../frozenPresentationConfig.js";

const RUN = process.env["CROSSDB_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\cross-db-bench\\experiments\\embedder-sybil-gate-blend";

const H = 3;
const A_VALUES = [5, 50, 200];
const TRIALS_PER_A = 8; // 3 x 8 = 24, matching the walk-mode gate exactly
const EMBED_SEED_K = 64; // generous — every distinct payload text in a trial must fit

interface TrialRecord {
  readonly tag: string;
  readonly A: number;
  readonly litCount: number;
  readonly blendedCount: number;
  readonly winner: string | null;
  readonly winnerWalkMode: string | null;
  readonly correct: boolean;
  readonly beliefUnchangedVsWalk: boolean;
}

(RUN ? describe : describe.skip)(
  "CROSSDB_BENCH Sybil — WITH the Ollama embedder configured, rankMode='blend' (Phase 1b spec §2 gate)",
  () => {
    it(
      "blend-mode presentation ranking still leaves the winning value governed by independence, never similarity — 24/24",
      async () => {
        const store: StrandStore = createMemoryStore();
        const { identity } = makeIdentity();
        const engine: IntelligentDb = createIntelligentDb(store, identity);

        const embedder: EmbedderPort = createOllamaEmbedder();
        const vectors = createMemoryVectorSidecar();

        // WORST-CASE seeding: identical to the walk-mode gate — the `base` resolver
        // contributes NOTHING, so every seed must come from cosine similarity alone.
        const emptyBase: CueResolver = { index(): void {}, resolve: (): WalkSeed[] => [] };
        const embResolver = createEmbeddingCueResolver(store, embedder, vectors, { base: emptyBase });

        const trials: TrialRecord[] = [];
        let rootSeq = 0;

        for (const A of A_VALUES) {
          for (let t = 0; t < TRIALS_PER_A; t++) {
            const tag = `${A}:${t}`;
            const sc = buildCheapSybilAttack(tag, H, A);

            // 1) WRITE every fact through the REAL engine (mint path unchanged).
            const inputs: WriteFactInput[] = sc.facts.map((f) => ({
              entity: f.entity as EntityId,
              attribute: f.attribute as AttributeKey,
              payload: { value: f.value, text: `${f.entity} ${f.attribute} ${f.value}` },
              stamp: bareStamp(f.sourceId as SourceId),
            }));
            const ids = engine.writeFactsBatch(inputs);
            for (const id of ids) embResolver.index(store.getStrand(id)!);

            // Manual provenance-root index — H honest DISTINCT classes vs A Sybil ONE
            // SHARED class (identical modeling to the walk-mode gate / published bench).
            const rootByStrandId = new Map<string, ProvenanceRoot>();
            const valueByStrandId = new Map<string, string>();
            sc.facts.forEach((f, i) => {
              const id = String(ids[i]!);
              const isHonest = f.sourceId.startsWith("honest:");
              rootByStrandId.set(id, {
                rootId: `root:${rootSeq++}` as ProvenanceRootId,
                independenceClass: (isHonest ? `cls:honest:${tag}:${i}` : `cls:sybil:${tag}:SHARED`) as IndependenceClassId,
                sourceId: null,
                establishedAt: NOW as EpochMs,
              });
              valueByStrandId.set(id, f.value);
            });

            // 2) POPULATE THE REAL VECTOR SIDECAR (same batched-embed pattern as the
            //    walk-mode gate) — this sidecar is ALSO what blend mode's union term
            //    reads, so it must carry every fact's payload text, honest AND Sybil.
            const texts = ids.map((id) => {
              const strand = store.getStrand(id)!;
              return { hash: strand.content_hash, text: `${strand.entity} ${sc.attribute} ${valueByStrandId.get(String(id))!}` };
            });
            const embedded = await embedder.embed(texts.map((x) => x.text));
            texts.forEach((x, i) => vectors.put(x.hash, embedder.modelId, embedded[i]!));

            // 3) SEED engine.recall() purely via embedder cosine top-K over the cue.
            const cueText = `${sc.entity} ${sc.attribute}`;
            const seeds = await embResolver.resolveWithEmbeddings(
              { text: cueText },
              { embedSeedK: EMBED_SEED_K, embedSeedEnergyCap: 1 },
            );
            expect(seeds.length).toBeGreaterThan(0);

            const res = engine.recall({ seeds });

            // 4a) WALK-MODE winning value (for the belief-unchanged-vs-walk comparison).
            const winningValueOf = (
              lit: readonly { strandId: unknown }[],
            ): string | null => {
              const rootsByValue = new Map<string, ProvenanceRoot[]>();
              for (const l of lit) {
                const id = String(l.strandId);
                const root = rootByStrandId.get(id);
                const value = valueByStrandId.get(id);
                if (root === undefined || value === undefined) continue;
                const arr = rootsByValue.get(value) ?? [];
                arr.push(root);
                rootsByValue.set(value, arr);
              }
              let winner: string | null = null;
              let bestScore = -1;
              for (const [value, roots] of rootsByValue) {
                const score = identity.independentRootCount(roots);
                if (score > bestScore) {
                  bestScore = score;
                  winner = value;
                }
              }
              return winner;
            };

            const winnerWalkMode = winningValueOf(res.lit);

            // 4b) BLEND-MODE re-ranking: the real Phase 1b module, union-widened
            //     against the SAME vector sidecar the seeding step populated.
            const cueVector = (await embedder.embed([cueText]))[0]!;
            const blended = rankRecallResult(
              store,
              res,
              { vectors, modelId: embedder.modelId, cueVector },
              FROZEN_PRESENTATION_OPTIONS,
            );
            const winner = winningValueOf(blended.lit);

            const correct = winner === sc.trueValue;
            const beliefUnchangedVsWalk = winner === winnerWalkMode;
            trials.push({
              tag,
              A,
              litCount: res.lit.length,
              blendedCount: blended.lit.length,
              winner,
              winnerWalkMode,
              correct,
              beliefUnchangedVsWalk,
            });
          }
        }

        const correctCount = trials.filter((t) => t.correct).length;
        const unchangedCount = trials.filter((t) => t.beliefUnchangedVsWalk).length;

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(
          `${OUT_DIR}/metrics.json`,
          JSON.stringify(
            { H, A_VALUES, TRIALS_PER_A, EMBED_SEED_K, trials, correctCount, unchangedCount, totalTrials: trials.length },
            null,
            2,
          ),
        );
        writeFileSync(`${OUT_DIR}/results.md`, renderReport(trials, correctCount, unchangedCount));

        // ---- THE GATE --------------------------------------------------------
        expect(trials.length).toBe(24);
        expect(correctCount).toBe(24);
        // Belief metric (winning value by independent root count) unchanged vs walk mode.
        expect(unchangedCount).toBe(24);

        void asStrandId; // referenced for type-consistency of the import; no-op
      },
      600_000,
    );
  },
);

function renderReport(trials: readonly TrialRecord[], correctCount: number, unchangedCount: number): string {
  const L: string[] = [];
  L.push("# CROSSDB_BENCH Sybil — WITH the Ollama embedder, rankMode='blend' (Phase 1b spec §2 gate)");
  L.push("");
  L.push(
    `${trials.length} attack trials (H=${H} honest, A in {${A_VALUES.join(", ")}}, ${TRIALS_PER_A} trials each) — ` +
      `IDENTICAL scenario generator + worst-case cosine-only seeding to the walk-mode gate. The lit set is then ` +
      `re-ranked through the real Phase 1b \`rankRecallResult(..., { rankMode: 'blend' })\` before the winning ` +
      `value is computed.`,
  );
  L.push("");
  L.push(`**Result: ${correctCount}/${trials.length} correct; ${unchangedCount}/${trials.length} belief-unchanged vs walk mode.**`);
  L.push("");
  L.push("| A | trial | lit (walk) | lit (blend) | winner (blend) | winner (walk) | correct | unchanged vs walk |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const t of trials) {
    L.push(
      `| ${t.A} | ${t.tag} | ${t.litCount} | ${t.blendedCount} | ${t.winner ?? "(none)"} | ${t.winnerWalkMode ?? "(none)"} | ${t.correct ? "yes" : "NO"} | ${t.beliefUnchangedVsWalk ? "yes" : "NO"} |`,
    );
  }
  L.push("");
  L.push(
    "The winning value is computed the SAME way in both modes — max independence-weighted root count " +
      "(`identity.independentRootCount`) over each value's provenance. Blend mode widens/reorders the " +
      "PRESENTATION of the lit set (cosine-heavy score, union-added candidates) but never touches this " +
      "computation's inputs in a way that changes the outcome: belief stays a function of independence, never similarity.",
  );
  L.push("");
  return L.join("\n");
}
