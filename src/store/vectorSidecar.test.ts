/**
 * vectorSidecar.test.ts — proves the in-memory and SQLite vector sidecars are
 * faithful equals: put/get round-trip, cosine top-K ranking, model-id mismatch
 * is silently ignored (never cross-model-compared), and content_hash keying
 * means an echo (same hash, re-put) replaces rather than duplicates.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ContentHash } from "../core/types.js";
import {
  cosineSimilarity,
  createMemoryVectorSidecar,
  createSqliteVectorSidecar,
  type SqliteVectorSidecar,
  type VectorSidecar,
} from "./vectorSidecar.js";

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
});
