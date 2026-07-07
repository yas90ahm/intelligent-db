/**
 * mcp/daemonSwitch.test.ts — the opt-in daemon-backing switch (mcp/server.ts):
 * env resolution and connectivity validation (the fail-fast startup pre-check
 * PHASE3B_MCP_ASYNC_SPEC.md kept unchanged — see mcp/server.ts's `main()`,
 * which then constructs a real, long-lived `RemoteAgentMemory` to actually
 * serve requests; the true end-to-end wiring is proven by
 * `daemon/__e2e__/mcpDaemonBacked.e2e.test.ts`, not here). Uses a tiny
 * hand-rolled test daemon over a real Windows named pipe (this machine) —
 * genuine `node:net` I/O, no fakes — since these are the actual
 * startup-time checks a real deployment would exercise.
 */

import * as net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  DAEMON_STARTUP_TIMEOUT_MS,
  resolveDaemonConfig,
  validateDaemonConnectivity,
} from "./server.js";

const TOKEN = "test-daemon-token";

function pipePath(): string {
  return `\\\\.\\pipe\\iddb-mcp-switch-test-${randomBytes(8).toString("hex")}`;
}

function startFakeDaemon(socketPath: string): { server: net.Server; close: () => Promise<void> } {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      const req = JSON.parse(line) as { token: string };
      if (req.token !== TOKEN) {
        socket.write(JSON.stringify({ ok: false, error: "bad token" }) + "\n");
        socket.end();
        return;
      }
      socket.write(JSON.stringify({ ok: true, defaultSourceId: "src:fake-daemon-owner" }) + "\n");
    });
  });
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

describe("resolveDaemonConfig", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir !== null) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("returns null when MEMORY_DAEMON_SOCKET is absent (in-process default, untouched)", async () => {
    const config = await resolveDaemonConfig({});
    expect(config).toBeNull();
  });

  it("throws when MEMORY_DAEMON_SOCKET is set without MEMORY_DAEMON_TOKEN_FILE", async () => {
    await expect(resolveDaemonConfig({ MEMORY_DAEMON_SOCKET: "\\\\.\\pipe\\x" })).rejects.toThrow(
      /MEMORY_DAEMON_TOKEN_FILE/,
    );
  });

  it("throws when the token file is empty", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "iddb-daemon-switch-"));
    const tokenFile = path.join(tmpDir, "token");
    await writeFile(tokenFile, "   \n");
    await expect(
      resolveDaemonConfig({ MEMORY_DAEMON_SOCKET: "\\\\.\\pipe\\x", MEMORY_DAEMON_TOKEN_FILE: tokenFile }),
    ).rejects.toThrow(/is empty/);
  });

  it("throws a clear error when the token file does not exist", async () => {
    await expect(
      resolveDaemonConfig({
        MEMORY_DAEMON_SOCKET: "\\\\.\\pipe\\x",
        MEMORY_DAEMON_TOKEN_FILE: "C:\\definitely\\does\\not\\exist\\token",
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("resolves socketPath + trimmed token when both are configured", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "iddb-daemon-switch-"));
    const tokenFile = path.join(tmpDir, "token");
    await writeFile(tokenFile, "  sekret-token-value  \n");
    const config = await resolveDaemonConfig({
      MEMORY_DAEMON_SOCKET: "\\\\.\\pipe\\iddb-x",
      MEMORY_DAEMON_TOKEN_FILE: tokenFile,
    });
    expect(config).toEqual({ socketPath: "\\\\.\\pipe\\iddb-x", token: "sekret-token-value" });
  });
});

describe("validateDaemonConnectivity", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("succeeds (resolves) against a real daemon that accepts the token", async () => {
    const socketPath = pipePath();
    const daemon = startFakeDaemon(socketPath);
    await listen(daemon.server, socketPath);
    cleanups.push(daemon.close);

    await expect(
      validateDaemonConnectivity({ socketPath, token: TOKEN }, 5_000),
    ).resolves.toBeUndefined();
  });

  it("rejects when the daemon refuses the token", async () => {
    const socketPath = pipePath();
    const daemon = startFakeDaemon(socketPath);
    await listen(daemon.server, socketPath);
    cleanups.push(daemon.close);

    await expect(
      validateDaemonConnectivity({ socketPath, token: "wrong-token" }, 5_000),
    ).rejects.toThrow(/auth failed/);
  });

  it("rejects within the bound when nothing is listening (fail-fast, no infinite hang)", async () => {
    const socketPath = pipePath(); // nothing ever listens on this path
    await expect(validateDaemonConnectivity({ socketPath, token: TOKEN }, 300)).rejects.toThrow(
      /did not complete the handshake/,
    );
  }, 10_000);

  it("DAEMON_STARTUP_TIMEOUT_MS is a sane positive bound", () => {
    expect(DAEMON_STARTUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
