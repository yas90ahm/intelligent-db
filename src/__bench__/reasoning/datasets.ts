/**
 * reasoning/datasets.ts — loader for the unified reasoning-benchmark JSONL.
 *
 * The JSONL is produced offline by prep_datasets.py (Python stdlib: download +
 * normalize MATH-500 / GPQA-diamond / HumanEval into ONE schema). This module only
 * READS that cache — no network, no parsing of upstream formats. Keeping the (CSV /
 * gzip / redirect) ingest in Python means the TS harness stays small and dependency-free.
 */

import { readFileSync } from "node:fs";

export type BenchmarkId = "math" | "gpqa" | "coding" | "aime";

export interface BenchItem {
  /** Stable unique id (e.g. "math/...", "gpqa/recXXX", "coding/HumanEval/0"). */
  readonly id: string;
  readonly benchmark: BenchmarkId;
  /** Exact problem text shown to the model (coding: the function stub). */
  readonly question: string;
  /** Text embedded for retrieval similarity (the problem statement). */
  readonly retrieval_text: string;
  /** The worked exemplar (problem + solution) injected as a few-shot example. */
  readonly solution_text: string;
  /** math: answer string; gpqa: correct letter; coding: "" (tests live in meta). */
  readonly gold: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Read a unified benchmark JSONL file into BenchItems (one object per line). */
export function loadBench(path: string): BenchItem[] {
  const raw = readFileSync(path, "utf8");
  const out: BenchItem[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    out.push(JSON.parse(t) as BenchItem);
  }
  return out;
}

/**
 * Deterministic, leakage-free study/test split. The first `n` items by id are the held-out
 * TEST set (what we grade the model on); the REMAINING items are the STUDY bank loaded into
 * memory. Sorting by id makes both sets byte-stable across runs/machines, and the test items
 * are guaranteed absent from the study bank — so any memory-arm gain is genuine recall of
 * RELATED-but-unseen worked examples, never a near-twin of the test question.
 */
export function splitStudyTest(
  items: readonly BenchItem[],
  n: number,
): { readonly test: BenchItem[]; readonly study: BenchItem[] } {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Math.min(n, sorted.length);
  return { test: sorted.slice(0, k), study: sorted.slice(k) };
}
