/**
 * reasoning/score.ts — answer extraction + exact-match scoring for math and gpqa.
 * (coding is graded by codeExec.runHumanEval.)
 *
 * The SAME extractor/normalizer is applied to every arm and model, so any extraction
 * noise is a constant and the cross-arm comparison stays fair.
 */

/** Normalize a math answer for comparison: strip latex wrappers, $, spaces, commas, trailing punctuation. */
export function normalizeMath(s: string): string {
  let t = s.trim();
  t = t.replace(/\\boxed\{([\s\S]*?)\}/g, "$1");
  t = t.replace(/\\text\{([\s\S]*?)\}/g, "$1");
  t = t.replace(/\\left|\\right|\\!|\\,|\\;|\\ /g, "");
  t = t.replace(/\$/g, "");
  t = t.replace(/\\dfrac/g, "\\frac");
  t = t.replace(/[\s]+/g, "");
  t = t.replace(/,/g, "");
  t = t.replace(/\.$/, "");
  t = t.replace(/^\{|\}$/g, "");
  return t.toLowerCase();
}

/** Extract a math final answer: prefer the 'Final answer:' marker, else last \boxed{}, else last line. */
export function extractMathAnswer(reply: string): string {
  const marker = [...reply.matchAll(/final answer\s*[:=]\s*(.+)/gi)];
  if (marker.length > 0) return marker[marker.length - 1]![1]!.trim();
  const boxed = [...reply.matchAll(/\\boxed\{([\s\S]*?)\}/g)];
  if (boxed.length > 0) return boxed[boxed.length - 1]![1]!.trim();
  const lines = reply.trim().split("\n").filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : "";
}

/** True iff the extracted math answer matches gold (string-normalized, with a numeric fallback). */
export function scoreMath(reply: string, gold: string): boolean {
  const pred = normalizeMath(extractMathAnswer(reply));
  const g = normalizeMath(gold);
  if (pred === g) return true;
  const pf = Number(pred);
  const gf = Number(g);
  if (Number.isFinite(pf) && Number.isFinite(gf)) return Math.abs(pf - gf) < 1e-6;
  return false;
}

/** Extract a GPQA letter: prefer the 'Answer:' marker, else the last standalone A-D token. */
export function extractGpqaLetter(reply: string): string {
  const marker = [...reply.matchAll(/answer\s*[:=]?\s*\(?\s*([A-D])\b/gi)];
  if (marker.length > 0) return marker[marker.length - 1]![1]!.toUpperCase();
  const any = [...reply.matchAll(/\b([A-D])\b/g)];
  if (any.length > 0) return any[any.length - 1]![1]!.toUpperCase();
  return "";
}

/** True iff the extracted GPQA letter equals gold. */
export function scoreGpqa(reply: string, gold: string): boolean {
  return extractGpqaLetter(reply) === gold.trim().toUpperCase();
}
