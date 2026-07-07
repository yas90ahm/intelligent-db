/**
 * migrationsRollback.test.ts — regression for `migration-rollback-untested`
 * (HIGH, `audit-test-quality-verified.md` finding #3).
 *
 * THE GAP: `store/migrations.ts`'s own doc (and `runMigrations`'s doc comment)
 * documents a crash-safety guarantee: "a crash mid-ladder rolls back to the
 * ORIGINAL (unstamped) version, safely retryable next open," implemented via
 * `BEGIN` / `try { ...; COMMIT } catch { ROLLBACK; throw }` around the whole
 * pending-migration batch. `src/__tests__/migrations.test.ts` exercises the
 * happy path (fresh db, the checked-in v1 fixture, idempotent reopen, and the
 * future-schema refusal) but never constructs a ladder where a LATER rung
 * throws — so the rollback branch itself had ZERO coverage. A regression that
 * deleted the `try`/`catch`/`ROLLBACK` entirely (running every migration
 * autocommitted) would not have failed a single test.
 *
 * THE FIX (this file): `runMigrations` already accepts an optional `migrations`
 * parameter (`runMigrations(db, migrations = MIGRATIONS)`) specifically so a
 * caller/tester can supply a synthetic ladder — no source change was needed to
 * make this testable. This file builds a synthetic `Migration[]` whose SECOND
 * rung throws partway through its own `up()` (after creating a table, before
 * finishing), and asserts the REAL `runMigrations` (not a reimplementation)
 * rolls back the WHOLE batch: `user_version` is unchanged, and NEITHER the
 * first rung's table NOR the second rung's partial work survives — proving the
 * transaction genuinely wraps every pending rung as one unit, not just the
 * version stamp.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  readUserVersion,
  runMigrations,
  type Migration,
} from "./migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-migrations-rollback-${tag}-${unique}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(p + suffix, { force: true });
    }
  });
  return p;
}

function tableExists(db: DatabaseSyncType, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

describe("schema migration ladder — mid-run rollback (migration-rollback-untested)", () => {
  it("a throw on the 2nd of 3 rungs rolls back the WHOLE batch: user_version unchanged, no partial table from EITHER rung", () => {
    const p = freshPath("mid-throw");
    const db = new DatabaseSync(p);
    cleanups.push(() => db.close());

    const synthetic: Migration[] = [
      {
        to: 1,
        up: (h) => {
          h.exec("CREATE TABLE rung_one (id INTEGER PRIMARY KEY)");
        },
      },
      {
        to: 2,
        up: (h) => {
          // Partial work BEFORE the throw: proves the rollback undoes work the
          // failing rung itself already did, not just the rungs before it.
          h.exec("CREATE TABLE rung_two_partial (id INTEGER PRIMARY KEY)");
          throw new Error("INJECTED failure mid-ladder (rung 2 of 3)");
        },
      },
      {
        to: 3,
        up: (h) => {
          h.exec("CREATE TABLE rung_three (id INTEGER PRIMARY KEY)");
        },
      },
    ];

    expect(readUserVersion(db)).toBe(0);

    expect(() => runMigrations(db, synthetic)).toThrow(
      /INJECTED failure mid-ladder/,
    );

    // 1) user_version must be UNCHANGED (the ladder stamps only after every
    //    pending up() returns; a crash/throw mid-ladder never stamps a version
    //    the db does not actually hold).
    expect(readUserVersion(db)).toBe(0);

    // 2) NO partial table from ANY rung survives — not rung 1 (which committed
    //    cleanly before the throw), not rung 2's OWN partial DDL (issued before
    //    its throw), and rung 3 never ran at all.
    expect(tableExists(db, "rung_one")).toBe(false);
    expect(tableExists(db, "rung_two_partial")).toBe(false);
    expect(tableExists(db, "rung_three")).toBe(false);
  });

  it("is safely retryable next open: a clean ladder (no injected throw) against the SAME db now succeeds fully", () => {
    const p = freshPath("retry-after-rollback");
    const db = new DatabaseSync(p);
    cleanups.push(() => db.close());

    let attempt = 0;
    const flaky: Migration[] = [
      {
        to: 1,
        up: (h) => {
          h.exec("CREATE TABLE rung_one (id INTEGER PRIMARY KEY)");
        },
      },
      {
        to: 2,
        up: (h) => {
          attempt++;
          if (attempt === 1) {
            throw new Error("INJECTED failure, first attempt only");
          }
          h.exec("CREATE TABLE rung_two (id INTEGER PRIMARY KEY)");
        },
      },
    ];

    expect(() => runMigrations(db, flaky)).toThrow(/INJECTED failure/);
    expect(readUserVersion(db)).toBe(0);
    expect(tableExists(db, "rung_one")).toBe(false);

    // Retry with the SAME ladder (now on its 2nd invocation of rung 2's up(),
    // which no longer throws) — the documented "safely retryable next open"
    // guarantee.
    expect(() => runMigrations(db, flaky)).not.toThrow();
    expect(readUserVersion(db)).toBe(2);
    expect(tableExists(db, "rung_one")).toBe(true);
    expect(tableExists(db, "rung_two")).toBe(true);
  });

  it("a throw on the ONLY pending rung (fresh db, single-migration ladder) also rolls back cleanly", () => {
    const p = freshPath("single-rung-throw");
    const db = new DatabaseSync(p);
    cleanups.push(() => db.close());

    const single: Migration[] = [
      {
        to: 1,
        up: (h) => {
          h.exec("CREATE TABLE only_rung (id INTEGER PRIMARY KEY)");
          throw new Error("INJECTED failure, only rung");
        },
      },
    ];

    expect(() => runMigrations(db, single)).toThrow(/INJECTED failure, only rung/);
    expect(readUserVersion(db)).toBe(0);
    expect(tableExists(db, "only_rung")).toBe(false);
  });
});
