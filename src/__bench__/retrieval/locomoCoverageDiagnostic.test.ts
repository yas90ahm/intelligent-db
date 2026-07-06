/**
 * retrieval/locomoCoverageDiagnostic.test.ts — Phase 1b spec's REQUIRED diagnostic
 * ("Why seeding alone missed", docs/specs/PHASE1B_RANKING_SPEC.md).
 *
 * Before any ranking/candidate-generation change lands, the spec requires measuring,
 * on the LoCoMo DEV split, for the TunedHybrid and EmbedSeeded arms:
 *   (a) COVERAGE  — the fraction of a question's gold evidence-turn ids present
 *       ANYWHERE in the arm's full surfaced candidate set, BEFORE the final top-k
 *       (recall@20) truncation/ranking cut. "Candidate set" = every id that ENTERS
 *       the arm's final fuse-and-sort step (RRF), i.e. the ceiling recall@∞ could
 *       ever reach for that arm on that query — not the top-20 the arm actually
 *       returns.
 *   (b) recall@20 — AS SHIPPED (the exact ranked output the production bench
 *       arms compute, sliced to 20).
 * Plus a third, coverage-only reference point the spec's §2 lever depends on:
 *   (c) cosine-top-64-ONLY coverage from a real `VectorSidecar` (the spec's
 *       default N=64 union candidate count) — no walk, no graph, no entity seed,
 *       just brute-force cosine over the sidecar.
 *
 * DECISION RULE (spec, verbatim): if coverage >= 0.55 while recall@20 is ~0.37,
 * ranking is CONFIRMED as the gap (the blend-score design applies). If coverage
 * itself is < 0.45, the fix is candidate generation (the §2 union term), not
 * ranking — report before proceeding.
 *
 * CANDIDATE-SET DEFINITIONS PER ARM (exact code-level reproduction, not a
 * re-implementation — every function below is imported from the real bench
 * arms in retrievers.ts / graph.ts / locomo.ts):
 *   - TunedHybrid: rankVec (top cfg.s ids by cosineRanking) UNION rankGraph
 *     (graphExpand(seed, cfg.h) reachable ids) — exactly the two maps
 *     `hybridRetrieveFromSeed` fuses via RRF before sorting.
 *   - EmbedSeeded: rankVec (same top cfg.s cosine ids, cfg reused from
 *     TunedHybrid's frozen fusion params per the shipped EmbedSeeded runner)
 *     UNION rankGraph (the embedder-seeded `engine.recall` lit set, ranked by
 *     activation desc) — exactly the two maps the shipped EmbedSeeded arm
 *     fuses via RRF before sorting.
 *
 * TUNING: both arms' hyperparameters are grid-tuned by the SAME selection rule
 * the shipped runners use (TunedHybrid: max mean recall@10; EmbedSeeded: max
 * mean recall@20), but SELECTED AND MEASURED ON DEV ONLY (this is a fast
 * pre-flight diagnostic, not the frozen-weights protocol — see the spec's
 * measurement section for the dev-tune/test-score split that governs the real
 * gate). The previously-published, honest TEST-split numbers for these same
 * arms (0.375 / 0.366 recall@20 — see docs/specs/PHASE1B_RANKING_SPEC.md's
 * "Why seeding alone missed") are reported alongside DEV numbers here for
 * context; dev-tuned-and-measured-on-dev is mildly optimistic vs held-out TEST.
 *
 * Gated behind RETRIEVAL_BENCH=1 (same convention as the sibling LoCoMo runners
 * in this directory — a plain `npm test` never loads the embedder or this file):
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoCoverageDiagnostic.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.2.coverage-diagnostic/.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  asStrandId,
  createEmbeddingCueResolver,
  createMemoryVectorSidecar,
  DEFAULT_WALK_CONFIG,
} from "../../index.js";
import type { CueResolver, EmbedderPort, WalkConfig, WalkSeed, ContentHash } from "../../index.js";

import { embedTexts, cachePathFor, MODEL_ID, EMBED_DIM } from "./embed.js";
import { vectorTop1, cosineRanking, graphExpand } from "./graph.js";
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

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.2.coverage-diagnostic";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

// Previously-measured, honest TEST-split numbers for the same two arms (cited
// verbatim in the spec's "Why seeding alone missed" section and in
// experiments/1.1/results.md + 1.1.1.1.1.embedseeded/results.md).
const PUBLISHED_TEST = {
  TunedHybrid: { recall10: 0.307, recall20: 0.375, ndcg10: 0.194, mrr: 0.174 },
  EmbedSeeded: { recall10: 0.322, recall20: 0.366, ndcg10: 0.201, mrr: 0.174 },
};

const EMBED_SEED_K_GRID: readonly number[] = [8, 16, 32];
const REINFORCEMENT_GRID: ReadonlyArray<"dominance" | "summation"> = ["dominance", "summation"];

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

/** SAME baseline seed protocol as the other LoCoMo runners: entity-match ∪ vector top-1. */
function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/** Fraction of `rel` present anywhere in `candidates` (set membership, order-independent). */
function coverage(candidates: ReadonlySet<string>, rel: ReadonlySet<string>): number {
  if (rel.size === 0) return 0;
  let hit = 0;
  for (const r of rel) if (candidates.has(r)) hit++;
  return hit / rel.size;
}

function meanOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** TunedHybrid's candidate set: rankVec (top-s cosine) UNION rankGraph (≤h-hop from seed). */
function tunedHybridCandidates(
  graph: SharedGraph,
  seeds: readonly string[],
  cueVec: Float32Array,
  cfg: HybridConfig,
): Set<string> {
  const ranking = cosineRanking(graph, cueVec);
  const vecIds = ranking.slice(0, Math.min(cfg.s, ranking.length)).map((r) => r.id);
  const dist = graphExpand(graph, seeds, cfg.h);
  return new Set<string>([...vecIds, ...dist.keys()]);
}

/**
 * EmbedSeeded's candidate set + fused ranking: rankVec (same top-s cosine, cfg reused
 * from the frozen TunedHybrid fusion) UNION rankGraph (the embedder-seeded engine.recall
 * lit set, ranked by activation desc) — the EXACT two maps the shipped EmbedSeeded arm
 * (`locomoEmbedSeededRunner.test.ts`'s `embedSeededRank`) fuses via RRF before sorting.
 */
function embedSeededCandidatesAndRank(
  litRanked: readonly string[],
  graph: SharedGraph,
  cueVec: Float32Array,
  cfg: HybridConfig,
): { candidates: Set<string>; ranked: string[] } {
  const ranking = cosineRanking(graph, cueVec);
  const cosOf = new Map<string, number>();
  ranking.forEach((r) => cosOf.set(r.id, r.sim));
  const rankVec = new Map<string, number>();
  for (let i = 0; i < Math.min(cfg.s, ranking.length); i++) rankVec.set(ranking[i]!.id, i + 1);
  const rankGraph = new Map<string, number>();
  litRanked.forEach((id, i) => rankGraph.set(id, i + 1));
  const candidates = new Set<string>([...rankVec.keys(), ...rankGraph.keys()]);
  const scored = [...candidates].map((c) => {
    const gv = rankGraph.has(c) ? cfg.alpha / (cfg.k + rankGraph.get(c)!) : 0;
    const vv = rankVec.has(c) ? (1 - cfg.alpha) / (cfg.k + rankVec.get(c)!) : 0;
    return { id: c, score: gv + vv };
  });
  scored.sort(
    (a, b) => (b.score - a.score) || ((cosOf.get(b.id) ?? 0) - (cosOf.get(a.id) ?? 0)) || (a.id < b.id ? -1 : 1),
  );
  return { candidates, ranked: scored.map((x) => x.id) };
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

interface PerQuery {
  readonly q: LocomoQuestion;
  readonly thCoverage: number;
  readonly thRecall20: number;
  readonly esCoverage: number;
  readonly esRecall20: number;
  readonly cos64Coverage: number;
}

(RUN ? describe : describe.skip)(
  "PHASE 1B DIAGNOSTIC — LoCoMo DEV coverage vs recall@20 (TunedHybrid, EmbedSeeded, cosine-top-64)",
  () => {
    it(
      "measures candidate-set coverage and shipped recall@20 on DEV; verdict: ranking-bound vs coverage-bound",
      async () => {
        // ---- 1) DATASET -------------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        // ---- 2) EMBED (shared MiniLM vectors; cached) -------------------------
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

        // ---- 3) PER-CONVERSATION graph + ID retriever + embedder-seed rig -----
        const graphByConv = new Map<string, SharedGraph>();
        const rigByConv = new Map<string, ConvRig>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          const idr = createLocomoIdRetriever(c);

          // Real VectorSidecar (spec's strand_vectors sidecar analogue), populated
          // from the SAME MiniLM vectors every arm uses. Content hash keyed by
          // `hash:${turnId}` — matching the shipped EmbedSeeded runner's convention.
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

        // ---- 4) PREPARE every question -----------------------------------------
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

        // ---- 5) DEV split ONLY (the spec's diagnostic runs on DEV) -------------
        const { dev } = splitLocomo(allQuestions, 0.3);

        // ---- 6) TUNE TunedHybrid on DEV (max mean recall@10 — shipped rule) ----
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

        // ---- 7) TUNE EmbedSeeded on DEV (max mean recall@20 — shipped rule) ----
        async function embedSeededSeedsFor(qid: string, embedSeedK: number): Promise<WalkSeed[]> {
          const p = prepared.get(qid)!;
          const rig = rigByConv.get(p.convId)!;
          rig.currentBaseline = p.baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
          const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, {
            base: rig.baseResolver,
          });
          return resolver.resolveWithEmbeddings({ text: p.q.cueText }, { embedSeedK, embedSeedEnergyCap: 1 });
        }

        function embedSeededLit(
          qid: string,
          seeds: readonly WalkSeed[],
          reinforcement: "dominance" | "summation",
        ): string[] {
          const p = prepared.get(qid)!;
          const rig = rigByConv.get(p.convId)!;
          const present = seeds.filter((s) => rig.idr.store.getStrand(s.strandId) !== null);
          if (present.length === 0) return [];
          const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement };
          const res = rig.idr.engine.recall({ seeds: present, config });
          return [...res.lit]
            .sort((a, b) => (b.activation - a.activation) || (String(a.strandId) < String(b.strandId) ? -1 : 1))
            .map((l) => String(l.strandId));
        }

        interface EsConfigResult {
          readonly embedSeedK: number;
          readonly reinforcement: "dominance" | "summation";
          readonly dev: RankMetrics;
        }
        const esConfigResults: EsConfigResult[] = [];
        const litByConfigAndQ = new Map<string, Map<string, string[]>>(); // "K:reinforcement" -> qid -> lit
        for (const embedSeedK of EMBED_SEED_K_GRID) {
          const seedsByQ = new Map<string, WalkSeed[]>();
          for (const q of dev) seedsByQ.set(q.id, await embedSeededSeedsFor(q.id, embedSeedK));
          for (const reinforcement of REINFORCEMENT_GRID) {
            const key = `${embedSeedK}:${reinforcement}`;
            const litMap = new Map<string, string[]>();
            const rows = dev.map((q) => {
              const lit = embedSeededLit(q.id, seedsByQ.get(q.id)!, reinforcement);
              litMap.set(q.id, lit);
              const { ranked } = embedSeededCandidatesAndRank(lit, graphByConv.get(prepared.get(q.id)!.convId)!, prepared.get(q.id)!.cueVec, frozenHybrid);
              return queryMetrics(ranked, prepared.get(q.id)!.rel);
            });
            litByConfigAndQ.set(key, litMap);
            esConfigResults.push({ embedSeedK, reinforcement, dev: meanMetrics(rows) });
          }
        }
        let esWinner = esConfigResults[0]!;
        for (const r of esConfigResults) {
          if (
            r.dev.recall20 > esWinner.dev.recall20 + 1e-12 ||
            (Math.abs(r.dev.recall20 - esWinner.dev.recall20) <= 1e-12 && r.dev.ndcg10 > esWinner.dev.ndcg10 + 1e-12)
          ) {
            esWinner = r;
          }
        }
        const esWinnerLit = litByConfigAndQ.get(`${esWinner.embedSeedK}:${esWinner.reinforcement}`)!;

        // ---- 8) PER-QUERY coverage + recall@20 (frozen configs) on DEV ---------
        const perQuery: PerQuery[] = [];
        for (const q of dev) {
          const p = prepared.get(q.id)!;
          const g = graphByConv.get(p.convId)!;
          const rig = rigByConv.get(p.convId)!;

          // TunedHybrid
          const thCands = tunedHybridCandidates(g, p.baselineIds, p.cueVec, frozenHybrid);
          const thRanked = hybridRetrieveFromSeed(g, p.baselineIds, p.cueVec, frozenHybrid);
          const thCoverage = coverage(thCands, p.rel);
          const thRecall20 = queryMetrics(thRanked, p.rel).recall20;

          // EmbedSeeded (winner config)
          const lit = esWinnerLit.get(q.id) ?? [];
          const { candidates: esCands, ranked: esRanked } = embedSeededCandidatesAndRank(lit, g, p.cueVec, frozenHybrid);
          const esCoverage = coverage(esCands, p.rel);
          const esRecall20 = queryMetrics(esRanked, p.rel).recall20;

          // cosine-top-64-ONLY coverage from the real VectorSidecar (no walk, no graph).
          const matches = rig.vectors.topK(p.cueVec, MODEL_ID, 64);
          const cos64Ids = new Set<string>(matches.map((m) => String(m.contentHash).replace(/^hash:/, "")));
          const cos64Coverage = coverage(cos64Ids, p.rel);

          perQuery.push({ q, thCoverage, thRecall20, esCoverage, esRecall20, cos64Coverage });
        }

        // ---- 9) AGGREGATE overall + per-category -------------------------------
        function agg(rows: readonly PerQuery[]): {
          n: number; thCoverage: number; thRecall20: number; esCoverage: number; esRecall20: number; cos64Coverage: number;
        } {
          return {
            n: rows.length,
            thCoverage: meanOf(rows.map((r) => r.thCoverage)),
            thRecall20: meanOf(rows.map((r) => r.thRecall20)),
            esCoverage: meanOf(rows.map((r) => r.esCoverage)),
            esRecall20: meanOf(rows.map((r) => r.esRecall20)),
            cos64Coverage: meanOf(rows.map((r) => r.cos64Coverage)),
          };
        }
        const overall = agg(perQuery);
        const byCategory: Record<string, ReturnType<typeof agg>> = {};
        for (const cat of LOCOMO_CATEGORIES) {
          const rows = perQuery.filter((r) => r.q.category === cat);
          if (rows.length === 0) continue;
          byCategory[cat] = agg(rows);
        }

        // ---- 10) VERDICT (spec's decision rule) --------------------------------
        function verdictFor(cov: number, recall20: number): "ranking-bound" | "coverage-bound" | "inconclusive" {
          if (cov >= 0.55) return "ranking-bound";
          if (cov < 0.45) return "coverage-bound";
          return "inconclusive"; // between 0.45 and 0.55: neither threshold cleanly met
        }
        const thVerdict = verdictFor(overall.thCoverage, overall.thRecall20);
        const esVerdict = verdictFor(overall.esCoverage, overall.esRecall20);

        // ---- 11) WRITE OUTPUT ---------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.2.coverage-diagnostic — Phase 1b spec 'Why seeding alone missed'",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            devQuestions: dev.length,
            frozenHybridConfig: frozenHybrid,
            embedSeededWinner: { embedSeedK: esWinner.embedSeedK, reinforcement: esWinner.reinforcement },
            candidateSetDefinition:
              "TunedHybrid: top-cfg.s cosine ids UNION graphExpand(seed, cfg.h) ids (the two maps hybridRetrieveFromSeed " +
              "RRF-fuses before sorting). EmbedSeeded: same top-cfg.s cosine ids UNION the embedder-seeded engine.recall " +
              "lit set (activation desc) — the two maps the shipped EmbedSeeded arm RRF-fuses before sorting. Both are " +
              "measured BEFORE the recall@20 truncation.",
            cos64Definition:
              "VectorSidecar.topK(cueVec, MODEL_ID, 64) mapped back to turn ids via content_hash — pure brute-force " +
              "cosine, no walk/graph/entity seed at all (spec §2's default N=64 union candidate count in isolation).",
            publishedTestSplitNumbers: PUBLISHED_TEST,
            devTuningCaveat:
              "Both arms are grid-tuned AND measured on DEV in this diagnostic (fast pre-flight check per the spec's " +
              "own instruction to run this diagnostic on the DEV split); this is mildly optimistic vs the held-out " +
              "TEST numbers reported alongside for context.",
          },
          overall,
          byCategory,
          verdict: {
            TunedHybrid: thVerdict,
            EmbedSeeded: esVerdict,
            rule: "coverage >= 0.55 => ranking-bound; coverage < 0.45 => coverage-bound; else inconclusive",
          },
          esSweep: esConfigResults,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity --------------------------------------------------------
        expect(overall.n).toBeGreaterThan(0);
        expect(overall.thCoverage).toBeGreaterThanOrEqual(overall.thRecall20 - 1e-9);
        expect(overall.esCoverage).toBeGreaterThanOrEqual(overall.esRecall20 - 1e-9);

        // ---- cleanup temp caches -------------------------------------------
        const cache = cachePathFor(all);
        if (existsSync(cache)) { try { rmSync(cache, { force: true }); } catch { /* best-effort */ } }
        const ds = join(tmpdir(), "idb-locomo10.json");
        if (existsSync(ds)) { try { rmSync(ds, { force: true }); } catch { /* best-effort */ } }
      },
      1_800_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderReport(m: any): string {
  const meta = m.meta;
  const o = m.overall;
  const L: string[] = [];

  L.push("# Phase 1b diagnostic — LoCoMo DEV coverage vs recall@20 (\"Why seeding alone missed\")");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; **${meta.devQuestions} DEV questions**. ` +
      `Embedder: **${meta.embedder}**. Frozen TunedHybrid config: \`${JSON.stringify(meta.frozenHybridConfig)}\`. ` +
      `EmbedSeeded winner: \`${JSON.stringify(meta.embedSeededWinner)}\`.`,
  );
  L.push("");

  L.push("## 1. Headline table (DEV, macro-averaged)");
  L.push("");
  L.push("| Arm | coverage (candidate-set) | recall@20 (as shipped) | gap (coverage − recall@20) |");
  L.push("|---|---|---|---|");
  L.push(`| TunedHybrid | ${f3(o.thCoverage)} | ${f3(o.thRecall20)} | ${f3(o.thCoverage - o.thRecall20)} |`);
  L.push(`| EmbedSeeded | ${f3(o.esCoverage)} | ${f3(o.esRecall20)} | ${f3(o.esCoverage - o.esRecall20)} |`);
  L.push(`| cosine-top-64-only | ${f3(o.cos64Coverage)} | n/a (coverage-only reference) | — |`);
  L.push("");
  L.push(
    `Published (honest) TEST-split numbers for context: TunedHybrid recall@20=${f3(meta.publishedTestSplitNumbers.TunedHybrid.recall20)}, ` +
      `EmbedSeeded recall@20=${f3(meta.publishedTestSplitNumbers.EmbedSeeded.recall20)}. ${meta.devTuningCaveat}`,
  );
  L.push("");

  L.push("## 2. Per-category breakdown");
  L.push("");
  L.push("| Category | n | TunedHybrid coverage | TunedHybrid recall@20 | EmbedSeeded coverage | EmbedSeeded recall@20 | cos-top-64 coverage |");
  L.push("|---|---|---|---|---|---|---|");
  for (const cat of LOCOMO_CATEGORIES) {
    const r = m.byCategory[cat];
    if (!r) continue;
    L.push(
      `| ${cat} | ${r.n} | ${f3(r.thCoverage)} | ${f3(r.thRecall20)} | ${f3(r.esCoverage)} | ${f3(r.esRecall20)} | ${f3(r.cos64Coverage)} |`,
    );
  }
  L.push("");

  L.push("## 3. Verdict (spec decision rule: coverage >= 0.55 => ranking-bound; coverage < 0.45 => coverage-bound)");
  L.push("");
  L.push(`- **TunedHybrid**: coverage ${f3(o.thCoverage)}, recall@20 ${f3(o.thRecall20)} => **${m.verdict.TunedHybrid}**`);
  L.push(`- **EmbedSeeded**: coverage ${f3(o.esCoverage)}, recall@20 ${f3(o.esRecall20)} => **${m.verdict.EmbedSeeded}**`);
  L.push("");

  L.push("## 4. EmbedSeeded sweep (DEV, all embedSeedK x reinforcement configs)");
  L.push("");
  L.push("| embedSeedK | reinforcement | recall@10 | recall@20 | nDCG@10 | MRR |");
  L.push("|---|---|---|---|---|---|");
  for (const r of m.esSweep) {
    const d: RankMetrics = r.dev;
    L.push(`| ${r.embedSeedK} | ${r.reinforcement} | ${f3(d.recall10)} | ${f3(d.recall20)} | ${f3(d.ndcg10)} | ${f3(d.mrr)} |`);
  }
  L.push("");

  L.push("## 5. Definitions + fairness audit");
  L.push("");
  L.push("```");
  L.push(`candidate-set definition: ${meta.candidateSetDefinition}`);
  L.push(`cosine-top-64 definition: ${meta.cos64Definition}`);
  L.push(`frozen TunedHybrid config (dev-tuned, max mean recall@10): ${JSON.stringify(meta.frozenHybridConfig)}`);
  L.push(`EmbedSeeded winner (dev-tuned, max mean recall@20): ${JSON.stringify(meta.embedSeededWinner)}`);
  L.push("```");
  L.push("");

  return L.join("\n");
}
