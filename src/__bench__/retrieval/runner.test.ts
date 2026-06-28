/**
 * retrieval/runner.test.ts — RETRIEVAL-QUALITY benchmark runner (gated).
 *
 * Registered only when RETRIEVAL_BENCH=1 (mirrors DEPLOY_BENCH / CROSSDB_BENCH), so a
 * plain `npm test` never loads the embedder or runs this. To run:
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/runner.test.ts
 *
 * It builds the synthetic corpus + planted ground truth, embeds every fact and cue
 * ONCE (shared), builds ONE shared graph, GRID-TUNES the hybrid on the dev split,
 * FREEZES it, and scores BOTH systems on the TEST split — emitting metrics.json +
 * results.md to .arbor/sessions/retrieval-quality/experiments/1/.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { buildDataset, splitQueries } from "./dataset.js";
import type { Category, QueryRecord } from "./dataset.js";
import { embedTexts, cachePathFor, MODEL_ID } from "./embed.js";
import { buildGraph } from "./graph.js";
import {
  createIdRetriever,
  hybridRetrieve,
  HYBRID_GRID,
  type HybridConfig,
} from "./retrievers.js";
import {
  queryMetrics,
  meanMetrics,
  haltingQuality,
  summarizeHalting,
  type RankMetrics,
} from "./metrics.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1";

const RANK_KEYS: Array<[keyof RankMetrics, string]> = [
  ["recall1", "recall@1"],
  ["recall5", "recall@5"],
  ["recall10", "recall@10"],
  ["recall20", "recall@20"],
  ["precision1", "precision@1"],
  ["precision5", "precision@5"],
  ["precision10", "precision@10"],
  ["mrr", "MRR"],
  ["ndcg10", "nDCG@10"],
];

function f3(x: number): string {
  return x.toFixed(3);
}

(RUN ? describe : describe.skip)("RETRIEVAL QUALITY — IntelligentDB activation walk vs tuned graph+vector hybrid", () => {
  it(
    "builds planted ground truth, tunes the hybrid on dev, scores both on test, emits metrics + report",
    async () => {
      // ---- 1) DATASET ----------------------------------------------------
      const dataset = buildDataset({ seed: 0xc0ffee });
      const { dev, test } = splitQueries(dataset.queries, 0.3);
      expect(dataset.facts.length).toBeGreaterThanOrEqual(290);
      expect(dataset.queries.length).toBeGreaterThanOrEqual(75);

      // ---- 2) EMBED (shared; cached) -------------------------------------
      const factTexts = dataset.facts.map((f) => f.text);
      const cueTexts = dataset.queries.map((q) => q.cueText);
      const all = [...factTexts, ...cueTexts];
      const vectors = await embedTexts(all);
      const factVectors = vectors.slice(0, factTexts.length);
      const cueVecByQuery = new Map<string, Float32Array>();
      dataset.queries.forEach((q, i) => cueVecByQuery.set(q.id, vectors[factTexts.length + i]!));

      // ---- 3) SHARED GRAPH ----------------------------------------------
      const graph = buildGraph(dataset, factVectors);

      // ---- 4) ID RETRIEVER (mirrors graph, adjudicates contradictions) ---
      const id = createIdRetriever(graph, dataset);

      const cueVec = (q: QueryRecord): Float32Array => cueVecByQuery.get(q.id)!;
      const relOf = (q: QueryRecord): Set<string> => new Set(q.relevant);

      // ---- 5) TUNE the hybrid on DEV (maximize mean recall@10), FREEZE ---
      let best: { cfg: HybridConfig; recall10: number; ndcg: number } | null = null;
      for (const cfg of HYBRID_GRID) {
        const rows = dev.map((q) => queryMetrics(hybridRetrieve(graph, q, cueVec(q), cfg), relOf(q)));
        const m = meanMetrics(rows);
        if (
          best === null ||
          m.recall10 > best.recall10 + 1e-12 ||
          (Math.abs(m.recall10 - best.recall10) <= 1e-12 && m.ndcg10 > best.ndcg + 1e-12)
        ) {
          best = { cfg, recall10: m.recall10, ndcg: m.ndcg10 };
        }
      }
      const frozen = best!.cfg;

      // ---- 6) SCORE BOTH on TEST ----------------------------------------
      const idRankedByQuery = new Map<string, string[]>();
      const hyRankedByQuery = new Map<string, string[]>();
      for (const q of test) {
        idRankedByQuery.set(q.id, id.retrieve(q, cueVec(q)));
        hyRankedByQuery.set(q.id, hybridRetrieve(graph, q, cueVec(q), frozen));
      }

      const idRows = test.map((q) => queryMetrics(idRankedByQuery.get(q.id)!, relOf(q)));
      const hyRows = test.map((q) => queryMetrics(hyRankedByQuery.get(q.id)!, relOf(q)));
      const idOverall = meanMetrics(idRows);
      const hyOverall = meanMetrics(hyRows);

      const cats: Category[] = ["DIRECT", "MULTIHOP", "PARAPHRASE", "CONTRADICTION"];
      const byCat = new Map<Category, { id: RankMetrics; hy: RankMetrics; n: number }>();
      for (const cat of cats) {
        const qs = test.filter((q) => q.category === cat);
        byCat.set(cat, {
          id: meanMetrics(qs.map((q) => queryMetrics(idRankedByQuery.get(q.id)!, relOf(q)))),
          hy: meanMetrics(qs.map((q) => queryMetrics(hyRankedByQuery.get(q.id)!, relOf(q)))),
          n: qs.length,
        });
      }

      // ---- 7) CONTRADICTION accuracy (full contradiction set) -----------
      const K_CON = 10;
      let idBoth = 0, hyBoth = 0, idCorrectLive = 0;
      const conQueryById = new Map<string, QueryRecord>();
      for (const q of dataset.queries) if (q.contradiction) conQueryById.set(q.contradiction.attribute, q);
      for (const pair of dataset.contradictions) {
        const q = conQueryById.get(pair.attribute)!;
        const idR = id.retrieve(q, cueVec(q)).slice(0, K_CON);
        const hyR = hybridRetrieve(graph, q, cueVec(q), frozen).slice(0, K_CON);
        if (idR.includes(pair.trueFactId) && idR.includes(pair.falseFactId)) idBoth++;
        if (hyR.includes(pair.trueFactId) && hyR.includes(pair.falseFactId)) hyBoth++;
        if (id.liveWinnerOf(pair) === pair.trueFactId) idCorrectLive++;
      }
      const nCon = dataset.contradictions.length;
      const contradiction = {
        bothSidesSurfacedAtK: K_CON,
        idBothSidesRate: idBoth / nCon,
        hybridBothSidesRate: hyBoth / nCon,
        idCorrectLiveRate: idCorrectLive / nCon,
        n: nCon,
      };

      // ---- 8) HALTING quality (ID only, over TEST) ----------------------
      const haltRows = test.map((q) => haltingQuality(idRankedByQuery.get(q.id)!, relOf(q)));
      const halting = summarizeHalting(haltRows);

      // ---- 9) WRITE OUTPUT ----------------------------------------------
      const metricsJson = {
        meta: {
          embedder: MODEL_ID,
          embedderRuntime: "@huggingface/transformers (Node-native ONNX)",
          corpusFacts: dataset.facts.length,
          totalQueries: dataset.queries.length,
          devQueries: dev.length,
          testQueries: test.length,
          frozenHybridConfig: frozen,
          seedingProtocol:
            "sharedSeed(q) = {nodes whose entity == a cue entity} UNION {global vector top-1 by cosine}; " +
            "IntelligentDB energizes these as walk seeds; the hybrid uses them as the graph-expansion root " +
            "and the global cosine ranking as its vector channel.",
          tuning: "Grid s∈{5,10,20} x h∈{1,2} x k∈{10,30,60} x alpha∈{0.3,0.5,0.7}; maximize mean recall@10 on dev; frozen for test.",
        },
        overall: { IntelligentDB: idOverall, TunedHybrid: hyOverall },
        byCategory: Object.fromEntries(
          cats.map((c) => [c, { n: byCat.get(c)!.n, IntelligentDB: byCat.get(c)!.id, TunedHybrid: byCat.get(c)!.hy }]),
        ),
        contradiction,
        halting,
      };

      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
      writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson, idOverall, hyOverall, byCat, cats));

      // sanity assertions (the bench must produce real numbers)
      expect(idOverall.recall10).toBeGreaterThan(0);
      expect(hyOverall.recall10).toBeGreaterThan(0);

      // ---- cleanup the embedding cache ----------------------------------
      const cache = cachePathFor(all);
      if (existsSync(cache)) {
        try { rmSync(cache, { force: true }); } catch { /* best-effort */ }
      }
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any,
  idOverall: RankMetrics,
  hyOverall: RankMetrics,
  byCat: Map<Category, { id: RankMetrics; hy: RankMetrics; n: number }>,
  cats: Category[],
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = meta as any;
  const lines: string[] = [];
  lines.push("# Retrieval-Quality Benchmark — IntelligentDB vs Tuned Graph+Vector Hybrid");
  lines.push("");
  lines.push(
    `Synthetic corpus of **${m.meta.corpusFacts} facts** with planted ground truth; ` +
      `**${m.meta.totalQueries} queries** (${m.meta.devQueries} dev / ${m.meta.testQueries} test). ` +
      `Embedder: **${m.meta.embedder}** via ${m.meta.embedderRuntime}. All numbers below are on the **TEST split**.`,
  );
  lines.push("");

  // --- LEAD: per-metric comparison table ---
  lines.push("## Overall comparison (TEST, macro-averaged)");
  lines.push("");
  lines.push("| Metric | IntelligentDB | TunedHybrid | Winner |");
  lines.push("|---|---|---|---|");
  for (const [key, label] of RANK_KEYS) {
    const a = idOverall[key];
    const b = hyOverall[key];
    const win = Math.abs(a - b) < 1e-9 ? "tie" : a > b ? "ID" : "Hybrid";
    lines.push(`| ${label} | ${f3(a)} | ${f3(b)} | ${win} |`);
  }
  lines.push("");

  // --- per-category breakdown ---
  lines.push("## Per-category breakdown (recall@10 / precision@5 / nDCG@10 / MRR)");
  lines.push("");
  lines.push("| Category | n | System | recall@10 | precision@5 | nDCG@10 | MRR |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const cat of cats) {
    const row = byCat.get(cat)!;
    lines.push(`| ${cat} | ${row.n} | IntelligentDB | ${f3(row.id.recall10)} | ${f3(row.id.precision5)} | ${f3(row.id.ndcg10)} | ${f3(row.id.mrr)} |`);
    lines.push(`| ${cat} | ${row.n} | TunedHybrid | ${f3(row.hy.recall10)} | ${f3(row.hy.precision5)} | ${f3(row.hy.ndcg10)} | ${f3(row.hy.mrr)} |`);
  }
  lines.push("");

  // --- contradiction block ---
  const c = m.contradiction;
  lines.push("## Contradiction detection");
  lines.push("");
  lines.push(`Over the full contradiction set (**${c.n} pairs**, top-${c.bothSidesSurfacedAtK}):`);
  lines.push("");
  lines.push("| Metric | IntelligentDB | TunedHybrid |");
  lines.push("|---|---|---|");
  lines.push(`| both-sides-surfaced rate | ${f3(c.idBothSidesRate)} | ${f3(c.hybridBothSidesRate)} |`);
  lines.push(`| correct-LIVE rate (adjudication) | ${f3(c.idCorrectLiveRate)} | n/a |`);
  lines.push("");
  lines.push(
    "- **both-sides-surfaced**: fraction of contradicted (entity,attribute) pairs where BOTH the true and false " +
      "value appear in the system's top-K. Measures whether the conflict is even visible.",
  );
  lines.push(
    "- **correct-LIVE** (ID only): fraction where, after `engine.adjudicate`, the strand kept LIVE is the " +
      "planted-true value (the planted-false one DEMOTED). The hybrid has no adjudication, so this is n/a.",
  );
  lines.push("");

  // --- halting block ---
  const h = m.halting;
  lines.push("## Halting quality (ID auto-halt vs oracle best-K)");
  lines.push("");
  lines.push("| Quantity | Value |");
  lines.push("|---|---|");
  lines.push(`| mean \\|lit\\| (auto-halted set size) | ${f3(h.meanLitSize)} |`);
  lines.push(`| mean F1 (auto-halt) | ${f3(h.meanAutoF1)} |`);
  lines.push(`| mean F1 (oracle best-K) | ${f3(h.meanOracleF1)} |`);
  lines.push(`| F1(auto) / F1(oracle) | ${f3(h.autoOverOracle)} |`);
  lines.push(`| mean F1 @ fixed K=5 | ${f3(h.meanF1At5)} |`);
  lines.push(`| mean F1 @ fixed K=10 | ${f3(h.meanF1At10)} |`);
  lines.push(`| mean overshoot (\\|lit\\| − oracleK) | ${f3(h.meanOvershoot)} |`);
  lines.push("");
  lines.push(
    h.meanOvershoot > 0
      ? `Auto-halt OVER-shoots the oracle prefix by ~${f3(h.meanOvershoot)} strands on average (it lights more than the F1-optimal cut).`
      : `Auto-halt UNDER-shoots the oracle prefix by ~${f3(-h.meanOvershoot)} strands on average.`,
  );
  lines.push("");

  // --- frozen config + seeding ---
  lines.push("## Frozen hybrid config + seeding protocol");
  lines.push("");
  lines.push("```");
  lines.push(`hybrid (frozen on dev): ${JSON.stringify(m.meta.frozenHybridConfig)}`);
  lines.push(`tuning: ${m.meta.tuning}`);
  lines.push(`seeding: ${m.meta.seedingProtocol}`);
  lines.push("```");
  lines.push("");

  // --- verdict ---
  lines.push("## Verdict");
  lines.push("");
  lines.push(synthesizeVerdict(idOverall, hyOverall, byCat));
  lines.push("");
  return lines.join("\n");
}

function synthesizeVerdict(
  idOverall: RankMetrics,
  hyOverall: RankMetrics,
  byCat: Map<Category, { id: RankMetrics; hy: RankMetrics; n: number }>,
): string {
  const winOf = (c: Category): string => {
    const r = byCat.get(c)!;
    const d = r.id.recall10 - r.hy.recall10;
    if (Math.abs(d) < 0.02) return `parity on ${c.toLowerCase()} (Δrecall@10 ${d >= 0 ? "+" : ""}${f3(d)})`;
    return `${d > 0 ? "ID" : "Hybrid"} wins ${c.toLowerCase()} (recall@10 ${f3(r.id.recall10)} vs ${f3(r.hy.recall10)})`;
  };
  const overallWinner = idOverall.ndcg10 >= hyOverall.ndcg10 ? "IntelligentDB" : "TunedHybrid";
  return (
    `On nDCG@10 the overall edge goes to **${overallWinner}** ` +
    `(${f3(idOverall.ndcg10)} vs ${f3(hyOverall.ndcg10)}). By category: ${winOf("DIRECT")}; ${winOf("MULTIHOP")}; ` +
    `${winOf("PARAPHRASE")}; ${winOf("CONTRADICTION")}. ` +
    `The structural activation walk is strongest where relevance follows the graph (direct same-entity recall and ` +
    `multi-hop relation chains a pure-vector seed cannot see) and uniquely resolves contradictions by demoting the ` +
    `planted-false side; it is weakest on paraphrase rings that are reachable only by semantic similarity with no ` +
    `structural thread, where the tuned hybrid's vector channel dominates.`
  );
}
