/**
 * longmemeval/runner.test.ts — LongMemEval (ORACLE subset) harness (gated; local-LLM driver).
 *
 * Adopts LongMemEval (Wu et al., ICLR 2025 — https://github.com/xiaowu0162/LongMemEval),
 * flagged in BENCH_RERUN_2026-07-06.md as "the market's likely next benchmark after
 * LoCoMo". Best-effort MEDIUM adoption: the **oracle** release (500 questions, each
 * paired with its own small evidence-only haystack, ~15MB total — see `dataset.ts` for
 * why oracle over the 277MB/2.7GB `_s`/`_m` full-haystack releases) run on a deterministic
 * stratified subsample (default N=60, covering every question type + the abstention
 * subset), with two arms:
 *
 *   - idb : the real engine (activation-walk MultiSeedID retrieval over a per-question
 *           conversation graph — same machinery `retrieval/retrievers.ts` runs on LoCoMo).
 *   - rag : flat vector top-K over the same turns (no walk, no provenance).
 *
 * Scoring is DUAL (mirrors `poisonedrag/dualMetricRunner.test.ts`): the cheap
 * containment/F1 metric (`retrieval/qa/qaScore.ts`, reused verbatim) alongside a local
 * LLM judge (qwen2.5:7b by default) that reproduces LongMemEval's own "is this
 * semantically correct" grading protocol (the paper uses GPT-4o; this harness has no paid
 * API dependency) — reported side by side with their agreement rate.
 *
 *   LME_BENCH=1 LME_MODEL=qwen2.5:7b LME_N=60 LME_ARMS=idb,rag \
 *     npx vitest run src/__bench__/longmemeval/runner.test.ts
 *
 * Output: .arbor/sessions/longmemeval/results.json (+ a console table).
 * Determinism: temperature 0, id-sorted stratified subsample. Engine src/ is untouched —
 * this layer is purely additive, adapter-level (same discipline as every other bench).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { loadLongMemEval, toConversation, buildLmeGraph, stratifiedSubsample } from "./dataset.js";
import type { LmeItem } from "./dataset.js";
import { embedTexts } from "../retrieval/embed.js";
import { createLmeIdRetriever, lmeSeed, idbMemories, ragMemories } from "./arms.js";
import { buildQaPrompt } from "../retrieval/qa/qaPrompt.js";
import { scoreAnswer } from "../retrieval/qa/qaScore.js";
import { judgeAnswer } from "./judge.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "../retrieval/qa/ollama.js";

const RUN = process.env["LME_BENCH"] === "1";

const envInt = (k: string, dflt: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};
const envList = (k: string, dflt: string): string[] =>
  (process.env[k] ?? dflt).split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const MODEL = process.env["LME_MODEL"] ?? "qwen2.5:7b";
const JUDGE_MODEL = process.env["LME_JUDGE_MODEL"] ?? MODEL;
const N = envInt("LME_N", 60);
const TOP_K = envInt("LME_K", 10);
const ARMS = envList("LME_ARMS", "idb,rag") as Array<"idb" | "rag">;
const CONCURRENCY = envInt("LME_CONCURRENCY", 4);
const CACHE_PATH = process.env["LME_DATA"] ?? "D:\\Intelligent DB\\.arbor\\cache\\longmemeval\\longmemeval_oracle.json";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\longmemeval";
const ORACLE_URLS = [
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
];

async function download(url: string, dest: string): Promise<boolean> {
  const https = await import("node:https");
  return await new Promise<boolean>((resolve) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest).then(resolve, () => resolve(false));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(true)));
      out.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
  });
}

async function locateOracleJson(): Promise<string> {
  if (existsSync(CACHE_PATH)) return CACHE_PATH;
  mkdirSync(join(CACHE_PATH, ".."), { recursive: true });
  for (const url of ORACLE_URLS) {
    if (await download(url, CACHE_PATH)) return CACHE_PATH;
  }
  throw new Error(`could not obtain longmemeval_oracle.json (set LME_DATA to a local copy; tried ${ORACLE_URLS.join(", ")})`);
}

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

interface Task {
  readonly item: LmeItem;
  readonly arm: "idb" | "rag";
  readonly prompt: string;
}

(RUN ? describe : describe.skip)(
  "LongMemEval (oracle subset) — idb vs rag, dual-metric scored (containment/F1 + LLM judge)",
  () => {
    it(
      "retrieves top-K memories per arm, reads with a local LLM, scores vs gold two ways",
      async () => {
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${MODEL}${JUDGE_MODEL !== MODEL ? `, ${JUDGE_MODEL}` : ""}`);
        }

        // ---- 1) DATASET + deterministic stratified subsample --------------------
        const path = await locateOracleJson();
        const all = loadLongMemEval(readFileSync(path, "utf8"));
        expect(all.length).toBeGreaterThan(0);
        const subsample = stratifiedSubsample(all, N, (it) => it.questionType, (it) => it.questionId);
        expect(subsample.length).toBeGreaterThan(0);

        const strata: Record<string, number> = {};
        let nAbstention = 0;
        for (const it of subsample) {
          strata[it.questionType] = (strata[it.questionType] ?? 0) + 1;
          if (it.isAbstention) nAbstention += 1;
        }

        // ---- 2) EMBED (shared; batched across the whole subsample) --------------
        const turnTexts: string[] = [];
        const turnIds: string[] = [];
        for (const it of subsample) for (const t of it.turns) { turnTexts.push(t.text); turnIds.push(t.id); }
        const cueTexts = subsample.map((it) => it.question);
        const vectors = await embedTexts([...turnTexts, ...cueTexts]);
        const vecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => vecByTurn.set(id, vectors[i]!));
        const vecByQuestion = new Map<string, Float32Array>();
        subsample.forEach((it, i) => vecByQuestion.set(it.questionId, vectors[turnTexts.length + i]!));
        const turnText = new Map<string, string>();
        for (const it of subsample) for (const t of it.turns) turnText.set(t.id, t.text);

        // ---- 3) PER-QUESTION conversation graph + (if requested) idb retriever --
        const convOf = new Map(subsample.map((it) => [it.questionId, toConversation(it)] as const));
        const graphOf = new Map(
          [...convOf.entries()].map(([qid, conv]) => [qid, buildLmeGraph(conv, (id) => vecByTurn.get(id)!)] as const),
        );
        const idrOf = ARMS.includes("idb")
          ? new Map([...convOf.entries()].map(([qid, conv]) => [qid, createLmeIdRetriever(conv)] as const))
          : new Map<string, ReturnType<typeof createLmeIdRetriever>>();

        // ---- 4) RETRIEVE memories per (item, arm) --------------------------------
        const memoriesOf = new Map<string, string[]>(); // `${questionId}|${arm}` -> memories
        for (const it of subsample) {
          const cueVec = vecByQuestion.get(it.questionId)!;
          const conv = convOf.get(it.questionId)!;
          const graph = graphOf.get(it.questionId)!;
          for (const arm of ARMS) {
            const mem =
              arm === "idb"
                ? idbMemories(idrOf.get(it.questionId)!, graph, cueVec, turnText, TOP_K)
                : ragMemories(conv, vecByTurn, cueVec, turnText, TOP_K);
            memoriesOf.set(`${it.questionId}|${arm}`, mem);
          }
        }
        void lmeSeed; // (available for future entity-seeded variants; MultiSeedID seeds by vector-kNN only)

        // ---- 5) BUILD PROMPTS, GENERATE (bounded concurrency) --------------------
        const tasks: Task[] = [];
        for (const it of subsample) {
          for (const arm of ARMS) {
            const mem = memoriesOf.get(`${it.questionId}|${arm}`)!;
            tasks.push({ item: it, arm, prompt: buildQaPrompt(it.question, mem) });
          }
        }
        const replies = await mapLimit(tasks, CONCURRENCY, async (t) =>
          ollamaGenerate(t.prompt, { model: MODEL, num_predict: 96, temperature: 0, timeoutMs: 180_000 }),
        );

        // ---- 6) SCORE dual-metric: cheap containment/F1 + LLM judge -------------
        const judged = await mapLimit(tasks, CONCURRENCY, async (t, i) =>
          judgeAnswer(t.item.question, t.item.answer, replies[i]!, { model: JUDGE_MODEL }),
        );

        interface Row {
          arm: "idb" | "rag";
          n: number;
          f1: number;
          containment: number;
          judgeAcc: number;
          agreement: number; // containment bit === judge-correct bit
        }
        const zero = (arm: "idb" | "rag"): Row => ({ arm, n: 0, f1: 0, containment: 0, judgeAcc: 0, agreement: 0 });
        const perArm: Record<string, Row> = {};
        for (const arm of ARMS) perArm[arm] = zero(arm);
        const perType: Record<string, Record<string, Row>> = {};
        const abstention: Record<string, Row> = {};
        for (const arm of ARMS) abstention[arm] = zero(arm);

        const samples: Array<{ arm: string; qid: string; type: string; question: string; gold: string; reply: string; f1: number; containment: number; judge: string }> = [];

        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]!;
          const reply = replies[i]!;
          const sc = scoreAnswer(reply, t.item.answer);
          const jv = judged[i]!;
          const judgeBit = jv === "CORRECT" ? 1 : 0;

          const a = perArm[t.arm]!;
          a.n += 1; a.f1 += sc.f1; a.containment += sc.contains; a.judgeAcc += judgeBit;
          if (sc.contains === judgeBit) a.agreement += 1;

          const tp = (perType[t.item.questionType] ??= {});
          const tr = (tp[t.arm] ??= zero(t.arm));
          tr.n += 1; tr.f1 += sc.f1; tr.containment += sc.contains; tr.judgeAcc += judgeBit;
          if (sc.contains === judgeBit) tr.agreement += 1;

          if (t.item.isAbstention) {
            const ar = abstention[t.arm]!;
            ar.n += 1; ar.f1 += sc.f1; ar.containment += sc.contains; ar.judgeAcc += judgeBit;
            if (sc.contains === judgeBit) ar.agreement += 1;
          }

          if (samples.length < 16) {
            samples.push({
              arm: t.arm, qid: t.item.questionId, type: t.item.questionType, question: t.item.question,
              gold: t.item.answer, reply, f1: sc.f1, containment: sc.contains, judge: jv,
            });
          }
        }

        const mean = (r: Row): Row => ({
          ...r,
          f1: r.n ? r.f1 / r.n : 0,
          containment: r.n ? r.containment / r.n : 0,
          judgeAcc: r.n ? r.judgeAcc / r.n : 0,
          agreement: r.n ? r.agreement / r.n : 0,
        });
        for (const arm of ARMS) perArm[arm] = mean(perArm[arm]!);
        for (const type of Object.keys(perType)) for (const arm of Object.keys(perType[type]!)) perType[type]![arm] = mean(perType[type]![arm]!);
        for (const arm of ARMS) abstention[arm] = mean(abstention[arm]!);

        // ---- 7) WRITE OUTPUT ------------------------------------------------------
        const out = {
          config: {
            model: MODEL, judgeModel: JUDGE_MODEL, arms: ARMS, n: subsample.length, topK: TOP_K,
            requestedN: N, strata, nAbstention, host: ollamaHost(),
            dataset: "LongMemEval oracle (xiaowu0162/longmemeval-cleaned, longmemeval_oracle.json)",
            scoring: "dual: containment/F1 (retrieval/qa/qaScore.ts) + local LLM judge (CORRECT/WRONG)",
          },
          perArm,
          perType,
          abstention,
          samples,
        };
        mkdirSync(OUT_DIR, { recursive: true });
        const outPath = join(OUT_DIR, "results.json");
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        // ---- 8) console tables -----------------------------------------------------
        const h = "arm  |   n | contain% |   F1%  | judgeAcc% | agree%";
        // eslint-disable-next-line no-console
        console.log(`\n=== LongMemEval oracle (n=${subsample.length}, K=${TOP_K}, model=${MODEL}) ===\n${h}\n${"-".repeat(h.length)}`);
        for (const arm of ARMS) {
          const r = perArm[arm]!;
          // eslint-disable-next-line no-console
          console.log(
            `${arm.padEnd(4)} | ${String(r.n).padStart(3)} | ${(100 * r.containment).toFixed(1).padStart(8)} | ${(100 * r.f1).toFixed(1).padStart(6)} | ${(100 * r.judgeAcc).toFixed(1).padStart(9)} | ${(100 * r.agreement).toFixed(1).padStart(6)}`,
          );
        }
        // eslint-disable-next-line no-console
        console.log(`\n=== per question_type (judge accuracy) ===`);
        for (const type of Object.keys(perType).sort()) {
          const cells = ARMS.map((arm) => {
            const r = perType[type]![arm];
            return r ? `${arm}=${(100 * r.judgeAcc).toFixed(1)}%(n${r.n})` : `${arm}=-`;
          });
          // eslint-disable-next-line no-console
          console.log(`  ${type.padEnd(24)} ${cells.join("  ")}`);
        }
        if (nAbstention > 0) {
          // eslint-disable-next-line no-console
          console.log(`\n=== abstention subset (n=${nAbstention}) ===`);
          for (const arm of ARMS) {
            const r = abstention[arm]!;
            // eslint-disable-next-line no-console
            console.log(`  ${arm.padEnd(4)} judgeAcc=${(100 * r.judgeAcc).toFixed(1)}%  contain=${(100 * r.containment).toFixed(1)}%`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`\n[longmemeval] wrote ${outPath}`);

        expect(Object.keys(perArm).length).toBe(ARMS.length);
      },
      86_400_000,
    );
  },
);
