/**
 * presentationRank.test.ts — Phase 1b Design §1-4 (docs/specs/PHASE1B_RANKING_SPEC.md).
 *
 * Covers exactly the invariants the spec's design section makes load-bearing:
 *   1. union-never-removes — buildUnionCandidateSet is strictly additive.
 *   2. walk-mode-unchanged — rankMode absent/'walk' is a byte-identical passthrough.
 *   3. stateWeight nudge ordering — LIVE > PROVISIONAL > DEMOTED at equal cosine/energy.
 *   4. blend score math — the exact wCos/wWalk/wState arithmetic, incl. min-max
 *      normalization of walk energy across the candidate set.
 * Plus a real store+vectors integration test for the §2 union term (the
 * diagnostic-flagged primary lever: widening `unionTopN` widens coverage).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  FactState,
  asStrandId,
  createMemoryStore,
  createMemoryVectorSidecar,
  createSqliteStore,
  createSqliteVectorSidecar,
  buildUnionCandidateSet,
  scorePresentation,
  rankForPresentation,
  stateWeightOf,
  cosineTopNCandidates,
  rankRecallResult,
  DEFAULT_PRESENTATION_WEIGHTS,
  DEFAULT_UNION_TOP_N,
  STATE_WEIGHT,
} from "../index.js";
import type {
  ContentHash,
  EntityId,
  RecallResult,
  WalkLitCandidate,
  CosineCandidate,
  StrandStore,
  VectorSidecar,
} from "../index.js";
import { makeStrand } from "../__bench__/fixtures.js";

function wlc(
  idRaw: string,
  hash: string,
  factState: FactState,
  walkEnergy: number,
): WalkLitCandidate {
  return {
    strandId: asStrandId(idRaw),
    contentHash: hash as ContentHash,
    factState,
    walkEnergy,
  };
}

function cc(idRaw: string, hash: string, factState: FactState, cosine: number): CosineCandidate {
  return {
    strandId: asStrandId(idRaw),
    contentHash: hash as ContentHash,
    factState,
    cosine,
  };
}

// ---------------------------------------------------------------------------
// 1) union-never-removes
// ---------------------------------------------------------------------------

describe("buildUnionCandidateSet — union only ADDS, never removes or restates", () => {
  it("keeps every walk-lit candidate verbatim, and adds genuinely new content_hash matches", () => {
    const walkLit = [
      wlc("a", "h1", FactState.LIVE, 5),
      wlc("b", "h2", FactState.PROVISIONAL, 2),
    ];
    const cosineTopN = [
      // matches an EXISTING content_hash (h1) under a DIFFERENT strand id — must
      // NOT create a duplicate entry; only annotate the existing candidate.
      cc("a-echo", "h1", FactState.LIVE, 0.95),
      // a genuinely NEW content_hash the walk never surfaced — must be ADDED.
      cc("c", "h3", FactState.DEMOTED, 0.6),
    ];

    const union = buildUnionCandidateSet(walkLit, cosineTopN);

    // Never fewer than the walk's own candidates (never removes).
    expect(union.length).toBe(3);

    const byHash = new Map(union.map((u) => [String(u.contentHash), u]));

    // h1: walk's own strandId/factState/walkEnergy/litByWalk are UNCHANGED
    // (never re-stated), cosine is now annotated from the union match.
    const h1 = byHash.get("h1")!;
    expect(String(h1.strandId)).toBe("a");
    expect(h1.factState).toBe(FactState.LIVE);
    expect(h1.walkEnergy).toBe(5);
    expect(h1.litByWalk).toBe(true);
    expect(h1.cosine).toBe(0.95);

    // h2: untouched — no cosine match landed on it.
    const h2 = byHash.get("h2")!;
    expect(h2.factState).toBe(FactState.PROVISIONAL);
    expect(h2.walkEnergy).toBe(2);
    expect(h2.litByWalk).toBe(true);
    expect(h2.cosine).toBe(0);

    // h3: brand-new, union-added-only candidate.
    const h3 = byHash.get("h3")!;
    expect(String(h3.strandId)).toBe("c");
    expect(h3.factState).toBe(FactState.DEMOTED);
    expect(h3.walkEnergy).toBe(0); // the walk never lit it
    expect(h3.litByWalk).toBe(false);
    expect(h3.cosine).toBe(0.6);
  });

  it("an empty cosineTopN leaves the walk set completely unchanged (identity union)", () => {
    const walkLit = [wlc("a", "h1", FactState.LIVE, 1), wlc("b", "h2", FactState.DEMOTED, 0.3)];
    const union = buildUnionCandidateSet(walkLit, []);
    expect(union).toHaveLength(2);
    expect(union.map((u) => String(u.strandId))).toEqual(["a", "b"]);
    for (const u of union) expect(u.cosine).toBe(0);
  });

  it("union candidates are monotonically non-decreasing in count as more cosine matches are added", () => {
    const walkLit = [wlc("a", "h1", FactState.LIVE, 1)];
    const small = buildUnionCandidateSet(walkLit, [cc("x", "h9", FactState.LIVE, 0.4)]);
    const bigger = buildUnionCandidateSet(walkLit, [
      cc("x", "h9", FactState.LIVE, 0.4),
      cc("y", "h10", FactState.LIVE, 0.3),
    ]);
    expect(bigger.length).toBeGreaterThanOrEqual(small.length);
    // every content_hash present in the smaller union is still present in the bigger one
    const smallHashes = new Set(small.map((c) => String(c.contentHash)));
    const bigHashes = new Set(bigger.map((c) => String(c.contentHash)));
    for (const h of smallHashes) expect(bigHashes.has(h)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) walk-mode-unchanged
// ---------------------------------------------------------------------------

describe("rankForPresentation — 'walk' mode is a byte-identical passthrough", () => {
  const walkLit = [
    wlc("c", "h3", FactState.LIVE, 0.4),
    wlc("a", "h1", FactState.DEMOTED, 9), // deliberately NOT energy-sorted
    wlc("b", "h2", FactState.PROVISIONAL, 3),
  ];
  // A cosine set that WOULD dramatically reorder things in blend mode (huge
  // cosine on a brand-new candidate) — walk mode must ignore it entirely.
  const cosineTopN = [cc("z", "h99", FactState.LIVE, 1.0)];

  it("rankMode absent: same strand order, energies, and no union/cosine leak", () => {
    const ranked = rankForPresentation(walkLit, cosineTopN);
    expect(ranked.map((r) => String(r.strandId))).toEqual(["c", "a", "b"]);
    for (const [i, r] of ranked.entries()) {
      expect(r.walkEnergy).toBe(walkLit[i]!.walkEnergy);
      expect(r.factState).toBe(walkLit[i]!.factState);
      expect(r.cosine).toBe(0);
      expect(r.litByWalk).toBe(true);
      expect(r.score).toBe(walkLit[i]!.walkEnergy);
    }
  });

  it("rankMode: 'walk' explicitly: identical to rankMode absent", () => {
    const implicit = rankForPresentation(walkLit, cosineTopN);
    const explicit = rankForPresentation(walkLit, cosineTopN, { rankMode: "walk" });
    expect(explicit).toEqual(implicit);
  });

  it("rankRecallResult: 'walk' mode (or no cosine deps) returns the RecallResult unchanged", () => {
    const store = createMemoryStore();
    const strand = makeStrand("s1", "entity:x" as EntityId, "src:1" as never, "cls:1", { text: "hi" });
    store.putStrand(strand);
    const result: RecallResult = {
      lit: [{ strandId: strand.id, activation: 0.42 }],
      halt: { reason: "CONVERGED", popCount: 1, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: false } as never,
      unresolvedSeeds: [],
      seedsResolved: 1,
    };

    // rankMode absent
    expect(rankRecallResult(store, result, null)).toEqual(result);
    // rankMode 'blend' requested but no cosine deps wired => fails OPEN to walk order
    expect(rankRecallResult(store, result, null, { rankMode: "blend" })).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// 3) stateWeight nudge ordering
// ---------------------------------------------------------------------------

describe("stateWeight — presentation nudge orders LIVE > PROVISIONAL > DEMOTED", () => {
  it("stateWeightOf reads the documented constants (1.0 / 0.85 / 0.4)", () => {
    expect(stateWeightOf(FactState.LIVE)).toBe(1.0);
    expect(stateWeightOf(FactState.PROVISIONAL)).toBe(0.85);
    expect(stateWeightOf(FactState.DEMOTED)).toBe(0.4);
    expect(STATE_WEIGHT[FactState.LIVE]).toBe(1.0);
    expect(STATE_WEIGHT[FactState.PROVISIONAL]).toBe(0.85);
    expect(STATE_WEIGHT[FactState.DEMOTED]).toBe(0.4);
  });

  it("an explicit override table wins over the built-in constants", () => {
    expect(stateWeightOf(FactState.PROVISIONAL, { [FactState.PROVISIONAL]: 0.99 })).toBe(0.99);
  });

  it("at IDENTICAL cosine and walk energy, blend mode ranks LIVE first, then PROVISIONAL, then DEMOTED", () => {
    // Equal walkEnergy across all three => normalizedWalkEnergy is identical for
    // all (min===max span=0 branch), and equal cosine via the union annotation
    // => the ONLY discriminator left is stateWeight.
    const walkLit = [
      wlc("live", "h-live", FactState.LIVE, 1),
      wlc("prov", "h-prov", FactState.PROVISIONAL, 1),
      wlc("demo", "h-demo", FactState.DEMOTED, 1),
    ];
    const cosineTopN = [
      cc("live", "h-live", FactState.LIVE, 0.5),
      cc("prov", "h-prov", FactState.PROVISIONAL, 0.5),
      cc("demo", "h-demo", FactState.DEMOTED, 0.5),
    ];

    const ranked = rankForPresentation(walkLit, cosineTopN, { rankMode: "blend" });
    expect(ranked.map((r) => String(r.strandId))).toEqual(["live", "prov", "demo"]);
    // scores strictly decreasing
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.score).toBeGreaterThan(ranked[2]!.score);
  });

  it("a PROVISIONAL flood cannot crowd out a LIVE incumbent purely on stateWeight ties", () => {
    // Many PROVISIONAL union-only candidates at high cosine, one LIVE walk-lit
    // candidate at a merely decent cosine — LIVE should still win when its
    // combined score (helped by wWalk + wState) beats the flood's wCos-only edge,
    // for a weight configuration that leans on state (documents the nudge's
    // purpose: "quarantined floods cannot crowd the top ranks").
    const walkLit = [wlc("incumbent", "h-incumbent", FactState.LIVE, 10)];
    const flood: CosineCandidate[] = [];
    for (let i = 0; i < 20; i++) {
      flood.push(cc(`attacker-${i}`, `h-attacker-${i}`, FactState.PROVISIONAL, 0.99));
    }
    const ranked = rankForPresentation(walkLit, flood, {
      rankMode: "blend",
      weights: { wCos: 0.3, wWalk: 0.3, wState: 0.4 },
    });
    expect(String(ranked[0]!.strandId)).toBe("incumbent");
  });
});

// ---------------------------------------------------------------------------
// 4) blend score math
// ---------------------------------------------------------------------------

describe("scorePresentation — exact blend score arithmetic", () => {
  it("matches wCos*cosine + wWalk*normalizedWalkEnergy + wState*stateWeight by hand", () => {
    const candidates = [
      { strandId: asStrandId("a"), contentHash: "h1" as ContentHash, factState: FactState.LIVE, walkEnergy: 0, cosine: 0.2, litByWalk: true },
      { strandId: asStrandId("b"), contentHash: "h2" as ContentHash, factState: FactState.PROVISIONAL, walkEnergy: 5, cosine: 0.8, litByWalk: true },
      { strandId: asStrandId("c"), contentHash: "h3" as ContentHash, factState: FactState.DEMOTED, walkEnergy: 10, cosine: 0.5, litByWalk: false },
    ];
    const weights = { wCos: 0.5, wWalk: 0.3, wState: 0.2 };
    const scored = scorePresentation(candidates, weights);

    // min-max normalization of walkEnergy across {0, 5, 10} => {0, 0.5, 1}.
    const expectedNormEnergy = [0, 0.5, 1];
    const expectedStateWeight = [1.0, 0.85, 0.4];

    scored.forEach((s, i) => {
      expect(s.normalizedWalkEnergy).toBeCloseTo(expectedNormEnergy[i]!, 10);
      expect(s.stateWeight).toBeCloseTo(expectedStateWeight[i]!, 10);
      const expectedScore =
        weights.wCos * candidates[i]!.cosine +
        weights.wWalk * expectedNormEnergy[i]! +
        weights.wState * expectedStateWeight[i]!;
      expect(s.score).toBeCloseTo(expectedScore, 10);
    });

    // Spot-check candidate b by hand: 0.5*0.8 + 0.3*0.5 + 0.2*0.85 = 0.4+0.15+0.17 = 0.72
    expect(scored[1]!.score).toBeCloseTo(0.72, 10);
  });

  it("a degenerate all-equal-energy set normalizes energy to 1 when energy > 0, else 0", () => {
    const equalPositive = scorePresentation([
      { strandId: asStrandId("a"), contentHash: "h1" as ContentHash, factState: FactState.LIVE, walkEnergy: 3, cosine: 0, litByWalk: true },
      { strandId: asStrandId("b"), contentHash: "h2" as ContentHash, factState: FactState.LIVE, walkEnergy: 3, cosine: 0, litByWalk: true },
    ]);
    expect(equalPositive[0]!.normalizedWalkEnergy).toBe(1);
    expect(equalPositive[1]!.normalizedWalkEnergy).toBe(1);

    const allZero = scorePresentation([
      { strandId: asStrandId("a"), contentHash: "h1" as ContentHash, factState: FactState.LIVE, walkEnergy: 0, cosine: 0, litByWalk: false },
    ]);
    expect(allZero[0]!.normalizedWalkEnergy).toBe(0);
  });

  it("default weights are the documented spec-grid midpoint (0.7 / 0.3 / 0.1)", () => {
    expect(DEFAULT_PRESENTATION_WEIGHTS).toEqual({ wCos: 0.7, wWalk: 0.3, wState: 0.1 });
  });

  it("rankForPresentation sorts blend-mode output by score descending, ties broken by strandId", () => {
    const walkLit = [wlc("z", "h1", FactState.LIVE, 1), wlc("a", "h2", FactState.LIVE, 1)];
    // Same cosine, same energy, same fact_state => identical scores => tie-break
    // must be deterministic (strandId ascending).
    const ranked = rankForPresentation(walkLit, [], { rankMode: "blend" });
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
    expect(ranked.map((r) => String(r.strandId))).toEqual(["a", "z"]);
  });
});

// ---------------------------------------------------------------------------
// 5) real store + vector sidecar integration — the §2 union term (N sweep)
// ---------------------------------------------------------------------------

describe("cosineTopNCandidates / rankRecallResult — real store + VectorSidecar integration", () => {
  function vec(...xs: number[]): Float32Array {
    return Float32Array.from(xs);
  }

  it("resolves content_hash matches back to live strands and skips stale (dangling) vectors", () => {
    const store = createMemoryStore();
    const vectors = createMemoryVectorSidecar();
    const modelId = "test-model";

    const s1 = makeStrand("s1", "entity:x" as EntityId, "src:1" as never, "cls:1", { text: "a" });
    store.putStrand(s1);
    vectors.put(s1.content_hash, modelId, vec(1, 0, 0));
    // A vector for a content_hash with NO backing strand (stale/evicted).
    vectors.put("hash:ghost" as ContentHash, modelId, vec(0, 1, 0));

    const matches = cosineTopNCandidates(store, vectors, modelId, vec(1, 0, 0), 10);
    expect(matches).toHaveLength(1);
    expect(String(matches[0]!.strandId)).toBe("s1");
    expect(matches[0]!.cosine).toBeCloseTo(1, 6);
  });

  it("widening unionTopN (the diagnostic-flagged primary lever) admits more coverage without dropping anything", () => {
    const store = createMemoryStore();
    const vectors = createMemoryVectorSidecar();
    const modelId = "test-model";

    // 5 strands whose vectors are progressively less aligned with the cue.
    const cue = vec(1, 0);
    const strands = [
      { id: "near1", v: vec(1, 0) },
      { id: "near2", v: vec(0.9, 0.1) },
      { id: "mid", v: vec(0.5, 0.5) },
      { id: "far1", v: vec(0.1, 0.9) },
      { id: "far2", v: vec(0, 1) },
    ];
    for (const s of strands) {
      const strand = makeStrand(s.id, "entity:x" as EntityId, "src:1" as never, "cls:1", { text: s.id });
      store.putStrand(strand);
      vectors.put(strand.content_hash, modelId, s.v);
    }

    const narrow = cosineTopNCandidates(store, vectors, modelId, cue, 1);
    const wide = cosineTopNCandidates(store, vectors, modelId, cue, DEFAULT_UNION_TOP_N);

    expect(narrow.length).toBe(1);
    expect(wide.length).toBe(strands.length); // N=64 > available vectors => all admitted
    // The narrow set is a SUBSET of the wide set's content hashes (union only adds).
    const wideHashes = new Set(wide.map((c) => String(c.contentHash)));
    for (const n of narrow) expect(wideHashes.has(String(n.contentHash))).toBe(true);
  });

  it("rankRecallResult blends the walk's lit set with a wider cosine union and never drops the lit strand", () => {
    const store = createMemoryStore();
    const vectors = createMemoryVectorSidecar();
    const modelId = "test-model";
    const cue = vec(1, 0);

    const lit = makeStrand("lit1", "entity:x" as EntityId, "src:1" as never, "cls:1", { text: "walk-lit" });
    store.putStrand(lit);
    vectors.put(lit.content_hash, modelId, vec(0, 1)); // orthogonal to the cue: weak cosine

    const strong = makeStrand("strong1", "entity:y" as EntityId, "src:2" as never, "cls:2", { text: "cosine-only" });
    store.putStrand(strong);
    vectors.put(strong.content_hash, modelId, vec(1, 0)); // perfectly aligned: the walk never lit it

    const baseResult: RecallResult = {
      lit: [{ strandId: lit.id, activation: 0.9 }],
      halt: { reason: "CONVERGED", popCount: 1, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: false } as never,
      unresolvedSeeds: [],
      seedsResolved: 1,
    };

    const blended = rankRecallResult(
      store,
      baseResult,
      { vectors, modelId, cueVector: cue },
      { rankMode: "blend" },
    );

    const ids = blended.lit.map((l) => String(l.strandId));
    expect(ids).toContain("lit1"); // never dropped (union never removes)
    expect(ids).toContain("strong1"); // union-added, even though the walk never lit it
    // halt/unresolvedSeeds/seedsResolved pass through unchanged.
    expect(blended.halt).toEqual(baseResult.halt);
    expect(blended.unresolvedSeeds).toEqual(baseResult.unresolvedSeeds);
    expect(blended.seedsResolved).toBe(baseResult.seedsResolved);
  });
});

// ---------------------------------------------------------------------------
// 6) STORE MATRIX — blend forced on, both backends (Phase 1b gate §1: "ALSO run
//    the store matrix once with blend forced on via test config"). Re-runs the
//    same rankRecallResult union/never-drop invariant over BOTH createMemoryStore()
//    and a real createSqliteStore()/createSqliteVectorSidecar() (WAL, on-disk),
//    proving blend mode's store integration is backend-agnostic, not just an
//    in-memory-store artifact.
// ---------------------------------------------------------------------------

describe("store matrix — rankRecallResult in blend mode over both backends", () => {
  function vec(...xs: number[]): Float32Array {
    return Float32Array.from(xs);
  }

  const tmpPaths: string[] = [];
  afterEach(() => {
    for (const p of tmpPaths.splice(0)) {
      try {
        rmSync(p, { force: true });
        rmSync(`${p}-wal`, { force: true });
        rmSync(`${p}-shm`, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  function backends(): Array<{ name: string; store: StrandStore; vectors: VectorSidecar }> {
    const dbPath = join(tmpdir(), `idb-presentationrank-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    tmpPaths.push(dbPath);
    return [
      { name: "memory", store: createMemoryStore(), vectors: createMemoryVectorSidecar() },
      { name: "sqlite", store: createSqliteStore(dbPath), vectors: createSqliteVectorSidecar(dbPath) },
    ];
  }

  for (const { name, store, vectors } of backends()) {
    it(`[${name}] rankMode='blend' widens the lit set without ever dropping the walk-lit strand`, () => {
      const modelId = "test-model";
      const cue = vec(1, 0);

      const lit = makeStrand("mlit1", "entity:x" as EntityId, "src:1" as never, "cls:1", { text: "walk-lit" });
      store.putStrand(lit);
      vectors.put(lit.content_hash, modelId, vec(0, 1)); // weak cosine to the cue

      const strong = makeStrand("mstrong1", "entity:y" as EntityId, "src:2" as never, "cls:2", { text: "cosine-only" });
      store.putStrand(strong);
      vectors.put(strong.content_hash, modelId, vec(1, 0)); // walk never lit this one

      const baseResult: RecallResult = {
        lit: [{ strandId: lit.id, activation: 0.9 }],
        halt: { reason: "CONVERGED", popCount: 1, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: false } as never,
        unresolvedSeeds: [],
        seedsResolved: 1,
      };

      // Forced-on test config: rankMode is NOT left to default — blend is
      // explicit, matching the gate's "blend forced on via test config" wording.
      const blended = rankRecallResult(store, baseResult, { vectors, modelId, cueVector: cue }, { rankMode: "blend" });

      const ids = blended.lit.map((l) => String(l.strandId));
      expect(ids).toContain("mlit1"); // union never removes the walk-lit strand
      expect(ids).toContain("mstrong1"); // union-added candidate present
      expect(blended.halt).toEqual(baseResult.halt);
      expect(blended.seedsResolved).toBe(baseResult.seedsResolved);
    });
  }
});
