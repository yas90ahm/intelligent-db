/**
 * __torture__/killLoop.ts — THE KILL-LOOP DRIVER (docs/specs/PHASE2_DURABILITY_SPEC.md
 * §4a).
 *
 * For each cycle: spawn `killWorker.js` (a real, separate OS process) against a
 * persistent db file, let it run randomized compound ops for a random 5-50ms, then
 * forcibly kill it (`SIGKILL` — on Windows `ChildProcess.kill()` always terminates
 * the process forcefully/abruptly regardless of the signal name, which is exactly
 * the "no unwind, no flush, no atexit" crash this suite needs). Reopen the SAME db
 * file in-process and run the dedicated {@link checkInvariants} scan. The db file is
 * NOT reset between cycles — state accumulates across the whole run, so later
 * cycles torture an increasingly large, increasingly realistic graph (and every
 * reopen also exercises real WAL-recovery-on-open, not just a fresh empty db).
 *
 * This module is a plain library function — it does not read `process.env` and does
 * not gate on `TORTURE=1` itself (that gate lives in the two callers:
 * `runTorture.ts`, the standalone CLI entry, and `killLoop.test.ts`, the vitest
 * smoke test).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { closeWired, wireEngine } from "./harness.js";
import { checkInvariants } from "./invariantChecker.js";
import type { InvariantReport } from "./invariantChecker.js";
import { ALL_ROSTER_SOURCE_IDS } from "./roster.js";

export interface KillCycleResult {
  readonly cycle: number;
  readonly killDelayMs: number;
  readonly childExitCode: number | null;
  readonly childSignal: NodeJS.Signals | null;
  readonly report: InvariantReport;
}

export interface KillLoopOptions {
  /** Absolute path to the compiled `killWorker.js` (see `runTorture.ts` / the build step). */
  readonly workerScriptPath: string;
  /** The db file every cycle shares (created fresh if absent). */
  readonly dbPath: string;
  readonly cycles: number;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Fired after EVERY cycle (including violations) — the caller's logging hook. */
  readonly onCycle?: (result: KillCycleResult) => void;
  /** Delete any pre-existing db at `dbPath` before cycle 1. Default `true`. */
  readonly resetDb?: boolean;
}

export interface KillLoopSummary {
  readonly cyclesRun: number;
  readonly violations: readonly { readonly cycle: number; readonly violation: InvariantReport["violations"][number] }[];
  readonly results: readonly KillCycleResult[];
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function removeDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

export interface SpawnAndKillResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Spawn the worker, wait for its `TORTURE_READY` stdout line (so the kill delay is
 * timed from "the op loop actually started," not from raw process spawn — Node
 * cold-start alone can eat the whole 5-50ms window otherwise), then wait `delayMs`
 * more, forcibly kill it, and await its exit. Falls back to timing from spawn if
 * READY never arrives within a generous cap (a worker that fails to even wire up
 * is itself worth catching, not silently waiting on forever).
 *
 * Exported (not just used internally by {@link runKillLoop}) so a caller that needs
 * the RAW post-crash file — e.g. `tornWrite.test.ts`, which must corrupt the WAL
 * BEFORE anything does a clean reopen-and-close (a clean close checkpoints/truncates
 * the WAL, destroying the very un-checkpointed content a torn-write test needs) —
 * can drive one real SIGKILL without `runKillLoop`'s own post-cycle invariant-check
 * reopen consuming the WAL first.
 */
export function spawnAndKillOnce(
  workerScriptPath: string,
  dbPath: string,
  seed: number,
  delayMs: number,
): Promise<SpawnAndKillResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerScriptPath, dbPath, String(seed)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({ exitCode, signal });
    };
    const scheduleKill = (): void => {
      if (settled || killTimer !== null) return;
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited on its own (a thrown/uncaught op) —
          // fine, the exit handler below already resolved.
        }
      }, delayMs);
    };

    let readySeen = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (readySeen) return;
      if (chunk.toString("utf8").includes("TORTURE_READY")) {
        readySeen = true;
        scheduleKill();
      }
    });
    // Fallback: if READY never arrives (a worker that crashes during wiring, or an
    // unexpectedly slow cold start), still schedule the kill so a cycle can never
    // hang the whole loop — timed generously past normal cold-start latency.
    const readyFallback = setTimeout(scheduleKill, 2000);

    child.on("exit", (code, signal) => {
      clearTimeout(readyFallback);
      finish(code, signal);
    });
    child.on("error", () => {
      clearTimeout(readyFallback);
      finish(null, null);
    });
  });
}

/** Run `cycles` kill-and-check iterations against one persistent db file. */
export async function runKillLoop(opts: KillLoopOptions): Promise<KillLoopSummary> {
  const minDelayMs = opts.minDelayMs ?? 5;
  const maxDelayMs = opts.maxDelayMs ?? 50;
  const resetDb = opts.resetDb ?? true;

  mkdirSync(dirname(opts.dbPath), { recursive: true });
  if (resetDb) removeDbFiles(opts.dbPath);

  const results: KillCycleResult[] = [];
  const violations: Array<{ cycle: number; violation: InvariantReport["violations"][number] }> = [];

  for (let cycle = 1; cycle <= opts.cycles; cycle++) {
    const delayMs = randomInt(minDelayMs, maxDelayMs);
    const seed = cycle * 2654435761; // Knuth multiplicative hash — decorrelates per-cycle seeds
    const { exitCode, signal } = await spawnAndKillOnce(opts.workerScriptPath, opts.dbPath, seed, delayMs);

    // Reopen fresh (a real reopen — a new DatabaseSync handle, exercising real
    // WAL-recovery-on-open) and run the dedicated invariant scan.
    const w = wireEngine(opts.dbPath);
    let report: InvariantReport;
    try {
      report = checkInvariants(w, ALL_ROSTER_SOURCE_IDS);
    } finally {
      closeWired(w);
    }

    const result: KillCycleResult = {
      cycle,
      killDelayMs: delayMs,
      childExitCode: exitCode,
      childSignal: signal,
      report,
    };
    results.push(result);
    for (const violation of report.violations) {
      violations.push({ cycle, violation });
    }
    opts.onCycle?.(result);
  }

  return { cyclesRun: results.length, violations, results };
}
