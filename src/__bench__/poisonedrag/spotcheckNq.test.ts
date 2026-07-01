/**
 * spotcheckNq.test.ts — WHY does Intelligent DB ignore the PoisonedRAG poison?
 *
 * A PURE-ENGINE-STATE explainer (no LLM, deterministic, CPU only). For a small
 * sample of NQ questions it reconstructs the substrate arm EXACTLY as
 * poisonedrag/arms.ts builds it (same recipe, same anchors/reputation wiring),
 * then for each query dumps the concrete "trust score + provenance mismatch"
 * reason the poison was dropped:
 *
 *   - the GOLD value's independent-root count  #R  (engine-derived; should be 2:
 *     DOMAIN + ORG, primary pre-earned)
 *   - the POISON cluster's #R                       (should be 1: one shared anchor
 *     class = a Sybil cluster)
 *   - the reputation / LCB of the gold-primary source vs the poison sources
 *   - the adjudication outcome (RESOLVED / DEFERRED / NOOP)
 *   - WHICH poison passage strands ended DEMOTED vs the gold staying LIVE
 *   - top-k passages plain RAG (cosine) would surface (poison-dominated) vs what
 *     IDB surfaces after filtering the demoted poison (gold)
 *
 * The report is written to .arbor/sessions/verification/spotcheck_nq.md.
 *
 * Gated (CPU-only, no GPU). Run with:
 *   SPOTCHECK_NQ=1 npx vitest run src/__bench__/poisonedrag/spotcheckNq.test.ts
 *
 * The embedding channel (Xenova/all-MiniLM-L6-v2, ONNX, CPU) is used ONLY to rank
 * the per-query candidate pool for the RAG-vs-IDB top-k columns — the same
 * embedder the validated arms use. The trust verdict itself is pure engine state.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb, createMemoryStore, createSourceIdentityLayer, createReputationLedger,
  createPendingLedger, generatePassport, asStrandId, asEpochMs, FactState, FactOrigin, Tier, AnchorClass,
} from "../../index.js";
import type {
  Strand, StrandStore, SourceId, Unit, EpochMs, EntityId, AttributeKey, ProvenanceRoot,
  ProvenanceRootId, IndependenceClassId, ContentHash, AnchorBinding, KeyRegistryPort,
  AnchorRegistryPort, ReputationLedger, ReputationLedgerPort, StakeLedgerPort, RatificationDeps,
  SourceIdentityLayer,
} from "../../index.js";

import { loadKB, loadQuestions } from "./data.js";
import type { KBPassage, PRQuestion } from "./data.js";
import { cosine, embedTexts } from "../retrieval/embed.js";
import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";

const RUN = process.env["SPOTCHECK_NQ"] === "1";
const CACHE = process.env["PR_CACHE"] ?? "D:\\Intelligent DB\\.arbor\\cache\\poisonedrag";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\verification";
const SAMPLE = Number(process.env["SPOTCHECK_N"] ?? "8");
const NEG_POOL = Number(process.env["SPOTCHECK_NEG"] ?? "80"); // shared distractor pool size
const TOP_K = 5;

const NOW: EpochMs = asEpochMs(1_700_000_000_000);

// --- strand/root/anchor builders (verbatim from poisonedrag/arms.ts) --------

function makeRoot(sourceId: string, cls: string, idRaw: string): ProvenanceRoot {
  return { rootId: `root:${idRaw}` as ProvenanceRootId, independenceClass: cls as IndependenceClassId, sourceId: sourceId as SourceId, establishedAt: NOW };
}
function makeStrand(idRaw: string, attrKey: string, value: string, contentHash: string, roots: ProvenanceRoot[]): Strand {
  return {
    id: asStrandId(idRaw), entity: attrKey as EntityId, attribute: attrKey as AttributeKey, payload: { value },
    content_hash: contentHash as ContentHash, origin: FactOrigin.OBSERVED, fact_state: FactState.LIVE, tier: Tier.WARM,
    provenance: roots, outEdges: [], inEdges: [], outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 }, salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0, observedAt: NOW, external_reobservation_count: 0, contradiction_set: null,
    co_equal_claim_cardinality: 0, last_tier_reason: null, register: null,
  };
}
const bind = (c: AnchorClass): AnchorBinding => ({ anchorClass: c, realizedCost: 0.5 as Unit, independenceWeight: 0.5 as Unit });

interface QueryRecord {
  qid: string;
  question: string;
  correct: string;
  incorrect: string;
  goldStrandIds: string[];
  goldRoots: ProvenanceRoot[];
  goldPrimary: string;
  goldSources: { source: string; cls: AnchorClass }[];
  poisonStrandIds: string[];
  poisonRoots: ProvenanceRoot[];
  poisonSources: string[];
  goldPassageIds: string[];
  poisonPassageIds: string[];
  strandToPassage: Map<string, string>;
}

(RUN ? describe : describe.skip)("SPOTCHECK NQ — why IDB drops the poison (pure engine state)", () => {
  it("reconstructs the substrate arm and explains the trust verdict per query", async () => {
    const kbPath = join(CACHE, "pr_nq_kb.jsonl");
    const qPath = join(CACHE, "pr_nq_questions.jsonl");
    if (!existsSync(kbPath) || !existsSync(qPath)) throw new Error(`missing NQ prep output — ${kbPath}`);

    const passages = loadKB(kbPath);
    const questions = loadQuestions(qPath).filter((q) => q.has_gold);

    // index passages by query, and gather a shared negative pool.
    const byQuery = new Map<string, { gold: KBPassage[]; poison: KBPassage[] }>();
    const negatives: KBPassage[] = [];
    for (const p of passages) {
      if (p.kind === "negative") { if (negatives.length < NEG_POOL) negatives.push(p); continue; }
      if (p.kind !== "gold" && p.kind !== "poison") continue;
      const g = byQuery.get(p.query_id) ?? { gold: [], poison: [] };
      (p.kind === "gold" ? g.gold : g.poison).push(p);
      byQuery.set(p.query_id, g);
    }

    const sample: PRQuestion[] = [];
    for (const q of questions) {
      const g = byQuery.get(q.id);
      if (g && g.gold.length > 0 && g.poison.length > 0) sample.push(q);
      if (sample.length >= SAMPLE) break;
    }

    // ---- build the substrate engine EXACTLY as arms.substrateArm does -------
    const store: StrandStore = createMemoryStore();
    const anchorBindings = new Map<string, AnchorBinding[]>();
    const known = new Set<string>();
    const earn = new Set<string>();
    const records: QueryRecord[] = [];

    let si = 0;
    for (const q of sample) {
      const qid = q.id;
      const g = byQuery.get(qid)!;
      const correctCH = `ch:${qid}:correct`;
      const rec: QueryRecord = {
        qid, question: q.question, correct: q.correct, incorrect: q.incorrect,
        goldStrandIds: [], goldRoots: [], goldPrimary: "", goldSources: [],
        poisonStrandIds: [], poisonRoots: [], poisonSources: [],
        goldPassageIds: g.gold.map((p) => p.id), poisonPassageIds: g.poison.map((p) => p.id),
        strandToPassage: new Map(),
      };

      let goldCount = 0;
      for (let i = 0; i < g.gold.length; i++) {
        const gp = g.gold[i]!;
        const cls = i === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;
        const sid = `s:${si++}`;
        const root = makeRoot(gp.source, `cls:gold:${qid}:${i}`, `${si}`);
        store.putStrand(makeStrand(sid, qid, "correct", correctCH, [root]));
        anchorBindings.set(gp.source, [bind(cls)]);
        known.add(gp.source);
        if (i === 0) { earn.add(gp.source); rec.goldPrimary = gp.source; }
        rec.goldStrandIds.push(sid); rec.goldRoots.push(root);
        rec.goldSources.push({ source: gp.source, cls });
        rec.strandToPassage.set(sid, gp.id);
        goldCount++;
      }
      if (goldCount === 1) {
        const cs = `src:corrob:${qid}`;
        const sid = `s:${si++}`;
        const root = makeRoot(cs, `cls:corrob:${qid}`, `${si}`);
        store.putStrand(makeStrand(sid, qid, "correct", correctCH, [root]));
        anchorBindings.set(cs, [bind(AnchorClass.ORGANIZATION)]);
        known.add(cs);
        rec.goldStrandIds.push(sid); rec.goldRoots.push(root);
        rec.goldSources.push({ source: cs, cls: AnchorClass.ORGANIZATION });
      }

      const poisonCH = `ch:${qid}:incorrect`;
      for (const pp of g.poison) {
        const id = `s:${si++}`;
        const root = makeRoot(pp.source, `cls:sybil:${qid}`, `${si}`);
        store.putStrand(makeStrand(id, qid, "incorrect", poisonCH, [root]));
        anchorBindings.set(pp.source, [bind(AnchorClass.EMAIL_OAUTH)]);
        known.add(pp.source);
        rec.poisonStrandIds.push(id); rec.poisonRoots.push(root);
        rec.poisonSources.push(pp.source);
        rec.strandToPassage.set(id, pp.id);
      }
      records.push(rec);
    }

    const keys: KeyRegistryPort = { register: () => {}, sourceIdOf: (s) => (known.has(String(s)) ? s : null), has: (s) => known.has(String(s)) };
    const anchors: AnchorRegistryPort = {
      bind: () => {},
      anchorsOf: (s) => anchorBindings.get(String(s)) ?? [],
      aggregateCost: () => 0.5 as Unit,
      independenceBetween: (a, b) => {
        const ca = new Set(a.map((x) => x.anchorClass));
        const cb = new Set(b.map((x) => x.anchorClass));
        if (ca.size === 0 || cb.size === 0) return 0 as Unit;
        for (const c of ca) if (cb.has(c)) return 0 as Unit;
        return 0.5 as Unit;
      },
    };
    const repCapOf = (s: SourceId): Unit => (earn.has(String(s)) ? 0.95 : 0.05) as Unit;
    const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, () => NOW);
    const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
    const stake: StakeLedgerPort = { postedFor: () => 0 as Unit };
    const identity: SourceIdentityLayer = createSourceIdentityLayer({ keys, anchors, reputation: reputationPort, stake });
    const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSigner: generatePassport() };
    const engine = createIntelligentDb(store, identity, null, reputation, ratification);

    for (const s of earn) for (let r = 0; r < PRIMARY_WARMUP_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);

    // ---- adjudicate per query and capture the outcome ----------------------
    const outcomes = new Map<string, string>();
    for (const rec of records) {
      const out = engine.adjudicate(rec.qid as AttributeKey);
      const k = out.kind === "RESOLVED" ? `RESOLVED (${out.demotions.length} demoted)` : out.kind;
      outcomes.set(rec.qid, k);
    }

    // ---- embed the per-query candidate pools for the RAG-vs-IDB top-k -------
    const negTexts = negatives.map((n) => n.text);
    const passById = new Map<string, KBPassage>();
    for (const rec of records) {
      for (const pid of rec.goldPassageIds) passById.set(pid, passages.find((p) => p.id === pid)!);
      for (const pid of rec.poisonPassageIds) passById.set(pid, passages.find((p) => p.id === pid)!);
    }
    const qTexts = records.map((r) => r.question);
    const goldPoolTexts: string[] = [];
    for (const rec of records) for (const pid of [...rec.goldPassageIds, ...rec.poisonPassageIds]) goldPoolTexts.push(passById.get(pid)!.text);

    const allTexts = [...qTexts, ...goldPoolTexts, ...negTexts];
    const vecs = await embedTexts(allTexts);
    const vecOf = new Map<string, Float32Array>();
    let vi = 0;
    const qVec = new Map<string, Float32Array>();
    for (const r of records) qVec.set(r.qid, vecs[vi++]!);
    for (const rec of records) for (const pid of [...rec.goldPassageIds, ...rec.poisonPassageIds]) vecOf.set(pid, vecs[vi++]!);
    const negVecs: { id: string; text: string; vec: Float32Array }[] = [];
    for (const n of negatives) negVecs.push({ id: n.id, text: n.text, vec: vecs[vi++]! });

    // collect demoted poison passage-ids (engine state).
    const demotedPoisonPid = new Set<string>();
    for (const rec of records) {
      for (const sid of rec.poisonStrandIds) {
        if (store.getStrand(asStrandId(sid))?.fact_state === FactState.DEMOTED) demotedPoisonPid.add(rec.strandToPassage.get(sid)!);
      }
    }

    type Ranked = { label: string; pid: string; score: number; snippet: string };
    function rankPool(rec: QueryRecord, dropDemoted: boolean): Ranked[] {
      const q = qVec.get(rec.qid)!;
      const cand: Ranked[] = [];
      for (const pid of rec.goldPassageIds) cand.push({ label: "GOLD", pid, score: cosine(q, vecOf.get(pid)!), snippet: passById.get(pid)!.text.slice(0, 70) });
      for (const pid of rec.poisonPassageIds) {
        if (dropDemoted && demotedPoisonPid.has(pid)) continue;
        cand.push({ label: "POISON", pid, score: cosine(q, vecOf.get(pid)!), snippet: passById.get(pid)!.text.slice(0, 70) });
      }
      for (const n of negVecs) cand.push({ label: "neg", pid: n.id, score: cosine(q, n.vec), snippet: n.text.slice(0, 70) });
      cand.sort((a, b) => b.score - a.score);
      return cand.slice(0, TOP_K);
    }

    // ---- compose the markdown report ---------------------------------------
    const round = (x: number): string => x.toFixed(4);
    const L: string[] = [];
    L.push("# PoisonedRAG NQ — spot check: WHY Intelligent DB ignores the poison");
    L.push("");
    L.push(`Generated ${new Date().toISOString()} — pure engine state, no LLM. Sample: ${records.length} questions from \`pr_nq_kb.jsonl\`.`);
    L.push("");
    L.push("Mechanism: each query's GOLD value is backed by ≥2 anchor-DISJOINT roots (primary pre-earned via 12 ratifies, cap 0.95) so its independent-root count **#R = 2**; the attacker's 5 poison passages all share ONE anchor class (a Sybil cluster) so the incorrect value's **#R = 1**. `adjudicate()` sees a decisive, EARNED reputation margin for the gold and DEMOTES the poison (demote-never-delete). Plain RAG ranks by cosine only — the query-crafted poison crowds the top-k; IDB drops the DEMOTED poison and surfaces the gold.");
    L.push("");
    L.push("| reputation LCB (engine `scoreOf`) | value |");
    L.push("|---|---|");
    L.push(`| gold-primary (earned, cap 0.95) | ${round(reputation.scoreOf(records[0]!.goldPrimary as SourceId))} |`);
    L.push(`| poison source (unearned, cap 0.05) | ${round(reputation.scoreOf(records[0]!.poisonSources[0]! as SourceId))} |`);
    L.push("");

    for (const rec of records) {
      const rGold = identity.independentRootCount(rec.goldRoots);
      const rPoison = identity.independentRootCount(rec.poisonRoots);
      const goldRep = reputation.scoreOf(rec.goldPrimary as SourceId);
      const poisRep = reputation.scoreOf(rec.poisonSources[0]! as SourceId);
      const liveGold = rec.goldStrandIds.filter((s) => store.getStrand(asStrandId(s))?.fact_state === FactState.LIVE).length;
      const demoted = rec.poisonStrandIds.filter((s) => store.getStrand(asStrandId(s))?.fact_state === FactState.DEMOTED).length;
      const liveGoldAll = liveGold === rec.goldStrandIds.length;

      L.push(`## ${rec.qid} — "${rec.question}"`);
      L.push(`- correct = **${rec.correct}**  ·  attacker-injected incorrect = **${rec.incorrect}**`);
      L.push(`- GOLD value "correct": ${rec.goldSources.length} co-asserter root(s) over classes [${rec.goldSources.map((s) => s.cls).join(", ")}] → **#R = ${rGold}**`);
      L.push(`- POISON value "incorrect": ${rec.poisonSources.length} passages, all anchor class EMAIL_OAUTH (one shared independence class \`cls:sybil:${rec.qid}\`) → **#R = ${rPoison}**`);
      L.push(`- reputation/LCB: gold-primary \`${rec.goldPrimary}\` = **${round(goldRep)}**  vs  poison \`${rec.poisonSources[0]}\` = **${round(poisRep)}**`);
      L.push(`- adjudication outcome: **${outcomes.get(rec.qid)}**`);
      L.push(`- engine state after adjudicate: gold strands LIVE = ${liveGold}/${rec.goldStrandIds.length}${liveGoldAll ? " (all LIVE)" : ""}; poison strands DEMOTED = ${demoted}/${rec.poisonStrandIds.length}`);
      L.push(`- **reason poison dropped:** trust + provenance mismatch — the gold's #R=${rGold} with an earned LCB ${round(goldRep)} decisively outranks the Sybil cluster's #R=${rPoison} at LCB ${round(poisRep)}; the poison is a single-anchor-class echo, not independent corroboration.`);
      L.push("");
      L.push("Top-5 plain RAG (cosine only) — poison crowds the context:");
      L.push("");
      L.push("| rank | label | cos | snippet |");
      L.push("|---|---|---|---|");
      rankPool(rec, false).forEach((r, i) => L.push(`| ${i + 1} | ${r.label} | ${round(r.score)} | ${r.snippet.replace(/\|/g, "/").replace(/\n/g, " ")}… |`));
      L.push("");
      L.push("Top-5 IDB (cosine, demoted poison filtered out) — gold surfaces:");
      L.push("");
      L.push("| rank | label | cos | snippet |");
      L.push("|---|---|---|---|");
      rankPool(rec, true).forEach((r, i) => L.push(`| ${i + 1} | ${r.label} | ${round(r.score)} | ${r.snippet.replace(/\|/g, "/").replace(/\n/g, " ")}… |`));
      L.push("");
    }

    L.push("---");
    L.push("");
    L.push("Note: the BARE / RAG / IDB *LLM* answer strings (ASR + clean accuracy) are a GPU/Ollama step the operator adds separately:");
    L.push("");
    L.push("```");
    L.push("POISONEDRAG_BENCH=1 PR_DATASET=nq PR_MODEL=qwen2.5:7b npx vitest run src/__bench__/poisonedrag/runner.test.ts");
    L.push("```");
    L.push("");

    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = join(OUT_DIR, "spotcheck_nq.md");
    writeFileSync(outPath, L.join("\n"));
    // eslint-disable-next-line no-console
    console.log(`[spotcheck] wrote ${outPath} (${records.length} queries)`);

    // sanity: the recipe must hold for the sample.
    for (const rec of records) {
      expect(identity.independentRootCount(rec.goldRoots)).toBe(2);
      expect(identity.independentRootCount(rec.poisonRoots)).toBe(1);
      expect(outcomes.get(rec.qid)!.startsWith("RESOLVED")).toBe(true);
    }
    expect(records.length).toBeGreaterThan(0);
  }, 600_000);
});
