/**
 * daemon/__e2e__/support.ts — shared helpers for the daemon END-TO-END suite:
 * a REAL daemon process (spawned as a genuinely separate OS process, running
 * the COMPILED `dist/daemon/cli.js`, not an in-process `DaemonServer`
 * instance) reached over a REAL socket/named-pipe. This is deliberately
 * heavier than `daemon/__tests__/server.test.ts` (which instantiates
 * `DaemonServer` directly in-process): these tests exist to catch anything
 * that ONLY manifests across a real process boundary + real transport (argv
 * parsing, signal handling, the compiled bin entry, real OS socket/pipe
 * semantics) — the exact gap "spawn a real daemon process, real socket/pipe"
 * in the review brief calls out.
 *
 * Mirrors `src/__torture__/buildHelper.ts`'s "build once, cache" pattern, but
 * targets the SHIPPED `dist/` build (via `npm run build`) since
 * `package.json`'s `bin.intelligent-db-daemon` already points at
 * `dist/daemon/cli.js` — these tests exercise the actual deliverable, not a
 * parallel test-only bundle.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { readOwnerTokenFile } from "../tokens.js";
import type { OwnerTokenFile } from "../tokens.js";

export const DIST_CLI_PATH = join(process.cwd(), "dist", "daemon", "cli.js");

/** Build `dist/` (via `npm run build`) unless the compiled CLI already exists. */
export function ensureDaemonBuilt(): void {
  if (existsSync(DIST_CLI_PATH)) return;
  execFileSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (!existsSync(DIST_CLI_PATH)) {
    throw new Error(`ensureDaemonBuilt: ${DIST_CLI_PATH} still missing after build.`);
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export interface DaemonProcessHandle {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly endpoint: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly auditDbPath: string;
  readonly owner: OwnerTokenFile;
  readonly stderrLines: string[];
  /** Graceful stop: SIGTERM, wait for real exit. */
  stop(): Promise<void>;
  /** Ungraceful: SIGKILL, wait for real exit — the H4 crash primitive. */
  kill(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

let counter = 0;
function nextTag(): string {
  counter += 1;
  return `iddb-e2e-${process.pid}-${counter}`;
}

export interface SpawnDaemonOptions {
  /** Reuse an existing data dir / db (for reopen-after-kill scenarios). */
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly socketArg?: string;
  /** Wait this long for the "listening on" line before giving up. Default 8s. */
  readonly readyTimeoutMs?: number;
}

/** Spawn a REAL `node dist/daemon/cli.js` child process and wait for it to report ready. */
export function spawnDaemon(opts: SpawnDaemonOptions = {}): Promise<DaemonProcessHandle> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), nextTag() + "-"));
  const dbPath = opts.dbPath ?? join(dataDir, "memory.db");
  const args = ["--db", dbPath, "--data-dir", dataDir];
  if (opts.socketArg !== undefined) args.push("--socket", opts.socketArg);

  const child = spawn(process.execPath, [DIST_CLI_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrLines: string[] = [];
  let stderrBuf = "";

  return new Promise((resolve, reject) => {
    const timeoutMs = opts.readyTimeoutMs ?? 8000;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`spawnDaemon: timed out waiting for "listening on" (stderr so far: ${stderrLines.join(" | ")})`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("exit");
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        stderrLines.push(line);
        const m = /listening on (.+)$/.exec(line);
        if (m) {
          cleanup();
          const endpoint = m[1]!.trim();
          const owner = readOwnerTokenFile(dataDir);
          if (owner === null) {
            reject(new Error("spawnDaemon: daemon reported ready but no owner token file was found."));
            return;
          }
          resolve({
            child,
            endpoint,
            dataDir,
            dbPath,
            auditDbPath: join(dataDir, "daemon-audit.db"),
            owner,
            stderrLines,
            stop: () => stopDaemon(child),
            kill: () => killDaemon(child),
          });
        }
      }
    });

    child.once("exit", (code, signal) => {
      cleanup();
      reject(new Error(`spawnDaemon: process exited early (code=${code}, signal=${signal}): ${stderrLines.join(" | ")}`));
    });
  });
}

function stopDaemon(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    // Windows/CI safety net: if graceful shutdown hangs, force it after a bound.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  });
}

function killDaemon(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exitCode: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ exitCode: code, signal }));
    child.kill("SIGKILL");
  });
}

export function removeDataDir(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort (a Windows handle briefly held by a just-killed process).
  }
}

// ---------------------------------------------------------------------------
// Raw wire helpers — deliberately NOT going through daemon/client.ts, so the
// adversarial/protocol-matrix tests can send arbitrary, malformed, or
// out-of-order bytes.
// ---------------------------------------------------------------------------

export function rawConnect(endpoint: string): net.Socket {
  return net.createConnection(endpoint);
}

export class LineReader {
  #buf = "";
  #queue: string[] = [];
  #waiters: Array<(line: string) => void> = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.#buf.indexOf("\n")) !== -1) {
        const line = this.#buf.slice(0, idx);
        this.#buf = this.#buf.slice(idx + 1);
        const waiter = this.#waiters.shift();
        if (waiter !== undefined) waiter(line);
        else this.#queue.push(line);
      }
    });
  }

  next(timeoutMs = 5000): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("LineReader.next timed out")), timeoutMs);
      this.#waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async nextJson<T = any>(timeoutMs?: number): Promise<T> {
    return JSON.parse(await this.next(timeoutMs)) as T;
  }
}

export function waitClose(socket: net.Socket, timeoutMs = 5000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitClose timed out")), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Handshake over a raw socket; returns the reader + the auth response. */
export async function rawHandshake(
  endpoint: string,
  token: string,
): Promise<{ socket: net.Socket; reader: LineReader; auth: { ok: boolean; defaultSourceId?: string; error?: string } }> {
  const socket = rawConnect(endpoint);
  const reader = new LineReader(socket);
  socket.write(JSON.stringify({ method: "auth", token }) + "\n");
  const auth = await reader.nextJson();
  return { socket, reader, auth };
}

export function req(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ id, method, params: params ?? {} }) + "\n";
}
