/**
 * store/sharedSqliteHandle.ts — ONE-OWNER COMPOSITION HELPER for the
 * "facts + trust + audit ride one DatabaseSync" shared-handle recipe
 * documented in `sqliteStore.ts`'s module doc and CLAUDE.md's durability
 * pillar.
 *
 * THE FOOTGUN THIS CLOSES (`shared-handle-close-footgun`, Wave 3 polish):
 * `SqliteStrandStore.close()`, the reputation ledger's `close()`, and the
 * pending ledger's `close()` are each a documented NO-OP when the handle they
 * were constructed against was BORROWED (the `{ db }` overload) rather than
 * OWNED (a plain path) — see each backend's own `ownsDb` guard. That is the
 * correct contract (only the single owner of a handle three subsystems are
 * riding may close it), but it is also a footgun: a caller composing the
 * shared-handle recipe by hand sees THREE objects each offering a `close()`
 * method and nothing structurally stops them from believing calling any (or
 * all) of them releases the resource, when in fact none of the three do —
 * the raw `DatabaseSync` handle itself is the one thing that needs closing,
 * and it needs closing exactly once, by whoever opened it.
 *
 * {@link createSharedSqliteHandle} makes that ownership explicit: it opens
 * (and WAL-verifies, mirroring `createSqliteStore`'s owned-path branch) the
 * handle here, hands out `{ db }` for as many borrowing constructors as the
 * caller likes, and exposes exactly ONE obvious way to release it —
 * `closeAll()`. `closeAll()` is idempotent (a second call is a no-op), so
 * teardown code calling it from more than one path (e.g. a `SIGINT` handler
 * racing a normal `close()`) never double-closes the underlying handle.
 *
 * This module does NOT change the borrowed-handle `close()` contract on the
 * store/ledger backends — a borrower must still never close someone else's
 * handle. It only gives the OWNER side of the recipe a named, tested
 * composition point instead of the same few lines of ad hoc
 * `new DatabaseSync(path)` + `PRAGMA journal_mode=WAL` + `db.close()`
 * duplicated at every call site that wires the recipe (see
 * `agent/agentMemory.ts`'s default facade, the first caller migrated to this
 * helper).
 *
 * ZERO new runtime deps: `node:sqlite`, loaded via the same runtime-`require`
 * indirection `sqliteStore.ts` uses and for the identical reason (a static
 * `import "node:sqlite"` trips bundler/test-transformer dependency scanners
 * that don't yet know this Node 24+ built-in — see that module's doc) — still
 * Node stdlib, resolved by Node's own loader exactly as in production.
 */

import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { assertOwnedWal } from "./sqliteStore.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/**
 * A single OWNED `DatabaseSync` handle, opened and WAL-verified, meant to be
 * BORROWED by the store + reputation ledger + pending ledger's `{ db }`
 * overloads (each of those remains a documented no-op on `close()` when
 * constructed against `db` here — see this module's doc).
 */
export interface SharedSqliteHandle {
  /** Pass `{ db }` to as many shared-handle store/ledger constructors as needed. */
  readonly db: DatabaseSyncType;
  /**
   * Close the underlying handle. Idempotent — a second (or Nth) call is a
   * no-op, so multiple teardown paths (normal shutdown racing a signal
   * handler, a test's `afterEach` racing an explicit close in the test body)
   * can each call this without double-closing. This is the ONLY `close` in
   * the shared-handle recipe that actually does anything; every borrower's
   * own `close()` stays a documented no-op against this handle.
   */
  closeAll(): void;
}

/**
 * Open and OWN a fresh `DatabaseSync` handle at `path`, set + verify WAL mode
 * took (the durability floor every borrowing constructor's shared-handle
 * overload requires already be in place — see `sqliteStore.ts`'s
 * `assertSharedHandleWal`), and return a {@link SharedSqliteHandle} whose
 * `closeAll()` is the one obvious way to release it. Throws (and closes the
 * just-opened handle before propagating) if WAL verification fails — the
 * identical fail-closed discipline `createSqliteStore`'s owned-path branch
 * already applies.
 *
 * @example
 *   const handle = createSharedSqliteHandle("/var/lib/idb/web.db");
 *   const store  = createSqliteStore({ db: handle.db });
 *   const rep    = createSqliteReputationLedger(repCapOf, { db: handle.db });
 *   const ledger = createSqlitePendingLedger({ db: handle.db, reputation: rep });
 *   // ... use store/rep/ledger; store.close()/rep.close()/ledger.close() are
 *   // documented no-ops here (borrowed) — only this releases the file handle:
 *   handle.closeAll();
 */
export function createSharedSqliteHandle(path: string): SharedSqliteHandle {
  const db = new DatabaseSync(path);
  try {
    // OWNED path: set + verify WAL took (mirrors createSqliteStore's owned
    // branch exactly). A BORROWER of this handle must never re-issue this
    // pragma (see assertSharedHandleWal's doc — a borrower only verifies);
    // the OWNER must, exactly once, here.
    assertOwnedWal(db, "createSharedSqliteHandle");
  } catch (err) {
    db.close();
    throw err;
  }
  let closed = false;
  return {
    db,
    closeAll(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
