/**
 * facadeRatifyAtomicity.test.ts — regression for `no-test-for-default-facade-wiring`
 * (MEDIUM, `audit-durability-verified.md` finding #6).
 *
 * THE GAP: every compound-write atomicity test in this codebase
 * (`__tests__/atomicCompound.test.ts`, `__torture__/harness.ts`) builds its own
 * hand-wired shared-`DatabaseSync`-handle rig — never the ACTUAL public
 * `agent/agentMemory.ts`'s `createAgentMemory({ dbPath })` factory most callers
 * construct. `approveDesyncDefaultFacade.test.ts` (a Wave-1 fix regression) closed
 * part of this gap for `approve()` specifically, but no test proved the OTHER
 * store+reputation-ledger compound write — `ratify()` — is atomic under the real
 * default facade wiring. This file adds that: an `atomicCompound.test.ts`-style
 * forced-mid-op-throw case, but wired EXACTLY like the real
 * `createAgentMemory({ dbPath })` default (post-Wave-1 shared handle), never a
 * hand-rolled rig.
 *
 * `ratify()` (`api.ts`'s `#ratifyImpl`, wrapped in `withTxn`) writes across TWO
 * subsystems riding the SAME shared handle: the store (`putStrand` — the
 * promoted strand + appended external provenance root) and the reputation ledger
 * (`reputation.ratify` — the earned credit, `INSERT INTO reputation`). A crash or
 * thrown error between the two must leave EITHER both applied or NEITHER — never
 * a promoted/re-observed strand with no matching reputation credit (or vice
 * versa). Because `AgentMemory` does not expose its internal store/ledger/engine
 * private fields (the engine's `#store` is a true ECMAScript private field), the
 * failure is injected the same way `approveDesyncDefaultFacade.test.ts` does: a
 * ONE-SHOT wrapper on `DatabaseSync.prototype.prepare` that throws the first time
 * the real `SqliteReputationLedger`'s reused `INSERT INTO reputation` statement
 * runs — the exact write `ratify()`'s credit path makes — without touching any
 * private internals.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentMemory,
  createSqliteReputationLedger,
  FactState,
  repCapFor,
} from "../index.js";
import type { SourceId, Unit } from "../index.js";

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
  const p = join(tmpdir(), `idb-facade-ratify-atomic-${tag}-${unique}.db`);
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

/**
 * Arm a ONE-SHOT injected failure on the next `INSERT INTO reputation` write ANY
 * `DatabaseSync` instance in this process executes — the real
 * `SqliteReputationLedgerImpl`'s `#put` statement (`identity/reputation.ts`
 * prepares this exact SQL once, in its constructor, and reuses it for every
 * `ratify`/`contradict`/`reverseCredit`/`disownSweep` write). Mirrors
 * `approveDesyncDefaultFacade.test.ts`'s `armOneShotEdgeInsertFailure` exactly,
 * targeting the reputation ledger's write instead of the store's edge write.
 */
function armOneShotReputationInsertFailure(): () => void {
  const proto = DatabaseSync.prototype as unknown as {
    prepare: (sql: string, ...rest: unknown[]) => { run: (...args: unknown[]) => unknown };
  };
  const originalPrepare = proto.prepare;
  let armed = true;
  proto.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const stmt = originalPrepare.call(this, sql, ...rest);
    if (armed && sql.includes("INSERT INTO reputation ")) {
      armed = false; // only the FIRST matching prepared statement is ever wrapped
      const originalRun = stmt.run.bind(stmt);
      let fired = false;
      stmt.run = (...args: unknown[]) => {
        if (!fired) {
          fired = true;
          throw new Error("INJECTED reputation.ratify failure (regression test, mid-ratify)");
        }
        return originalRun(...args);
      };
    }
    return stmt;
  };
  return () => {
    proto.prepare = originalPrepare;
  };
}

describe("no-test-for-default-facade-wiring: createAgentMemory({ dbPath })'s ratify() is atomic", () => {
  it("a mid-ratify reputation-ledger write failure rolls back BOTH the store's promotion AND the reputation credit", () => {
    const dbPath = freshPath("main");

    const disarm = armOneShotReputationInsertFailure();
    let mem: ReturnType<typeof createAgentMemory> | null = null;
    let externalSourceId: SourceId;
    let strandId: string;
    try {
      const memory = createAgentMemory({ dbPath });
      mem = memory;

      // A plain fact filed by the auto-provisioned default (OWNER) source — LIVE,
      // non-quarantined, no dispute involved. Any `ratify()` call against it drives
      // the reputation-credit path unconditionally (api.ts's `#ratifyImpl`: the
      // credit branch runs whenever a reputation ledger is wired, independent of
      // whether the strand's fact_state/origin actually flips).
      const { id } = memory.remember({
        text: "The Eiffel Tower is in Paris",
        entity: "entity:eiffel-tower",
        attribute: "eiffel_tower#city",
      });
      strandId = String(id);

      const before = memory.explain(id);
      expect(before).not.toBeNull();
      expect(before!.factState).toBe(FactState.LIVE);
      expect(before!.externalReobservationCount).toBe(0);
      expect(before!.roots).toHaveLength(1);

      // An anchor-independent external witness — a genuine second, distinct source
      // (not the owner) so the ratify call is a real external-corroboration event.
      const external = memory.trust.registerSystemOfRecord({ name: "atlas-approver" });
      externalSourceId = external.sourceId;

      // THE INJECTED FAILURE fires on ratify()'s reputation-ledger write.
      expect(() => memory.ratify(id, { sourceId: external.sourceId })).toThrow(
        /INJECTED reputation\.ratify failure/,
      );

      // --- THE ATOMICITY ASSERTIONS -----------------------------------------

      // 1) The store side must be UNCHANGED: no new external provenance root, no
      //    bump to external_reobservation_count — `putStrand(promoted)` (which ran
      //    BEFORE the injected reputation write) must have been rolled back too,
      //    not left half-applied.
      const after = memory.explain(id);
      expect(after).not.toBeNull();
      expect(after!.factState).toBe(FactState.LIVE);
      expect(after!.externalReobservationCount).toBe(0);
      expect(after!.roots).toHaveLength(1);
      expect(after!.roots.map((r) => r.sourceId)).not.toContain(external.sourceId);
    } finally {
      disarm();
      if (mem !== null) {
        try {
          mem.close();
        } catch {
          /* already closed */
        }
      }
    }

    // 2) THE DURABLE REPUTATION LEDGER ITSELF: reopen the SAME on-disk file with a
    //    fresh, independent `SqliteReputationLedger` (real production code, not
    //    reimplemented) and confirm NO reputation state was ever persisted for the
    //    external ratifier — the injected write threw before its own INSERT
    //    committed, and the surrounding `withTxn` rolled back the store's earlier
    //    (uncommitted) write in the SAME transaction.
    const rawDb = new DatabaseSync(dbPath);
    cleanups.push(() => {
      try {
        rawDb.close();
      } catch {
        /* already closed */
      }
    });
    const reopenedLedger = createSqliteReputationLedger((_sourceId: SourceId): Unit => repCapFor([]), {
      db: rawDb,
    });
    expect(reopenedLedger.stateOf(externalSourceId!)).toBeNull();

    // 3) The store itself reopens clean and the strand is exactly as it was before
    //    the failed ratify — no half-applied promotion survived an unclean
    //    in-process rollback either.
    const strandRow = rawDb
      .prepare("SELECT json FROM strands WHERE id = ?")
      .get(strandId!) as { json: string } | undefined;
    expect(strandRow).toBeDefined();
    const persisted = JSON.parse(strandRow!.json) as {
      fact_state: string;
      external_reobservation_count: number;
      provenance: unknown[];
    };
    expect(persisted.fact_state).toBe(FactState.LIVE);
    expect(persisted.external_reobservation_count).toBe(0);
    expect(persisted.provenance).toHaveLength(1);
  });
});
