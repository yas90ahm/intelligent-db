/**
 * daemon/__torture__/daemonKillLoop.ts — H4 CRASH SEMANTICS TESTED, extended to
 * the DAEMON PROCESS ITSELF (PHASE3_DAEMON_SPEC.md H4: "A kill-the-daemon-
 * mid-request test (torture suite extension): client observes disconnect, DB
 * reopens clean (integrity + both chains verify), and the committed/
 * uncommitted outcome matches WAL semantics. Client adapter surfaces UNKNOWN,
 * never fabricates success/failure.").
 *
 * DIFFERENT SHAPE from `src/__torture__/killLoop.ts` (which SIGKILLs the
 * process DOING the writes, i.e. the engine itself, in-process): here the
 * process under kill is the DAEMON SERVER, reached over a real socket/pipe by
 * a separate, never-killed CLIENT process (this test process) that is
 * continuously firing real `remember()` calls through `daemon/client.ts`'s
 * `createRemoteAgentMemory` while the daemon gets SIGKILLed at a random point.
 *
 * PER CYCLE:
 *   1. Spawn a real `dist/daemon/cli.js` child process (fresh on cycle 1, a
 *      REOPEN of the same db/data-dir on every later cycle — WAL recovery is
 *      exercised on every single cycle after the first, not just once).
 *   2. A live client connection fires a continuous stream of `remember()`
 *      calls for a random 5-100ms window.
 *   3. SIGKILL the daemon process (no unwind, no flush, no atexit — Node's
 *      `ChildProcess.kill()` on Windows always terminates forcefully
 *      regardless of signal name, exactly the crash this suite needs).
 *   4. Every request STILL PENDING at that moment must settle as
 *      {@link DaemonUnknownOutcomeError} (never a fabricated success/failure)
 *      — checked directly against `Promise.allSettled`'s outcomes.
 *   5. Respawn a FRESH daemon process against the SAME db/data-dir (the real
 *      reopen). It must come up cleanly (a corrupt-on-open db would make the
 *      CLI's `createAgentMemory` throw before ever printing "listening on",
 *      which surfaces here as `spawnDaemon` rejecting/timing out).
 *   6. Stop that daemon GRACEFULLY (so nothing holds the file open), then
 *      directly open the SAME sqlite files this cycle's daemon used and
 *      check: (a) `PRAGMA integrity_check` on the memory store (STRUCTURAL —
 *      "DB reopens clean"), (b) `verifyChain()` on the daemon's OWN durable
 *      R8 audit chain (`auditChainSqlite.ts` — the fix this pass shipped).
 *      NOTE ON SCOPE (see the module's adversarial-pass writeup): the
 *      fact/ratification checksum chain (`ratification/pendingLedger.ts`) is
 *      wired IN-MEMORY by `agent/agentMemory.ts`'s `createAgentMemory` facade
 *      REGARDLESS of `dbPath` (its own doc comment: "In-memory even when the
 *      store is SQLite ... an open pending is RE-DERIVABLE") — a PRE-EXISTING
 *      facade characteristic, not something the daemon lanes introduced or
 *      could fix without rewiring the whole facade. It therefore resets on
 *      EVERY daemon restart (crash or clean), not just under SIGKILL, and is
 *      excluded from "both chains" here on purpose — see the KNOWN
 *      LIMITATIONS addition in `CLAUDE.md` and this suite's `.test.ts` doc.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DIST_CLI_PATH } from "../__e2e__/support.js";
import { readOwnerTokenFile } from "../tokens.js";
import { createRemoteAgentMemory } from "../client.js";
import type { RemoteAgentMemory } from "../client.js";
import { DaemonUnknownOutcomeError } from "../client.js";
import { createSqliteStore } from "../../store/sqliteStore.js";
import { createSqliteDaemonAuditChain } from "../auditChainSqlite.js";

export interface DaemonKillCycleResult {
  readonly cycle: number;
  readonly killDelayMs: number;
  readonly requestsInFlight: number;
  readonly requestsFulfilled: number;
  readonly requestsUnknown: number;
  /** Non-empty ⇒ a request settled some OTHER way than fulfilled/UNKNOWN — a violation. */
  readonly anomalies: readonly string[];
  readonly reopenOk: boolean;
  readonly integrityOk: boolean;
  readonly daemonChainOk: boolean;
  readonly daemonChainFirstBrokenSeq: number | null;
  readonly factCountAfterReopen: number;
}

export interface DaemonKillLoopOptions {
  readonly cycles: number;
  readonly workDir: string;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onCycle?: (result: DaemonKillCycleResult) => void;
}

export interface DaemonKillLoopSummary {
  readonly cyclesRun: number;
  readonly results: readonly DaemonKillCycleResult[];
  readonly violations: readonly { readonly cycle: number; readonly detail: string }[];
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

interface SpawnResult {
  readonly child: ReturnType<typeof spawn>;
  readonly endpoint: string;
}

function spawnDaemonRaw(dbPath: string, dataDir: string, timeoutMs = 10_000): Promise<SpawnResult> {
  const child = spawn(process.execPath, [DIST_CLI_PATH, "--db", dbPath, "--data-dir", dataDir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`spawnDaemonRaw: timed out waiting for "listening on"`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("exit");
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = /listening on (.+)/.exec(buf);
      if (m) {
        cleanup();
        resolve({ child, endpoint: m[1]!.trim() });
      }
    });
    child.once("exit", (code, signal) => {
      cleanup();
      reject(new Error(`spawnDaemonRaw: daemon exited early during startup (code=${code}, signal=${signal})`));
    });
  });
}

function waitExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Run `cycles` kill-and-check iterations against the daemon process itself. */
export async function runDaemonKillLoop(opts: DaemonKillLoopOptions): Promise<DaemonKillLoopSummary> {
  const minDelayMs = opts.minDelayMs ?? 5;
  const maxDelayMs = opts.maxDelayMs ?? 100;
  mkdirSync(opts.workDir, { recursive: true });
  const dbPath = join(opts.workDir, "daemon-torture.db");
  const dataDir = opts.workDir;
  const auditDbPath = join(dataDir, "daemon-audit.db");

  const results: DaemonKillCycleResult[] = [];
  const violations: Array<{ cycle: number; detail: string }> = [];

  for (let cycle = 1; cycle <= opts.cycles; cycle++) {
    const delayMs = randomInt(minDelayMs, maxDelayMs);
    const anomalies: string[] = [];

    // --- 1/2/3: spawn (or reopen), load, kill --------------------------------
    const { child, endpoint } = await spawnDaemonRaw(dbPath, dataDir);
    const owner = readOwnerTokenFile(dataDir);
    if (owner === null) throw new Error(`cycle ${cycle}: no owner token file after startup`);

    const client: RemoteAgentMemory = createRemoteAgentMemory({
      socketPath: endpoint,
      token: owner.token,
      requestTimeoutMs: 4000,
    });
    await client.getDefaultSourceId();

    // Fire a LARGE burst of writes SYNCHRONOUSLY (no per-call await) so a real
    // backlog is genuinely still being processed/in the socket buffer when the
    // random-delay kill lands — a slow one-at-a-time trickle would let every
    // call round-trip and resolve well before the kill, never exercising the
    // "disconnect mid-flight" path at all (each call is a synchronous, sub-ms
    // local SQLite write once dequeued). Kept comfortably under the server's
    // default max queue depth (1024, H6) so a legitimate BACKPRESSURE response
    // is not conflated with a genuine crash-timing outcome.
    const BURST = 300;
    const inflight: Array<Promise<unknown>> = [];
    for (let seq = 1; seq <= BURST; seq++) {
      const p = client.remember({
        text: `daemon-torture cycle=${cycle} seq=${seq}`,
        attribute: "daemon-torture-attr",
      });
      // Attach a no-op rejection handler IMMEDIATELY (in addition to, never
      // instead of, the real `Promise.allSettled` check below) — a promise
      // that rejects before `allSettled` is called on it would otherwise trip
      // Node's unhandled-rejection detector for the brief window between "the
      // kill lands" and "we get around to awaiting it".
      p.catch(() => {});
      inflight.push(p);
    }

    // Kill at a random point relative to the burst just fired (never a fixed
    // offset) — with 300 requests in flight this window reliably lands mid-
    // backlog rather than after everything has already round-tripped.
    await new Promise((r) => setTimeout(r, delayMs));

    // 3) SIGKILL — no unwind, no flush, no atexit.
    child.kill("SIGKILL");
    await waitExit(child);

    // 4) every settled outcome must be a real success OR a typed UNKNOWN —
    // NEVER any other kind of thrown error (which would mean a fabricated or
    // ambiguous outcome slipped through the client adapter).
    const settled = await Promise.allSettled(inflight);
    let fulfilled = 0;
    let unknown = 0;
    for (const s of settled) {
      if (s.status === "fulfilled") {
        fulfilled += 1;
      } else if (s.reason instanceof DaemonUnknownOutcomeError || s.reason?.outcome === "UNKNOWN") {
        unknown += 1;
      } else {
        anomalies.push(
          `request settled neither fulfilled nor UNKNOWN: ${
            s.reason instanceof Error ? s.reason.constructor.name + ": " + s.reason.message : String(s.reason)
          }`,
        );
      }
    }
    await client.close();

    // 5/6) reopen fresh, confirm it comes up clean, then stop it gracefully
    // and inspect the persisted files directly.
    let reopenOk = false;
    let factCountAfterReopen = -1;
    try {
      const reopened = await spawnDaemonRaw(dbPath, dataDir);
      reopenOk = true;
      const reopenedOwner = readOwnerTokenFile(dataDir)!;
      const reopenedClient = createRemoteAgentMemory({
        socketPath: reopened.endpoint,
        token: reopenedOwner.token,
        requestTimeoutMs: 4000,
      });
      const recall = await reopenedClient.recall("daemon-torture");
      factCountAfterReopen = recall.facts.length;
      await reopenedClient.close();
      reopened.child.kill("SIGTERM");
      await waitExit(reopened.child);
    } catch (err) {
      anomalies.push(`reopen failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // STRUCTURAL — the memory store's own integrity_check, opened directly
    // (no daemon process holding the file at this point).
    let integrityOk = false;
    try {
      const store = createSqliteStore(dbPath);
      integrityOk = store.integrityCheck();
      store.close();
    } catch (err) {
      anomalies.push(`integrityCheck threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // R8's OWN durable chain (this pass's fix) — verified directly.
    let daemonChainOk = false;
    let daemonChainFirstBrokenSeq: number | null = null;
    try {
      const chain = createSqliteDaemonAuditChain(auditDbPath);
      const v = chain.verifyChain();
      daemonChainOk = v.ok;
      daemonChainFirstBrokenSeq = v.firstBrokenSeq;
      chain.close();
    } catch (err) {
      anomalies.push(`daemon audit chain verify threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const result: DaemonKillCycleResult = {
      cycle,
      killDelayMs: delayMs,
      requestsInFlight: settled.length,
      requestsFulfilled: fulfilled,
      requestsUnknown: unknown,
      anomalies,
      reopenOk,
      integrityOk,
      daemonChainOk,
      daemonChainFirstBrokenSeq,
      factCountAfterReopen,
    };
    results.push(result);
    if (!reopenOk) violations.push({ cycle, detail: "reopen failed" });
    if (!integrityOk) violations.push({ cycle, detail: "integrity_check failed" });
    if (!daemonChainOk) violations.push({ cycle, detail: `daemon audit chain broken at seq ${String(daemonChainFirstBrokenSeq)}` });
    for (const a of anomalies) violations.push({ cycle, detail: a });
    opts.onCycle?.(result);
  }

  return { cyclesRun: results.length, results, violations };
}

export function resetWorkDir(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
