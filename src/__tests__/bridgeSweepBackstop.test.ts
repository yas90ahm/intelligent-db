/**
 * bridgeSweepBackstop.test.ts — regression for `bridge-sweep-backstop-frozen`
 * (HIGH, audit finding #2 in `audit-engine-core-verified.md`).
 *
 * THE BUG: `traversal/walk.ts`'s phase-2 mandatory bridge sweep built ONE
 * `HaltContext` before the sweep loop and reused it BY REFERENCE across every
 * `nextBridgeCrossing(sweepCtx)` call. `HaltContext.now` never changed (frozen at
 * whatever the last LOCAL-phase pop's timestamp was), and `onPop` — the only place
 * `TwoPhaseHaltingController.popCount` advances — is never called during the
 * bridge loop (only `nextBridgeCrossing`/`recordCrossingYield` are, per the
 * documented drive loop). So the HARD BACKSTOP's absolute pop-cap AND wall-clock
 * checks (`backstopTripped`, reading frozen `ctx.now`/`this.popCount`) could never
 * trip during phase 2 — the documented "hard backstop (pop-cap / wall-clock ->
 * TRUNCATED)" was dead code for the entire bridge sweep, even though the SEPARATE
 * ~20% `bridgeBudgetTotal` sub-budget and the zero-yield circuit breaker still
 * bounded it by OTHER means (so this was a real contract violation / missing
 * defense-in-depth layer, not an actual infinite loop).
 *
 * THE FIX: `walk.ts` now rebuilds the sweep context EVERY iteration with a FRESH
 * `now` reading (`asEpochMs(Date.now())`), and `halting.ts`'s `nextBridgeCrossing`
 * now advances the SAME `popCount` field the local phase's `onPop` does, once per
 * crossing dispatched — making the absolute pop-cap a genuine whole-walk ceiling
 * across BOTH phases, not just phase 1.
 *
 * THIS TEST proves the pop-cap dimension specifically (deterministic — no
 * wall-clock timing dependency): a pathological graph with FAR MORE lit,
 * un-crossed bridges (20) than the configured absolute `popCap` (5) allows, with
 * `bridgeBudgetFraction: 1` so the SEPARATE sub-budget is numerically equal to
 * `popCap` and would NOT be the first thing to trip if the absolute backstop is
 * dead (pre-fix: `bridgePopsConsumed` alone reaches `bridgeBudgetTotal` after 5
 * crossings -> BRIDGE_STARVED; post-fix: the shared `popCount` — seeded at 1 by
 * the local seed pop — reaches `popCap` after only 4 crossings, so the ABSOLUTE
 * backstop trips FIRST -> TRUNCATED). Every far strand carries a distinct,
 * never-before-seen independence class so every crossing yields positive
 * corroboration (the zero-yield circuit breaker never fires and cannot be the
 * thing that stops the sweep) — isolating the hard backstop as the sole cause.
 *
 * Runs through the real, unmodified `db.recall(...)` engine entrypoint (which
 * drives the real `activationWalk` + `TwoPhaseHaltingController`), never a
 * hand-rolled unit test of the controller in isolation.
 */

import { describe, expect, it } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  AnchorClass,
  EdgeType,
  FactOrigin,
  FactState,
  ReasonCode,
  Tier,
  asEdgeId,
  asEpochMs,
  asStrandId,
  computeEdgeWeight,
  DEFAULT_WALK_CONFIG,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  Edge,
  EdgeId,
  EntityId,
  EpochMs,
  ProvenanceRoot,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRef,
  SourceRegistryPort,
  StakeLedgerPort,
  Strand,
  Unit,
  WalkConfig,
} from "../index.js";

// --- minimal in-test identity ports (recall's walk never reads identity, but
//     createIntelligentDb requires a SourceIdentityLayer to construct) ----------

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: SourceRef): void {
      known.add(p.sourceId);
    },
    sourceIdOf(s: SourceId): SourceId | null {
      return known.has(s) ? s : null;
    },
    has(s: SourceId): boolean {
      return known.has(s);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(s: SourceId, anchors: readonly AnchorBinding[]): void {
      book.set(s, [...(book.get(s) ?? []), ...anchors]);
    },
    anchorsOf(s: SourceId): readonly AnchorBinding[] {
      return book.get(s) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween(): Unit {
      return 0 as Unit;
    },
  };
}

function makeIdentityLayer(): SourceIdentityLayer {
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 as Unit };
  const stake: StakeLedgerPort = { postedFor: () => 0 as Unit };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake,
  });
}

// --- hand-built strand/edge fixtures (mirrors smoke.test.ts's cross-web-bridge
//     test's `strandIn` helper — a full OBSERVED strand built by hand so distinct
//     strands can live in DISTINCT entities/independence classes) --------------

const AT: EpochMs = asEpochMs(1_700_000_000_000);

function strandIn(idRaw: string, entityRaw: string, cls: string): Strand {
  return {
    id: asStrandId(idRaw),
    entity: entityRaw as EntityId,
    attribute: null,
    payload: { note: idRaw },
    content_hash: idRaw as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
        independenceClass: cls as ProvenanceRoot["independenceClass"],
        sourceId: null,
        establishedAt: AT,
      },
    ],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: AT, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: AT,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

const NUM_BRIDGES = 20;

/**
 * Build ONE seed strand with NO local neighbors (so the local phase converges
 * immediately after popping just the seed — `popCount === 1` entering phase 2)
 * and `NUM_BRIDGES` distinct `CROSS_WEB_BRIDGE` edges to `NUM_BRIDGES` distinct
 * far strands, each in its OWN entity + independence class (every crossing
 * yields positive novelty, so the zero-yield circuit breaker never engages).
 */
function buildPathologicalBridgeGraph(): { store: ReturnType<typeof createMemoryStore>; seedId: Strand["id"] } {
  const store = createMemoryStore();
  const seed = strandIn("strand:seed", "entity:seed-web", "class:seed");

  const bridgeEdges: EdgeId[] = [];
  for (let i = 0; i < NUM_BRIDGES; i++) {
    const far = strandIn(`strand:far-${i}`, `entity:far-web-${i}`, `class:far-${i}`);
    const edgeId = asEdgeId(`edge:bridge-${i}`);
    const w = computeEdgeWeight(0.5 as Unit, 0.5 as Unit, 0.5 as Unit);
    const bridge: Edge = {
      id: edgeId,
      from: seed.id,
      to: far.id,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 0.5 as Unit,
      provenance_independence: 0.5 as Unit,
      recency: 0.5 as Unit,
      w,
      out_weight_sum: w,
    };
    store.putStrand({ ...far, inEdges: [edgeId] });
    store.putEdge(bridge);
    bridgeEdges.push(edgeId);
  }
  store.putStrand({ ...seed, outEdges: bridgeEdges });
  store.recomputeOutWeightSum(seed.id);

  return { store, seedId: seed.id };
}

describe("bridge-sweep-backstop-frozen: the hard backstop fires during phase 2, not just phase 1", () => {
  it("a pathological bridge graph (20 lit bridges) trips the ABSOLUTE pop-cap backstop mid-sweep -> TRUNCATED, not a silent stop, not a full sweep", () => {
    const { store, seedId } = buildPathologicalBridgeGraph();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    // popCap=5 with bridgeBudgetFraction=1 makes the SEPARATE sub-budget
    // (bridgeBudgetTotal = round(5*1) = 5) numerically equal to the absolute
    // cap — so if the absolute backstop's popCount never advances during the
    // sweep (the pre-fix bug), the sub-budget alone would be the first (and
    // only) thing to trip, after a full 5 crossings, stamped BRIDGE_STARVED.
    // Post-fix, popCount starts at 1 (the local seed pop) and advances once per
    // dispatched crossing, so it reaches popCap after only 4 crossings — ONE
    // sooner than the sub-budget alone would allow — tripping the ABSOLUTE
    // backstop first, stamped TRUNCATED. A large wallClockMs/breaker keeps
    // those two OTHER mechanisms from being the thing that stops this run, so
    // TRUNCATED here can only be explained by the pop-cap fix.
    const config: WalkConfig = {
      ...DEFAULT_WALK_CONFIG,
      popCap: 5,
      bridgeBudgetFraction: 1,
      wallClockMs: 60_000,
      bridgeZeroYieldBreaker: NUM_BRIDGES + 1,
    };

    const result = db.recall({ seeds: [{ strandId: seedId, energy: 1 }], config });

    // THE BACKSTOP FIRED: TRUNCATED, not BRIDGE_STARVED (the pre-fix outcome)
    // and not a clean BRIDGE_SWEEP_CLEAR (which would mean it processed all 20
    // — proof the sweep was actually bounded by something, not just running out
    // of graph).
    expect(result.halt.reason).toBe(ReasonCode.TRUNCATED);
    expect(result.halt.degraded).toBe(true);

    // The walk TERMINATED (this assertion running at all proves it didn't
    // hang) with an honest, non-silent stamp — never invented, per
    // "halting fails open" (CLAUDE.md).
    expect(result.halt.popCount).toBe(5);

    // Proof the sweep was cut SHORT, not completed: far fewer than the 20
    // pending bridges were actually crossed.
    expect(result.halt.bridgesCrossed).toBeLessThan(NUM_BRIDGES);
    expect(result.halt.bridgesCrossed).toBe(4);
  });

  it("control: the SAME graph with a popCap large enough to finish cleanly reports BRIDGE_SWEEP_CLEAR with all 20 bridges crossed (the fix doesn't over-trip)", () => {
    const { store, seedId } = buildPathologicalBridgeGraph();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const config: WalkConfig = {
      ...DEFAULT_WALK_CONFIG,
      popCap: 1000,
      bridgeBudgetFraction: 1,
      wallClockMs: 60_000,
      bridgeZeroYieldBreaker: NUM_BRIDGES + 1,
    };

    const result = db.recall({ seeds: [{ strandId: seedId, energy: 1 }], config });

    expect(result.halt.reason).toBe(ReasonCode.BRIDGE_SWEEP_CLEAR);
    expect(result.halt.degraded).toBe(false);
    expect(result.halt.bridgesCrossed).toBe(NUM_BRIDGES);
  });
});
