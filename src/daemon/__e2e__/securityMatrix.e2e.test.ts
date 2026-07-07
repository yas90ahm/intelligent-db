/**
 * daemon/__e2e__/securityMatrix.e2e.test.ts — END-TO-END security matrix
 * against a REAL daemon process (spawned child, real socket/named pipe):
 * the full handshake/auth matrix over the wire, identity binding (H2),
 * revocation immediacy mid-session (R3), connection cap (H6), and the
 * Windows named-pipe random-suffix discovery-requires-token-file property
 * (R9). See `support.ts`'s module doc for why this is a separate,
 * heavier lane from `daemon/__tests__/server.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as net from "node:net";

import {
  ensureDaemonBuilt,
  spawnDaemon,
  rawHandshake,
  rawConnect,
  waitClose,
  removeDataDir,
  req,
  LineReader,
} from "./support.js";
import type { DaemonProcessHandle } from "./support.js";
import { createRemoteAgentMemory } from "../client.js";
import type { RemoteAgentMemory } from "../client.js";

beforeAll(() => {
  ensureDaemonBuilt();
}, 180_000);

// ---------------------------------------------------------------------------
// One shared daemon for the read-mostly matrix cases; a few tests spin up
// their own (connection cap, revocation) since they mutate shared state.
// ---------------------------------------------------------------------------

let shared: DaemonProcessHandle | null = null;

beforeAll(async () => {
  shared = await spawnDaemon();
}, 20_000);

afterAll(async () => {
  if (shared !== null) {
    await shared.stop();
    removeDataDir(shared.dataDir);
    shared = null;
  }
});

describe("E2E: handshake/auth matrix over a REAL spawned daemon + real socket/pipe", () => {
  it("valid owner token -> handshake succeeds; a real remember()/recall() round trip works", async () => {
    const h = shared!;
    const { socket, reader, auth } = await rawHandshake(h.endpoint, h.owner.token);
    expect(auth.ok).toBe(true);
    expect(typeof auth.defaultSourceId).toBe("string");

    socket.write(req(1, "remember", { text: "The E2E daemon test wrote this fact." }));
    const rememberResp = await reader.nextJson();
    expect(rememberResp.ok).toBe(true);
    expect(typeof rememberResp.result.id).toBe("string");

    socket.write(req(2, "recall", "E2E daemon test"));
    const recallResp = await reader.nextJson();
    expect(recallResp.ok).toBe(true);
    expect(Array.isArray(recallResp.result.facts)).toBe(true);
    expect(recallResp.result.facts.length).toBeGreaterThan(0);

    socket.destroy();
  });

  it("bad token -> handshake rejected, connection dropped, raw token never echoed", async () => {
    const h = shared!;
    const bad = "d".repeat(64);
    const { socket, auth } = await rawHandshake(h.endpoint, bad);
    expect(auth.ok).toBe(false);
    expect(JSON.stringify(auth)).not.toContain(bad);
    await waitClose(socket);
  });

  it("malformed JSON as first line -> dropped, never crashes the daemon for OTHER clients", async () => {
    const h = shared!;
    const socket = rawConnect(h.endpoint);
    const reader = new LineReader(socket);
    socket.write("{{{ not json\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);

    // The daemon process is still alive and serving other connections.
    const { auth } = await rawHandshake(h.endpoint, h.owner.token);
    expect(auth.ok).toBe(true);
  });

  it("a non-auth first line (well-formed JSON) -> rejected, never treated as an implicit auth", async () => {
    const h = shared!;
    const socket = rawConnect(h.endpoint);
    const reader = new LineReader(socket);
    socket.write(JSON.stringify({ id: 1, method: "remember", params: { text: "sneaky" } }) + "\n");
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(false);
    await waitClose(socket);
  });

  it("admin verb from a non-OWNER-grade connection is forbidden; OWNER succeeds", async () => {
    const h = shared!;
    const { socket: ownerSock, reader: ownerReader } = await rawHandshake(h.endpoint, h.owner.token);
    ownerSock.write(req(1, "issueToken", { grade: "EMAIL_OAUTH", label: "e2e-agent" }));
    const issued = await ownerReader.nextJson();
    expect(issued.ok).toBe(true);
    const agentToken = issued.result.token as string;

    const { socket: agentSock, reader: agentReader } = await rawHandshake(h.endpoint, agentToken);
    agentSock.write(req(1, "reloadTokens", {}));
    const forbidden = await agentReader.nextJson();
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error.code).toBe("ADMIN_FORBIDDEN");

    // ALSO try to self-escalate: mint an OWNER-grade token from the low-grade connection.
    agentSock.write(req(2, "issueToken", { grade: "OWNER", label: "escalate" }));
    const escalateAttempt = await agentReader.nextJson();
    expect(escalateAttempt.ok).toBe(false);
    expect(escalateAttempt.error.code).toBe("ADMIN_FORBIDDEN");

    ownerSock.destroy();
    agentSock.destroy();
  });
});

describe("E2E: H2 identity binding — the connection's resolved identity is the ONLY actor", () => {
  it("a client-claimed 'source' in the remember() payload is IGNORED; the daemon's bound identity wins", async () => {
    const h = shared!;
    const { socket, reader, auth } = await rawHandshake(h.endpoint, h.owner.token);
    const boundSourceId = auth.defaultSourceId!;

    socket.write(
      req(1, "remember", {
        text: "identity binding probe",
        source: { sourceId: "src:someone-else-entirely" },
      }),
    );
    const resp = await reader.nextJson();
    expect(resp.ok).toBe(true);
    const strandId = resp.result.id as string;

    socket.write(req(2, "explain", { target: strandId }));
    const explainResp = await reader.nextJson();
    expect(explainResp.ok).toBe(true);
    const dossier = JSON.stringify(explainResp.result);
    // The IMPERSONATED id must never appear as the strand's actual source.
    expect(dossier).not.toContain("src:someone-else-entirely");
    expect(dossier).toContain(boundSourceId);

    socket.destroy();
  });
});

describe("E2E: R3 revocation immediacy mid-session", () => {
  let h: DaemonProcessHandle;
  beforeAll(async () => {
    h = await spawnDaemon();
  }, 20_000);
  afterAll(async () => {
    await h.stop();
    removeDataDir(h.dataDir);
  });

  it("a revoked token: (a) rejects a NEW request on the live connection, (b) rejects re-auth on a fresh connection", async () => {
    const { socket: ownerSock, reader: ownerReader } = await rawHandshake(h.endpoint, h.owner.token);
    ownerSock.write(req(1, "issueToken", { grade: "EMAIL_OAUTH", label: "revoke-me" }));
    const issued = await ownerReader.nextJson();
    const agentToken = issued.result.token as string;
    const fingerprint = issued.result.fingerprint as string;

    const { socket: agentSock, reader: agentReader } = await rawHandshake(h.endpoint, agentToken);
    // Confirm it works before revocation.
    agentSock.write(req(1, "recall", "anything"));
    const before = await agentReader.nextJson();
    expect(before.ok).toBe(true);

    ownerSock.write(req(2, "revokeToken", { fingerprint }));
    const revoked = await ownerReader.nextJson();
    expect(revoked.result.revoked).toBe(true);

    // (a) the SAME live connection: give the revocation a moment to propagate
    // to the connection state, then issue a new request. R3 permits the
    // daemon to drop the connection OUTRIGHT (no in-flight request to finish)
    // rather than answer with a typed error first — an EPIPE/ECONNRESET on
    // the write itself is therefore an EXPECTED outcome here, not a test bug.
    await new Promise((r) => setTimeout(r, 50));
    agentSock.on("error", () => {
      /* ECONNRESET/EPIPE racing an already-closed socket is expected below */
    });
    let writeThrew = false;
    try {
      agentSock.write(req(2, "recall", "anything"));
    } catch {
      writeThrew = true;
    }
    // Either the write itself failed (connection already closed), an explicit
    // REVOKED error arrives, or the connection closes shortly after — all
    // three are R3-compliant ("drops its existing connections"); what must
    // NEVER happen is a normal ok:true response.
    if (!writeThrew) {
      const outcome = await Promise.race([
        agentReader.nextJson(2000).then((r) => ({ kind: "response" as const, r })),
        waitClose(agentSock, 2000).then(() => ({ kind: "closed" as const })),
      ]);
      if (outcome.kind === "response") {
        expect(outcome.r.ok).toBe(false);
        expect(outcome.r.error.code).toBe("REVOKED");
      }
    }

    // (b) a FRESH connection presenting the now-revoked raw token is rejected
    // at handshake — revocation persists beyond the one live connection.
    const { auth: reauth, socket: reauthSock } = await rawHandshake(h.endpoint, agentToken);
    expect(reauth.ok).toBe(false);
    reauthSock.destroy();

    ownerSock.destroy();
    if (!agentSock.destroyed) agentSock.destroy();
  });

  it("revokeAllTokens spares the caller, invalidates every other live agent token immediately", async () => {
    const { socket: ownerSock, reader: ownerReader } = await rawHandshake(h.endpoint, h.owner.token);
    ownerSock.write(req(1, "issueToken", { grade: "DOMAIN", label: "victim-a" }));
    const a = await ownerReader.nextJson();
    ownerSock.write(req(2, "issueToken", { grade: "DOMAIN", label: "victim-b" }));
    const b = await ownerReader.nextJson();

    const { socket: aSock } = await rawHandshake(h.endpoint, a.result.token as string);
    const { socket: bSock } = await rawHandshake(h.endpoint, b.result.token as string);

    ownerSock.write(req(3, "revokeAllTokens", {}));
    const resp = await ownerReader.nextJson();
    expect(resp.result.revokedCount).toBe(2);

    // Fresh reconnects with the old tokens must now fail.
    const { auth: aReauth, socket: aReauthSock } = await rawHandshake(h.endpoint, a.result.token as string);
    const { auth: bReauth, socket: bReauthSock } = await rawHandshake(h.endpoint, b.result.token as string);
    expect(aReauth.ok).toBe(false);
    expect(bReauth.ok).toBe(false);

    // The owner's OWN (spared) token still works.
    const { auth: ownerReauth, socket: ownerReauthSock } = await rawHandshake(h.endpoint, h.owner.token);
    expect(ownerReauth.ok).toBe(true);

    ownerSock.destroy();
    [aSock, bSock, aReauthSock, bReauthSock, ownerReauthSock].forEach((s) => {
      if (!s.destroyed) s.destroy();
    });
  });
});

describe("E2E: connection cap + backpressure (H6)", () => {
  it("refuses connections beyond the default cap (32) with a typed error before handshake", async () => {
    const h = await spawnDaemon();
    const sockets: net.Socket[] = [];
    try {
      const readers: LineReader[] = [];
      for (let i = 0; i < 32; i++) {
        const { socket, reader } = await rawHandshake(h.endpoint, h.owner.token);
        sockets.push(socket);
        readers.push(reader);
      }
      // The 33rd connection should be refused before it can even authenticate.
      const overCap = rawConnect(h.endpoint);
      const overCapReader = new LineReader(overCap);
      const resp = await overCapReader.nextJson();
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe("CONNECTION_CAP");
      await waitClose(overCap);
    } finally {
      sockets.forEach((s) => s.destroy());
      await h.stop();
      removeDataDir(h.dataDir);
    }
  }, 30_000);

  it("H6 backpressure: flooding one connection past the queue depth (1024) yields a typed error, not a hang or crash", async () => {
    const h = await spawnDaemon();
    try {
      const { socket, reader } = await rawHandshake(h.endpoint, h.owner.token);
      // Fire far more requests than the default max queue depth, back-to-back,
      // without waiting for any response — a real flood over the real socket.
      const TOTAL = 1400;
      for (let i = 0; i < TOTAL; i++) {
        socket.write(req(i, "recall", "flood"));
      }
      let backpressureSeen = false;
      let okSeen = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && okSeen + (backpressureSeen ? 1 : 0) < TOTAL) {
        const resp = await reader.nextJson(15_000);
        if (resp.ok) okSeen += 1;
        else if (resp.error?.code === "BACKPRESSURE") {
          backpressureSeen = true;
          break;
        }
      }
      expect(backpressureSeen).toBe(true);
      socket.destroy();

      // The daemon survives the flood and keeps serving other connections.
      const { auth } = await rawHandshake(h.endpoint, h.owner.token);
      expect(auth.ok).toBe(true);
    } finally {
      await h.stop();
      removeDataDir(h.dataDir);
    }
  }, 30_000);
});

describe("E2E: R9 Windows named-pipe random-suffix discovery-requires-token-file", () => {
  it("the bound endpoint carries a high-entropy random suffix, written only into the token file", async () => {
    if (process.platform !== "win32") return; // gated per this lane's brief
    const h = shared!;
    expect(h.endpoint).toMatch(/^\\\\\.\\pipe\\.+-[0-9a-f]{32}$/);
    expect(h.owner.endpoint).toBe(h.endpoint);
  });

  it("guessing the base pipe name WITHOUT the random suffix fails to connect", async () => {
    if (process.platform !== "win32") return;
    const h = shared!;
    const guessedBase = h.endpoint.replace(/-[0-9a-f]{32}$/, "");
    expect(guessedBase).not.toBe(h.endpoint);
    await new Promise<void>((resolve) => {
      const probe = net.connect(guessedBase);
      probe.once("connect", () => {
        probe.destroy();
        throw new Error("guessed base pipe name unexpectedly connected");
      });
      probe.once("error", () => resolve());
    });
  });

  it("two consecutive daemon starts mint DIFFERENT random pipe suffixes (endpoint is not guessable across restarts)", async () => {
    if (process.platform !== "win32") return;
    const h2 = await spawnDaemon();
    try {
      expect(h2.endpoint).not.toBe(shared!.endpoint);
    } finally {
      await h2.stop();
      removeDataDir(h2.dataDir);
    }
  }, 20_000);
});
