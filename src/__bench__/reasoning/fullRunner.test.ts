/**
 * reasoning/fullRunner.test.ts — FULL-SCALE rigorous evaluation (gated; local-LLM driver).
 *
 * Tests the WHOLE of each benchmark with a leakage-free SEPARATE study corpus, concurrent
 * generation, and avg@k multi-sampling on the noisy sets — the "what a real model eval does"
 * version of runner.test.ts. The thesis stays: does the Intelligent DB memory (`substrate`)
 * make a capable model more accurate than no memory (`bare`)? `rag`/`hybrid`/`mem0` are
 * controls.
 *
 *   FULL_BENCH=1 FULL_MODEL=gemma3:12b npx vitest run src/__bench__/reasoning/fullRunner.test.ts
 *
 * Memory source (leakage-free, every test item is graded):
 *   - math / aime : study bank = MATH-train (study_math.jsonl), disjoint from MATH-500/AIME.
 *   - coding      : study bank = MBPP (study_coding.jsonl), disjoint from HumanEval.
 *   - gpqa        : leave-one-out over GPQA-diamond + a near-duplicate cosine filter.
 * A near-dup cosine filter (FULL_DEDUP) is applied in ALL cases as a second guard.
 *
 * Sampling: single greedy sample for every arm by default; thesis arms (FULL_THESIS_ARMS)
 * get avg@k on the noisy sets (FULL_SAMPLES_GPQA, FULL_SAMPLES_AIME) at temperature FULL_TEMP.
 *
 * Output: .arbor/sessions/reasoning-bench/full_results.json (+ console tables, per-benchmark
 * checkpoint to full_results.partial.json).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { loadBench } from "./datasets.js";
import type { BenchItem, BenchmarkId } from "./datasets.js";
import { embedTexts, cosine } from "../retrieval/embed.js";
import { bareArm, ragArm, substrateArm, hybridArm } from "./arms.js";
import type { Arm, ArmId } from "./arms.js";
import { createMem0Arm } from "./mem0Arm.js";
import { buildBank } from "./poison.js";
import { buildPrompt, numPredictFor } from "./prompt.js";
import { scoreMath, scoreGpqa } from "./score.js";
import { runHumanEval } from "./codeExec.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "../retrieval/qa/ollama.js";

const RUN = process.env["FULL_BENCH"] === "1";

const envList = (k: string, dflt: string): string[] =>
  (process.env[k] ?? dflt).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const envInt = (k: string, dflt: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};
const envFloat = (k: string, dflt: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : dflt;
};

const MODEL = process.env["FULL_MODEL"] ?? "gemma3:12b";
const BENCHMARKS = envList("FULL_BENCHMARKS", "math,gpqa,coding,aime") as BenchmarkId[];
const ARMS = envList("FULL_ARMS", "bare,rag,substrate,hybrid,mem0") as ArmId[];
const THESIS_ARMS = new Set<string>(envList("FULL_THESIS_ARMS", "bare,rag,substrate"));
const K = envInt("FULL_K", 3);
const CONCURRENCY = envInt("FULL_CONCURRENCY", 3);
const STUDY_CAP = envInt("FULL_STUDY_CAP", 1000);
/** Cap the number of TEST items per benchmark (0 = the whole set). For fast smoke tests. */
const TEST_CAP = envInt("FULL_TEST_CAP", 0);
const DEDUP = envFloat("FULL_DEDUP", 0.92);
const POISON = envFloat("FULL_POISON", 0);
const TEMP = envFloat("FULL_TEMP", 0.7);
const SAMPLES: Record<BenchmarkId, number> = {
  math: envInt("FULL_SAMPLES_MATH", 1),
  coding: envInt("FULL_SAMPLES_CODING", 1),
  gpqa: envInt("FULL_SAMPLES_GPQA", 4),
  aime: envInt("FULL_SAMPLES_AIME", 16),
};

/** Unique per-run output tag: <model>_<clean|poisonX>. Keeps the 4 runs from clobbering. */
const RUN_TAG = `${MODEL.replace(/[^A-Za-z0-9._-]+/g, "_")}_${POISON > 0 ? `poison${POISON}` : "clean"}`;

const DATA_DIR = process.env["REASON_DATA"] ?? "D:\\Intelligent DB\\.arbor\\cache\\reasoning";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\reasoning-bench";
const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = envInt("MEM0_EMBED_DIMS", 768);

/** The leakage-free study file for a benchmark, or null ⇒ leave-one-out over its own set. */
function studyFileFor(b: BenchmarkId): string | null {
  if (b === "math" || b === "aime") return "study_math.jsonl";
  if (b === "coding") return "study_coding.jsonl";
  return null; // gpqa
}

function scoreItem(item: BenchItem, reply: string): boolean {
  if (item.benchmark === "math" || item.benchmark === "aime") return scoreMath(reply, item.gold);
  if (item.benchmark === "gpqa") return scoreGpqa(reply, item.gold);
  const m = item.meta as Record<string, unknown>;
  return runHumanEval(reply, String(m["test"]), String(m["entry_point"])).passed;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
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

const sortById = (xs: readonly BenchItem[]): BenchItem[] =>
  [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

interface RowResult {
  model: string;
  benchmark: BenchmarkId;
  arm: ArmId;
  nItems: number;
  samples: number;
  correctMean: number;
  accuracy: number;
  avgGenMs: number;
}

interface GenResult {
  armId: ArmId;
  qi: number;
  reply: string;
  ms: number;
}

(RUN ? describe : describe.skip)(
  "FULL reasoning bench — leakage-free study corpora, concurrent, avg@k on noisy sets",
  () => {
    it(
      "tests the whole of each benchmark; memory (substrate) vs no-memory (bare) + controls",
      async () => {
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${MODEL}`);
        }

        const rows: RowResult[] = [];
        const samplesOut: Array<{ benchmark: string; arm: string; id: string; ok: boolean; pred: string }> = [];
        const poisonByBench: Record<string, { poisonN: number; recall: Record<string, { recalled: number; poison: number; rate: number }> }> = {};

        for (const bench of BENCHMARKS) {
          const testPath = join(DATA_DIR, `${bench}.jsonl`);
          if (!existsSync(testPath)) throw new Error(`missing ${testPath} — run prep_datasets.py`);
          let testItems = sortById(loadBench(testPath));
          if (TEST_CAP > 0 && testItems.length > TEST_CAP) testItems = testItems.slice(0, TEST_CAP);

          // Study corpus (separate + leakage-free, or leave-one-out for gpqa), capped.
          const sf = studyFileFor(bench);
          const leaveOneOut = sf === null;
          let studyItems = leaveOneOut ? testItems : sortById(loadBench(join(DATA_DIR, sf)));
          if (STUDY_CAP > 0 && studyItems.length > STUDY_CAP) studyItems = studyItems.slice(0, STUDY_CAP);

          // Build the bank FIRST (adds poison twins when POISON>0), then embed the POOL so
          // the vectors line up 1:1 with the arms' bank indices (bug fix: embedding the
          // pre-poison studyItems left the arms indexing past the end of the vector array).
          const bank = buildBank(studyItems, POISON);
          const pool = bank.map((e) => e.item);

          // Embed (shared MiniLM, cached on disk).
          const studyVecs = await embedTexts(pool.map((p) => p.retrieval_text));
          const testVecs = await embedTexts(testItems.map((p) => p.retrieval_text));

          // Build requested arms over the bank.
          const armOf: Partial<Record<ArmId, Arm>> = {};
          for (const a of ARMS) {
            if (a === "bare") armOf.bare = bareArm();
            else if (a === "rag") armOf.rag = ragArm(pool, studyVecs);
            else if (a === "substrate") armOf.substrate = substrateArm(bank, studyVecs);
            else if (a === "hybrid") armOf.hybrid = hybridArm(pool, studyVecs);
            else if (a === "mem0") {
              armOf.mem0 = await createMem0Arm(bank, {
                pythonBin: MEM0_PYTHON,
                llm: MODEL,
                embed: MEM0_EMBED,
                embedDims: MEM0_EMBED_DIMS,
                qdrantPath: join(tmpdir(), `idb-mem0-full-${bench}-${process.pid}`),
                ollamaHost: ollamaHost(),
              });
            }
          }

          // Precompute exemplars (+ dedup) → one prompt per (arm, test item). When the bank
          // is poisoned, also tally POISON-RECALL: of the exemplars each arm actually injects,
          // how many are adversarial twins? (ID's defense shows here even when downstream
          // accuracy barely moves — substrate demotes poison → ~0%; rag/mem0 recall it.)
          const promptByArm = new Map<ArmId, string[]>();
          const poisonRecall: Record<string, { recalled: number; poison: number; rate: number }> = {};
          for (const armId of ARMS) {
            const arm = armOf[armId]!;
            const prompts: string[] = [];
            let recalled = 0;
            let poison = 0;
            for (let qi = 0; qi < testItems.length; qi++) {
              const exRaw = await arm.exemplars({ item: testItems[qi]!, vec: testVecs[qi]! }, K + 12);
              const ex: number[] = [];
              for (const i of exRaw) {
                if (pool[i]!.id === testItems[qi]!.id) continue; // self
                if (cosine(testVecs[qi]!, studyVecs[i]!) > DEDUP) continue; // near-dup guard
                ex.push(i);
                if (ex.length >= K) break;
              }
              recalled += ex.length;
              poison += ex.filter((i) => bank[i]!.poison).length;
              prompts.push(buildPrompt(testItems[qi]!, ex.map((i) => pool[i]!)));
            }
            promptByArm.set(armId, prompts);
            poisonRecall[armId] = { recalled, poison, rate: recalled > 0 ? poison / recalled : 0 };
            if (POISON > 0) {
              // eslint-disable-next-line no-console
              console.log(`[full] ${bench} | ${armId}: poison-recall ${poison}/${recalled} = ${(100 * (recalled ? poison / recalled : 0)).toFixed(1)}%`);
            }
          }
          if (POISON > 0) {
            poisonByBench[bench] = { poisonN: bank.filter((e) => e.poison).length, recall: poisonRecall };
          }

          // Build the generation task list (avg@k for thesis arms on noisy sets).
          interface Task { armId: ArmId; qi: number; prompt: string; seed: number; temp: number }
          const tasks: Task[] = [];
          const samplesOfArm: Record<string, number> = {};
          for (const armId of ARMS) {
            const samp = THESIS_ARMS.has(armId) ? SAMPLES[bench] : 1;
            samplesOfArm[armId] = samp;
            const prompts = promptByArm.get(armId)!;
            for (let qi = 0; qi < testItems.length; qi++) {
              for (let s = 0; s < samp; s++) {
                tasks.push({ armId, qi, prompt: prompts[qi]!, seed: s, temp: samp > 1 ? TEMP : 0 });
              }
            }
          }

          // Generate concurrently. num_predict per benchmark, overridable per env
          // (FULL_NUMPREDICT_AIME etc.) — reasoning models need bigger budgets.
          const np = envInt(`FULL_NUMPREDICT_${bench.toUpperCase()}`, numPredictFor(bench));
          const gen: GenResult[] = await mapLimit(tasks, CONCURRENCY, async (t) => {
            const t0 = performance.now();
            const reply = await ollamaGenerate(t.prompt, {
              model: MODEL,
              num_predict: np,
              temperature: t.temp,
              seed: t.seed,
              timeoutMs: 600_000,
            });
            return { armId: t.armId, qi: t.qi, reply, ms: performance.now() - t0 };
          });

          // Score (sequential — coding spawns python) and aggregate avg@k.
          const correctByArm = new Map<ArmId, number[][]>();
          const msByArm = new Map<ArmId, number[]>();
          for (const armId of ARMS) {
            correctByArm.set(armId, Array.from({ length: testItems.length }, () => []));
            msByArm.set(armId, []);
          }
          for (const g of gen) {
            const ok = scoreItem(testItems[g.qi]!, g.reply);
            correctByArm.get(g.armId)![g.qi]!.push(ok ? 1 : 0);
            msByArm.get(g.armId)!.push(g.ms);
            if (samplesOut.length < 16) {
              samplesOut.push({ benchmark: bench, arm: g.armId, id: testItems[g.qi]!.id, ok, pred: g.reply.slice(-160) });
            }
          }

          for (const armId of ARMS) {
            const perItem = correctByArm.get(armId)!.map((arr) => mean(arr));
            const acc = mean(perItem);
            rows.push({
              model: MODEL, benchmark: bench, arm: armId,
              nItems: testItems.length, samples: samplesOfArm[armId]!,
              correctMean: acc, accuracy: acc, avgGenMs: mean(msByArm.get(armId)!),
            });
            // eslint-disable-next-line no-console
            console.log(
              `[full] ${bench} | ${armId}: ${(100 * acc).toFixed(1)}%  (n=${testItems.length}, avg@${samplesOfArm[armId]}, ${(mean(msByArm.get(armId)!) / 1000).toFixed(1)}s/gen)`,
            );
          }

          // Release per-benchmark arm resources (mem0 sidecar + its Qdrant store).
          for (const a of Object.values(armOf)) if (a?.close) await a.close();

          // Checkpoint after each benchmark.
          mkdirSync(OUT_DIR, { recursive: true });
          writeFileSync(
            join(OUT_DIR, `full_${RUN_TAG}.partial.json`),
            JSON.stringify({ model: MODEL, rows }, null, 2),
          );
        }

        // Headline: Δ vs bare per (benchmark).
        const deltas: Array<{ benchmark: BenchmarkId; arm: ArmId; accuracy: number; baselineBare: number; deltaVsBare: number }> = [];
        const byBench = new Map<BenchmarkId, RowResult[]>();
        for (const r of rows) {
          const g = byBench.get(r.benchmark);
          if (g) g.push(r);
          else byBench.set(r.benchmark, [r]);
        }
        for (const g of byBench.values()) {
          const bare = g.find((r) => r.arm === "bare");
          const base = bare ? bare.accuracy : NaN;
          for (const r of g) deltas.push({ benchmark: r.benchmark, arm: r.arm, accuracy: r.accuracy, baselineBare: base, deltaVsBare: r.accuracy - base });
        }

        mkdirSync(OUT_DIR, { recursive: true });
        const out = {
          config: {
            model: MODEL, benchmarks: BENCHMARKS, arms: ARMS, thesisArms: [...THESIS_ARMS],
            k: K, concurrency: CONCURRENCY, studyCap: STUDY_CAP, dedup: DEDUP, poison: POISON,
            temp: TEMP, samples: SAMPLES, host: ollamaHost(),
          },
          rows,
          deltaVsBare: deltas,
          poison: POISON > 0 ? { rate: POISON, perBenchmark: poisonByBench } : null,
          samples: samplesOut,
        };
        const outPath = join(OUT_DIR, `full_${RUN_TAG}.json`);
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        // Console: full table + MEMORY vs NO-MEMORY.
        const hdr = "bench  | arm        |  acc   | n    | avg@ | s/gen";
        // eslint-disable-next-line no-console
        console.log("\n" + hdr + "\n" + "-".repeat(hdr.length));
        for (const r of rows) {
          // eslint-disable-next-line no-console
          console.log(
            `${r.benchmark.padEnd(6)} | ${r.arm.padEnd(10)} | ${(100 * r.accuracy).toFixed(1).padStart(5)}% | ${String(r.nItems).padStart(4)} | ${String(r.samples).padStart(4)} | ${(r.avgGenMs / 1000).toFixed(1).padStart(5)}`,
          );
        }
        if (ARMS.includes("bare")) {
          const memArms = ARMS.filter((a) => a !== "bare");
          const dh = `bench  | no-mem | ${memArms.map((a) => `${a} (Δ)`.padEnd(18)).join("| ")}`;
          // eslint-disable-next-line no-console
          console.log("\n=== MEMORY vs NO-MEMORY (accuracy, Δ vs bare) ===\n" + dh + "\n" + "-".repeat(dh.length));
          for (const g of byBench.values()) {
            const bare = g.find((r) => r.arm === "bare");
            if (!bare) continue;
            const cells = memArms.map((a) => {
              const r = g.find((x) => x.arm === a);
              if (!r) return "".padEnd(18);
              const d = r.accuracy - bare.accuracy;
              return `${(100 * r.accuracy).toFixed(1)}% (${d > 0 ? "+" : ""}${(100 * d).toFixed(1)})`.padEnd(18);
            });
            // eslint-disable-next-line no-console
            console.log(`${bare.benchmark.padEnd(6)} | ${(100 * bare.accuracy).toFixed(1).padStart(5)}% | ${cells.join("| ")}`);
          }
        }
        // POISON RECALL table (the metric that shows ID's defense directly).
        if (POISON > 0) {
          const memArms = ARMS.filter((a) => a !== "bare");
          const ph = `bench  | ${memArms.map((a) => a.padEnd(16)).join("| ")}`;
          // eslint-disable-next-line no-console
          console.log(`\n=== POISON RECALL (fraction of recalled exemplars that are poison; lower = better defense; rate ${POISON}) ===\n` + ph + "\n" + "-".repeat(ph.length));
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
        console.log(`\n[full] wrote ${outPath}`);

        expect(rows.length).toBe(BENCHMARKS.length * ARMS.length);
      },
      86_400_000,
    );
  },
);
