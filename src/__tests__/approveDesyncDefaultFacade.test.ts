/**
 * approveDesyncDefaultFacade.test.ts — regression for `approve-desync-default-facade`
 * (CRITICAL, audit finding #1 in `audit-durability-verified.md`).
 *
 * THE BUG: `agent/agentMemory.ts`'s `createAgentMemory({ dbPath })` — the ACTUAL
 * wiring the public facade builds, not a hand-rolled test rig — used to open its
 * own SQLite handle for the StrandStore but wire the ratification (audit/pending)
 * ledger IN-MEMORY regardless of `dbPath`. `api.ts`'s `approve()` runs the ledger's
 * (irrevocable, in-memory) `APPROVAL` append FIRST, then persists the store writes
 * (OUTRANKS edges + demotions) inside a `withTxn` that only knows about the
 * store's OWN transaction. A thrown error mid-persist rolled the STORE back but
 * left the in-memory ledger's `APPROVAL` record permanent: an ordinary exception
 * (no crash) desynced the "immortal" audit chain from the belief state it claims
 * to describe — `listPending()` would drop the dispute as resolved while the
 * store-side loser stayed un-demoted forever.
 *
 * THE FIX: the facade now owns ONE `DatabaseSync` handle and shares it across the
 * store, the reputation ledger, and the ratification ledger (see agentMemory.ts's
 * `createAgentMemory` doc) — so the ledger's `APPROVAL` insert rides the SAME
 * SQLite transaction the store writes do, and a mid-op throw rolls back BOTH.
 *
 * THIS TEST constructs the memory via the REAL, unmodified `createAgentMemory({
 * dbPath })` factory (never a hand-built shared-handle rig — `AgentMemory` does
 * not expose its internal store/ledger objects, and the store's `#store` field on
 * the engine is a true ECMAScript private field, unreachable from outside even by
 * casting). To force "an ordinary write failure mid-approve" through that closed
 * surface, it arms a ONE-SHOT failure on the very first `INSERT INTO edges`
 * prepared-statement `.run()` call any `DatabaseSync` in this process makes —
 * i.e. the real `SqliteStrandStore.putEdge` call `approve()`'s OUTRANKS-edge
 * persistence loop makes — exactly the "ordinary thrown exception, no crash
 * required" shape the audit reproduced, without touching any private internals.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentMemory,
  createSqlitePendingLedger,
  FactState,
} from "../index.js";
import type { AttributeKey } from "../index.js";

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
  const p = join(tmpdir(), `idb-approve-desync-${tag}-${unique}.db`);
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
 * Arm a ONE-SHOT injected failure on the next `INSERT INTO edges` write ANY
 * `DatabaseSync` instance in this process executes — the real
 * `SqliteStrandStore.putEdge` code path (`store/sqliteStore.ts` prepares this
 * exact statement once, in its constructor, and reuses it for every `putEdge`).
 * Restores the original `prepare` when `disarm()` runs (always call it — success
 * or failure — so later tests in this process are unaffected).
 */
function armOneShotEdgeInsertFailure(): () => void {
  const proto = DatabaseSync.prototype as unknown as {
    prepare: (sql: string, ...rest: unknown[]) => { run: (...args: unknown[]) => unknown };
  };
  const originalPrepare = proto.prepare;
  let armed = true;
  proto.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const stmt = originalPrepare.call(this, sql, ...rest);
    if (armed && sql.includes("INSERT INTO edges")) {
      armed = false; // only the FIRST matching prepared statement is ever wrapped
      const originalRun = stmt.run.bind(stmt);
      let fired = false;
      stmt.run = (...args: unknown[]) => {
        if (!fired) {
          fired = true;
          throw new Error("INJECTED store.putEdge failure (regression test, mid-approve)");
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

describe("approve-desync-default-facade: createAgentMemory({ dbPath })'s approve() is atomic", () => {
  it("a mid-approve store write failure rolls back BOTH the store AND the audit ledger — no permanent APPROVAL, no half-demotion", () => {
    const dbPath = freshPath("main");
    const ATTRIBUTE = "acme_hq#city" as AttributeKey;

    // Arm BEFORE constructing the facade so the wrapper attaches to the store's
    // OWN `#putEdge` statement the instant it's prepared during construction.
    const disarm = armOneShotEdgeInsertFailure();
    let mem: ReturnType<typeof createAgentMemory> | null = null;
    try {
      const memory = createAgentMemory({ dbPath });
      mem = memory;

      // Two anchor-independent authors filing a genuine two-class dispute —
      // mirrors the audit's own live repro exactly.
      const winner = memory.trust.registerOwner("winner-src");
      const rival = memory.trust.registerSsoMember({
        issuer: "https://idp.tenantx.example",
        subject: "loser-user",
        tenantId: "tenantX",
      });

      const { id: winnerId } = memory.remember({
        text: "Acme HQ is in Austin",
        entity: "entity:acme_hq",
        attribute: String(ATTRIBUTE),
        source: { sourceId: winner.sourceId },
      });
      const { id: loserId } = memory.remember({
        text: "Acme HQ is in Denver",
        entity: "entity:acme_hq",
        attribute: String(ATTRIBUTE),
        source: { sourceId: rival.sourceId },
      });

      const outcome = memory.adjudicate(ATTRIBUTE);
      expect(outcome.kind).toBe("DEFERRED");

      const pendingBefore = memory.listPending();
      expect(pendingBefore).toHaveLength(1);
      const csid = pendingBefore[0]!.contradictionSetId;

      // A distinct external approver: anchor-registered, independent of both
      // authors (SYSTEM_OF_RECORD is its own class).
      const approver = memory.trust.registerSystemOfRecord({ name: "workday-approver" });

      // THE INJECTED FAILURE fires on approve()'s FIRST store edge write (the
      // OUTRANKS edge) — an ordinary thrown exception, no crash.
      expect(() => memory.approve(csid, winnerId, approver.sourceId)).toThrow(
        /INJECTED store\.putEdge failure/,
      );

      // --- THE ATOMICITY ASSERTIONS -------------------------------------------

      // 1) The dispute must STILL be open — not silently "resolved" while the
      //    store never actually applied the resolution.
      const pendingAfter = memory.listPending();
      expect(pendingAfter).toHaveLength(1);
      expect(pendingAfter[0]!.contradictionSetId).toBe(csid);

      // 2) The store-side loser must be UNCHANGED: still LIVE, no demotion —
      //    the pre-fix bug's exact symptom was the loser staying LIVE while the
      //    ledger permanently recorded the dispute as resolved (the INVERSE
      //    desync would be equally bad: a demoted loser with the ledger not
      //    reflecting an approval — this asserts the loser side of the pair).
      const loserExplain = memory.explain(loserId);
      expect(loserExplain).not.toBeNull();
      expect(loserExplain!.factState).toBe(FactState.LIVE);
      expect(loserExplain!.demotion).toBeNull();

      const winnerExplain = memory.explain(winnerId);
      expect(winnerExplain).not.toBeNull();
      expect(winnerExplain!.factState).toBe(FactState.LIVE);
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

    // 3) THE DURABLE LEDGER ITSELF: reopen the SAME on-disk file with a fresh,
    //    independent `SqlitePendingLedger` (real production code, not
    //    reimplemented) and prove (a) the checksum chain verifies clean — the
    //    rolled-back APPROVAL insert left no broken/dangling row — and (b) NO
    //    APPROVAL record for this dispute was ever persisted; only the original
    //    PENDING survived.
    const rawDb = new DatabaseSync(dbPath);
    cleanups.push(() => {
      try {
        rawDb.close();
      } catch {
        /* already closed */
      }
    });
    const reopenedLedger = createSqlitePendingLedger({ db: rawDb });
    expect(reopenedLedger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    const stillPending = reopenedLedger.listPending();
    expect(stillPending).toHaveLength(1);

    const records = reopenedLedger.records();
    const approvalRecords = records.filter((r) => r.kind === "APPROVAL");
    expect(approvalRecords).toHaveLength(0);
    expect(records.some((r) => r.kind === "PENDING")).toBe(true);
  });
});
