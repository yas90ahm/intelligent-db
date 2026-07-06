/**
 * retrieval/locomoMem0Runner.test.ts — mem0 COMPETITOR ARM for the real-LoCoMo retrieval
 * bench (survey gap closed: BENCH_RERUN_2026-07-06.md §4 flagged "mem0 arm on LoCoMo / QA
 * end-task benches — not built... feasible... but new harness infrastructure").
 *
 * Reuses the SAME real LoCoMo corpus, the SAME dev/test split, and the SAME
 * recall@k/precision@k/nDCG@10/MRR metrics (`metrics.ts`) as `locomoRunner.test.ts` /
 * `locomoMultiSeedRunner.test.ts`. In THIS SAME test run it (a) re-tunes and scores the
 * four in-house arms (PureID, ID+Rerank, MultiSeedID, TunedHybrid — identical methodology
 * to cycles B/E, just re-executed here so the comparison is same-run) and (b) drives the
 * GENERIC mem0 sidecar (`reasoning/mem0Arm.ts`'s `Mem0Sidecar` — the same
 * build-a-bank/search-by-text protocol the reasoning bench uses, unmodified) as a FIFTH
 * arm: mem0 is fully local (Ollama LLM + embedder, embedded Qdrant), uses its OWN
 * embedder/store/ranking, and ingests the SAME corpus turns (`infer=False`, i.e. mem0
 * stores each turn verbatim rather than LLM-summarizing it — a fair like-for-like ingest,
 * not mem0's fact-extraction mode) and answers the SAME question cue texts mem0 sees fit.
 *
 * mem0 has no notion of "one shared graph across conversations" — each LoCoMo conversation
 * is a self-contained retrieval scope (ground-truth evidence never crosses conversations),
 * so mem0 gets ONE sidecar (one embedded-Qdrant collection) PER CONVERSATION, built from
 * that conversation's turns only, then queried only with that conversation's TEST
 * questions — the same conversation-scoping every IDB arm already gets for free from its
 * per-conversation graph/store.
 *
 * Gated behind RETRIEVAL_BENCH=1 AND MEM0_BENCH=1 (both) so a plain `npm test` — and a
 * bare `RETRIEVAL_BENCH=1` run of the other retrieval runners — never spawns the mem0
 * venv. To run:
 *
 *     RETRIEVAL_BENCH=1 MEM0_BENCH=1 npx vitest run src/__bench__/retrieval/locomoMem0Runner.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.1.mem0/.
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
  multiSeedRetrieve,
  HYBRID_GRID,
  RERANK_BLEND_GRID,
  MULTISEED_K_GRID,
  type HybridConfig,
  type LitEnergy,
} from "./retrievers.js";
import { queryMetrics, meanMetrics, type RankMetrics } from "./metrics.js";
import { ollamaHost } from "./qa/ollama.js";
import { Mem0Sidecar, type Mem0Options } from "../reasoning/mem0Arm.js";

// mem0's telemetry path defaults to a FIXED global directory (`~/.mem0/migrations_qdrant`)
// shared by every mem0 process on the machine — an embedded-Qdrant client only allows one
// process to open a given storage folder at a time, so a concurrent mem0 sidecar elsewhere
// (another bench lane, or our own next conversation's sidecar racing a slow shutdown)
// throws "already accessed by another instance of Qdrant client" at construction. Disabling
// telemetry (mem0's own documented env knob) skips that shared path entirely (same fix as
// `crossdb/adapters/mem0.ts`) — our own per-conversation `qdrantPath` below was never the
// colliding resource.
if (process.env["MEM0_TELEMETRY"] === undefined) process.env["MEM0_TELEMETRY"] = "False";

const RUN = process.env["RETRIEVAL_BENCH"] === "1" && process.env["MEM0_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.1.mem0";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

const MEM0_PYTHON =
  process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = Number(process.env["MEM0_EMBED_DIMS"] ?? "768");
const MEM0_SEARCH_K = 20; // >= max(recall@k) we score (recall@20)

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

/** SHARED per-query seed (cycle B): entity-match (cue proper nouns) ∪ vector top-1. */
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
  readonly rel: Set<string>;
  readonly convId: string;
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — mem0 competitor arm vs PureID/ID+Rerank/MultiSeedID/TunedHybrid",
  () => {
    it(
      "ingests the real LoCoMo corpus into mem0 per-conversation, scores it vs the 4 IDB arms (same run)",
      async () => {
        // ---- 1) DATASET ------------------------------------------------------
        const path = await locateLocomoJson();
        const dataset: LocomoDataset = loadLocomo(readFileSync(path, "utf8"));
        const convs = dataset.conversations;
        expect(convs.length).toBeGreaterThanOrEqual(5);
        expect(dataset.stats.questionsKept).toBeGreaterThan(100);

        // ---- 2) EMBED (MiniLM, shared across the 4 IDB arms; cached) --------
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

        // ---- 3) PER-CONVERSATION graph + ID retriever ------------------------
        const graphByConv = new Map<string, SharedGraph>();
        const idByConv = new Map<string, ReturnType<typeof createLocomoIdRetriever>>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          idByConv.set(c.convId, createLocomoIdRetriever(c));
        }

        // ---- 4) PREPARE every question ---------------------------------------
        const prepared = new Map<string, Prepared>();
        for (const c of convs) {
          const g = graphByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            const seed = locomoSeed(g, q, cueVec);
            prepared.set(q.id, { q, graph: g, cueVec, seed, rel: new Set(q.relevant), convId: c.convId });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        const singleLitFor = (qid: string): LitEnergy[] => {
          const p = prepared.get(qid)!;
          return idByConv.get(p.convId)!.retrieveLit(p.seed);
        };

        // ---- 5) TUNE the hybrid on DEV (max mean recall@10), FREEZE ----------
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

        // ---- 5b) TUNE the ID+rerank blend on DEV (max mean nDCG@10), FREEZE --
        let bestBlend: { blend: number; ndcg: number } | null = null;
        for (const blend of RERANK_BLEND_GRID) {
          const rows = dev.map((q) => {
            const p = prepared.get(q.id)!;
            return queryMetrics(rerankLit(singleLitFor(q.id), p.graph, p.cueVec, blend), p.rel);
          });
          const m = meanMetrics(rows);
          if (bestBlend === null || m.ndcg10 > bestBlend.ndcg + 1e-12) {
            bestBlend = { blend, ndcg: m.ndcg10 };
          }
        }
        const frozenBlend = bestBlend!.blend;

        // ---- 5c) TUNE the multi-seed k on DEV (max mean recall@20), FREEZE ---
        const multiFor = (qid: string, k: number): { lit: LitEnergy[]; ranked: string[] } => {
          const p = prepared.get(qid)!;
          const r = multiSeedRetrieve(idByConv.get(p.convId)!, p.graph, p.cueVec, k, frozenBlend);
          return { lit: r.lit, ranked: r.ranked };
        };
        let bestK: { k: number; recall20: number; ndcg: number } | null = null;
        for (const k of MULTISEED_K_GRID) {
          const rows = dev.map((q) => queryMetrics(multiFor(q.id, k).ranked, prepared.get(q.id)!.rel));
          const m = meanMetrics(rows);
          if (
            bestK === null ||
            m.recall20 > bestK.recall20 + 1e-12 ||
            (Math.abs(m.recall20 - bestK.recall20) <= 1e-12 && m.ndcg10 > bestK.ndcg + 1e-12)
          ) {
            bestK = { k, recall20: m.recall20, ndcg: m.ndcg10 };
          }
        }
        const frozenK = bestK!.k;

        // ---- 6) SCORE the 4 IDB arms on TEST ---------------------------------
        const rankPureID = new Map<string, string[]>();
        const rankIDRerank = new Map<string, string[]>();
        const rankMultiSeed = new Map<string, string[]>();
        const rankHybrid = new Map<string, string[]>();
        for (const q of test) {
          const p = prepared.get(q.id)!;
          const sl = singleLitFor(q.id);
          rankPureID.set(q.id, sl.map((l) => l.id));
          rankIDRerank.set(q.id, rerankLit(sl, p.graph, p.cueVec, frozenBlend));
          rankMultiSeed.set(q.id, multiFor(q.id, frozenK).ranked);
          rankHybrid.set(q.id, hybridRetrieveFromSeed(p.graph, p.seed, p.cueVec, frozenHybrid));
        }

        // ---- 7) mem0 ARM: one sidecar PER CONVERSATION -----------------------
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
        let searchedQuestions = 0;
        const t0 = process.hrtime.bigint();
        for (const c of convs) {
          const qs = testByConv.get(c.convId) ?? [];
          if (qs.length === 0) continue; // nothing to score for this conversation
          const qdrantPath = join(tmpdir(), `idb-mem0-locomo-${c.convId.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`);
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
              searchedQuestions += 1;
              const ranked = hits
                .map((h) => c.turns[h.idx]?.id)
                .filter((id): id is string => id !== undefined);
              rankMem0.set(q.id, ranked);
            }
            process.stderr.write(
              `[locomoMem0] conv=${c.convId} turns=${c.turns.length} testQs=${qs.length} ` +
                `ingestMs=${ingestMs.toFixed(0)} searchMs=${searchMs.toFixed(0)}\n`,
            );
          } finally {
            await sc.close();
            try { rmSync(qdrantPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }
        const totalMem0Ms = Number(process.hrtime.bigint() - t0) / 1e6;

        // ---- 8) METRICS --------------------------------------------------------
        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id) ?? [], prepared.get(q.id)!.rel)));

        // mem0 only scores over questions it was actually asked (conversations with >=1
        // test question — i.e. all of TEST, since every conversation has test questions).
        const mem0Test = test.filter((q) => rankMem0.has(q.id));

        const overall = {
          PureID: metricsFor(test, rankPureID),
          IDRerank: metricsFor(test, rankIDRerank),
          MultiSeedID: metricsFor(test, rankMultiSeed),
          TunedHybrid: metricsFor(test, rankHybrid),
          mem0: metricsFor(mem0Test, rankMem0),
        };

        const byCat = new Map<
          string,
          { n: number; nMem0: number; PureID: RankMetrics; IDRerank: RankMetrics; MultiSeedID: RankMetrics; TunedHybrid: RankMetrics; mem0: RankMetrics }
        >();
        for (const cat of LOCOMO_CATEGORIES) {
          const qs = test.filter((q) => q.category === cat);
          if (qs.length === 0) continue;
          const qsMem0 = qs.filter((q) => rankMem0.has(q.id));
          byCat.set(cat, {
            n: qs.length,
            nMem0: qsMem0.length,
            PureID: metricsFor(qs, rankPureID),
            IDRerank: metricsFor(qs, rankIDRerank),
            MultiSeedID: metricsFor(qs, rankMultiSeed),
            TunedHybrid: metricsFor(qs, rankHybrid),
            mem0: metricsFor(qsMem0, rankMem0),
          });
        }

        // ---- 9) WRITE OUTPUT ----------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.1.mem0 — mem0 competitor arm on real LoCoMo (same-run vs 4 IDB arms)",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            mem0Llm: MEM0_LLM,
            mem0Embed: MEM0_EMBED,
            mem0EmbedDims: MEM0_EMBED_DIMS,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            mem0ScoredQuestions: mem0Test.length,
            frozenHybridConfig: frozenHybrid,
            frozenRerankBlend: frozenBlend,
            frozenMultiSeedK: frozenK,
            mem0SearchK: MEM0_SEARCH_K,
            mem0IngestedItems: ingestedItems,
            mem0IngestMs: Math.round(ingestMs),
            mem0IngestItemsPerSec: ingestMs > 0 ? Math.round((ingestedItems / ingestMs) * 1000) : 0,
            mem0SearchMs: Math.round(searchMs),
            mem0SearchedQuestions: searchedQuestions,
            mem0MeanSearchMs: searchedQuestions > 0 ? searchMs / searchedQuestions : 0,
            mem0TotalWallMs: Math.round(totalMem0Ms),
            fairness:
              "mem0 gets ONE sidecar (embedded-Qdrant collection) per LoCoMo conversation, built from that " +
              "conversation's turns only (mem.add(text, infer=False) — same-run ingest, no LLM summarization), " +
              "and is queried ONLY with that conversation's TEST question cue texts (mem.search) — the same " +
              "conversation-scoping the 4 IDB arms get for free from their per-conversation graph/store. The 4 " +
              "IDB arms (PureID / ID+Rerank / MultiSeedID / TunedHybrid) are re-tuned on DEV and re-scored on " +
              "TEST in THIS SAME run (identical methodology to experiments/1.1 and 1.1.1.1.1) so every number " +
              "in this report comes from one process invocation.",
          },
          overall,
          byCategory: Object.fromEntries([...byCat.entries()].map(([c, r]) => [c, r])),
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity (real numbers, real wiring) --------------------------------
        expect(ingestedItems).toBe(dataset.stats.totalTurns);
        expect(mem0Test.length).toBe(test.length); // every test question got a mem0 answer
        expect(overall.PureID.recall10).toBeGreaterThan(0);
        expect(overall.TunedHybrid.recall10).toBeGreaterThan(0);
        expect(Number.isFinite(overall.mem0.recall10)).toBe(true);

        // ---- cleanup temp caches ------------------------------------------------
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
  const arms: Array<[string, RankMetrics]> = [
    ["PureID", m.overall.PureID],
    ["ID+Rerank", m.overall.IDRerank],
    ["MultiSeedID", m.overall.MultiSeedID],
    ["TunedHybrid", m.overall.TunedHybrid],
    ["mem0", m.overall.mem0],
  ];
  const L: string[] = [];

  L.push("# LoCoMo retrieval bench — mem0 competitor arm (same-run vs 4 IDB arms)");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; ` +
      `**${meta.questionsKept} questions kept**. Split: **${meta.devQuestions} dev / ${meta.testQuestions} test**. ` +
      `mem0 scored **${meta.mem0ScoredQuestions}/${meta.testQuestions}** TEST questions ` +
      `(mem0: llm=${meta.mem0Llm}, embed=${meta.mem0Embed}(${meta.mem0EmbedDims}d), fully local Ollama+embedded-Qdrant; ` +
      `IDB embedder: ${meta.embedder}). All numbers below are on the TEST split, macro-averaged.`,
  );
  L.push("");
  L.push(
    `mem0 ingest: **${meta.mem0IngestedItems} items** in ${meta.mem0IngestMs}ms ` +
      `(**${meta.mem0IngestItemsPerSec} items/sec**). mem0 search: ${meta.mem0SearchedQuestions} queries, ` +
      `${meta.mem0SearchMs}ms total (mean ${meta.mem0MeanSearchMs.toFixed(1)}ms/query). ` +
      `Total mem0 wall time: ${meta.mem0TotalWallMs}ms.`,
  );
  L.push("");

  L.push("## 1. Five-arm comparison (TEST, macro-averaged)");
  L.push("");
  L.push("| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid | mem0 | Best |");
  L.push("|---|---|---|---|---|---|---|");
  for (const [key, label] of RANK_KEYS) {
    const vals = arms.map(([, r]) => r[key]);
    const max = Math.max(...vals);
    const best = arms[vals.indexOf(max)]![0];
    L.push(`| ${label} | ${vals.map(f3).join(" | ")} | ${best} |`);
  }
  L.push("");

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
    row("ID+Rerank", r.IDRerank);
    row("MultiSeedID", r.MultiSeedID);
    row("TunedHybrid", r.TunedHybrid);
    row(`mem0 (n=${r.nMem0})`, r.mem0);
  }
  L.push("");

  L.push("## 3. Frozen config + fairness audit");
  L.push("");
  L.push("```");
  L.push(`hybrid (frozen this run):     ${JSON.stringify(meta.frozenHybridConfig)}`);
  L.push(`rerank blend (frozen):        ${meta.frozenRerankBlend}`);
  L.push(`multi-seed k (frozen):        ${meta.frozenMultiSeedK}`);
  L.push(`mem0 search top_k:            ${meta.mem0SearchK}`);
  L.push(`fairness:                     ${meta.fairness}`);
  L.push("```");
  L.push("");

  const hy: RankMetrics = m.overall.TunedHybrid;
  const mm: RankMetrics = m.overall.mem0;
  const dR10 = mm.recall10 - hy.recall10;
  const dN = mm.ndcg10 - hy.ndcg10;
  L.push("## 4. Verdict");
  L.push("");
  L.push(
    `mem0 recall@10 ${f3(mm.recall10)} vs TunedHybrid ${f3(hy.recall10)} (${dR10 >= 0 ? "+" : ""}${f3(dR10)}); ` +
      `nDCG@10 ${f3(mm.ndcg10)} vs ${f3(hy.ndcg10)} (${dN >= 0 ? "+" : ""}${f3(dN)}). ` +
      `mem0 ${dR10 > 1e-3 ? "beats" : dR10 < -1e-3 ? "trails" : "roughly matches"} the frozen tuned hybrid on recall@10 on this run.`,
  );
  L.push("");
  return L.join("\n");
}
