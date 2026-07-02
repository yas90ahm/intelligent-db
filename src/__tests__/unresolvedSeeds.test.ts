/**
 * unresolvedSeeds.test.ts — HONEST HALT when recall seeds do not resolve.
 *
 * THE BUG BEING PINNED: traversal/walk.ts silently `continue`d over any seed whose
 * strand was not in the store. When ALL seeds failed to resolve, the pop loop never
 * ran, the bridge sweep ran against a fabricated context, and the caller got
 * BRIDGE_SWEEP_CLEAR / popCount 0 / degraded false — indistinguishable from a
 * genuinely healthy empty answer. A stale-id cue is a DEGRADED outcome ("the cue
 * never touched the web"), not a clean one; halting's contract is "never a silent
 * stop".
 *
 * THE FIX (pure information-add, no traversal semantics change):
 *   - WalkResult gains REQUIRED `unresolvedSeeds` + `seedsResolved` fields,
 *     populated on every return path (and forwarded verbatim by engine recall).
 *   - seeds supplied but NONE resolved ⇒ skip the pop loop AND the bridge sweep,
 *     return ReasonCode.NO_SEEDS_RESOLVED with degraded: true.
 *   - an EMPTY seeds array stays the caller's legitimate no-op (regression-pinned).
 *
 * Cases:
 *   (a) one bad + one good seed ⇒ the walk proceeds normally; unresolvedSeeds
 *       names EXACTLY the bad id; seedsResolved === 1.
 *   (b) only bad seeds ⇒ reason === NO_SEEDS_RESOLVED, degraded === true, lit
 *       empty, popCount === 0 — and explicitly NOT BRIDGE_SWEEP_CLEAR.
 *   (c) empty seeds array ⇒ pre-fix behavior byte-for-byte (regression pin).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WALK_CONFIG,
  FactOrigin,
  FactState,
  ReasonCode,
  Tier,
  activationWalk,
  asEpochMs,
  asStrandId,
  createHaltingController,
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
} from "../index.js";

import type {
  AnchorBinding,
  AttributeKey,
  EntityId,
  SourceIdentityLayer,
  Strand,
  StrandId,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:seeds" as EntityId;
const ATTR = "seeds#claim" as AttributeKey;

function makeStrand(id: StrandId): Strand {
  return {
    id,
    entity: ENTITY,
    attribute: ATTR,
    payload: { id: String(id) },
    content_hash: ("hash:" + String(id)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + String(id)) as Strand["provenance"][number]["rootId"],
        independenceClass: ("class:" +
          String(id)) as Strand["provenance"][number]["independenceClass"],
        sourceId: null,
        establishedAt: NOW,
      },
    ],
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

/** Minimal identity layer — recall never consults it; the engine ctor requires one. */
function minimalIdentity(): SourceIdentityLayer {
  return createSourceIdentityLayer({
    sources: {
      register(): void {},
      sourceIdOf: () => null,
      has: () => false,
    },
    anchors: {
      bind(): void {},
      anchorsOf: (): readonly AnchorBinding[] => [],
      aggregateCost: (): Unit => 0,
      independenceBetween: (): Unit => 0,
    },
    reputation: { scoreOf: (): Unit => 0 },
    stake: { postedFor: () => 0 },
  });
}

describe("unresolved seeds — the cue's contact points are reported, never silently dropped", () => {
  it("(a) one bad + one good seed: the walk proceeds; unresolvedSeeds names exactly the bad id", () => {
    const store = createMemoryStore();
    const good = asStrandId("strand:good");
    const sibling = asStrandId("strand:sibling"); // same entity ⇒ reachable via the index fan
    const bad = asStrandId("strand:no-such");
    store.putStrand(makeStrand(good));
    store.putStrand(makeStrand(sibling));

    const result = activationWalk(
      store,
      [
        { strandId: bad, energy: 1 },
        { strandId: good, energy: 1 },
      ],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    // The walk ran normally from the resolvable seed…
    expect(result.lit.map((l) => l.strandId)).toContain(good);
    expect(result.halt.popCount).toBeGreaterThanOrEqual(1);
    expect(result.halt.reason).not.toBe(ReasonCode.NO_SEEDS_RESOLVED);
    // …and the dangling id is NAMED, exactly and only it.
    expect(result.unresolvedSeeds).toEqual([bad]);
    expect(result.seedsResolved).toBe(1);
  });

  it("(b) only bad seeds: NO_SEEDS_RESOLVED, degraded, empty, popCount 0 — never BRIDGE_SWEEP_CLEAR", () => {
    const store = createMemoryStore();
    // The store even has content — the point is the CUE's ids are stale, not the web.
    store.putStrand(makeStrand(asStrandId("strand:unrelated")));

    const badA = asStrandId("strand:stale-1");
    const badB = asStrandId("strand:stale-2");
    const result = activationWalk(
      store,
      [
        { strandId: badA, energy: 1 },
        { strandId: badB, energy: 1 },
      ],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    expect(result.halt.reason).toBe(ReasonCode.NO_SEEDS_RESOLVED);
    // Explicit: NOT the healthy stamp the pre-fix walk fabricated for this case.
    expect(result.halt.reason).not.toBe(ReasonCode.BRIDGE_SWEEP_CLEAR);
    expect(result.halt.degraded).toBe(true);
    expect(result.halt.popCount).toBe(0);
    expect(result.halt.bridgesCrossed).toBe(0);
    expect(result.lit).toEqual([]);
    expect(result.unresolvedSeeds).toEqual([badA, badB]);
    expect(result.seedsResolved).toBe(0);
  });

  it("(b, engine seam) engine.recall forwards the stamp and both new fields verbatim", () => {
    const store = createMemoryStore();
    const engine = createIntelligentDb(store, minimalIdentity());
    const bad = asStrandId("strand:stale");

    const result = engine.recall({ seeds: [{ strandId: bad, energy: 1 }] });
    expect(result.halt.reason).toBe(ReasonCode.NO_SEEDS_RESOLVED);
    expect(result.halt.degraded).toBe(true);
    expect(result.lit).toEqual([]);
    expect(result.unresolvedSeeds).toEqual([bad]);
    expect(result.seedsResolved).toBe(0);
  });

  it("(c) an EMPTY seeds array behaves exactly as before (the caller's legitimate no-op)", () => {
    const store = createMemoryStore();
    const result = activationWalk(
      store,
      [],
      DEFAULT_WALK_CONFIG,
      createHaltingController(DEFAULT_WALK_CONFIG),
    );

    // Pre-fix pin: an empty cue clears through the (vacuous) bridge sweep,
    // NOT degraded, NOT NO_SEEDS_RESOLVED — nothing was supplied, nothing failed.
    expect(result.halt.reason).toBe(ReasonCode.BRIDGE_SWEEP_CLEAR);
    expect(result.halt.degraded).toBe(false);
    expect(result.halt.popCount).toBe(0);
    expect(result.lit).toEqual([]);
    expect(result.unresolvedSeeds).toEqual([]);
    expect(result.seedsResolved).toBe(0);
  });
});
