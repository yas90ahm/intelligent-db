/**
 * retrieval/metrics.ts — ranking + contradiction + halting-quality metrics.
 *
 * All ranking metrics take a RANKED list of fact ids and the planted relevant set.
 * Binary relevance. Macro-averaged across queries; category breakdowns are computed
 * by filtering the per-query results.
 */

export interface RankMetrics {
  recall1: number;
  recall5: number;
  recall10: number;
  recall20: number;
  precision1: number;
  precision5: number;
  precision10: number;
  mrr: number;
  ndcg10: number;
}

const ZERO: RankMetrics = {
  recall1: 0, recall5: 0, recall10: 0, recall20: 0,
  precision1: 0, precision5: 0, precision10: 0, mrr: 0, ndcg10: 0,
};

function recallAtK(ranked: readonly string[], rel: ReadonlySet<string>, k: number): number {
  if (rel.size === 0) return 0;
  let hit = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (rel.has(ranked[i]!)) hit++;
  return hit / rel.size;
}

function precisionAtK(ranked: readonly string[], rel: ReadonlySet<string>, k: number): number {
  if (k === 0) return 0;
  let hit = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) if (rel.has(ranked[i]!)) hit++;
  return hit / k;
}

function reciprocalRank(ranked: readonly string[], rel: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) if (rel.has(ranked[i]!)) return 1 / (i + 1);
  return 0;
}

function ndcgAtK(ranked: readonly string[], rel: ReadonlySet<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (rel.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, rel.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function queryMetrics(ranked: readonly string[], rel: ReadonlySet<string>): RankMetrics {
  return {
    recall1: recallAtK(ranked, rel, 1),
    recall5: recallAtK(ranked, rel, 5),
    recall10: recallAtK(ranked, rel, 10),
    recall20: recallAtK(ranked, rel, 20),
    precision1: precisionAtK(ranked, rel, 1),
    precision5: precisionAtK(ranked, rel, 5),
    precision10: precisionAtK(ranked, rel, 10),
    mrr: reciprocalRank(ranked, rel),
    ndcg10: ndcgAtK(ranked, rel, 10),
  };
}

export function meanMetrics(rows: readonly RankMetrics[]): RankMetrics {
  if (rows.length === 0) return { ...ZERO };
  const acc: RankMetrics = { ...ZERO };
  const keys = Object.keys(ZERO) as Array<keyof RankMetrics>;
  for (const r of rows) for (const k of keys) acc[k] += r[k];
  for (const k of keys) acc[k] /= rows.length;
  return acc;
}

// ---------------------------------------------------------------------------
// Halting quality (ID only)
// ---------------------------------------------------------------------------

export interface HaltingQuality {
  /** |lit| — the size of the engine's auto-halted set. */
  litSize: number;
  autoPrecision: number;
  autoRecall: number;
  autoF1: number;
  /** The oracle best-prefix length (the K that maximizes F1 over ID's ranking). */
  oracleK: number;
  oraclePrecision: number;
  oracleRecall: number;
  oracleF1: number;
  f1At5: number;
  f1At10: number;
}

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function prAt(ranked: readonly string[], rel: ReadonlySet<string>, k: number): { p: number; r: number } {
  return { p: precisionAtK(ranked, rel, k), r: recallAtK(ranked, rel, k) };
}

/**
 * Compare the engine's AUTO-HALTED lit set (the full `ranked` output) to the ORACLE
 * best-K prefix (the prefix length maximizing F1 vs ground truth) and to fixed K=5,10.
 */
export function haltingQuality(ranked: readonly string[], rel: ReadonlySet<string>): HaltingQuality {
  const litSize = ranked.length;
  const auto = prAt(ranked, rel, litSize);
  let oracleK = 0;
  let oracleF1 = 0;
  let oraclePrecision = 0;
  let oracleRecall = 0;
  for (let k = 1; k <= litSize; k++) {
    const { p, r } = prAt(ranked, rel, k);
    const f = f1(p, r);
    if (f > oracleF1) {
      oracleF1 = f;
      oracleK = k;
      oraclePrecision = p;
      oracleRecall = r;
    }
  }
  const a5 = prAt(ranked, rel, 5);
  const a10 = prAt(ranked, rel, 10);
  return {
    litSize,
    autoPrecision: auto.p,
    autoRecall: auto.r,
    autoF1: f1(auto.p, auto.r),
    oracleK,
    oraclePrecision,
    oracleRecall,
    oracleF1,
    f1At5: f1(a5.p, a5.r),
    f1At10: f1(a10.p, a10.r),
  };
}

export interface HaltingSummary {
  meanLitSize: number;
  meanAutoF1: number;
  meanOracleF1: number;
  autoOverOracle: number; // F1(auto)/F1(oracle)
  meanF1At5: number;
  meanF1At10: number;
  /** Mean (litSize - oracleK): >0 => auto-halt OVER-shoots; <0 => UNDER-shoots. */
  meanOvershoot: number;
}

export function summarizeHalting(rows: readonly HaltingQuality[]): HaltingSummary {
  const n = rows.length || 1;
  let lit = 0, autoF1 = 0, oracleF1 = 0, ratio = 0, f5 = 0, f10 = 0, over = 0, ratioCount = 0;
  for (const r of rows) {
    lit += r.litSize;
    autoF1 += r.autoF1;
    oracleF1 += r.oracleF1;
    f5 += r.f1At5;
    f10 += r.f1At10;
    over += r.litSize - r.oracleK;
    if (r.oracleF1 > 0) {
      ratio += r.autoF1 / r.oracleF1;
      ratioCount++;
    }
  }
  return {
    meanLitSize: lit / n,
    meanAutoF1: autoF1 / n,
    meanOracleF1: oracleF1 / n,
    autoOverOracle: ratioCount ? ratio / ratioCount : 0,
    meanF1At5: f5 / n,
    meanF1At10: f10 / n,
    meanOvershoot: over / n,
  };
}
