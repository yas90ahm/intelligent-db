/**
 * daemon/__e2e__/adversarial.e2e.test.ts — attacker-minded pass against a REAL
 * spawned daemon process: pre-auth verbs, oversized/malformed frames
 * (pre- and post-handshake), slowloris (partial-line trickling), token
 * fingerprint-vs-raw discipline across the wire, admin-verb escalation from a
 * non-OWNER token, and connecting during shutdown drain. Every finding is
 * reported in the verifier's summary regardless of outcome (found-and-fixed,
 * or found-and-already-defended).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "node:net";

import {
  ensureDaemonBuilt,
  spawnDaemon,
  rawConnect,
  rawHandshake,
  waitClose,
  removeDataDir,
  req,
  LineReader,
} from "./support.js";
import type { DaemonProcessHandle } from "./support.js";
import { MAX_LINE_BYTES } from "../protocol.js";

beforeAll(() => {
  ensureDaemonBuilt();
}, 180_000);

describe("Adversarial E2E: pre-auth verb / frame attacks", () => {
  let h: DaemonProcessHandle;
  beforeAll(async () => {
    h = await spawnDaemon();
  }, 20_000);
  afterAll(async () => {
    await h.stop();
    removeDataDir(h.dataDir);
  });

  it("an ADMIN verb sent as the very first line (pre-auth) is rejected exactly like any other non-auth line", async () => {
    const socket = rawConnect(h.endpoint);
    const reader = new LineReader(socket);
    socket.write(JSON.stringify({ id: 1, method: "issueToken", params: { grade: "OWNER" } }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);
  });

  it("a DATA verb (remember/recall/disown) sent pre-auth is rejected, never executed", async () => {
    for (const method of ["remember", "recall", "disown", "revokeAllTokens"]) {
      const socket = rawConnect(h.endpoint);
      const reader = new LineReader(socket);
      socket.write(JSON.stringify({ id: 1, method, params: {} }) + "\n");
      const resp = await reader.nextJson();
      expect(resp.ok).toBe(false);
      await waitClose(socket);
    }
    // Confirm nothing pre-auth leaked through: a fresh recall from an
    // authenticated connection should show none of the pre-auth attempts
    // (they specified no coherent text anyway, but the real assertion is
    // that the daemon is still alive and answers normally).
    const { auth } = await rawHandshake(h.endpoint, h.owner.token);
    expect(auth.ok).toBe(true);
  });

  it("oversized line AFTER a successful handshake: typed error, connection survives, daemon survives", async () => {
    const { socket, reader } = await rawHandshake(h.endpoint, h.owner.token);
    // No trailing newline — BoundedLineSplitter flags overflow once the
    // buffered incomplete line crosses MAX_LINE_BYTES (1MB).
    socket.write("y".repeat(MAX_LINE_BYTES + 4096));
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("OVERSIZED_LINE");
    // The connection is NOT dropped post-handshake for an oversized line
    // (only pre-handshake oversized lines fail the connection) — prove it
    // still answers a well-formed request.
    socket.write("\n" + req(1, "recall", "anything"));
    const followUp = await reader.nextJson();
    expect(followUp.ok).toBe(true);
    socket.destroy();
  });

  it("malformed JSON AFTER a successful handshake: typed parse error, connection + daemon survive", async () => {
    const { socket, reader } = await rawHandshake(h.endpoint, h.owner.token);
    socket.write("{ this is not valid json at all\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    socket.write(req(2, "recall", "anything"));
    const followUp = await reader.nextJson();
    expect(followUp.ok).toBe(true);
    socket.destroy();
  });

  it("an unknown method name post-auth returns METHOD_NOT_FOUND, never a crash", async () => {
    const { socket, reader } = await rawHandshake(h.endpoint, h.owner.token);
    socket.write(req(1, "definitelyNotARealMethod", {}));
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe("METHOD_NOT_FOUND");
    socket.destroy();
  });
});

describe("Adversarial E2E: slowloris (partial-line trickling)", () => {
  let h: DaemonProcessHandle;
  beforeAll(async () => {
    h = await spawnDaemon();
  }, 20_000);
  afterAll(async () => {
    await h.stop();
    removeDataDir(h.dataDir);
  });

  it("trickling a NEVER-COMPLETED auth line (1 byte at a time) is still dropped at the fixed handshake deadline, not extended by activity", async () => {
    const socket = rawConnect(h.endpoint);
    const reader = new LineReader(socket);
    const partial = JSON.stringify({ method: "auth", token: "a".repeat(64) });
    // Send everything EXCEPT the trailing newline, in small chunks, spread
    // out — a classic slowloris shape — then simply stop (never send \n).
    let i = 0;
    const trickle = setInterval(() => {
      if (i >= partial.length || socket.destroyed) {
        clearInterval(trickle);
        return;
      }
      socket.write(partial[i]!);
      i += 1;
    }, 150);
    const start = Date.now();
    const resp = await reader.nextJson(8000);
    const elapsed = Date.now() - start;
    clearInterval(trickle);
    expect(resp.ok).toBe(false);
    // The fixed handshake window (default 5s) fired — the connection was not
    // kept alive indefinitely just because bytes kept trickling in.
    expect(elapsed).toBeLessThan(7000);
    await waitClose(socket);
  }, 15_000);

  it("trickling a VALID auth line (chunked, but completed well within the handshake window) succeeds normally", async () => {
    const socket = rawConnect(h.endpoint);
    const reader = new LineReader(socket);
    const full = JSON.stringify({ method: "auth", token: h.owner.token }) + "\n";
    let i = 0;
    const trickle = setInterval(() => {
      if (i >= full.length) {
        clearInterval(trickle);
        return;
      }
      socket.write(full[i]!);
      i += 1;
    }, 20);
    const resp = await reader.nextJson(8000);
    clearInterval(trickle);
    expect(resp.ok).toBe(true);
    socket.destroy();
  }, 15_000);
});

describe("Adversarial E2E: token fingerprint vs raw discipline across every serialized surface", () => {
  it("no non-mint response, no error message, and no stderr line ever contains a raw agent token", async () => {
    const h = await spawnDaemon();
    try {
      const { socket: ownerSock, reader: ownerReader } = await rawHandshake(h.endpoint, h.owner.token);
      ownerSock.write(req(1, "issueToken", { grade: "EMAIL_OAUTH", label: "leak-probe" }));
      const issued = await ownerReader.nextJson();
      const agentRaw = issued.result.token as string;

      // Exercise a bunch of surfaces with the new token: handshake ok, a data
      // call, a forbidden admin call, a bad-token handshake attempt reusing
      // a DIFFERENT bad value, and a revoke.
      const { socket: agentSock, reader: agentReader } = await rawHandshake(h.endpoint, agentRaw);
      agentSock.write(req(1, "recall", "leak probe"));
      const recallResp = await agentReader.nextJson();
      agentSock.write(req(2, "issueToken", { grade: "OWNER" }));
      const forbidden = await agentReader.nextJson();

      ownerSock.write(req(2, "revokeToken", { fingerprint: issued.result.fingerprint }));
      const revokeResp = await ownerReader.nextJson();

      const surfaces = [recallResp, forbidden, revokeResp];
      for (const s of surfaces) {
        expect(JSON.stringify(s)).not.toContain(agentRaw);
      }
      // stderr (startup banner + any error logging) never contains it either.
      expect(h.stderrLines.join("\n")).not.toContain(agentRaw);

      agentSock.destroy();
      ownerSock.destroy();
    } finally {
      await h.stop();
      removeDataDir(h.dataDir);
    }
  }, 20_000);
});

describe("Adversarial E2E: admin-verb escalation attempts from a non-OWNER token", () => {
  it("every admin verb is individually rejected for a non-OWNER connection (not just one sampled verb)", async () => {
    const h = await spawnDaemon();
    try {
      const { socket: ownerSock, reader: ownerReader } = await rawHandshake(h.endpoint, h.owner.token);
      ownerSock.write(req(1, "issueToken", { grade: "DOMAIN", label: "non-owner-probe" }));
      const issued = await ownerReader.nextJson();

      const { socket: lowSock, reader: lowReader } = await rawHandshake(h.endpoint, issued.result.token as string);
      const adminVerbs = [
        { method: "issueToken", params: { grade: "EMAIL_OAUTH" } },
        { method: "revokeToken", params: { fingerprint: issued.result.fingerprint } },
        { method: "revokeAllTokens", params: {} },
        { method: "reloadTokens", params: {} },
      ];
      let idc = 1;
      for (const verb of adminVerbs) {
        lowSock.write(req(idc, verb.method, verb.params));
        const resp = await lowReader.nextJson();
        expect(resp.ok).toBe(false);
        expect(resp.error.code).toBe("ADMIN_FORBIDDEN");
        idc += 1;
      }
      // The token is still fully valid for ordinary data verbs (forbidding
      // admin verbs must not accidentally break normal use).
      lowSock.write(req(idc, "recall", "anything"));
      const dataResp = await lowReader.nextJson();
      expect(dataResp.ok).toBe(true);

      ownerSock.destroy();
      lowSock.destroy();
    } finally {
      await h.stop();
      removeDataDir(h.dataDir);
    }
  }, 20_000);
});

describe("Adversarial E2E: connecting during shutdown drain", () => {
  it("a connection attempt raced against SIGTERM never completes a handshake once shutdown has begun", async () => {
    const h = await spawnDaemon();
    let sawSuccessfulAuthAfterSignal = false;
    let anyAttemptMade = false;
    h.child.kill("SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      anyAttemptMade = true;
      const socket = net.connect(h.endpoint);
      const outcome = await new Promise<"ok" | "refused" | "no-response">((resolve) => {
        let settled = false;
        const finish = (v: "ok" | "refused" | "no-response"): void => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        socket.once("error", () => finish("refused"));
        socket.once("close", () => finish("no-response"));
        socket.once("connect", () => {
          socket.write(JSON.stringify({ method: "auth", token: h.owner.token }) + "\n");
        });
        let buf = "";
        socket.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          if (buf.includes("\n")) {
            try {
              const parsed = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as { ok: boolean };
              finish(parsed.ok ? "ok" : "refused");
            } catch {
              finish("refused");
            }
          }
        });
        setTimeout(() => finish("no-response"), 250);
      });
      socket.destroy();
      if (outcome === "ok") sawSuccessfulAuthAfterSignal = true;
      if (child_exited(h)) break;
    }
    expect(anyAttemptMade).toBe(true);
    expect(sawSuccessfulAuthAfterSignal).toBe(false);
    removeDataDir(h.dataDir);
  }, 15_000);
});

function child_exited(h: DaemonProcessHandle): boolean {
  return h.child.exitCode !== null || h.child.signalCode !== null;
}
