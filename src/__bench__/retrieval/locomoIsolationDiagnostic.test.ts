/**
 * retrieval/locomoIsolationDiagnostic.test.ts — Phase 1c D1/D2 isolation diagnostics
 * (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "Hypotheses to isolate ... run these
 * DEV diagnostics FIRST, in this order"), run BEFORE any Phase 1c tuning.
 *
 * D1 — PURE-COSINE CONTROL: rank the 1b union pool (walk-lit UNION cosine-top-128,
 *   `unionTopN=128` frozen from 1b) by cosine ALONE — `PresentationWeights = {wCos:1,
 *   wWalk:0, wState:0}`, a DIAGNOSTIC-ONLY config, never shippable (it drops the
 *   `wState` floor the stuffing gate needs) — on the LoCoMo DEV split, with the existing
 *   MiniLM sidecar (`embed.ts`, `Xenova/all-MiniLM-L6-v2`). Reports recall@10/@20,
 *   nDCG@10, MRR.
 *
 * D2 — EMBEDDER PARITY: rebuild the sidecar with `nomic-embed-text` via the Ollama
 *   reference embedder (`src/examples/embedders.ts`'s `createOllamaEmbedder`, the SAME
 *   model mem0 uses), through `embedOllama.ts`'s cached batch wrapper, and repeat D1
 *   IDENTICALLY (same walk protocol, same diagnostic weights, same unionTopN=128) — the
 *   ONLY variable that changes is which embedder produced every vector (both the
 *   strand_vectors sidecar AND the embedder-seeded walk's own seeding). Reports the same
 *   metrics plus the D2-D1 delta.
 *
 * mem0's DEV recall@20 is also measured in the SAME session (gated separately behind
 * MEM0_BENCH, since it drives a Python sidecar) as the control's reference point,
 * scored ONLY over the DEV split (mem0's TEST-split number, 0.484, is the existing
 * cross-run reference — this file adds the matching DEV number so D1/D2 have a
 * same-split comparator, not a cross-split one).
 *
 * BELIEF INVARIANT: this file only ever reads `rankRecallResult`'s PRESENTATION output
 * (an already-completed `RecallResult`'s `lit` set, re-ordered) — it writes nothing, and
 * never touches `fact_state`/adjudication/independence/reputation/eviction. Diagnostic
 * weights here (wState=0) are explicitly flagged non-shippable in the header above and
 * in the emitted report; no code path in this file freezes them as a default anywhere.
 *
 * Gated behind RETRIEVAL_BENCH=1 (D1/D2); ALSO MEM0_BENCH=1 to additionally run the mem0
 * DEV arm. To run D1+D2 only:
 *
 *     RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoIsolationDiagnostic.test.ts
 *
 * To also run mem0's DEV arm in the same pass:
 *
 *     RETRIEVAL_BENCH=1 MEM0_BENCH=1 npx vitest run src/__bench__/retrieval/locomoIsolationDiagnostic.test.ts
 *
 * Emits metrics.json + results.md to
 *     .arbor/sessions/retrieval-quality/experiments/1.1.1.1.4.isolation/.
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
import { embedTextsOllama, ollamaCachePathFor, OLLAMA_MODEL_ID, OLLAMA_EMBED_DIM } from "./embedOllama.js";
import { vectorTop1 } from "./graph.js";
import type { SharedGraph } from "./graph.js";
import { loadLocomo, buildLocomoGraph, splitLocomo, type LocomoQuestion, type LocomoDataset } from "./locomo.js";
import { createLocomoIdRetriever, type LocomoIdRetriever } from "./retrievers.js";
import { queryMetrics, meanMetrics, type RankMetrics } from "./metrics.js";
import { ollamaHost } from "./qa/ollama.js";
import { Mem0Sidecar, type Mem0Options } from "../reasoning/mem0Arm.js";

if (process.env["MEM0_TELEMETRY"] === undefined) process.env["MEM0_TELEMETRY"] = "False";

const RUN = process.env["RETRIEVAL_BENCH"] === "1";
const RUN_MEM0 = RUN && process.env["MEM0_BENCH"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\1.1.1.1.4.isolation";
const LOCOMO_URLS = [
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo/locomo10.json",
];

const MEM0_PYTHON = process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = Number(process.env["MEM0_EMBED_DIMS"] ?? "768");
const MEM0_SEARCH_K = 20;

// Phase-1 FROZEN walk defaults (docs/specs/PHASE1_RETRIEVAL_SPEC.md measurement gate;
// CLAUDE.md's retrieval-quality note) — unchanged by this diagnostic, exactly as 1b/1c
// require ("only the presentation weights are tuned").
const FROZEN_EMBED_SEED_K = 16;
const FROZEN_REINFORCEMENT = "dominance" as const;

// 1b's frozen union width — this diagnostic reuses it verbatim (D1's brief: "rank the
// 1b union pool (unionTopN=128)").
const FROZEN_UNION_TOP_N = 128;

// D1/D2's DIAGNOSTIC-ONLY presentation weights (spec: "wCos=1, wWalk=0, wState=0 —
// diagnostic-only config"). NEVER shippable — see header doc.
const DIAGNOSTIC_WEIGHTS: PresentationWeights = { wCos: 1, wWalk: 0, wState: 0 };

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

/** Build one embedder-parity arm's per-conversation rig set, given precomputed vectors. */
function buildRigs(
  convs: readonly LocomoDataset["conversations"][number][],
  vecByTurn: Map<string, Float32Array>,
  cueVecByText: Map<string, Float32Array>,
  modelId: string,
  dim: number,
): { graphByConv: Map<string, SharedGraph>; rigByConv: Map<string, ConvRig> } {
  const graphByConv = new Map<string, SharedGraph>();
  const rigByConv = new Map<string, ConvRig>();
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
      idr,
      vectors: sidecar,
      embedder,
      currentBaseline: [],
      baseResolver: { index(): void {}, resolve: (): WalkSeed[] => rig.currentBaseline },
    };
    rigByConv.set(c.convId, rig);
  }
  return { graphByConv, rigByConv };
}

/** Run the D1/D2 diagnostic (walk -> blend rerank at DIAGNOSTIC_WEIGHTS) over one split. */
async function scoreDiagnostic(
  qs: readonly LocomoQuestion[],
  prepared: Map<string, Prepared>,
  rigByConv: Map<string, ConvRig>,
  baselineByQ: Map<string, string[]>,
  cueVecByQ: Map<string, Float32Array>,
  modelId: string,
): Promise<RankMetrics> {
  const rows: RankMetrics[] = [];
  for (const q of qs) {
    const p = prepared.get(q.id)!;
    const rig = rigByConv.get(p.convId)!;
    const baselineIds = baselineByQ.get(q.id)!;
    rig.currentBaseline = baselineIds.map((id) => ({ strandId: asStrandId(id), energy: 1 }));
    const resolver = createEmbeddingCueResolver(rig.idr.store, rig.embedder, rig.vectors, { base: rig.baseResolver });
    const cueVec = cueVecByQ.get(q.id)!;
    const seeds = await resolver.resolveWithEmbeddings(
      { text: q.cueText },
      { embedSeedK: FROZEN_EMBED_SEED_K, embedSeedEnergyCap: 1 },
    );
    const present = seeds.filter((s) => rig.idr.store.getStrand(s.strandId) !== null);
    const res: RecallResult =
      present.length === 0
        ? { lit: [], halt: { reason: "TRUNCATED", popCount: 0, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: true } as never, unresolvedSeeds: [], seedsResolved: 0 }
        : rig.idr.engine.recall({ seeds: present, config: { ...DEFAULT_WALK_CONFIG, reinforcement: FROZEN_REINFORCEMENT } });

    const blended = rankRecallResult(
      rig.idr.store,
      res,
      { vectors: rig.vectors, modelId, cueVector: cueVec },
      { rankMode: "blend", unionTopN: FROZEN_UNION_TOP_N, weights: DIAGNOSTIC_WEIGHTS },
    );
    const ranked = blended.lit.map((l) => String(l.strandId));
    rows.push(queryMetrics(ranked, p.rel));
  }
  return meanMetrics(rows);
}

(RUN ? describe : describe.skip)(
  "RETRIEVAL QUALITY (real LoCoMo) — Phase 1c D1/D2 isolation diagnostics (pure-cosine control + embedder parity)",
  () => {
    it(
      "D1 (MiniLM, pure-cosine) then D2 (nomic-embed-text, pure-cosine) on DEV, plus optional mem0 DEV control",
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
        void test; // this diagnostic is DEV-only per spec ("run these DEV diagnostics FIRST")

        const prepared = new Map<string, Prepared>();
        const baselineByQ = new Map<string, string[]>();
        for (const q of allQuestions) prepared.set(q.id, { q, convId: q.convId, rel: new Set(q.relevant) });

        // =====================================================================
        // D1 — MiniLM sidecar, pure-cosine diagnostic weights, DEV split
        // =====================================================================
        const miniVecs = await embedTexts(all);
        const miniVecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => miniVecByTurn.set(id, miniVecs[i]!));
        const miniCueVecByText = new Map<string, Float32Array>();
        const miniCueVecByQ = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = miniVecs[turnTexts.length + i]!;
          miniCueVecByText.set(q.cueText, v);
          miniCueVecByQ.set(q.id, v);
        });

        const miniRigs = buildRigs(convs, miniVecByTurn, miniCueVecByText, MODEL_ID, EMBED_DIM);
        for (const c of convs) {
          for (const q of c.questions) {
            const g = miniRigs.graphByConv.get(c.convId)!;
            baselineByQ.set(q.id, locomoSeed(g, q, miniCueVecByQ.get(q.id)!));
          }
        }

        const d1 = await scoreDiagnostic(dev, prepared, miniRigs.rigByConv, baselineByQ, miniCueVecByQ, MODEL_ID);

        // =====================================================================
        // D2 — nomic-embed-text (Ollama) sidecar, SAME diagnostic, SAME split
        // =====================================================================
        const nomicVecs = await embedTextsOllama(all);
        const nomicVecByTurn = new Map<string, Float32Array>();
        turnIds.forEach((id, i) => nomicVecByTurn.set(id, nomicVecs[i]!));
        const nomicCueVecByText = new Map<string, Float32Array>();
        const nomicCueVecByQ = new Map<string, Float32Array>();
        allQuestions.forEach((q, i) => {
          const v = nomicVecs[turnTexts.length + i]!;
          nomicCueVecByText.set(q.cueText, v);
          nomicCueVecByQ.set(q.id, v);
        });

        const nomicRigs = buildRigs(convs, nomicVecByTurn, nomicCueVecByText, OLLAMA_MODEL_ID, OLLAMA_EMBED_DIM);
        // The baseline seed (entity-match ∪ vector-top-1) is recomputed with the nomic
        // vectors too — D2's brief is "rebuild the sidecar ... and repeat D1 identically",
        // i.e. the ONLY controlled variable is which embedder produced every vector,
        // including the vector-top-1 baseline seed component.
        const nomicBaselineByQ = new Map<string, string[]>();
        for (const c of convs) {
          for (const q of c.questions) {
            const g = nomicRigs.graphByConv.get(c.convId)!;
            nomicBaselineByQ.set(q.id, locomoSeed(g, q, nomicCueVecByQ.get(q.id)!));
          }
        }

        const d2 = await scoreDiagnostic(dev, prepared, nomicRigs.rigByConv, nomicBaselineByQ, nomicCueVecByQ, OLLAMA_MODEL_ID);

        const delta: RankMetrics = {
          recall1: d2.recall1 - d1.recall1,
          recall5: d2.recall5 - d1.recall5,
          recall10: d2.recall10 - d1.recall10,
          recall20: d2.recall20 - d1.recall20,
          precision1: d2.precision1 - d1.precision1,
          precision5: d2.precision5 - d1.precision5,
          precision10: d2.precision10 - d1.precision10,
          mrr: d2.mrr - d1.mrr,
          ndcg10: d2.ndcg10 - d1.ndcg10,
        };

        // =====================================================================
        // mem0 DEV control (optional, gated behind MEM0_BENCH — drives a Python
        // sidecar per conversation, real mem0.search over the DEV questions only).
        // =====================================================================
        let mem0Dev: RankMetrics | null = null;
        let mem0DevScored = 0;
        if (RUN_MEM0) {
          const mem0Opts = (qdrantPath: string): Mem0Options => ({
            pythonBin: MEM0_PYTHON,
            llm: MEM0_LLM,
            embed: MEM0_EMBED,
            embedDims: MEM0_EMBED_DIMS,
            qdrantPath,
            ollamaHost: ollamaHost(),
          });
          const devByConv = new Map<string, LocomoQuestion[]>();
          for (const q of dev) {
            const arr = devByConv.get(q.convId) ?? [];
            arr.push(q);
            devByConv.set(q.convId, arr);
          }
          const rows: RankMetrics[] = [];
          for (const c of convs) {
            const qs = devByConv.get(c.convId) ?? [];
            if (qs.length === 0) continue;
            const qdrantPath = join(tmpdir(), `idb-mem0-locomo-isolation-${c.convId.replace(/[^a-z0-9_-]/gi, "_")}-${process.pid}`);
            const sc = new Mem0Sidecar(mem0Opts(qdrantPath));
            try {
              await sc.ready();
              await sc.build(c.turns.map((t, i) => ({ idx: i, text: t.text })));
              for (const q of qs) {
                const hits = await sc.search(q.cueText, MEM0_SEARCH_K);
                const ranked = hits.map((h) => c.turns[h.idx]?.id).filter((id): id is string => id !== undefined);
                rows.push(queryMetrics(ranked, prepared.get(q.id)!.rel));
                mem0DevScored++;
              }
            } finally {
              await sc.close();
              try { rmSync(qdrantPath, { recursive: true, force: true }); } catch { /* best-effort */ }
            }
          }
          mem0Dev = meanMetrics(rows);
        }

        // ---- WRITE OUTPUT --------------------------------------------------
        const metricsJson = {
          meta: {
            experiment: "1.1.1.1.4.isolation — Phase 1c D1/D2 isolation diagnostics (run before tuning)",
            dataset: "LoCoMo (snap-research/locomo, locomo10.json)",
            conversations: dataset.stats.conversations,
            corpusTurns: dataset.stats.totalTurns,
            questionsKept: dataset.stats.questionsKept,
            devQuestions: dev.length,
            testQuestions: test.length,
            frozenEmbedSeedK: FROZEN_EMBED_SEED_K,
            frozenReinforcement: FROZEN_REINFORCEMENT,
            frozenUnionTopN: FROZEN_UNION_TOP_N,
            diagnosticWeights: DIAGNOSTIC_WEIGHTS,
            d1Embedder: MODEL_ID,
            d2Embedder: OLLAMA_MODEL_ID,
            mem0Ran: RUN_MEM0,
            mem0DevScored,
            mem0TestReference: { recall20: 0.484, note: "1b same-run TEST number, cross-split caveat if mem0DevScored===0" },
          },
          D1_pureCosine_MiniLM_DEV: d1,
          D2_pureCosine_Nomic_DEV: d2,
          delta_D2_minus_D1: delta,
          mem0_DEV: mem0Dev,
        };

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(join(OUT_DIR, "metrics.json"), JSON.stringify(metricsJson, null, 2));
        writeFileSync(join(OUT_DIR, "results.md"), renderReport(metricsJson));

        // ---- sanity ----------------------------------------------------------
        expect(Number.isFinite(d1.recall20)).toBe(true);
        expect(Number.isFinite(d2.recall20)).toBe(true);
        if (RUN_MEM0) expect(mem0DevScored).toBeGreaterThan(0);

        // ---- cleanup temp caches ----------------------------------------------
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

  L.push("# LoCoMo retrieval bench — Phase 1c D1/D2 isolation diagnostics");
  L.push("");
  L.push(
    `**${meta.conversations} conversations**, **${meta.corpusTurns} turns**; **${meta.questionsKept} questions kept**. ` +
      `Split: **${meta.devQuestions} dev / ${meta.testQuestions} test** — diagnostics run on DEV only. ` +
      `Frozen walk: embedSeedK=${meta.frozenEmbedSeedK}, reinforcement=${meta.frozenReinforcement}. ` +
      `Frozen unionTopN=${meta.frozenUnionTopN} (1b's frozen width, reused verbatim).`,
  );
  L.push("");
  L.push(
    `**Diagnostic weights (never shippable): ${JSON.stringify(meta.diagnosticWeights)}** — pure cosine over the ` +
      "union pool; drops the wState floor the embedding-stuffing gate requires, by design (measurement only).",
  );
  L.push("");

  L.push("## D1 — pure-cosine control (MiniLM sidecar, DEV)");
  L.push("");
  L.push(`Embedder: **${meta.d1Embedder}**.`);
  L.push("");
  L.push("| metric | value |");
  L.push("|---|---|");
  for (const [k, label] of RANK_KEYS) L.push(`| ${label} | ${f3(m.D1_pureCosine_MiniLM_DEV[k])} |`);
  L.push("");

  L.push("## D2 — embedder parity (nomic-embed-text via Ollama, DEV, identical protocol)");
  L.push("");
  L.push(`Embedder: **${meta.d2Embedder}**.`);
  L.push("");
  L.push("| metric | D1 (MiniLM) | D2 (nomic) | delta (D2-D1) |");
  L.push("|---|---|---|---|");
  for (const [k, label] of RANK_KEYS) {
    L.push(
      `| ${label} | ${f3(m.D1_pureCosine_MiniLM_DEV[k])} | ${f3(m.D2_pureCosine_Nomic_DEV[k])} | ` +
        `${m.delta_D2_minus_D1[k] >= 0 ? "+" : ""}${f3(m.delta_D2_minus_D1[k])} |`,
    );
  }
  L.push("");

  L.push("## mem0 DEV control");
  L.push("");
  if (m.mem0_DEV !== null) {
    L.push(`Real mem0 sidecar, same session, scored over **${meta.mem0DevScored}** DEV questions:`);
    L.push("");
    L.push("| metric | mem0 (DEV, this run) |");
    L.push("|---|---|");
    for (const [k, label] of RANK_KEYS) L.push(`| ${label} | ${f3(m.mem0_DEV[k])} |`);
  } else {
    L.push(
      `mem0 was NOT run in this pass (MEM0_BENCH not set). Reference caveat: mem0's measured ` +
        `**TEST**-split recall@20 (1b same-run) is **${meta.mem0TestReference.recall20}** — a cross-split ` +
        "number, not a same-split DEV comparator; re-run with MEM0_BENCH=1 for a same-split control.",
    );
  }
  L.push("");

  L.push("## Verdict");
  L.push("");
  const gap = m.D1_pureCosine_MiniLM_DEV.recall20;
  L.push(
    `D1 recall@20 = **${f3(gap)}**. Per spec: "If this lands near mem0's DEV number, the linear blend weights ` +
      "were the loss. If it stays near 0.44, the embedder/chunking is the loss." + " D2-D1 delta on recall@20 = " +
      `**${m.delta_D2_minus_D1.recall20 >= 0 ? "+" : ""}${f3(m.delta_D2_minus_D1.recall20)}** is the embedder's ` +
      "measured contribution, isolated from the weights.",
  );
  L.push("");

  return L.join("\n");
}
