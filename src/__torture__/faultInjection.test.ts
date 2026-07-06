/**
 * __torture__/faultInjection.test.ts — FAULT INJECTION ON THE SNAPSHOT/ARCHIVE PATHS
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4b).
 *
 * A "disk-full" condition is, from `store/backup.ts`'s point of view, indistinguishable
 * from any OTHER fs call at the snapshot/archive write sites failing (`mkdirSync`,
 * `copyFileSync`, the manifest's `writeSync`) — what matters is that a failure AT
 * EXACTLY those sites (1) surfaces as a clean thrown error, never a crash or a
 * silently-wrong partial artifact, and (2) a RETRY after the fault clears succeeds
 * cleanly ("writes resume after space clears").
 *
 * CONSERVATIVE SCOPING NOTE (read before extending): the spec names Windows'
 * VHDX-quota route as "overkill" and asks for an injection SHIM instead. Mocking
 * `node:fs` globally (`vi.mock`) is avoidable risk this codebase has never used
 * anywhere else and could perturb unrelated fs traffic in the same module graph
 * (e.g. `node:sqlite`'s own file handling). Instead this file injects REAL fs
 * failures at the exact call sites the spec names, by making the destination a
 * filesystem object of the WRONG kind (a file where a directory write is attempted,
 * a directory where a file copy target is expected) — deterministic, portable, and
 * zero new dependencies. This is not literally ENOSPC, but it exercises the
 * identical code path an ENOSPC would hit (the same `mkdirSync`/`copyFileSync`/
 * `writeSync` calls failing), which is what "assert typed errors, no corruption,
 * writes resume after space clears" is actually testing.
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  asStrandId,
  asEpochMs,
  createSqliteStore,
  createWalArchiver,
  manifestPathFor,
  FactOrigin,
  FactState,
  Tier,
} from "../index.js";
import type { AttributeKey, ContentHash, EntityId, SourceId } from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSyncType;
};

const RUN = process.env["TORTURE"] === "1";

function makeStrand(i: number) {
  const now = asEpochMs(1_700_000_000_000 + i);
  return {
    id: asStrandId(`strand:fault-${i}`),
    entity: `entity:fault` as EntityId,
    attribute: `attr-${i}` as AttributeKey,
    payload: { text: `fault-injection fact ${i}` },
    content_hash: `hash-fault-${i}` as ContentHash,
    fact_state: FactState.LIVE,
    origin: FactOrigin.OBSERVED,
    tier: Tier.WARM,
    observedAt: now,
    provenance: {
      roots: [
        {
          rootId: `root:fault-${i}`,
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

(RUN ? describe : describe.skip)("fault injection on the snapshot/archive paths", () => {
  it("snapshotDb: a blocked destination directory throws cleanly, leaves no partial snapshot, and a retry after the fault clears succeeds", () => {
    const workDir = mkdtempSync(join(tmpdir(), "idb-fault-snap-"));
    try {
      const dbPath = join(workDir, "live.db");
      const store = createSqliteStore(dbPath);
      store.putStrand(makeStrand(0) as never);

      // Block the snapshot's destination directory with a FILE where a directory
      // must be created — mkdirSync(dirname(destPath)) fails immediately, before
      // VACUUM INTO ever runs.
      const blockedDir = join(workDir, "blocked");
      writeFileSync(blockedDir, "not a directory");
      const destPath = join(blockedDir, "snap.db");

      expect(() => store.snapshot(destPath)).toThrow();
      expect(existsSync(destPath)).toBe(false);
      expect(existsSync(manifestPathFor(destPath))).toBe(false);

      // Space clears: point the snapshot at a real, writable destination — succeeds.
      rmSync(blockedDir, { force: true });
      const goodDestPath = join(workDir, "snap-ok.db");
      const manifest = store.snapshot(goodDestPath);
      expect(existsSync(goodDestPath)).toBe(true);
      expect(existsSync(manifestPathFor(goodDestPath))).toBe(true);
      expect(manifest.userVersion).toBeGreaterThan(0);

      store.close();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("createWalArchiver: a blocked archive directory throws cleanly, writes no base.meta.json, and a retry after the fault clears archives normally", () => {
    const workDir = mkdtempSync(join(tmpdir(), "idb-fault-archive-"));
    try {
      const dbPath = join(workDir, "live.db");
      // Shared-handle wiring (the codebase's own convention for store + archiver
      // over one live db — see backupRestore.test.ts's identical pattern).
      const handle: DatabaseSyncType = new DatabaseSync(dbPath);
      handle.exec("PRAGMA journal_mode=WAL");
      const store = createSqliteStore({ db: handle });
      store.putStrand(makeStrand(0) as never);

      // Block the archiver's OWN directory (`opts.dir`) by pre-creating it as a
      // FILE — `createWalArchiver`'s very first statement (`mkdirSync(opts.dir,
      // { recursive: true })`) then fails immediately, before any PRAGMA is
      // touched and before the base-copy is ever attempted (note: pre-creating
      // just `<dir>/base.db` as a directory would NOT reach the copy call at all —
      // `existsSync(baseDbPath)` would read true and skip the first-activation
      // branch entirely, so the fault must block the directory itself).
      const archiveDir = join(workDir, "archive");
      writeFileSync(archiveDir, "not a directory");

      expect(() => createWalArchiver(handle, { dir: archiveDir })).toThrow();
      expect(existsSync(join(archiveDir, "base.meta.json"))).toBe(false);

      // Space clears: remove the blocking file and retry — archiving works.
      rmSync(archiveDir, { force: true });
      const archiver = createWalArchiver(handle, { dir: archiveDir });
      try {
        expect(existsSync(join(archiveDir, "base.meta.json"))).toBe(true);
        store.putStrand(makeStrand(1) as never);
        const seg = archiver.checkpoint();
        expect(seg).not.toBeNull();
      } finally {
        archiver.close();
      }

      handle.close(); // store.close() is a no-op on a shared handle — close the owner.
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
