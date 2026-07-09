/**
 * Bare memory smoke: spreading/graph recall with ZERO trust/poison focus.
 * Run: node scripts/bare-memory-demo.mjs
 */
import { createAgentMemory } from '../dist/index.js';

const mem = createAgentMemory();

const remembered = [
  mem.remember({ entity: 'Alice', attribute: 'lives_in', text: 'Alice lives in Berlin' }),
  mem.remember({ entity: 'Alice', attribute: 'works_at', text: 'Alice works at Acme' }),
  mem.remember({ entity: 'Bob', attribute: 'lives_in', text: 'Bob lives in Paris' }),
  mem.remember({ entity: 'Bob', attribute: 'works_at', text: 'Bob works at Acme' }),
];

console.log('=== remembered strandIds ===');
for (const r of remembered) {
  console.log(JSON.stringify(r));
}

const cue = 'where does Alice live';
const { facts, halt } = mem.recall(cue);

console.log('\n=== recall:', JSON.stringify(cue), '===');
console.log('halt:', JSON.stringify(halt));
console.log('fact count:', facts.length);
for (const f of facts) {
  console.log(
    JSON.stringify({
      text: f.text,
      strandId: f.strandId,
      activation: f.activation,
      fact_state: f.fact_state,
      contested: f.contested,
    }),
  );
}

const aliceTexts = facts.filter((f) => /alice/i.test(f.text));
const bobTexts = facts.filter((f) => /bob/i.test(f.text));
console.log('\n=== Alice vs Bob preference ===');
console.log('Alice-related facts in recall:', aliceTexts.length);
console.log('Bob-related facts in recall:', bobTexts.length);
if (facts.length > 0) {
  const top = facts[0];
  console.log('top fact is Alice-related:', /alice/i.test(top.text));
  console.log('top text:', top.text);
}

const target = facts.find((f) => /alice.*berlin|berlin/i.test(f.text)) ?? facts[0];
if (target) {
  const report = mem.explain(target);
  console.log('\n=== explain (graph-ish / entity fields) ===');
  if (report == null) {
    console.log('explain returned null');
  } else {
    console.log(
      JSON.stringify(
        {
          entity: report.entity,
          attribute: report.attribute,
          hasEntityField: report.entity != null && String(report.entity).length > 0,
          keys: Object.keys(report),
        },
        null,
        2,
      ),
    );
  }
}

mem.close?.();
