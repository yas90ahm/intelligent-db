/**
 * multihoprag/runner.test.ts — MultiHop-RAG harness (gated; local-LLM driver).
 *
 * NEW external benchmark (Tang & Yang, COLM 2024) — not LoCoMo / PoisonedRAG / FactWorld /
 * cross-db. Full-corpus retrieval + QA with dual scoring (containment/F1 + LLM judge).
 *
 *   MHR_BENCH=1 MHR_MODEL=qwen2.5:7b MHR_N=200 MHR_ARMS=idb,rag \
 *     npx vitest run src/__bench__/multihoprag/runner.test.ts
 *
 * Output: .arbor/sessions/new-best-in-class-2026-07-08/multihoprag/results.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  loadMultiHopQueries,
  loadMultiHopCorpus,
  chunkDocuments,
  stratifiedSubsample,
} from "./dataset.js";
import type { MhrQuery } from "./dataset.js";
import { buildIdbIndex, ragRetrieve } from "./arms.js";
import { embedTexts } from "../retrieval/embed.js";
import { buildQaPrompt } from "../retrieval/qa/qaPrompt.js";
import { scoreAnswer } from "../retrieval/qa/qaScore.js";
import { judgeAnswer } from "../longmemeval/judge.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "../retrieval/qa/ollama.js";

const RUN = process.env["MHR_BENCH"] === "1";

type ArmId = "idb" | "rag";

const envInt = (k: string, dflt: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};
const envList = (k: string, dflt: string): string[] =>
  (process.env[k] ?? dflt).split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const MODEL = process.env["MHR_MODEL"] ?? "qwen2.5:7b";
const JUDGE_MODEL = process.env["MHR_JUDGE_MODEL"] ?? MODEL;
const N = envInt("MHR_N", 200);
const TOP_K = envInt("MHR_K", 8);
const ARMS = envList("MHR_ARMS", "idb,rag") as ArmId[];
const CONCURRENCY = envInt("MHR_CONCURRENCY", 4);
const CHUNK_CHARS = envInt("MHR_CHUNK_CHARS", 900);
const QUERY_PATH =
  process.env["MHR_QUERIES"] ?? "D:\\Intelligent DB\\.arbor\\cache\\multihoprag\\MultiHopRAG.json";
const CORPUS_PATH =
  process.env["MHR_CORPUS"] ?? "D:\\Intelligent DB\\.arbor\\cache\\multihoprag\\corpus.json";
const OUT_DIR =
  process.env["MHR_OUT_DIR"] ??
  "D:\\Intelligent DB\\.arbor\\sessions\\new-best-in-class-2026-07-08\\multihoprag";

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
  readonly item: MhrQuery;
  readonly arm: ArmId;
  readonly prompt: string;
}

(RUN ? describe : describe.skip)(
  "MultiHop-RAG — idb vs rag over full corpus, dual-metric scored",
  () => {
    it(
      "retrieves top-K chunks per arm, reads with a local LLM, scores vs gold two ways",
      async () => {
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${MODEL}`);
        }
        if (!existsSync(QUERY_PATH) || !existsSync(CORPUS_PATH)) {
          throw new Error(`missing MultiHop-RAG data at ${QUERY_PATH} / ${CORPUS_PATH}`);
        }

        const all = loadMultiHopQueries(readFileSync(QUERY_PATH, "utf8"));
        const docs = loadMultiHopCorpus(readFileSync(CORPUS_PATH, "utf8"));
        expect(all.length).toBeGreaterThan(0);
        expect(docs.length).toBeGreaterThan(0);

        const subsample = stratifiedSubsample(all, N, (q) => q.questionType, (q) => q.id);
        const strata: Record<string, number> = {};
        for (const q of subsample) strata[q.questionType] = (strata[q.questionType] ?? 0) + 1;

        const chunks = chunkDocuments(docs, CHUNK_CHARS);
        process.stderr.write(`[multihoprag] docs=${docs.length} chunks=${chunks.length} queries=${subsample.length}\n`);

        // Embed all chunks + all query texts once.
        const chunkTexts = chunks.map((c) => c.text);
        const queryTexts = subsample.map((q) => q.query);
        const vectors = await embedTexts([...chunkTexts, ...queryTexts]);
        const chunkVecs = vectors.slice(0, chunks.length);
        const queryVecs = vectors.slice(chunks.length);
        process.stderr.write(`[multihoprag] embedded ${vectors.length} texts\n`);

        const idb = ARMS.includes("idb") ? buildIdbIndex(chunks, chunkVecs) : null;
        process.stderr.write(`[multihoprag] idb index ${idb ? "ready" : "skipped"}\n`);

        const memoriesOf = new Map<string, string[]>();
        for (let qi = 0; qi < subsample.length; qi++) {
          const q = subsample[qi]!;
          const qv = queryVecs[qi]!;
          for (const arm of ARMS) {
            const mem =
              arm === "idb" ? idb!.retrieve(qv, TOP_K) : ragRetrieve(chunks, chunkVecs, qv, TOP_K);
            memoriesOf.set(`${q.id}|${arm}`, mem);
          }
          if ((qi + 1) % 25 === 0) process.stderr.write(`[multihoprag] retrieved ${qi + 1}/${subsample.length}\n`);
        }

        const tasks: Task[] = [];
        for (const q of subsample) {
          for (const arm of ARMS) {
            tasks.push({ item: q, arm, prompt: buildQaPrompt(q.query, memoriesOf.get(`${q.id}|${arm}`)!)});
          }
        }

        const replies = await mapLimit(tasks, CONCURRENCY, async (t) =>
          ollamaGenerate(t.prompt, { model: MODEL, num_predict: 64, temperature: 0, timeoutMs: 180_000 }),
        );
        const judged = await mapLimit(tasks, CONCURRENCY, async (t, i) =>
          judgeAnswer(t.item.query, t.item.answer, replies[i]!, { model: JUDGE_MODEL }),
        );

        interface Row {
          arm: ArmId;
          n: number;
          f1: number;
          containment: number;
          judgeAcc: number;
          agreement: number;
        }
        const zero = (arm: ArmId): Row => ({ arm, n: 0, f1: 0, containment: 0, judgeAcc: 0, agreement: 0 });
        const perArm: Record<string, Row> = {};
        for (const arm of ARMS) perArm[arm] = zero(arm);
        const perType: Record<string, Record<string, Row>> = {};
        const nullSubset: Record<string, Row> = {};
        for (const arm of ARMS) nullSubset[arm] = zero(arm);

        const samples: Array<{
          arm: string;
          qid: string;
          type: string;
          question: string;
          gold: string;
          reply: string;
          f1: number;
          containment: number;
          judge: string;
        }> = [];

        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i]!;
          const reply = replies[i]!;
          const sc = scoreAnswer(reply, t.item.answer);
          const jv = judged[i]!;
          const judgeBit = jv === "CORRECT" ? 1 : 0;

          const a = perArm[t.arm]!;
          a.n += 1;
          a.f1 += sc.f1;
          a.containment += sc.contains;
          a.judgeAcc += judgeBit;
          if (sc.contains === judgeBit) a.agreement += 1;

          const tp = (perType[t.item.questionType] ??= {});
          const tr = (tp[t.arm] ??= zero(t.arm));
          tr.n += 1;
          tr.f1 += sc.f1;
          tr.containment += sc.contains;
          tr.judgeAcc += judgeBit;
          if (sc.contains === judgeBit) tr.agreement += 1;

          if (t.item.isNull) {
            const nr = nullSubset[t.arm]!;
            nr.n += 1;
            nr.f1 += sc.f1;
            nr.containment += sc.contains;
            nr.judgeAcc += judgeBit;
            if (sc.contains === judgeBit) nr.agreement += 1;
          }

          if (samples.length < 16) {
            samples.push({
              arm: t.arm,
              qid: t.item.id,
              type: t.item.questionType,
              question: t.item.query,
              gold: t.item.answer,
              reply,
              f1: sc.f1,
              containment: sc.contains,
              judge: jv,
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
        for (const type of Object.keys(perType)) {
          for (const arm of Object.keys(perType[type]!)) perType[type]![arm] = mean(perType[type]![arm]!);
        }
        for (const arm of ARMS) nullSubset[arm] = mean(nullSubset[arm]!);

        const out = {
          config: {
            model: MODEL,
            judgeModel: JUDGE_MODEL,
            arms: ARMS,
            n: subsample.length,
            topK: TOP_K,
            requestedN: N,
            strata,
            chunkChars: CHUNK_CHARS,
            nChunks: chunks.length,
            nDocs: docs.length,
            host: ollamaHost(),
            dataset: "MultiHop-RAG (yixuantt/MultiHopRAG) — full corpus retrieval",
            scoring: "dual: containment/F1 + local LLM judge (CORRECT/WRONG)",
          },
          perArm,
          perType,
          nullSubset,
          samples,
        };
        mkdirSync(OUT_DIR, { recursive: true });
        const outPath = join(OUT_DIR, "results.json");
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        const h = "arm  |   n | contain% |   F1%  | judgeAcc% | agree%";
        // eslint-disable-next-line no-console
        console.log(`\n=== MultiHop-RAG (n=${subsample.length}, K=${TOP_K}, model=${MODEL}) ===\n${h}\n${"-".repeat(h.length)}`);
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
        // eslint-disable-next-line no-console
        console.log(`\n[multihoprag] wrote ${outPath}`);

        expect(Object.keys(perArm).length).toBe(ARMS.length);
      },
      86_400_000,
    );
  },
);
