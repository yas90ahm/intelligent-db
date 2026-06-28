/**
 * retrieval/librarianRunner.test.ts — CYCLE D: the LIBRARIAN ladder (gated).
 *
 * Isolates how much GRAPH-CONSTRUCTION quality moves Intelligent DB's retrieval. Holds
 * EVERYTHING fixed (same turns, same MiniLM embeddings, same per-query seed — computed
 * ONCE from the L0 baseline conversation and reused across every rung — same retrievers
 * with their dev-frozen hyper-params) and varies ONLY the librarian (the graph builder),
 * across four rungs L0/L1/L2/L3 (+ combined L1+L2):
 *
 *   L0 baseline · L1 semantic k-NN overlay (DEPLOYABLE, (m,τ) tuned on dev) ·
 *   L2 richer-entity (DEPLOYABLE) · L1+L2 · L3 ORACLE CEILING (LEAKY / diagnostic).
 *
 * Registered only when RETRIEVAL_BENCH=1. To run:
 *   RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/librarianRunner.test.ts
 *
 * Emits metrics.json + results.md to
 *   .arbor/sessions/retrieval-quality/experiments/1.1.1.1/
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { embedTexts, cachePathFor, MODEL_ID } from "./embed.js";
import { vectorTop1 } from "./graph.js";
import type { SharedGraph } from "./graph.js";
import {
  loadLocomo,
  buildLocomoGraph,
  splitLocomo,
  LOCOMO_CATEGORIES,
  type LocomoConversation,
  type LocomoQuestion,
  type LocomoDataset,
} from "./locomo.js";
import {
  createLocomoIdRetriever,
  hybridRetrieveFromSeed,
  rerankLit,
  HYBRID_GRID,
  RERANK_BLEND_GRID,
  type HybridConfig,
  type LitEnergy,
} from "./retrievers.js";
import { queryMetrics, meanMetrics, type RankMetrics } from "./metrics.js";
import {
  L0_BASELINE,
  L2_RICHER_ENTITY,
  L3_ORACLE,
  makeL1,
  makeL1L2,
  graphDensity,
  aggregateDensity,
  type Librarian,
  type SemanticParams,
} from "./librarian.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

/** L1 (m,τ) grid, tuned on dev to maximize ID+Rerank recall@20 (nDCG@10 tie-break). */
const SEMANTIC_GRID: SemanticParams[] = (() => {
  const out: SemanticParams[] = [];
  for (const m of [3, 5, 8]) for (const tau of [0.45, 0.55, 0.65]) out.push({ m, tau });
  return out;
})();

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

// ---------------------------------------------------------------------------
// Per-rung artifacts (graph + ID retriever per conversation) + density
// ---------------------------------------------------------------------------

interface RungArtifacts {
  readonly graphByConv: Map<string, SharedGraph>;
  readonly idByConv: Map<string, ReturnType<typeof createLocomoIdRetriever>>;
  readonly density: ReturnType<typeof aggregateDensity>;
}

function buildRung(
  lib: Librarian,
  convs: readonly LocomoConversation[],
  vecByTurn: Map<string, Float32Array>,
): RungArtifacts {
  const graphByConv = new Map<string, SharedGraph>();
  const idByConv = new Map<string, ReturnType<typeof createLocomoIdRetriever>>();
  const densities = [];
  for (const c of convs) {
    const variant = lib.build(c, (id) => vecByTurn.get(id)!);
    graphByConv.set(c.convId, buildLocomoGraph(variant, (id) => vecByTurn.get(id)!));
    idByConv.set(c.convId, createLocomoIdRetriever(variant));
    densities.push(graphDensity(variant));
  }
  return { graphByConv, idByConv, density: aggregateDensity(densities) };
}

/** Fixed per-question context (seed + cueVec + relevant), computed ONCE from L0. */
interface QCtx {
  readonly q: LocomoQuestion;
  readonly seed: string[];
  readonly cueVec: Float32Array;
  readonly rel: Set<string>;
}

/**
 * Rank all three arms for `questions` over a rung's artifacts. PureID = lit energy order;
 * Hybrid = RRF over the rung graph from the fixed seed; ID+Rerank = lit reordered by the
 * frozen cosine blend. Returns per-question ranked id lists for each arm.
 */
function rankRung(
  art: RungArtifacts,
  questions: readonly QCtx[],
  frozenHybrid: HybridConfig,
  frozenBlend: number,
): Map<string, { id: string[]; hy: string[]; rr: string[] }> {
  const out = new Map<string, { id: string[]; hy: string[]; rr: string[] }>();
  for (const qc of questions) {
    const graph = art.graphByConv.get(qc.q.convId)!;
    const idr = art.idByConv.get(qc.q.convId)!;
    const lit: LitEnergy[] = idr.retrieveLit(qc.seed);
    out.set(qc.q.id, {
      id: lit.map((l) => l.id),
      hy: hybridRetrieveFromSeed(graph, qc.seed, qc.cueVec, frozenHybrid),
      rr: rerankLit(lit, graph, qc.cueVec, frozenBlend),
    });
  }
  return out;
}

function meanFor(
  questions: readonly QCtx[],
  ranked: Map<string, { id: string[]; hy: string[]; rr: string[] }>,
  arm: "id" | "hy" | "rr",
): RankMetrics {
  return meanMetrics(
    questions.map((qc) => queryMetrics(ranked.get(qc.q.id)![arm], qc.rel)),
  );
}

(RUN ? describe : describe.skip)(
  "LIBRARIAN LADDER (real LoCoMo) — vary ONLY the graph across L0/L1/L2/L3",
  () => {
    it(
      "tunes L1 (m,τ) + hybrid + rerank on dev, scores every rung × {PureID,Hybrid,ID+Rerank} on test",
      async () => {
        // ---- 1) DATASET ----------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        // ---- 2) EMBED (shared; cached) -------------------------------------
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
        allQuestions.forEach((q, i) => vecByQuestion.set(q.id, vectors[turnTexts.length + i]!));

        // ---- 3) FIXED per-query seed (computed ONCE from the L0 graph) ------
        const l0graphByConv = new Map<string, SharedGraph>();
        for (const c of convs) l0graphByConv.set(c.convId, buildLocomoGraph(c, (id) => vecByTurn.get(id)!));
        const ctxByQ = new Map<string, QCtx>();
        for (const c of convs) {
          const g = l0graphByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            const set = new Set<string>();
            for (const e of q.cueEntities) for (const id of g.entityFacts(e)) set.add(id);
            set.add(vectorTop1(g, cueVec));
            ctxByQ.set(q.id, { q, seed: [...set], cueVec, rel: new Set(q.relevant) });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);
        const devCtx = dev.map((q) => ctxByQ.get(q.id)!);
        const testCtx = test.map((q) => ctxByQ.get(q.id)!);

        // ---- 4) Tune hybrid + rerank blend on the L0 dev split, FREEZE ------
        const l0 = buildRung(L0_BASELINE, convs, vecByTurn);
        // Hybrid: max mean recall@10 on dev (nDCG@10 tie-break).
        let bestH: { cfg: HybridConfig; r10: number; ndcg: number } | null = null;
        for (const cfg of HYBRID_GRID) {
          const rows = devCtx.map((qc) =>
            queryMetrics(hybridRetrieveFromSeed(l0.graphByConv.get(qc.q.convId)!, qc.seed, qc.cueVec, cfg), qc.rel),
          );
          const m = meanMetrics(rows);
          if (bestH === null || m.recall10 > bestH.r10 + 1e-12 ||
              (Math.abs(m.recall10 - bestH.r10) <= 1e-12 && m.ndcg10 > bestH.ndcg + 1e-12)) {
            bestH = { cfg, r10: m.recall10, ndcg: m.ndcg10 };
          }
        }
        const frozenHybrid = bestH!.cfg;
        // Rerank blend: max mean nDCG@10 on dev (over L0 lit sets).
        const l0litDev = new Map<string, LitEnergy[]>();
        for (const qc of devCtx) l0litDev.set(qc.q.id, l0.idByConv.get(qc.q.convId)!.retrieveLit(qc.seed));
        let bestB: { blend: number; ndcg: number } | null = null;
        for (const blend of RERANK_BLEND_GRID) {
          const rows = devCtx.map((qc) =>
            queryMetrics(rerankLit(l0litDev.get(qc.q.id)!, l0.graphByConv.get(qc.q.convId)!, qc.cueVec, blend), qc.rel),
          );
          const m = meanMetrics(rows);
          if (bestB === null || m.ndcg10 > bestB.ndcg + 1e-12) bestB = { blend, ndcg: m.ndcg10 };
        }
        const frozenBlend = bestB!.blend;

        // ---- 5) Tune L1 (m,τ) on dev: max ID+Rerank recall@20 (nDCG@10 t-b) -
        let bestL1: { p: SemanticParams; r20: number; ndcg: number } | null = null;
        for (const p of SEMANTIC_GRID) {
          const art = buildRung(makeL1(p), convs, vecByTurn);
          const ranked = rankRung(art, devCtx, frozenHybrid, frozenBlend);
          const m = meanFor(devCtx, ranked, "rr");
          if (bestL1 === null || m.recall20 > bestL1.r20 + 1e-12 ||
              (Math.abs(m.recall20 - bestL1.r20) <= 1e-12 && m.ndcg10 > bestL1.ndcg + 1e-12)) {
            bestL1 = { p, r20: m.recall20, ndcg: m.ndcg10 };
          }
        }
        const frozenSemantic = bestL1!.p;

        // ---- 6) Define the rungs (frozen params) ---------------------------
        const rungs: Array<{ label: string; lib: Librarian; leaky: boolean }> = [
          { label: "L0-baseline", lib: L0_BASELINE, leaky: false },
          { label: "L1-semantic", lib: makeL1(frozenSemantic), leaky: false },
          { label: "L2-richer-entity", lib: L2_RICHER_ENTITY, leaky: false },
          { label: "L1+L2", lib: makeL1L2(frozenSemantic), leaky: false },
          { label: "L3-oracle-LEAKY", lib: L3_ORACLE, leaky: true },
        ];

        // ---- 7) Score every rung on TEST -----------------------------------
        interface RungResult {
          label: string;
          leaky: boolean;
          overall: { PureID: RankMetrics; TunedHybrid: RankMetrics; IDRerank: RankMetrics };
          byCategory: Record<string, { n: number; PureID: RankMetrics; TunedHybrid: RankMetrics; IDRerank: RankMetrics }>;
          density: ReturnType<typeof aggregateDensity>;
        }
        const results: RungResult[] = [];
        for (const r of rungs) {
          const art = r.label === "L0-baseline" ? l0 : buildRung(r.lib, convs, vecByTurn);
          const ranked = rankRung(art, testCtx, frozenHybrid, frozenBlend);
          const overall = {
            PureID: meanFor(testCtx, ranked, "id"),
            TunedHybrid: meanFor(testCtx, ranked, "hy"),
            IDRerank: meanFor(testCtx, ranked, "rr"),
          };
          const byCategory: RungResult["byCategory"] = {};
          for (const cat of LOCOMO_CATEGORIES) {
            const qs = testCtx.filter((qc) => qc.q.category === cat);
            if (qs.length === 0) continue;
            byCategory[cat] = {
              n: qs.length,
              PureID: meanFor(qs, ranked, "id"),
              TunedHybrid: meanFor(qs, ranked, "hy"),
              IDRerank: meanFor(qs, ranked, "rr"),
            };
          }
          results.push({ label: r.label, leaky: r.leaky, overall, byCategory, density: art.density });
        }

        // ---- 8) WRITE OUTPUT -----------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1 — librarian (graph-construction) ladder, retrieval isolation",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            isolation:
              "vary ONLY the librarian (graph edges); same turns, same MiniLM vectors, same retrievers, " +
              "and the SAME per-query seed (computed once from the L0 graph, reused across all rungs).",
            frozenHybridConfig: frozenHybrid,
            frozenRerankBlend: frozenBlend,
            frozenSemanticL1: frozenSemantic,
            l1Grid: SEMANTIC_GRID,
            l1TuningObjective: "max mean ID+Rerank recall@20 on dev (nDCG@10 tie-break)",
            l2EntityRule:
              "richer proper-noun-PHRASE extraction + alias normalization: tokens stripped of surrounding " +
              "punctuation + trailing possessive, lowercased; proper-noun = /^[A-Z][a-z]{2,}$/ OR acronym " +
              "/^[A-Z]{2,5}$/ (minus stopwords); consecutive proper nouns merge into a phrase AND each " +
              "multi-token phrase also emits its constituent token keys; SHARED_ENTITY edges for keys with DF∈[2,40].",
            l3Oracle: "LEAKY/diagnostic: edges between turns co-evidence for the SAME question (uses ground-truth labels).",
          },
          rungs: results,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // sanity
        for (const r of results) {
          expect(r.overall.PureID.recall10).toBeGreaterThanOrEqual(0);
          expect(r.overall.IDRerank.recall10).toBeGreaterThan(0);
        }

        // ---- cleanup temp caches -------------------------------------------
        const cache = cachePathFor(all);
        if (existsSync(cache)) { try { rmSync(cache, { force: true }); } catch { /* best-effort */ } }
        const ds = join(tmpdir(), "idb-locomo10.json");
        if (existsSync(ds)) { try { rmSync(ds, { force: true }); } catch { /* best-effort */ } }
      },
      600_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderReport(m: any): string {
  const meta = m.meta;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rungs: any[] = m.rungs;
  const deployable = rungs.filter((r) => !r.leaky);
  const oracle = rungs.find((r) => r.leaky);
  const L: string[] = [];

  const get = (r: RankMetrics): { r10: string; r20: string; mrr: string; ndcg: string } => ({
    r10: f3(r.recall10), r20: f3(r.recall20), mrr: f3(r.mrr), ndcg: f3(r.ndcg10),
  });

  L.push("# Librarian Ladder (Cycle D) — graph-construction quality isolation, real LoCoMo");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**, ` +
      `**${meta.questionsKept} questions** (**${meta.devQuestions} dev / ${meta.testQuestions} test**, ` +
      `stratified). Embedder: **${meta.embedder}**. All TEST numbers, macro-averaged. ` +
      `**Isolation:** ${meta.isolation}`,
  );
  L.push("");

  // --- LEAD: rung × {PureID, ID+Rerank, Hybrid} ---
  L.push("## 1. Rung × retriever (TEST) — recall@10 / recall@20 / MRR / nDCG@10");
  L.push("");
  L.push("| Rung | PureID r@10/r@20/MRR/nDCG | ID+Rerank r@10/r@20/MRR/nDCG | Hybrid r@10/r@20/MRR/nDCG | ID+Rerank−Hybrid (r@10 / r@20 / nDCG) |");
  L.push("|---|---|---|---|---|");
  for (const r of deployable) {
    const a = get(r.overall.PureID), b = get(r.overall.IDRerank), c = get(r.overall.TunedHybrid);
    const g10 = r.overall.IDRerank.recall10 - r.overall.TunedHybrid.recall10;
    const g20 = r.overall.IDRerank.recall20 - r.overall.TunedHybrid.recall20;
    const gnd = r.overall.IDRerank.ndcg10 - r.overall.TunedHybrid.ndcg10;
    const sgn = (x: number): string => (x >= 0 ? "+" : "") + f3(x);
    L.push(
      `| ${r.label} | ${a.r10}/${a.r20}/${a.mrr}/${a.ndcg} | ${b.r10}/${b.r20}/${b.mrr}/${b.ndcg} | ` +
        `${c.r10}/${c.r20}/${c.mrr}/${c.ndcg} | ${sgn(g10)} / ${sgn(g20)} / ${sgn(gnd)} |`,
    );
  }
  L.push("");
  L.push(
    "Gap column = ID+Rerank minus Hybrid (positive ⇒ the better librarian let ID overtake the hybrid). " +
      "L3 oracle is reported separately below (it is LEAKY — not comparable to the deployable rungs).",
  );
  L.push("");

  // --- per-category for L0 / L1 / L1+L2 ---
  L.push("## 2. Per-category breakdown (recall@10 / nDCG@10) for L0, L1, L1+L2");
  L.push("");
  const focus = ["L0-baseline", "L1-semantic", "L1+L2"].map((x) => rungs.find((r) => r.label === x)).filter(Boolean);
  L.push("| Category | n | Rung | PureID r@10/nDCG | ID+Rerank r@10/nDCG | Hybrid r@10/nDCG |");
  L.push("|---|---|---|---|---|---|");
  for (const cat of LOCOMO_CATEGORIES) {
    for (const r of focus) {
      const bc = r.byCategory[cat];
      if (!bc) continue;
      const a = bc.PureID, b = bc.IDRerank, c = bc.TunedHybrid;
      L.push(
        `| ${cat} | ${bc.n} | ${r.label} | ${f3(a.recall10)}/${f3(a.ndcg10)} | ${f3(b.recall10)}/${f3(b.ndcg10)} | ${f3(c.recall10)}/${f3(c.ndcg10)} |`,
      );
    }
  }
  L.push("");

  // --- ORACLE CEILING ---
  L.push("## 3. ORACLE CEILING (LEAKY — diagnostic upper bound, NOT deployable)");
  L.push("");
  L.push("> ⚠️ L3 adds edges between turns that are co-evidence for the SAME question, using GROUND-TRUTH");
  L.push("> evidence sets (TEST LABELS). Its scores are an UPPER BOUND on headroom from perfect graph");
  L.push("> construction — they are NOT a fair/deployable retrieval result and must not be compared to the rungs above as such.");
  L.push("");
  if (oracle) {
    const l0 = rungs.find((r) => r.label === "L0-baseline")!;
    L.push("| Arm | L0 r@10 | Oracle r@10 | Δ headroom | L0 nDCG@10 | Oracle nDCG@10 | Δ |");
    L.push("|---|---|---|---|---|---|---|");
    for (const arm of ["PureID", "IDRerank", "TunedHybrid"] as const) {
      const a = l0.overall[arm], b = oracle.overall[arm];
      const sgn = (x: number): string => (x >= 0 ? "+" : "") + f3(x);
      L.push(`| ${arm} | ${f3(a.recall10)} | ${f3(b.recall10)} | ${sgn(b.recall10 - a.recall10)} | ${f3(a.ndcg10)} | ${f3(b.ndcg10)} | ${sgn(b.ndcg10 - a.ndcg10)} |`);
    }
  }
  L.push("");

  // --- graph density ---
  L.push("## 4. Graph-density stats per rung (cost of density)");
  L.push("");
  L.push("| Rung | nodes | materialized edges | mean edges/node | SHARED_ENTITY | CONFIRMED_LINK |");
  L.push("|---|---|---|---|---|---|");
  for (const r of rungs) {
    const d = r.density;
    L.push(`| ${r.label} | ${d.nodes} | ${d.materializedEdges} | ${f3(d.meanEdgesPerNode)} | ${d.sharedEntityEdges} | ${d.confirmedLinkEdges} |`);
  }
  L.push("");
  L.push("(Same-speaker sibling connectivity is constant across rungs and not counted here; these are the librarian's materialized mention/session/semantic/oracle edges only.)");
  L.push("");

  // --- frozen config ---
  L.push("## 5. Frozen config + fairness audit");
  L.push("");
  L.push("```");
  L.push(`L1 frozen (m,τ):       ${JSON.stringify(meta.frozenSemanticL1)}   [tuned on dev: ${meta.l1TuningObjective}]`);
  L.push(`L1 grid:               ${JSON.stringify(meta.l1Grid)}`);
  L.push(`hybrid frozen:         ${JSON.stringify(meta.frozenHybridConfig)}   [dev-tuned on L0, reused all rungs]`);
  L.push(`rerank blend frozen:   ${meta.frozenRerankBlend}   [dev-tuned on L0, reused all rungs]`);
  L.push(`L2 entity rule:        ${meta.l2EntityRule}`);
  L.push(`L3 oracle:             ${meta.l3Oracle}`);
  L.push("```");
  L.push("");

  // --- verdict ---
  L.push("## 6. Verdict (Q1–Q4)");
  L.push("");
  L.push(verdict(m));
  L.push("");
  return L.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verdict(m: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rungs: any[] = m.rungs;
  const r = (label: string) => rungs.find((x) => x.label === label);
  const l0 = r("L0-baseline"), l1 = r("L1-semantic"), l12 = r("L1+L2"), orc = r("L3-oracle-LEAKY");
  const gap = (x: any): { g10: number; g20: number } => ({
    g10: x.overall.IDRerank.recall10 - x.overall.TunedHybrid.recall10,
    g20: x.overall.IDRerank.recall20 - x.overall.TunedHybrid.recall20,
  });
  const g0 = gap(l0), g1 = gap(l1);
  const sgn = (x: number): string => (x >= 0 ? "+" : "") + f3(x);
  const idLift10 = l1.overall.IDRerank.recall10 - l0.overall.IDRerank.recall10;
  const hyLift10 = l1.overall.TunedHybrid.recall10 - l0.overall.TunedHybrid.recall10;
  const headroom10 = orc.overall.IDRerank.recall10 - l0.overall.IDRerank.recall10;

  return (
    `**Q1 (does L1 close/flip the ID+Rerank-vs-Hybrid recall gap?)** At L0 the ID+Rerank−Hybrid recall@10 gap is ${sgn(g0.g10)} ` +
    `(r@20 ${sgn(g0.g20)}); the deployable semantic librarian L1 moves it to ${sgn(g1.g10)} (r@20 ${sgn(g1.g20)}) — a ` +
    `${Math.abs(g1.g10) < Math.abs(g0.g10) ? "narrowing" : "widening"} of ${sgn(g1.g10 - g0.g10)} at r@10. ` +
    `**Q2 (does a better librarian help ID more than the hybrid?)** Going L0→L1, ID+Rerank recall@10 moves ${sgn(idLift10)} ` +
    `while the hybrid moves ${sgn(hyLift10)} — the lever is ${Math.abs(idLift10) > Math.abs(hyLift10) + 1e-9 ? "ID-favouring (gap shrinks)" : "broadly shared (both lift)"}. ` +
    `**Q3 (oracle headroom).** Perfect (leaky) graph construction lifts ID+Rerank recall@10 by ${sgn(headroom10)} over L0 ` +
    `(to ${f3(orc.overall.IDRerank.recall10)}); ${headroom10 > 0.15 ? "LARGE ⇒ the librarian is a dominant lever and current construction leaves real recall on the table" : "MODEST ⇒ ID is substantially walk/embedding-bound, not graph-bound"}. ` +
    `**Q4 (which category benefits most).** ${categoryWinner(l0, l12)} ` +
    `Combined L1+L2 recall@10 (ID+Rerank) = ${f3(l12.overall.IDRerank.recall10)} vs L0 ${f3(l0.overall.IDRerank.recall10)}.`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function categoryWinner(l0: any, l12: any): string {
  let best = "";
  let bestDelta = -Infinity;
  for (const cat of LOCOMO_CATEGORIES) {
    const a = l0.byCategory[cat], b = l12.byCategory[cat];
    if (!a || !b) continue;
    const d = b.IDRerank.recall10 - a.IDRerank.recall10;
    if (d > bestDelta) { bestDelta = d; best = cat; }
  }
  return best
    ? `The biggest L0→L1+L2 ID+Rerank recall@10 gain is on **${best}** (${(bestDelta >= 0 ? "+" : "") + f3(bestDelta)}).`
    : "";
}
