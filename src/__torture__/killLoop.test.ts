/**
 * __torture__/killLoop.test.ts — the vitest-visible SMOKE gate for the kill-loop
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4a).
 *
 * Env-gated `TORTURE=1` (never runs as part of the default `npm test`). Builds the
 * torture bundle on demand (`npm run torture:build`, cached under
 * `node_modules/.torture-build` — skipped if already fresh) so `TORTURE=1 npx vitest
 * run src/__torture__` is a single self-contained command, then drives a handful of
 * REAL kill cycles through {@link runKillLoop} and asserts the "heart of the suite"
 * structural invariants (no demotion without OUTRANKS, no APPROVAL without
 * demotions, no half-applied disown) plus integrity_check/verifyChain hold clean.
 * The heavy 200/1000-cycle runs live outside vitest entirely (`npm run torture`, see
 * `runTorture.ts` + the scratchpad run log) — this test's job is just "the wiring
 * works and a small run is clean," cheap enough for CI's optional torture-smoke job
 * (default 5 cycles here; CI runs the CLI separately at 50).
 *
 * KNOWN, PRE-EXISTING, NON-CRASH `RECONCILE_DRIFT` was CLOSED when `approve()`
 * began recording corroboration-event α-mass (see
 * `reconcileDriftApproveRegression.test.ts`). `KNOWN_NONCRASH_VIOLATION_KINDS` is
 * now empty; this smoke still hard-fails on ANY violation kind.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runKillLoop } from "./killLoop.js";
import { ensureTortureBuilt, WORKER_PATH } from "./buildHelper.js";
import { KNOWN_NONCRASH_VIOLATION_KINDS } from "./invariantChecker.js";

const RUN = process.env["TORTURE"] === "1";
const CYCLES = Number(process.env["TORTURE_SMOKE_CYCLES"] ?? "5");

(RUN ? describe : describe.skip)("kill-loop smoke (real SIGKILL, dedicated invariant checker)", () => {
  let workDir = "";

  beforeAll(() => {
    ensureTortureBuilt();
    workDir = mkdtempSync(join(tmpdir(), "idb-torture-smoke-"));
  }, 120_000);

  afterAll(() => {
    if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
  });

  it(`runs ${CYCLES} real kill cycles with zero STRUCTURAL invariant violations`, async () => {
    const dbPath = join(workDir, "torture.db");
    const summary = await runKillLoop({
      workerScriptPath: WORKER_PATH,
      dbPath,
      cycles: CYCLES,
      minDelayMs: 5,
      maxDelayMs: 50,
    });

    const structural = summary.violations.filter(
      (v) => !KNOWN_NONCRASH_VIOLATION_KINDS.has(v.violation.kind),
    );
    if (structural.length > 0) {
      // Surface every violation in the failure message — never just a count.
      const detail = structural
        .map((v) => `cycle ${v.cycle}: [${v.violation.kind}] ${v.violation.detail}`)
        .join("\n");
      throw new Error(`${structural.length} STRUCTURAL invariant violation(s):\n${detail}`);
    }
    expect(summary.cyclesRun).toBe(CYCLES);
  }, 120_000);
});
