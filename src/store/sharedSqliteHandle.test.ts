/**
 * sharedSqliteHandle.test.ts — proves `createSharedSqliteHandle`'s composition
 * contract for the shared-handle recipe (`shared-handle-close-footgun`, Wave 3
 * polish): `closeAll()` ACTUALLY closes the underlying handle, while a
 * BORROWING store/ledger's own `close()` against that same handle is a proven
 * no-op (the footgun this helper exists to make hard to hit — see the
 * module's doc).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteStore, type SqliteStrandStore } from "./sqliteStore.js";
import { createSharedSqliteHandle, type SharedSqliteHandle } from "./sharedSqliteHandle.js";
import { createSqliteReputationLedger } from "../identity/reputation.js";
import { createSqlitePendingLedger } from "../ratification/pendingLedger.js";
import {
  asEpochMs,
  FactOrigin,
  FactState,
  Tier,
  type ContentHash,
  type EntityId,
  type Strand,
  type StrandId,
} from "../core/types.js";
import type { SourceId, Unit } from "../core/types.js";

let dbPath: string;
let handle: SharedSqliteHandle | null;

beforeEach(() => {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbPath = join(tmpdir(), `idb-shared-handle-${unique}.db`);
  handle = null;
});

afterEach(() => {
  try {
    handle?.closeAll();
  } catch {
    // already closed by the test
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(dbPath + suffix, { force: true });
  }
});

function makeStrand(id: string): Strand {
  return {
    id: id as StrandId,
    entity: "entity:e1" as EntityId,
    attribute: null,
    payload: { text: id },
    content_hash: `hash:${id}` as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: asEpochMs(0), lambda: 0.1, fire_count: 0 },
    description_value: 0,
    observedAt: asEpochMs(0),
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}

describe("createSharedSqliteHandle", () => {
  it("opens a WAL-mode handle usable by borrowing store/ledger constructors", () => {
    handle = createSharedSqliteHandle(dbPath);
    const store = createSqliteStore({ db: handle.db });
    store.putStrand(makeStrand("s1"));
    expect(store.getStrand("s1" as StrandId)?.id).toBe("s1");

    const row = handle.db.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
    expect(String(row["journal_mode"]).toLowerCase()).toBe("wal");
  });

  it("a BORROWED store's close() is a proven no-op: the handle keeps working after it", () => {
    handle = createSharedSqliteHandle(dbPath);
    const store: SqliteStrandStore = createSqliteStore({ db: handle.db });
    store.putStrand(makeStrand("s1"));

    store.close(); // documented no-op for a borrowed handle

    // The underlying handle is still open: further use succeeds (a real close
    // would make this throw "database is not open" — see the closeAll() test).
    expect(() => handle!.db.prepare("PRAGMA journal_mode").get()).not.toThrow();
    // The store itself still works post-"close" too — proof this really was a no-op.
    expect(store.getStrand("s1" as StrandId)?.id).toBe("s1");
  });

  it("closeAll() actually closes the handle: further use throws", () => {
    handle = createSharedSqliteHandle(dbPath);
    const store = createSqliteStore({ db: handle.db });
    store.putStrand(makeStrand("s1"));

    handle.closeAll();

    expect(() => handle!.db.prepare("PRAGMA journal_mode").get()).toThrow(
      /database is not open/i,
    );
  });

  it("closeAll() is idempotent: a second call does not throw", () => {
    handle = createSharedSqliteHandle(dbPath);
    handle.closeAll();
    expect(() => handle!.closeAll()).not.toThrow();
  });

  it("three borrowers (store + reputation ledger + pending ledger) share one handle; only closeAll() releases it", () => {
    handle = createSharedSqliteHandle(dbPath);
    const store = createSqliteStore({ db: handle.db });
    const repCapOf = (_s: SourceId): Unit => 1 as Unit;
    const reputation = createSqliteReputationLedger(repCapOf, { db: handle.db });
    const ledger = createSqlitePendingLedger({ db: handle.db, reputation });

    // Every borrower's own close() is a no-op: none of them touch the shared handle.
    store.close();
    reputation.close();
    ledger.close();
    expect(() => handle!.db.prepare("PRAGMA journal_mode").get()).not.toThrow();
    // The chain (backed by the still-open handle) is still usable post-"close".
    expect(ledger.verifyChain().ok).toBe(true);

    // The ONE real release:
    handle.closeAll();
    expect(() => handle!.db.prepare("PRAGMA journal_mode").get()).toThrow(
      /database is not open/i,
    );
  });

  it("throws (and cleans up the just-opened handle) if the underlying path can't be opened", () => {
    // A directory path is a real, portable way to make node:sqlite's open fail.
    expect(() => createSharedSqliteHandle(tmpdir())).toThrow();
  });
});
