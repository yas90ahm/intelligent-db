/**
 * reasoning/prompt.ts — the ONE prompt template per benchmark.
 *
 * Identical instruction + format across all arms and models so the only variable is the
 * retrieved exemplar set. Each benchmark ends with a STRICT, machine-extractable answer
 * format (so scoring is unambiguous): math/gpqa end with a marker line; coding returns a
 * single fenced ```python block.
 */

import type { BenchItem, BenchmarkId } from "./datasets.js";

const INSTRUCTION: Record<BenchmarkId, string> = {
  math:
    "You are an expert mathematician. Solve the problem step by step, then end your reply " +
    "with a line of exactly the form 'Final answer: <answer>' (the answer only, no units or prose).",
  aime:
    "You are an expert competition mathematician solving an AIME problem (the answer is an " +
    "integer from 0 to 999). Reason step by step, then end your reply with a line of exactly " +
    "the form 'Final answer: <integer>'.",
  gpqa:
    "You are an expert scientist answering a multiple-choice question. Reason step by step, " +
    "then end your reply with a line of exactly the form 'Answer: <LETTER>' where <LETTER> is one of A, B, C, D.",
  coding:
    "You are an expert Python programmer. Complete the function. Return ONLY one fenced " +
    "```python code block containing the COMPLETE function (with any imports it needs) and nothing else.",
};

const EXEMPLAR_HEADER: Record<BenchmarkId, string> = {
  math: "Here are some solved example problems for reference:",
  aime: "Here are some solved example competition problems for reference:",
  gpqa: "Here are some solved example questions for reference:",
  coding: "Here are some solved example functions for reference:",
};

/**
 * Build the reader prompt: instruction, optional numbered exemplars (already-solved
 * problems retrieved by the arm), then the target problem.
 */
export function buildPrompt(item: BenchItem, exemplars: readonly BenchItem[]): string {
  const lines: string[] = [INSTRUCTION[item.benchmark], ""];
  if (exemplars.length > 0) {
    lines.push(EXEMPLAR_HEADER[item.benchmark], "");
    exemplars.forEach((ex, i) => {
      lines.push(`--- Example ${i + 1} ---`);
      lines.push(ex.solution_text.trim());
      lines.push("");
    });
    lines.push("--- Now solve this ---");
  }
  if (item.benchmark === "coding") {
    lines.push("", item.question.trim());
  } else {
    lines.push("", `Problem: ${item.question.trim()}`, "", "Solution:");
  }
  return lines.join("\n");
}

/** Suggested generation budget (tokens) per benchmark — reasoning needs room. */
export function numPredictFor(b: BenchmarkId): number {
  if (b === "coding") return 1024;
  if (b === "aime") return 2048; // AIME solutions run long
  return 1536;
}
