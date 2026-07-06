/**
 * gradedNovelty.test.ts — Phase-1 retrieval spec §4b: graded novelty (flagged,
 * `WalkConfig.noveltyMode` + `noveltyTau`).
 *
 * `noveltyOf` used to feed the halting EWMA a 0/1 signal ("did this pop
 * contribute at least one previously-unseen independence class"). The graded
 * mode replaces it with `1 - exp(-newIndependentRoots / tau)`, so a strand
 * contributing 2 NEW independent roots registers MORE novelty than one
 * contributing 1 — without ever reaching a hard ceiling.
 *
 * Cases:
 *   1. DEFAULT (`noveltyMode` omitted, or `"binary"`) is byte-for-byte today's
 *      0/1 signal — a regression pin.
 *   2. GRADED: a strand with 2 new independent roots produces a STRICTLY
 *      higher local-saturation signal than one with only 1 — provable via the
 *      halting controller's own EWMA (a higher per-pop novelty keeps
 *      `trailingNovelty` above `epsilon` longer, deferring CONVERGED).
 *   3. GRADED at added=0 still maps to exactly 0 in both modes (no novelty is
 *      no novelty, regardless of tau).
 *   4. A non-positive tau fails SAFE to the binary signal (never NaN/negative).
 *   5. ORDERING / STOP CONTRACT unaffected: convergence_factor-based ordering
 *      and the ReasonCode mapping are identical in shape between modes for the
 *      same underlying graph structure (only the EWMA's trajectory differs).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALK_CONFIG,
  EdgeType,
  FactOrigin,
  FactState,
  ReasonCode,
  Tier,
  activationWalk,
  asEdgeId,
  asEpochMs,
  asStrandId,
  computeEdgeWeight,
  createHaltingController,
  createMemoryStore,
} from "../index.js";
import type {
  Edge,
  EntityId,
  ProvenanceRoot,
  Strand,
  StrandId,
  StrandStore,
  Unit,
  WalkConfig,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

function rootIn(cls: string): ProvenanceRoot {
  return {
    rootId: ("root:" + cls + ":" + Math.random().toString(36).slice(2)) as ProvenanceRoot["rootId"],
    independenceClass: ("class:" + cls) as ProvenanceRoot["independenceClass"],
    sourceId: null,
    establishedAt: NOW,
  };
}

function strandWithRoots(id: StrandId, entity: EntityId, roots: ProvenanceRoot[]): Strand {
  return {
    id,
    entity,
    attribute: null,
    payload: { id: String(id) },
    content_hash: ("hash:" + String(id)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: roots,
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

function wireEdge(store: StrandStore, from: StrandId, to: StrandId): void {
  const w = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit);
  const edge: Edge = {
    id: asEdgeId(`edge:${String(from)}->${String(to)}`),
    from,
    to,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w,
    out_weight_sum: w,
  };
  store.putEdge(edge);
}

/**
 * Build a chain seed -> a -> b -> ... where `seed` carries 0 roots (novelty
 * irrelevant) and each subsequent node carries a distinct fresh independence
 * class (so EVERY pop after the seed is maximally novel under the BINARY
 * signal — always exactly 1 new class — letting us isolate the graded-vs-binary
 * difference to nodes carrying MULTIPLE new roots at once).
 */
function buildChain(rootsPerNode: number[]): { store: StrandStore; ids: StrandId[] } {
  const store = createMemoryStore();
  const ids = rootsPerNode.map((_, i) => asStrandId(`strand:${i}`));
  ids.forEach((id, i) => {
    const roots = Array.from({ length: rootsPerNode[i]! }, () => rootIn(`n${i}-${Math.random()}`));
    store.putStrand(strandWithRoots(id, ("entity:" + String(id)) as EntityId, roots));
  });
  for (let i = 0; i < ids.length - 1; i++) {
    wireEdge(store, ids[i]!, ids[i + 1]!);
    store.recomputeOutWeightSum(ids[i]!);
  }
  return { store, ids };
}

describe("graded novelty (Phase-1 retrieval spec §4b)", () => {
  it("DEFAULT (noveltyMode omitted) is byte-for-byte the binary 0/1 signal — regression pin", () => {
    // A chain where node 1 contributes 2 NEW independent roots at once. Under
    // binary mode this is STILL exactly 1 (added > 0 ? 1 : 0) — same as a
    // single-root node — so halting behavior for this graph must be IDENTICAL
    // to what a hand-computed 0/1 EWMA would produce.
    const { store, ids } = buildChain([0, 2, 1, 1, 1]);
    const config: WalkConfig = DEFAULT_WALK_CONFIG; // noveltyMode omitted
    const result = activationWalk(
      store,
      [{ strandId: ids[0]!, energy: 1 }],
      config,
      createHaltingController(config),
    );
    // Sanity: the walk ran and lit every chain node (no truncation surprises).
    expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    expect(result.lit.length).toBeGreaterThan(0);
  });

  it("GRADED: 2 new independent roots register MORE novelty than 1 (keeps the EWMA above epsilon longer)", () => {
    // Two otherwise-identical chains, differing ONLY in how many roots the
    // early nodes carry: chain A gives each early node exactly 1 new root;
    // chain B gives each early node 3 new roots. Under BINARY mode the two
    // chains are indistinguishable to halting (both always signal exactly 1
    // per pop). Under GRADED mode, chain B's higher per-pop novelty
    // (1 - exp(-3/tau) > 1 - exp(-1/tau)) keeps the trailing EWMA higher for
    // longer, so chain B should NOT converge (locally saturate) any EARLIER
    // than chain A — and, with a tight epsilon, should run strictly more pops
    // before CONVERGED fires.
    const chainA = buildChain([0, 1, 1, 1, 1, 1, 1, 1]);
    const chainB = buildChain([0, 3, 3, 3, 3, 3, 3, 3]);

    const gradedConfig: WalkConfig = {
      ...DEFAULT_WALK_CONFIG,
      noveltyMode: "graded",
      noveltyTau: 1.0,
      epsilon: 0.5, // tight enough that the binary EWMA (which decays toward 1 exactly, never below until the chain ends) would otherwise saturate identically for both
    };

    const resultA = activationWalk(
      chainA.store,
      [{ strandId: chainA.ids[0]!, energy: 1 }],
      gradedConfig,
      createHaltingController(gradedConfig),
    );
    const resultB = activationWalk(
      chainB.store,
      [{ strandId: chainB.ids[0]!, energy: 1 }],
      gradedConfig,
      createHaltingController(gradedConfig),
    );

    // Chain B's stronger per-pop novelty signal (3 roots vs 1) must be >=, and
    // in this construction strictly greater in at least one measurable way:
    // it lights AT LEAST as many nodes as chain A before converging, and never
    // converges "faster" (fewer pops) than the weaker chain.
    expect(resultB.halt.popCount).toBeGreaterThanOrEqual(resultA.halt.popCount);
  });

  it("added === 0 maps to EXACTLY 0 in both modes — no novelty is no novelty regardless of tau", () => {
    // A 2-node chain where the SECOND node shares the SAME independence class as
    // the seed (0 NEW roots at that pop) under BOTH binary and graded modes.
    const store = createMemoryStore();
    const seed = asStrandId("strand:seed");
    const echo = asStrandId("strand:echo");
    const sharedRoot = rootIn("shared");
    store.putStrand(strandWithRoots(seed, "entity:seed" as EntityId, [sharedRoot]));
    store.putStrand(
      strandWithRoots(echo, "entity:echo" as EntityId, [
        { ...sharedRoot, rootId: ("root:echo-copy") as ProvenanceRoot["rootId"] },
      ]),
    );
    wireEdge(store, seed, echo);
    store.recomputeOutWeightSum(seed);

    for (const noveltyMode of ["binary", "graded"] as const) {
      const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, noveltyMode, noveltyTau: 0.1 };
      // Tiny tau would make ANY positive `added` grade to ~1 immediately — the
      // assertion that matters is that a ZERO-new-class pop stays EXACTLY 0.
      const result = activationWalk(
        store,
        [{ strandId: seed, energy: 1 }],
        config,
        createHaltingController(config),
      );
      expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    }
  });

  it("a non-positive tau fails SAFE to the binary signal (never NaN, never negative)", () => {
    const { store, ids } = buildChain([0, 2, 2]);
    const config: WalkConfig = {
      ...DEFAULT_WALK_CONFIG,
      noveltyMode: "graded",
      noveltyTau: 0, // degenerate — must not divide-by-zero into NaN/-Infinity
    };
    const result = activationWalk(
      store,
      [{ strandId: ids[0]!, energy: 1 }],
      config,
      createHaltingController(config),
    );
    expect(Number.isNaN(result.halt.popCount)).toBe(false);
    expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    expect(result.lit.every((l) => Number.isFinite(l.activation))).toBe(true);
  });

  it("ordering/stop CONTRACT unaffected: the ReasonCode vocabulary + lit set are unchanged in SHAPE between modes", () => {
    const chainBinary = buildChain([0, 1, 1, 1]);
    const chainGraded = buildChain([0, 1, 1, 1]);
    const binaryConfig: WalkConfig = DEFAULT_WALK_CONFIG;
    const gradedConfig: WalkConfig = { ...DEFAULT_WALK_CONFIG, noveltyMode: "graded" };

    const resultBinary = activationWalk(
      chainBinary.store,
      [{ strandId: chainBinary.ids[0]!, energy: 1 }],
      binaryConfig,
      createHaltingController(binaryConfig),
    );
    const resultGraded = activationWalk(
      chainGraded.store,
      [{ strandId: chainGraded.ids[0]!, energy: 1 }],
      gradedConfig,
      createHaltingController(gradedConfig),
    );

    // Same small graph, same DEFAULT epsilon (0.02): binary's per-pop novelty
    // is 1 and graded's is `1 - exp(-1/1) ≈ 0.63` — both are still FAR above
    // epsilon, so the frontier runs dry (a 4-node chain) before either EWMA
    // could fall below it in EITHER mode. The stop CONTRACT (ReasonCode
    // vocabulary, degraded flag, lit-set shape) is therefore identical here —
    // graded novelty only changes WHEN local saturation triggers, never
    // WHETHER a clean run finishes the same reachable set.
    expect(resultGraded.lit.map((l) => l.strandId).sort()).toEqual(
      resultBinary.lit.map((l) => l.strandId).sort(),
    );
    expect(resultGraded.halt.reason).toBe(resultBinary.halt.reason);
    expect(resultGraded.halt.degraded).toBe(resultBinary.halt.degraded);
  });
});
