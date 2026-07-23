// Wilson 95% score interval (z=1.96) for ASR and accuracy across completed benchmark JSONs.
// Run: node src/__bench__/verification/wilsonCI.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const Z = 1.96;

/** Wilson score interval for a proportion. Returns [lo, hi] in [0,1]. */
function wilson(k, n) {
  if (n <= 0) return [0, 0];
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const pct = (x) => (x * 100).toFixed(1);
const ci = (k, n) => {
  const [lo, hi] = wilson(k, n);
  return `[${pct(lo)},${pct(hi)}]`;
};
const round = (k) => Math.round(k); // success count from rate*n

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => JSON.parse(readFileSync(`${ROOT}/${p}`, 'utf8'));

const rows = []; // {benchmark, arm, asrK, asrN, accK, accN}

// PoisonedRAG: n=100, asr and acc are rates over n.
for (const ds of ['nq', 'hotpotqa', 'msmarco']) {
  const j = read(`.arbor/sessions/poisonedrag/poisonedrag_${ds}_qwen2.5_7b.json`);
  for (const r of j.rows) {
    const n = r.n;
    rows.push({
      benchmark: `poisonedrag-${ds}`,
      arm: r.arm,
      asrK: round(r.asr * n),
      asrN: n,
      accK: round(r.acc * n),
      accN: n,
    });
  }
}

// FactWorld: poisoned-subset metrics over nPoisoned=601.
// ASR = poisonedPoisonAcc is the attacker-success-on-poisoned rate? In factworld asr field is the
// poison-success rate; poisonedPoisonAcc is accuracy on the poisoned subset. Use nPoisoned for both.
{
  const j = read('.arbor/sessions/factworld/factworld_qwen2.5_7b.json');
  const n = j.nPoisoned; // 601
  for (const r of j.rows) {
    rows.push({
      benchmark: 'factworld',
      arm: r.arm,
      asrK: round(r.asr * n),
      asrN: n,
      accK: round(r.poisonedPoisonAcc * n),
      accN: n,
    });
  }
}

// Build markdown table.
let md = '# Wilson 95% Confidence Intervals (z=1.96)\n\n';
md += 'ASR = attack success rate (lower is better). acc = accuracy (higher is better). ';
md += 'CIs are Wilson score intervals on the success count / n.\n\n';
md += '| benchmark | arm | ASR % [lo,hi] | acc % [lo,hi] |\n';
md += '|---|---|---|---|\n';
for (const r of rows) {
  const asr = `${pct(r.asrK / r.asrN)} ${ci(r.asrK, r.asrN)}`;
  const acc = `${pct(r.accK / r.accN)} ${ci(r.accK, r.accN)}`;
  md += `| ${r.benchmark} | ${r.arm} | ${asr} | ${acc} |\n`;
}

// Overlap statements: per real-dataset benchmark, RAG vs IDB(substrate) ASR CI overlap.
md += '\n## ASR CI overlap: RAG vs IDB (substrate) — per benchmark\n\n';
const benches = [...new Set(rows.map((r) => r.benchmark))];
const overlaps = (a, b) => {
  const [alo, ahi] = wilson(a.asrK, a.asrN);
  const [blo, bhi] = wilson(b.asrK, b.asrN);
  return alo <= bhi && blo <= ahi;
};
for (const b of benches) {
  const rag = rows.find((r) => r.benchmark === b && r.arm === 'rag');
  const sub = rows.find((r) => r.benchmark === b && r.arm === 'substrate');
  if (!rag || !sub) continue;
  const ov = overlaps(rag, sub);
  md += `- ${b}: RAG ASR ${ci(rag.asrK, rag.asrN)} vs IDB ASR ${ci(sub.asrK, sub.asrN)} -> ${ov ? 'OVERLAP' : 'NO OVERLAP'}\n`;
}

mkdirSync(`${ROOT}/src/__bench__/reports`, { recursive: true });
writeFileSync(`${ROOT}/src/__bench__/reports/confidence_intervals.md`, md);
process.stdout.write(md);
