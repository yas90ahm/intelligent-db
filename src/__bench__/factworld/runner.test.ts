/**
 * factworld/runner.test.ts — the closed-book entity-attribute QA benchmark (gated).
 *
 * The council's design, implemented: ~300 fictional entities × 4 attributes = ~1,200
 * closed-book questions whose CURRENT value lives ONLY in injected memory. Memory arms
 * (bare / rag / substrate / mem0) each retrieve context; a local LLM answers; EM scoring
 * (no judge). Run in BOTH conditions — clean bank and Sybil-poisoned bank (paired by seed).
 *
 *   FACTWORLD_BENCH=1 FW_MODEL=qwen2.5:7b FW_ENTITIES=300 \
 *     npx vitest run src/__bench__/factworld/runner.test.ts
 *
 * Headline: on the POISONED subset, does memory help over bare, and does substrate hold its
 * accuracy (ASR≈0) while rag/mem0 collapse (ASR high)? bare is unaffected by poison (sanity).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { generateFactWorld, labelOf } from "./generate.js";
import type { Condition, FWQuestion } from "./generate.js";
import { embedTexts } from "../retrieval/embed.js";
import { bareArm, ragArm, substrateArm } from "./arms.js";
import type { FwArm, FwArmId } from "./arms.js";
import { createFwMem0Arm } from "./mem0Arm.js";
import { buildFwPrompt } from "./prompt.js";
import { scoreEM } from "./score.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "../retrieval/qa/ollama.js";

const RUN = process.env["FACTWORLD_BENCH"] === "1";

const envInt = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};
const envFloat = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};
const envList = (k: string, d: string): string[] =>
  (process.env[k] ?? d).split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const MODEL = process.env["FW_MODEL"] ?? "qwen2.5:7b";
const ENTITIES = envInt("FW_ENTITIES", 300);
const POISON_RATE = envFloat("FW_POISON_RATE", 0.5);
const SYBIL_K = envInt("FW_SYBIL_K", 6);
const TOP_K = envInt("FW_K", 5);
const ARMS = envList("FW_ARMS", "bare,rag,substrate,mem0") as FwArmId[];
const CONCURRENCY = envInt("FW_CONCURRENCY", 4);
const SEED = envInt("FW_SEED", 7);
const NUM_PREDICT = envInt("FW_NUMPREDICT", 24);
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\factworld";
const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = envInt("MEM0_EMBED_DIMS", 768);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, () => worker()));
  return out;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const meanAt = (xs: readonly number[], idx: readonly number[]): number => (idx.length ? idx.reduce((a, i) => a + xs[i]!, 0) / idx.length : 0);

(RUN ? describe : describe.skip)(
  "FACTWORLD — closed-book entity-attribute QA, clean vs Sybil-poison, EM-scored",
  () => {
    it(
      "runs each memory arm on clean + poisoned banks and reports accuracy + ASR",
      async () => {
        if (!(await ollamaReachable())) throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${MODEL}`);

        // correct[cond][arm][qi] / answeredPoison[cond][arm][qi]
        const correct: Record<Condition, Partial<Record<FwArmId, number[]>>> = { clean: {}, poison: {} };
        const answeredPoison: Record<Condition, Partial<Record<FwArmId, number[]>>> = { clean: {}, poison: {} };
        let poisonQuestions: FWQuestion[] = [];

        for (const condition of ["clean", "poison"] as Condition[]) {
          const world = generateFactWorld({ entities: ENTITIES, condition, poisonRate: POISON_RATE, sybilK: SYBIL_K, seed: SEED });
          if (condition === "poison") poisonQuestions = world.questions;

          const stmtVecs = await embedTexts(world.assertions.map((a) => a.statement));
          const queryVecs = await embedTexts(world.questions.map((q) => `${q.entity}'s ${labelOf(q.attribute)}`));

          // Build requested arms over this bank.
          const armOf: Partial<Record<FwArmId, FwArm>> = {};
          for (const a of ARMS) {
            if (a === "bare") armOf.bare = bareArm();
            else if (a === "rag") armOf.rag = ragArm(world.assertions, stmtVecs, TOP_K);
            else if (a === "substrate") armOf.substrate = substrateArm(world.assertions);
            else if (a === "mem0") {
              armOf.mem0 = await createFwMem0Arm(world.assertions, {
                pythonBin: MEM0_PYTHON, embed: MEM0_EMBED, embedDims: MEM0_EMBED_DIMS, llm: MODEL, k: TOP_K,
              });
            }
          }

          for (const armId of ARMS) {
            const arm = armOf[armId]!;
            // Precompute the prompt for every question (context retrieval).
            const prompts: string[] = [];
            for (let qi = 0; qi < world.questions.length; qi++) {
              const q = world.questions[qi]!;
              const ctx = await arm.contextFor(q, queryVecs[qi]!);
              prompts.push(buildFwPrompt(q.entity, labelOf(q.attribute), ctx));
            }
            // Generate concurrently (answers are a single token).
            const replies = await mapLimit(prompts, CONCURRENCY, async (p) =>
              ollamaGenerate(p, { model: MODEL, num_predict: NUM_PREDICT, temperature: 0, timeoutMs: 120_000 }),
            );
            const corr: number[] = [];
            const ap: number[] = [];
            for (let qi = 0; qi < world.questions.length; qi++) {
              const q = world.questions[qi]!;
              corr.push(scoreEM(replies[qi]!, q.gold) ? 1 : 0);
              ap.push(scoreEM(replies[qi]!, q.poisonValue) ? 1 : 0);
            }
            correct[condition][armId] = corr;
            answeredPoison[condition][armId] = ap;
            // eslint-disable-next-line no-console
            console.log(`[fw] ${condition} | ${armId}: acc ${(100 * mean(corr)).toFixed(1)}%`);
          }

          for (const a of Object.values(armOf)) if (a?.close) await a.close();
        }

        // ---- analysis: poisoned subset (the effect-bearing cell) -----------------
        const poisonIdx: number[] = [];
        for (let qi = 0; qi < poisonQuestions.length; qi++) if (poisonQuestions[qi]!.poisoned) poisonIdx.push(qi);

        const rows = ARMS.map((arm) => {
          const cClean = correct.clean[arm]!;
          const cPois = correct.poison[arm]!;
          const apPois = answeredPoison.poison[arm]!;
          return {
            arm,
            cleanAcc: mean(cClean),
            poisonAcc: mean(cPois),
            // headline cell: on the attacked questions only
            poisonedCleanAcc: meanAt(cClean, poisonIdx),
            poisonedPoisonAcc: meanAt(cPois, poisonIdx),
            deltaOnPoisoned: meanAt(cPois, poisonIdx) - meanAt(cClean, poisonIdx),
            asr: meanAt(apPois, poisonIdx), // fraction of attacked Qs answered with the poison value
          };
        });

        // ---- write + tables -----------------------------------------------------
        mkdirSync(OUT_DIR, { recursive: true });
        const out = {
          config: { model: MODEL, entities: ENTITIES, poisonRate: POISON_RATE, sybilK: SYBIL_K, topK: TOP_K, arms: ARMS, seed: SEED, host: ollamaHost() },
          nQuestions: poisonQuestions.length,
          nPoisoned: poisonIdx.length,
          rows,
        };
        const outPath = join(OUT_DIR, `factworld_${MODEL.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        const h = "arm        | clean | poison || POISONED-SUBSET clean | poison |   Δ   | ASR";
        // eslint-disable-next-line no-console
        console.log(`\n=== FACTWORLD (n=${poisonQuestions.length}, poisoned=${poisonIdx.length}) ===\n${h}\n${"-".repeat(h.length)}`);
        for (const r of rows) {
          // eslint-disable-next-line no-console
          console.log(
            `${r.arm.padEnd(10)} | ${(100 * r.cleanAcc).toFixed(1).padStart(5)} | ${(100 * r.poisonAcc).toFixed(1).padStart(6)} || ${(100 * r.poisonedCleanAcc).toFixed(1).padStart(20)} | ${(100 * r.poisonedPoisonAcc).toFixed(1).padStart(6)} | ${(100 * r.deltaOnPoisoned).toFixed(1).padStart(5)} | ${(100 * r.asr).toFixed(1).padStart(4)}%`,
          );
        }
        // eslint-disable-next-line no-console
        console.log(`\n[fw] wrote ${outPath}`);

        expect(rows.length).toBe(ARMS.length);
      },
      86_400_000,
    );
  },
);
