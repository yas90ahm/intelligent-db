/**
 * retrieval/qa/qaRunner.test.ts — CYCLE F: END-TASK QA harness (LLM reader, gated).
 *
 * Registered ONLY when QA_BENCH=1, so a plain `npm test` never loads the embedder, the
 * LoCoMo corpus, or the local LLM. For each retrieval arm we retrieve top-K=8 memories per
 * LoCoMo question, feed them as context to a local Ollama model, read back a short answer,
 * and score it (token-F1 + normalized EM/containment) against the LoCoMo gold answer. The
 * SAME K, prompt template, and (deterministic, stratified) subsample are used across all
 * arms and models — the ONLY variable is which retriever chose the memories.
 *
 *   QA_BENCH=1 QA_MODEL=qwen2.5:7b QA_N=150 \
 *     npx vitest run src/__bench__/retrieval/qa/qaRunner.test.ts
 *
 * THREE retrieval arms (frozen configs from cycles B/E — NOT re-tuned here):
 *   - ID+Rerank   : single-seed activation-walk lit set, cosine-reranked (blend 0.2).
 *   - MultiSeedID : top-k vector-kNN seeded activation walk (k=20), cosine-reranked.
 *   - TunedHybrid : RRF fusion of vector-kNN + ≤h-hop graph (s5 h1 k10 alpha0.5).
 *
 * PLUS a contradiction END-TO-END mode over the cycle-A synthetic planted-contradiction
 * pairs: for each (entity,attribute) with a planted-true and planted-false value from
 * different sources, two contexts are read — (A) ID-ADJUDICATED = only the LIVE value the
 * engine's adjudication keeps (true kept, false demoted); (B) RAW = both planted values
 * including the false one. We score whether the LLM answers the TRUE value. This isolates
 * what the identity/adjudication layer buys the downstream reader.
 *
 * Output: .arbor/sessions/retrieval-quality/experiments/qa-cycle-f/qa_<model>.json
 *   { model, n, perArm:{arm:{f1,em,n}}, perCategory:{arm:{cat:{f1,em,n}}},
 *     contradiction:{adjudicated:{acc,n}, raw:{acc,n}} }
 *
 * Determinism: temperature 0, index-derived subsample. Engine src/ untouched (the QA
 * layer is purely additive, adapter-level over the existing retrievers).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { asStrandId, FactState } from "../../../index.js";
import { buildDataset } from "../dataset.js";
import type { QueryRecord } from "../dataset.js";
import { embedTexts, EMBED_DIM, MODEL_ID } from "../embed.js";
import { buildGraph, vectorTop1 } from "../graph.js";
import type { SharedGraph } from "../graph.js";
import {
  loadLocomo,
  buildLocomoGraph,
  splitLocomo,
  LOCOMO_CATEGORIES,
  type LocomoQuestion,
  type LocomoDataset,
} from "../locomo.js";
import {
  createLocomoIdRetriever,
  createIdRetriever,
  hybridRetrieveFromSeed,
  rerankLit,
  multiSeedRetrieve,
  type HybridConfig,
} from "../retrievers.js";
import { buildQaPrompt } from "./qaPrompt.js";
import { scoreAnswer } from "./qaScore.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "./ollama.js";

const RUN = process.env["QA_BENCH"] === "1";
const QA_N = (() => {
  const v = Number(process.env["QA_N"]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 150;
})();
const TOP_K = 8;
const OUT_DIR =
  "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\qa-cycle-f";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

// Frozen configs (audited; reused, NOT re-tuned) — cycle B (experiments/1.1) + cycle E.
const FROZEN_HYBRID: HybridConfig = { s: 5, h: 1, k: 10, alpha: 0.5 };
const FROZEN_RERANK_BLEND = 0.2;
const FROZEN_MULTISEED_K = 20;

const ARMS = ["ID+Rerank", "MultiSeedID", "TunedHybrid"] as const;
type Arm = (typeof ARMS)[number];

// ---------------------------------------------------------------------------
// dataset fetch (mirrors the cycle-B/E runners)
// ---------------------------------------------------------------------------

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

async function locateLocomoJson(): Promise<string> {
  const envPath = process.env["LOCOMO_JSON"];
  if (envPath && existsSync(envPath)) return envPath;
  const cached = join(tmpdir(), "idb-locomo10.json");
  if (existsSync(cached)) return cached;
  for (const url of LOCOMO_URLS) {
    if (await download(url, cached)) return cached;
  }
  throw new Error("could not obtain locomo10.json (set LOCOMO_JSON to a local copy)");
}

/** SHARED single-seed (cycle B): entity-match (cue proper nouns) ∪ vector top-1. */
function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/**
 * Deterministic, stratified (by category) subsample of size `n`. Per-category quota is
 * proportional to the category's share of the pool; questions are sorted by id and picked
 * at even strides (index-derived — no RNG), so the same n yields the same set every run.
 */
function stratifiedSubsample(qs: readonly LocomoQuestion[], n: number): LocomoQuestion[] {
  const byCat = new Map<string, LocomoQuestion[]>();
  for (const q of qs) {
    const arr = byCat.get(q.category) ?? [];
    arr.push(q);
    byCat.set(q.category, arr);
  }
  const cats = [...byCat.keys()].sort();
  for (const c of cats) {
    byCat.get(c)!.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const total = qs.length;
  const target = Math.min(n, total);
  const alloc = new Map<string, number>();
  let assigned = 0;
  for (const c of cats) {
    const cap = byCat.get(c)!.length;
    const k = Math.min(cap, Math.floor((cap / total) * target));
    alloc.set(c, k);
    assigned += k;
  }
  // Distribute the remainder deterministically in category order (round-robin).
  let rem = target - assigned;
  while (rem > 0) {
    let progressed = false;
    for (const c of cats) {
      if (rem === 0) break;
      if (alloc.get(c)! < byCat.get(c)!.length) {
        alloc.set(c, alloc.get(c)! + 1);
        rem -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const out: LocomoQuestion[] = [];
  for (const c of cats) {
    const arr = byCat.get(c)!;
    const k = alloc.get(c)!;
    if (k <= 0) continue;
    if (k >= arr.length) {
      out.push(...arr);
      continue;
    }
    const stride = arr.length / k;
    for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * stride)]!);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

interface Prepared {
  readonly q: LocomoQuestion;
  readonly convId: string;
  readonly cueVec: Float32Array;
  readonly seed: string[];
}

(RUN ? describe : describe.skip)(
  "END-TASK QA (real LoCoMo) — LLM reader over ID+Rerank / MultiSeedID / TunedHybrid + contradiction E2E",
  () => {
    it(
      "retrieves top-K per arm, reads with a local LLM, scores vs gold, and runs the contradiction E2E",
      async () => {
        // ---- 0) LLM liveness (fail LOUD if blocked) -------------------------
        const model = process.env["QA_MODEL"]?.trim();
        if (!model) throw new Error("QA_MODEL is not set (e.g. QA_MODEL=qwen2.5:7b)");
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${model}`);
        }

        // ---- 1) DATASET + deterministic subsample ---------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        const allQuestions: LocomoQuestion[] = convs.flatMap((c) => c.questions);
        const { test } = splitLocomo(allQuestions, 0.3);
        const subsample = stratifiedSubsample(test, QA_N);
        expect(subsample.length).toBeGreaterThan(0);

        const strata: Record<string, number> = {};
        for (const q of subsample) strata[q.category] = (strata[q.category] ?? 0) + 1;

        // Only embed/build the conversations the subsample actually touches (identical
        // vectors — embeddings are per-text — but far cheaper for small QA_N).
        const neededConvIds = new Set(subsample.map((q) => q.convId));
        const neededConvs = convs.filter((c) => neededConvIds.has(c.convId));

        // ---- 2) EMBED (shared; cached) --------------------------------------
        const turnTexts: string[] = [];
        const turnIds: string[] = [];
        for (const c of neededConvs) for (const t of c.turns) { turnTexts.push(t.text); turnIds.push(t.id); }
        const cueTexts = subsample.map((q) => q.cueText);
        const all = [...turnTexts, ...cueTexts];
        const vectors = await embedTexts(all);

        const vecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => vecByTurn.set(id, vectors[i]!));
        const vecByQuestion = new Map<string, Float32Array>();
        subsample.forEach((q, i) => vecByQuestion.set(q.id, vectors[turnTexts.length + i]!));
        const turnText = new Map<string, string>();
        for (const c of neededConvs) for (const t of c.turns) turnText.set(t.id, t.text);

        // ---- 3) PER-CONVERSATION graph + ID retriever -----------------------
        const graphByConv = new Map<string, SharedGraph>();
        const idByConv = new Map<string, ReturnType<typeof createLocomoIdRetriever>>();
        for (const c of neededConvs) {
          graphByConv.set(c.convId, buildLocomoGraph(c, (id) => vecByTurn.get(id)!));
          idByConv.set(c.convId, createLocomoIdRetriever(c));
        }

        // ---- 4) PREPARE every subsampled question ---------------------------
        const prepared = new Map<string, Prepared>();
        for (const q of subsample) {
          const g = graphByConv.get(q.convId)!;
          const cueVec = vecByQuestion.get(q.id)!;
          prepared.set(q.id, { q, convId: q.convId, cueVec, seed: locomoSeed(g, q, cueVec) });
        }

        // Retrieve top-K memory TEXTS for an arm.
        const memoriesFor = (p: Prepared, arm: Arm): string[] => {
          const g = graphByConv.get(p.convId)!;
          const idr = idByConv.get(p.convId)!;
          let ranked: string[];
          if (arm === "ID+Rerank") {
            const lit = idr.retrieveLit(p.seed);
            ranked = rerankLit(lit, g, p.cueVec, FROZEN_RERANK_BLEND);
          } else if (arm === "MultiSeedID") {
            ranked = multiSeedRetrieve(idr, g, p.cueVec, FROZEN_MULTISEED_K, FROZEN_RERANK_BLEND).ranked;
          } else {
            ranked = hybridRetrieveFromSeed(g, p.seed, p.cueVec, FROZEN_HYBRID);
          }
          return ranked.slice(0, TOP_K).map((id) => turnText.get(id) ?? "").filter((t) => t.length > 0);
        };

        // ---- 5) READ + SCORE each arm ---------------------------------------
        const zero = (): { f1: number; em: number; n: number } => ({ f1: 0, em: 0, n: 0 });
        const perArmSum: Record<Arm, { f1: number; em: number; n: number }> = {
          "ID+Rerank": zero(), MultiSeedID: zero(), TunedHybrid: zero(),
        };
        const perCatSum: Record<Arm, Record<string, { f1: number; em: number; n: number }>> = {
          "ID+Rerank": {}, MultiSeedID: {}, TunedHybrid: {},
        };
        const samples: Array<{ arm: Arm; q: string; gold: string; pred: string; f1: number; em: number }> = [];

        for (const q of subsample) {
          const p = prepared.get(q.id)!;
          for (const arm of ARMS) {
            const memories = memoriesFor(p, arm);
            const prompt = buildQaPrompt(q.cueText, memories);
            const pred = await ollamaGenerate(prompt, { model });
            const sc = scoreAnswer(pred, q.answer);
            const a = perArmSum[arm];
            a.f1 += sc.f1; a.em += sc.em; a.n += 1;
            const cat = (perCatSum[arm][q.category] ??= zero());
            cat.f1 += sc.f1; cat.em += sc.em; cat.n += 1;
            if (samples.length < 6) {
              samples.push({ arm, q: q.cueText, gold: q.answer, pred, f1: sc.f1, em: sc.em });
            }
          }
        }

        const meanArm = (s: { f1: number; em: number; n: number }) => ({
          f1: s.n ? s.f1 / s.n : 0, em: s.n ? s.em / s.n : 0, n: s.n,
        });
        const perArm: Record<string, { f1: number; em: number; n: number }> = {};
        for (const arm of ARMS) perArm[arm] = meanArm(perArmSum[arm]);
        const perCategory: Record<string, Record<string, { f1: number; em: number; n: number }>> = {};
        for (const arm of ARMS) {
          perCategory[arm] = {};
          for (const cat of LOCOMO_CATEGORIES) {
            const s = perCatSum[arm][cat];
            if (s && s.n > 0) perCategory[arm][cat] = meanArm(s);
          }
        }

        // ---- 6) CONTRADICTION END-TO-END (cycle-A synthetic pairs) ----------
        // The engine's adjudication runs in createIdRetriever's constructor (true kept
        // LIVE, false DEMOTED). We read the attribute question with (A) only the LIVE
        // value vs (B) both planted values, and score whether the LLM answers the TRUE
        // value. No embeddings needed (retrieve() is never called) — pass zero vectors.
        const synth = buildDataset();
        const zeros = synth.facts.map(() => new Float32Array(EMBED_DIM));
        const sgraph = buildGraph(synth, zeros);
        const idr = createIdRetriever(sgraph, synth);
        const factText = new Map(synth.facts.map((f) => [f.id, f.text] as const));
        const factVal = new Map(synth.facts.map((f) => [f.id, f.value] as const));
        const conQ = new Map<string, QueryRecord>();
        for (const qr of synth.queries) if (qr.contradiction) conQ.set(qr.contradiction.attribute, qr);

        let adjCorrect = 0;
        let rawCorrect = 0;
        const nCon = synth.contradictions.length;
        for (const pair of synth.contradictions) {
          const qr = conQ.get(pair.attribute)!;
          const trueVal = factVal.get(pair.trueFactId)!;
          // (A) ID-ADJUDICATED: only the LIVE strand(s) the engine kept.
          const liveIds = [pair.trueFactId, pair.falseFactId].filter((id) => {
            const s = idr.store.getStrand(asStrandId(id));
            return s !== null && s.fact_state === FactState.LIVE;
          }).sort();
          const ctxAdj = liveIds.map((id) => factText.get(id)!);
          // (B) RAW: both planted values (incl. the false one), deterministic order.
          const ctxRaw = [pair.trueFactId, pair.falseFactId].slice().sort().map((id) => factText.get(id)!);
          const ansAdj = await ollamaGenerate(buildQaPrompt(qr.cueText, ctxAdj), { model });
          const ansRaw = await ollamaGenerate(buildQaPrompt(qr.cueText, ctxRaw), { model });
          if (scoreAnswer(ansAdj, trueVal).contains === 1) adjCorrect += 1;
          if (scoreAnswer(ansRaw, trueVal).contains === 1) rawCorrect += 1;
        }
        const contradiction = {
          adjudicated: { acc: nCon ? adjCorrect / nCon : 0, n: nCon },
          raw: { acc: nCon ? rawCorrect / nCon : 0, n: nCon },
        };

        // ---- 7) WRITE OUTPUT ------------------------------------------------
        const out = {
          model,
          n: subsample.length,
          perArm,
          perCategory,
          contradiction,
          meta: {
            cycle: "F (end-task QA: local-LLM reader over the frozen retrieval arms + contradiction E2E)",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            llmHost: ollamaHost(),
            topK: TOP_K,
            requestedN: QA_N,
            strata,
            promptTemplate: "fixed grounded-QA (system + numbered memories + question), identical across arms/models",
            scoring: "token-F1 + normalized EM/containment (lowercase, strip punctuation/articles)",
            frozenConfigs: {
              hybrid: FROZEN_HYBRID,
              rerankBlend: FROZEN_RERANK_BLEND,
              multiSeedK: FROZEN_MULTISEED_K,
            },
            contradiction: {
              source: "cycle-A synthetic planted-contradiction pairs (dataset.ts)",
              metric: "fraction where the reader answer contains the planted-TRUE value",
              adjudicatedContext: "only the LIVE value after engine.adjudicate (true kept, false demoted)",
              rawContext: "both planted values including the false one",
            },
            samples,
          },
        };

        mkdirSync(OUT_DIR, { recursive: true });
        const sanitized = model.replace(/[^A-Za-z0-9._-]+/g, "_");
        const outPath = join(OUT_DIR, `qa_${sanitized}.json`);
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        // ---- 8) sanity guards (non-degenerate) ------------------------------
        for (const arm of ARMS) {
          expect(perArm[arm]!.n).toBe(subsample.length);
        }
        expect(contradiction.adjudicated.n).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(`[qa-cycle-f] wrote ${outPath} (n=${subsample.length}, model=${model})`);
      },
      3_600_000,
    );
  },
);
