/**
 * __torture__/runTorture.ts — the standalone CLI entry point for the kill-loop.
 *
 * Env-gated (`TORTURE=1` — docs/specs/PHASE2_DURABILITY_SPEC.md §4): refuses to run
 * otherwise, so this can never accidentally execute as part of a normal build/test.
 *
 *   TORTURE=1 CYCLES=200 npm run torture
 *
 * Env knobs: CYCLES (default 50 — the CI-smoke count), MIN_DELAY_MS (default 5),
 * MAX_DELAY_MS (default 50), DB_PATH (default a fresh file under os.tmpdir()),
 * SUMMARY_JSON (optional path to also write the full JSON summary).
 *
 * Prints one line per cycle to stdout (cheap progress for a backgrounded run being
 * polled) and a final summary; every violation is printed regardless of kind (never
 * silently dropped), but the PROCESS EXIT CODE reflects only STRUCTURAL violations
 * (`invariantChecker.ts`'s `KNOWN_NONCRASH_VIOLATION_KINDS` — see its doc: a
 * pre-existing, reproducible-without-a-kill `RECONCILE_DRIFT` this suite surfaced,
 * not a crash-consistency bug) — exits 0 iff zero STRUCTURAL violations occurred,
 * else exits 1, so CI's smoke job fails loudly on any real atomicity regression
 * without perpetually red-lining on a known, already-reported, non-crash finding.
 *
 * REQUIRES a build step first (this file — like the rest of `__torture__` — uses
 * runtime TS enums, so it must be compiled, not type-stripped): see
 * `tsconfig.torture.json` / the `npm run torture` script.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";

import { runKillLoop } from "./killLoop.js";
import { KNOWN_NONCRASH_VIOLATION_KINDS } from "./invariantChecker.js";

if (process.env["TORTURE"] !== "1") {
  console.error(
    "runTorture: refusing to run without TORTURE=1 (docs/specs/PHASE2_DURABILITY_SPEC.md §4 " +
      "env-gates the whole suite off by default).",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const workerScriptPath = join(here, "killWorker.js");

const cycles = Number(process.env["CYCLES"] ?? "50");
const minDelayMs = Number(process.env["MIN_DELAY_MS"] ?? "5");
const maxDelayMs = Number(process.env["MAX_DELAY_MS"] ?? "50");
const dbPath = process.env["DB_PATH"] ?? join(tmpdir(), `idb-torture-${Date.now()}.db`);
const summaryJsonPath = process.env["SUMMARY_JSON"];

console.log(
  `runTorture: ${cycles} kill-cycles, delay ${minDelayMs}-${maxDelayMs}ms, db=${dbPath}`,
);

const startedAt = Date.now();

const summary = await runKillLoop({
  workerScriptPath,
  dbPath,
  cycles,
  minDelayMs,
  maxDelayMs,
  onCycle: (result) => {
    const status = result.report.ok ? "OK" : `VIOLATIONS(${result.report.violations.length})`;
    console.log(
      `cycle ${result.cycle}/${cycles} killDelay=${result.killDelayMs}ms ` +
        `exit=${String(result.childExitCode)} signal=${String(result.childSignal)} ` +
        `strands=${result.report.strandsScanned} demoted=${result.report.demotedScanned} ` +
        `approvals=${result.report.approvalsScanned} disowned=${result.report.disownedSourcesScanned} ` +
        `-> ${status}`,
    );
    if (!result.report.ok) {
      for (const v of result.report.violations) {
        console.error(`  VIOLATION [${v.kind}] ${v.detail}`);
      }
    }
  },
});

const structural = summary.violations.filter(
  (v) => !KNOWN_NONCRASH_VIOLATION_KINDS.has(v.violation.kind),
);
const elapsedMs = Date.now() - startedAt;
console.log(
  `runTorture: ${summary.cyclesRun} cycles complete in ${elapsedMs}ms, ` +
    `${summary.violations.length} total violations (${structural.length} STRUCTURAL, ` +
    `${summary.violations.length - structural.length} known non-crash).`,
);

if (summaryJsonPath !== undefined) {
  writeFileSync(
    summaryJsonPath,
    JSON.stringify(
      { cyclesRun: summary.cyclesRun, elapsedMs, violations: summary.violations, structuralCount: structural.length },
      null,
      2,
    ),
  );
}

process.exit(structural.length === 0 ? 0 : 1);
