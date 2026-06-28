/**
 * writeFactsBatch.test.ts — the bulk-ingest verb is CORRECT, not merely fast.
 *
 * `writeFactsBatch(inputs)` is the bulk-ingest equivalent of calling `writeFact`
 * once per input: it mints the SAME OBSERVED strands (same mechanical mint path —
 * content hash, provenance-from-stamp, WARM grace pin, entity index) but commits the
 * whole batch under ONE `withTxn` (one durability barrier on the durable backend).
 * These tests pin the SEMANTIC equivalence, the return contract, ATOMICITY (a throw
 * mid-batch rolls the WHOLE batch back — none persisted), and the empty-input no-op.
 *
 * Backends: equivalence / return / empty run against BOTH the in-memory store (where
 * `withTxn` no-ops) and the durable SQLite store (where the transaction matters).
 * Atomicity is SQLite-only — the in-memory store has no transaction to roll back (it
 * is atomic-per-call by construction), so there is nothing to test there.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSqliteStore,
} from "../index.js";

import type {
  EntityId,
  AttributeKey,
  SourceId,
  IntelligentDb,
  StrandStore,
  Strand,
  StrandId,
} from "../index.js";

import { makeIdentity, bareStamp } from "../__bench__/fixtures.js";

import type { WriteFactInput } from "../api.js";

// --- temp db lifecycle ------------------------------------------------------
//
// On Windows the SQLite file stays locked until the handle is closed, so afterEach
// CLOSES every tracked store FIRST (close-first is load-bearing) and only then
// removes the db + its WAL/SHM siblings.

let paths: string[] = [];
let openStores: StrandStore[] = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-batch-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

/** Remember a store so afterEach can close it before removing its file. */
function track<S extends StrandStore>(store: S): S {
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      (store as Partial<{ close(): void }>).close?.();
    } catch {
      // already closed
    }
  }
  for (const base of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- fixtures ---------------------------------------------------------------

const SRC = "src:bulk" as SourceId;

/** K deterministic inputs, all bare-key stamped (the default writeFact stamp). */
function inputs(k: number): WriteFactInput[] {
  const out: WriteFactInput[] = [];
  for (let i = 0; i < k; i++) {
    out.push({
      entity: (`entity:e${i}` as EntityId),
      attribute: (`e${i}#attr` as AttributeKey),
      payload: { value: `v${i}`, i },
      stamp: bareStamp(SRC),
    });
  }
  return out;
}

/** Engine over a given store + a fresh identity layer. */
function engineOver(store: StrandStore): IntelligentDb {
  return createIntelligentDb(store, makeIdentity().identity);
}

/**
 * The content-bearing projection of a stored strand — everything that must match
 * between the batch and the per-fact path, EXCLUDING the deliberately-random fields
 * (the strand id and each provenance root's random rootId) and the per-fact `now()`
 * timestamps (which differ by milliseconds across two independent runs).
 */
function shapeOf(s: Strand): unknown {
  return {
    entity: s.entity,
    attribute: s.attribute,
    payload: s.payload,
    origin: s.origin,
    fact_state: s.fact_state,
    tier: s.tier,
    content_hash: s.content_hash,
    provenance: s.provenance.map((r) => ({
      independenceClass: r.independenceClass,
      sourceId: r.sourceId,
    })),
  };
}

/** Resolve a stored strand by id from any store, asserting it exists. */
function get(store: StrandStore, id: StrandId): Strand {
  const s = store.getStrand(id);
  expect(s).not.toBeNull();
  return s as Strand;
}

// --- parametrized correctness (both backends) -------------------------------

const backends: ReadonlyArray<readonly [string, () => StrandStore]> = [
  ["memory", () => track(createMemoryStore())],
  ["sqlite", () => track(createSqliteStore(freshPath("ok")))],
];

describe.each(backends)("writeFactsBatch over %s store", (_name, makeStore) => {
  it("EQUIVALENCE: batch produces the SAME stored strands as N writeFact calls", () => {
    const K = 25;
    const ins = inputs(K);

    // Batch path (one db).
    const batchStore = makeStore();
    const batchEngine = engineOver(batchStore);
    const batchIds = batchEngine.writeFactsBatch(ins);

    // Per-fact path (a SEPARATE db, the SAME K inputs).
    const oneStore = makeStore();
    const oneEngine = engineOver(oneStore);
    const oneIds = ins.map((input) => oneEngine.writeFact(input));

    expect(batchIds).toHaveLength(K);
    expect(oneIds).toHaveLength(K);

    // Content-identical, index-for-index (ids differ — randomUUID — so compare shape).
    for (let i = 0; i < K; i++) {
      const fromBatch = shapeOf(get(batchStore, batchIds[i]!));
      const fromOne = shapeOf(get(oneStore, oneIds[i]!));
      expect(fromBatch).toEqual(fromOne);
    }

    // And the entity index agrees: each entity holds exactly its one strand on both.
    for (let i = 0; i < K; i++) {
      const entity = (`entity:e${i}` as EntityId);
      const batchAbout = batchStore.strandsByEntity(entity).map((s) => shapeOf(s));
      const oneAbout = oneStore.strandsByEntity(entity).map((s) => shapeOf(s));
      expect(batchAbout).toEqual(oneAbout);
      expect(batchAbout).toHaveLength(1);
    }
  });

  it("RETURN CONTRACT: K ids in input order, each retrievable and matching its input entity", () => {
    const K = 10;
    const ins = inputs(K);
    const store = makeStore();
    const ids = engineOver(store).writeFactsBatch(ins);

    expect(ids).toHaveLength(K);
    expect(new Set(ids).size).toBe(K); // all distinct

    ins.forEach((input, i) => {
      const s = get(store, ids[i]!);
      expect(s.entity).toBe(input.entity);
      expect(s.attribute).toBe(input.attribute);
      expect(s.payload).toEqual(input.payload);
    });
  });

  it("EMPTY INPUT: returns [] and writes nothing (no throw)", () => {
    const store = makeStore();
    let ids: StrandId[] = [];
    expect(() => {
      ids = engineOver(store).writeFactsBatch([]);
    }).not.toThrow();
    expect(ids).toEqual([]);
    expect(store.strandsByEntity("entity:e0" as EntityId)).toEqual([]);
  });
});

// --- atomicity (SQLite — the txn matters) -----------------------------------

describe("writeFactsBatch atomicity (SQLite)", () => {
  it("a throw MID-BATCH rolls the WHOLE batch back — none persisted, store reusable", () => {
    const path = freshPath("atomic");
    const store = track(createSqliteStore(path));
    const engine = engineOver(store);

    const ins = inputs(5);

    // Force a mid-batch failure: the patched putStrandsBatch durably writes the FIRST
    // strand (inside the open withTxn) then throws — exactly a crash partway through a
    // bulk ingest. Because writeFactsBatch runs putStrandsBatch inside ONE withTxn over
    // the SQLite handle, the throw must roll the already-written first row back too.
    const realPutStrand = store.putStrand.bind(store);
    store.putStrandsBatch = (strands: Iterable<Strand>): void => {
      let n = 0;
      for (const s of strands) {
        realPutStrand(s); // enrolls in the open transaction
        if (++n === 1) throw new Error("boom: mid-batch failure");
      }
    };

    expect(() => engine.writeFactsBatch(ins)).toThrow(/boom/);

    // NOTHING persisted: not the first (durably-written-then-rolled-back) strand, not
    // any later one. Every entity index is empty.
    for (let i = 0; i < ins.length; i++) {
      expect(store.strandsByEntity(`entity:e${i}` as EntityId)).toEqual([]);
    }
    expect(store.integrityCheck()).toBe(true);

    // The store is cleanly reusable: restore the real batch and the op genuinely lands.
    delete (store as Partial<StrandStore>).putStrandsBatch;
    const ids = engine.writeFactsBatch(ins);
    expect(ids).toHaveLength(ins.length);
    for (let i = 0; i < ins.length; i++) {
      expect(store.strandsByEntity(`entity:e${i}` as EntityId)).toHaveLength(1);
    }
    // afterEach closes the tracked handle before removing the file (close-first).
  });
});
