/**
 * migrations.test.ts — Phase 2 Durability spec §1: the `PRAGMA user_version`
 * schema migration ladder.
 *
 * Covers:
 *  1. A fresh db is stamped at `LATEST_SCHEMA_VERSION` at creation.
 *  2. Opening the checked-in v1 FIXTURE (`fixtures/v1-legacy.db` — a real
 *     pre-ladder database, `user_version` at SQLite's own default 0, two
 *     strands + an edge + a reputation row + one genuine hash-chained audit
 *     record) with CURRENT code runs the ladder exactly once, brings the db to
 *     `LATEST_SCHEMA_VERSION`, and leaves every byte of pre-existing data
 *     intact — including the audit chain, which still verifies.
 *  3. Reopening the now-migrated db is idempotent (no error, no re-migration,
 *     `user_version` unchanged).
 *  4. `runMigrations` REFUSES to open (throws `UnknownFutureSchemaError`) a db
 *     whose `user_version` is newer than this build's latest known migration.
 *  5. `MIGRATIONS` is asserted ascending at module load (defensive; exercised
 *     indirectly by every other test in this file importing the module).
 */

import { createRequire } from "node:module";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readUserVersion,
  runMigrations,
  UnknownFutureSchemaError,
  createSqliteStore,
  createSqlitePendingLedger,
} from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(__dirname, "fixtures", "v1-legacy.db");

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-migrations-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

function trackClose(fn: () => void): void {
  closers.push(() => {
    try {
      fn();
    } catch {
      // already closed
    }
  });
}

beforeEach(() => {
  paths = [];
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const base of paths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

describe("schema migration ladder", () => {
  it("MIGRATIONS is non-empty and LATEST_SCHEMA_VERSION is its max 'to'", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    const maxTo = MIGRATIONS.reduce((m, mig) => Math.max(m, mig.to), 0);
    expect(LATEST_SCHEMA_VERSION).toBe(maxTo);
  });

  it("stamps a fresh database at LATEST_SCHEMA_VERSION at creation", () => {
    const p = freshPath("fresh");
    const store = createSqliteStore(p);
    trackClose(() => store.close());

    const raw = new DatabaseSync(p);
    trackClose(() => raw.close());
    expect(readUserVersion(raw)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("brings the checked-in v1 fixture forward, data intact, audit chain verifies", () => {
    const p = freshPath("v1fixture");
    expect(existsSync(FIXTURE_SRC)).toBe(true);
    copyFileSync(FIXTURE_SRC, p);

    // Sanity: the fixture predates the ladder entirely (SQLite's own default).
    const preCheck = new DatabaseSync(p);
    expect(readUserVersion(preCheck)).toBe(0);
    const preStrandCount = (
      preCheck.prepare("SELECT COUNT(*) AS c FROM strands").get() as { c: number }
    ).c;
    expect(preStrandCount).toBe(2);
    preCheck.close();

    // Open with CURRENT code (the strand store's constructor runs the ladder).
    const store = createSqliteStore(p);
    trackClose(() => store.close());

    const raw = new DatabaseSync(p);
    trackClose(() => raw.close());
    expect(readUserVersion(raw)).toBe(LATEST_SCHEMA_VERSION);

    // Data intact: both fixture strands, the edge, and the reputation row.
    const strands = [...store.allStrands()];
    expect(strands.map((s) => s.id).sort()).toEqual([
      "strand:fixture-1",
      "strand:fixture-2",
    ]);
    const fixtureStrand1 = strands.find((s) => s.id === "strand:fixture-1");
    expect(fixtureStrand1?.entity).toBe("entity:acme-corp");
    expect(fixtureStrand1?.attribute).toBe("hq_city");

    const edges = [...store.allEdges()];
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe("edge:fixture-1");

    const repRow = raw
      .prepare("SELECT json FROM reputation WHERE source_id = ?")
      .get("source:fixture-owner") as { json: string } | undefined;
    expect(repRow).toBeDefined();

    // The audit chain that shipped in the fixture still verifies after migration —
    // the ladder must never touch existing ratification_records rows.
    const ledger = createSqlitePendingLedger({ db: raw });
    const verification = ledger.verifyChain();
    expect(verification.ok).toBe(true);
    expect(verification.firstBrokenSeq).toBeNull();
    expect(ledger.chainHead().seq).toBe(0);
  });

  it("reopen after migration is idempotent (no re-migration, version unchanged)", () => {
    const p = freshPath("idempotent");
    copyFileSync(FIXTURE_SRC, p);

    const store1 = createSqliteStore(p);
    store1.close();

    const raw1 = new DatabaseSync(p);
    const versionAfterFirstOpen = readUserVersion(raw1);
    raw1.close();
    expect(versionAfterFirstOpen).toBe(LATEST_SCHEMA_VERSION);

    // Reopen: should be a clean no-op ladder run (no throw, version unchanged).
    const store2 = createSqliteStore(p);
    trackClose(() => store2.close());
    const raw2 = new DatabaseSync(p);
    trackClose(() => raw2.close());
    expect(readUserVersion(raw2)).toBe(LATEST_SCHEMA_VERSION);

    // Data still intact after the second open.
    const strands = [...store2.allStrands()];
    expect(strands).toHaveLength(2);
  });

  it("refuses to open a database whose user_version is newer than known", () => {
    const p = freshPath("future");
    const raw = new DatabaseSync(p);
    trackClose(() => raw.close());
    raw.exec(`PRAGMA user_version=${LATEST_SCHEMA_VERSION + 1}`);

    expect(() => runMigrations(raw)).toThrow(UnknownFutureSchemaError);
    try {
      runMigrations(raw);
      expect.unreachable("expected runMigrations to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFutureSchemaError);
      const typed = err as UnknownFutureSchemaError;
      expect(typed.foundVersion).toBe(LATEST_SCHEMA_VERSION + 1);
      expect(typed.latestKnownVersion).toBe(LATEST_SCHEMA_VERSION);
    }

    // The refusal must not have stamped/altered the version.
    expect(readUserVersion(raw)).toBe(LATEST_SCHEMA_VERSION + 1);
  });

  it("createSqliteStore itself refuses a future-versioned db (fail-closed at the real call site)", () => {
    const p = freshPath("future-storeopen");
    const raw = new DatabaseSync(p);
    raw.exec(`PRAGMA user_version=${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => {
      const store = createSqliteStore(p);
      trackClose(() => store.close());
    }).toThrow(UnknownFutureSchemaError);
  });
});
