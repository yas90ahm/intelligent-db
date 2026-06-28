/**
 * retrieval/qa/qaScore.ts — SQuAD/LoCoMo-style short-answer scoring.
 *
 * Standard normalized metrics for a free-text reader answer vs a gold short answer:
 *   - normalize: lowercase, strip punctuation, drop articles (a/an/the), collapse spaces.
 *   - token-F1: harmonic mean of token precision/recall over the normalized token bags
 *     (multiset overlap — the canonical SQuAD F1).
 *   - exact-match (EM): 1 iff the normalized strings are equal.
 *   - containment: 1 iff the normalized gold appears as a contiguous token subsequence of
 *     the normalized prediction (LLM readers are verbose — a gold buried in a sentence is
 *     a correct answer that strict EM would miss). This is the headline `em` the runner
 *     reports, since strict EM on a generative reader is near-degenerate.
 *
 * Pure, dependency-free, deterministic.
 */

const ARTICLES = new Set(["a", "an", "the"]);

/** Lowercase, strip punctuation to spaces, drop articles, collapse whitespace. */
export function normalizeAnswer(s: string): string {
  const lowered = s.toLowerCase();
  // Collapse digit-group separators FIRST so "125,000" == "125000" (LLM readers freely
  // reformat numbers; this is symmetric across every arm/context, so it does not bias the
  // comparison — it only stops a formatting choice from masking a correct numeric answer).
  const denum = lowered.replace(/(?<=\d)[,_](?=\d)/g, "");
  // Replace anything that is not a letter/number/space with a space (punctuation strip).
  const depunct = denum.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const toks = depunct.split(/\s+/).filter((t) => t.length > 0 && !ARTICLES.has(t));
  return toks.join(" ");
}

/** Normalized token list (the bag the F1 metric compares). */
export function normTokens(s: string): string[] {
  const n = normalizeAnswer(s);
  return n.length === 0 ? [] : n.split(" ");
}

/** SQuAD token-level F1 over the normalized multisets. */
export function tokenF1(pred: string, gold: string): number {
  const p = normTokens(pred);
  const g = normTokens(gold);
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  // multiset intersection
  const goldCount = new Map<string, number>();
  for (const t of g) goldCount.set(t, (goldCount.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = goldCount.get(t) ?? 0;
    if (c > 0) {
      overlap += 1;
      goldCount.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Strict normalized exact match. */
export function exactMatch(pred: string, gold: string): number {
  return normalizeAnswer(pred) === normalizeAnswer(gold) ? 1 : 0;
}

/** Containment: 1 iff normalized gold is a contiguous token subsequence of normalized pred. */
export function containment(pred: string, gold: string): number {
  const p = normTokens(pred);
  const g = normTokens(gold);
  if (g.length === 0) return p.length === 0 ? 1 : 0;
  if (p.length < g.length) return 0;
  for (let i = 0; i + g.length <= p.length; i++) {
    let ok = true;
    for (let j = 0; j < g.length; j++) {
      if (p[i + j] !== g[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return 1;
  }
  return 0;
}

export interface QaScore {
  readonly f1: number;
  /** Headline match: strict EM OR containment (a gold buried in a verbose answer counts). */
  readonly em: number;
  readonly exact: number;
  readonly contains: number;
}

/** Score a reader answer against a gold short answer. */
export function scoreAnswer(pred: string, gold: string): QaScore {
  const exact = exactMatch(pred, gold);
  const contains = containment(pred, gold);
  return {
    f1: tokenF1(pred, gold),
    em: exact === 1 || contains === 1 ? 1 : 0,
    exact,
    contains,
  };
}
