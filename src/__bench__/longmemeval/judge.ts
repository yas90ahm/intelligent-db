/**
 * longmemeval/judge.ts — the DUAL metric: cheap containment/F1 (reused verbatim from
 * `retrieval/qa/qaScore.ts`) cross-validated against an LLM judge, mirroring the pattern
 * in `poisonedrag/dualMetricRunner.test.ts`.
 *
 * LongMemEval's own paper scores QA correctness with GPT-4o as an LLM judge (a reply is
 * either semantically CORRECT or WRONG vs the gold short answer) rather than exact/token
 * match, because gold answers range from short facts to full abstention sentences
 * ("the information provided is not enough...") that a token-F1 metric scores unfairly.
 * This harness reproduces that judge locally with the SAME model family the runner
 * already drives (qwen2.5:7b via Ollama) instead of a paid API, and reports the cheap
 * qaScore metric alongside it for cross-validation (does the free metric agree with the
 * judge?), exactly as `dualMetricRunner.test.ts` does for PoisonedRAG.
 */

import { ollamaGenerate } from "../retrieval/qa/ollama.js";

export type JudgeVerdict = "CORRECT" | "WRONG";

export function buildJudgePrompt(question: string, gold: string, reply: string): string {
  return [
    "You are a strict grader for a long-term-memory QA benchmark.",
    "Decide whether the RESPONSE correctly answers the QUESTION, given the REFERENCE ANSWER.",
    "The response does not need to match the reference answer word-for-word — it is CORRECT",
    "if it conveys the same fact (or, for a reference that says the information is",
    "insufficient/unknown, if the response also declines to answer or says it doesn't know).",
    "Output EXACTLY ONE word and nothing else: CORRECT or WRONG.",
    "",
    `Question: ${question}`,
    `Reference answer: ${gold}`,
    `Response: ${reply.replace(/\s+/g, " ").trim()}`,
    "",
    "Verdict (one word):",
  ].join("\n");
}

/** Deterministic parse: first occurrence of CORRECT/WRONG wins; unparseable -> WRONG. */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const up = raw.toUpperCase();
  const iC = up.indexOf("CORRECT");
  const iW = up.indexOf("WRONG");
  // "INCORRECT" would contain "CORRECT" as a tail match; guard against it (the prompt
  // never asks for INCORRECT, but a model can still emit it).
  const correctStandalone = iC >= 0 && !(up.slice(Math.max(0, iC - 2), iC) === "IN");
  if (iW >= 0 && (iC < 0 || iW < iC || !correctStandalone)) return "WRONG";
  if (correctStandalone) return "CORRECT";
  return "WRONG";
}

export interface JudgeOptions {
  readonly model: string;
  readonly timeoutMs?: number;
}

/** One judge call: question + gold + reply -> CORRECT | WRONG. */
export async function judgeAnswer(question: string, gold: string, reply: string, opts: JudgeOptions): Promise<JudgeVerdict> {
  const raw = await ollamaGenerate(buildJudgePrompt(question, gold, reply), {
    model: opts.model,
    num_predict: 8,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  return parseJudgeVerdict(raw);
}
