/**
 * retrieval/locomoMultiSeedRunner.test.ts — CYCLE E: MULTI-SEED activation walk (gated).
 *
 * The diagnosis from cycles C+D: PureID's coverage cap is the SEED + walk REACH (not the
 * halt, not the graph — the oracle best-K ceiling ≈ the full-lit recall). The tuned
 * hybrid wins deep recall because its VECTOR channel retrieves evidence DIRECTLY, while
 * the single-seed activation walk starts from one entity/top-1 seed and never reaches the
 * evidence turns.
 *
 * HYPOTHESIS: seed the SAME engine's activation walk at the top-k VECTOR-NEAREST turns to
 * the cue (the SAME vector-kNN entry the hybrid consumes), so the walk STARTS near the
 * evidence; activation+provenance then expands (multi-hop) and the cosine rerank ranks
 * from a good entry — closing coverage while keeping ID's structural wins.
 *
 * EXPERIMENT (apples-to-apples): a MultiSeedID arm whose seed is the top-k cosine-nearest
 * turns; k is grid-tuned on the DEV split (max mean recall@20, nDCG@10 tie-break), FROZEN,
 * and scored on TEST. The cosine rerank blend is REUSED FROZEN from cycle B (0.2); the
 * TunedHybrid config is REUSED FROZEN from cycle B (NOT re-tuned). This makes the contrast
 * exact: MultiSeedID and the hybrid both enter through vector-kNN; the ONLY difference is
 * expansion+ranking — activation-walk + provenance (MultiSeedID) vs k-hop graph + RRF
 * (hybrid). Arms kept for context: PureID (cycle-B single-seed), ID+Rerank (cycle-B).
 *
 * ADDITIVE / ADAPTER-LEVEL ONLY: the multi-seed entry rides through retrieveLit(seed) →
 * recall({ seeds }); no engine source (api/traversal/core/store/identity) is modified.
 *
 * Gated behind RETRIEVAL_BENCH=1 (a plain `npm test` never loads the embedder / dataset):
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoMultiSeedRunner.test.ts
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.1/.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { DEFAULT_WALK_CONFIG } from "../../index.js";
import { embedTexts, cachePathFor, MODEL_ID } from "./embed.js";
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
  rerankLit,
  multiSeedRetrieve,
  MULTISEED_K_GRID,
  type HybridConfig,
  type LitEnergy,
} from "./retrievers.js";
import {
  queryMetrics,
  meanMetrics,
  type RankMetrics,
} from "./metrics.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.1";
const CYCLE_B_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

// Frozen cycle-B knobs (reused, NOT re-tuned). Loaded from cycle B's metrics.json when
// present; these literals are the audited fallbacks.
const CYCLE_B_HYBRID_FALLBACK: HybridConfig = { s: 5, h: 1, k: 10, alpha: 0.5 };
const CYCLE_B_RERANK_BLEND_FALLBACK = 0.2;

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

/** SHARED single-seed (cycle B): entity-match (cue proper nouns) ∪ vector top-1. */
function locomoSeed(graph: SharedGraph, q: LocomoQuestion, cueVec: Float32Array): string[] {
  const set = new Set<string>();
  for (const e of q.cueEntities) for (const id of graph.entityFacts(e)) set.add(id);
  set.add(vectorTop1(graph, cueVec));
  return [...set];
}

/** Fraction of a question's ground-truth evidence turns present in a lit set. */
function reachability(lit: readonly LitEnergy[], rel: ReadonlySet<string>): number {
  if (rel.size === 0) return 0;
  const ids = new Set(lit.map((l) => l.id));
  let hit = 0;
  for (const r of rel) if (ids.has(r)) hit++;
  return hit / rel.size;
}

interface Prepared {
  readonly q: LocomoQuestion;
  readonly graph: SharedGraph;
  readonly cueVec: Float32Array;
  readonly seed: string[]; // cycle-B single seed
  readonly rel: Set<string>;
  readonly idConvId: string;
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — MULTI-SEED: PureID / ID+Rerank / MultiSeedID vs frozen TunedHybrid",
  () => {
    it(
      "grid-tunes the vector-kNN seed size k on dev (max MultiSeedID recall@20), freezes, scores all arms on test, emits reachability + cost",
      async () => {
        // ---- 1) DATASET -----------------------------------------------------
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

        // ---- 3) PER-CONVERSATION graph + ID retriever ----------------------
        const graphByConv = new Map<string, SharedGraph>();
        const idByConv = new Map<string, ReturnType<typeof createLocomoIdRetriever>>();
        for (const c of convs) {
          const g = buildLocomoGraph(c, (id) => vecByTurn.get(id)!);
          graphByConv.set(c.convId, g);
          idByConv.set(c.convId, createLocomoIdRetriever(c));
        }

        // ---- 4) PREPARE every question (single-seed computed ONCE) ----------
        const prepared = new Map<string, Prepared>();
        for (const c of convs) {
          const g = graphByConv.get(c.convId)!;
          for (const q of c.questions) {
            const cueVec = vecByQuestion.get(q.id)!;
            const seed = locomoSeed(g, q, cueVec);
            prepared.set(q.id, { q, graph: g, cueVec, seed, rel: new Set(q.relevant), idConvId: c.convId });
          }
        }

        const { dev, test } = splitLocomo(allQuestions, 0.3);

        // ---- 5) Reuse the FROZEN cycle-B hybrid config + rerank blend -------
        let frozenHybrid: HybridConfig = CYCLE_B_HYBRID_FALLBACK;
        let frozenBlend = CYCLE_B_RERANK_BLEND_FALLBACK;
        try {
          const cb = JSON.parse(readFileSync(join(CYCLE_B_DIR, "metrics.json"), "utf8")) as {
            meta?: { frozenHybridConfig?: HybridConfig; frozenRerankBlend?: number };
          };
          if (cb.meta?.frozenHybridConfig) frozenHybrid = cb.meta.frozenHybridConfig;
          if (typeof cb.meta?.frozenRerankBlend === "number") frozenBlend = cb.meta.frozenRerankBlend;
        } catch { /* fallbacks */ }

        // Helper: single-seed pure-ID lit (cycle-B), DEFAULT config.
        const singleLitFor = (qid: string): LitEnergy[] => {
          const p = prepared.get(qid)!;
          return idByConv.get(p.idConvId)!.retrieveLit(p.seed);
        };
        // Helper: multi-seed (top-k vector-kNN) retrieve, DEFAULT config, frozen blend.
        const multiFor = (qid: string, k: number): { lit: LitEnergy[]; ranked: string[] } => {
          const p = prepared.get(qid)!;
          const r = multiSeedRetrieve(idByConv.get(p.idConvId)!, p.graph, p.cueVec, k, frozenBlend);
          return { lit: r.lit, ranked: r.ranked };
        };

        // ---- 6) SWEEP k over DEV: maximize MultiSeedID recall@20 -----------
        interface KTune { k: number; recall20: number; ndcg: number; meanLit: number; reach: number; }
        let best: KTune | null = null;
        const kTrace: KTune[] = [];
        for (const k of MULTISEED_K_GRID) {
          const rows: RankMetrics[] = [];
          let litSum = 0;
          let reachSum = 0;
          for (const q of dev) {
            const { lit, ranked } = multiFor(q.id, k);
            const p = prepared.get(q.id)!;
            rows.push(queryMetrics(ranked, p.rel));
            litSum += lit.length;
            reachSum += reachability(lit, p.rel);
          }
          const m = meanMetrics(rows);
          const t: KTune = {
            k,
            recall20: m.recall20,
            ndcg: m.ndcg10,
            meanLit: litSum / (dev.length || 1),
            reach: reachSum / (dev.length || 1),
          };
          kTrace.push(t);
          if (
            best === null ||
            t.recall20 > best.recall20 + 1e-12 ||
            (Math.abs(t.recall20 - best.recall20) <= 1e-12 && t.ndcg > best.ndcg + 1e-12)
          ) {
            best = t;
          }
        }
        const frozenK = best!.k;

        // ---- 7) SCORE on TEST: 4 arms --------------------------------------
        // Per-question single-seed lit (computed once), and multi-seed lit at frozen k.
        const singleLit = new Map<string, LitEnergy[]>();
        const multiLit = new Map<string, LitEnergy[]>();
        const rankPureID = new Map<string, string[]>();      // single-seed, energy order
        const rankIDRerank = new Map<string, string[]>();    // single-seed, cosine rerank
        const rankMultiSeed = new Map<string, string[]>();   // top-k seed, cosine rerank
        const rankHybrid = new Map<string, string[]>();      // frozen RRF hybrid
        for (const q of test) {
          const p = prepared.get(q.id)!;
          const sl = singleLitFor(q.id);
          singleLit.set(q.id, sl);
          rankPureID.set(q.id, sl.map((l) => l.id));
          rankIDRerank.set(q.id, rerankLit(sl, p.graph, p.cueVec, frozenBlend));
          const ms = multiFor(q.id, frozenK);
          multiLit.set(q.id, ms.lit);
          rankMultiSeed.set(q.id, ms.ranked);
          rankHybrid.set(q.id, hybridRetrieveFromSeed(p.graph, p.seed, p.cueVec, frozenHybrid));
        }

        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id)!, prepared.get(q.id)!.rel)));

        const overall = {
          PureID: metricsFor(test, rankPureID),
          IDRerank: metricsFor(test, rankIDRerank),
          MultiSeedID: metricsFor(test, rankMultiSeed),
          TunedHybrid: metricsFor(test, rankHybrid),
        };

        // Per-category.
        interface CatRow {
          n: number;
          PureID: RankMetrics;
          IDRerank: RankMetrics;
          MultiSeedID: RankMetrics;
          TunedHybrid: RankMetrics;
        }
        const byCat = new Map<string, CatRow>();
        for (const cat of LOCOMO_CATEGORIES) {
          const qs = test.filter((q) => q.category === cat);
          if (qs.length === 0) continue;
          byCat.set(cat, {
            n: qs.length,
            PureID: metricsFor(qs, rankPureID),
            IDRerank: metricsFor(qs, rankIDRerank),
            MultiSeedID: metricsFor(qs, rankMultiSeed),
            TunedHybrid: metricsFor(qs, rankHybrid),
          });
        }

        // ---- 8) REACHABILITY: single-seed vs multi-seed (TEST) -------------
        let reachSingle = 0;
        let reachMulti = 0;
        let litSingle = 0;
        let litMulti = 0;
        for (const q of test) {
          const p = prepared.get(q.id)!;
          const sl = singleLit.get(q.id)!;
          const ml = multiLit.get(q.id)!;
          reachSingle += reachability(sl, p.rel);
          reachMulti += reachability(ml, p.rel);
          litSingle += sl.length;
          litMulti += ml.length;
        }
        const nTest = test.length || 1;
        const reach = {
          single: reachSingle / nTest,
          multi: reachMulti / nTest,
          meanLitSingle: litSingle / nTest,
          meanLitMulti: litMulti / nTest,
        };

        // ---- 9) COST: recall latency single vs multi (wall-clock) ----------
        const timeSingle = (): { totalMs: number; meanMs: number; n: number } => {
          const t0 = process.hrtime.bigint();
          let n = 0;
          for (const q of test) { singleLitFor(q.id); n++; }
          const t1 = process.hrtime.bigint();
          const totalMs = Number(t1 - t0) / 1e6;
          return { totalMs, meanMs: totalMs / (n || 1), n };
        };
        const timeMulti = (): { totalMs: number; meanMs: number; n: number } => {
          const t0 = process.hrtime.bigint();
          let n = 0;
          for (const q of test) { multiFor(q.id, frozenK); n++; }
          const t1 = process.hrtime.bigint();
          const totalMs = Number(t1 - t0) / 1e6;
          return { totalMs, meanMs: totalMs / (n || 1), n };
        };
        const latSingle = timeSingle();
        const latMulti = timeMulti();

        // ---- 10) WRITE OUTPUT ----------------------------------------------
        const metricsJson = {
          meta: {
            cycle: "E (multi-seed: vector-kNN seeded activation walk, adapter-level)",
            experiment: "1.1.1.1.1 — MultiSeedID: seed the activation walk at the top-k cosine-nearest turns",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            defaultWalkConfig: DEFAULT_WALK_CONFIG,
            multiseedKGrid: MULTISEED_K_GRID,
            frozenK,
            frozenRerankBlend: frozenBlend,
            frozenHybridConfig: frozenHybrid,
            tuning:
              "k∈{" + MULTISEED_K_GRID.join(",") + "} on dev; max mean MultiSeedID recall@20 (nDCG@10 tie-break). " +
              "Rerank blend + hybrid config REUSED FROZEN from cycle B (experiments/1.1); engine src/ untouched.",
            fairness:
              "MultiSeedID seeds the walk at the SAME vector-kNN entry (top-k cosine) the hybrid's vector channel uses; " +
              "the ONLY difference is expansion+ranking — activation-walk+provenance vs k-hop graph+RRF.",
            kTrace,
          },
          overall,
          byCategory: Object.fromEntries([...byCat.entries()].map(([c, r]) => [c, r])),
          reachability: reach,
          cost: {
            meanLitSingle: reach.meanLitSingle,
            meanLitMulti: reach.meanLitMulti,
            litMultiple: reach.meanLitMulti / (reach.meanLitSingle || 1),
            latencySingle: latSingle,
            latencyMulti: latMulti,
            latencyMultiple: latMulti.meanMs / (latSingle.meanMs || 1),
            precision1: {
              PureID: overall.PureID.precision1,
              IDRerank: overall.IDRerank.precision1,
              MultiSeedID: overall.MultiSeedID.precision1,
              TunedHybrid: overall.TunedHybrid.precision1,
            },
          },
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- determinism / sanity guards -----------------------------------
        // Reproduce cycle B's PureID recall@20 within tolerance (same pipeline → same numbers).
        try {
          const cb = JSON.parse(readFileSync(join(CYCLE_B_DIR, "metrics.json"), "utf8")) as {
            overall?: { PureID?: RankMetrics };
          };
          if (cb.overall?.PureID) {
            expect(Math.abs(overall.PureID.recall20 - cb.overall.PureID.recall20)).toBeLessThan(0.02);
          }
        } catch { /* cycle B optional */ }
        expect(overall.MultiSeedID.recall20).toBeGreaterThan(0);
        // Multi-seed must not REDUCE seed→evidence reachability vs single-seed.
        expect(reach.multi).toBeGreaterThanOrEqual(reach.single - 1e-9);

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
  const o = m.overall;
  const L: string[] = [];

  L.push("# Retrieval-Quality Benchmark (Cycle E) — MULTI-SEED activation walk on real LoCoMo");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; ` +
      `**${meta.questionsKept} questions** kept. Split: **${meta.devQuestions} dev / ${meta.testQuestions} test** ` +
      `(stratified). Embedder: **${meta.embedder}**. All numbers on the **TEST split**, macro-averaged. ` +
      `MultiSeedID seeds the engine's activation walk at the **top-k cosine-nearest turns** to the cue (the SAME ` +
      `vector-kNN entry the hybrid uses); k was grid-tuned on **dev** (max recall@20). The rerank blend and the ` +
      `TunedHybrid config are **reused frozen from cycle B**. Engine src/ is untouched (adapter-level seeding only).`,
  );
  L.push("");
  L.push("```");
  L.push(`frozen MultiSeed k:       ${meta.frozenK}   (swept over {${meta.multiseedKGrid.join(",")}} on dev)`);
  L.push(`frozen rerank blend:      ${meta.frozenRerankBlend}   (reused from cycle B)`);
  L.push(`frozen TunedHybrid:       ${JSON.stringify(meta.frozenHybridConfig)}   (reused from cycle B)`);
  L.push("```");
  L.push("");

  // --- LEAD: 4-arm table ---
  L.push("## 1. Four-arm comparison (TEST)");
  L.push("");
  L.push("| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid (frozen) |");
  L.push("|---|---|---|---|---|");
  for (const [key, label] of RANK_KEYS) {
    L.push(`| ${label} | ${f3(o.PureID[key])} | ${f3(o.IDRerank[key])} | ${f3(o.MultiSeedID[key])} | ${f3(o.TunedHybrid[key])} |`);
  }
  L.push("");
  const gapMulti20 = o.MultiSeedID.recall20 - o.TunedHybrid.recall20;
  const gapRerank20 = o.IDRerank.recall20 - o.TunedHybrid.recall20;
  L.push(
    `recall@20 gap to hybrid: ID+Rerank **${gapRerank20 >= 0 ? "+" : ""}${f3(gapRerank20)}** → ` +
      `MultiSeedID **${gapMulti20 >= 0 ? "+" : ""}${f3(gapMulti20)}** ` +
      `(${gapMulti20 >= -1e-9 ? "CLOSED/overtook" : "narrowed but not closed"}).`,
  );
  L.push("");

  // --- per-category ---
  L.push("## 2. Per-LoCoMo-category breakdown (recall@20 / recall@10 / nDCG@10 / MRR / precision@5)");
  L.push("");
  L.push("| Category | n | Arm | recall@20 | recall@10 | nDCG@10 | MRR | precision@5 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const cat of ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]) {
    const r = m.byCategory[cat];
    if (!r) continue;
    const row = (name: string, key: string): void => {
      const x: RankMetrics = r[key];
      L.push(`| ${cat} | ${r.n} | ${name} | ${f3(x.recall20)} | ${f3(x.recall10)} | ${f3(x.ndcg10)} | ${f3(x.mrr)} | ${f3(x.precision5)} |`);
    };
    row("PureID", "PureID");
    row("ID+Rerank", "IDRerank");
    row("MultiSeedID", "MultiSeedID");
    row("TunedHybrid", "TunedHybrid");
  }
  L.push("");

  // --- reachability + cost ---
  L.push("## 3. Seed→evidence reachability (the diagnostic) + honest cost");
  L.push("");
  const rc = m.reachability;
  const c = m.cost;
  L.push("| Quantity | Single-seed (cycle B) | Multi-seed (frozen k) | Change |");
  L.push("|---|---|---|---|");
  L.push(`| seed→evidence reachability (mean frac of evidence turns in lit set) | ${f3(rc.single)} | ${f3(rc.multi)} | ${(rc.multi - rc.single >= 0 ? "+" : "")}${f3(rc.multi - rc.single)} |`);
  L.push(`| mean \\|lit\\| (auto-halted size) | ${f3(c.meanLitSingle)} | ${f3(c.meanLitMulti)} | ${c.litMultiple.toFixed(2)}× |`);
  L.push(`| mean recall latency / query (ms) | ${f3(c.latencySingle.meanMs)} | ${f3(c.latencyMulti.meanMs)} | ${c.latencyMultiple.toFixed(2)}× |`);
  L.push(`| precision@1 (PureID / ID+Rerank / MultiSeedID / hybrid) | ${f3(c.precision1.PureID)} / ${f3(c.precision1.IDRerank)} | — | MultiSeedID ${f3(c.precision1.MultiSeedID)} vs hybrid ${f3(c.precision1.TunedHybrid)} |`);
  L.push("");
  L.push("k-sweep on dev (recall@20 / nDCG@10 / mean |lit| / reachability):");
  L.push("");
  L.push("| k | recall@20 | nDCG@10 | mean \\|lit\\| | reachability |");
  L.push("|---|---|---|---|---|");
  for (const t of m.meta.kTrace) {
    L.push(`| ${t.k}${t.k === meta.frozenK ? " ★" : ""} | ${f3(t.recall20)} | ${f3(t.ndcg)} | ${f3(t.meanLit)} | ${f3(t.reach)} |`);
  }
  L.push("");

  // --- verdict ---
  L.push("## 4. Verdict (Q1–Q4)");
  L.push("");
  L.push(verdict(m));
  L.push("");
  return L.join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function verdict(m: any): string {
  const o = m.overall;
  const rc = m.reachability;
  const adv = m.byCategory["adversarial"];
  const mh = m.byCategory["multi-hop"];
  const gap10 = o.MultiSeedID.recall10 - o.TunedHybrid.recall10;
  const gap20 = o.MultiSeedID.recall20 - o.TunedHybrid.recall20;
  const closed20 = gap20 >= -1e-9;
  const beatsHybridR20 = o.MultiSeedID.recall20 > o.TunedHybrid.recall20 + 1e-9;
  const keptMultiHop =
    mh ? o.MultiSeedID.ndcg10 >= o.TunedHybrid.ndcg10 - 1e-9 || mh.MultiSeedID.ndcg10 >= mh.TunedHybrid.ndcg10 - 1e-9 : false;
  const reachRose = rc.multi > rc.single + 1e-9;
  const advStr = adv
    ? `Adversarial (n=${adv.n}): MultiSeedID recall@20 ${f3(adv.MultiSeedID.recall20)} vs hybrid ${f3(adv.TunedHybrid.recall20)}, vs ID+Rerank ${f3(adv.IDRerank.recall20)}.`
    : "";
  const mhStr = mh
    ? `Multi-hop (n=${mh.n}): MultiSeedID recall@20 ${f3(mh.MultiSeedID.recall20)} / nDCG@10 ${f3(mh.MultiSeedID.ndcg10)} vs hybrid ${f3(mh.TunedHybrid.recall20)} / ${f3(mh.TunedHybrid.ndcg10)}.`
    : "";
  return (
    `**Q1 (close/flip the deep-recall + adversarial gap?)** MultiSeedID recall@10 ${f3(o.MultiSeedID.recall10)} ` +
    `(gap to hybrid ${gap10 >= 0 ? "+" : ""}${f3(gap10)}), recall@20 ${f3(o.MultiSeedID.recall20)} ` +
    `(gap ${gap20 >= 0 ? "+" : ""}${f3(gap20)}) — ${closed20 ? "the deep-recall gap is CLOSED/overtaken" : "the gap NARROWED but did NOT close"} ` +
    `vs ID+Rerank's pre-seed gap of ${f3(o.IDRerank.recall20 - o.TunedHybrid.recall20)}. ${advStr} ` +
    `**Q2 (same vector seeds: does activation-walk beat graph+RRF?)** ${beatsHybridR20 ? "YES on recall@20 — " : "Not on overall recall@20 — "}` +
    `from the SAME vector-kNN entry, MultiSeedID ${beatsHybridR20 ? "exceeds" : "trails/matches"} the hybrid ` +
    `(${f3(o.MultiSeedID.recall20)} vs ${f3(o.TunedHybrid.recall20)}); the per-category rows show where activation+provenance ` +
    `expansion wins vs k-hop graph+RRF. ${mhStr} ` +
    `**Q3 (kept ID's multi-hop edge while gaining coverage?)** ${keptMultiHop ? "YES" : "PARTIALLY"} — multi-hop nDCG@10 ` +
    `${mh ? f3(mh.MultiSeedID.ndcg10) : "n/a"} ${mh && mh.MultiSeedID.ndcg10 >= mh.TunedHybrid.ndcg10 ? "≥" : "vs"} hybrid ${mh ? f3(mh.TunedHybrid.ndcg10) : "n/a"}. ` +
    `**Q4 (reachability rose as predicted?)** Seed→evidence reachability ${f3(rc.single)} → ${f3(rc.multi)} ` +
    `(${reachRose ? "ROSE" : "did NOT rise"}); ${reachRose && (o.MultiSeedID.recall20 > o.IDRerank.recall20) ? "reachability and recall moved in lockstep, CONFIRMING the cycle C+D seed/reach diagnosis" : "the reachability/recall coupling is weaker than predicted"}. ` +
    `COST: mean |lit| ${f3(m.cost.meanLitSingle)} → ${f3(m.cost.meanLitMulti)} (${m.cost.litMultiple.toFixed(2)}×), latency ${m.cost.latencyMultiple.toFixed(2)}× per query, ` +
    `precision@1 ${f3(m.cost.precision1.IDRerank)} (ID+Rerank) → ${f3(m.cost.precision1.MultiSeedID)} (MultiSeedID).`
  );
}
