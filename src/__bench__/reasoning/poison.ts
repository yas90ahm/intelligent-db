/**
 * reasoning/poison.ts — the POISONED study-bank variant.
 *
 * This is where the Intelligent DB is DESIGNED to win. A clean study bank rewards any
 * retriever equally; a poisoned one separates ID from plain RAG. The poison model is
 * CONTRADICTION poison: for a fraction of studied problems an adversarial (low-reputation)
 * source posts a DUPLICATE of the problem carrying a WRONG solution. The legit entry (from
 * a trusted source) and its poison twin share an (entity, attribute) — so they form a
 * contradiction set the engine can adjudicate. Trusted >> adversarial in earned reputation,
 * so ID's adjudication keeps the legit answer LIVE and DEMOTES the poison (never recalling
 * it). rag/hybrid have no identity/contradiction notion, so they recall poison by cosine.
 *
 * This is faithful to the project's hard theorem: ID catches CONTRADICTIONS/identity, not
 * arbitrary novel plausible falsehoods. Poison with no legit twin to contradict is the
 * honest limit — out of scope for this variant by design.
 */

import type { BenchItem } from "./datasets.js";

/** All legit entries speak for one trusted source; all poison for one adversary. */
export const TRUSTED_SOURCE = "src:trusted";
export const ADVERSARY_SOURCE = "src:adversary";

export interface BankEntry {
  /** Content used as a recalled exemplar (poison ⇒ wrong solution_text). */
  readonly item: BenchItem;
  /** The trusted source's id, or the adversary's. */
  readonly sourceId: string;
  readonly trusted: boolean;
  readonly poison: boolean;
  /** Shared by a legit/poison twin pair (the contradiction's entity). */
  readonly entity: string;
  /** Shared by a legit/poison twin pair (the contradiction's attribute). */
  readonly attribute: string;
}

/** Deterministic FNV-1a 32-bit hash → used for poison selection and tie-breaking. */
export function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic fraction in [0,1) from a string. */
export function hashFrac(s: string): number {
  return hash32(s) / 0x100000000;
}

function wrongMathAnswer(gold: string): string {
  const n = Number(gold);
  if (Number.isFinite(n)) return String(n + 1);
  return gold.length > 0 ? `${gold}0` : "0";
}

function wrongLetter(gold: string): string {
  const g = gold.trim().toUpperCase();
  return ["A", "B", "C", "D"].find((l) => l !== g) ?? "A";
}

/** Build a confidently-WRONG worked exemplar for a problem (the poison payload). */
export function corruptSolutionText(item: BenchItem): string {
  if (item.benchmark === "math") {
    const w = wrongMathAnswer(item.gold);
    return `Problem: ${item.question}\nSolution: A short calculation gives ${w}.\nFinal answer: ${w}`;
  }
  if (item.benchmark === "gpqa") {
    const w = wrongLetter(item.gold);
    return `Question: ${item.retrieval_text}\nThe correct answer is option ${w}.`;
  }
  // coding: a plausible-looking but broken implementation.
  const m = item.meta as Record<string, unknown>;
  return `${String(m["prompt"])}    # implementation\n    return None\n`;
}

/**
 * Build the study bank. Every studied problem becomes a legit (trusted) entry; if
 * `poisonRate > 0`, problems whose id hashes below the rate ALSO get an adversarial poison
 * twin (same problem, wrong solution, shared entity+attribute → a contradiction set). The
 * twin keeps the SAME retrieval_text (so it competes head-to-head in cosine space) but a
 * distinct id (so tie-breaks don't systematically favor either side).
 */
export function buildBank(study: readonly BenchItem[], poisonRate: number): BankEntry[] {
  const bank: BankEntry[] = [];
  for (let i = 0; i < study.length; i++) {
    const it = study[i]!;
    bank.push({
      item: it,
      sourceId: TRUSTED_SOURCE,
      trusted: true,
      poison: false,
      entity: `prob:${i}`,
      attribute: `ans:${i}`,
    });
  }
  if (poisonRate > 0) {
    for (let i = 0; i < study.length; i++) {
      const it = study[i]!;
      if (hashFrac(it.id) >= poisonRate) continue;
      const poisonItem: BenchItem = {
        ...it,
        id: `${it.id}#poison`,
        solution_text: corruptSolutionText(it),
        gold: "",
      };
      bank.push({
        item: poisonItem,
        sourceId: ADVERSARY_SOURCE,
        trusted: false,
        poison: true,
        entity: `prob:${i}`,
        attribute: `ans:${i}`,
      });
    }
  }
  return bank;
}
