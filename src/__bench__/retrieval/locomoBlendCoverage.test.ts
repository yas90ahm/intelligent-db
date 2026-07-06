/**
 * retrieval/locomoBlendCoverage.test.ts — Phase 1b Measurement follow-up: the coverage
 * diagnostic for the FROZEN Blend arm (docs/specs/PHASE1B_RANKING_SPEC.md's Measurement
 * section: "If it is not met, report the shortfall and the coverage diagnostic").
 *
 * `locomoBlendRunner.test.ts` froze `(wCos, wWalk, unionTopN)` on DEV and measured
 * recall@20 = 0.419 on TEST — below the 0.484 gate. This file measures, with that SAME
 * frozen config (no re-tuning — a read-only diagnostic over an already-frozen arm),
 * COVERAGE: the fraction of a question's gold evidence-turn ids present ANYWHERE in the
 * Blend arm's full (untruncated) candidate set — i.e. the ceiling recall@infinity could
 * ever reach — vs its actual recall@20 (the ranking cost of the top-20 cut). Reported for
 * DEV and TEST, alongside the EmbedSeeded arm's own coverage for the SAME questions (the
 * walk-only candidate set the Blend arm's union widens), so the delta from widening is
 * visible directly.
 *
 * Gated behind RETRIEVAL_BENCH=1 only (no mem0 — this is a read-only, no-network,
 * no-Python diagnostic over data already computed in `locomoBlendRunner.test.ts`). To run:
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoBlendCoverage.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.3.blend-coverage/.
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
import { loadLocomo, buildLocomoGraph, splitLocomo, type LocomoQuestion, type LocomoDataset } from "./locomo.js";
import { createLocomoIdRetriever, type LocomoIdRetriever } from "./retrievers.js";
import { queryMetrics, meanMetrics } from "./metrics.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.3.blend-coverage";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

// FROZEN this run (locomoBlendRunner.test.ts's DEV-tuned result) — read-only here.
const FROZEN_EMBED_SEED_K = 16;
const FROZEN_REINFORCEMENT = "dominance" as const;
const FROZEN_BLEND_WEIGHTS: PresentationWeights = { wCos: 0.9, wWalk: 0.3, wState: 0.1 };
const FROZEN_UNION_TOP_N = 128;

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

function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/** Coverage: fraction of `rel` present ANYWHERE in `candidateIds` (order irrelevant). */
function coverage(candidateIds: readonly string[], rel: ReadonlySet<string>): number {
  if (rel.size === 0) return 0;
  const set = new Set(candidateIds);
  let hit = 0;
  for (const r of rel) if (set.has(r)) hit++;
  return hit / rel.size;
}

interface ConvRig {
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
  "RETRIEVAL QUALITY (real LoCoMo) — Blend arm coverage diagnostic (frozen config, read-only)",
  () => {
    it(
      "measures coverage (full candidate set) vs recall@20 (top-20 cut) for the FROZEN Blend arm on DEV+TEST",
      async () => {
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;

        const turnTexts: string[] = [];
        const turnIds: string[] = [];
        for (const c of convs) for (const t of c.turns) { turnTexts.push(t.text); turnIds.push(t.id); }
        const allQuestions: LocomoQuestion[] = convs.flatMap((c) => c.questions);
        const cueTexts = allQuestions.map((q) => q.cueText);
        const all = [...turnTexts, ...cueTexts];
        const vectors = await embedTexts(all);

        const vecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => vecByTurn.set(id, vectors[i]!));
        const cueVecByText = new Map<string, Float32Array>();
        const vecByQuestion = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = vectors[turnTexts.length + i]!;
          vecByQuestion.set(q.id, v);
          cueVecByText.set(q.cueText, v);
        });

        const graphByConv = new Map<string, SharedGraph>();
        const rigByConv = new Map<string, ConvRig>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          const idr = createLocomoIdRetriever(c);
          const sidecar = createMemoryVectorSidecar();
          for (const t of c.turns) sidecar.put(`hash:${t.id}` as ContentHash, MODEL_ID, vecByTurn.get(t.id)!);
          const embedder: EmbedderPort = {
            dim: EMBED_DIM,
            modelId: MODEL_ID,
            async embed(texts: string[]): Promise<Float32Array[]> {
              return texts.map((t) => cueVecByText.get(t) ?? new Float32Array(EMBED_DIM));
            },
          };
          const rig: ConvRig = {
            idr,
            vectors: sidecar,
            embedder,
            currentBaseline: [],
            baseResolver: { index(): void {}, resolve: (): WalkSeed[] => rig.currentBaseline },
          };
          rigByConv.set(c.convId, rig);
        }

        const prepared = new Map<string, Prepared>();
        for (const c of convs) {
          const g = graphByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            prepared.set(q.id, { q, convId: c.convId, cueVec, baselineIds: locomoSeed(g, q, cueVec), rel: new Set(q.relevant) });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        async function walkResultFor(qid: string): Promise<RecallResult> {
          const p = prepared.get(qid)!;
          const rig = rigByConv.get(p.convId)!;
          rig.currentBaseline = p.baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
          const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, { base: rig.baseResolver });
          const seeds = await resolver.resolveWithEmbeddings({ text: p.q.cueText }, { embedSeedK: FROZEN_EMBED_SEED_K, embedSeedEnergyCap: 1 });
          const present = seeds.filter((s) => rig.idr.store.getStrand(s.strandId) !== null);
          if (present.length === 0) {
            return { lit: [], halt: { reason: "TRUNCATED", popCount: 0, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: true } as never, unresolvedSeeds: [], seedsResolved: 0 };
          }
          return rig.idr.engine.recall({ seeds: present, config: { ...DEFAULT_WALK_CONFIG, reinforcement: FROZEN_REINFORCEMENT } });
        }

        async function scoreSplit(qs: readonly LocomoQuestion[]) {
          const embedSeededCoverage: number[] = [];
          const blendCoverage: number[] = [];
          const embedSeededRecall20: number[] = [];
          const blendRecall20: number[] = [];
          for (const q of qs) {
            const p = prepared.get(q.id)!;
            const rig = rigByConv.get(p.convId)!;
            const res = await walkResultFor(q.id);
            const embedSeededIds = res.lit.map((l) => String(l.strandId));
            const blended = rankRecallResult(
              rig.idr.store,
              res,
              { vectors: rig.vectors, modelId: MODEL_ID, cueVector: p.cueVec },
              { rankMode: "blend", unionTopN: FROZEN_UNION_TOP_N, weights: FROZEN_BLEND_WEIGHTS },
            );
            const blendIds = blended.lit.map((l) => String(l.strandId));

            embedSeededCoverage.push(coverage(embedSeededIds, p.rel));
            blendCoverage.push(coverage(blendIds, p.rel));
            embedSeededRecall20.push(queryMetrics(embedSeededIds, p.rel).recall20);
            blendRecall20.push(queryMetrics(blendIds, p.rel).recall20);
          }
          const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
          return {
            embedSeededCoverage: mean(embedSeededCoverage),
            blendCoverage: mean(blendCoverage),
            embedSeededRecall20: mean(embedSeededRecall20),
            blendRecall20: mean(blendRecall20),
          };
        }

        const devScores = await scoreSplit(dev);
        const testScores = await scoreSplit(test);

        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.3.blend-coverage — Phase 1b Measurement: Blend arm coverage diagnostic (frozen config)",
            frozenEmbedSeedK: FROZEN_EMBED_SEED_K,
            frozenReinforcement: FROZEN_REINFORCEMENT,
            frozenBlendWeights: FROZEN_BLEND_WEIGHTS,
            frozenUnionTopN: FROZEN_UNION_TOP_N,
            devQuestions: dev.length,
            testQuestions: test.length,
          },
          dev: devScores,
          test: testScores,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(
          join(OUT_DIR, "results.md"),
          [
            "# LoCoMo Blend arm — coverage diagnostic (frozen config, read-only)",
            "",
            `Frozen: embedSeedK=${FROZEN_EMBED_SEED_K}, reinforcement=${FROZEN_REINFORCEMENT}, ` +
              `blend weights=${JSON.stringify(FROZEN_BLEND_WEIGHTS)}, unionTopN=${FROZEN_UNION_TOP_N}.`,
            "",
            "| split | arm | coverage (full candidate set) | recall@20 (top-20 cut) |",
            "|---|---|---|---|",
            `| DEV | EmbedSeeded (walk only) | ${f3(devScores.embedSeededCoverage)} | ${f3(devScores.embedSeededRecall20)} |`,
            `| DEV | Blend (walk UNION cosine-top-${FROZEN_UNION_TOP_N}) | ${f3(devScores.blendCoverage)} | ${f3(devScores.blendRecall20)} |`,
            `| TEST | EmbedSeeded (walk only) | ${f3(testScores.embedSeededCoverage)} | ${f3(testScores.embedSeededRecall20)} |`,
            `| TEST | Blend (walk UNION cosine-top-${FROZEN_UNION_TOP_N}) | ${f3(testScores.blendCoverage)} | ${f3(testScores.blendRecall20)} |`,
            "",
            "Coverage = fraction of a question's gold evidence-turn ids present ANYWHERE in the arm's full " +
              "(untruncated) candidate set (the recall@infinity ceiling); recall@20 is the same arm's actual " +
              "top-20 output. A coverage-recall@20 gap is a RANKING cost (evidence was surfaced but not in the " +
              "top 20); coverage itself below ~0.45-0.55 points at candidate generation, not ranking, as the " +
              "remaining lever (spec's decision rule, `locomoCoverageDiagnostic.test.ts`).",
            "",
          ].join("\n"),
        );

        expect(Number.isFinite(testScores.blendCoverage)).toBe(true);

        const cache = cachePathFor(all);
        if (existsSync(cache)) { try { rmSync(cache, { force: true }); } catch { /* best-effort */ } }
      },
      1_800_000,
    );
  },
);
