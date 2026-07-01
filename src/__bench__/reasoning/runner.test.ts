/**
 * reasoning/runner.test.ts — REASONING-BENCHMARK harness (gated; local-LLM driver).
 *
 * Compares memory/retrieval ARMS (bare | rag | substrate) on competition reasoning
 * benchmarks (math = MATH-500, gpqa = GPQA-diamond, coding = HumanEval) across one or
 * more local Ollama models. Each arm chooses K few-shot exemplars for the SAME problem;
 * the model/prompt/K are identical, so the only variable is the retrieval strategy.
 * We measure EXACT-ANSWER accuracy and generation LATENCY.
 *
 *   REASON_BENCH=1 REASON_MODELS=qwen2.5:7b,llama3.1:8b,gemma3 \
 *     REASON_BENCHMARKS=math,gpqa,coding REASON_N=20 REASON_K=3 \
 *     npx vitest run src/__bench__/reasoning/runner.test.ts
 *
 * Defaults are a tiny PILOT (N=5, qwen2.5:7b only). Output:
 *   .arbor/sessions/reasoning-bench/results.json  (+ a console table)
 *
 * Determinism: temperature 0, id-sorted subsample, hash-stable exemplar order. The
 * engine src/ is untouched — this layer is purely additive, adapter-level.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { loadBench, splitStudyTest } from "./datasets.js";
import type { BenchItem, BenchmarkId } from "./datasets.js";
import { embedTexts } from "../retrieval/embed.js";
import { bareArm, ragArm, substrateArm, hybridArm } from "./arms.js";
import type { Arm, ArmId } from "./arms.js";
import { createMem0Arm } from "./mem0Arm.js";
import { buildBank } from "./poison.js";
import { buildPrompt, numPredictFor } from "./prompt.js";
import { scoreMath, scoreGpqa } from "./score.js";
import { runHumanEval } from "./codeExec.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "../retrieval/qa/ollama.js";

const RUN = process.env["REASON_BENCH"] === "1";

const envList = (k: string, dflt: string): string[] =>
  (process.env[k] ?? dflt).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const envInt = (k: string, dflt: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};

const MODELS = envList("REASON_MODELS", "qwen2.5:7b");
const BENCHMARKS = envList("REASON_BENCHMARKS", "math,gpqa,coding") as BenchmarkId[];
const ARMS = envList("REASON_ARMS", "bare,rag,substrate,hybrid") as ArmId[];
const N = envInt("REASON_N", 5);
const K = envInt("REASON_K", 3);
/** Cap the study bank size (0 = use all held-out items). Bounds mem0 ingest time. */
const STUDY_CAP = envInt("REASON_STUDY_CAP", 0);
/** Poison rate in [0,1]: fraction of studied problems given an adversarial wrong-answer twin. 0 = clean. */
const POISON_RATE = (() => {
  const v = Number(process.env["REASON_POISON"]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1) : 0;
})();
const DATA_DIR = process.env["REASON_DATA"] ?? "D:\\Intelligent DB\\.arbor\\cache\\reasoning";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\reasoning-bench";

// mem0 arm (external substrate) config — its OWN local pipeline (Ollama + embedded Qdrant).
const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? MODELS[0] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = envInt("MEM0_EMBED_DIMS", 768);

interface RowResult {
  model: string;
  benchmark: BenchmarkId;
  arm: ArmId;
  n: number;
  correct: number;
  accuracy: number;
  avgGenMs: number;
  totalGenMs: number;
}

function scoreItem(item: BenchItem, reply: string): boolean {
  if (item.benchmark === "math") return scoreMath(reply, item.gold);
  if (item.benchmark === "gpqa") return scoreGpqa(reply, item.gold);
  const m = item.meta as Record<string, unknown>;
  return runHumanEval(reply, String(m["test"]), String(m["entry_point"])).passed;
}

(RUN ? describe : describe.skip)(
  "REASONING bench — bare vs rag vs substrate over local LLMs (math/gpqa/coding)",
  () => {
    it(
      "retrieves K exemplars per arm, generates, scores exact-answer accuracy + latency",
      async () => {
        const model0 = MODELS[0];
        if (!model0) throw new Error("REASON_MODELS is empty");
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${MODELS.join(", ")}`);
        }

        const rows: RowResult[] = [];
        const samples: Array<{ model: string; benchmark: string; arm: string; id: string; ok: boolean; pred: string }> = [];
        const poisonByBench: Record<string, { studyN: number; poisonN: number; recall: Record<string, { recalled: number; poison: number; rate: number }> }> = {};

        for (const bench of BENCHMARKS) {
          const path = join(DATA_DIR, `${bench}.jsonl`);
          if (!existsSync(path)) {
            throw new Error(`missing dataset ${path} — run prep_datasets.py first`);
          }
          const all = loadBench(path);
          // Leakage-free split: first-N-by-id are HELD-OUT test; the rest are the STUDY bank.
          const split = splitStudyTest(all, N);
          const evalItems = split.test;
          const studyBank = STUDY_CAP > 0 ? split.study.slice(0, STUDY_CAP) : split.study;
          expect(evalItems.length).toBeGreaterThan(0);
          expect(studyBank.length).toBeGreaterThan(0);

          // Build the study bank (clean, or with adversarial wrong-answer twins if poisoned).
          const bank = buildBank(studyBank, POISON_RATE);
          const pool = bank.map((e) => e.item);
          const nPoison = bank.filter((e) => e.poison).length;

          // Embed the bank (shared memory corpus) and the test queries. Same embedder +
          // cache for all arms, so the embedding channel is identical.
          const bankVecs = await embedTexts(pool.map((p) => p.retrieval_text));
          const testVecs = await embedTexts(evalItems.map((p) => p.retrieval_text));

          // Build ONLY the requested arms over the BANK (test items are never in memory).
          // mem0 is async (spawns a sidecar + ingests the bank) and only built if requested.
          const armOf: Partial<Record<ArmId, Arm>> = {};
          for (const a of ARMS) {
            if (a === "bare") armOf.bare = bareArm();
            else if (a === "rag") armOf.rag = ragArm(pool, bankVecs);
            else if (a === "substrate") armOf.substrate = substrateArm(bank, bankVecs);
            else if (a === "hybrid") armOf.hybrid = hybridArm(pool, bankVecs);
            else if (a === "mem0") {
              armOf.mem0 = await createMem0Arm(bank, {
                pythonBin: MEM0_PYTHON,
                llm: MEM0_LLM,
                embed: MEM0_EMBED,
                embedDims: MEM0_EMBED_DIMS,
                qdrantPath: join(tmpdir(), `idb-mem0-${bench}-${process.pid}`),
                ollamaHost: ollamaHost(),
              });
            }
          }

          // Poison-recall pass (model-independent): of the exemplars each arm recalls, how
          // many are poison? This is the clean mechanistic signal — ID should recall ~0.
          const poisonRecall: Record<string, { recalled: number; poison: number; rate: number }> = {};
          if (POISON_RATE > 0) {
            for (const armId of ARMS) {
              const arm = armOf[armId]!;
              let recalled = 0;
              let poison = 0;
              for (let qi = 0; qi < evalItems.length; qi++) {
                const exIdx = await arm.exemplars({ item: evalItems[qi]!, vec: testVecs[qi]! }, K);
                recalled += exIdx.length;
                poison += exIdx.filter((i) => bank[i]!.poison).length;
              }
              poisonRecall[armId] = { recalled, poison, rate: recalled > 0 ? poison / recalled : 0 };
              // eslint-disable-next-line no-console
              console.log(`[reason] ${bench} | ${armId}: poison-recall ${poison}/${recalled} = ${(100 * (recalled ? poison / recalled : 0)).toFixed(1)}%`);
            }
          }
          poisonByBench[bench] = { studyN: studyBank.length, poisonN: nPoison, recall: poisonRecall };

          for (const model of MODELS) {
            for (const armId of ARMS) {
              const arm = armOf[armId]!;
              let correct = 0;
              let totalGenMs = 0;
              for (let qi = 0; qi < evalItems.length; qi++) {
                const item = evalItems[qi]!;
                const exIdx = await arm.exemplars({ item, vec: testVecs[qi]! }, K);
                const exemplars = exIdx.map((i) => pool[i]!);
                const prompt = buildPrompt(item, exemplars);
                const t0 = performance.now();
                const reply = await ollamaGenerate(prompt, {
                  model,
                  num_predict: numPredictFor(bench),
                  timeoutMs: 300_000,
                });
                totalGenMs += performance.now() - t0;
                const ok = scoreItem(item, reply);
                if (ok) correct += 1;
                if (samples.length < 12) {
                  samples.push({ model, benchmark: bench, arm: armId, id: item.id, ok, pred: reply.slice(-160) });
                }
              }
              const n = evalItems.length;
              const row: RowResult = {
                model, benchmark: bench, arm: armId, n, correct,
                accuracy: correct / n, avgGenMs: totalGenMs / n, totalGenMs,
              };
              rows.push(row);
              // eslint-disable-next-line no-console
              console.log(
                `[reason] ${model} | ${bench} | ${armId}: ${correct}/${n} = ${(100 * row.accuracy).toFixed(1)}%  (avg ${(row.avgGenMs / 1000).toFixed(1)}s/q)`,
              );
            }
          }

          // Release per-benchmark arm resources (the mem0 sidecar + its Qdrant store).
          for (const a of Object.values(armOf)) if (a?.close) await a.close();

          // Checkpoint after each benchmark so a later failure never discards finished work.
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(
            join(OUT_DIR, "results.partial.json"),
            JSON.stringify({ config: { models: MODELS, arms: ARMS, n: N, k: K, poisonRate: POISON_RATE }, rows, poison: poisonByBench }, null, 2),
          );
        }

        // ---- HEADLINE: does memory beat no-memory? delta vs `bare` per (model,bench) ----
        const groups = new Map<string, RowResult[]>();
        for (const r of rows) {
          const key = `${r.model}|||${r.benchmark}`;
          const g = groups.get(key);
          if (g) g.push(r);
          else groups.set(key, [r]);
        }
        const deltas: Array<{
          model: string; benchmark: BenchmarkId; arm: ArmId;
          accuracy: number; baselineBare: number; deltaVsBare: number;
        }> = [];
        for (const g of groups.values()) {
          const bare = g.find((r) => r.arm === "bare");
          const base = bare ? bare.accuracy : NaN;
          for (const r of g) {
            deltas.push({
              model: r.model, benchmark: r.benchmark, arm: r.arm,
              accuracy: r.accuracy, baselineBare: base, deltaVsBare: r.accuracy - base,
            });
          }
        }

        // ---- write + summarize -------------------------------------------------
        mkdirSync(OUT_DIR, { recursive: true });
        const out = {
          config: { models: MODELS, benchmarks: BENCHMARKS, arms: ARMS, n: N, k: K, poisonRate: POISON_RATE, host: ollamaHost() },
          rows,
          deltaVsBare: deltas,
          poison: POISON_RATE > 0 ? { rate: POISON_RATE, perBenchmark: poisonByBench } : null,
          samples,
        };
        const outPath = join(OUT_DIR, "results.json");
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        // console table
        const hdr = "model                | bench  | arm        |  acc   | avg s/q";
        // eslint-disable-next-line no-console
        console.log("\n" + hdr + "\n" + "-".repeat(hdr.length));
        for (const r of rows) {
          // eslint-disable-next-line no-console
          console.log(
            `${r.model.padEnd(20)} | ${r.benchmark.padEnd(6)} | ${r.arm.padEnd(10)} | ${(100 * r.accuracy).toFixed(1).padStart(5)}% | ${(r.avgGenMs / 1000).toFixed(1).padStart(6)}`,
          );
        }
        // headline table: MEMORY vs NO-MEMORY (Δ = arm accuracy − bare accuracy)
        if (ARMS.includes("bare")) {
          const memArms = ARMS.filter((a) => a !== "bare");
          const dh = `model                | bench  | no-mem | ${memArms.map((a) => `${a} (Δ)`.padEnd(18)).join("| ")}`;
          // eslint-disable-next-line no-console
          console.log("\n=== MEMORY vs NO-MEMORY (accuracy, Δ vs bare) ===\n" + dh + "\n" + "-".repeat(dh.length));
          for (const g of groups.values()) {
            const bare = g.find((r) => r.arm === "bare");
            if (!bare) continue;
            const cells = memArms.map((a) => {
              const r = g.find((x) => x.arm === a);
              if (!r) return "".padEnd(18);
              const d = r.accuracy - bare.accuracy;
              const sign = d > 0 ? "+" : "";
              return `${(100 * r.accuracy).toFixed(1)}% (${sign}${(100 * d).toFixed(1)})`.padEnd(18);
            });
            // eslint-disable-next-line no-console
            console.log(
              `${bare.model.padEnd(20)} | ${bare.benchmark.padEnd(6)} | ${(100 * bare.accuracy).toFixed(1).padStart(5)}% | ${cells.join("| ")}`,
            );
          }
        }

        // poison-recall table: of the exemplars each arm recalled, how many were poison?
        if (POISON_RATE > 0) {
          const memArms = ARMS.filter((a) => a !== "bare");
          const ph = `bench  | ${memArms.map((a) => a.padEnd(16)).join("| ")}`;
          // eslint-disable-next-line no-console
          console.log(`\n=== POISON RECALL (lower = better defense; poison rate ${POISON_RATE}) ===\n` + ph + "\n" + "-".repeat(ph.length));
          for (const bench of BENCHMARKS) {
            const pr = poisonByBench[bench];
            if (!pr) continue;
            const cells = memArms.map((a) => {
              const r = pr.recall[a];
              return (r ? `${(100 * r.rate).toFixed(1)}% (${r.poison}/${r.recalled})` : "-").padEnd(16);
            });
            // eslint-disable-next-line no-console
            console.log(`${bench.padEnd(6)} | ${cells.join("| ")}`);
          }
        }

        // eslint-disable-next-line no-console
        console.log(`\n[reason] wrote ${outPath}`);

        expect(rows.length).toBe(MODELS.length * BENCHMARKS.length * ARMS.length);
      },
      86_400_000,
    );
  },
);
