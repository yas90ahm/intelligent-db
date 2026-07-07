/**
 * daemon/__torture__/daemonKillLoop.test.ts — the vitest-visible SMOKE gate for
 * the DAEMON crash-torture loop (H4). Env-gated `DAEMON_TORTURE=1` (never runs
 * as part of the default `npm test`, mirroring `src/__torture__/killLoop.test.ts`'s
 * own convention for the exact same reason: a real SIGKILL loop is slow and
 * not required for every commit's default gate). Default 5 cycles here; the
 * verifier's actual report ran 25+ cycles via `DAEMON_TORTURE_CYCLES=25`.
 *
 * SCOPE NOTE (see `daemonKillLoop.ts`'s module doc for the full explanation):
 * "both chains verify" here means (1) the memory store's structural
 * `PRAGMA integrity_check` and (2) the daemon's OWN durable R8 audit chain
 * (`auditChainSqlite.ts`). The fact/ratification checksum chain
 * (`ratification/pendingLedger.ts`) is wired IN-MEMORY by
 * `agent/agentMemory.ts`'s `createAgentMemory` facade regardless of `dbPath`
 * — a pre-existing facade characteristic (not a daemon regression) documented
 * in `CLAUDE.md`'s KNOWN LIMITATIONS and in that module's own comment — so it
 * resets on every daemon restart (crash or clean) and is out of scope for
 * this specific "both chains" check.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureDaemonBuilt } from "../__e2e__/support.js";
import { runDaemonKillLoop, resetWorkDir } from "./daemonKillLoop.js";

const RUN = process.env["DAEMON_TORTURE"] === "1";
const CYCLES = Number(process.env["DAEMON_TORTURE_CYCLES"] ?? "5");

(RUN ? describe : describe.skip)("daemon kill-loop (real SIGKILL of the daemon process, H4)", () => {
  let workDir = "";

  beforeAll(() => {
    ensureDaemonBuilt();
    workDir = mkdtempSync(join(tmpdir(), "iddb-daemon-torture-"));
  }, 180_000);

  afterAll(() => {
    if (workDir !== "") resetWorkDir(workDir);
  });

  it(`runs ${CYCLES} real daemon-process kill cycles with zero violations`, async () => {
    const summary = await runDaemonKillLoop({
      cycles: CYCLES,
      workDir,
      // Tight window: a 300-request burst round-trips in ~15-20ms on this
      // machine, so a wide 5-100ms window mostly lands AFTER everything
      // already completed (a valid but less interesting outcome). 1-20ms
      // reliably lands mid-backlog on a meaningful fraction of cycles,
      // genuinely exercising the disconnect-mid-flight -> UNKNOWN path.
      minDelayMs: 1,
      maxDelayMs: 20,
      onCycle: (r) => {
        if (process.env["DAEMON_TORTURE_VERBOSE"] === "1") {
          // eslint-disable-next-line no-console
          console.error(
            `[daemon-torture] cycle=${r.cycle} killDelayMs=${r.killDelayMs} inFlight=${r.requestsInFlight} fulfilled=${r.requestsFulfilled} unknown=${r.requestsUnknown} reopenOk=${r.reopenOk} integrityOk=${r.integrityOk} daemonChainOk=${r.daemonChainOk} factCountAfterReopen=${r.factCountAfterReopen} anomalies=${r.anomalies.length}`,
          );
        }
      },
    });

    if (summary.violations.length > 0) {
      const detail = summary.violations.map((v) => `cycle ${v.cycle}: ${v.detail}`).join("\n");
      throw new Error(`${summary.violations.length} violation(s):\n${detail}`);
    }
    expect(summary.cyclesRun).toBe(CYCLES);
    for (const r of summary.results) {
      expect(r.anomalies).toEqual([]);
      // Every settled request accounted for as either a real success or a
      // typed UNKNOWN — never anything else (no request vanished unaccounted).
      expect(r.requestsFulfilled + r.requestsUnknown).toBe(r.requestsInFlight);
      expect(r.reopenOk).toBe(true);
      expect(r.integrityOk).toBe(true);
      expect(r.daemonChainOk).toBe(true);
    }
  }, 600_000);
});
