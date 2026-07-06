/**
 * __torture__/tornWrite.test.ts — TORN-WRITE SIMULATION + RECOVERY CONVERGENCE
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4c).
 *
 * A real SIGKILL (via `killLoop.ts`'s own machinery — one cycle) leaves a WAL file
 * with genuinely un-checkpointed frames: a clean `store.close()` would defeat the
 * premise, since SQLite checkpoints (and typically truncates) the WAL on the last
 * connection's ordinary close — exactly the content a torn-write test needs to
 * still be sitting there to corrupt. This file corrupts the LAST few bytes of that
 * real WAL file — simulating a write only partially flushed — and asserts SQLite's
 * own WAL-frame-checksum recovery-on-open, plus this suite's `integrityCheck()` and
 * dedicated invariant scan, converge to a clean, internally consistent state:
 * `PRAGMA integrity_check` ok and every "heart of the suite" structural invariant
 * still holds over whatever prefix of history survived.
 *
 * Gated on `TORTURE=1` alongside the rest of `src/__torture__/`; uses the same
 * compiled worker the kill-loop spawns (built on demand).
 */

import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spawnAndKillOnce } from "./killLoop.js";
import { ensureTortureBuilt, WORKER_PATH } from "./buildHelper.js";
import { closeWired, wireEngine } from "./harness.js";
import { checkInvariants, structuralViolations } from "./invariantChecker.js";
import { ALL_ROSTER_SOURCE_IDS } from "./roster.js";

const RUN = process.env["TORTURE"] === "1";

/** Zero out the last `n` bytes of `path` in place (simulates a torn trailing write). */
function corruptTail(path: string, n: number): void {
  const size = statSync(path).size;
  const start = Math.max(0, size - n);
  const fd = openSync(path, "r+");
  try {
    const zeros = Buffer.alloc(size - start, 0);
    writeSync(fd, zeros, 0, zeros.length, start);
  } finally {
    closeSync(fd);
  }
}

(RUN ? describe : describe.skip)("torn-write simulation + recovery convergence", () => {
  it(
    "a corrupted WAL tail (after a real SIGKILL) still converges to a clean, structurally-sound reopen",
    async () => {
      ensureTortureBuilt();
      const workDir = mkdtempSync(join(tmpdir(), "idb-torn-"));
      try {
        const dbPath = join(workDir, "live.db");

        // A REAL crash: spawn the worker, let it run a genuine mix of compound ops,
        // SIGKILL it — never a clean close, so the WAL is left with real,
        // un-checkpointed frames to corrupt. Uses `spawnAndKillOnce` directly (NOT
        // `runKillLoop`, which would immediately reopen-and-cleanly-close to run its
        // own invariant check — checkpointing/truncating the WAL before this test
        // ever gets to corrupt it).
        await spawnAndKillOnce(WORKER_PATH, dbPath, 1, 45);

        const walPath = `${dbPath}-wal`;
        expect(existsSync(walPath)).toBe(true);
        const walSizeBefore = statSync(walPath).size;
        expect(walSizeBefore).toBeGreaterThan(64); // sanity: real WAL content to corrupt

        corruptTail(walPath, 48);

        // Reopen (a SECOND, deliberate reopen on top of the kill-loop's own check):
        // SQLite's WAL-recovery-on-open must converge to a clean, internally sound
        // prefix of history — never a structurally broken file — and every "heart of
        // the suite" invariant must still hold over whatever survived.
        const w = wireEngine(dbPath);
        try {
          const report = checkInvariants(w, ALL_ROSTER_SOURCE_IDS);
          expect(report.integrityOk).toBe(true);
          expect(report.chainOk).toBe(true);
          // The three cross-op structural invariants (RECONCILE_DRIFT is a separate,
          // documented, non-crash finding — see `invariantChecker.ts`'s
          // `KNOWN_NONCRASH_VIOLATION_KINDS`) — this single-cycle fixture is unlikely
          // to even reach an approve(), but either way only structural kinds count.
          expect(structuralViolations(report)).toEqual([]);
        } finally {
          closeWired(w);
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
