/**
 * retrieval/locomoBlendRunner.test.ts — Phase 1b Measurement (docs/specs/PHASE1B_RANKING_SPEC.md
 * §"Measurement"): "LoCoMo same-run (RETRIEVAL_BENCH + MEM0_BENCH): report walk-mode arms, the
 * new `Blend` arm, and mem0 across recall@10/@20, nDCG@10, MRR — DEV for tuning, TEST once, no
 * post-TEST tuning."
 *
 * ONE test execution that:
 *   1. Loads the real LoCoMo corpus + shared MiniLM embeddings (identical to the other
 *      retrieval runners).
 *   2. Builds, per conversation, a REAL engine + store (`createLocomoIdRetriever`) and a
 *      real `VectorSidecar` populated from the same embeddings — the exact Phase-1
 *      production substrate.
 *   3. For every question, seeds `engine.recall()` via `createEmbeddingCueResolver`'s
 *      cosine-union seeding (spec §3's seed seam) at the Phase-1 FROZEN defaults
 *      (`embedSeedK=16`, `WalkConfig.reinforcement='dominance'` — see CLAUDE.md's Phase-1
 *      retrieval-quality note; NOT re-tuned here, only the Phase-1b presentation weights
 *      are). This produces ONE walk-mode `RecallResult` per question, reused by every arm
 *      below that needs it.
 *   4. THE BLEND ARM (spec §1-4, real code, `recall/presentationRank.ts`): re-ranks that
 *      SAME `RecallResult` via `rankRecallResult(..., { rankMode: 'blend' })`, sweeping
 *      `(wCos, wWalk, unionTopN)` on the DEV split per the spec's grid (`wCos` in
 *      {0.5,0.7,0.9}, `wWalk` in {0.1,0.3,0.5}, `wState` fixed 0.1 — extended here with an
 *      `unionTopN` sweep in {32,64,128} since the task explicitly asks to tune N too;
 *      the spec itself only fixes N's *default* at 64, it does not grid it), selecting the
 *      config with max mean recall@20 on DEV (the gate metric), FREEZING before TEST is
 *      touched.
 *   5. WALK-MODE COMPARISON ARMS, same run, same split: PureID (baseline seed only, no
 *      embedder), TunedHybrid (RRF vector+graph fusion, dev-tuned/frozen), EmbedSeeded (the
 *      embedder-seeded walk itself, i.e. the SAME `RecallResult` the Blend arm re-ranks,
 *      reported in its own native walk-activation order — this isolates exactly what
 *      presentation ranking changed).
 *   6. mem0, same run: one `Mem0Sidecar` per conversation (identical protocol to
 *      `locomoMem0Runner.test.ts` — `infer=False` verbatim ingest, `mem.search` per TEST
 *      question), scored only over the TEST questions it actually saw.
 *
 * Gated behind RETRIEVAL_BENCH=1 AND MEM0_BENCH=1 (both — same flag family as
 * `locomoMem0Runner.test.ts`, since this run ALSO drives the mem0 venv). To run:
 *
 *     RETRIEVAL_BENCH=1 MEM0_BENCH=1 npx vitest run src/__bench__/retrieval/locomoBlendRunner.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.3.blend/.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  asStrandId,
  createEmbeddingCueResolver,
  createMemoryVectorSidecar,
  rankRecallResult,
  DEFAULT_WALK_CONFIG,
} from "../../index.js";
import type { CueResolver, EmbedderPort, WalkSeed, ContentHash, RecallResult, PresentationWeights } from "../../index.js";

import { embedTexts, cachePathFor, MODEL_ID, EMBED_DIM } from "./embed.js";
import { vectorTop1 } from "./graph.js";
import type { SharedGraph } from "./graph.js";
import {
  loadLocomo,
  buildLocomoGraph,
  splitLocomo,
  LOCOMO_CATEGORIES,
  type LocomoQuestion,
  type LocomoDataset,
} from "./locomo.js";
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
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.3.blend";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = Number(process.env["MEM0_EMBED_DIMS"] ?? "768");
const MEM0_SEARCH_K = 20;

// Phase-1 FROZEN defaults (docs/specs/PHASE1_RETRIEVAL_SPEC.md measurement gate,
// CLAUDE.md's retrieval-quality note) — NOT re-tuned by this Phase-1b task.
const FROZEN_EMBED_SEED_K = 16;
const FROZEN_REINFORCEMENT = "dominance" as const;

// Phase 1b DEV sweep grid (spec §3): wCos/wWalk per the spec; unionTopN is this task's
// own extension (the spec fixes N's *default* at 64 but doesn't grid it — tuning N was
// explicitly requested).
const WCOS_GRID: readonly number[] = [0.5, 0.7, 0.9];
const WWALK_GRID: readonly number[] = [0.1, 0.3, 0.5];
const WSTATE_FIXED = 0.1;
const UNION_N_GRID: readonly number[] = [32, 64, 128];

// mem0's own already-measured same-run number, retained here ONLY as a labeled
// cross-reference in the report — this run drives a REAL mem0 sidecar itself (below),
// which is the number actually used for the gate comparison table.
const MEM0_PUBLISHED_BASELINE = { recall10: 0.382, recall20: 0.484, ndcg10: 0.242, mrr: 0.215 };

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
  readonly cueVec: Float32Array;
  readonly baselineIds: string[];
  readonly rel: Set<string>;
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — Blend arm (Phase 1b presentation ranking), same-run vs mem0 + walk-mode arms",
  () => {
    it(
      "tunes (wCos, wWalk, unionTopN) on DEV, freezes, scores TEST once vs PureID/TunedHybrid/EmbedSeeded/mem0",
      async () => {
        // ---- 1) DATASET ------------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        // ---- 2) EMBED (shared MiniLM vectors; cached) ------------------------
        const turnTexts: string[] = [];
        const turnIds: string[] = [];
        for (const c of convs) for (const t of c.turns) { turnTexts.push(t.text); turnIds.push(t.id); }
        const allQuestions: LocomoQuestion[] = convs.flatMap((c) => c.questions);
        const cueTexts = allQuestions.map((q) => q.cueText);
        const all = [...turnTexts, ...cueTexts];
        const vectors = await embedTexts(all);

        const vecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => vecByTurn.set(id, vectors[i]!));
        const vecByQuestion = new Map<string, Float32Array>();
        const cueVecByText = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = vectors[turnTexts.length + i]!;
          vecByQuestion.set(q.id, v);
          cueVecByText.set(q.cueText, v);
        });

        // ---- 3) PER-CONVERSATION graph + ID retriever + embedder-seed rig ----
        const graphByConv = new Map<string, SharedGraph>();
        const rigByConv = new Map<string, ConvRig>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          const idr = createLocomoIdRetriever(c);

          const sidecar = createMemoryVectorSidecar();
          for (const t of c.turns) {
            sidecar.put(`hash:${t.id}` as ContentHash, MODEL_ID, vecByTurn.get(t.id)!);
          }

          const embedder: EmbedderPort = {
            dim: EMBED_DIM,
            modelId: MODEL_ID,
            async embed(texts: string[]): Promise<Float32Array[]> {
              return texts.map((t) => cueVecByText.get(t) ?? new Float32Array(EMBED_DIM));
            },
          };

          const rig: ConvRig = {
            graph: g,
            idr,
            vectors: sidecar,
            embedder,
            currentBaseline: [],
            baseResolver: {
              index(): void {},
              resolve(): WalkSeed[] {
                return rig.currentBaseline;
              },
            },
          };
          rigByConv.set(c.convId, rig);
        }

        // ---- 4) PREPARE every question ---------------------------------------
        const prepared = new Map<string, Prepared>();
        for (const c of convs) {
          const g = graphByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            prepared.set(q.id, {
              q,
              convId: c.convId,
              cueVec,
              baselineIds: locomoSeed(g, q, cueVec),
              rel: new Set(q.relevant),
            });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        // ---- 5) TUNE the hybrid fusion params on DEV (same protocol as every
        //         other runner) — TunedHybrid is a same-run WALK-MODE comparison
        //         arm, not touched by the Blend sweep. --------------------------
        let bestH: { cfg: HybridConfig; recall10: number; ndcg: number } | null = null;
        for (const cfg of HYBRID_GRID) {
          const rows = dev.map((q) => {
            const p = prepared.get(q.id)!;
            const g = graphByConv.get(p.convId)!;
            return queryMetrics(hybridRetrieveFromSeed(g, p.baselineIds, p.cueVec, cfg), p.rel);
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

        // ---- 6) THE EMBEDDER-SEEDED WALK — ONE engine.recall() per question at
        //         Phase-1's FROZEN embedSeedK/reinforcement. Every arm below that
        //         needs the walk (EmbedSeeded, Blend) reuses this SAME result. ---
        const resByQ = new Map<string, RecallResult>();
        for (const q of allQuestions) {
          const p = prepared.get(q.id)!;
          const rig = rigByConv.get(p.convId)!;
          rig.currentBaseline = p.baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
          const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, { base: rig.baseResolver });
          const seeds = await resolver.resolveWithEmbeddings(
            { text: p.q.cueText },
            { embedSeedK: FROZEN_EMBED_SEED_K, embedSeedEnergyCap: 1 },
          );
          const present = seeds.filter((s) => rig.idr.store.getStrand(s.strandId) !== null);
          const res: RecallResult =
            present.length === 0
              ? { lit: [], halt: { reason: "TRUNCATED", popCount: 0, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: true } as never, unresolvedSeeds: [], seedsResolved: 0 }
              : rig.idr.engine.recall({ seeds: present, config: { ...DEFAULT_WALK_CONFIG, reinforcement: FROZEN_REINFORCEMENT } });
          resByQ.set(q.id, res);
        }

        // EmbedSeeded arm ranking: the walk's own lit set, activation desc.
        function embedSeededRank(qid: string): string[] {
          const res = resByQ.get(qid)!;
          return [...res.lit]
            .sort((a, b) => (b.activation - a.activation) || (String(a.strandId) < String(b.strandId) ? -1 : 1))
            .map((l) => String(l.strandId));
        }

        // ---- 7) THE BLEND ARM: rankRecallResult over the SAME walk result ------
        function blendRank(qid: string, weights: PresentationWeights, unionTopN: number): string[] {
          const p = prepared.get(qid)!;
          const rig = rigByConv.get(p.convId)!;
          const res = resByQ.get(qid)!;
          const blended = rankRecallResult(
            rig.idr.store,
            res,
            { vectors: rig.vectors, modelId: MODEL_ID, cueVector: p.cueVec },
            { rankMode: "blend", unionTopN, weights },
          );
          return blended.lit.map((l) => String(l.strandId));
        }

        // ---- 8) SWEEP (wCos, wWalk, unionTopN) on DEV, max mean recall@20 -------
        interface BlendConfigResult {
          readonly weights: PresentationWeights;
          readonly unionTopN: number;
          readonly dev: RankMetrics;
        }
        const blendSweep: BlendConfigResult[] = [];
        for (const wCos of WCOS_GRID) {
          for (const wWalk of WWALK_GRID) {
            for (const unionTopN of UNION_N_GRID) {
              const weights: PresentationWeights = { wCos, wWalk, wState: WSTATE_FIXED };
              const rows = dev.map((q) => queryMetrics(blendRank(q.id, weights, unionTopN), prepared.get(q.id)!.rel));
              blendSweep.push({ weights, unionTopN, dev: meanMetrics(rows) });
            }
          }
        }
        let winner = blendSweep[0]!;
        for (const r of blendSweep) {
          if (
            r.dev.recall20 > winner.dev.recall20 + 1e-12 ||
            (Math.abs(r.dev.recall20 - winner.dev.recall20) <= 1e-12 && r.dev.ndcg10 > winner.dev.ndcg10 + 1e-12)
          ) {
            winner = r;
          }
        }
        const frozenWeights = winner.weights;
        const frozenUnionTopN = winner.unionTopN;

        // ---- 9) SCORE TEST ONCE — every same-run arm ----------------------------
        const rankPureID = new Map<string, string[]>();
        const rankHybrid = new Map<string, string[]>();
        const rankEmbedSeeded = new Map<string, string[]>();
        const rankBlend = new Map<string, string[]>();
        for (const q of test) {
          const p = prepared.get(q.id)!;
          const rig = rigByConv.get(p.convId)!;
          rankPureID.set(q.id, rig.idr.retrieveLit(p.baselineIds).map((l) => l.id));
          rankHybrid.set(q.id, hybridRetrieveFromSeed(rig.graph, p.baselineIds, p.cueVec, frozenHybrid));
          rankEmbedSeeded.set(q.id, embedSeededRank(q.id));
          rankBlend.set(q.id, blendRank(q.id, frozenWeights, frozenUnionTopN));
        }

        // ---- 10) mem0 ARM: one sidecar PER CONVERSATION, same-run --------------
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
        let ingestedItems = 0;
        let ingestMs = 0;
        let searchMs = 0;
        for (const c of convs) {
          const qs = testByConv.get(c.convId) ?? [];
          if (qs.length === 0) continue;
          const qdrantPath = join(tmpdir(), `idb-mem0-locomo-blend-${c.convId.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`);
          const sc = new Mem0Sidecar(mem0Opts(qdrantPath));
          try {
            await sc.ready();
            const tb0 = process.hrtime.bigint();
            const added = await sc.build(c.turns.map((t, i) => ({ idx: i, text: t.text })));
            ingestMs += Number(process.hrtime.bigint() - tb0) / 1e6;
            ingestedItems += added;
            for (const q of qs) {
              const tq0 = process.hrtime.bigint();
              const hits = await sc.search(q.cueText, MEM0_SEARCH_K);
              searchMs += Number(process.hrtime.bigint() - tq0) / 1e6;
              const ranked = hits.map((h) => c.turns[h.idx]?.id).filter((id): id is string => id !== undefined);
              rankMem0.set(q.id, ranked);
            }
          } finally {
            await sc.close();
            try { rmSync(qdrantPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }

        // ---- 11) METRICS --------------------------------------------------------
        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id) ?? [], prepared.get(q.id)!.rel)));
        const mem0Test = test.filter((q) => rankMem0.has(q.id));

        const overall = {
          PureID: metricsFor(test, rankPureID),
          TunedHybrid: metricsFor(test, rankHybrid),
          EmbedSeeded: metricsFor(test, rankEmbedSeeded),
          Blend: metricsFor(test, rankBlend),
          mem0: metricsFor(mem0Test, rankMem0),
        };

        // ---- 12) WRITE OUTPUT ---------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.3.blend — Phase 1b Measurement: Blend arm vs walk-mode arms + mem0 (same run)",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            mem0Llm: MEM0_LLM,
            mem0Embed: MEM0_EMBED,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            mem0ScoredQuestions: mem0Test.length,
            frozenHybridConfig: frozenHybrid,
            frozenEmbedSeedK: FROZEN_EMBED_SEED_K,
            frozenReinforcement: FROZEN_REINFORCEMENT,
            blendSweepGrid: { wCos: WCOS_GRID, wWalk: WWALK_GRID, wState: WSTATE_FIXED, unionTopN: UNION_N_GRID },
            frozenBlendWeights: frozenWeights,
            frozenBlendUnionTopN: frozenUnionTopN,
            gate: "LoCoMo recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1B_RANKING_SPEC.md)",
            mem0PublishedBaseline: MEM0_PUBLISHED_BASELINE,
          },
          devSweep: blendSweep,
          overall,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity ------------------------------------------------------------
        expect(blendSweep.length).toBe(WCOS_GRID.length * WWALK_GRID.length * UNION_N_GRID.length);
        expect(Number.isFinite(overall.Blend.recall20)).toBe(true);
        expect(mem0Test.length).toBeGreaterThan(0);

        // ---- cleanup temp caches -------------------------------------------
        const cache = cachePathFor(all);
        if (existsSync(cache)) { try { rmSync(cache, { force: true }); } catch { /* best-effort */ } }
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

  L.push("# LoCoMo retrieval bench — Blend arm (Phase 1b Measurement)");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; **${meta.questionsKept} questions kept**. ` +
      `Split: **${meta.devQuestions} dev / ${meta.testQuestions} test** (mem0 scored **${meta.mem0ScoredQuestions}**). ` +
      `Embedder: **${meta.embedder}**. Gate: **${meta.gate}**.`,
  );
  L.push("");
  L.push(
    `Frozen embedder-seeded walk: embedSeedK=${meta.frozenEmbedSeedK}, reinforcement=${meta.frozenReinforcement} ` +
      `(Phase-1 defaults, not re-tuned here). Frozen TunedHybrid config: ${JSON.stringify(meta.frozenHybridConfig)}.`,
  );
  L.push("");
  L.push(`**Frozen Blend config: weights=${JSON.stringify(meta.frozenBlendWeights)}, unionTopN=${meta.frozenBlendUnionTopN}**`);
  L.push("");

  L.push("## 1. DEV sweep (wCos x wWalk x unionTopN) — recall@20 / nDCG@10");
  L.push("");
  L.push("| wCos | wWalk | wState | unionTopN | recall@20 (DEV) | nDCG@10 (DEV) |");
  L.push("|---|---|---|---|---|---|");
  for (const r of m.devSweep) {
    L.push(
      `| ${r.weights.wCos} | ${r.weights.wWalk} | ${r.weights.wState} | ${r.unionTopN} | ${f3(r.dev.recall20)} | ${f3(r.dev.ndcg10)} |`,
    );
  }
  L.push("");

  L.push("## 2. Full comparison table — TEST split, macro-averaged (same run)");
  L.push("");
  L.push("| Arm | recall@10 | recall@20 | nDCG@10 | MRR |");
  L.push("|---|---|---|---|---|");
  const order = ["PureID", "TunedHybrid", "EmbedSeeded", "Blend", "mem0"];
  for (const name of order) {
    const r: RankMetrics = m.overall[name];
    L.push(`| ${name} | ${f3(r.recall10)} | ${f3(r.recall20)} | ${f3(r.ndcg10)} | ${f3(r.mrr)} |`);
  }
  L.push("");

  L.push("## 3. Gate verdict");
  L.push("");
  const gap = m.overall.Blend.recall20 - m.overall.mem0.recall20;
  if (m.overall.Blend.recall20 >= 0.484) {
    L.push(
      `**PASS** — Blend's recall@20 (${f3(m.overall.Blend.recall20)}) meets/exceeds the gate (>= 0.484). ` +
        `Same-run mem0: ${f3(m.overall.mem0.recall20)} (delta ${gap >= 0 ? "+" : ""}${f3(gap)}).`,
    );
  } else {
    L.push(
      `**FALL SHORT** — Blend's recall@20 (${f3(m.overall.Blend.recall20)}) is BELOW the gate (>= 0.484). ` +
        `Same-run mem0: ${f3(m.overall.mem0.recall20)}. Reported honestly per instructions — not tuned to pass.`,
    );
  }
  L.push("");
  L.push(`mem0's previously-published same-run number (cross-reference only): ${JSON.stringify(meta.mem0PublishedBaseline)}`);
  L.push("");

  void RANK_KEYS; // referenced for type-consistency of the shared metric-name table
  return L.join("\n");
}
