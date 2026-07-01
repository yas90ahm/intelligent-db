/**
 * poisonedrag/nonOracleArm.ts — the NON-ORACLE substrate arm.
 *
 * WHY THIS EXISTS. The `substrateArm` in arms.ts is oracle-conditional: it assigns anchor
 * classes / reputation from the ground-truth `kind` ("gold" vs "poison") label, so it proves
 * "given a CORRECT external identity signal, the engine uses it" — not "the engine can find
 * the attacker on its own." This arm removes the oracle. It reads ONLY passage text + the
 * same retrieval vectors every other arm uses. It NEVER reads `kind`, `value`, `source`,
 * `anchor_class`, or `query_id`. The trust partition is DERIVED, in-band, from observable
 * source structure.
 *
 * THE STRUCTURAL SIGNAL. A PoisonedRAG attack must inject N≈5 documents that (a) all match the
 * target query (or they aren't retrieved) and (b) all assert the same crafted answer (or the
 * attack doesn't concentrate). That forces them into a DENSE mutual near-duplicate cluster —
 * measured (nonOracleCalibrate.test.ts): poison-poison cosine mean 0.83-0.89 vs a lone gold
 * passage at 0.56-0.67. A genuine corpus corroboration is textually diverse; a Sybil flood is
 * not. So we apply the web's own rule — "a same-root flood collapses to multiplicity 1; a
 * majority may only collapse AGREEING echoes, never independent roots" — structurally, at
 * retrieval time: any group of >= MIN_ECHO mutually near-duplicate candidates (cosine >= TAU,
 * transitive closure) is treated as ONE witness. Only its single best member survives into the
 * context; the rest are echo-collapsed. The attacker's multiplicity advantage — the entire
 * mechanism of PoisonedRAG — is erased WITHOUT anyone telling the arm which docs are poison.
 *
 * WHAT IT CANNOT DO (stated honestly). It neutralizes MULTIPLICITY, not persuasion: the one
 * surviving echo representative still enters the context at its natural rank, so a lone gold
 * source (PoisonedRAG often ships exactly one) is a 1-vs-1 with the collapsed poison, not a
 * guaranteed win. And an attacker who pays for N genuinely independent, textually diverse
 * sources escapes the collapse — that is the "priced, not prevented" boundary the
 * costlyIndependent bench already charts. This arm measures the FREE, in-band, no-oracle
 * portion of the defense.
 */

import { cosine } from "../retrieval/embed.js";
import type { KBPassage, PRQuestion } from "./data.js";
import type { PrArm } from "./arms.js";

const envNum = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

// Calibrated on nonOracleCalibrate.test.ts: TAU sits in the poison/gold mean-gap for all three
// datasets; MIN_ECHO>=3 collapses only a genuine MULTIPLICITY (never an incidental pair).
const TAU = envNum("NONORACLE_TAU", 0.78);
const MIN_ECHO = envNum("NONORACLE_MINECHO", 3);

function cosTopK(vecs: readonly Float32Array[], qVec: Float32Array, k: number): number[] {
  const scored: Array<{ i: number; s: number }> = [];
  for (let i = 0; i < vecs.length; i++) scored.push({ i, s: cosine(qVec, vecs[i]!) });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, k).map((x) => x.i);
}

/** Union-find over the candidate pool; merge two candidates when their vectors are near-dup. */
function echoClusters(cand: number[], vecs: readonly Float32Array[], tau: number): Map<number, number[]> {
  const parent = new Map<number, number>();
  for (const i of cand) parent.set(i, i);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      if (cosine(vecs[cand[a]!]!, vecs[cand[b]!]!) >= tau) union(cand[a]!, cand[b]!);
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of cand) { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); }
  return groups;
}

export interface NonOracleStats {
  /** Per-query record — labels used ONLY here for measurement, never in the defense path. */
  collapsedIsPoison: number; // echo-collapsed candidates that were, in truth, poison
  collapsedIsGold: number;   // echo-collapsed candidates that were, in truth, gold (false-collapse)
  collapsedTotal: number;
  queries: number;
}

/**
 * Echo-cluster handling:
 *   "collapse" — keep the single best-ranked member of a >= MIN_ECHO cluster, drop the rest
 *                (pure de-duplication: erases the MULTIPLICITY advantage only).
 *   "exclude"  — treat a >= MIN_ECHO near-dup flood as a Sybil signal in itself and drop the
 *                WHOLE cluster (structurally INFERRED distrust — the non-oracle analog of the
 *                oracle arm filtering the demoted poison, but derived from source structure).
 */
export type EchoMode = "collapse" | "exclude";

/**
 * Non-oracle substrate arm. `topN` = cosine candidate pool; near-duplicate clusters of size
 * >= MIN_ECHO are collapsed to their single best member; the surviving top-K is the context.
 * Optionally accumulates measurement-only stats into `stats` (uses labels for scoring ONLY).
 */
export function nonOracleSubstrateArm(
  passages: readonly KBPassage[],
  vecs: readonly Float32Array[],
  topN: number,
  k: number,
  stats?: NonOracleStats,
  mode: EchoMode = "collapse",
): PrArm {
  return {
    id: "substrate", // reported under a distinct label by the runner
    async contextFor(_q: PRQuestion, qVec: Float32Array) {
      const cand = cosTopK(vecs, qVec, topN); // cosine-sorted candidate indices
      const groups = echoClusters(cand, vecs, TAU);
      const rank = new Map<number, number>();
      cand.forEach((i, r) => rank.set(i, r));
      // For each echo cluster of size >= MIN_ECHO: "collapse" keeps the best-ranked member and
      // drops the rest; "exclude" drops the entire flood (best member included).
      const dropped = new Set<number>();
      for (const members of groups.values()) {
        if (members.length < MIN_ECHO) continue;
        const best = mode === "collapse" ? members.reduce((a, b) => (rank.get(a)! <= rank.get(b)! ? a : b)) : -1;
        for (const m of members) if (m !== best) {
          dropped.add(m);
          if (stats) {
            stats.collapsedTotal++;
            if (passages[m]!.kind === "poison") stats.collapsedIsPoison++;
            else if (passages[m]!.kind === "gold") stats.collapsedIsGold++;
          }
        }
      }
      if (stats) stats.queries++;
      const kept: string[] = [];
      for (const i of cand) {
        if (dropped.has(i)) continue;
        kept.push(passages[i]!.text);
        if (kept.length >= k) break;
      }
      return kept;
    },
  };
}
