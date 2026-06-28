/**
 * adapters/duckdbStore.ts — the `@duckdb/node-api` (DuckDB) adapter.
 *
 * DUMB store with the same MAJORITY semantics as the SQL adapters, but DuckDB's
 * node-api is ASYNC-ONLY, so writes are BUFFERED synchronously and committed in one
 * batched `flush()` (chunked multi-row INSERTs + a CHECKPOINT to land the data on
 * disk). Recall is an async `GROUP BY value ORDER BY count` query. No provenance /
 * independence ⇒ the cheap-Sybil FALSE majority wins — the expected, honest baseline.
 * footprintBytes reports the ON-DISK database file size after the checkpoint.
 *
 * Loaded via runtime require + a minimal local interface so typecheck does not hard-
 * depend on the optional package's bundled types.
 */

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { req, tempPath, fileFootprint, cleanupPath } from "../util.js";

interface DuckConn {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRows(): unknown[][] }>;
  disconnectSync?(): void;
  closeSync?(): void;
}
interface DuckInstance {
  connect(): Promise<DuckConn>;
  closeSync?(): void;
}
interface DuckModule {
  DuckDBInstance: { create(path: string): Promise<DuckInstance> };
}

const duckdb = req("@duckdb/node-api") as DuckModule;

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

export function createDuckDbAdapter(): MemoryAdapter {
  let instance: DuckInstance | null = null;
  let conn: DuckConn | null = null;
  let path = "";
  let buffer: Fact[] = [];

  return {
    name: "duckdb (@duckdb/node-api)",

    async setup(): Promise<void> {
      path = tempPath("duckdb") + ".duckdb";
      instance = await duckdb.DuckDBInstance.create(path);
      conn = await instance.connect();
      await conn.run("CREATE TABLE facts (entity VARCHAR, attribute VARCHAR, value VARCHAR)");
    },

    writeFact(f: Fact): void {
      // Synchronous buffer; committed in flush (DuckDB's API is async-only, so per-fact
      // awaited inserts would not be a fair write-throughput measure).
      buffer.push(f);
    },

    async flush(): Promise<void> {
      if (buffer.length === 0) return;
      const rows = buffer;
      buffer = [];
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const vals = slice
          .map((f) => `('${esc(f.entity)}','${esc(f.attribute)}','${esc(f.value)}')`)
          .join(",");
        await conn!.run(`INSERT INTO facts VALUES ${vals}`);
      }
      await conn!.run("CHECKPOINT");
    },

    async recall(cue: Cue): Promise<RankedFact[]> {
      const reader = await conn!.runAndReadAll(
        `SELECT value, COUNT(*) c FROM facts WHERE entity = '${esc(cue.entity)}' ` +
          `AND attribute = '${esc(cue.attribute)}' GROUP BY value ORDER BY c DESC`,
      );
      return reader.getRows().map((r) => ({
        value: String(r[0]),
        score: Number(r[1]),
      }));
    },

    footprintBytes(): number {
      return fileFootprint(path);
    },

    async close(): Promise<void> {
      try {
        conn?.disconnectSync?.();
        conn?.closeSync?.();
        instance?.closeSync?.();
      } catch {
        /* best effort */
      }
      conn = null;
      instance = null;
      cleanupPath(path);
    },
  };
}
