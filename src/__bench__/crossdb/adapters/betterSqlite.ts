/**
 * adapters/betterSqlite.ts — the `better-sqlite3` (native prebuilt) adapter.
 *
 * DUMB store, identical semantics to the node:sqlite adapter (MAJORITY value for an
 * (entity, attribute); ties → most-recent rowid). Present so the table shows a SECOND,
 * widely-used SQLite binding alongside the builtin; under the cheap-Sybil attack it too
 * returns the FALSE majority. footprintBytes reports the ON-DISK file size.
 *
 * better-sqlite3 ships no bundled TS types here, so it is loaded via a runtime require
 * and typed against a MINIMAL local interface (just the calls this adapter uses).
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { req, tempPath, fileFootprint, cleanupPath } from "../util.js";

interface BetterStmt {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterDb {
  pragma(s: string): unknown;
  exec(s: string): unknown;
  prepare(s: string): BetterStmt;
  close(): void;
}
type BetterCtor = new (path: string) => BetterDb;

const Database = req("better-sqlite3") as BetterCtor;

export function createBetterSqliteAdapter(): MemoryAdapter {
  let db: BetterDb | null = null;
  let path = "";
  let inTxn = false;
  let insert: BetterStmt | null = null;
  let select: BetterStmt | null = null;

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
    name: "better-sqlite3",

    setup(): void {
      path = tempPath("better-sqlite") + ".db";
      db = new Database(path);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec("CREATE TABLE facts (id INTEGER PRIMARY KEY, entity TEXT, attribute TEXT, value TEXT)");
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
