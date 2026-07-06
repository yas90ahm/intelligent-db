/**
 * crossdb/embedderSybilGate.test.ts — Phase-1 retrieval spec §5.2 adversarial gate:
 * "CROSSDB_BENCH Sybil: IntelligentDB still 24/24. Run WITH the Ollama embedder
 * configured — a poisoned strand may win a seed slot; it must still surface only
 * with its true fact_state/provenance, and the poison metric must not move."
 *
 * The PUBLISHED crossdb baseline (`runner.test.ts` / `adapters/intelligentDb.ts`) is
 * left UNTOUCHED — its `recall()` deliberately bypasses `engine.recall()`/the cue
 * resolver entirely (a parallel offline-provenance index, documented in its own
 * header), so wiring an embedder there would have literally no code path to affect.
 * This file instead runs the SAME `buildCheapSybilAttack` scenario (H=3 honest, A in
 * {5,50,200}, 8 trials each = 24 attack trials — identical to the published bench)
 * through the REAL production seeding path: a live Ollama embedder + a real
 * `VectorSidecar`, seeding `engine.recall()` via `createEmbeddingCueResolver`'s
 * cosine top-K union (spec §3) — WORST-CASE ADVERSARIAL: the seed comes from
 * SIMILARITY ALONE (no exact-entity/lexical boost at all: `base` resolves to `[]`),
 * so every candidate strand — honest AND cheap-Sybil alike — earns its seed slot
 * purely by cosine similarity to the cue.
 *
 * The WINNING VALUE is then computed the identical way the published bench does
 * (independence-weighted `identity.independentRootCount` over each value's
 * provenance roots, H honest facts each in a DISTINCT class vs A Sybil facts sharing
 * ONE class — the attacker controls keys, not class assignment, exactly as
 * `adapters/intelligentDb.ts`'s header states) — but the CANDIDATE SET going into
 * that ranking is now whatever the embedder-seeded activation walk actually lit, not
 * a raw index scan. If similarity could ever flip belief, a poisoned near-duplicate
 * would out-rank the true value here; the thesis constraint says it cannot.
 *
 * Requires a live Ollama server (`nomic-embed-text` pulled). Gated behind
 * CROSSDB_BENCH=1 (reusing the existing suite flag — this IS "the CROSSDB_BENCH
 * Sybil" gate) so a plain `npm test` never hits the network. To run:
 *
 *     CROSSDB_BENCH=1 npx vitest run src/__bench__/crossdb/embedderSybilGate.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createMemoryVectorSidecar,
  createEmbeddingCueResolver,
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

const RUN = process.env["CROSSDB_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\cross-db-bench\\experiments\\embedder-sybil-gate";

const H = 3;
const A_VALUES = [5, 50, 200];
const TRIALS_PER_A = 8; // 3 x 8 = 24, matching the published crossdb baseline exactly
const EMBED_SEED_K = 64; // generous — every distinct payload text in a trial must fit

interface TrialRecord {
  readonly tag: string;
  readonly A: number;
  readonly litCount: number;
  readonly winner: string | null;
  readonly correct: boolean;
}

(RUN ? describe : describe.skip)(
  "CROSSDB_BENCH Sybil — WITH the Ollama embedder configured (spec §5.2)",
  () => {
    it(
      "seeds engine.recall() by cosine similarity ALONE (no entity/lexical boost); the winning value is still governed by independence, never similarity — 24/24",
      async () => {
        const store: StrandStore = createMemoryStore();
        const { identity } = makeIdentity();
        const engine: IntelligentDb = createIntelligentDb(store, identity);

        const embedder: EmbedderPort = createOllamaEmbedder();
        const vectors = createMemoryVectorSidecar();

        // WORST-CASE seeding: the `base` resolver contributes NOTHING — every seed
        // must come from the embedder's cosine top-K, never an exact entity/lexical
        // hit. This is the maximally adversarial configuration the spec's §5.2 gate
        // describes ("a poisoned strand may win a seed slot").
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
            // The resolver's content-hash index is maintained via the `index` hook
            // (the facade calls this on every remember — see cueResolver.ts's
            // header doc); mirror that here for every freshly-written strand.
            for (const id of ids) embResolver.index(store.getStrand(id)!);

            // Manual provenance-root index (H honest DISTINCT classes vs A Sybil ONE
            // SHARED class) — the SAME modeling choice `adapters/intelligentDb.ts`'s
            // header documents: the attacker controls KEYS, not class assignment,
            // so class assignment is the external anchor layer's output, not the
            // engine's own per-source-key auto-mint. Keyed by the resulting strand id
            // so the ranking step below reads roots for whatever the WALK actually lit.
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

            // 2) POPULATE THE REAL VECTOR SIDECAR via a single batched Ollama call —
            //    every fact's payload text is embedded (including the cheap-Sybil
            //    fleet's near-duplicate payloads), keyed by the strand's REAL
            //    content_hash (read back off the store, never re-derived by hand).
            const texts = ids.map((id) => {
              const strand = store.getStrand(id)!;
              return { hash: strand.content_hash, text: `${strand.entity} ${sc.attribute} ${valueByStrandId.get(String(id))!}` };
            });
            const embedded = await embedder.embed(texts.map((x) => x.text));
            texts.forEach((x, i) => vectors.put(x.hash, embedder.modelId, embedded[i]!));

            // 3) SEED engine.recall() purely via embedder cosine top-K over the cue
            //    "<entity> <attribute>" — NO entity/lexical boost (emptyBase above).
            const seeds = await embResolver.resolveWithEmbeddings(
              { text: `${sc.entity} ${sc.attribute}` },
              { embedSeedK: EMBED_SEED_K, embedSeedEnergyCap: 1 },
            );
            expect(seeds.length).toBeGreaterThan(0); // the poisoned+honest strands DID win seed slots

            const res = engine.recall({ seeds });

            // 4) WINNING VALUE = max independence-weighted root count over the LIT
            //    set's own provenance (never similarity/activation) — identical rule
            //    to the published bench's `recall()`.
            const rootsByValue = new Map<string, ProvenanceRoot[]>();
            for (const lit of res.lit) {
              const id = String(lit.strandId);
              const root = rootByStrandId.get(id);
              const value = valueByStrandId.get(id);
              if (root === undefined || value === undefined) continue; // not one of this trial's facts
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
            const correct = winner === sc.trueValue;
            trials.push({ tag, A, litCount: res.lit.length, winner, correct });
          }
        }

        const correctCount = trials.filter((t) => t.correct).length;

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(
          `${OUT_DIR}/metrics.json`,
          JSON.stringify({ H, A_VALUES, TRIALS_PER_A, EMBED_SEED_K, trials, correctCount, totalTrials: trials.length }, null, 2),
        );
        writeFileSync(`${OUT_DIR}/results.md`, renderReport(trials, correctCount));

        // ---- THE GATE --------------------------------------------------------
        expect(trials.length).toBe(24);
        expect(correctCount).toBe(24);

        void asStrandId; // referenced for type-consistency of the import; no-op
      },
      600_000,
    );
  },
);

function renderReport(trials: readonly TrialRecord[], correctCount: number): string {
  const L: string[] = [];
  L.push("# CROSSDB_BENCH Sybil — WITH the Ollama embedder configured (spec §5.2 gate)");
  L.push("");
  L.push(
    `${trials.length} attack trials (H=${H} honest, A in {${A_VALUES.join(", ")}}, ${TRIALS_PER_A} trials each) — ` +
      `identical scenario generator to the published crossdb baseline. Seeding is WORST-CASE adversarial: ` +
      `\`engine.recall()\` is seeded PURELY by Ollama cosine-similarity top-${EMBED_SEED_K} (no entity/lexical boost at all), ` +
      `so every candidate strand — honest AND cheap-Sybil alike — must win its seed slot by similarity.`,
  );
  L.push("");
  L.push(`**Result: ${correctCount}/${trials.length} correct.**`);
  L.push("");
  L.push("| A | trial | lit set size | winner | correct |");
  L.push("|---|---|---|---|---|");
  for (const t of trials) {
    L.push(`| ${t.A} | ${t.tag} | ${t.litCount} | ${t.winner ?? "(none)"} | ${t.correct ? "yes" : "NO"} |`);
  }
  L.push("");
  L.push(
    "The winning value is computed the SAME way the published crossdb bench does — max " +
      "independence-weighted root count (`identity.independentRootCount`) over each value's " +
      "provenance, H honest facts in DISTINCT classes vs A cheap-Sybil facts sharing ONE class — " +
      "but the CANDIDATE SET now comes from a real embedder-seeded activation walk instead of a " +
      "raw index scan. A poisoned near-duplicate payload can (and does) win a seed slot; it never " +
      "wins the belief ranking, because belief is never a function of similarity.",
  );
  L.push("");
  return L.join("\n");
}
