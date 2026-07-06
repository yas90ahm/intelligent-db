/**
 * daemon/__tests__/auditChain.test.ts — R8's separate hash chain: distinct
 * genesis from the fact/ratification chain, own chainHead(), tamper detection,
 * AppendSink-compatible shipping, and fingerprint-never-raw (R3).
 */

import { describe, it, expect } from "vitest";

import { sha256Hex } from "../../ratification/pendingLedger.js";
import {
  createDaemonAuditChain,
  DAEMON_GENESIS_HASH,
  type DaemonLedgerRecord,
} from "../auditChain.js";

describe("auditChain: R8 separate chain", () => {
  it("genesis hash is DISTINCT from the fact/ratification chain's sha256('GENESIS')", () => {
    const factChainGenesis = sha256Hex("GENESIS");
    expect(DAEMON_GENESIS_HASH).not.toBe(factChainGenesis);
  });

  it("an empty chain's chainHead is the genesis anchor at seq -1", () => {
    const chain = createDaemonAuditChain();
    expect(chain.chainHead()).toEqual({ seq: -1, headHash: DAEMON_GENESIS_HASH });
  });

  it("records chain in order and chainHead tracks the tail", () => {
    const clock = mkClock();
    const chain = createDaemonAuditChain({ clock });
    const r0 = chain.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    const r1 = chain.recordAuthFailure({ reason: "MALFORMED" });
    expect(r0.seq).toBe(0);
    expect(r1.seq).toBe(1);
    expect(r1.prevHash).toBe(r0.thisHash);
    expect(chain.chainHead()).toEqual({ seq: 1, headHash: r1.thisHash });
    expect(chain.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });

  it("verifyChain names the first broken seq after an at-rest tamper", () => {
    const chain = createDaemonAuditChain();
    chain.recordConnectionAccepted({ fingerprint: "fp1", sourceId: "src1" });
    chain.recordAuthFailure({ reason: "TIMEOUT" });
    chain.recordShutdown({ clean: true });

    const records = chain.records() as DaemonLedgerRecord[];
    // Flip a byte in the middle record's payload (immutable interface, but the
    // underlying array element object can still be mutated for this test — the
    // whole point of verifyChain is to catch exactly this).
    const tampered = { ...records[1]!, payload: { ...records[1]!.payload, reason: "MALFORMED" } };
    (records as DaemonLedgerRecord[])[1] = tampered as DaemonLedgerRecord;

    const result = chain.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.firstBrokenSeq).toBe(1);
  });

  it("records every documented record kind", () => {
    const chain = createDaemonAuditChain();
    chain.recordConnectionAccepted({ fingerprint: "fp", sourceId: "src" });
    chain.recordAuthFailure({ reason: "UNKNOWN_OR_REVOKED_TOKEN", fingerprint: "fp2" });
    chain.recordRevocation({ fingerprint: "fp2", revokedBySourceId: "src" });
    chain.recordAdminVerb({ verb: "issueToken", actorSourceId: "src", detail: "fp3" });
    chain.recordShutdown({ clean: true });

    const kinds = chain.records().map((r) => r.kind);
    expect(kinds).toEqual([
      "CONNECTION_ACCEPTED",
      "AUTH_FAILURE",
      "REVOCATION",
      "ADMIN_VERB",
      "SHUTDOWN_MARKER",
    ]);
    expect(chain.verifyChain().ok).toBe(true);
  });

  it("H5: CONNECTION_ACCEPTED carries requestId only when the client supplied one", () => {
    const chain = createDaemonAuditChain();
    const withId = chain.recordConnectionAccepted({
      fingerprint: "fp",
      sourceId: "src",
      requestId: "req-123",
    });
    const withoutId = chain.recordConnectionAccepted({ fingerprint: "fp2", sourceId: "src2" });
    expect((withId.payload as { requestId?: string }).requestId).toBe("req-123");
    expect(Object.prototype.hasOwnProperty.call(withoutId.payload, "requestId")).toBe(false);
  });

  it("AppendSink-compatible: ships BEFORE the local write, and a throwing sink aborts the append", () => {
    const shipped: string[] = [];
    const chain = createDaemonAuditChain({
      onAppend: (record) => {
        shipped.push(record.kind);
      },
    });
    chain.recordConnectionAccepted({ fingerprint: "fp", sourceId: "src" });
    expect(shipped).toEqual(["CONNECTION_ACCEPTED"]);
    expect(chain.records().length).toBe(1);

    const throwingChain = createDaemonAuditChain({
      onAppend: () => {
        throw new Error("sink down");
      },
    });
    expect(() => throwingChain.recordAuthFailure({ reason: "TIMEOUT" })).toThrow("sink down");
    // Fail-closed: nothing was appended locally when the sink threw.
    expect(throwingChain.records().length).toBe(0);
    expect(throwingChain.chainHead()).toEqual({ seq: -1, headHash: DAEMON_GENESIS_HASH });
  });
});

describe("auditChain: R3 fingerprint-never-raw (grep-style assertion)", () => {
  it("no serialized record ever contains a raw-token-shaped value", () => {
    // A "raw token" is a 64-hex-char string (see tokens.ts's TOKEN_BYTES=32).
    // Every fixture below uses ONLY fingerprints (also 64-hex, but the point of
    // this test is structural: the payload TYPES have no field a raw token could
    // occupy — there is no "token"/"raw" key anywhere in the daemon record shapes).
    const chain = createDaemonAuditChain();
    chain.recordConnectionAccepted({ fingerprint: "f".repeat(64), sourceId: "src" });
    chain.recordAuthFailure({ reason: "UNKNOWN_OR_REVOKED_TOKEN", fingerprint: "a".repeat(64) });
    chain.recordRevocation({ fingerprint: "b".repeat(64), revokedBySourceId: "src" });
    chain.recordAdminVerb({ verb: "issueToken", actorSourceId: "src", detail: "c".repeat(64) });
    chain.recordShutdown({ clean: false });

    for (const record of chain.records()) {
      const keys = new Set<string>();
      const collectKeys = (obj: unknown): void => {
        if (obj === null || typeof obj !== "object") return;
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          keys.add(k);
          collectKeys(v);
        }
      };
      collectKeys(record);
      expect(keys.has("token")).toBe(false);
      expect(keys.has("raw")).toBe(false);
      expect(keys.has("rawToken")).toBe(false);
    }
  });
});

function mkClock(): () => number {
  let t = 1_000_000;
  return () => (t += 1);
}
