/**
 * runForgettingAtomicity.test.ts — REGRESSION for two re-audit findings against
 * `IntelligentDb.runForgetting` (perf lane finding #9 + test-quality lane finding,
 * `PRODUCTION_READINESS_REASSESSMENT.md` items 9/10):
 *
 *   1. `#isBridgeBetween` used to take the SUBJECT strand's id and re-fetch
 *      `store.outEdges`/`store.inEdges` on EVERY call — but `#forgettingNeighborsOf`
 *      calls it once per SAME-ENTITY NEIGHBOR of a fixed subject strand, so the
 *      subject's own edges were re-fetched once per neighbor instead of once per
 *      subject — the exact redundant-refetch shape Wave-2 fixed for the activation
 *      walk's `outEdgesCache`, reintroduced here in the newer forgetting sweep.
 *   2. Unlike EVERY sibling compound belief-mutating verb (`adjudicate`, `approve`,
 *      `downstreamDisownSweep`, `writeFact`, `ratify` — all covered by
 *      `atomicCompound.test.ts`), `runForgetting` had ZERO atomicity / SQLite-backend
 *      / crash-recovery test coverage, despite already being wrapped in `withTxn` in
 *      production. This file closes that gap the same way `atomicCompound.test.ts`
 *      and `approveDesyncDefaultFacade.test.ts` do: construct via the REAL, unmodified
 *      `createAgentMemory({ dbPath })` facade (never a hand-wired rig), inject a
 *      genuine mid-sweep write failure, and prove the WHOLE sweep rolls back — no
 *      strand is left half-moved even though its own individual write succeeded
 *      before the later one threw.
 *
 * Both fixes are proven against the REAL production entry point
 * (`memory.engine.runForgetting`), never a re-derived predicate.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentMemory, Tier } from "../index.js";
import type { EpochMs } from "../index.js";

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
  const p = join(tmpdir(), `idb-forgetting-atomic-${tag}-${unique}.db`);
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
const { StatementSync } = nodeRequire("node:sqlite") as {
  StatementSync: new (...args: never[]) => {
    readonly sourceSQL: string;
    all(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};

// A future "at" far past both the 7-day grace window and any realistic salience
// half-life, so `decayPressure` saturates near 1 for every strand regardless of
// the exact moment the test happened to run — a REALISTIC parameter (real elapsed
// wall time), not a value hand-tuned to the default config's exact thresholds.
const FAR_FUTURE = (Date.now() + 100 * 365 * 24 * 60 * 60 * 1000) as EpochMs;

/**
 * Arm a failure on `INSERT INTO strands` that fires ONLY for the strand id given
 * in `targetId` (matched against the statement's first bound parameter), on its
 * FIRST matching invocation. Content-keyed (not call-count-keyed) so it correctly
 * fires no matter how many OTHER `putStrand` calls setup work already made.
 *
 * Patches `StatementSync.prototype.run` directly (the SHARED prototype every
 * prepared statement instance looks up methods through) rather than wrapping
 * `DatabaseSync.prototype.prepare`: `SqliteStrandStore` prepares its `putStrand`
 * statement ONCE in the constructor, well before `createAgentMemory({ dbPath })`
 * returns to this test, so a `prepare()`-wrapping spy installed afterward (the
 * only time this helper CAN be installed, since it must run after `remember()`
 * has already produced the target strand's id) would never see that pre-existing
 * statement's later `.run()` calls at all.
 */
function armOneShotStrandWriteFailureFor(targetId: string): () => void {
  const proto = StatementSync.prototype as unknown as {
    run: (...args: unknown[]) => unknown;
  };
  const originalRun = proto.run;
  let fired = false;
  proto.run = function (this: { sourceSQL: string }, ...args: unknown[]) {
    if (!fired && this.sourceSQL.includes("INSERT INTO strands") && args[0] === targetId) {
      fired = true;
      throw new Error("INJECTED runForgetting mid-sweep failure");
    }
    return originalRun.apply(this, args);
  };
  return () => {
    proto.run = originalRun;
  };
}

describe("runForgetting: atomicity over createAgentMemory({ dbPath }) (re-audit fix)", () => {
  it("a mid-sweep write failure rolls back the WHOLE sweep — no half-moved tier, even for a strand whose own write already succeeded", () => {
    const dbPath = freshPath("main");
    const memory = createAgentMemory({ dbPath });
    cleanups.push(() => {
      try {
        memory.close();
      } catch {
        /* already closed */
      }
    });

    const a = memory.remember({ text: "fact alpha", entity: "entity:alpha" });
    const b = memory.remember({ text: "fact beta", entity: "entity:beta" });
    expect(memory.explain(a.id)!.tier).toBe(Tier.WARM);
    expect(memory.explain(b.id)!.tier).toBe(Tier.WARM);

    // `runForgetting` evaluates targets in the order `store.allStrands()` returns
    // them; iterate BOTH ids explicitly so ordering is pinned regardless of store
    // internals — `a` is evaluated (and its write SUCCEEDS inside the open SQL
    // transaction) BEFORE the injected failure fires on `b`.
    const disarm = armOneShotStrandWriteFailureFor(String(b.id));
    try {
      expect(() =>
        memory.engine.runForgetting({ at: FAR_FUTURE, strandIds: [a.id, b.id] }),
      ).toThrow(/INJECTED runForgetting mid-sweep failure/);
    } finally {
      disarm();
    }

    // THE ATOMICITY ASSERTION: `a`'s tier move — which physically executed inside
    // the transaction before `b`'s write threw — must be UNDONE too. A pre-fix
    // (or unwrapped) sweep would leave `a` at COLD and only `b` stuck at WARM: a
    // half-moved sweep, exactly what `withTxn` exists to prevent.
    expect(memory.explain(a.id)!.tier).toBe(Tier.WARM);
    expect(memory.explain(b.id)!.tier).toBe(Tier.WARM);

    // Re-runnable and then genuinely succeeds (same idiom as
    // atomicCompound.test.ts's forced-throw-then-clean-rerun cases) — proves the
    // rollback left a consistent, retryable state, not a wedged one.
    const result = memory.engine.runForgetting({ at: FAR_FUTURE, strandIds: [a.id, b.id] });
    expect(result.moved.map((m) => String(m.strandId)).sort()).toEqual(
      [String(a.id), String(b.id)].sort(),
    );
    expect(memory.explain(a.id)!.tier).toBe(Tier.COLD);
    expect(memory.explain(b.id)!.tier).toBe(Tier.COLD);
  });

  it("the durable file itself shows no half-applied sweep: a fresh reopen sees BOTH strands still WARM after the rollback", () => {
    const dbPath = freshPath("reopen");
    let memory = createAgentMemory({ dbPath });
    const a = memory.remember({ text: "fact gamma", entity: "entity:gamma" });
    const b = memory.remember({ text: "fact delta", entity: "entity:delta" });

    const disarm = armOneShotStrandWriteFailureFor(String(b.id));
    try {
      expect(() =>
        memory.engine.runForgetting({ at: FAR_FUTURE, strandIds: [a.id, b.id] }),
      ).toThrow(/INJECTED runForgetting mid-sweep failure/);
    } finally {
      disarm();
    }
    memory.close();

    // A FRESH process-equivalent reopen (new facade instance, same file) — proves
    // the rollback is durable, not just an in-process illusion.
    memory = createAgentMemory({ dbPath });
    cleanups.push(() => {
      try {
        memory.close();
      } catch {
        /* already closed */
      }
    });
    expect(memory.explain(a.id)!.tier).toBe(Tier.WARM);
    expect(memory.explain(b.id)!.tier).toBe(Tier.WARM);
  });
});

describe("runForgetting: no redundant per-neighbor edge refetch (re-audit fix)", () => {
  it("fetches the subject's out/in edges ONCE per strand, not once per same-entity neighbor", () => {
    const dbPath = freshPath("norefetch");
    const memory = createAgentMemory({ dbPath });
    cleanups.push(() => {
      try {
        memory.close();
      } catch {
        /* already closed */
      }
    });

    // FIVE strands sharing ONE entity: each strand's OWN sweep sees FOUR
    // same-entity neighbors. Pre-fix, `#isBridgeBetween` would re-fetch the
    // subject's out/in edges once per neighbor => 5 subjects * 4 neighbors = 20
    // out/in-edge queries. Fixed: exactly one out + one in query per SUBJECT,
    // regardless of neighbor count => 5 of each.
    const ids = Array.from({ length: 5 }, (_, i) =>
      memory.remember({ text: `fact cluster ${i}`, entity: "entity:cluster" }).id,
    );

    // Patch `StatementSync.prototype.all` directly (the SHARED prototype every
    // prepared statement instance looks up methods through), filtered by
    // `this.sourceSQL` at call time: `SqliteStrandStore` prepares its
    // `outEdges`/`inEdges` statements ONCE in the constructor (well before this
    // spy could be installed) and reuses them via `.all()` on every call, so a
    // `DatabaseSync.prototype.prepare`-wrapping spy installed here would never
    // see those calls at all — silently passing even against the unfixed,
    // per-neighbor-refetching code.
    const proto = StatementSync.prototype as unknown as {
      all: (...args: unknown[]) => unknown;
    };
    const originalAll = proto.all;
    let outEdgeQueries = 0;
    let inEdgeQueries = 0;
    proto.all = function (this: { sourceSQL: string }, ...args: unknown[]) {
      if (this.sourceSQL === "SELECT json FROM edges WHERE from_id = ?") outEdgeQueries++;
      else if (this.sourceSQL === "SELECT json FROM edges WHERE to_id = ?") inEdgeQueries++;
      return originalAll.apply(this, args);
    };
    try {
      const result = memory.engine.runForgetting({ at: FAR_FUTURE, strandIds: ids });
      expect(result.evaluated).toBe(5);
    } finally {
      proto.all = originalAll;
    }

    expect(outEdgeQueries).toBe(5);
    expect(inEdgeQueries).toBe(5);
  });
});
