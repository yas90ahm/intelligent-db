/**
 * vectorSidecar.test.ts — proves the in-memory and SQLite vector sidecars are
 * faithful equals: put/get round-trip, cosine top-K ranking, model-id mismatch
 * is silently ignored (never cross-model-compared), and content_hash keying
 * means an echo (same hash, re-put) replaces rather than duplicates.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { ContentHash } from "../core/types.js";
import {
  BoundedTopKHeap,
  cosineSimilarity,
  createMemoryVectorSidecar,
  createSqliteVectorSidecar,
  type SqliteVectorSidecar,
  type VectorMatch,
  type VectorSidecar,
} from "./vectorSidecar.js";
import { SharedHandleNotWalError } from "./sqliteStore.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

function hash(s: string): ContentHash {
  return s as ContentHash;
}

function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity(vec(1, 0), vec(1, 0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1, 6);
  });

  it("returns 0 (never NaN) for a zero-norm vector", () => {
    expect(cosineSimilarity(vec(0, 0), vec(1, 0))).toBe(0);
    expect(cosineSimilarity(vec(0, 0), vec(0, 0))).toBe(0);
  });
});

// BoundedTopKHeap is the exact O(k)-memory selection primitive rankTopK (and
// therefore every backend's topK()) runs through — unit-tested directly here so
// the SIZE BOUND itself (not just end-to-end output correctness, covered above
// per-backend) is a real, enforced regression check: `.size` must never exceed
// the capacity passed at construction, no matter how many candidates are pushed.
describe("BoundedTopKHeap (the vectorsidecar-topk-full-materialization fix)", () => {
  function match(contentHash: string, score: number): VectorMatch {
    return { contentHash: hash(contentHash), score };
  }

  it("never retains more than `capacity` entries, however many are pushed", () => {
    function pseudoScore(i: number): number {
      const raw = Math.sin(i * 12.9898) * 43758.5453;
      return raw - Math.floor(raw);
    }
    const heap = new BoundedTopKHeap(7);
    for (let i = 0; i < 10_000; i++) {
      heap.push(match(`c${i}`, pseudoScore(i)));
      // The retained size is checked on EVERY push, not just at the end: a bug that
      // let the internal array grow past capacity before some later compaction step
      // would still be caught mid-stream.
      expect(heap.size).toBeLessThanOrEqual(7);
    }
    expect(heap.size).toBe(7);
  });

  it("keeps exactly the k highest scores, sorted descending (ties broken by content_hash ascending)", () => {
    const heap = new BoundedTopKHeap(3);
    for (const m of [
      match("z", 0.1),
      match("a", 0.9),
      match("m", 0.5),
      match("b", 0.9), // ties "a" on score -> tie-break decides order
      match("q", 0.4),
      match("low", -1),
    ]) {
      heap.push(m);
    }
    expect(heap.toSorted().map((m) => String(m.contentHash))).toEqual(["a", "b", "m"]);
  });

  it("a late-arriving candidate that beats the current worst kept displaces it", () => {
    const heap = new BoundedTopKHeap(2);
    heap.push(match("low1", 0.1));
    heap.push(match("low2", 0.2));
    expect(heap.size).toBe(2);
    heap.push(match("winner", 0.99));
    expect(heap.size).toBe(2);
    expect(heap.toSorted().map((m) => String(m.contentHash))).toEqual(["winner", "low2"]);
  });

  it("a candidate worse than everything already kept is discarded once the heap is full", () => {
    const heap = new BoundedTopKHeap(2);
    heap.push(match("a", 0.9));
    heap.push(match("b", 0.8));
    heap.push(match("worse", 0.01));
    expect(heap.size).toBe(2);
    expect(heap.toSorted().map((m) => String(m.contentHash))).toEqual(["a", "b"]);
  });

  it("capacity 0 retains nothing and toSorted() is []", () => {
    const heap = new BoundedTopKHeap(0);
    heap.push(match("a", 1));
    heap.push(match("b", 2));
    expect(heap.size).toBe(0);
    expect(heap.toSorted()).toEqual([]);
  });

  it("matches a naive full-sort baseline on random data (correctness of the heap itself)", () => {
    let seed = 12345;
    function rand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    const n = 2000;
    const k = 37;
    const all: VectorMatch[] = [];
    for (let i = 0; i < n; i++) all.push(match(`h${i}`, rand()));

    const heap = new BoundedTopKHeap(k);
    for (const m of all) heap.push(m);

    const naive = [...all]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.contentHash) < String(b.contentHash) ? -1 : 1;
      })
      .slice(0, k);

    expect(heap.toSorted()).toEqual(naive);
  });
});

// A shared behavioral suite run over BOTH backends so they stay faithful equals.
function sidecarBehavior(name: string, make: () => VectorSidecar, teardown?: () => void) {
  describe(name, () => {
    afterEach(() => {
      teardown?.();
    });

    it("put/get round-trips modelId, dim, and the vector", () => {
      const sc = make();
      sc.put(hash("h1"), "modelA", vec(1, 2, 3));
      const got = sc.get(hash("h1"));
      expect(got).not.toBeNull();
      expect(got?.modelId).toBe("modelA");
      expect(got?.dim).toBe(3);
      expect(Array.from(got?.vec ?? [])).toEqual([1, 2, 3]);
    });

    it("get returns null for an unknown content_hash", () => {
      const sc = make();
      expect(sc.get(hash("nope"))).toBeNull();
    });

    it("re-put under the SAME content_hash REPLACES (echoes share one vector)", () => {
      const sc = make();
      sc.put(hash("h1"), "modelA", vec(1, 0));
      sc.put(hash("h1"), "modelA", vec(0, 1));
      const got = sc.get(hash("h1"));
      expect(Array.from(got?.vec ?? [])).toEqual([0, 1]);
    });

    it("a later put under a DIFFERENT model_id replaces the row (lazy re-embed on model change)", () => {
      const sc = make();
      sc.put(hash("h1"), "modelA", vec(1, 0));
      sc.put(hash("h1"), "modelB", vec(0, 1));
      const got = sc.get(hash("h1"));
      expect(got?.modelId).toBe("modelB");
      expect(Array.from(got?.vec ?? [])).toEqual([0, 1]);
    });

    it("topK ranks by cosine score descending", () => {
      const sc = make();
      sc.put(hash("exact"), "m", vec(1, 0));
      sc.put(hash("close"), "m", vec(0.9, 0.1));
      sc.put(hash("far"), "m", vec(0, 1));
      const results = sc.topK(vec(1, 0), "m", 3);
      expect(results.map((r) => String(r.contentHash))).toEqual(["exact", "close", "far"]);
      expect(results[0]?.score).toBeCloseTo(1, 6);
    });

    it("topK caps at k and k<=0 returns []", () => {
      const sc = make();
      sc.put(hash("a"), "m", vec(1, 0));
      sc.put(hash("b"), "m", vec(1, 0.01));
      sc.put(hash("c"), "m", vec(1, 0.02));
      expect(sc.topK(vec(1, 0), "m", 2)).toHaveLength(2);
      expect(sc.topK(vec(1, 0), "m", 0)).toEqual([]);
      expect(sc.topK(vec(1, 0), "m", -1)).toEqual([]);
    });

    it("a model_id MISMATCH is silently ignored — never cross-model compared", () => {
      const sc = make();
      // A vector minted by a different model that happens to be cosine-identical
      // must NOT appear in a topK scoped to "current" model.
      sc.put(hash("wrong-model"), "old-model", vec(1, 0));
      sc.put(hash("right-model"), "current-model", vec(1, 0));
      const results = sc.topK(vec(1, 0), "current-model", 10);
      expect(results.map((r) => String(r.contentHash))).toEqual(["right-model"]);
    });

    it("topK over an empty sidecar (or all-mismatched models) returns []", () => {
      const sc = make();
      expect(sc.topK(vec(1, 0), "m", 5)).toEqual([]);
      sc.put(hash("h"), "other", vec(1, 0));
      expect(sc.topK(vec(1, 0), "m", 5)).toEqual([]);
    });

    // Regression: vectorsidecar-topk-full-materialization. topK used to push EVERY
    // scored candidate into one array and run a full Array.prototype.sort before
    // slicing the top k (O(n) retained memory, O(n log n) time regardless of k).
    // The fix streams candidates through a bounded size-k min-heap (BoundedTopKHeap)
    // instead. This proves CORRECTNESS PARITY against an independent, deliberately
    // naive "score everything, full-sort, slice" baseline (the OLD algorithm,
    // reimplemented here only for comparison — production code never runs this path
    // anymore) over a large randomized set, for several values of k, on the REAL
    // backend's topK() — not a reimplementation of the algorithm under test.
    it("topK on a large randomized set matches a naive full-sort baseline, for several k", () => {
      const sc = make();
      const modelId = "large-set-model";
      const n = 4000;
      // Deterministic PRNG (mulberry32) so a failure is reproducible without
      // depending on Math.random's seed.
      let seed = 0x2f6e2b1;
      function rand(): number {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }

      const rows: Array<{ contentHash: ContentHash; vec: Float32Array }> = [];
      for (let i = 0; i < n; i++) {
        const v = vec(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
        const ch = hash(`row-${i}`);
        rows.push({ contentHash: ch, vec: v });
        sc.put(ch, modelId, v);
      }
      // A handful of deliberately duplicate scores (same vector, different hash) so
      // the tie-break (content_hash ascending) is actually exercised at scale.
      const dupeVec = vec(0.3, 0.6, 0.1, 0.2);
      for (const suffix of ["dupe-c", "dupe-a", "dupe-b"]) {
        const ch = hash(suffix);
        rows.push({ contentHash: ch, vec: dupeVec });
        sc.put(ch, modelId, dupeVec);
      }

      const query = vec(0.5, -0.2, 0.1, 0.9);

      // Independent naive baseline: score every row, full sort, slice — exactly the
      // PRE-FIX algorithm, reimplemented ONLY here as an oracle.
      function naiveTopK(k: number): string[] {
        const scored = rows.map((r) => ({
          contentHash: r.contentHash,
          score: cosineSimilarity(query, r.vec),
        }));
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return String(a.contentHash) < String(b.contentHash) ? -1 : 1;
        });
        return scored.slice(0, k).map((s) => String(s.contentHash));
      }

      for (const k of [1, 5, 50, 500, rows.length, rows.length + 100]) {
        const got = sc.topK(query, modelId, k).map((r) => String(r.contentHash));
        expect(got).toEqual(naiveTopK(k));
      }
    });
  });
}

sidecarBehavior("createMemoryVectorSidecar", () => createMemoryVectorSidecar());

describe("createSqliteVectorSidecar", () => {
  let sidecar: SqliteVectorSidecar | null = null;
  let dbPath = "";

  afterEach(() => {
    sidecar?.close();
    sidecar = null;
    if (dbPath !== "") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(dbPath + suffix, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      dbPath = "";
    }
  });

  sidecarBehavior(
    "(shared suite, owned path handle)",
    () => {
      dbPath = join(tmpdir(), `idb-vecsidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      sidecar = createSqliteVectorSidecar(dbPath);
      return sidecar;
    },
    () => {
      sidecar?.close();
      sidecar = null;
    },
  );

  it("persists across a close + reopen on the same path", () => {
    dbPath = join(tmpdir(), `idb-vecsidecar-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const first = createSqliteVectorSidecar(dbPath);
    first.put(hash("persist"), "m", vec(1, 2, 3, 4));
    first.close();

    const reopened = createSqliteVectorSidecar(dbPath);
    const got = reopened.get(hash("persist"));
    expect(got?.modelId).toBe("m");
    expect(Array.from(got?.vec ?? [])).toEqual([1, 2, 3, 4]);
    reopened.close();
    sidecar = null;
  });

  // Regression: vectorsidecar-unverified-wal. The owned-path constructor used to
  // `db.exec("PRAGMA journal_mode=WAL")` and trust it blindly (no read-back), and
  // the shared-handle path did NOTHING to verify the borrowed handle was already in
  // WAL mode — unlike `createSqliteStore`, which has always verified both. Confirms
  // the vector sidecar now enforces the identical crash-safety floor.
  describe("WAL verification (vectorsidecar-unverified-wal)", () => {
    it("an owned path handle is actually in WAL mode after construction", () => {
      dbPath = join(tmpdir(), `idb-vecsidecar-wal-owned-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      sidecar = createSqliteVectorSidecar(dbPath);
      const raw = new DatabaseSyncCtor(dbPath);
      const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe("wal");
      raw.close();
    });

    it("THROWS when a borrowed { db } handle is NOT already in WAL mode", () => {
      dbPath = join(tmpdir(), `idb-vecsidecar-wal-shared-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      const raw = new DatabaseSyncCtor(dbPath);
      try {
        // Deliberately do nothing else -- a fresh DatabaseSync defaults to a
        // rollback journal ("delete"), not WAL.
        const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        expect(mode.journal_mode.toLowerCase()).not.toBe("wal");
        expect(() => createSqliteVectorSidecar({ db: raw })).toThrow(SharedHandleNotWalError);
      } finally {
        raw.close();
      }
    });

    it("succeeds over a { db } handle once the owner has set it to WAL mode", () => {
      dbPath = join(tmpdir(), `idb-vecsidecar-wal-shared-good-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      const raw = new DatabaseSyncCtor(dbPath);
      raw.exec("PRAGMA journal_mode=WAL");
      const shared = createSqliteVectorSidecar({ db: raw });
      shared.put(hash("h"), "m", vec(1, 2));
      expect(shared.get(hash("h"))?.modelId).toBe("m");
      raw.close();
    });

    it("succeeds over a :memory: shared handle (non-durable by design, legitimately reports 'memory')", () => {
      const raw = new DatabaseSyncCtor(":memory:");
      const shared = createSqliteVectorSidecar({ db: raw });
      shared.put(hash("h"), "m", vec(1, 2));
      expect(shared.get(hash("h"))?.modelId).toBe("m");
      raw.close();
    });
  });
});
