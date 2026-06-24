/**
 * store.bench.ts — STORE HOT PATHS: memory vs SQLite.
 *
 * Benches the four primitives the activation walk and the engine hammer:
 *   putStrand, getStrand, strandsByEntity, outEdges.
 * Each backend is pre-seeded with N strands + a star of edges so the read benches
 * operate over a realistic adjacency. SQLite uses a temp path under os.tmpdir and is
 * cleaned up in afterAll (including -wal/-shm sidecars).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, bench, describe } from "vitest";

import { EdgeType, createMemoryStore, createSqliteStore } from "../index.js";
import type { EntityId, SourceId, StrandId, StrandStore } from "../index.js";
import type { SqliteStrandStore } from "../index.js";

import { makeEdge, makeStrand } from "./fixtures.js";

const SEED_N = 10_000;
const ENTITY = "entity:store-bench" as EntityId;

/** Seed `store` with N strands about ONE entity, each linked hub<->member to strand 0. */
function seed(store: StrandStore, tag: string): { ids: StrandId[]; hub: StrandId } {
  const ids: StrandId[] = [];
  for (let i = 0; i < SEED_N; i++) {
    const s = makeStrand(`${tag}:${i}`, ENTITY, (`src:${i % 32}` as SourceId), `cls:${i}`, { i });
    store.putStrand(s);
    ids.push(s.id);
  }
  const hub = ids[0]!;
  // A wide hub so outEdges(hub) returns a realistic fan-out (capped to keep seeding fast).
  const fan = Math.min(SEED_N - 1, 256);
  for (let j = 1; j <= fan; j++) {
    store.putEdge(makeEdge(`${tag}:e:${j}`, hub, ids[j]!, EdgeType.SHARED_ENTITY));
  }
  store.recomputeOutWeightSum(hub);
  return { ids, hub };
}

// --- temp SQLite lifecycle --------------------------------------------------

let sqlitePath: string;
let sqliteStore: SqliteStrandStore;
let memStore: StrandStore;
let memIds: StrandId[];
let memHub: StrandId;
let sqIds: StrandId[];
let sqHub: StrandId;
let putCounter = 0;

beforeAll(() => {
  memStore = createMemoryStore();
  const m = seed(memStore, "mem");
  memIds = m.ids;
  memHub = m.hub;

  sqlitePath = join(tmpdir(), `idb-bench-store-${process.pid}-${Date.now()}.db`);
  sqliteStore = createSqliteStore(sqlitePath);
  const s = seed(sqliteStore, "sq");
  sqIds = s.ids;
  sqHub = s.hub;
});

afterAll(() => {
  try {
    sqliteStore.close();
  } catch {
    /* best effort */
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(sqlitePath + suffix, { force: true });
    } catch {
      /* handle not released */
    }
  }
});

describe("STORE · putStrand (append fresh)", () => {
  bench("memory", () => {
    const s = makeStrand(`mem:put:${putCounter++}`, ENTITY, "src:put" as SourceId, "cls:put", { x: 1 });
    memStore.putStrand(s);
  });
  bench("sqlite", () => {
    const s = makeStrand(`sq:put:${putCounter++}`, ENTITY, "src:put" as SourceId, "cls:put", { x: 1 });
    sqliteStore.putStrand(s);
  });
});

describe("STORE · getStrand (read over 10k)", () => {
  let k = 0;
  bench("memory", () => {
    memStore.getStrand(memIds[(k++ % SEED_N)]!);
  });
  bench("sqlite", () => {
    sqliteStore.getStrand(sqIds[(k++ % SEED_N)]!);
  });
});

describe("STORE · strandsByEntity (10k about one entity)", () => {
  bench("memory", () => {
    memStore.strandsByEntity(ENTITY);
  });
  bench("sqlite", () => {
    sqliteStore.strandsByEntity(ENTITY);
  });
});

describe("STORE · outEdges (hub with ~256 out-edges)", () => {
  bench("memory", () => {
    memStore.outEdges(memHub);
  });
  bench("sqlite", () => {
    sqliteStore.outEdges(sqHub);
  });
});
