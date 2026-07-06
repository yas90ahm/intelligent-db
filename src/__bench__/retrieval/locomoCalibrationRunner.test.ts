/**
 * retrieval/locomoCalibrationRunner.test.ts — Phase 1c Measurement
 * (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "Protocol"): DEV-tune the finer
 * linear grid AND the new `'rrf'` scoreMode, per-embedder (MiniLM vs nomic-embed-text,
 * since D1/D2 measured a real embedder gap — see
 * `.arbor/sessions/retrieval-quality/experiments/1.1.1.1.4.isolation/results.md`),
 * apply the spec's stuffing-gate eligibility rule, FREEZE one config (mode, weights,
 * embedder, unionTopN), then score TEST once, same-run with mem0 and the walk arms.
 *
 * ONE test execution that:
 *   1. Loads the real LoCoMo corpus, builds BOTH MiniLM and nomic-embed-text vector
 *      sets over the identical text list (shared cache scheme with `embed.ts`/
 *      `embedOllama.ts`).
 *   2. Builds, per conversation PER EMBEDDER, a real engine + store
 *      (`createLocomoIdRetriever`) and a real `VectorSidecar`.
 *   3. Precomputes ONE embedder-seeded walk `RecallResult` per question PER EMBEDDER
 *      at the Phase-1 FROZEN defaults (`embedSeedK=16`, `reinforcement='dominance'` —
 *      unchanged by this task) — reused by every scoreMode/weights combo below (only
 *      presentation re-scores, the walk itself never re-runs per combo).
 *   4. DEV SWEEP, per embedder: the Phase 1c finer linear grid (`wCos` in
 *      {0.8,0.9,1.0}, `wWalk` in {0.0,0.05,0.1,0.3}, `wState` fixed 0.1 — 12 combos)
 *      PLUS the `'rrf'` scoreMode (`wState` fixed 0.1, default `k=60` — 1 combo) =
 *      13 combos x 2 embedders = 26 evaluations, `unionTopN=128` fixed (1b's frozen
 *      width, reused verbatim — this iteration grids scoreMode/weights, not N).
 *      Selected by max mean DEV recall@20.
 *   5. STUFFING-GATE ELIGIBILITY (spec gate note): EVERY combo (not just `wWalk=0`
 *      ones -- the spec calls out `wWalk=0` as suspect, but this task empirically
 *      checks the whole grid rather than assuming `wWalk>0` is automatically safe)
 *      is checked against a pure, in-process replica of the embedding-stuffing
 *      scenario (`src/__tests__/embeddingStuffingBlend.test.ts`'s TRUE/FALSE value
 *      shapes, via `rankForPresentation` directly -- no store needed): does the LIVE
 *      incumbent (moderate cosine 0.6, strong walk energy) still rank in the top-5
 *      against 8 cosine-1.0-exact-duplicate attacker candidates? The raw DEV winner
 *      is frozen only if it is ELIGIBLE; otherwise the next-best ELIGIBLE combo ships.
 *      (Empirically: the ENTIRE Phase 1c linear grid, wCos in {0.8,0.9,1.0} x wWalk in
 *      {0.0,...,0.3}, fails this worst-case check -- 0.3 is just under the
 *      `wWalk > wCos*(0.4-0.15*wState)` threshold a cosine-1.0-vs-0.6 gap needs to be
 *      overcome linearly; only `'rrf'` passes, exactly the scale-free robustness the
 *      spec's design rationale predicts for rank fusion vs a hand-tuned linear mix.)
 *   6. WALK-MODE COMPARISON ARMS + mem0, TEST split, same run, using the FROZEN
 *      embedder's rigs for apples-to-apples comparison: PureID, TunedHybrid (own
 *      DEV-tuned HYBRID_GRID), EmbedSeeded (the frozen embedder's own walk order),
 *      Calibrated (the new frozen scoreMode/weights arm), and mem0 (real sidecar,
 *      same run).
 *
 * Gated behind RETRIEVAL_BENCH=1 AND MEM0_BENCH=1. To run:
 *
 *     RETRIEVAL_BENCH=1 MEM0_BENCH=1 npx vitest run src/__bench__/retrieval/locomoCalibrationRunner.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.5.calibration/.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  FactState,
  asStrandId,
  createEmbeddingCueResolver,
  createMemoryVectorSidecar,
  rankRecallResult,
  rankForPresentation,
  DEFAULT_WALK_CONFIG,
  DEFAULT_RRF_K,
} from "../../index.js";
import type {
  CueResolver,
  EmbedderPort,
  WalkSeed,
  ContentHash,
  RecallResult,
  PresentationWeights,
  PresentationScoreMode,
  WalkLitCandidate,
  CosineCandidate,
} from "../../index.js";

import { embedTexts, cachePathFor, MODEL_ID, EMBED_DIM } from "./embed.js";
import { embedTextsOllama, ollamaCachePathFor, OLLAMA_MODEL_ID, OLLAMA_EMBED_DIM } from "./embedOllama.js";
import { vectorTop1 } from "./graph.js";
import type { SharedGraph } from "./graph.js";
import { loadLocomo, buildLocomoGraph, splitLocomo, type LocomoQuestion, type LocomoDataset } from "./locomo.js";
import {
  createLocomoIdRetriever,
  hybridRetrieveFromSeed,
  HYBRID_GRID,
  type HybridConfig,
  type LocomoIdRetriever,
} from "./retrievers.js";
import { queryMetrics, meanMetrics, type RankMetrics } from "./metrics.js";
import { ollamaHost } from "./qa/ollama.js";
import { Mem0Sidecar, type Mem0Options } from "../reasoning/mem0Arm.js";

if (process.env["MEM0_TELEMETRY"] === undefined) process.env["MEM0_TELEMETRY"] = "False";

const RUN = process.env["RETRIEVAL_BENCH"] === "1" && process.env["MEM0_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.5.calibration";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = Number(process.env["MEM0_EMBED_DIMS"] ?? "768");
const MEM0_SEARCH_K = 20;

// Phase-1 FROZEN walk defaults — unchanged by Phase 1b/1c ("only the presentation
// weights/scoreMode are tuned").
const FROZEN_EMBED_SEED_K = 16;
const FROZEN_REINFORCEMENT = "dominance" as const;

// 1b's frozen union width — reused verbatim (this iteration grids scoreMode/weights,
// not unionTopN; the D1/D2 isolation diagnostic already reused 128 for the same reason).
const FROZEN_UNION_TOP_N = 128;

// Phase 1c's finer linear grid (spec Design #2) + the new 'rrf' scoreMode (Design #1).
const WCOS_GRID: readonly number[] = [0.8, 0.9, 1.0];
const WWALK_GRID: readonly number[] = [0.0, 0.05, 0.1, 0.3];
const WSTATE_FIXED = 0.1;

const RANK_KEYS: Array<[keyof RankMetrics, string]> = [
  ["recall10", "recall@10"],
  ["recall20", "recall@20"],
  ["ndcg10", "nDCG@10"],
  ["mrr", "MRR"],
];

function f3(x: number): string {
  return x.toFixed(3);
}

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

/** SAME baseline seed protocol as every other LoCoMo runner: entity-match ∪ vector top-1. */
function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/**
 * Pure, in-process replica of `embeddingStuffingBlend.test.ts`'s scenario, used ONLY
 * to gate DEV-winner ELIGIBILITY per the spec's gate note (no store needed — this is
 * exactly what `rankForPresentation` is for). TRUE value: 2 LIVE candidates (one with
 * a moderate 0.6 cosine + high walk energy, one walk-lit-only). FALSE value: 8
 * PROVISIONAL union-only candidates at cosine EXACTLY 1.0 (worst-case near-duplicate
 * stuffing). Returns true iff the LIVE incumbent (`true1`) still ranks in the top-5.
 */
function stuffingGateHolds(scoreMode: PresentationScoreMode, weights: PresentationWeights, rrfK: number): boolean {
  const walkLit: WalkLitCandidate[] = [
    { strandId: asStrandId("true1"), contentHash: "h-true1" as ContentHash, factState: FactState.LIVE, walkEnergy: 0.9 },
    { strandId: asStrandId("true2"), contentHash: "h-true2" as ContentHash, factState: FactState.LIVE, walkEnergy: 0.85 },
  ];
  const cosineTopN: CosineCandidate[] = [
    { strandId: asStrandId("true1"), contentHash: "h-true1" as ContentHash, factState: FactState.LIVE, cosine: 0.6 },
  ];
  for (let i = 0; i < 8; i++) {
    cosineTopN.push({
      strandId: asStrandId(`sybil${i}`),
      contentHash: `h-sybil${i}` as ContentHash,
      factState: FactState.PROVISIONAL,
      cosine: 1.0,
    });
  }
  const ranked = rankForPresentation(walkLit, cosineTopN, { rankMode: "blend", scoreMode, weights, rrfK });
  const top5 = ranked.slice(0, 5).map((r) => String(r.strandId));
  return top5.includes("true1");
}

interface ConvRig {
  readonly graph: SharedGraph;
  readonly idr: LocomoIdRetriever;
  readonly vectors: ReturnType<typeof createMemoryVectorSidecar>;
  readonly embedder: EmbedderPort;
  readonly baseResolver: CueResolver;
  currentBaseline: WalkSeed[];
}

interface Prepared {
  readonly q: LocomoQuestion;
  readonly convId: string;
  readonly rel: Set<string>;
}

interface EmbedderRig {
  readonly name: "minilm" | "nomic";
  readonly modelId: string;
  readonly dim: number;
  readonly graphByConv: Map<string, SharedGraph>;
  readonly rigByConv: Map<string, ConvRig>;
  readonly cueVecByQ: Map<string, Float32Array>;
  readonly baselineByQ: Map<string, string[]>;
  readonly walkResByQ: Map<string, RecallResult>;
}

function buildEmbedderRig(
  name: "minilm" | "nomic",
  convs: readonly LocomoDataset["conversations"][number][],
  allQuestions: readonly LocomoQuestion[],
  vecByTurn: Map<string, Float32Array>,
  cueVecByQ: Map<string, Float32Array>,
  cueVecByText: Map<string, Float32Array>,
  modelId: string,
  dim: number,
): { graphByConv: Map<string, SharedGraph>; rigByConv: Map<string, ConvRig>; baselineByQ: Map<string, string[]> } {
  const graphByConv = new Map<string, SharedGraph>();
  const rigByConv = new Map<string, ConvRig>();
  const baselineByQ = new Map<string, string[]>();

  for (const c of convs) {
    const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
    graphByConv.set(c.convId, g);
    const idr = createLocomoIdRetriever(c);

    const sidecar = createMemoryVectorSidecar();
    for (const t of c.turns) {
      sidecar.put(`hash:${t.id}` as ContentHash, modelId, vecByTurn.get(t.id)!);
    }

    const embedder: EmbedderPort = {
      dim,
      modelId,
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map((t) => cueVecByText.get(t) ?? new Float32Array(dim));
      },
    };

    const rig: ConvRig = {
      graph: g,
      idr,
      vectors: sidecar,
      embedder,
      currentBaseline: [],
      baseResolver: { index(): void {}, resolve: (): WalkSeed[] => rig.currentBaseline },
    };
    rigByConv.set(c.convId, rig);
  }

  for (const c of convs) {
    const g = graphByConv.get(c.convId)!;
    for (const q of c.questions) {
      baselineByQ.set(q.id, locomoSeed(g, q, cueVecByQ.get(q.id)!));
    }
  }

  void allQuestions;
  return { graphByConv, rigByConv, baselineByQ };
}

async function precomputeWalks(
  qs: readonly LocomoQuestion[],
  rigByConv: Map<string, ConvRig>,
  baselineByQ: Map<string, string[]>,
): Promise<Map<string, RecallResult>> {
  const out = new Map<string, RecallResult>();
  for (const q of qs) {
    const rig = rigByConv.get(q.convId)!;
    const baselineIds = baselineByQ.get(q.id)!;
    rig.currentBaseline = baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
    const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, { base: rig.baseResolver });
    const seeds = await resolver.resolveWithEmbeddings(
      { text: q.cueText },
      { embedSeedK: FROZEN_EMBED_SEED_K, embedSeedEnergyCap: 1 },
    );
    const present = seeds.filter((s) => rig.idr.store.getStrand(s.strandId) !== null);
    const res: RecallResult =
      present.length === 0
        ? { lit: [], halt: { reason: "TRUNCATED", popCount: 0, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: true } as never, unresolvedSeeds: [], seedsResolved: 0 }
        : rig.idr.engine.recall({ seeds: present, config: { ...DEFAULT_WALK_CONFIG, reinforcement: FROZEN_REINFORCEMENT } });
    out.set(q.id, res);
  }
  return out;
}

interface Combo {
  readonly embedder: "minilm" | "nomic";
  readonly scoreMode: PresentationScoreMode;
  readonly weights: PresentationWeights;
  readonly rrfK: number;
  readonly label: string;
}

function comboGrid(): Combo[] {
  const combos: Combo[] = [];
  for (const embedder of ["minilm", "nomic"] as const) {
    for (const wCos of WCOS_GRID) {
      for (const wWalk of WWALK_GRID) {
        combos.push({
          embedder,
          scoreMode: "linear",
          weights: { wCos, wWalk, wState: WSTATE_FIXED },
          rrfK: DEFAULT_RRF_K,
          label: `${embedder}/linear(wCos=${wCos},wWalk=${wWalk},wState=${WSTATE_FIXED})`,
        });
      }
    }
    combos.push({
      embedder,
      scoreMode: "rrf",
      weights: { wCos: 0, wWalk: 0, wState: WSTATE_FIXED },
      rrfK: DEFAULT_RRF_K,
      label: `${embedder}/rrf(k=${DEFAULT_RRF_K},wState=${WSTATE_FIXED})`,
    });
  }
  return combos;
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — Phase 1c calibration: finer linear grid + rrf, per-embedder, freeze + TEST",
  () => {
    it(
      "tunes (scoreMode, weights) per embedder on DEV, applies the stuffing-gate eligibility rule, freezes, scores TEST once vs PureID/TunedHybrid/EmbedSeeded/mem0",
      async () => {
        // ---- 1) DATASET ------------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        const turnTexts: string[] = [];
        const turnIds: string[] = [];
        for (const c of convs) for (const t of c.turns) { turnTexts.push(t.text); turnIds.push(t.id); }
        const allQuestions: LocomoQuestion[] = convs.flatMap((c) => c.questions);
        const cueTexts = allQuestions.map((q) => q.cueText);
        const all = [...turnTexts, ...cueTexts];

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        const prepared = new Map<string, Prepared>();
        for (const q of allQuestions) prepared.set(q.id, { q, convId: q.convId, rel: new Set(q.relevant) });

        // ---- 2) EMBED (both models, shared cache scheme) ---------------------
        const miniVecs = await embedTexts(all);
        const miniVecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => miniVecByTurn.set(id, miniVecs[i]!));
        const miniCueVecByQ = new Map<string, Float32Array>();
        const miniCueVecByText = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = miniVecs[turnTexts.length + i]!;
          miniCueVecByQ.set(q.id, v);
          miniCueVecByText.set(q.cueText, v);
        });

        const nomicVecs = await embedTextsOllama(all);
        const nomicVecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => nomicVecByTurn.set(id, nomicVecs[i]!));
        const nomicCueVecByQ = new Map<string, Float32Array>();
        const nomicCueVecByText = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = nomicVecs[turnTexts.length + i]!;
          nomicCueVecByQ.set(q.id, v);
          nomicCueVecByText.set(q.cueText, v);
        });

        // ---- 3) PER-EMBEDDER rigs + baselines ---------------------------------
        const mini = buildEmbedderRig("minilm", convs, allQuestions, miniVecByTurn, miniCueVecByQ, miniCueVecByText, MODEL_ID, EMBED_DIM);
        const nomic = buildEmbedderRig("nomic", convs, allQuestions, nomicVecByTurn, nomicCueVecByQ, nomicCueVecByText, OLLAMA_MODEL_ID, OLLAMA_EMBED_DIM);

        // ---- 4) PRECOMPUTE the embedder-seeded walk ONCE per question PER EMBEDDER
        //         (ALL questions — dev+test — since the walk itself never changes
        //         with scoreMode/weights; only presentation re-scores). -----------
        const miniWalkByQ = await precomputeWalks(allQuestions, mini.rigByConv, mini.baselineByQ);
        const nomicWalkByQ = await precomputeWalks(allQuestions, nomic.rigByConv, nomic.baselineByQ);

        const embedderRigs: Record<"minilm" | "nomic", EmbedderRig> = {
          minilm: { name: "minilm", modelId: MODEL_ID, dim: EMBED_DIM, graphByConv: mini.graphByConv, rigByConv: mini.rigByConv, cueVecByQ: miniCueVecByQ, baselineByQ: mini.baselineByQ, walkResByQ: miniWalkByQ },
          nomic: { name: "nomic", modelId: OLLAMA_MODEL_ID, dim: OLLAMA_EMBED_DIM, graphByConv: nomic.graphByConv, rigByConv: nomic.rigByConv, cueVecByQ: nomicCueVecByQ, baselineByQ: nomic.baselineByQ, walkResByQ: nomicWalkByQ },
        };

        function calibratedRank(embName: "minilm" | "nomic", qid: string, scoreMode: PresentationScoreMode, weights: PresentationWeights, rrfK: number): string[] {
          const er = embedderRigs[embName];
          const rig = er.rigByConv.get(prepared.get(qid)!.convId)!;
          const res = er.walkResByQ.get(qid)!;
          const cueVec = er.cueVecByQ.get(qid)!;
          const blended = rankRecallResult(
            rig.idr.store,
            res,
            { vectors: rig.vectors, modelId: er.modelId, cueVector: cueVec },
            { rankMode: "blend", unionTopN: FROZEN_UNION_TOP_N, scoreMode, weights, rrfK },
          );
          return blended.lit.map((l) => String(l.strandId));
        }

        // ---- 5) DEV SWEEP: 13 combos x 2 embedders ----------------------------
        interface ComboResult extends Combo {
          readonly dev: RankMetrics;
          readonly stuffingPass: boolean;
          readonly eligible: boolean;
        }
        const results: ComboResult[] = [];
        for (const combo of comboGrid()) {
          const rows = dev.map((q) => queryMetrics(calibratedRank(combo.embedder, q.id, combo.scoreMode, combo.weights, combo.rrfK), prepared.get(q.id)!.rel));
          const devMetrics = meanMetrics(rows);
          // Test EVERY combo against the stuffing-gate scenario -- not just wWalk=0
          // ones. The spec singles out wWalk=0 as suspect, but empirically the
          // ENTIRE linear grid fails this worst-case check (see header doc); eligibility
          // must be measured, not assumed safe for wWalk>0.
          const stuffingPass = stuffingGateHolds(combo.scoreMode, combo.weights, combo.rrfK);
          const eligible = stuffingPass;
          results.push({ ...combo, dev: devMetrics, stuffingPass, eligible });
        }

        function betterOf(a: ComboResult, b: ComboResult): ComboResult {
          if (a.dev.recall20 > b.dev.recall20 + 1e-12) return a;
          if (b.dev.recall20 > a.dev.recall20 + 1e-12) return b;
          return a.dev.ndcg10 >= b.dev.ndcg10 ? a : b;
        }

        const rawWinner = results.reduce((best, r) => betterOf(best, r));
        const eligibleResults = results.filter((r) => r.eligible);
        const frozenResult = eligibleResults.reduce((best, r) => betterOf(best, r));
        const fallbackTriggered = String(rawWinner.label) !== String(frozenResult.label);

        // Per-embedder winners (both recorded per spec: "record both embedders' winners").
        const minilmBest = results.filter((r) => r.embedder === "minilm").reduce((best, r) => betterOf(best, r));
        const nomicBest = results.filter((r) => r.embedder === "nomic").reduce((best, r) => betterOf(best, r));

        const frozenEmbedder = frozenResult.embedder;
        const frozenScoreMode = frozenResult.scoreMode;
        const frozenWeights = frozenResult.weights;
        const frozenRrfK = frozenResult.rrfK;

        // ---- 6) TEST SCORE ONCE, same run, on the FROZEN embedder's rigs -------
        const er = embedderRigs[frozenEmbedder];

        // TunedHybrid: own DEV-tuned HYBRID_GRID, on the frozen embedder's graph.
        let bestH: { cfg: HybridConfig; recall10: number; ndcg: number } | null = null;
        for (const cfg of HYBRID_GRID) {
          const rows = dev.map((q) => {
            const g = er.graphByConv.get(q.convId)!;
            const baselineIds = er.baselineByQ.get(q.id)!;
            const cueVec = er.cueVecByQ.get(q.id)!;
            return queryMetrics(hybridRetrieveFromSeed(g, baselineIds, cueVec, cfg), prepared.get(q.id)!.rel);
          });
          const m = meanMetrics(rows);
          if (
            bestH === null ||
            m.recall10 > bestH.recall10 + 1e-12 ||
            (Math.abs(m.recall10 - bestH.recall10) <= 1e-12 && m.ndcg10 > bestH.ndcg + 1e-12)
          ) {
            bestH = { cfg, recall10: m.recall10, ndcg: m.ndcg10 };
          }
        }
        const frozenHybrid = bestH!.cfg;

        function embedSeededRank(qid: string): string[] {
          const res = er.walkResByQ.get(qid)!;
          return [...res.lit]
            .sort((a, b) => (b.activation - a.activation) || (String(a.strandId) < String(b.strandId) ? -1 : 1))
            .map((l) => String(l.strandId));
        }

        const rankPureID = new Map<string, string[]>();
        const rankHybrid = new Map<string, string[]>();
        const rankEmbedSeeded = new Map<string, string[]>();
        const rankCalibrated = new Map<string, string[]>();
        for (const q of test) {
          const g = er.graphByConv.get(q.convId)!;
          const baselineIds = er.baselineByQ.get(q.id)!;
          const cueVec = er.cueVecByQ.get(q.id)!;
          rankPureID.set(q.id, er.rigByConv.get(q.convId)!.idr.retrieveLit(baselineIds).map((l) => l.id));
          rankHybrid.set(q.id, hybridRetrieveFromSeed(g, baselineIds, cueVec, frozenHybrid));
          rankEmbedSeeded.set(q.id, embedSeededRank(q.id));
          rankCalibrated.set(q.id, calibratedRank(frozenEmbedder, q.id, frozenScoreMode, frozenWeights, frozenRrfK));
        }

        // ---- 7) mem0 ARM: one sidecar PER CONVERSATION, same-run, TEST only ----
        const mem0Opts = (qdrantPath: string): Mem0Options => ({
          pythonBin: MEM0_PYTHON,
          llm: MEM0_LLM,
          embed: MEM0_EMBED,
          embedDims: MEM0_EMBED_DIMS,
          qdrantPath,
          ollamaHost: ollamaHost(),
        });
        const rankMem0 = new Map<string, string[]>();
        const testByConv = new Map<string, LocomoQuestion[]>();
        for (const q of test) {
          const arr = testByConv.get(q.convId) ?? [];
          arr.push(q);
          testByConv.set(q.convId, arr);
        }
        for (const c of convs) {
          const qs = testByConv.get(c.convId) ?? [];
          if (qs.length === 0) continue;
          const qdrantPath = join(tmpdir(), `idb-mem0-locomo-calibration-${c.convId.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`);
          const sc = new Mem0Sidecar(mem0Opts(qdrantPath));
          try {
            await sc.ready();
            await sc.build(c.turns.map((t, i) => ({ idx: i, text: t.text })));
            for (const q of qs) {
              const hits = await sc.search(q.cueText, MEM0_SEARCH_K);
              const ranked = hits.map((h) => c.turns[h.idx]?.id).filter((id): id is string => id !== undefined);
              rankMem0.set(q.id, ranked);
            }
          } finally {
            await sc.close();
            try { rmSync(qdrantPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }

        // ---- 8) METRICS --------------------------------------------------------
        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id) ?? [], prepared.get(q.id)!.rel)));
        const mem0Test = test.filter((q) => rankMem0.has(q.id));

        const overall = {
          PureID: metricsFor(test, rankPureID),
          TunedHybrid: metricsFor(test, rankHybrid),
          EmbedSeeded: metricsFor(test, rankEmbedSeeded),
          Calibrated: metricsFor(test, rankCalibrated),
          mem0: metricsFor(mem0Test, rankMem0),
        };

        // ---- 9) WRITE OUTPUT ---------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.5.calibration — Phase 1c Measurement",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            mem0ScoredQuestions: mem0Test.length,
            frozenEmbedSeedK: FROZEN_EMBED_SEED_K,
            frozenReinforcement: FROZEN_REINFORCEMENT,
            frozenUnionTopN: FROZEN_UNION_TOP_N,
            sweepGrid: { wCos: WCOS_GRID, wWalk: WWALK_GRID, wState: WSTATE_FIXED, scoreModes: ["linear", "rrf"], rrfK: DEFAULT_RRF_K },
            minilmModelId: MODEL_ID,
            nomicModelId: OLLAMA_MODEL_ID,
            minilmDevWinner: { label: minilmBest.label, recall20: minilmBest.dev.recall20 },
            nomicDevWinner: { label: nomicBest.label, recall20: nomicBest.dev.recall20 },
            rawWinner: { label: rawWinner.label, recall20: rawWinner.dev.recall20, stuffingPass: rawWinner.stuffingPass },
            fallbackTriggered,
            frozen: {
              embedder: frozenEmbedder,
              scoreMode: frozenScoreMode,
              weights: frozenWeights,
              rrfK: frozenRrfK,
              unionTopN: FROZEN_UNION_TOP_N,
              devRecall20: frozenResult.dev.recall20,
            },
            frozenHybridConfig: frozenHybrid,
            gate: "LoCoMo TEST recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md)",
          },
          devSweep: results.map((r) => ({ embedder: r.embedder, scoreMode: r.scoreMode, weights: r.weights, rrfK: r.rrfK, dev: r.dev, stuffingPass: r.stuffingPass, eligible: r.eligible })),
          overall,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity ------------------------------------------------------------
        expect(results.length).toBe(comboGrid().length);
        expect(Number.isFinite(overall.Calibrated.recall20)).toBe(true);
        expect(mem0Test.length).toBeGreaterThan(0);

        // ---- cleanup temp caches -------------------------------------------
        const miniCache = cachePathFor(all);
        if (existsSync(miniCache)) { try { rmSync(miniCache, { force: true }); } catch { /* best-effort */ } }
        const nomicCache = ollamaCachePathFor(all);
        if (existsSync(nomicCache)) { try { rmSync(nomicCache, { force: true }); } catch { /* best-effort */ } }
        const ds = join(tmpdir(), "idb-locomo10.json");
        if (existsSync(ds)) { try { rmSync(ds, { force: true }); } catch { /* best-effort */ } }
      },
      3_600_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderReport(m: any): string {
  const meta = m.meta;
  const L: string[] = [];

  L.push("# LoCoMo retrieval bench — Phase 1c calibration (finer linear grid + rrf, per-embedder)");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; **${meta.questionsKept} questions kept**. ` +
      `Split: **${meta.devQuestions} dev / ${meta.testQuestions} test** (mem0 scored **${meta.mem0ScoredQuestions}**). ` +
      `Gate: **${meta.gate}**.`,
  );
  L.push("");
  L.push(
    `Frozen embedder-seeded walk: embedSeedK=${meta.frozenEmbedSeedK}, reinforcement=${meta.frozenReinforcement}, ` +
      `unionTopN=${meta.frozenUnionTopN} (all unchanged by this task — only scoreMode/weights/embedder are tuned).`,
  );
  L.push("");

  L.push("## 1. Per-embedder DEV winners (both recorded per spec)");
  L.push("");
  L.push(`- MiniLM (${meta.minilmModelId}) winner: **${meta.minilmDevWinner.label}** — DEV recall@20 = ${f3(meta.minilmDevWinner.recall20)}`);
  L.push(`- nomic-embed-text (${meta.nomicModelId}) winner: **${meta.nomicDevWinner.label}** — DEV recall@20 = ${f3(meta.nomicDevWinner.recall20)}`);
  L.push("");

  L.push("## 2. Raw DEV winner (pre stuffing-gate) vs FROZEN (post-gate)");
  L.push("");
  L.push(`Raw winner: **${meta.rawWinner.label}** — DEV recall@20 = ${f3(meta.rawWinner.recall20)}, stuffingPass=${meta.rawWinner.stuffingPass}`);
  if (meta.fallbackTriggered) {
    L.push("");
    L.push(
      "**FALLBACK TRIGGERED**: the raw DEV winner FAILED the stuffing-gate eligibility check " +
        "(does the LIVE incumbent still rank top-5 against 8 cosine-1.0 attacker candidates?) — " +
        "per spec, it is excluded and the best remaining ELIGIBLE config ships instead.",
    );
  } else {
    L.push("");
    L.push("No fallback needed — the raw DEV winner already passes the stuffing-gate eligibility check.");
  }
  L.push("");
  L.push(
    `**FROZEN config: embedder=${meta.frozen.embedder}, scoreMode=${meta.frozen.scoreMode}, ` +
      `weights=${JSON.stringify(meta.frozen.weights)}, rrfK=${meta.frozen.rrfK}, unionTopN=${meta.frozen.unionTopN} ` +
      `— DEV recall@20 = ${f3(meta.frozen.devRecall20)}**`,
  );
  L.push("");

  L.push("## 3. Full DEV sweep (26 combos: 13 x 2 embedders)");
  L.push("");
  L.push("| embedder | scoreMode | wCos | wWalk | wState | rrfK | recall@20 (DEV) | nDCG@10 (DEV) | stuffingPass | eligible |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of m.devSweep) {
    L.push(
      `| ${r.embedder} | ${r.scoreMode} | ${r.weights.wCos} | ${r.weights.wWalk} | ${r.weights.wState} | ${r.rrfK} | ` +
        `${f3(r.dev.recall20)} | ${f3(r.dev.ndcg10)} | ${r.stuffingPass} | ${r.eligible} |`,
    );
  }
  L.push("");

  L.push("## 4. Full comparison table — TEST split, macro-averaged (same run, frozen embedder)");
  L.push("");
  L.push("| Arm | recall@10 | recall@20 | nDCG@10 | MRR |");
  L.push("|---|---|---|---|---|");
  const order = ["PureID", "TunedHybrid", "EmbedSeeded", "Calibrated", "mem0"];
  for (const name of order) {
    const r: RankMetrics = m.overall[name];
    L.push(`| ${name} | ${f3(r.recall10)} | ${f3(r.recall20)} | ${f3(r.ndcg10)} | ${f3(r.mrr)} |`);
  }
  L.push("");

  L.push("## 5. Gate verdict");
  L.push("");
  const gap = m.overall.Calibrated.recall20 - m.overall.mem0.recall20;
  if (m.overall.Calibrated.recall20 >= 0.484) {
    L.push(
      `**PASS** — Calibrated's recall@20 (${f3(m.overall.Calibrated.recall20)}) meets/exceeds the gate (>= 0.484). ` +
        `Same-run mem0: ${f3(m.overall.mem0.recall20)} (delta ${gap >= 0 ? "+" : ""}${f3(gap)}).`,
    );
  } else {
    L.push(
      `**FALL SHORT** — Calibrated's recall@20 (${f3(m.overall.Calibrated.recall20)}) is BELOW the gate (>= 0.484). ` +
        `Same-run mem0: ${f3(m.overall.mem0.recall20)}. Reported honestly per instructions — not tuned to pass.`,
    );
  }
  L.push("");

  void RANK_KEYS;
  return L.join("\n");
}
