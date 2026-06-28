/**
 * adapters/nodeSqlite.ts — the BUILT-IN `node:sqlite` (DatabaseSync) adapter.
 *
 * DUMB store: it records every asserted fact in a table and recalls the (entity,
 * attribute) answer by MAJORITY value (most asserted copies; ties broken by most-recent
 * rowid). It has NO provenance/independence model, so under the cheap-Sybil attack it
 * returns the FALSE majority once the fleet out-copies the truth — the expected, honest
 * baseline. footprintBytes reports the ON-DISK file size (data + WAL).
 *
 * The value is loaded with a runtime `require("node:sqlite")` exactly as the engine's
 * own SQLite store does (the builtin is newer than the static typing surface).
 */

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { req, tempPath, fileFootprint, cleanupPath } from "../util.js";

const { DatabaseSync } = req("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

export function createNodeSqliteAdapter(): MemoryAdapter {
  let db: DatabaseSyncType | null = null;
  let path = "";
  let inTxn = false;
  let insert: ReturnType<DatabaseSyncType["prepare"]> | null = null;
  let select: ReturnType<DatabaseSyncType["prepare"]> | null = null;

  function begin(): void {
    if (!inTxn && db !== null) {
      db.exec("BEGIN");
      inTxn = true;
    }
  }
  function commit(): void {
    if (inTxn && db !== null) {
      db.exec("COMMIT");
      inTxn = false;
    }
  }

  return {
    name: "node:sqlite (builtin)",

    setup(): void {
      path = tempPath("node-sqlite") + ".db";
      db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec(
        "CREATE TABLE facts (id INTEGER PRIMARY KEY, entity TEXT, attribute TEXT, value TEXT)",
      );
      db.exec("CREATE INDEX idx_ea ON facts(entity, attribute)");
      insert = db.prepare("INSERT INTO facts(entity, attribute, value) VALUES (?, ?, ?)");
      select = db.prepare(
        "SELECT value, COUNT(*) c, MAX(id) latest FROM facts WHERE entity = ? AND attribute = ? " +
          "GROUP BY value ORDER BY c DESC, latest DESC",
      );
    },

    writeFact(f: Fact): void {
      begin();
      insert!.run(f.entity, f.attribute, f.value);
    },

    flush(): void {
      // Commit so the on-disk footprint reflects the data, then reopen a txn for any
      // later (poison-trial) writes. Reads on this same handle see uncommitted rows too.
      commit();
    },

    recall(cue: Cue): RankedFact[] {
      const rows = select!.all(cue.entity, cue.attribute) as Array<{ value: string; c: number }>;
      return rows.map((r) => ({ value: r.value, score: r.c }));
    },

    footprintBytes(): number {
      return fileFootprint(path);
    },

    close(): void {
      commit();
      if (db !== null) {
        db.close();
        db = null;
      }
      cleanupPath(path);
    },
  };
}
