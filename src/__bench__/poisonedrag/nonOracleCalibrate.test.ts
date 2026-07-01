/**
 * nonOracleCalibrate.test.ts — measure the STRUCTURAL separation the non-oracle arm relies on.
 *
 * The PoisonedRAG attack injects N≈5 crafted docs that all paraphrase ONE claim. This test
 * measures how tightly those poison docs cluster (to each other) versus how far the genuine
 * gold passage sits from them, in BOTH semantic (cosine) and lexical (n-gram Jaccard) space.
 * Labels are used ONLY to SCORE the separation here — the arm itself never reads them.
 *
 *   CALIBRATE_BENCH=1 npx vitest run src/__bench__/poisonedrag/nonOracleCalibrate.test.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { loadKB } from "./data.js";
import { embedTexts, cosine } from "../retrieval/embed.js";

const RUN = process.env["CALIBRATE_BENCH"] === "1";
const CACHE = process.env["PR_CACHE"] ?? "D:\\Intelligent DB\\.arbor\\cache\\poisonedrag";

const shingles = (t: string, n = 3): Set<string> => {
  const w = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(" "));
  return s;
};
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(q * (s.length - 1))]!;
};

(RUN ? describe : describe.skip)("NON-ORACLE calibration — poison-cluster vs gold separation", () => {
  it("measures cosine + Jaccard separation across nq/hotpotqa/msmarco", async () => {
    for (const ds of ["nq", "hotpotqa", "msmarco"]) {
      const kbPath = join(CACHE, `pr_${ds}_kb.jsonl`);
      if (!existsSync(kbPath)) continue;
      const kb = loadKB(kbPath);
      const byq = new Map<string, { gold: typeof kb; poison: typeof kb }>();
      for (const p of kb) {
        if ((p.kind === "gold" || p.kind === "poison") && p.query_id) {
          const g = byq.get(p.query_id) ?? { gold: [], poison: [] };
          (p.kind === "gold" ? g.gold : g.poison).push(p);
          byq.set(p.query_id, g);
        }
      }
      const qs = [...byq.entries()].filter(([, g]) => g.gold.length >= 1 && g.poison.length >= 2).slice(0, 25);
      const texts: string[] = [];
      const idx: Array<{ qid: string; kind: string; i: number }> = [];
      for (const [qid, g] of qs) for (const p of [...g.gold, ...g.poison]) { idx.push({ qid, kind: p.kind, i: texts.length }); texts.push(p.text); }
      const V = await embedTexts(texts);
      const sh = texts.map((t) => shingles(t));
      const pp: number[] = [], gp: number[] = [], ppJ: number[] = [], gpJ: number[] = [];
      for (const [qid] of qs) {
        const gi = idx.filter((x) => x.qid === qid && x.kind === "gold").map((x) => x.i);
        const pi = idx.filter((x) => x.qid === qid && x.kind === "poison").map((x) => x.i);
        for (let a = 0; a < pi.length; a++) for (let b = a + 1; b < pi.length; b++) { pp.push(cosine(V[pi[a]!]!, V[pi[b]!]!)); ppJ.push(jaccard(sh[pi[a]!]!, sh[pi[b]!]!)); }
        for (const a of gi) for (const b of pi) { gp.push(cosine(V[a]!, V[b]!)); gpJ.push(jaccard(sh[a]!, sh[b]!)); }
      }
      // eslint-disable-next-line no-console
      console.log(`\n=== ${ds}  (${qs.length} queries) ===`);
      // eslint-disable-next-line no-console
      console.log(`COSINE  poison-poison: mean ${mean(pp).toFixed(3)} p10 ${pct(pp, .1).toFixed(3)}  |  gold-poison: mean ${mean(gp).toFixed(3)} p90 ${pct(gp, .9).toFixed(3)}`);
      // eslint-disable-next-line no-console
      console.log(`JACCARD poison-poison: mean ${mean(ppJ).toFixed(3)} p10 ${pct(ppJ, .1).toFixed(3)}  |  gold-poison: mean ${mean(gpJ).toFixed(3)} p90 ${pct(gpJ, .9).toFixed(3)}`);
      expect(V.length).toBe(texts.length);
    }
  }, 600_000);
});
