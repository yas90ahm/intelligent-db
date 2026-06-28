/**
 * dockerUtil.ts — container lifecycle + readiness plumbing for the Docker-backed
 * vector-DB adapters (Qdrant, Postgres+pgvector, Redis-Stack).
 *
 * GRACEFUL DEGRADATION is the contract: every helper here either succeeds or throws a
 * SINGLE-LINE, human-readable Error. The runner's `measure()` already try/catches
 * `setup()` and records a SKIP with the message, so an adapter whose image won't pull,
 * whose container won't start, or whose port never opens is marked SKIPPED and the run
 * continues. `close()` always calls {@link removeContainer} (best-effort) so nothing
 * leaks even on a failed setup.
 *
 * Docker is driven via `docker` CLI calls (execFileSync) rather than a JS SDK — zero
 * extra deps, and the CLI is the thing the directive says is running (Docker 29.5.2).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`.
 */

import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

/** Run `docker <args>`, returning trimmed stdout; throws a one-line Error on failure. */
export function docker(args: string[], timeoutMs = 60_000): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    const first = (stderr || e.message || "docker error").split("\n")[0] ?? "docker error";
    throw new Error(`docker ${args[0]} failed: ${first}`);
  }
}

/** Throw unless the Docker daemon answers (the precondition for any container adapter). */
export function assertDockerRunning(): void {
  docker(["version", "--format", "{{.Server.Version}}"], 15_000);
}

/** `docker exec` inside a running container; returns trimmed stdout (throws on failure). */
export function dockerExec(name: string, cmd: string[], timeoutMs = 30_000): string {
  return docker(["exec", name, ...cmd], timeoutMs);
}

/** Force-remove a container (idempotent — a missing name is not an error here). */
export function removeContainer(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best effort — already gone, or daemon down */
  }
}

/**
 * Start a detached container after force-removing any stale instance of the same name
 * (so reruns are clean). Returns the container id. Throws a one-line Error if the image
 * can't be pulled or the container won't start.
 */
export function runContainer(opts: {
  name: string;
  image: string;
  ports: ReadonlyArray<[number, number]>; // [host, container]
  env?: Readonly<Record<string, string>>;
}): string {
  removeContainer(opts.name);
  const args = ["run", "-d", "--name", opts.name];
  for (const [host, cont] of opts.ports) args.push("-p", `${host}:${cont}`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(opts.image);
  // Pull (if needed) + start can be slow on a cold image — allow generous time.
  return docker(args, 300_000);
}

/** Resolve once a TCP connect to host:port succeeds (a single attempt). */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/** Sleep helper (no wall-clock dependence in the metrics — only readiness polling). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `host:port` until a TCP connect succeeds or `timeoutMs` elapses. Throws a
 * one-line Error on timeout (which the runner records as the SKIP reason).
 */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs = 60_000,
  intervalMs = 750,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no connection";
  while (Date.now() < deadline) {
    if (await tryConnect(host, port, 2_000)) return;
    lastErr = `port ${port} not open`;
    await sleep(intervalMs);
  }
  throw new Error(`readiness timeout after ${timeoutMs}ms: ${lastErr}`);
}

/**
 * Retry an async readiness probe (e.g. a real client handshake / first query) until it
 * resolves or the deadline passes. Throws the LAST probe error (one line) on timeout.
 */
export async function waitForReady(
  probe: () => Promise<void>,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = new Error("not ready");
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (err) {
      last = err;
      await sleep(intervalMs);
    }
  }
  const msg = last instanceof Error ? last.message : String(last);
  throw new Error(`client handshake timeout after ${timeoutMs}ms: ${msg.split("\n")[0]}`);
}
