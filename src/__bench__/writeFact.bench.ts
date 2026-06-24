/**
 * writeFact.bench.ts — ENGINE WRITE PATH (mint strand + putStrand) on memory and
 * SQLite, at a few existing-strand counts.
 *
 * SHARED_ENTITY is now an INDEX, not a materialized clique: writeFact mints NO
 * sibling edges (the old O(N^2) mesh is gone) — it only `putStrand`s the fresh
 * strand, and the store's entity index (already maintained by putStrand) is the
 * shared-entity join the activation walk derives siblings from at read time. So the
 * shared-entity part of writeFact is O(1), NOT O(existing strands about the entity).
 * We still bench at 100 / 1k / 10k existing same-entity strands — the curve should
 * now be ~FLAT across all three (no fan-out), where it used to be a steep O(siblings)
 * cliff (~95 → ~16 → ~1.3 hz on SQLite).
 *
 * We re-seed a fixed-size web in a closure and measure ONE writeFact against it; the
 * heavy 10k-SQLite case is bounded with low time/iterations (the re-seed, not
 * writeFact, dominates that case now).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, bench, describe } from "vitest";

import { createIntelligentDb, createMemoryStore, createSqliteStore } from "../index.js";
import type {
  EntityId,
  IntelligentDb,
  SourceId,
  StrandStore,
  SqliteStrandStore,
} from "../index.js";

import { costStamp, makeIdentity, makeStrand } from "./fixtures.js";

const SRC = "src:writer" as SourceId;
const STAMP = costStamp(SRC, 0.35);

/** Pre-seed `store` with `existing` strands about ONE entity (engine-free, cheap). */
function seedEntity(store: StrandStore, tag: string, existing: number, entity: EntityId): void {
  for (let i = 0; i < existing; i++) {
    store.putStrand(makeStrand(`${tag}:${i}`, entity, (`src:${i}` as SourceId), `cls:${i}`, { i }));
  }
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function freshSqlite(tag: string): SqliteStrandStore {
  const p = join(tmpdir(), `idb-bench-wf-${tag}-${process.pid}-${Date.now()}.db`);
  const store = createSqliteStore(p);
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      /* */
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* */
      }
    }
  });
  return store;
}

const EXISTING = [100, 1_000, 10_000] as const;

// Pre-seed each fixed-size web ONCE (outside the timed body), exactly like
// recall.bench. SHARED_ENTITY is now an INDEX: writeFact no longer reads or rewrites
// siblings, so it costs the SAME regardless of how many priors the entity already
// has — and it does NOT matter that repeated timed iterations keep growing the web,
// because the cost of one writeFact is independent of the web size. Measuring ONE
// writeFact against a pre-seeded web therefore isolates the (now O(1)) write cost and
// the 100 / 1k / 10k curve should be ~FLAT (it used to be a steep O(siblings) cliff:
// ~95 → ~16 → ~1.3 hz on SQLite).
interface SeededWf {
  readonly db: IntelligentDb;
  readonly entity: EntityId;
}

const memWebs = new Map<number, SeededWf>();
const sqWebs = new Map<number, SeededWf>();
for (const existing of EXISTING) {
  const memEntity = (`ent:wf:mem:${existing}` as EntityId);
  const memStore: StrandStore = createMemoryStore();
  seedEntity(memStore, `m:${existing}`, existing, memEntity);
  memWebs.set(existing, {
    db: createIntelligentDb(memStore, makeIdentity().identity),
    entity: memEntity,
  });

  const sqEntity = (`ent:wf:sq:${existing}` as EntityId);
  const sqStore = freshSqlite(`${existing}`);
  seedEntity(sqStore, `s:${existing}`, existing, sqEntity);
  sqWebs.set(existing, {
    db: createIntelligentDb(sqStore, makeIdentity().identity),
    entity: sqEntity,
  });
}

for (const existing of EXISTING) {
  describe(`WRITEFACT · ${existing} existing same-entity strands`, () => {
    // MEMORY: one writeFact against a pre-seeded `existing`-strand entity. Flat in
    // `existing` (the shared-entity part is one putStrand, no fan-out).
    bench("memory", () => {
      const w = memWebs.get(existing)!;
      w.db.writeFact({ entity: w.entity, payload: { fresh: true }, stamp: STAMP });
    });

    // SQLITE: same shape on the durable backend. No longer the harness's heaviest
    // case — there is no 10k×2 edge insert + 10k recompute fan-out anymore, just one
    // row insert, so it stays flat across 100 / 1k / 10k.
    bench("sqlite", () => {
      const w = sqWebs.get(existing)!;
      w.db.writeFact({ entity: w.entity, payload: { fresh: true }, stamp: STAMP });
    });
  });
}
