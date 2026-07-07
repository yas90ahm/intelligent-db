/**
 * agentMemoryHandleLeak.test.ts — REGRESSION for `createAgentMemory({dbPath})`
 * leaking the shared `DatabaseSync` handle (and the OS-level file lock that comes
 * with it) when construction throws AFTER the handle has already opened
 * successfully (`PRODUCTION_READINESS_REASSESSMENT.md`'s durability-lane finding
 * #7, re-audit item 3).
 *
 * THE BUG: the facade's multi-step shared-handle recipe (open handle -> store ->
 * reputation ledger -> pending ledger) had no `try`/`catch` anywhere around it.
 * `store/sqliteStore.ts`'s OWNED-path `createSqliteStore(path)` factory has always
 * had `try { ... } catch (err) { handle.close(); throw err; }` around its own
 * construction — the facade's newer multi-step recipe never carried that
 * discipline forward, so a throw partway through (the realistic trigger: opening
 * a pre-existing db file stamped with a schema newer than this build knows,
 * `UnknownFutureSchemaError`) left the handle open and the file locked, with
 * nothing in the process ever able to release it short of exiting.
 *
 * THIS TEST forces exactly that: writes a real db file whose `user_version` is
 * one past `LATEST_SCHEMA_VERSION`, calls the REAL, unmodified
 * `createAgentMemory({ dbPath })` factory against it (never a hand-rolled rig),
 * confirms it throws `UnknownFutureSchemaError`, and then proves the handle was
 * actually released — a SECOND real open (and a real write) against the SAME file
 * succeeds immediately, with no lock contention.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentMemory,
  LATEST_SCHEMA_VERSION,
  UnknownFutureSchemaError,
} from "../index.js";

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
  const p = join(tmpdir(), `idb-handleleak-${tag}-${unique}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
  return p;
}

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSyncType;
};

describe("createAgentMemory({ dbPath }): does not leak the shared handle on a construction-time throw", () => {
  it("a mid-construction UnknownFutureSchemaError closes the handle — a second real open+write on the same file succeeds immediately", () => {
    const dbPath = freshPath("future-schema");

    // Plant a db file stamped one version PAST what this build knows — the exact
    // realistic trigger the re-audit reproduced live (a downgrade / rollback
    // scenario, or a db shared with a newer build).
    const seed = new DatabaseSync(dbPath);
    seed.exec(`PRAGMA user_version=${LATEST_SCHEMA_VERSION + 1}`);
    seed.close();

    // THE FAILING CONSTRUCTION: real, unmodified factory — no private internals
    // touched. Must throw the typed error, not silently succeed or hang.
    expect(() => createAgentMemory({ dbPath })).toThrow(UnknownFutureSchemaError);

    // THE ATOMICITY ASSERTION: the handle opened during that failed construction
    // must be closed — a fresh `DatabaseSync` against the SAME file must be able
    // to open AND WRITE immediately. Before the fix this hangs/throws on Windows
    // (EBUSY/EPERM) because the leaked handle still holds the file open; on POSIX
    // SQLite's advisory locking allows a second reader but a WRITE would still
    // contend with the leaked connection's open transaction/journal state.
    const second = new DatabaseSync(dbPath);
    cleanups.push(() => {
      try {
        second.close();
      } catch {
        /* already closed */
      }
    });
    expect(() => second.exec("PRAGMA user_version=0")).not.toThrow();
    second.close();

    // Belt-and-suspenders (mirrors the re-audit's own live repro): renaming the
    // file out from under a leaked handle fails with EBUSY/EPERM on Windows.
    // With the handle released, rename+cleanup succeeds without special handling.
    const renamedPath = `${dbPath}.renamed`;
    cleanups.push(() => {
      try {
        rmSync(renamedPath, { force: true });
      } catch {
        /* ignore */
      }
    });
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    expect(() => renameSync(dbPath, renamedPath)).not.toThrow();
  });

  it("repeated failed constructions against the SAME bad file never accumulate leaked handles (retry-without-restart shape)", () => {
    const dbPath = freshPath("future-schema-retry");
    const seed = new DatabaseSync(dbPath);
    seed.exec(`PRAGMA user_version=${LATEST_SCHEMA_VERSION + 1}`);
    seed.close();

    // The realistic "retry within the same process" shape the re-audit flagged
    // as the scenario that actually accumulates leaks: a supervisor/harness that
    // catches the construction error and retries WITHOUT a full process restart.
    for (let i = 0; i < 5; i++) {
      expect(() => createAgentMemory({ dbPath })).toThrow(UnknownFutureSchemaError);
    }

    // Even after 5 failed attempts, the file is still fully unlocked.
    const finalCheck = new DatabaseSync(dbPath);
    cleanups.push(() => {
      try {
        finalCheck.close();
      } catch {
        /* already closed */
      }
    });
    expect(() => finalCheck.exec("PRAGMA user_version=0")).not.toThrow();
    finalCheck.close();
  });

  it("does not regress the success path: a valid db still constructs and closes cleanly", () => {
    const dbPath = freshPath("valid");
    const memory = createAgentMemory({ dbPath });
    memory.remember({ text: "the handle-leak fix does not break normal construction" });
    memory.close();

    // Reopening after a clean close works exactly as before.
    const reopened = createAgentMemory({ dbPath });
    cleanups.push(() => {
      try {
        reopened.close();
      } catch {
        /* already closed */
      }
    });
    const { facts } = reopened.recall("handle-leak fix");
    expect(facts.length).toBeGreaterThan(0);
  });
});
