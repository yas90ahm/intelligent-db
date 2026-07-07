/**
 * reinforcementSummation.test.ts — Phase-1 retrieval spec §4a: reinforcement-by-
 * summation (flagged, `WalkConfig.reinforcement`), and its termination bound.
 *
 * Built directly on `activationWalk` over hand-built strands/edges (mirrors
 * `unresolvedSeeds.test.ts`'s low-level harness) so the reinforcement/clamp math
 * is exercised without any identity/engine machinery in the way.
 *
 * Cases:
 *   1. DEFAULT (`reinforcement` omitted) is byte-for-byte the pre-existing
 *      dominance behavior — a regression pin proving the flag changes NOTHING
 *      when absent.
 *   2. SUMMATION genuinely reinforces: a strand receiving several convergent
 *      deliveries AFTER it already fired (which dominance mode silently drops)
 *      reports a HIGHER activation than dominance's single-path value.
 *   3. THE CLAMP: the reported activation never exceeds `summationCap × max
 *      single-path delivery` — proven by a fan-in graph whose UNCLAMPED sum
 *      would be far larger, and re-proven insensitive to adding MORE converging
 *      parents (the clamp, not the count of paths, bounds the result).
 *   4. TERMINATION over a genuine CYCLE: a ring graph still halts (finite
 *      popCount, never TRUNCATED) because firing is still exactly-once per
 *      strand in EITHER mode — only the reported activation differs.
 *   5. THE GEOMETRIC BOUND: total dispensed (lit) energy across the whole walk
 *      never exceeds `Σ seed energy / (1 - gamma)` — the infinite gamma-
 *      geometric series ceiling — in either mode.
 *   6. Wave-3 `summation-double-count`: a strand reachable from the SAME pop via
 *      BOTH a materialized edge AND the derived shared-entity (virtual sibling)
 *      channel is delivered to exactly ONCE per pop, not twice.
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
  Strand,
  StrandId,
  StrandStore,
  Unit,
  WalkConfig,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

/** A bare strand with NO edges/provenance beyond what a test wires up itself. */
function bareStrand(id: StrandId, entity: EntityId): Strand {
  return {
    id,
    entity,
    attribute: null,
    payload: { id: String(id) },
    content_hash: ("hash:" + String(id)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
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
  };
}

/**
 * Put a strand in its OWN distinct entity, so the walk's derived shared-entity
 * fan-out never adds extra connectivity these tests don't ask for (every node
 * gets a unique `entity:` so `strandsByEntity` returns exactly itself).
 */
function putIsolated(store: StrandStore, id: StrandId): void {
  store.putStrand(bareStrand(id, ("entity:" + String(id)) as EntityId));
}

/** Wire a single directed edge of weight 1 (link_confidence=recency=provenance_independence=1). */
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

const GAMMA = DEFAULT_WALK_CONFIG.gamma; // 0.6

describe("reinforcement-by-summation (Phase-1 retrieval spec §4a)", () => {
  it("DEFAULT (reinforcement omitted) is byte-for-byte dominance — regression pin", () => {
    const store = createMemoryStore();
    const c = asStrandId("strand:c");
    const s1 = asStrandId("strand:s1");
    putIsolated(store, c);
    putIsolated(store, s1);
    wireEdge(store, s1, c);
    store.recomputeOutWeightSum(s1);

    const result = activationWalk(
      store,
      [
        { strandId: c, energy: 1 },
        { strandId: s1, energy: 0.99 },
      ],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    const cLit = result.lit.find((l) => l.strandId === c);
    // c fires FIRST at its own seed energy (1); s1's later delivery to c
    // (0.99 * 1 * gamma) is silently dropped by dominance — c stays at 1.
    expect(cLit?.activation).toBe(1);
  });

  it("SUMMATION reinforces: post-fire convergent deliveries raise the reported activation above dominance's value", () => {
    const store = createMemoryStore();
    const c = asStrandId("strand:c");
    const s1 = asStrandId("strand:s1");
    const s2 = asStrandId("strand:s2");
    const s3 = asStrandId("strand:s3");
    for (const id of [c, s1, s2, s3]) putIsolated(store, id);
    for (const s of [s1, s2, s3]) {
      wireEdge(store, s, c);
      store.recomputeOutWeightSum(s);
    }

    const seeds = [
      { strandId: c, energy: 1 }, // fires FIRST (highest energy) => "already fired" target
      { strandId: s1, energy: 0.99 },
      { strandId: s2, energy: 0.99 },
      { strandId: s3, energy: 0.99 },
    ];

    const dominance = activationWalk(
      store,
      seeds.map((s) => ({ ...s })),
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );
    const summationConfig: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement: "summation" };
    const summation = activationWalk(
      store,
      seeds.map((s) => ({ ...s })),
      summationConfig,
      createHaltingController(summationConfig),
    );

    const cDominance = dominance.lit.find((l) => l.strandId === c)?.activation ?? 0;
    const cSummation = summation.lit.find((l) => l.strandId === c)?.activation ?? 0;

    expect(cDominance).toBe(1); // unaffected by the 3 convergent post-fire deliveries
    expect(cSummation).toBeGreaterThan(cDominance); // summation actually reinforced it
  });

  it("THE CLAMP: reported activation never exceeds summationCap × max single delivery, regardless of fan-in count", () => {
    const build = (fanIn: number): { store: StrandStore; c: StrandId; seeds: { strandId: StrandId; energy: number }[] } => {
      const store = createMemoryStore();
      const c = asStrandId("strand:c");
      putIsolated(store, c);
      const seeds = [{ strandId: c, energy: 1 }];
      for (let i = 0; i < fanIn; i++) {
        const s = asStrandId(`strand:fan${i}`);
        putIsolated(store, s);
        wireEdge(store, s, c);
        store.recomputeOutWeightSum(s);
        seeds.push({ strandId: s, energy: 0.99 });
      }
      return { store, c, seeds };
    };

    const runSummation = (fanIn: number, cap: number): number => {
      const { store, c, seeds } = build(fanIn);
      const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement: "summation", summationCap: cap };
      const result = activationWalk(store, seeds, config, createHaltingController(config));
      return result.lit.find((l) => l.strandId === c)?.activation ?? 0;
    };

    // Each parent delivers 0.99 * 1 * gamma ≈ 0.594 to c; max single delivery to c
    // is the seed's own 1. cap = 2.0 * 1 = 2.0.
    const per = 0.99 * 1 * GAMMA;
    const cap = 2.0;

    // 3 parents: UNCLAMPED sum would be 1 + 3*per ≈ 2.782 > cap => clamp engages.
    const with3 = runSummation(3, cap);
    expect(with3).toBeCloseTo(cap, 6);
    expect(1 + 3 * per).toBeGreaterThan(cap); // sanity: the naive sum really would exceed the cap

    // 10 parents: UNCLAMPED sum would be MUCH larger (~6.94), yet the clamped
    // result is IDENTICAL to the 3-parent case — the cap, not the path count,
    // bounds the activation (cycle/fan-in amplification is structurally capped).
    const with10 = runSummation(10, cap);
    expect(with10).toBeCloseTo(cap, 6);
    expect(1 + 10 * per).toBeGreaterThan(1 + 3 * per);

    // A genuine single-path delivery (no fan-in) is NEVER clamped — the cap only
    // bites when the sum actually exceeds it.
    const with0 = runSummation(0, cap);
    expect(with0).toBe(1);
  });

  it("TERMINATION over a genuine CYCLE: a ring still halts, finite popCount, never TRUNCATED", () => {
    const store = createMemoryStore();
    const ringSize = 5;
    const ring = Array.from({ length: ringSize }, (_, i) => asStrandId(`strand:ring${i}`));
    for (const id of ring) putIsolated(store, id);
    for (let i = 0; i < ringSize; i++) {
      wireEdge(store, ring[i]!, ring[(i + 1) % ringSize]!);
      store.recomputeOutWeightSum(ring[i]!);
    }

    const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement: "summation" };
    const result = activationWalk(
      store,
      [{ strandId: ring[0]!, energy: 1 }],
      config,
      createHaltingController(config),
    );

    // Every ring node fired exactly once (fired-once bounds re-expansion
    // regardless of mode) — the cycle's return delivery to ring[0] is recorded
    // (summation) but never re-expands it. Never a hard-backstop truncation.
    expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    expect(result.halt.degraded).toBe(false);
    expect(result.halt.popCount).toBeLessThanOrEqual(ringSize + 1);
    expect(result.lit.map((l) => l.strandId).sort()).toEqual([...ring].sort());
  });

  it("THE GEOMETRIC BOUND: total dispensed energy never exceeds Σ(seed energy) / (1 - gamma)", () => {
    // A denser convergent graph: a "hub" c fed by several parents, each parent
    // ALSO fed by its own predecessor — several hops of decay plus fan-in.
    const store = createMemoryStore();
    const c = asStrandId("strand:hub");
    putIsolated(store, c);
    const seeds: { strandId: StrandId; energy: number }[] = [{ strandId: c, energy: 1 }];
    for (let i = 0; i < 6; i++) {
      const p1 = asStrandId(`strand:p1_${i}`);
      const p2 = asStrandId(`strand:p2_${i}`);
      putIsolated(store, p1);
      putIsolated(store, p2);
      wireEdge(store, p2, p1);
      wireEdge(store, p1, c);
      store.recomputeOutWeightSum(p2);
      store.recomputeOutWeightSum(p1);
      seeds.push({ strandId: p2, energy: 1 });
    }

    const totalSeedEnergy = seeds.reduce((sum, s) => sum + s.energy, 0);
    const bound = totalSeedEnergy / (1 - GAMMA);

    for (const reinforcement of ["dominance", "summation"] as const) {
      const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement };
      const result = activationWalk(
        store,
        seeds.map((s) => ({ ...s })),
        config,
        createHaltingController(config),
      );
      const totalDispensed = result.lit.reduce((sum, l) => sum + l.activation, 0);
      expect(totalDispensed).toBeLessThanOrEqual(bound);
      expect(result.halt.reason).not.toBe(ReasonCode.TRUNCATED);
    }
  });

  it("Wave-3 [summation-double-count]: a target reachable via BOTH a materialized edge AND the virtual-sibling channel from the SAME pop is delivered to exactly ONCE", () => {
    const store = createMemoryStore();
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    // A and B share ONE entity (making B a virtual sibling of A) AND carry a
    // real materialized edge A->B — the exact double-reachability shape the
    // finding describes.
    const entity = "entity:shared" as EntityId;
    store.putStrand(bareStrand(a, entity));
    store.putStrand(bareStrand(b, entity));
    wireEdge(store, a, b);
    store.recomputeOutWeightSum(a);

    const config: WalkConfig = { ...DEFAULT_WALK_CONFIG, reinforcement: "summation" };
    const result = activationWalk(
      store,
      [{ strandId: a, energy: 1 }],
      config,
      createHaltingController(config),
    );

    const bLit = result.lit.find((l) => l.strandId === b)?.activation ?? 0;

    // Both channels compute the IDENTICAL per-channel delivery here (materialized
    // edge weight 1, virtual-sibling weight 1, one sibling ⇒ Σ_eff = 2 either
    // way): childEnergy = 1 * (1/2) * gamma = 0.3. A double-counting bug sums
    // BOTH deliveries (0.6, which the clamp — 2x the max single delivery, 0.6 —
    // would not even catch, making the bug invisible to the existing CLAMP
    // test); the fix records exactly ONE delivery (0.3).
    const perChannelDelivery = 1 * 0.5 * GAMMA;
    expect(bLit).toBeCloseTo(perChannelDelivery, 10);
    expect(bLit).toBeLessThan(2 * perChannelDelivery);
  });
});
