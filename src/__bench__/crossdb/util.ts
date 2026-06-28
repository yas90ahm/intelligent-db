/**
 * util.ts — tiny shared helpers for the cross-DB adapters: a CJS/builtin loader (so we
 * can require native modules without static-importing types that may be absent) and
 * temp-file plumbing for the file-backed engines.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`. `createRequire` lets the
 * ESM bench modules pull in CJS native addons (better-sqlite3, lmdb, @duckdb/node-api)
 * and the `node:sqlite` builtin at runtime, exactly as the engine's SQLite store does.
 */

import { createRequire } from "node:module";
import { rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A runtime `require` rooted at this module (resolves the worktree's node_modules). */
export const req = createRequire(import.meta.url);

/** A unique temp path for a file-backed store (no wall-clock logic depends on this). */
export function tempPath(tag: string): string {
  return join(tmpdir(), `idb-crossdb-${tag}-${process.pid}-${counter()}`);
}

let _c = 0;
function counter(): number {
  return _c++;
}

/** Sum the on-disk size of `path` and its sidecar files (WAL/SHM/journal). */
export function fileFootprint(path: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal", ".wal", ".shm"]) {
    const p = path + suffix;
    if (existsSync(p)) {
      try {
        total += statSync(p).size;
      } catch {
        /* best effort */
      }
    }
  }
  return total;
}

/** Best-effort recursive delete of a store path and its sidecars. */
export function cleanupPath(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal", ".wal", ".shm"]) {
    try {
      rmSync(path + suffix, { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
}
