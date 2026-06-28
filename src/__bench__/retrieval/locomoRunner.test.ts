/**
 * retrieval/locomoRunner.test.ts — CYCLE B: real-LoCoMo retrieval-quality bench (gated).
 *
 * Registered only when RETRIEVAL_BENCH=1 (mirrors cycle A's runner), so a plain
 * `npm test` never loads the embedder, downloads the dataset, or runs this. To run:
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoRunner.test.ts
 *
 * It loads the REAL LoCoMo corpus (`locomo10.json`), builds one shared graph per
 * conversation, embeds every turn + question cue ONCE (shared, cached), computes ONE
 * seed per question handed to ALL THREE arms, TUNES the hybrid {s,h,k,alpha} and the
 * ID+rerank blend on the DEV split, FREEZES them, and scores all three arms on the TEST
 * split — emitting metrics.json + results.md to
 * .arbor/sessions/retrieval-quality/experiments/1.1/.
 *
 * THREE ARMS (same graph, same embeddings, same per-query seed):
 *   1. Pure ID            — activation walk; lit set ranked by activation energy.
 *   2. Tuned hybrid       — vector-kNN seed -> <=h-hop graph expansion -> RRF fusion.
 *   3. ID + vector rerank — pure ID's lit set, REORDERED by a dev-tuned blend of
 *                           normalized activation + cosine(question, turn).
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  queryMetrics,
  meanMetrics,
  haltingQuality,
  summarizeHalting,
  type RankMetrics,
} from "./metrics.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

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

/** Download `url` to `dest` (node:https), following redirects. Resolves false on failure. */
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

/** SHARED per-query seed: entity-match (cue proper nouns) ∪ vector top-1. */
function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

interface Prepared {
  readonly q: LocomoQuestion;
  readonly graph: SharedGraph;
  readonly cueVec: Float32Array;
  readonly seed: string[];
  readonly lit: LitEnergy[]; // pure-ID lit set (auto-halted), energy-desc
  readonly rel: Set<string>;
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — PureID vs TunedHybrid vs ID+Rerank",
  () => {
    it(
      "loads LoCoMo, tunes hybrid + rerank-blend on dev, scores 3 arms on test, emits metrics + report",
      async () => {
        // ---- 1) DATASET ------------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        // ---- 2) EMBED (shared; cached) --------------------------------------
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

        // ---- 3) PER-CONVERSATION graph + ID retriever -----------------------
        const graphByConv = new Map<string, SharedGraph>();
        const idByConv = new Map<string, ReturnType<typeof createLocomoIdRetriever>>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          idByConv.set(c.convId, createLocomoIdRetriever(c));
        }

        // ---- 4) PREPARE every question (pure-ID lit computed ONCE) ----------
        const prepared = new Map<string, Prepared>();
        for (const c of convs) {
          const g = graphByConv.get(c.convId)!;
          const idr = idByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            const seed = locomoSeed(g, q, cueVec);
            const lit = idr.retrieveLit(seed);
            prepared.set(q.id, { q, graph: g, cueVec, seed, lit, rel: new Set(q.relevant) });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        // ---- 5) TUNE the hybrid on DEV (max mean recall@10), FREEZE ---------
        let bestH: { cfg: HybridConfig; recall10: number; ndcg: number } | null = null;
        for (const cfg of HYBRID_GRID) {
          const rows = dev.map((q) => {
            const p = prepared.get(q.id)!;
            return queryMetrics(hybridRetrieveFromSeed(p.graph, p.seed, p.cueVec, cfg), p.rel);
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

        // ---- 5b) TUNE the ID+rerank blend on DEV (max mean nDCG@10), FREEZE -
        let bestBlend: { blend: number; ndcg: number } | null = null;
        for (const blend of RERANK_BLEND_GRID) {
          const rows = dev.map((q) => {
            const p = prepared.get(q.id)!;
            return queryMetrics(rerankLit(p.lit, p.graph, p.cueVec, blend), p.rel);
          });
          const m = meanMetrics(rows);
          if (bestBlend === null || m.ndcg10 > bestBlend.ndcg + 1e-12) {
            bestBlend = { blend, ndcg: m.ndcg10 };
          }
        }
        const frozenBlend = bestBlend!.blend;

        // ---- 6) SCORE all three arms on TEST --------------------------------
        const idRankedByQ = new Map<string, string[]>();
        const hyRankedByQ = new Map<string, string[]>();
        const rrRankedByQ = new Map<string, string[]>();
        for (const q of test) {
          const p = prepared.get(q.id)!;
          idRankedByQ.set(q.id, p.lit.map((l) => l.id)); // pure-ID: energy order
          hyRankedByQ.set(q.id, hybridRetrieveFromSeed(p.graph, p.seed, p.cueVec, frozenHybrid));
          rrRankedByQ.set(q.id, rerankLit(p.lit, p.graph, p.cueVec, frozenBlend));
        }

        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id)!, prepared.get(q.id)!.rel)));

        const idOverall = metricsFor(test, idRankedByQ);
        const hyOverall = metricsFor(test, hyRankedByQ);
        const rrOverall = metricsFor(test, rrRankedByQ);

        const byCat = new Map<string, { id: RankMetrics; hy: RankMetrics; rr: RankMetrics; n: number }>();
        for (const cat of LOCOMO_CATEGORIES) {
          const qs = test.filter((q) => q.category === cat);
          if (qs.length === 0) continue;
          byCat.set(cat, {
            id: metricsFor(qs, idRankedByQ),
            hy: metricsFor(qs, hyRankedByQ),
            rr: metricsFor(qs, rrRankedByQ),
            n: qs.length,
          });
        }

        // ---- 7) HALTING quality (ID & ID+rerank, over TEST) -----------------
        const idHalt = summarizeHalting(test.map((q) => haltingQuality(idRankedByQ.get(q.id)!, prepared.get(q.id)!.rel)));
        const rrHalt = summarizeHalting(test.map((q) => haltingQuality(rrRankedByQ.get(q.id)!, prepared.get(q.id)!.rel)));

        // ---- 8) WRITE OUTPUT ------------------------------------------------
        const metricsJson = {
          meta: {
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            embedderRuntime: "@huggingface/transformers (Node-native ONNX)",
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsRaw: dataset.stats.totalQuestionsRaw,
            questionsKept: dataset.stats.questionsKept,
            questionsDropped: dataset.stats.questionsDropped,
            evidenceTokensTotal: dataset.stats.evidenceTokensTotal,
            evidenceTokensResolved: dataset.stats.evidenceTokensResolved,
            byCategoryKept: dataset.stats.byCategoryKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            frozenHybridConfig: frozenHybrid,
            frozenRerankBlend: frozenBlend,
            entityExtractionRule:
              "proper-noun phrases: tokens matching /^[A-Z][a-z]{2,}$/ (not in STOPWORDS) merged " +
              "across consecutive positions, lowercased; the two conversation speaker names excluded " +
              "as mention keys/cues; mention SHARED_ENTITY edges built for keys with DF in [2,25]. " +
              "Same rule applied to turns and to question cues.",
            seedingProtocol:
              "seed(q) = {turns mentioning a cue proper-noun entity} UNION {global vector top-1 by cosine}; " +
              "the SAME seed is handed to all three arms (ID energizes it as walk seeds; the hybrid uses it as " +
              "the graph-expansion root; ID+rerank inherits the ID lit set).",
            graphRule:
              "nodes = turns; CONFIRMED_LINK = same-session adjacency; SHARED_ENTITY = same speaker " +
              "(engine entity-index sibling fan + graph speaker adjacency) + shared mention (materialized edges).",
            hybridTuning: "grid s∈{5,10,20} × h∈{1,2} × k∈{10,30,60} × alpha∈{0.3,0.5,0.7}; max mean recall@10 on dev.",
            rerankTuning: `blend∈{${RERANK_BLEND_GRID.join(",")}} (blend·normActivation + (1−blend)·cosine); max mean nDCG@10 on dev.`,
          },
          overall: { PureID: idOverall, TunedHybrid: hyOverall, IDRerank: rrOverall },
          byCategory: Object.fromEntries(
            [...byCat.entries()].map(([c, r]) => [
              c,
              { n: r.n, PureID: r.id, TunedHybrid: r.hy, IDRerank: r.rr },
            ]),
          ),
          halting: { PureID: idHalt, IDRerank: rrHalt },
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // sanity (real numbers)
        expect(idOverall.recall10).toBeGreaterThan(0);
        expect(hyOverall.recall10).toBeGreaterThan(0);
        expect(rrOverall.recall10).toBeGreaterThan(0);

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
  const id: RankMetrics = m.overall.PureID;
  const hy: RankMetrics = m.overall.TunedHybrid;
  const rr: RankMetrics = m.overall.IDRerank;
  const L: string[] = [];

  L.push("# Retrieval-Quality Benchmark (Cycle B) — Real LoCoMo, 3 arms");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; ` +
      `**${meta.questionsKept}/${meta.questionsRaw} questions** kept ` +
      `(${meta.questionsDropped} dropped for unresolvable evidence); ` +
      `${meta.evidenceTokensResolved}/${meta.evidenceTokensTotal} evidence turn-ids resolved to the corpus. ` +
      `Split: **${meta.devQuestions} dev / ${meta.testQuestions} test** (stratified by category). ` +
      `Embedder: **${meta.embedder}**. All numbers below are on the **TEST split**, macro-averaged.`,
  );
  L.push("");

  // --- LEAD: 3-arm comparison ---
  L.push("## 1. Three-arm comparison (TEST, macro-averaged)");
  L.push("");
  L.push("| Metric | PureID | TunedHybrid | ID+Rerank | Best |");
  L.push("|---|---|---|---|---|");
  for (const [key, label] of RANK_KEYS) {
    const a = id[key], b = hy[key], c = rr[key];
    const max = Math.max(a, b, c);
    const best = max === a ? "PureID" : max === c ? "ID+Rerank" : "TunedHybrid";
    L.push(`| ${label} | ${f3(a)} | ${f3(b)} | ${f3(c)} | ${best} |`);
  }
  L.push("");

  // --- per-category ---
  L.push("## 2. Per-LoCoMo-category breakdown (recall@10 / nDCG@10 / MRR)");
  L.push("");
  L.push("| Category | n | Arm | recall@10 | nDCG@10 | MRR | precision@5 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const cat of LOCOMO_CATEGORIES) {
    const r = m.byCategory[cat];
    if (!r) continue;
    const row = (name: string, x: RankMetrics): void => {
      L.push(`| ${cat} | ${r.n} | ${name} | ${f3(x.recall10)} | ${f3(x.ndcg10)} | ${f3(x.mrr)} | ${f3(x.precision5)} |`);
    };
    row("PureID", r.PureID);
    row("TunedHybrid", r.TunedHybrid);
    row("ID+Rerank", r.IDRerank);
  }
  L.push("");

  // --- halting ---
  L.push("## 3. Halting quality (auto-halted lit set vs oracle best-K)");
  L.push("");
  L.push("| Quantity | PureID | ID+Rerank |");
  L.push("|---|---|---|");
  const hP = m.halting.PureID, hR = m.halting.IDRerank;
  L.push(`| mean \\|lit\\| (auto-halted size) | ${f3(hP.meanLitSize)} | ${f3(hR.meanLitSize)} |`);
  L.push(`| mean F1 (auto-halt) | ${f3(hP.meanAutoF1)} | ${f3(hR.meanAutoF1)} |`);
  L.push(`| mean F1 (oracle best-K) | ${f3(hP.meanOracleF1)} | ${f3(hR.meanOracleF1)} |`);
  L.push(`| F1(auto)/F1(oracle) | ${f3(hP.autoOverOracle)} | ${f3(hR.autoOverOracle)} |`);
  L.push(`| mean F1 @ K=5 | ${f3(hP.meanF1At5)} | ${f3(hR.meanF1At5)} |`);
  L.push(`| mean F1 @ K=10 | ${f3(hP.meanF1At10)} | ${f3(hR.meanF1At10)} |`);
  L.push(`| mean overshoot (\\|lit\\|−oracleK) | ${f3(hP.meanOvershoot)} | ${f3(hR.meanOvershoot)} |`);
  L.push("");
  L.push(
    `The lit SET (recall ceiling) is identical for PureID and ID+Rerank — reranking only reorders it. ` +
      `Auto-halt ${hP.meanOvershoot >= 0 ? "OVER" : "UNDER"}-shoots the F1-optimal prefix by ` +
      `~${f3(Math.abs(hP.meanOvershoot))} strands on average.`,
  );
  L.push("");

  // --- config / fairness ---
  L.push("## 4. Frozen config + fairness audit");
  L.push("");
  L.push("```");
  L.push(`hybrid (frozen on dev):  ${JSON.stringify(meta.frozenHybridConfig)}`);
  L.push(`rerank blend (frozen):   ${meta.frozenRerankBlend}`);
  L.push(`hybrid tuning:           ${meta.hybridTuning}`);
  L.push(`rerank tuning:           ${meta.rerankTuning}`);
  L.push(`entity-extraction rule:  ${meta.entityExtractionRule}`);
  L.push(`graph rule:              ${meta.graphRule}`);
  L.push(`seeding protocol:        ${meta.seedingProtocol}`);
  L.push(`category counts (kept):  ${JSON.stringify(meta.byCategoryKept)}`);
  L.push("```");
  L.push("");

  // --- verdict ---
  L.push("## 5. Verdict");
  L.push("");
  L.push(verdict(m, id, hy, rr));
  L.push("");
  return L.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verdict(m: any, id: RankMetrics, hy: RankMetrics, rr: RankMetrics): string {
  const dN = rr.ndcg10 - hy.ndcg10;
  const dM = rr.mrr - hy.mrr;
  const mh = m.byCategory["multi-hop"];
  const mhStr = mh
    ? `On multi-hop (n=${mh.n}): PureID recall@10 ${f3(mh.PureID.recall10)}, Hybrid ${f3(mh.TunedHybrid.recall10)}, ID+Rerank ${f3(mh.IDRerank.recall10)} (nDCG@10 ${f3(mh.IDRerank.ndcg10)} vs Hybrid ${f3(mh.TunedHybrid.ndcg10)}).`
    : "";
  const beat = dN > 1e-3 && dM > 1e-3;
  return (
    `On aggregate nDCG@10 ID+Rerank ${dN >= 0 ? "leads" : "trails"} the tuned hybrid by ${dN >= 0 ? "+" : ""}${f3(dN)} ` +
    `(MRR ${dM >= 0 ? "+" : ""}${f3(dM)}); pure-ID activation order alone scores nDCG@10 ${f3(id.ndcg10)}. ` +
    `So adding the cosine ranking discriminator ${beat ? "DOES" : "does NOT cleanly"} let ID match/beat the pure hybrid on ranking. ` +
    mhStr +
    ` Pure ID's structural reach is a recall ceiling; the rerank inherits that ceiling and adds the ranking signal ID lacks.`
  );
}
