/**
 * daemon/tokens.ts — TOKEN MINT / FINGERPRINT / REVOKE / RELOAD (PHASE3_DAEMON_SPEC.md
 * R1, R3, R9).
 *
 * A daemon token is an opaque 32-byte random value (hex-encoded, 64 chars). The RAW
 * value is the bearer credential a client presents at handshake (H1); this module
 * NEVER stores or logs the raw value anywhere except the one owner-token file R1
 * requires (`<dataDir>/daemon-token`, best-effort 0600 on POSIX) — every other record
 * (the in-memory revocation set, the persisted token registry, every audit record)
 * carries only the sha256 FINGERPRINT (R3: "the raw token never appears in logs,
 * errors, or the ledger").
 *
 * R1 — auto-provisioning: on first start the daemon mints an OWNER-grade token into
 * the user-private token file; clients read it from there. Additional per-agent
 * tokens are issuable at config-priced grades via {@link TokenStore.mint}.
 *
 * R3 — revocation takes effect IMMEDIATELY (a plain in-memory `Set` lookup on every
 * verify — no restart required). `revokeAllTokens` spares one connection's token (the
 * one performing the revocation) and re-mints the owner token file.
 *
 * R9 — Windows compensating control: the daemon's chosen named-pipe endpoint (with
 * its random-suffix name) is written into the SAME user-private token file the raw
 * token lives in, via {@link TokenStore.writeOwnerFile}'s `endpoint` field — the pipe
 * name is otherwise never advertised anywhere.
 *
 * ZERO new runtime deps: `node:crypto` (randomBytes, sha256) + `node:fs` only.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 *
 * `invalid-token-error-dead-code` (Wave 3 polish): this module used to export an
 * `InvalidTokenError` class documented as "thrown by admin verbs / verify paths
 * on an unknown or revoked token" — but nothing ever threw it. {@link
 * TokenStore.verify} deliberately RETURNS `null` on an unknown/revoked token
 * rather than throwing: its one production caller, `server.ts`'s handshake
 * handler, must COMMUNICATE the rejection to a remote client over the wire
 * (`authErr(...)`, a typed JSON response — see `#failHandshake`), not raise an
 * in-process exception with no synchronous caller on the other end of a socket
 * to catch it. The client side already has its own typed rejection,
 * `client.ts`'s `DaemonAuthError`, thrown when a real client receives that
 * wire-level rejection. With no genuine throw site on either side of the wire
 * boundary, the honest fix was deletion, not manufacturing a caller for an
 * error shape the architecture has no use for.
 */

import { randomBytes, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

import { AnchorClass } from "../core/types.js";
import { daemonLog } from "./log.js";

// ---------------------------------------------------------------------------
// Raw token minting + fingerprinting
// ---------------------------------------------------------------------------

/** Bytes of entropy per minted token (R3: "opaque 32-byte random values"). */
export const TOKEN_BYTES = 32;

/** Mint a fresh raw bearer token: 32 random bytes, hex-encoded (64 chars). */
export function mintRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * sha256 (hex) fingerprint of a raw token. This is the ONLY form of a token this
 * module (or any audit record / error / log) is permitted to retain once minted —
 * see the module doc's R3 discipline. Pure and total.
 */
export function fingerprintToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One issued token's metadata — NEVER the raw value. */
export interface TokenRecord {
  readonly fingerprint: string;
  readonly grade: AnchorClass;
  readonly label?: string;
  readonly issuedAt: number;
  /** True for the single auto-provisioned owner token (R1). */
  readonly isOwner: boolean;
}

/** The result of minting a token: the RAW value (return-once) + its record. */
export interface MintedToken {
  readonly raw: string;
  readonly record: TokenRecord;
}

/** The persisted, user-private owner-token file's shape (`<dataDir>/daemon-token`). */
export interface OwnerTokenFile {
  readonly token: string;
  readonly fingerprint: string;
  /** R9: the bound endpoint (POSIX socket path / Windows pipe name w/ random suffix). */
  readonly endpoint?: string;
  readonly mintedAt: number;
}

// ---------------------------------------------------------------------------
// Persistence file names
// ---------------------------------------------------------------------------

const OWNER_TOKEN_FILENAME = "daemon-token";
const REGISTRY_FILENAME = "daemon-tokens.json";

/** Disk shape of the (non-owner-raw) token registry: fingerprints + grades only. */
interface RegistryFile {
  readonly records: readonly TokenRecord[];
  readonly revoked: readonly string[];
}

// ---------------------------------------------------------------------------
// token-registry-silent-wipe fix (root cause, not just louder logging): every
// persisted token file (the registry AND the owner-token file) is now written
// ATOMICALLY — stage the full content at a sibling temp path, then ONE
// `renameSync` onto the real path. `renameSync` is a single filesystem
// operation the OS guarantees is all-or-nothing: a process killed at any point
// before it either never touched the real path (the temp file is simply
// orphaned) or has already fully replaced it — there is no window where a
// SIGKILL leaves the real path holding a half-written/truncated file. This is
// what actually stops `reloadTokens()`'s corrupt-JSON fallback from being
// reachable via a crash mid-write in the first place (previously a plain
// `writeFileSync` truncates-then-writes the REAL path directly, so a crash
// mid-write left exactly the truncated-JSON shape the fallback below has to
// degrade for).
// ---------------------------------------------------------------------------

export function atomicWriteFileSync(path: string, data: string, mode?: number): void {
  const tmpPath = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  if (mode !== undefined) {
    writeFileSync(tmpPath, data, { encoding: "utf8", mode });
  } else {
    writeFileSync(tmpPath, data, "utf8");
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    // Never leave an orphaned temp file behind on a failed rename — best
    // effort; the ORIGINAL error (not this cleanup) is what the caller sees.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TokenStore
// ---------------------------------------------------------------------------

export interface TokenStore {
  /** Mint a fresh token at `grade`, register it, persist the registry, return it once. */
  mint(grade: AnchorClass, label?: string): MintedToken;
  /**
   * R1 auto-provisioning: mint (if none persisted yet) or load the existing
   * OWNER-grade token, writing/refreshing `<dataDir>/daemon-token` with the given
   * `endpoint` (R9). Idempotent across restarts: a pre-existing owner token file
   * is loaded rather than re-minted, so already-distributed clients keep working.
   */
  ensureOwnerToken(endpoint: string): MintedToken;
  /** Verify a RAW presented token: returns its record, or `null` if unknown/revoked. */
  verify(raw: string): TokenRecord | null;
  /** Revoke one token by fingerprint. Returns whether it was previously active. */
  revoke(fingerprint: string): boolean;
  /**
   * R3: revoke every token except `spareFingerprint` (the invoking connection's
   * own token), then re-mint the owner token file at `endpoint`. Returns the
   * revoked fingerprints and the freshly minted owner token.
   */
  revokeAllTokens(
    spareFingerprint: string | null,
    endpoint: string,
  ): { revokedFingerprints: readonly string[]; newOwnerToken: MintedToken };
  /** Re-read the persisted registry + revocation set from disk. */
  reloadTokens(): void;
  /** Whether a fingerprint is currently known (issued, not revoked). */
  isActive(fingerprint: string): boolean;
  /** Every currently-active (non-revoked) record. */
  activeRecords(): readonly TokenRecord[];
  /** The data directory this store persists under. */
  readonly dataDir: string;
}

class FsTokenStore implements TokenStore {
  readonly dataDir: string;
  #records = new Map<string, TokenRecord>();
  #revoked = new Set<string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.reloadTokens();
  }

  mint(grade: AnchorClass, label?: string): MintedToken {
    const raw = mintRawToken();
    const record: TokenRecord = {
      fingerprint: fingerprintToken(raw),
      grade,
      ...(label !== undefined ? { label } : {}),
      issuedAt: Date.now(),
      isOwner: false,
    };
    this.#records.set(record.fingerprint, record);
    this.#persistRegistry();
    return { raw, record };
  }

  ensureOwnerToken(endpoint: string): MintedToken {
    const existing = this.#readOwnerFile();
    if (existing !== null) {
      const record: TokenRecord = {
        fingerprint: existing.fingerprint,
        grade: AnchorClass.OWNER,
        issuedAt: existing.mintedAt,
        isOwner: true,
      };
      this.#records.set(record.fingerprint, record);
      this.#revoked.delete(record.fingerprint);
      this.#persistRegistry();
      // Refresh the endpoint (a fresh random-suffix pipe name each start, R9)
      // while keeping the SAME token so already-distributed copies still work.
      this.#writeOwnerFile({
        token: existing.token,
        fingerprint: existing.fingerprint,
        endpoint,
        mintedAt: existing.mintedAt,
      });
      return { raw: existing.token, record };
    }
    const raw = mintRawToken();
    const fingerprint = fingerprintToken(raw);
    const mintedAt = Date.now();
    const record: TokenRecord = { fingerprint, grade: AnchorClass.OWNER, issuedAt: mintedAt, isOwner: true };
    this.#records.set(fingerprint, record);
    this.#persistRegistry();
    this.#writeOwnerFile({ token: raw, fingerprint, endpoint, mintedAt });
    return { raw, record };
  }

  verify(raw: string): TokenRecord | null {
    const fingerprint = fingerprintToken(raw);
    if (this.#revoked.has(fingerprint)) return null;
    return this.#records.get(fingerprint) ?? null;
  }

  isActive(fingerprint: string): boolean {
    return this.#records.has(fingerprint) && !this.#revoked.has(fingerprint);
  }

  activeRecords(): readonly TokenRecord[] {
    return [...this.#records.values()].filter((r) => !this.#revoked.has(r.fingerprint));
  }

  revoke(fingerprint: string): boolean {
    if (!this.isActive(fingerprint)) return false;
    this.#revoked.add(fingerprint);
    this.#persistRegistry();
    return true;
  }

  revokeAllTokens(
    spareFingerprint: string | null,
    endpoint: string,
  ): { revokedFingerprints: readonly string[]; newOwnerToken: MintedToken } {
    const revoked: string[] = [];
    for (const fp of this.#records.keys()) {
      if (fp === spareFingerprint) continue;
      if (this.#revoked.has(fp)) continue;
      this.#revoked.add(fp);
      revoked.push(fp);
    }
    // Re-mint the owner token file unconditionally — a leaked-owner-token
    // response to "revoke everything, right now" must not leave the SAME
    // owner token valid again on the next `ensureOwnerToken`/reload.
    const raw = mintRawToken();
    const fingerprint = fingerprintToken(raw);
    const mintedAt = Date.now();
    const record: TokenRecord = { fingerprint, grade: AnchorClass.OWNER, issuedAt: mintedAt, isOwner: true };
    this.#records.set(fingerprint, record);
    this.#persistRegistry();
    this.#writeOwnerFile({ token: raw, fingerprint, endpoint, mintedAt });
    return { revokedFingerprints: revoked, newOwnerToken: { raw, record } };
  }

  reloadTokens(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    if (!existsSync(path)) {
      this.#records = new Map();
      this.#revoked = new Set();
    } else {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
        this.#records = new Map(parsed.records.map((r) => [r.fingerprint, r]));
        this.#revoked = new Set(parsed.revoked);
      } catch (err) {
        // A corrupt/unreadable registry reloads to EMPTY (fail-closed: nothing
        // is trusted rather than trusting a half-parsed file) rather than
        // throwing and leaving the daemon unable to start.
        //
        // token-registry-silent-wipe fix: this fallback used to be COMPLETELY
        // SILENT — every non-owner token an operator had issued vanished with
        // zero trace (no log, no thrown warning, no audit record), so the
        // very first symptom was "every other agent's token stopped working"
        // with nothing pointing at why. Now logged LOUDLY at "error" level
        // before falling back, naming the path and the parse failure — the
        // fallback-to-empty ITSELF is unchanged (still the correct fail-closed
        // default: never trust a half-parsed file), only its silence is fixed.
        daemonLog({
          event: "token_registry_corrupt_fallback_empty",
          level: "error",
          path,
          dataDir: this.dataDir,
          message: err instanceof Error ? err.message : String(err),
        });
        this.#records = new Map();
        this.#revoked = new Set();
      }
    }
    // Fold the owner-token file's fingerprint back in (it is authoritative for
    // the OWNER record even if the registry JSON was hand-edited/deleted).
    const owner = this.#readOwnerFile();
    if (owner !== null) {
      this.#records.set(owner.fingerprint, {
        fingerprint: owner.fingerprint,
        grade: AnchorClass.OWNER,
        issuedAt: owner.mintedAt,
        isOwner: true,
      });
      this.#revoked.delete(owner.fingerprint);
    }
  }

  // -- internals --------------------------------------------------------------

  #persistRegistry(): void {
    const file: RegistryFile = {
      records: [...this.#records.values()],
      revoked: [...this.#revoked],
    };
    const path = join(this.dataDir, REGISTRY_FILENAME);
    // token-registry-silent-wipe fix: ATOMIC (temp file + rename), never a
    // partial in-place write — see the module comment above `atomicWriteFileSync`.
    // `mode: 0o600` is baked in at the temp file's CREATION (daemon-token-
    // file-toctou fix's same discipline, applied here too): the rename
    // preserves it, so this registry is never briefly loosely-permissioned.
    atomicWriteFileSync(path, JSON.stringify(file, null, 2), 0o600);
    this.#bestEffortPrivate(path);
  }

  #readOwnerFile(): OwnerTokenFile | null {
    const path = join(this.dataDir, OWNER_TOKEN_FILENAME);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as OwnerTokenFile;
    } catch {
      return null;
    }
  }

  /**
   * daemon-token-file-toctou fix: `{mode:0o600}` is passed directly to the
   * write that CREATES the temp file (`atomicWriteFileSync`), not applied via
   * a separate `chmodSync` AFTER a plain `writeFileSync` — the old shape had a
   * real create-then-chmod window where the file briefly existed at default
   * (often world/group-readable) permissions holding the RAW bearer token.
   * Because `atomicWriteFileSync` stages content at a fresh temp path and only
   * EVER makes it visible at `path` via one atomic `renameSync` (which
   * preserves the temp file's mode bits — a rename is a metadata-only
   * operation on the same inode), the owner-token file is 0600 from the very
   * first instant it is observable at `path`, on every write (first mint AND
   * every subsequent endpoint refresh) — there is no window to close.
   */
  #writeOwnerFile(file: OwnerTokenFile): void {
    const path = join(this.dataDir, OWNER_TOKEN_FILENAME);
    atomicWriteFileSync(path, JSON.stringify(file, null, 2), 0o600);
    // Defense in depth only (the atomic write above already establishes 0600
    // from creation): a best-effort re-assertion, e.g. against an unusual
    // filesystem that does not honor `open()`'s mode argument.
    this.#bestEffortPrivate(path);
  }

  /**
   * R1: best-effort 0600 on POSIX, defense in depth on top of the atomic
   * writes above (which already bake `mode: 0o600` in at creation — see
   * `#writeOwnerFile`'s doc). On Windows `chmod` has no POSIX-bit semantics —
   * the file's privacy there comes from the user-profile directory ACLs (the
   * module doc's disclosed R9 compensating control), so this is a genuine
   * no-op there; still best-effort (a read-only filesystem or an exotic ACL
   * setup must never crash daemon startup over a permission tightening) —
   * but daemon-token-file-toctou fix: a failure is now LOGGED, not silently
   * swallowed (previously zero log/stderr output on any platform).
   */
  #bestEffortPrivate(path: string): void {
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      daemonLog({
        event: "token_file_chmod_failed",
        level: "warn",
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Construct a filesystem-backed {@link TokenStore} rooted at `dataDir`. */
export function createTokenStore(dataDir: string): TokenStore {
  return new FsTokenStore(dataDir);
}

/** Read the owner token file directly (for client bootstrap code / tests). */
export function readOwnerTokenFile(dataDir: string): OwnerTokenFile | null {
  const path = join(dataDir, OWNER_TOKEN_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnerTokenFile;
  } catch {
    return null;
  }
}

/** The owner-token file's path for a given `dataDir` (exported for CLI/docs use). */
export function ownerTokenFilePath(dataDir: string): string {
  return join(dataDir, OWNER_TOKEN_FILENAME);
}
