/**
 * store/backup.ts — online snapshot, WAL archiving, and point-in-time restore
 * (Phase 2 Durability spec §2).
 *
 * THREE PIECES:
 *
 *  1. {@link snapshotDb} — `db.snapshot(destPath)`: an online, consistent, compact
 *     COLD-BACKUP copy of a live WAL database via `VACUUM INTO` (the portable floor
 *     the spec asks for — `node:sqlite`'s `DatabaseSync` does not yet expose a
 *     native backup-API method to prefer over it; see the doc on {@link snapshotDb}).
 *     A sidecar manifest (`<destPath>.manifest.json`) is written AFTER the copy and
 *     fsynced, carrying `{ createdAt, chainHead, userVersion, schemaHash }`. Restoring
 *     "just this file" (copy it back, done) is always correct on its own.
 *
 *  2. {@link createWalArchiver} — continuous WAL-segment archiving off the LIVE
 *     handle: on each controlled checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`), the
 *     `-wal` file is byte-copied to the archive dir with a monotonically-named file
 *     BEFORE SQLite truncates it. Auto-checkpoint is disabled
 *     (`wal_autocheckpoint=0`) so truncation only ever happens under our control.
 *
 *  3. {@link restoreToTimestamp} — reconstructs the database as of a target
 *     timestamp `t` from a WAL archive directory, verifies it, and REFUSES to
 *     complete if verification fails (a restore that can't prove its own integrity
 *     is a failure, not a warning).
 *
 * A DISCLOSED DESIGN DECISION (read before changing any of this):
 * ---------------------------------------------------------------
 * `VACUUM INTO` REWRITES the destination file's page layout (defragmented,
 * renumbered) relative to the live database it copied from. SQLite's native
 * WAL-recovery-on-open mechanism applies WAL frames by PAGE NUMBER — it does not
 * remap them. That means a `.wal` segment archived from the LIVE database's own
 * (never-defragmented) page lineage is NOT safe to splice directly onto a
 * `VACUUM INTO` copy: page numbers that were correct against the live file's
 * layout can silently land on the WRONG page of a differently-laid-out file. This
 * was verified empirically (not just reasoned about) before choosing this design;
 * see `p2-migrations-backup.md` in the scratchpad for the repro. Silently shipping
 * that composition would be exactly the kind of "looks fine in the happy path,
 * corrupts under real fragmentation" bug CLAUDE.md's fail-closed posture forbids.
 *
 * The SAFE, verified-working composition (also empirically confirmed) is:
 * WAL segments replay correctly via SQLite's own recovery-on-open onto a PLAIN
 * byte copy of the SAME live file's lineage (never VACUUM'd) taken while fully
 * checkpointed. So {@link createWalArchiver} maintains its OWN `base.db` inside the
 * archive directory — a plain `fs.copyFileSync` of the live file, taken once, the
 * first time archiving turns on, immediately after a full checkpoint — and every
 * later archived `.wal` segment is guaranteed to replay correctly onto that same
 * base (checkpointing never renumbers pages; only `VACUUM` does, and the live
 * database here is never `VACUUM`ed in place — only ever `VACUUM INTO`'d
 * elsewhere).
 *
 * {@link restoreToTimestamp} therefore reconstructs from the archive directory's
 * own `base.db` + its ordered `.wal` segments (self-sufficient, verified-sound),
 * NOT by splicing WAL onto the passed `snapshotPath`. `snapshotPath`'s manifest is
 * still read and cross-checked (`userVersion` must match; if the snapshot predates
 * `t`, the reconstructed database must be able to reach at least the snapshot's
 * recorded `chainHead` by seq) — the parameter stays exactly where the spec put it
 * in the function signature, its role is a corroborating cross-check, not the
 * physical restore base.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { asEpochMs } from "../core/types.js";
import type { EpochMs } from "../core/types.js";
import { readUserVersion } from "./migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * The minimal shape of a ratification-ledger checkpoint this module needs
 * (mirrors {@link "../ratification/pendingLedger.js".ChainHead} structurally —
 * NOT imported directly, to keep `store/` from depending on `ratification/`
 * for a two-field shape; anything satisfying this structurally works, e.g. the
 * real `PendingLedger.chainHead()` return value).
 */
export interface ChainHeadLike {
  readonly seq: number;
  readonly headHash: string;
}

// ---------------------------------------------------------------------------
// 1. Online snapshot (VACUUM INTO) + manifest
// ---------------------------------------------------------------------------

/** The sidecar manifest written alongside every snapshot, as `<destPath>.manifest.json`. */
export interface SnapshotManifest {
  readonly createdAt: EpochMs;
  /** The ratification ledger's checkpoint at snapshot time, or `null` if none is wired. */
  readonly chainHead: ChainHeadLike | null;
  readonly userVersion: number;
  /** sha256 over `sqlite_master`'s (name, sql) pairs — detects schema drift at a glance. */
  readonly schemaHash: string;
}

/** The manifest sidecar path for a given snapshot destination. */
export function manifestPathFor(destPath: string): string {
  return `${destPath}.manifest.json`;
}

/** sha256 over every `(name, sql)` row of `sqlite_master`, sorted by name — a schema fingerprint. */
function computeSchemaHash(db: DatabaseSyncType): string {
  const rows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;
  const canon = rows.map((r) => `${r.name}${r.sql}`).join(" ");
  return createHash("sha256").update(canon).digest("hex");
}

/** Write JSON to `path`, fsynced before returning (durability for the sidecar itself). */
function writeJsonFsync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read + parse a JSON file (no fallback — a missing/corrupt manifest is a hard error). */
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * `db.snapshot(destPath)`: an ONLINE, consistent, compact backup copy of `db`
 * (works against a live WAL database — `VACUUM INTO` reads a transactionally
 * consistent view without blocking writers any longer than the copy itself takes)
 * plus a fsynced sidecar manifest recording `{ createdAt, chainHead, userVersion,
 * schemaHash }`.
 *
 * `node:sqlite`'s `DatabaseSync` does not (as of the Node version this repo
 * targets) expose a backup-API method to prefer over `VACUUM INTO` — this IS the
 * portable floor the spec names, not a fallback we chose not to upgrade from.
 *
 * @param chainHead the ratification ledger's `chainHead()` at the moment of
 *   snapshotting, if one is wired (omit/`null` when there is no audit ledger).
 */
export function snapshotDb(
  db: DatabaseSyncType,
  destPath: string,
  opts?: { readonly chainHead?: ChainHeadLike | null; readonly now?: () => number },
): SnapshotManifest {
  mkdirSync(dirname(destPath), { recursive: true });
  // Bound parameter (not string interpolation) — safe regardless of destPath content.
  db.prepare("VACUUM INTO ?").run(destPath);

  const manifest: SnapshotManifest = {
    createdAt: asEpochMs((opts?.now ?? Date.now)()),
    chainHead: opts?.chainHead ?? null,
    userVersion: readUserVersion(db),
    schemaHash: computeSchemaHash(db),
  };
  writeJsonFsync(manifestPathFor(destPath), manifest);
  return manifest;
}

/** Read a snapshot's manifest. Throws if the manifest sidecar is missing/unreadable. */
export function readSnapshotManifest(destPath: string): SnapshotManifest {
  return readJson<SnapshotManifest>(manifestPathFor(destPath));
}

// ---------------------------------------------------------------------------
// 2. WAL archiving
// ---------------------------------------------------------------------------

/** Per-archived-segment metadata, written as `<dir>/seg-NNNNNN.meta.json`. */
export interface ArchivedSegmentMeta {
  readonly seq: number;
  readonly walFile: string;
  readonly checkpointedAt: EpochMs;
  readonly userVersion: number;
  readonly chainHead: ChainHeadLike | null;
}

/** The archive directory's own base-copy metadata, `<dir>/base.meta.json`. */
export interface ArchiveBaseMeta {
  readonly createdAt: EpochMs;
  readonly userVersion: number;
}

export interface WalArchiveOptions {
  /** Directory the archiver owns; created if missing. */
  readonly dir: string;
  /**
   * Optional automatic checkpoint interval (ms). When omitted, archiving only
   * happens when {@link WalArchiver.checkpoint} is called explicitly (the
   * "threshold" side of "timer/threshold" from a caller-side op counter, or a
   * test driving it deterministically).
   */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface WalArchiver {
  /**
   * Force a checkpoint-and-archive cycle right now. Returns the segment's
   * metadata, or `null` if there was nothing pending in the live WAL to archive
   * (a no-op checkpoint is never recorded as a segment).
   *
   * @param chainHead the ratification ledger's checkpoint at this moment, if
   *   wired — recorded in the segment's meta so `restoreToTimestamp` can prove
   *   "chainHead consistent with the manifest" at the restored point.
   */
  checkpoint(chainHead?: ChainHeadLike | null): ArchivedSegmentMeta | null;
  /** All archived segment metas, ascending by `seq`. */
  listSegments(): ArchivedSegmentMeta[];
  /** Stop the interval timer, if one was started. Idempotent. */
  close(): void;
}

function segMetaPath(dir: string, seq: number): string {
  return join(dir, `seg-${String(seq).padStart(6, "0")}.meta.json`);
}

function baseDbPath(dir: string): string {
  return join(dir, "base.db");
}

function baseMetaPath(dir: string): string {
  return join(dir, "base.meta.json");
}

/**
 * Set up continuous WAL-segment archiving off a LIVE, path-backed, WAL-mode
 * `db` handle (`:memory:` databases have no WAL file and are rejected).
 * Disables SQLite's own auto-checkpoint (`wal_autocheckpoint=0`) so a truncating
 * checkpoint only ever happens through {@link WalArchiver.checkpoint} — never
 * silently, mid-archive-copy, behind our back.
 *
 * On first activation against a fresh archive dir (no `base.db` yet): fully
 * checkpoints the live db (so it starts from a clean, WAL-lineage-consistent
 * state) and byte-copies the now-checkpointed main file into `<dir>/base.db` —
 * see the module doc's disclosed design decision for why this must be a plain
 * copy, never a `VACUUM INTO`.
 */
export function createWalArchiver(
  db: DatabaseSyncType,
  opts: WalArchiveOptions,
): WalArchiver {
  const dbPath = db.location();
  if (dbPath === null) {
    throw new Error(
      "createWalArchiver: the database has no on-disk location (an in-memory " +
        "':memory:' database has no WAL file to archive).",
    );
  }
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dir, { recursive: true });

  // Auto-checkpoint OFF: truncation happens ONLY via our own controlled checkpoint().
  db.exec("PRAGMA wal_autocheckpoint=0");

  if (!existsSync(baseDbPath(opts.dir))) {
    // Fully checkpoint first so the base copy starts from a clean, no-pending-WAL
    // state (mirrors how every subsequent segment boundary is defined).
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, baseDbPath(opts.dir));
    const baseMeta: ArchiveBaseMeta = {
      createdAt: asEpochMs(now()),
      userVersion: readUserVersion(db),
    };
    writeJsonFsync(baseMetaPath(opts.dir), baseMeta);
  }

  function listSegments(): ArchivedSegmentMeta[] {
    const files = readdirSync(opts.dir).filter(
      (f) => f.startsWith("seg-") && f.endsWith(".meta.json"),
    );
    const metas = files.map((f) => readJson<ArchivedSegmentMeta>(join(opts.dir, f)));
    metas.sort((a, b) => a.seq - b.seq);
    return metas;
  }

  function nextSeq(): number {
    const metas = listSegments();
    const last = metas[metas.length - 1];
    return last === undefined ? 1 : last.seq + 1;
  }

  function checkpoint(chainHead: ChainHeadLike | null = null): ArchivedSegmentMeta | null {
    const walPath = `${dbPath}-wal`;
    if (!existsSync(walPath) || statSync(walPath).size === 0) {
      // Nothing pending — a checkpoint here would be a no-op archive, so skip it
      // (no empty segment files, no wasted seq numbers).
      return null;
    }
    const seq = nextSeq();
    const walFile = `seg-${String(seq).padStart(6, "0")}.wal`;
    // Copy the WAL segment BEFORE truncating it — this is the durability-critical
    // ordering: once TRUNCATE runs, the pre-checkpoint WAL content is gone from the
    // live file for good.
    copyFileSync(walPath, join(opts.dir, walFile));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const meta: ArchivedSegmentMeta = {
      seq,
      walFile,
      checkpointedAt: asEpochMs(now()),
      userVersion: readUserVersion(db),
      chainHead,
    };
    writeJsonFsync(segMetaPath(opts.dir, seq), meta);
    return meta;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.intervalMs !== undefined) {
    timer = setInterval(() => {
      try {
        checkpoint();
      } catch {
        // Best-effort background tick; a caller relying on archiving completing
        // should call checkpoint() explicitly and handle the error itself.
      }
    }, opts.intervalMs);
    timer.unref?.();
  }

  return {
    checkpoint,
    listSegments,
    close(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Point-in-time restore
// ---------------------------------------------------------------------------

export interface RestoreVerification {
  readonly integrityOk: boolean;
  readonly chainOk: boolean;
  readonly chainFirstBrokenSeq: number | null;
  readonly chainHeadConsistent: boolean;
}

/**
 * The verifier a caller supplies so `store/` never has to import
 * `ratification/pendingLedger.ts` directly (keeping the layering the rest of
 * this codebase uses: the store is infrastructure, the audit chain is a
 * sibling subsystem the CALLER composes). Given the restored (already
 * integrity_check-passed) db handle, return the ledger's own verification.
 */
export type ChainVerifier = (restoredDb: DatabaseSyncType) => {
  readonly ok: boolean;
  readonly firstBrokenSeq: number | null;
  readonly chainHead: ChainHeadLike;
};

export interface RestoreOptions {
  /**
   * Verifies the restored ledger's checksum chain (structural half is always
   * `PRAGMA integrity_check`, run unconditionally). REQUIRED for the restore to
   * complete when the restored db carries a `ratification_records` table with
   * any rows — omitting it on such a db throws (a restore that cannot prove its
   * own chain is a failure, not a warning, per the spec's refusal rule).
   */
  readonly chainVerifier?: ChainVerifier;
}

export interface RestoreResult {
  readonly restoredPath: string;
  readonly appliedSegments: number;
  readonly userVersion: number;
  readonly chainHead: ChainHeadLike | null;
}

/** Remove `path`, `path-wal`, `path-shm` if present (best-effort cleanup). */
function removeDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

/**
 * REFUSE-TO-COMPLETE error (the spec's refusal rule, {@link RestoreOptions.chainVerifier}'s
 * doc): thrown by {@link restoreToTimestamp} when the reconstructed database carries a
 * `ratification_records` table with one or more rows (an audit-chain-backed deployment)
 * but either no {@link ChainVerifier} was supplied to prove that chain, or one was
 * supplied and it reported the chain broken. A restore that cannot prove the audit
 * chain it is handing back is a FAILURE, not a warning: `PRAGMA integrity_check` only
 * proves the file is not structurally torn — it says nothing about whether the
 * checksum-chained ledger inside it is genuine. Silently returning success here would
 * hand the caller an UNVERIFIED restore with no visible symptom until the next tamper
 * investigation finds nothing to check against.
 */
export class UnverifiedLedgerRestoreError extends Error {
  constructor(reason: string) {
    super(`restoreToTimestamp: refusing to complete — ${reason}`);
    this.name = "UnverifiedLedgerRestoreError";
  }
}

/**
 * Row count of `ratification_records` in `db`, or `0` if the table does not exist at
 * all (a database that never wired a ratification ledger has no such table — the
 * refusal gate below is correctly inert for it, since there is no chain to omit
 * verifying).
 */
function ratificationRecordsRowCount(db: DatabaseSyncType): number {
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ratification_records'",
    )
    .get();
  if (tableRow === undefined) return 0;
  const row = db.prepare("SELECT COUNT(*) AS n FROM ratification_records").get() as
    | { n: number }
    | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * Reconstruct the database as of timestamp `t` from a WAL archive directory
 * (see the module doc's disclosed design decision for WHY the reconstruction
 * base is the archive dir's own `base.db`, not a byte-splice onto
 * `snapshotPath`), write it to `destPath`, VERIFY it, and REFUSE (delete the
 * output, throw) if verification fails.
 *
 * `snapshotPath` is still read and cross-checked: its manifest's `userVersion`
 * must match the reconstructed database's, and — when the snapshot predates `t`
 * and carries a `chainHead` — the reconstructed chain must be able to reach at
 * least that head by seq (the snapshot's own recorded state must be a PREFIX of
 * what we restored to; anything else means the archive lineage and the snapshot
 * disagree about history, and restore refuses rather than silently picking one).
 *
 * @throws if `walArchiveDir` has no `base.db` (nothing has ever been archived),
 *   if `snapshotPath`'s manifest is unreadable, if `PRAGMA integrity_check`
 *   fails, if a `chainVerifier` is required (see {@link RestoreOptions}) but
 *   omitted, or if the chain / chainHead-consistency check fails. In every
 *   throwing case the partially-written `destPath` (+ `-wal`/`-shm`) is removed
 *   first — a failed restore never leaves a half-restored file behind to be
 *   mistaken for a good one.
 */
export function restoreToTimestamp(
  snapshotPath: string,
  walArchiveDir: string,
  t: EpochMs,
  destPath: string,
  opts?: RestoreOptions,
): RestoreResult {
  const base = baseDbPath(walArchiveDir);
  if (!existsSync(base)) {
    throw new Error(
      `restoreToTimestamp: no WAL archive base found at ${base} — nothing has ` +
        `ever been archived in ${walArchiveDir}.`,
    );
  }
  // Cross-check anchor: read (and require) the snapshot's manifest even though the
  // physical restore does not splice onto its bytes — see the module doc.
  const snapshotManifest = readSnapshotManifest(snapshotPath);

  const allSegments = readdirSync(walArchiveDir)
    .filter((f) => f.startsWith("seg-") && f.endsWith(".meta.json"))
    .map((f) => readJson<ArchivedSegmentMeta>(join(walArchiveDir, f)))
    .sort((a, b) => a.seq - b.seq);
  const toApply = allSegments.filter((s) => s.checkpointedAt <= t);

  removeDbFiles(destPath);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(base, destPath);

  // Replay each segment's WAL in order: copying it into place as `<destPath>-wal`
  // and simply OPENING the db triggers SQLite's own WAL-recovery-on-open, which
  // merges those frames in; we then checkpoint+close before laying the next one
  // down (each segment's WAL was captured relative to the state after the PRIOR
  // segment's checkpoint, so they must be applied strictly in order).
  for (const seg of toApply) {
    copyFileSync(join(walArchiveDir, seg.walFile), `${destPath}-wal`);
    const step = new DatabaseSync(destPath);
    try {
      step.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      step.close();
    }
  }

  // NOTE (Windows): a file cannot be deleted while a handle to it is open, so every
  // failure path below closes `restored` FIRST, then removes the half-restored
  // files, then throws — never the other order.
  const restored = new DatabaseSync(destPath);

  const integrityRows = restored.prepare("PRAGMA integrity_check").all() as Array<
    Record<string, unknown>
  >;
  const integrityOk =
    integrityRows.length === 1 && integrityRows[0]?.["integrity_check"] === "ok";
  const userVersion = readUserVersion(restored);

  if (!integrityOk) {
    restored.close();
    removeDbFiles(destPath);
    throw new Error(
      "restoreToTimestamp: PRAGMA integrity_check failed on the reconstructed " +
        "database — refusing to complete the restore.",
    );
  }

  if (userVersion !== snapshotManifest.userVersion) {
    restored.close();
    removeDbFiles(destPath);
    throw new Error(
      `restoreToTimestamp: reconstructed userVersion (${userVersion}) does not ` +
        `match the snapshot manifest's (${snapshotManifest.userVersion}) — the ` +
        `archive lineage and the snapshot disagree; refusing to complete the restore.`,
    );
  }

  // THE REFUSAL RULE (RestoreOptions.chainVerifier's doc): a restored db that carries
  // ANY ratification_records rows has an audit chain whose SEMANTIC integrity has not
  // yet been checked by anything above (integrity_check is structural only). Omitting
  // chainVerifier on such a db must throw here — never silently return success — and
  // the caller supplying one whose verification reports broken must throw too.
  const ledgerRowCount = ratificationRecordsRowCount(restored);
  if (opts?.chainVerifier === undefined) {
    if (ledgerRowCount > 0) {
      restored.close();
      removeDbFiles(destPath);
      throw new UnverifiedLedgerRestoreError(
        `the reconstructed database carries ${ledgerRowCount} ratification_records ` +
          `row(s) but no chainVerifier was supplied to verify its audit chain. Pass a ` +
          `RestoreOptions.chainVerifier (wrapping the ledger's own verifyChain()) so ` +
          `this restore can prove the chain it hands back.`,
      );
    }
  }

  let chainHead: ChainHeadLike | null = null;
  if (opts?.chainVerifier !== undefined) {
    const verification = opts.chainVerifier(restored);
    if (!verification.ok) {
      restored.close();
      removeDbFiles(destPath);
      throw new UnverifiedLedgerRestoreError(
        `audit chain verification failed at seq ${String(verification.firstBrokenSeq)}.`,
      );
    }
    chainHead = verification.chainHead;

    // chainHead-consistency: if the snapshot recorded a chainHead and predates
    // t, the restored chain must have reached at LEAST that seq (the snapshot's
    // history must be a prefix of the restored history).
    if (
      snapshotManifest.chainHead !== null &&
      snapshotManifest.createdAt <= t &&
      chainHead.seq < snapshotManifest.chainHead.seq
    ) {
      restored.close();
      removeDbFiles(destPath);
      throw new Error(
        `restoreToTimestamp: reconstructed chainHead (seq ${chainHead.seq}) is ` +
          `BEHIND the snapshot's recorded chainHead (seq ` +
          `${snapshotManifest.chainHead.seq}) even though the snapshot predates ` +
          `the restore target — the archive lineage is inconsistent with the ` +
          `snapshot; refusing to complete the restore.`,
      );
    }
  }

  restored.close();
  return {
    restoredPath: destPath,
    appliedSegments: toApply.length,
    userVersion,
    chainHead,
  };
}
