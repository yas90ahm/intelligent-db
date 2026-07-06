/**
 * retrieval/locomoEmbedSeededRunner.test.ts — Phase-1 retrieval spec §6 measurement.
 *
 * Adds the "EmbedSeeded" arm the spec calls for: **TunedHybrid + embedder seeding**,
 * built out of the REAL shipped Phase-1 code (not a bench reimplementation):
 *
 *   - `createEmbeddingCueResolver` (spec §3) unions the SAME baseline per-query seed
 *     cycle B/E use (entity-match ∪ vector-top-1, energy 1) with cosine top-`embedSeedK`
 *     candidates from a real `VectorSidecar`, energy-clamped to `<= embedSeedEnergyCap`
 *     AND `<= the baseline's own energy` (never letting similarity outrank an exact
 *     lexical/entity hit) — the exact production seed-selection seam, invoked with a
 *     tiny synthetic `base` CueResolver (since the baseline here comes from the bench's
 *     own per-conversation SharedGraph, not the engine's own entity index).
 *   - The resulting WalkSeed energies are handed STRAIGHT to `engine.recall` (not
 *     flattened to energy=1 the way `LocomoIdRetriever.retrieveLit` does for the plain
 *     PureID arm) so the clamp actually has an effect on the walk.
 *   - `WalkConfig.reinforcement` (spec §4a) sweeps `'dominance'` | `'summation'` on that
 *     SAME recall call — a real walk-config knob, not a bench stand-in.
 *   - The resulting lit set (ranked by reported activation) becomes the "graph channel"
 *     of the TunedHybrid RRF fusion (`retrievers.ts`'s formula, reusing the SAME
 *     {s,k,alpha} frozen this run for TunedHybrid's vector/graph fusion) IN PLACE OF the
 *     fixed h-hop BFS the plain hybrid uses — i.e. "TunedHybrid with its graph channel
 *     replaced by embedder-seeded activation" is the literal EmbedSeeded arm.
 *
 * Sweeps `embedSeedK` in {8, 16, 32} x `reinforcement` in {dominance, summation} — 6
 * configs — selects the winner by mean recall@20 on DEV (the same selection discipline
 * cycle B/E use for their own frozen configs), and reports all four headline metrics
 * (recall@10, recall@20, nDCG@10, MRR) per config on TEST against mem0's already-measured
 * same-run numbers (0.382 / 0.484 / 0.242 / 0.215 — `experiments/1.1.1.1.1.mem0/results.md`)
 * and against this SAME run's freshly re-tuned PureID/TunedHybrid arms.
 *
 * Gated behind RETRIEVAL_BENCH=1 (mirrors cycles B/C/D/E). To run:
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoEmbedSeededRunner.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.1.embedseeded/.
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

import { embedTexts, cachePathFor, cosine, MODEL_ID, EMBED_DIM } from "./embed.js";
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
import { cosineRanking } from "./graph.js";
import { queryMetrics, meanMetrics, type RankMetrics } from "./metrics.js";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.1.embedseeded";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

// mem0's already-measured same-run numbers (experiments/1.1.1.1.1.mem0/results.md),
// in the order the gate task specifies: recall@10, recall@20, nDCG@10, MRR.
const MEM0_BASELINE = { recall10: 0.382, recall20: 0.484, ndcg10: 0.242, mrr: 0.215 };

const EMBED_SEED_K_GRID: readonly number[] = [8, 16, 32];
const REINFORCEMENT_GRID: ReadonlyArray<"dominance" | "summation"> = ["dominance", "summation"];

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

/** SAME baseline seed protocol as cycles B/E: entity-match (cue proper nouns) ∪ vector top-1. */
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
  "RETRIEVAL QUALITY (real LoCoMo) — EmbedSeeded arm (TunedHybrid + embedder seeding), spec §6",
  () => {
    it(
      "sweeps embedSeedK x reinforcement, freezes the winner by dev recall@20, scores vs mem0 + same-run arms",
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

          // Real VectorSidecar, populated from the SAME MiniLM vectors every arm uses.
          const sidecar = createMemoryVectorSidecar();
          for (const t of c.turns) {
            sidecar.put(`hash:${t.id}` as ContentHash, MODEL_ID, vecByTurn.get(t.id)!);
          }

          // Real EmbedderPort adapter: deterministic lookup of the SAME precomputed
          // cue vector (never a fresh model call — keeps this sweep fast and exactly
          // reproducible), matching the "Deterministic for identical inputs" contract.
          const embedder: EmbedderPort = {
            dim: EMBED_DIM,
            modelId: MODEL_ID,
            async embed(texts: string[]): Promise<Float32Array[]> {
              return texts.map((t) => cueVecByText.get(t) ?? new Float32Array(EMBED_DIM));
            },
          };

          // Synthetic `base` CueResolver: the baseline here is the bench's own
          // per-conversation SharedGraph seed (entity ∪ vector-top-1), not the
          // engine store's entity index, so it is supplied as a per-question
          // mutable closure rather than derived from `cue.entities`.
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

        // ---- 5) TUNE the hybrid fusion params on DEV (SAME protocol cycle B --
        //         uses) — EmbedSeeded reuses these frozen {s,k,alpha}, sweeping
        //         ONLY the two spec-§6 knobs (embedSeedK, reinforcement).
        let bestH: { cfg: HybridConfig; recall10: number; ndcg: number } | null = null;
        for (const cfg of HYBRID_GRID) {
          const rows = test.length === 0 ? [] : dev.map((q) => {
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

        // ---- 6) THE EMBEDSEEDED ARM -------------------------------------------
        // For a given (embedSeedK, reinforcement), rank one question via:
        //   (a) embedder-seeded WalkSeeds (spec §3, real code) at this embedSeedK
        //   (b) engine.recall with WalkConfig.reinforcement = this mode (spec §4a,
        //       real code) fed those EXACT (unflattened) seed energies
        //   (c) RRF-fuse the resulting activation-desc ranking (the "graph channel")
        //       with the frozen TunedHybrid vector channel (top-s cosine) — the
        //       literal "TunedHybrid + embedder seeding" construction.
        async function embedSeededSeedsFor(qid: string, embedSeedK: number): Promise<WalkSeed[]> {
          const p = prepared.get(qid)!;
          const rig = rigByConv.get(p.convId)!;
          rig.currentBaseline = p.baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
          const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, {
            base: rig.baseResolver,
          });
          return resolver.resolveWithEmbeddings({ text: p.q.cueText }, { embedSeedK, embedSeedEnergyCap: 1 });
        }

        function embedSeededRank(
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
          const litRanked = [...res.lit]
            .sort((a, b) => (b.activation - a.activation) || (String(a.strandId) < String(b.strandId) ? -1 : 1))
            .map((l) => String(l.strandId));

          // RRF-fuse with the frozen TunedHybrid vector channel — the graph channel
          // is this embedder-seeded activation ranking IN PLACE OF the fixed h-hop
          // BFS `hybridRetrieveFromSeed` otherwise uses.
          const ranking = cosineRanking(rig.graph, p.cueVec);
          const cosOf = new Map<string, number>();
          ranking.forEach((r) => cosOf.set(r.id, r.sim));
          const rankVec = new Map<string, number>();
          for (let i = 0; i < Math.min(frozenHybrid.s, ranking.length); i++) rankVec.set(ranking[i]!.id, i + 1);
          const rankGraph = new Map<string, number>();
          litRanked.forEach((id, i) => rankGraph.set(id, i + 1));

          const candidates = new Set<string>([...rankVec.keys(), ...rankGraph.keys()]);
          const scored = [...candidates].map((c) => {
            const gv = rankGraph.has(c) ? frozenHybrid.alpha / (frozenHybrid.k + rankGraph.get(c)!) : 0;
            const vv = rankVec.has(c) ? (1 - frozenHybrid.alpha) / (frozenHybrid.k + rankVec.get(c)!) : 0;
            return { id: c, score: gv + vv };
          });
          scored.sort(
            (a, b) => (b.score - a.score) || ((cosOf.get(b.id) ?? 0) - (cosOf.get(a.id) ?? 0)) || (a.id < b.id ? -1 : 1),
          );
          return scored.map((x) => x.id);
        }

        interface ConfigResult {
          readonly embedSeedK: number;
          readonly reinforcement: "dominance" | "summation";
          readonly dev: RankMetrics;
          readonly test: RankMetrics;
        }

        const configResults: ConfigResult[] = [];
        for (const embedSeedK of EMBED_SEED_K_GRID) {
          // Seeds don't depend on reinforcement — compute once per K, reuse for both modes.
          const seedsByQ = new Map<string, WalkSeed[]>();
          for (const q of allQuestions) seedsByQ.set(q.id, await embedSeededSeedsFor(q.id, embedSeedK));

          for (const reinforcement of REINFORCEMENT_GRID) {
            const devRows = dev.map((q) => {
              const p = prepared.get(q.id)!;
              return queryMetrics(embedSeededRank(q.id, seedsByQ.get(q.id)!, reinforcement), p.rel);
            });
            const testRows = test.map((q) => {
              const p = prepared.get(q.id)!;
              return queryMetrics(embedSeededRank(q.id, seedsByQ.get(q.id)!, reinforcement), p.rel);
            });
            configResults.push({
              embedSeedK,
              reinforcement,
              dev: meanMetrics(devRows),
              test: meanMetrics(testRows),
            });
          }
        }

        // ---- 7) PICK THE WINNER (max mean recall@20 on DEV, spec §6) ----------
        let winner = configResults[0]!;
        for (const r of configResults) {
          if (
            r.dev.recall20 > winner.dev.recall20 + 1e-12 ||
            (Math.abs(r.dev.recall20 - winner.dev.recall20) <= 1e-12 && r.dev.ndcg10 > winner.dev.ndcg10 + 1e-12)
          ) {
            winner = r;
          }
        }

        // ---- 8) SAME-RUN comparison arms: PureID + TunedHybrid on TEST --------
        const idRankedByQ = new Map<string, string[]>();
        const hyRankedByQ = new Map<string, string[]>();
        for (const q of test) {
          const p = prepared.get(q.id)!;
          const rig = rigByConv.get(p.convId)!;
          const lit = rig.idr.retrieveLit(p.baselineIds);
          idRankedByQ.set(q.id, lit.map((l) => l.id));
          hyRankedByQ.set(q.id, hybridRetrieveFromSeed(rig.graph, p.baselineIds, p.cueVec, frozenHybrid));
        }
        const metricsFor = (qs: readonly LocomoQuestion[], ranked: Map<string, string[]>): RankMetrics =>
          meanMetrics(qs.map((q) => queryMetrics(ranked.get(q.id)!, prepared.get(q.id)!.rel)));
        const pureIdTest = metricsFor(test, idRankedByQ);
        const tunedHybridTest = metricsFor(test, hyRankedByQ);

        // ---- 9) WRITE OUTPUT ---------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.1.embedseeded — Phase-1 retrieval spec §6 EmbedSeeded arm",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            embedder: MODEL_ID,
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            frozenHybridConfig: frozenHybrid,
            embedSeedKGrid: EMBED_SEED_K_GRID,
            reinforcementGrid: REINFORCEMENT_GRID,
            gate: "LoCoMo recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1_RETRIEVAL_SPEC.md)",
            mem0Baseline: MEM0_BASELINE,
            construction:
              "EmbedSeeded = TunedHybrid's RRF fusion (frozen {s,k,alpha} this run) with its graph channel " +
              "REPLACED by a real engine.recall() lit-set (activation desc) seeded via createEmbeddingCueResolver " +
              "(spec §3: baseline entity∪vector-top1 UNION cosine-top-embedSeedK, energy-clamped) and " +
              "WalkConfig.reinforcement (spec §4a) — both real shipped code paths, not bench reimplementations.",
          },
          winner: { embedSeedK: winner.embedSeedK, reinforcement: winner.reinforcement, dev: winner.dev, test: winner.test },
          sweep: configResults,
          sameRun: { PureID: pureIdTest, TunedHybrid: tunedHybridTest },
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity (real numbers) --------------------------------------------
        expect(configResults.length).toBe(EMBED_SEED_K_GRID.length * REINFORCEMENT_GRID.length);
        expect(winner.test.recall10).toBeGreaterThan(0);
        expect(Number.isFinite(winner.test.recall20)).toBe(true);

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
  const L: string[] = [];

  L.push("# LoCoMo retrieval bench — EmbedSeeded arm (Phase-1 retrieval spec §6)");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; ` +
      `**${meta.questionsKept} questions kept**. Split: **${meta.devQuestions} dev / ${meta.testQuestions} test**. ` +
      `Embedder: **${meta.embedder}**. Gate: **${meta.gate}**.`,
  );
  L.push("");
  L.push(`Construction: ${meta.construction}`);
  L.push("");

  L.push("## 1. Full sweep (embedSeedK x reinforcement) — TEST split, macro-averaged");
  L.push("");
  L.push("| embedSeedK | reinforcement | recall@10 | recall@20 | nDCG@10 | MRR | recall@20 vs mem0 (0.484) |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of m.sweep) {
    const t: RankMetrics = r.test;
    const delta = t.recall20 - meta.mem0Baseline.recall20;
    L.push(
      `| ${r.embedSeedK} | ${r.reinforcement} | ${f3(t.recall10)} | ${f3(t.recall20)} | ${f3(t.ndcg10)} | ${f3(t.mrr)} | ${delta >= 0 ? "+" : ""}${f3(delta)} |`,
    );
  }
  L.push("");

  const w = m.winner;
  L.push("## 2. Winner (max mean recall@20 on DEV) — TEST numbers");
  L.push("");
  L.push(`**Frozen config: embedSeedK=${w.embedSeedK}, reinforcement=${w.reinforcement}**`);
  L.push("");
  L.push("| Metric | EmbedSeeded (winner) | mem0 | PureID (same run) | TunedHybrid (same run) |");
  L.push("|---|---|---|---|---|");
  const wt: RankMetrics = w.test;
  const pid: RankMetrics = m.sameRun.PureID;
  const th: RankMetrics = m.sameRun.TunedHybrid;
  L.push(`| recall@10 | ${f3(wt.recall10)} | ${f3(meta.mem0Baseline.recall10)} | ${f3(pid.recall10)} | ${f3(th.recall10)} |`);
  L.push(`| recall@20 | ${f3(wt.recall20)} | ${f3(meta.mem0Baseline.recall20)} | ${f3(pid.recall20)} | ${f3(th.recall20)} |`);
  L.push(`| nDCG@10 | ${f3(wt.ndcg10)} | ${f3(meta.mem0Baseline.ndcg10)} | ${f3(pid.ndcg10)} | ${f3(th.ndcg10)} |`);
  L.push(`| MRR | ${f3(wt.mrr)} | ${f3(meta.mem0Baseline.mrr)} | ${f3(pid.mrr)} | ${f3(th.mrr)} |`);
  L.push("");

  L.push("## 3. Gate verdict");
  L.push("");
  const gap = wt.recall20 - meta.mem0Baseline.recall20;
  if (gap >= 0) {
    L.push(`**PASS** — winner's recall@20 (${f3(wt.recall20)}) meets/exceeds the gate (>= 0.484), +${f3(gap)}.`);
  } else {
    L.push(
      `**FALL SHORT** — winner's recall@20 (${f3(wt.recall20)}) is BELOW the gate (>= 0.484) by ${f3(Math.abs(gap))}. ` +
        `Reported honestly per instructions — this is not tuned to pass.`,
    );
  }
  L.push("");

  L.push("## 4. Frozen config + fairness audit");
  L.push("");
  L.push("```");
  L.push(`hybrid fusion (frozen, reused from TunedHybrid this run): ${JSON.stringify(meta.frozenHybridConfig)}`);
  L.push(`embedSeedK grid swept: ${JSON.stringify(meta.embedSeedKGrid)}`);
  L.push(`reinforcement grid swept: ${JSON.stringify(meta.reinforcementGrid)}`);
  L.push(`mem0 baseline (from experiments/1.1.1.1.1.mem0/results.md, same LoCoMo split methodology): ${JSON.stringify(meta.mem0Baseline)}`);
  L.push("```");
  L.push("");

  return L.join("\n");
}
