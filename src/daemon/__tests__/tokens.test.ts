/**
 * daemon/__tests__/tokens.test.ts — token lifecycle (R1, R3, R9) + fingerprint-
 * never-raw (R3).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnchorClass } from "../../core/types.js";
import {
  createTokenStore,
  fingerprintToken,
  mintRawToken,
  readOwnerTokenFile,
  ownerTokenFilePath,
  atomicWriteFileSync,
  TOKEN_BYTES,
} from "../tokens.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "iddb-daemon-tokens-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("tokens: raw minting + fingerprinting", () => {
  it("mints a 32-byte (64 hex char) raw token", () => {
    const raw = mintRawToken();
    expect(raw).toMatch(/^[0-9a-f]+$/);
    expect(raw.length).toBe(TOKEN_BYTES * 2);
  });

  it("fingerprintToken is deterministic sha256 hex, distinct per input", () => {
    const a = mintRawToken();
    const b = mintRawToken();
    expect(fingerprintToken(a)).toBe(fingerprintToken(a));
    expect(fingerprintToken(a)).not.toBe(fingerprintToken(b));
    expect(fingerprintToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tokens: TokenStore lifecycle", () => {
  it("mint() issues a token verifiable by its raw value", () => {
    const store = createTokenStore(dataDir);
    const minted = store.mint(AnchorClass.EMAIL_OAUTH, "agent-1");
    const record = store.verify(minted.raw);
    expect(record).not.toBeNull();
    expect(record!.fingerprint).toBe(minted.record.fingerprint);
    expect(record!.grade).toBe(AnchorClass.EMAIL_OAUTH);
    expect(record!.label).toBe("agent-1");
    expect(record!.isOwner).toBe(false);
  });

  it("verify() rejects an unknown token", () => {
    const store = createTokenStore(dataDir);
    expect(store.verify(mintRawToken())).toBeNull();
  });

  it("revoke() takes effect immediately (a Set lookup, no restart)", () => {
    const store = createTokenStore(dataDir);
    const minted = store.mint(AnchorClass.DOMAIN);
    expect(store.verify(minted.raw)).not.toBeNull();

    const wasActive = store.revoke(minted.record.fingerprint);
    expect(wasActive).toBe(true);
    expect(store.verify(minted.raw)).toBeNull(); // immediate, no restart needed
    expect(store.isActive(minted.record.fingerprint)).toBe(false);
  });

  it("revoke() on an already-revoked/unknown fingerprint returns false (idempotent)", () => {
    const store = createTokenStore(dataDir);
    const minted = store.mint(AnchorClass.DOMAIN);
    expect(store.revoke(minted.record.fingerprint)).toBe(true);
    expect(store.revoke(minted.record.fingerprint)).toBe(false);
    expect(store.revoke("never-issued")).toBe(false);
  });

  it("ensureOwnerToken auto-provisions an OWNER-grade token on first call", () => {
    const store = createTokenStore(dataDir);
    const minted = store.ensureOwnerToken("some-endpoint");
    expect(minted.record.grade).toBe(AnchorClass.OWNER);
    expect(minted.record.isOwner).toBe(true);
    expect(store.verify(minted.raw)).not.toBeNull();
  });

  it("ensureOwnerToken is idempotent across 'restarts' (same raw token reused)", () => {
    const store1 = createTokenStore(dataDir);
    const first = store1.ensureOwnerToken("endpoint-a");

    // Simulate a restart: a FRESH store instance rooted at the SAME dataDir.
    const store2 = createTokenStore(dataDir);
    const second = store2.ensureOwnerToken("endpoint-b");

    expect(second.raw).toBe(first.raw); // already-distributed clients keep working
    expect(second.record.fingerprint).toBe(first.record.fingerprint);
  });

  it("R9: ensureOwnerToken refreshes the endpoint field on each call", () => {
    const store = createTokenStore(dataDir);
    store.ensureOwnerToken("endpoint-a");
    store.ensureOwnerToken("endpoint-b");
    const file = readOwnerTokenFile(dataDir);
    expect(file).not.toBeNull();
    expect(file!.endpoint).toBe("endpoint-b");
  });

  it("revokeAllTokens spares the invoking connection's token and re-mints the owner file", () => {
    const store = createTokenStore(dataDir);
    const owner = store.ensureOwnerToken("endpoint-a");
    const agent1 = store.mint(AnchorClass.EMAIL_OAUTH, "agent-1");
    const agent2 = store.mint(AnchorClass.DOMAIN, "agent-2");

    const { revokedFingerprints, newOwnerToken } = store.revokeAllTokens(
      owner.record.fingerprint, // spare the connection currently using the owner token
      "endpoint-a",
    );

    expect([...revokedFingerprints].sort()).toEqual(
      [agent1.record.fingerprint, agent2.record.fingerprint].sort(),
    );
    // The spared (invoking) connection's OLD token still verifies.
    expect(store.verify(owner.raw)).not.toBeNull();
    // The revoked agent tokens no longer verify.
    expect(store.verify(agent1.raw)).toBeNull();
    expect(store.verify(agent2.raw)).toBeNull();
    // A fresh owner token was minted (distinct raw value) and persisted to the file.
    expect(newOwnerToken.raw).not.toBe(owner.raw);
    expect(store.verify(newOwnerToken.raw)).not.toBeNull();
    const file = readOwnerTokenFile(dataDir);
    expect(file!.token).toBe(newOwnerToken.raw);
  });

  it("reloadTokens() re-reads the persisted registry + revocation set from disk", () => {
    const store1 = createTokenStore(dataDir);
    const minted = store1.mint(AnchorClass.DOMAIN, "agent-x");
    store1.revoke(minted.record.fingerprint);

    // A second, independent store instance over the SAME dataDir must reflect
    // the persisted state without ever having minted anything itself.
    const store2 = createTokenStore(dataDir);
    expect(store2.verify(minted.raw)).toBeNull(); // revoked, persisted

    const another = store1.mint(AnchorClass.EMAIL_OAUTH, "agent-y");
    // store2 hasn't seen `another` yet (it was minted on store1 after store2 opened).
    expect(store2.verify(another.raw)).toBeNull();
    store2.reloadTokens();
    expect(store2.verify(another.raw)).not.toBeNull(); // now visible after reload
  });

  it("activeRecords() excludes revoked tokens", () => {
    const store = createTokenStore(dataDir);
    const a = store.mint(AnchorClass.DOMAIN);
    const b = store.mint(AnchorClass.EMAIL_OAUTH);
    store.revoke(a.record.fingerprint);
    const active = store.activeRecords().map((r) => r.fingerprint);
    expect(active).not.toContain(a.record.fingerprint);
    expect(active).toContain(b.record.fingerprint);
  });
});

describe("tokens: R1 file persistence + best-effort permissions", () => {
  it("writes the owner token file at the documented path", () => {
    const store = createTokenStore(dataDir);
    store.ensureOwnerToken("ep");
    const path = ownerTokenFilePath(dataDir);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { token: string; fingerprint: string };
    expect(typeof raw.token).toBe("string");
    expect(raw.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("R1: best-effort 0600 on POSIX (gated to process.platform; Windows has no POSIX bits)", () => {
    const store = createTokenStore(dataDir);
    store.ensureOwnerToken("ep");
    const path = ownerTokenFilePath(dataDir);
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      // Windows: no POSIX permission bits to assert; privacy comes from the
      // user-profile directory ACLs (R1's disclosed compensating control).
      // We only assert the file exists and is readable — no numeric mode check.
      expect(statSync(path).isFile()).toBe(true);
    }
  });
});

describe("tokens: R3 fingerprint-never-raw", () => {
  it("TokenRecord never carries a 'raw'/'token' field — only fingerprint", () => {
    const store = createTokenStore(dataDir);
    const minted = store.mint(AnchorClass.DOMAIN, "agent-z");
    const serialized = JSON.stringify(minted.record);
    // Grep-style assertion: the raw value must never appear inside the record
    // that would be persisted / audited (the registry file only ever stores
    // TokenRecord shapes, never raw values, for non-owner tokens).
    expect(serialized).not.toContain(minted.raw);
    expect(Object.keys(minted.record)).not.toContain("token");
    expect(Object.keys(minted.record)).not.toContain("raw");
  });

  it("the persisted per-agent token registry file never contains a raw token value", () => {
    const store = createTokenStore(dataDir);
    const minted = store.mint(AnchorClass.DOMAIN, "agent-z");
    const registryPath = join(dataDir, "daemon-tokens.json");
    const contents = readFileSync(registryPath, "utf8");
    expect(contents).not.toContain(minted.raw);
    expect(contents).toContain(minted.record.fingerprint);
  });
});

describe("tokens: atomicWriteFileSync (token-registry-silent-wipe root cause)", () => {
  it("writes the file with the requested content, and leaves no orphaned temp file behind", () => {
    const path = join(dataDir, "atomic-target.json");
    atomicWriteFileSync(path, JSON.stringify({ v: 1 }), 0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 1 });
    const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it(
    "a FAILED rename never corrupts an existing target: the real production write path " +
      "is atomic (stage-then-rename), never a partial in-place write",
    () => {
      // Force the rename step to fail by making the TARGET a directory (a
      // file can never be renamed onto an existing directory, on either
      // POSIX or Windows) — this exercises the real `atomicWriteFileSync`
      // function's failure path, not a re-derived model of it.
      const targetDir = join(dataDir, "target-is-a-dir.json");
      mkdirSync(targetDir);

      expect(() => atomicWriteFileSync(targetDir, "new content", 0o600)).toThrow();

      // The "existing file" (here, a directory) is completely untouched —
      // the defining atomicity property: a failed write can NEVER leave the
      // destination half-written, because content is only ever staged at a
      // SEPARATE temp path first.
      expect(statSync(targetDir).isDirectory()).toBe(true);
      // No orphaned temp file left behind after the failed rename either.
      const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    },
  );

  it("mint()/ensureOwnerToken() never leave an orphaned .tmp- file in dataDir (the real write path)", () => {
    const store = createTokenStore(dataDir);
    store.ensureOwnerToken("ep-atomic-probe");
    store.mint(AnchorClass.DOMAIN, "agent-atomic-probe");
    store.revoke(store.mint(AnchorClass.EMAIL_OAUTH).record.fingerprint);
    const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("tokens: token-registry-silent-wipe — loud logging on corrupt-registry fallback", () => {
  it("a corrupt daemon-tokens.json logs LOUDLY (structured stderr) and falls back to empty, never silently", () => {
    const registryPath = join(dataDir, "daemon-tokens.json");
    // Simulate exactly the pre-fix crash symptom: a truncated write (what a
    // non-atomic writeFileSync leaves behind on a SIGKILL mid-write).
    writeFileSync(registryPath, '{"records":[{"fingerprint":"ab', "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The REAL production constructor path (FsTokenStore's constructor calls
    // reloadTokens() immediately).
    const store = createTokenStore(dataDir);
    const loggedLines = stderrSpy.mock.calls.map((c) => String(c[0]));
    stderrSpy.mockRestore();

    // Fails CLOSED to empty (no non-owner records trusted from a half-parsed file) —
    // the correct, UNCHANGED default — but no longer silently.
    expect(store.activeRecords()).toEqual([]);
    const parsed = loggedLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((r) => r?.["event"] === "token_registry_corrupt_fallback_empty");
    expect(parsed).toBeDefined();
    expect(parsed!["level"]).toBe("error");
    expect(parsed!["path"]).toBe(registryPath);
    expect(typeof parsed!["message"]).toBe("string");
  });

  it("a corrupt registry does NOT prevent an owner token from still being usable (fold-back-in survives)", () => {
    const store1 = createTokenStore(dataDir);
    const owner = store1.ensureOwnerToken("ep");

    // Corrupt ONLY the registry file (not the separate owner-token file).
    writeFileSync(join(dataDir, "daemon-tokens.json"), "{ not json at all", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const store2 = createTokenStore(dataDir);
    stderrSpy.mockRestore();

    // The owner record is folded back in from the SEPARATE owner-token file
    // regardless of the registry's corruption (reloadTokens' own documented
    // behavior) — only non-owner issued tokens were ever at risk.
    expect(store2.verify(owner.raw)).not.toBeNull();
  });
});
