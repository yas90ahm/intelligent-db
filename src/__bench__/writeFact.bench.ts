/**
 * writeFact.bench.ts — ENGINE WRITE PATH (mint strand + shared-entity edge attach +
 * recomputeOutWeightSum) on memory and SQLite, at a few existing-strand counts.
 *
 * writeFact attaches the fresh strand to EVERY existing strand about the same entity
 * with two SHARED_ENTITY edges each, then recomputes out_weight_sum on every touched
 * node — so its cost is O(existing strands about the entity). We bench at 100 / 1k /
 * 10k existing same-entity strands to expose that fan-out, on both backends.
 *
 * Because writeFact's fan-out GROWS the web each iteration (every new strand attaches
 * to all priors), we re-seed a fixed-size web in a closure and measure ONE writeFact
 * against it; the heavy 10k-SQLite case is bounded with low time/iterations.
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

for (const existing of EXISTING) {
  describe(`WRITEFACT · ${existing} existing same-entity strands`, () => {
    // MEMORY: re-seed a fresh fixed-size web each iteration so the fan-out stays at
    // `existing` (writeFact would otherwise grow the web unboundedly across iterations).
    bench(
      "memory",
      () => {
        const entity = (`ent:wf:mem:${existing}` as EntityId);
        const store: StrandStore = createMemoryStore();
        seedEntity(store, `m:${existing}`, existing, entity);
        const db: IntelligentDb = createIntelligentDb(store, makeIdentity().identity);
        db.writeFact({ entity, payload: { fresh: true }, stamp: STAMP });
      },
      // Re-seeding dominates; keep the heaviest case bounded so the run finishes.
      existing >= 10_000 ? { time: 400, iterations: 5 } : undefined,
    );

    // SQLITE: same shape on the durable backend. The 10k case is the heaviest in the
    // whole harness (10k×2 edge inserts + 10k recomputes per iteration over WAL), so it
    // is tightly bounded.
    bench(
      "sqlite",
      () => {
        const entity = (`ent:wf:sq:${existing}` as EntityId);
        const store = freshSqlite(`${existing}-${Math.random().toString(36).slice(2)}`);
        seedEntity(store, `s:${existing}`, existing, entity);
        const db: IntelligentDb = createIntelligentDb(store, makeIdentity().identity);
        db.writeFact({ entity, payload: { fresh: true }, stamp: STAMP });
        store.close();
      },
      existing >= 10_000 ? { time: 500, iterations: 3 } : existing >= 1_000 ? { time: 800 } : undefined,
    );
  });
}
