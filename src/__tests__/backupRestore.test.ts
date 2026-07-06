/**
 * backupRestore.test.ts — Phase 2 Durability spec §2: online snapshot (`VACUUM
 * INTO` + manifest), controlled WAL archiving, and `restoreToTimestamp`'s
 * chain-verification refusal rule.
 *
 * See `store/backup.ts`'s module doc for the disclosed design decision on why
 * `restoreToTimestamp` reconstructs from the WAL archive directory's own
 * `base.db` + segment chain rather than splicing WAL bytes onto the (page-
 * renumbering) `VACUUM INTO` snapshot — that choice is exercised implicitly by
 * every test below (`snapshotPath` is always passed and cross-checked, never
 * used as the physical restore base).
 *
 * A deterministic fake clock (`nowMs`, advanced by the test) drives every
 * `now()` callback (snapshot, archiver checkpoints) so `t` boundaries are exact,
 * never wall-clock-flaky.
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqliteStore,
  createSqliteReputationLedger,
  createSqlitePendingLedger,
  readSnapshotManifest,
  manifestPathFor,
  createWalArchiver,
  restoreToTimestamp,
  asStrandId,
  asEpochMs,
  FactState,
  FactOrigin,
  Tier,
} from "../index.js";
import type {
  EntityId,
  AttributeKey,
  ContentHash,
  ContradictionSetId,
  SourceId,
  Unit,
} from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

// --- temp dir lifecycle ------------------------------------------------------

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "idb-backup-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeStrand(i: number) {
  const now = asEpochMs(1_700_000_000_000 + i);
  return {
    id: asStrandId(`strand:fixture-${i}`),
    entity: `entity:acme` as EntityId,
    attribute: `attr-${i}` as AttributeKey,
    payload: { text: `fact number ${i}` },
    content_hash: `hash-${i}` as ContentHash,
    fact_state: FactState.LIVE,
    origin: FactOrigin.OBSERVED,
    tier: Tier.WARM,
    observedAt: now,
    provenance: {
      roots: [
        {
          rootId: `root:${i}`,
          sourceId: "source:owner" as SourceId,
          independenceClassId: "class:source:owner",
          establishedAt: now,
        },
      ],
    },
    salience: { s: 1, last_fire_time: now, fire_count: 0 },
    description_value: 1,
    external_reobservation_count: 0,
    refractory_until: asEpochMs(0),
    out_weight_sum: 0,
  };
}

describe("online snapshot (VACUUM INTO + manifest)", () => {
  it("produces a compact, consistent, standalone-restorable copy plus a fsynced manifest", () => {
    const dbPath = join(workDir, "live.db");
    const store = createSqliteStore(dbPath);
    for (let i = 0; i < 5; i++) store.putStrand(makeStrand(i) as never);

    const destPath = join(workDir, "snap.db");
    const manifest = store.snapshot(destPath);

    expect(existsSync(destPath)).toBe(true);
    expect(existsSync(manifestPathFor(destPath))).toBe(true);
    expect(manifest.userVersion).toBeGreaterThan(0);
    expect(manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.chainHead).toBeNull();

    // Standalone restorability: just open the snapshot file directly.
    const snapDb = new DatabaseSync(destPath);
    const rows = snapDb.prepare("SELECT COUNT(*) AS c FROM strands").get() as {
      c: number;
    };
    expect(rows.c).toBe(5);
    snapDb.close();

    // Manifest round-trips via the reader.
    const reread = readSnapshotManifest(destPath);
    expect(reread).toEqual(manifest);

    store.close();
  });

  it("carries the supplied chainHead through to the manifest", () => {
    const dbPath = join(workDir, "live2.db");
    const store = createSqliteStore(dbPath);
    store.putStrand(makeStrand(0) as never);
    const destPath = join(workDir, "snap2.db");
    const manifest = store.snapshot(destPath, { chainHead: { seq: 3, headHash: "abc123" } });
    expect(manifest.chainHead).toEqual({ seq: 3, headHash: "abc123" });
    store.close();
  });
});

describe("WAL archiving + point-in-time restore", () => {
  /**
   * Full end-to-end scenario mirroring the spec's test: write facts across N
   * checkpoints, snapshot mid-way, keep writing, restore to a timestamp between
   * two LATER checkpoints, assert exactly the facts written before `t` are
   * present and the chain verifies to its recorded head at `t`.
   */
  it("restores exactly the state as of a timestamp between two later checkpoints", () => {
    const dbPath = join(workDir, "live.db");
    const archiveDir = join(workDir, "archive");
    const snapshotPath = join(workDir, "snap.db");
    const restoredPath = join(workDir, "restored.db");

    let clockMs = 1_000_000;
    const now = (): number => clockMs;

    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    const store = createSqliteStore({ db: handle });
    const reputation = createSqliteReputationLedger((): Unit => 0.98 as Unit, {
      db: handle,
    });
    const ledger = createSqlitePendingLedger({ db: handle, reputation });
    const archiver = createWalArchiver(handle, { dir: archiveDir, now });

    function writeAndRecord(i: number): void {
      store.putStrand(makeStrand(i) as never);
      // A synthetic audit record per write so the checksum chain genuinely grows in
      // step with the strand data (exercising a REAL PendingLedger, not a stand-in).
      ledger.appendPending(
        {
          contradictionSetId: `cset:fixture-${i}` as ContradictionSetId,
          attribute: `attr-${i}` as AttributeKey,
          members: [asStrandId(`strand:fixture-${i}`)],
          reason: "INDEPENDENT_DISPUTE",
          createdAt: asEpochMs(clockMs),
        } as never,
        "source:owner" as SourceId,
      );
    }

    // --- checkpoints 1 and 2 --------------------------------------------------
    writeAndRecord(0);
    clockMs += 1000;
    const seg1 = archiver.checkpoint(ledger.chainHead());
    expect(seg1).not.toBeNull();
    const tAfterCheckpoint2Setup = clockMs;

    writeAndRecord(1);
    clockMs += 1000;
    const seg2 = archiver.checkpoint(ledger.chainHead());
    expect(seg2).not.toBeNull();

    // --- snapshot MID-WAY (after checkpoint 2) --------------------------------
    const snapshotChainHead = ledger.chainHead();
    store.snapshot(snapshotPath, { chainHead: snapshotChainHead, now });
    const tAfterSnapshot = clockMs;

    // --- keep writing: checkpoints 3 and 4 ------------------------------------
    writeAndRecord(2);
    clockMs += 1000;
    const seg3 = archiver.checkpoint(ledger.chainHead());
    expect(seg3).not.toBeNull();
    const chainHeadAtCheckpoint3 = ledger.chainHead();
    const tBetween3And4 = clockMs; // the restore target: after seg3, before seg4

    clockMs += 1000; // time passes with NOTHING written — proves "up to t" is exact
    writeAndRecord(3);
    clockMs += 1000;
    const seg4 = archiver.checkpoint(ledger.chainHead());
    expect(seg4).not.toBeNull();

    // Sanity: 4 strands exist in the LIVE db right now.
    expect([...store.allStrands()]).toHaveLength(4);

    archiver.close();
    store.close(); // no-op (shared handle) but exercise the call
    handle.close();

    // --- restore to a timestamp strictly between checkpoint 3 and checkpoint 4 --
    const result = restoreToTimestamp(
      snapshotPath,
      archiveDir,
      asEpochMs(tBetween3And4),
      restoredPath,
      {
        chainVerifier: (restoredDb) => {
          const restoredLedger = createSqlitePendingLedger({ db: restoredDb });
          const verification = restoredLedger.verifyChain();
          return {
            ok: verification.ok,
            firstBrokenSeq: verification.firstBrokenSeq,
            chainHead: restoredLedger.chainHead(),
          };
        },
      },
    );

    expect(result.appliedSegments).toBe(3); // seg1, seg2, seg3 (seg4 is AFTER t)
    expect(result.chainHead).toEqual(chainHeadAtCheckpoint3);

    const restoredHandle = new DatabaseSync(restoredPath);
    const restoredStrandIds = (
      restoredHandle.prepare("SELECT id FROM strands ORDER BY id").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    restoredHandle.close();

    // EXACTLY the facts written before t: fixtures 0, 1, 2 — never 3.
    expect(restoredStrandIds).toEqual([
      "strand:fixture-0",
      "strand:fixture-1",
      "strand:fixture-2",
    ]);

    // Sanity anchors used only to keep the intermediate `t` markers referenced
    // (documents the timeline; avoids unused-var lint noise without weakening
    // the assertions above).
    expect(tAfterCheckpoint2Setup).toBeLessThan(tAfterSnapshot);
    expect(tAfterSnapshot).toBeLessThanOrEqual(tBetween3And4);
  });

  it("REFUSES to complete (throws, cleans up) when the audit chain fails to verify", () => {
    const dbPath = join(workDir, "live.db");
    const archiveDir = join(workDir, "archive");
    const snapshotPath = join(workDir, "snap.db");
    const restoredPath = join(workDir, "restored.db");

    let clockMs = 2_000_000;
    const now = (): number => clockMs;

    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    const store = createSqliteStore({ db: handle });
    const reputation = createSqliteReputationLedger((): Unit => 0.98 as Unit, {
      db: handle,
    });
    const ledger = createSqlitePendingLedger({ db: handle, reputation });

    // Write BEFORE archiving activates, so the very first thing the archiver does
    // (capture `base.db`) already contains this record — giving the tamper step
    // below a genuine row to corrupt inside the archive's own base copy.
    store.putStrand(makeStrand(0) as never);
    ledger.appendPending(
      {
        contradictionSetId: "cset:fixture-0" as ContradictionSetId,
        attribute: "attr-0" as AttributeKey,
        members: [asStrandId("strand:fixture-0")],
        reason: "INDEPENDENT_DISPUTE",
        createdAt: asEpochMs(clockMs),
      } as never,
      "source:owner" as SourceId,
    );

    const archiver = createWalArchiver(handle, { dir: archiveDir, now });
    clockMs += 1000;

    store.snapshot(snapshotPath, { chainHead: ledger.chainHead(), now });
    clockMs += 1000;
    const tTarget = clockMs;

    archiver.close();
    handle.close();

    // Tamper with the archive's `base.db` (the archiver's own captured lineage
    // baseline) AFTER archiving — simulating at-rest corruption of the archived
    // copy itself — a substituted JSON payload string in the audit record.
    const baseDbPath = join(archiveDir, "base.db");
    const baseHandle = new DatabaseSync(baseDbPath);
    const row = baseHandle
      .prepare("SELECT seq, json FROM ratification_records ORDER BY seq LIMIT 1")
      .get() as { seq: number; json: string };
    const tampered = row.json.replace("INDEPENDENT_DISPUTE", "TAMPERED_REASON!!");
    baseHandle
      .prepare("UPDATE ratification_records SET json = ? WHERE seq = ?")
      .run(tampered, row.seq);
    baseHandle.close();

    expect(() =>
      restoreToTimestamp(snapshotPath, archiveDir, asEpochMs(tTarget), restoredPath, {
        chainVerifier: (restoredDb) => {
          const restoredLedger = createSqlitePendingLedger({ db: restoredDb });
          const verification = restoredLedger.verifyChain();
          return {
            ok: verification.ok,
            firstBrokenSeq: verification.firstBrokenSeq,
            chainHead: restoredLedger.chainHead(),
          };
        },
      }),
    ).toThrow(/audit chain verification failed/);

    // REFUSAL cleans up: no half-restored file left behind.
    expect(existsSync(restoredPath)).toBe(false);
    expect(existsSync(`${restoredPath}-wal`)).toBe(false);
  });

  it("throws if there is no WAL archive base to restore from", () => {
    const emptyDir = join(workDir, "never-archived");
    writeFileSync(join(workDir, "placeholder.txt"), "x"); // ensure workDir exists/used
    expect(() =>
      restoreToTimestamp(
        join(workDir, "nonexistent-snap.db"),
        emptyDir,
        asEpochMs(Date.now()),
        join(workDir, "out.db"),
      ),
    ).toThrow(/no WAL archive base found/);
  });

  it("createWalArchiver throws on an in-memory (':memory:') database (no WAL file to archive)", () => {
    const mem = new DatabaseSync(":memory:");
    expect(() => createWalArchiver(mem, { dir: join(workDir, "archive-mem") })).toThrow(
      /no on-disk location/,
    );
    mem.close();
  });

  it("checkpoint() is a no-op (returns null, no segment file) when the live WAL is empty", () => {
    const dbPath = join(workDir, "live-empty.db");
    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    const archiveDir = join(workDir, "archive-empty");
    const archiver = createWalArchiver(handle, { dir: archiveDir });
    // Immediately after activation (base.db just created, checkpointed), nothing
    // pending yet.
    const seg = archiver.checkpoint();
    expect(seg).toBeNull();
    expect(archiver.listSegments()).toHaveLength(0);
    archiver.close();
    handle.close();
  });
});
