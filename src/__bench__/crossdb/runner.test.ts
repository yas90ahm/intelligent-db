/**
 * runner.test.ts — the CROSS-DB BASELINE RUNNER.
 *
 * GATED so the normal suite (`npm test` / `vitest run`) does NOT execute the heavy
 * measurement — the whole describe is registered only when CROSSDB_BENCH=1, so the
 * existing tests are unaffected (with the flag unset this file contributes one skipped
 * suite and zero work). Invoke the baseline explicitly:
 *
 *     CROSSDB_BENCH=1 npx vitest run src/__bench__/crossdb/runner.test.ts
 *
 * (A vitest TEST file is used, not a `.bench.ts`, because vitest's bench mode does not
 * run `beforeAll`/`it` bodies the way the metric collection needs; a plain `it` invoked
 * via `vitest run` is the reliable harness — exactly the spec's "or a plain runner you
 * invoke with npx vitest run".)
 *
 * Timing uses `performance.now()` directly (identical for every engine) to compute the
 * four metrics; results are written to BOTH metrics.json and results.md under an
 * absolute Arbor session path so they survive worktree teardown.
 *
 * Determinism: every fact is index-derived (no Math.random, no wall-clock dependence).
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Fact, Cue, MemoryAdapter } from "./adapter.js";
import { embed } from "./embeddings.js";
import { buildCheapSybilAttack } from "./attack.js";

import { createNodeSqliteAdapter } from "./adapters/nodeSqlite.js";
import { createBetterSqliteAdapter } from "./adapters/betterSqlite.js";
import { createLmdbAdapter } from "./adapters/lmdbStore.js";
import { createDuckDbAdapter } from "./adapters/duckdbStore.js";
import { createVectorBruteforceAdapter } from "./adapters/vectorBruteforce.js";
import { createIntelligentDbAdapter } from "./adapters/intelligentDb.js";

// --- Fixed, identical workload across every engine -------------------------------

const N = 5000; // facts written (write_hz denominator)
const RECALLS = 250; // >= 200 recalls for the median latency
const H = 3; // honest witnesses asserting TRUE
const A_VALUES = [5, 50, 200]; // attacker fleet sizes
const TRIALS_PER_A = 8; // 3 x 8 = 24 attack trials (>= 20)

const OUT_DIR = "D:/Intelligent DB/.arbor/sessions/cross-db-bench/experiments/1";

/** Deterministic generic write workload (N facts, no attack). */
function genericFacts(): Fact[] {
  const facts: Fact[] = [];
  for (let i = 0; i < N; i++) {
    const entity = `ent:${i % 500}`;
    const attribute = `attr:${i % 50}`;
    const value = `val:${i % 1000}`;
    facts.push({
      entity,
      attribute,
      value,
      sourceId: `src:${i % 200}`,
      independenceClass: `cls:${i % 200}`,
      embedding: embed(`${entity} ${attribute} ${value}`),
    });
  }
  return facts;
}

/** Deterministic recall cues over the populated generic data. */
function recallCues(): Cue[] {
  const cues: Cue[] = [];
  for (let j = 0; j < RECALLS; j++) {
    const entity = `ent:${j % 500}`;
    const attribute = `attr:${j % 50}`;
    cues.push({ entity, attribute, embedding: embed(`${entity} ${attribute}`) });
  }
  return cues;
}

interface AdapterResult {
  name: string;
  write_hz: number;
  recall_ms: number;
  poison_correct_rate: number;
  bytes_per_fact: number;
  footprint_bytes: number;
  footprint_source: string;
  poison_trials: number;
  poison_correct: number;
}

interface SkipResult {
  name: string;
  reason: string;
}

interface Registration {
  name: string;
  footprintKind: "on-disk file" | "in-memory estimate" | "heap delta";
  make: () => MemoryAdapter;
}

const REGISTRY: Registration[] = [
  { name: "node:sqlite (builtin)", footprintKind: "on-disk file", make: createNodeSqliteAdapter },
  { name: "better-sqlite3", footprintKind: "on-disk file", make: createBetterSqliteAdapter },
  { name: "lmdb", footprintKind: "on-disk file", make: createLmdbAdapter },
  { name: "duckdb (@duckdb/node-api)", footprintKind: "on-disk file", make: createDuckDbAdapter },
  { name: "vector-bruteforce (in-proc)", footprintKind: "in-memory estimate", make: createVectorBruteforceAdapter },
  { name: "IntelligentDB (engine)", footprintKind: "heap delta", make: createIntelligentDbAdapter },
];

// Curated skips for adapters that could not install/build in this environment.
const SKIPS: SkipResult[] = [
  {
    name: "hnswlib-node",
    reason:
      "No prebuilt binary for win32-x64 / Node 24; npm install falls back to `node-gyp rebuild`, " +
      "which needs an MSVC toolchain (absent on this box) — the native module never built (Cannot find module 'hnswlib-node').",
  },
  {
    name: "faiss-node",
    reason: "Not attempted by directive (requires MSVC to build) — would fail identically to hnswlib-node.",
  },
];

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? "unknown error";
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

async function measure(
  reg: Registration,
  generic: Fact[],
  cues: Cue[],
  results: AdapterResult[],
): Promise<void> {
  let adapter: MemoryAdapter;
  try {
    adapter = reg.make();
  } catch (err) {
    SKIPS.push({ name: reg.name, reason: firstLine(err) });
    return;
  }

  try {
    await adapter.setup();

    // --- WRITE PHASE (write_hz + footprint) ---
    const g = globalThis as { gc?: () => void };
    g.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (const f of generic) await adapter.writeFact(f);
    if (adapter.flush) await adapter.flush();
    const writeMs = performance.now() - t0;
    g.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    const write_hz = N / (writeMs / 1000);

    // --- RECALL PHASE (median latency over RECALLS recalls) ---
    const lat: number[] = [];
    for (const c of cues) {
      const s = performance.now();
      await adapter.recall(c);
      lat.push(performance.now() - s);
    }
    lat.sort((a, b) => a - b);
    const recall_ms = lat[Math.floor(lat.length / 2)] ?? 0;

    // --- FOOTPRINT ---
    const fp = adapter.footprintBytes();
    const heapDelta = Math.max(0, heapAfter - heapBefore);
    const footprint_bytes = fp > 0 ? fp : heapDelta;
    const footprint_source = fp > 0 ? reg.footprintKind : "heap delta";
    const bytes_per_fact = footprint_bytes / N;

    // --- POISON PHASE (cheap-Sybil attack trials) ---
    let poison_correct = 0;
    let poison_trials = 0;
    for (const A of A_VALUES) {
      for (let t = 0; t < TRIALS_PER_A; t++) {
        const sc = buildCheapSybilAttack(`atk:${reg.name}:${A}:${t}`, H, A);
        for (const f of sc.facts) await adapter.writeFact(f);
        if (adapter.flush) await adapter.flush();
        const ranked = await adapter.recall(sc.cue);
        poison_trials++;
        if (ranked.length > 0 && ranked[0]!.value === sc.trueValue) poison_correct++;
      }
    }
    const poison_correct_rate = poison_correct / poison_trials;

    await adapter.close();

    results.push({
      name: reg.name,
      write_hz,
      recall_ms,
      poison_correct_rate,
      bytes_per_fact,
      footprint_bytes,
      footprint_source,
      poison_trials,
      poison_correct,
    });
  } catch (err) {
    try {
      await adapter.close();
    } catch {
      /* best effort */
    }
    SKIPS.push({ name: reg.name, reason: "RUNTIME: " + firstLine(err) });
  }
}

function writeArtifacts(results: AdapterResult[]): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const metrics = {
    config: { N, RECALLS, H, A_VALUES, TRIALS_PER_A, node: process.version, platform: process.platform },
    adapters: results,
    skipped: SKIPS,
  };
  writeFileSync(`${OUT_DIR}/metrics.json`, JSON.stringify(metrics, null, 2), "utf8");

  const lines: string[] = [];
  lines.push("# Cross-DB Baseline — Intelligent DB vs dumb stores under cheap-Sybil poisoning");
  lines.push("");
  lines.push(
    `Workload: N=${N} facts written, ${RECALLS} recalls (median latency), ` +
      `${A_VALUES.length * TRIALS_PER_A} attack trials (H=${H} honest, A in {${A_VALUES.join(", ")}}). ` +
      `Node ${process.version} on ${process.platform}.`,
  );
  lines.push("");
  lines.push(
    "`poison_correct_rate` = fraction of cheap-Sybil trials where the engine recalled the TRUE value. " +
      "A trust-blind store (SQL/KV majority, vector nearest-neighbour) is EXPECTED to score 0 (it speaks the FALSE majority); " +
      "the IntelligentDB engine collapses the fleet to one independent witness and scores 1.",
  );
  lines.push("");
  lines.push("| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes_per_fact | footprint source |");
  lines.push("|---|---:|---:|---:|---:|:--|");
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${fmt(r.write_hz, 0)} | ${fmt(r.recall_ms, 3)} | ` +
        `${fmt(r.poison_correct_rate, 2)} (${r.poison_correct}/${r.poison_trials}) | ` +
        `${fmt(r.bytes_per_fact, 1)} | ${r.footprint_source} |`,
    );
  }
  lines.push("");
  lines.push("## SKIPPED adapters");
  lines.push("");
  if (SKIPS.length === 0) {
    lines.push("_None — every targeted adapter installed and ran._");
  } else {
    for (const s of SKIPS) lines.push(`- **${s.name}** — ${s.reason}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- **Footprint source**: on-disk file = data + WAL file size after flush; in-memory estimate = " +
      "dense embedding bytes (N x 64 x 4) + value strings; heap delta = `process.memoryUsage().heapUsed` " +
      "before/after the write loop (approximate — GC was nudged only if `--expose-gc` was passed).",
  );
  lines.push(
    "- **Dumb-store recall**: SQL/KV engines return the MAJORITY value for the (entity, attribute) " +
      "(ties broken by most-recent); the vector engine returns the majority value among the top-128 " +
      "nearest neighbours of the cue embedding. None has a provenance/independence model, so all are " +
      "poisoned once the cheap fleet out-copies the truth — the honest, expected result.",
  );
  lines.push(
    "- **IntelligentDB recall**: groups the asserted facts by value and ranks each value by the REAL " +
      "Source-Identity Layer `independentRootCount` (maximum-independent-set over anchor-class " +
      "disjointness). Writes go through the genuine engine `writeFact`. The attacker controls keys, not " +
      "class assignment (the external anchor layer's output), exactly as the Phase-2 capability test models.",
  );
  lines.push(
    "- **hnswlib-node** (the intended native vector engine) has no win32-x64/Node-24 prebuilt and needs " +
      "MSVC to build, so the zero-dep `vector-bruteforce` index stands in for the vector-DB class.",
  );

  writeFileSync(`${OUT_DIR}/results.md`, lines.join("\n"), "utf8");
}

const RUN = process.env["CROSSDB_BENCH"] === "1";

(RUN ? describe : describe.skip)("cross-db baseline runner", () => {
  it(
    "measures every available adapter and writes the baseline table",
    async () => {
      const generic = genericFacts();
      const cues = recallCues();
      const results: AdapterResult[] = [];
      for (const reg of REGISTRY) {
        await measure(reg, generic, cues, results);
      }
      writeArtifacts(results);
      // eslint-disable-next-line no-console
      console.log("\n[cross-db] wrote", `${OUT_DIR}/results.md`);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ adapters: results, skipped: SKIPS }, null, 2));
      expect(results.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
