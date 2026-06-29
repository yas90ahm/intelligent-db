/**
 * smoke.test.ts — the scaffold's single smoke test.
 *
 * Goal: prove the public barrel wires together — the in-memory store, the
 * Source-Identity Layer, and the three-verb engine — and that a fact filed through
 * the api can be RECALLED from the store by its mechanical shared-entity index.
 *
 * `recall()` drives `activationWalk` (now fully implemented): the FILE-and-find
 * path and the activation walk both run end-to-end here — a filed fact is recalled
 * and the seed lights up holding its injected energy.
 *
 * Everything is imported through the barrel (`../index.js`) on purpose: that is
 * what exercises the integration surface this test exists to protect.
 */

import { describe, it, expect } from "vitest";

import {
  // engine + store
  createIntelligentDb,
  createMemoryStore,
  // identity layer + its pillar wiring
  createSourceIdentityLayer,
  createStakeLedger,
  generatePassport,
  repCapFor,
  independenceBetween,
  combineSublinear,
  applySelfStackCap,
  MAX_EXACT_ROOTS,
  // contract types / enums
  AnchorClass,
  ReasonCode,
  EdgeType,
  Tier,
  FactState,
  FactOrigin,
  asEpochMs,
  asStrandId,
  asEdgeId,
  computeEdgeWeight,
  DEFAULT_WALK_CONFIG,
  // forgetting: eviction gates + decision under test
  evaluateEviction,
  EvictionGate,
  ALL_EVICTION_GATES,
  DEFAULT_FORGETTING_CONFIG,
} from "../index.js";

import type {
  EntityId,
  AttributeKey,
  SourceId,
  Unit,
  AnchorBinding,
  IdentityStamp,
  ProvenanceRoot,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  Passport,
  WalkSeed,
  Strand,
  Edge,
  EpochMs,
  EdgeId,
  ForgettingNeighborView,
  EvictionEvidence,
} from "../index.js";

// ---------------------------------------------------------------------------
// Minimal in-test pillar ports (the concrete pillar registries are out of scope
// for the scaffold; these satisfy the injected-port contracts so the facade can
// compose a stamp). They lean on the REAL, fully-implemented anchor math.
// ---------------------------------------------------------------------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(passport: Passport): void {
      known.add(passport.sourceId);
    },
    sourceIdOf(sourceId: SourceId): SourceId | null {
      return known.has(sourceId) ? sourceId : null;
    },
    has(sourceId: SourceId): boolean {
      return known.has(sourceId);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void {
      const prev = book.get(sourceId) ?? [];
      book.set(sourceId, [...prev, ...anchors]);
    },
    anchorsOf(sourceId: SourceId): readonly AnchorBinding[] {
      return book.get(sourceId) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      // Sublinear aggregate: the strongest single realized cost dominates. Good
      // enough for the scaffold; the real sublinear curve is a tuning knob.
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best;
    },
    independenceBetween(
      a: readonly AnchorBinding[],
      b: readonly AnchorBinding[],
    ): Unit {
      // Defer to the real anchor-cost disjointness math.
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeReputationLedger(): ReputationLedgerPort {
  const anchors = makeAnchorRegistry();
  return {
    scoreOf(_sourceId: SourceId): Unit {
      // Fresh source with no track record sits at its floor (0). The rep_cap is
      // what it could eventually earn; the live score starts at zero.
      void anchors;
      return 0;
    },
  };
}

function makeStakePort(): StakeLedgerPort {
  const ledger = createStakeLedger();
  return {
    postedFor(sourceId: SourceId): number {
      return ledger.posted(sourceId);
    },
  };
}

/** Wire a complete Source-Identity Layer over the in-test pillar ports. */
function makeIdentityLayer(): SourceIdentityLayer {
  return createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: makeReputationLedger(),
    stake: makeStakePort(),
  });
}

/** A DOMAIN anchor binding (a costly, real-world-scarce root). */
function domainAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.DOMAIN,
    realizedCost: 0.35 as Unit,
    independenceWeight: 0.35 as Unit,
  };
}

/** An ORGANIZATION anchor binding (a single shared org root, costly). */
function orgAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.ORGANIZATION,
    realizedCost: 0.75 as Unit,
    independenceWeight: 0.75 as Unit,
  };
}

/** A VERIFIED_HUMAN anchor binding (a distinct legal person, costly). */
function verifiedHumanAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.VERIFIED_HUMAN,
    realizedCost: 0.7 as Unit,
    independenceWeight: 0.7 as Unit,
  };
}

/** An EMAIL/OAUTH anchor binding (the cheapest non-bare class: weight 0.10). */
function emailAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.EMAIL_OAUTH,
    realizedCost: 0.1 as Unit,
    independenceWeight: 0.1 as Unit,
  };
}

describe("Intelligent DB scaffold smoke", () => {
  it("registers a source and composes a well-formed identity stamp", () => {
    const identity = makeIdentityLayer();
    const passport = generatePassport();
    const anchors: AnchorBinding[] = [domainAnchor()];

    identity.register(passport, anchors);
    const stamp: IdentityStamp = identity.stampFor(passport.sourceId);

    expect(stamp.source_id).toBe(passport.sourceId);
    expect(stamp.anchor_cost).toBeGreaterThan(0); // a DOMAIN anchor carries cost
    expect(stamp.anchor_set.length).toBe(1);
    expect(stamp.reputation).toBe(0); // fresh source has earned nothing yet
    expect(stamp.stake_posted).toBe(0);
  });

  it("files a fact through the api and recalls it from the shared-entity index", () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    const attribute = "berlin#capital_of" as AttributeKey;

    // writeFact is a fully-implemented SIMPLE part: it mints an OBSERVED strand and
    // attaches it by the mechanical SHARED_ENTITY rule.
    const id = db.writeFact({
      entity,
      attribute,
      payload: { capitalOf: "Germany" },
      stamp,
    });

    expect(id).toBeTruthy();

    // RECALL the fact — not yet via the activation walk (crack-A), but via the
    // store's shared-entity seed index, which is exactly how a cue energizes seeds.
    const about = store.strandsByEntity(entity);
    expect(about.map((s) => s.id)).toContain(id);

    const filed = store.getStrand(id);
    expect(filed).not.toBeNull();
    expect(filed?.entity).toBe(entity);
    expect(filed?.payload).toEqual({ capitalOf: "Germany" });
    // It carries the source's provenance derived from the stamp.
    expect(filed?.provenance.length).toBeGreaterThan(0);
  });

  it("attaches a second fact about the same entity, reachable across the shared-entity join", () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    const a = db.writeFact({ entity, payload: { note: "first" }, stamp });
    const b = db.writeFact({ entity, payload: { note: "second" }, stamp });

    // Both strands are about the entity. SHARED_ENTITY is an INDEX, not a clique:
    // writeFact materializes NO sibling edges (the O(N^2) mesh is gone), so the
    // entity index — not an adjacency mesh — is the join.
    const about = store.strandsByEntity(entity);
    expect(about.map((s) => s.id).sort()).toEqual([a, b].sort());

    // INTENT preserved (connectivity / recall): with no materialized edges minted,
    // the activation walk DERIVES same-entity siblings from the index, so energy
    // seeded at `a` still reaches `b` across the shared-entity join.
    const result = db.recall({ seeds: [{ strandId: a, energy: 1 }] });
    const litIds = result.lit.map((l) => l.strandId);
    expect(litIds).toContain(a);
    expect(litIds).toContain(b);
  });

  it("independentRootCount collapses same-class roots to multiplicity 1", () => {
    const identity = makeIdentityLayer();
    const at = asEpochMs(Date.now());

    // Two roots in the SAME independence class are echoes => count collapses to 1.
    const sameClass: ProvenanceRoot[] = [
      {
        rootId: "root:1" as ProvenanceRoot["rootId"],
        independenceClass: "class:X" as ProvenanceRoot["independenceClass"],
        sourceId: null,
        establishedAt: at,
      },
      {
        rootId: "root:2" as ProvenanceRoot["rootId"],
        independenceClass: "class:X" as ProvenanceRoot["independenceClass"],
        sourceId: null,
        establishedAt: at,
      },
    ];
    expect(identity.independentRootCount(sameClass)).toBe(1);

    // Two DISTINCT classes => two independent roots (Stage-1 class-disjoint bound).
    const twoClasses: ProvenanceRoot[] = [
      sameClass[0]!,
      {
        rootId: "root:3" as ProvenanceRoot["rootId"],
        independenceClass: "class:Y" as ProvenanceRoot["independenceClass"],
        sourceId: null,
        establishedAt: at,
      },
    ];
    expect(identity.independentRootCount(twoClasses)).toBe(2);
  });

  it("anchor math: repCapFor honors the costliest anchor's ceiling", () => {
    // A DOMAIN anchor ceilings reputation at 0.60 (per the anchor-cost table).
    expect(repCapFor([domainAnchor()])).toBeCloseTo(0.6, 5);
    // An empty anchor set is a bare key: rep_cap 0.05.
    expect(repCapFor([])).toBeCloseTo(0.05, 5);
  });

  it("recall() runs the activation walk and lights up the seed", () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    const id = db.writeFact({ entity, payload: { note: "seed" }, stamp });

    const seeds: WalkSeed[] = [{ strandId: id, energy: 1 }];
    const result = db.recall({ seeds });

    // The seed lit up holding exactly its injected energy.
    const litIds = result.lit.map((l) => l.strandId);
    expect(litIds).toContain(id);
    expect(result.lit.find((l) => l.strandId === id)?.activation).toBe(1);

    // Never a silent stop: a clean walk stamps a non-degraded reason.
    expect(result.halt.degraded).toBe(false);
    expect([ReasonCode.CONVERGED, ReasonCode.BRIDGE_SWEEP_CLEAR]).toContain(
      result.halt.reason,
    );
    expect(result.halt.popCount).toBeGreaterThanOrEqual(1);
  });

  it("activation spreads across a shared-entity thread to a sibling strand", () => {
    const store = createMemoryStore();
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    // Two facts about the same entity are joined by the SHARED_ENTITY relation,
    // represented as the entity INDEX (no materialized clique). The activation walk
    // derives the same-entity siblings at read time, so energy seeded at `a` must
    // still reach `b` across the shared-entity join — this is the canonical
    // regression guard that lazy index-derivation preserves recall connectivity.
    const a = db.writeFact({ entity, payload: { note: "first" }, stamp });
    const b = db.writeFact({ entity, payload: { note: "second" }, stamp });

    const result = db.recall({ seeds: [{ strandId: a, energy: 1 }] });
    const litIds = result.lit.map((l) => l.strandId);

    expect(litIds).toContain(a);
    expect(litIds).toContain(b); // reached across the shared-entity thread

    // Spread energy is share-normalized and γ-decayed: strictly between 0 and the seed.
    const bEnergy = result.lit.find((l) => l.strandId === b)?.activation ?? 0;
    expect(bEnergy).toBeGreaterThan(0);
    expect(bEnergy).toBeLessThan(1);
  });

  it("a cross-web bridge lights up the far side via the mandatory sweep, not local expansion", () => {
    // Build a full OBSERVED strand by hand (mirrors api.ts makeObservedStrand) so
    // we can place the two strands in DIFFERENT entities (different webs) — which
    // api.writeFact cannot do, as it only mints SHARED_ENTITY edges. With distinct
    // entities there is NO shared-entity thread between them, so the lone
    // CROSS_WEB_BRIDGE is the ONLY connection: far-side activation can come ONLY
    // from the phase-2 sweep, never from local expansion.
    function strandIn(
      idRaw: string,
      entityRaw: string,
      cls: string,
      at: EpochMs,
    ): Strand {
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
            establishedAt: at,
          },
        ],
        outEdges: [],
        inEdges: [],
        outranked_by: null,
        bridge: { earned_bridge_value: 0, far_side_potential: 0 },
        salience: { s: 1, last_fire_time: at, lambda: 0.05, fire_count: 0 },
        description_value: 0,
        observedAt: at,
        external_reobservation_count: 0,
        contradiction_set: null,
        co_equal_claim_cardinality: 0,
        last_tier_reason: null,
        register: null,
      };
    }

    const at = asEpochMs(Date.now());
    // DISTINCT independence classes so the far strand contributes NEW novelty when
    // the sweep lights it (positive yield => no zero-yield breaker noise).
    let near = strandIn("strand:near", "entity:near-web", "class:near", at);
    let far = strandIn("strand:far", "entity:far-web", "class:far", at);
    // A LOCAL sibling in the SAME (near) web, joined to `near` by an ordinary
    // SHARED_ENTITY thread. Its purpose is twofold:
    //  (1) it makes the near strand's out_weight_sum STRICTLY GREATER than the
    //      bridge edge's own weight, so a (forbidden) LOCAL crossing of the bridge
    //      would deposit  1 * (w_bridge / out_weight_sum) * gamma  which is
    //      STRICTLY LESS than gamma. The sweep, by contrast, seeds gamma scaled by
    //      the bridge's own provenance_independence (B1): here indep=0.5 ⇒ the
    //      sweep seed is EXACTLY gamma*0.5. That constant (0.5*gamma) differs from
    //      the share-normalized local cross (w_bridge/out_weight_sum*gamma ≈
    //      0.111*gamma), so asserting farEnergy === gamma*0.5 still PROVES the far
    //      side was lit by the SWEEP, not by local expansion (this assertion FAILS
    //      if the local phase ever stops skipping CROSS_WEB_BRIDGE edges).
    //  (2) it gives the local phase a real neighbor to expand, so the walk is a
    //      genuine two-strand local web bridged to a third strand.
    let sibling = strandIn("strand:sib", "entity:near-web", "class:sib", at);

    // Bridge weight and a heavier local sibling weight => out_weight_sum > w_bridge.
    const wBridge = computeEdgeWeight(0.5 as Unit, 0.5 as Unit, 0.5 as Unit);
    const wLocal = computeEdgeWeight(1 as Unit, 1 as Unit, 1 as Unit);
    const bridge: Edge = {
      id: asEdgeId("edge:bridge"),
      from: near.id,
      to: far.id,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 0.5 as Unit,
      provenance_independence: 0.5 as Unit,
      recency: 0.5 as Unit,
      w: wBridge,
      out_weight_sum: wBridge,
    };
    const localEdge: Edge = {
      id: asEdgeId("edge:local"),
      from: near.id,
      to: sibling.id,
      edgeType: EdgeType.SHARED_ENTITY,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: wLocal,
      out_weight_sum: wLocal,
    };
    near = { ...near, outEdges: [bridge.id, localEdge.id] };
    far = { ...far, inEdges: [bridge.id] };
    sibling = { ...sibling, inEdges: [localEdge.id] };

    const store = createMemoryStore();
    store.putStrand(near);
    store.putStrand(far);
    store.putStrand(sibling);
    store.putEdge(bridge);
    store.putEdge(localEdge);
    store.recomputeOutWeightSum(near.id);

    // Sanity: the share-normalized LOCAL-cross energy is STRICTLY below gamma, so
    // gamma is a discriminating witness for the sweep path.
    const refreshedBridge = store.getEdge(bridge.id);
    const localCrossEnergy =
      1 * (refreshedBridge!.w / refreshedBridge!.out_weight_sum) * DEFAULT_WALK_CONFIG.gamma;
    expect(localCrossEnergy).toBeLessThan(DEFAULT_WALK_CONFIG.gamma);

    const db = createIntelligentDb(store, makeIdentityLayer());
    const result = db.recall({ seeds: [{ strandId: near.id, energy: 1 }] });

    const litIds = result.lit.map((l) => l.strandId);
    // The seed fired, the local sibling lit via the SHARED_ENTITY thread, and the
    // far strand — reachable ONLY across the bridge — lit up.
    expect(litIds).toContain(near.id);
    expect(litIds).toContain(sibling.id);
    expect(litIds).toContain(far.id);

    // Conclusive that the SWEEP (not local expansion) delivered the far side:
    //  - bridgesCrossed === 1 (only phase-2 nextBridgeCrossing increments it), and
    //  - the two webs live in DIFFERENT entities, so no SHARED_ENTITY path exists —
    //    the bridge is the sole connection.
    expect(result.halt.bridgesCrossed).toBe(1);
    expect(near.entity).not.toBe(far.entity);

    // Clean stop: every lit bridge crossed, non-degraded BRIDGE_SWEEP_CLEAR.
    expect(result.halt.reason).toBe(ReasonCode.BRIDGE_SWEEP_CLEAR);
    expect(result.halt.degraded).toBe(false);

    // THE discriminating assertion: the far side carries EXACTLY the sweep's
    // seedActivation = gamma * the bridge's provenance_independence (B1 down-weight;
    // here indep=0.5 ⇒ gamma*0.5), NOT the strictly-smaller share-normalized energy
    // a local bridge crossing would have deposited. This proves the local phase
    // SKIPPED the bridge and the SWEEP alone lit the far web, AND that B1's seed
    // scaling is live (a weak-stamped bridge is seeded below gamma).
    const farEnergy = result.lit.find((l) => l.strandId === far.id)?.activation;
    expect(farEnergy).toBe(DEFAULT_WALK_CONFIG.gamma * 0.5);
    expect(farEnergy).not.toBe(localCrossEnergy);
    // B1 stamp: exactly one crossing was down-weighted (the weak-stamped bridge).
    expect(result.halt.bridgeSeedsDownweighted).toBe(1);

    // The local sibling DID receive the smaller share-normalized local energy —
    // confirming local expansion really ran (and really differs from the sweep).
    const sibEnergy = result.lit.find((l) => l.strandId === sibling.id)?.activation ?? 0;
    expect(sibEnergy).toBeGreaterThan(0);
    expect(sibEnergy).toBeLessThan(DEFAULT_WALK_CONFIG.gamma);
  });
});

// ===========================================================================
// independentRootCount STAGE 2 — cross-source anchor-disjointness collapse.
//
// Stage 1 counts DISTINCT independence classes; Stage 2 additionally COLLAPSES
// roots whose SOURCES are not anchor-independent (the same org behind many
// domains, or a flood sharing one anchor CLASS) so a fake-independence flood
// reports its TRUE count (~1) and stays eviction-eligible, while genuinely
// disjoint-anchored sources stay corroborated. The count never exceeds the
// Stage-1 distinct-class bound.
// ===========================================================================

describe("independentRootCount Stage 2 (cross-source anchor disjointness)", () => {
  const at = asEpochMs(Date.now());

  /** Build a ProvenanceRoot in a class, optionally backed by a source. */
  function root(
    idRaw: string,
    cls: string,
    sourceId: SourceId | null,
  ): ProvenanceRoot {
    return {
      rootId: idRaw as ProvenanceRoot["rootId"],
      independenceClass: cls as ProvenanceRoot["independenceClass"],
      sourceId,
      establishedAt: at,
    };
  }

  /**
   * An identity layer whose anchor registry returns hand-chosen anchor sets per
   * source (so the REAL independenceBetween math drives the collapse), built from
   * a source -> anchors map. Sources are registered so the layer is wired exactly
   * as production.
   */
  function layerWithAnchors(
    bindings: ReadonlyArray<readonly [SourceId, AnchorBinding[]]>,
  ): SourceIdentityLayer {
    const identity = makeIdentityLayer();
    for (const [sourceId, anchors] of bindings) {
      const passport: Passport = { sourceId, publicKeyPem: "pem:" + sourceId };
      identity.register(passport, anchors);
    }
    return identity;
  }

  it("FAKE-FLOOD sharing one ORG anchor collapses to 1", () => {
    // N=5 roots, each a DISTINCT independence class and a DISTINCT sourceId, but
    // EVERY source bound to the SAME single ORGANIZATION anchor (shared anchor
    // class). Stage 1 alone would report 5 (the contradiction-bomb). For any pair
    // independenceBetween([org],[org]) = 0 (shared class filtered, empty disjoint
    // sides) => not > 0 => correlated. Greedy keeps only the first; the flood
    // collapses to its TRUE count.
    const N = 5;
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [];
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < N; i++) {
      const src = ("src:" + i) as SourceId;
      bindings.push([src, [orgAnchor()]]);
      roots.push(root("root:" + i, "class:" + i, src));
    }
    const identity = layerWithAnchors(bindings);

    expect(identity.independentRootCount(roots)).toBe(1);
  });

  it("TWO sources with DISJOINT costly anchors stay independent (count 2)", () => {
    // Distinct classes, distinct sources; source A bound to a DOMAIN anchor and
    // source B to a VERIFIED_HUMAN anchor — fully disjoint costly roots, so
    // independenceBetween > 0 => kept as corroborated.
    const a = "src:a" as SourceId;
    const b = "src:b" as SourceId;
    const identity = layerWithAnchors([
      [a, [domainAnchor()]],
      [b, [verifiedHumanAnchor()]],
    ]);
    const roots = [
      root("root:a", "class:a", a),
      root("root:b", "class:b", b),
    ];

    expect(identity.independentRootCount(roots)).toBe(2);
  });

  it("TRANSITIVITY: A~B, B~C, A perp C does NOT collapse A and C (count 2)", () => {
    // Three roots in three distinct classes. Rig anchors so:
    //   A,B share an ORG anchor    => independenceBetween(A,B) = 0 (correlated)
    //   B,C share that SAME ORG    => independenceBetween(B,C) = 0 (correlated)
    //   A,C: A has DOMAIN disjoint from C's VERIFIED_HUMAN => > 0 (independent)
    // To get exactly this, give B BOTH org + domain + verified-human so it shares
    // the org with A and the org with C, while A=domain+org and C=human+org.
    //   indep(A,B): A={DOMAIN,ORG}, B={DOMAIN,ORG,VH}. Shared classes DOMAIN,ORG
    //     removed => A disjoint = {} => strengthA = 0 => min = 0. Correlated. ✓
    //   indep(B,C): B={DOMAIN,ORG,VH}, C={VH,ORG}. Shared VH,ORG removed =>
    //     C disjoint = {} => strengthC = 0 => min = 0. Correlated. ✓
    //   indep(A,C): A={DOMAIN,ORG}, C={VH,ORG}. Shared ORG removed =>
    //     A disjoint={DOMAIN}>0, C disjoint={VH}>0 => min > 0. Independent. ✓
    // rootId sort order A<B<C: A becomes rep; B vs A => 0 => dropped; C vs A (only
    // surviving rep) => >0 => kept. Greedy avoids union-find's wrong collapse to 1.
    const a = "src:a" as SourceId;
    const b = "src:b" as SourceId;
    const c = "src:c" as SourceId;
    const identity = layerWithAnchors([
      [a, [domainAnchor(), orgAnchor()]],
      [b, [domainAnchor(), orgAnchor(), verifiedHumanAnchor()]],
      [c, [verifiedHumanAnchor(), orgAnchor()]],
    ]);
    const roots = [
      root("root:a", "class:a", a),
      root("root:b", "class:b", b),
      root("root:c", "class:c", c),
    ];

    expect(identity.independentRootCount(roots)).toBe(2);
  });

  it("COUNT never exceeds the Stage-1 distinct-class bound", () => {
    // Many roots but only 2 distinct classes; all sources fully disjoint
    // (DOMAIN vs VERIFIED_HUMAN) so anchor-independence alone would admit more
    // reps. The final min(distinctClassCount, reps) clamps the result to 2.
    const roots: ProvenanceRoot[] = [];
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [];
    for (let i = 0; i < 6; i++) {
      const src = ("src:" + i) as SourceId;
      // Alternate disjoint anchors AND only two classes total.
      const anchor = i % 2 === 0 ? domainAnchor() : verifiedHumanAnchor();
      bindings.push([src, [anchor]]);
      roots.push(root("root:" + i, i % 2 === 0 ? "class:X" : "class:Y", src));
    }
    const identity = layerWithAnchors(bindings);

    expect(identity.independentRootCount(roots)).toBe(2);
  });

  it("REGRESSION mirror: null-source same-class => 1, distinct-class => 2", () => {
    // Re-assert the existing smoke test's fallback path inside this harness so it
    // is locked independently of the original test file.
    const identity = makeIdentityLayer();

    const sameClass = [
      root("root:1", "class:X", null),
      root("root:2", "class:X", null),
    ];
    expect(identity.independentRootCount(sameClass)).toBe(1);

    const twoClasses = [
      root("root:1", "class:X", null),
      root("root:3", "class:Y", null),
    ];
    expect(identity.independentRootCount(twoClasses)).toBe(2);
  });

  it("EDGE cases: empty set => 0, single root => 1", () => {
    const identity = makeIdentityLayer();
    expect(identity.independentRootCount([])).toBe(0);
    expect(
      identity.independentRootCount([root("root:solo", "class:Z", null)]),
    ).toBe(1);
  });

  // ── TASK A: EXACT maximum-independent-set (not ordering-dependent greedy) ──

  it("TRANSITIVITY is fixed in BOTH orderings (B-first AND reversed) => 2", () => {
    // Same A~B, B~C, A⊥C rig as above, but assert the EXACT max-IS returns the
    // true maximum {A,C}=2 regardless of which root sorts first. The old greedy
    // could return 1 when the bridging vertex B was chosen first (B kills both A
    // and C as already-correlated reps). Exact max-clique is ordering-invariant.
    const a = "src:a" as SourceId;
    const b = "src:b" as SourceId;
    const c = "src:c" as SourceId;
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [
      [a, [domainAnchor(), orgAnchor()]],
      [b, [domainAnchor(), orgAnchor(), verifiedHumanAnchor()]],
      [c, [verifiedHumanAnchor(), orgAnchor()]],
    ];
    const identity = layerWithAnchors(bindings);

    // Ordering 1: rootIds sort A < B < C (B is NOT first here, but the bridging
    // vertex sits in the middle — still a transitivity trap for greedy variants).
    const forward = [
      root("root:a", "class:a", a),
      root("root:b", "class:b", b),
      root("root:c", "class:c", c),
    ];
    expect(identity.independentRootCount(forward)).toBe(2);

    // Ordering 2: force the BRIDGE vertex B to sort FIRST by giving it the
    // smallest rootId. This is the exact case where greedy undercounts to 1.
    const bFirst = [
      root("root:0_bridge", "class:b", b), // B sorts first
      root("root:1", "class:a", a),
      root("root:2", "class:c", c),
    ];
    expect(identity.independentRootCount(bFirst)).toBe(2);

    // Ordering 3: reversed rootId order. Still 2.
    const reversed = [
      root("root:z", "class:c", c),
      root("root:y", "class:b", b),
      root("root:x", "class:a", a),
    ];
    expect(identity.independentRootCount(reversed)).toBe(2);
  });

  it("STAR (shared-hub-anchor rim): rim stays pairwise independent => exact max-IS = 4", () => {
    // Five sources. A center source `hub` holds ONLY a shared ORG and is therefore
    // correlated with every rim (each rim also carries that ORG, so the hub's
    // disjoint side is empty against any rim => indep(hub, rim_i) = 0). Each rim
    // ALSO holds a UNIQUE costly class. For rim_i vs rim_j the shared ORG is
    // filtered from BOTH, leaving each its own unique disjoint class => indep > 0
    // => rim pairs ARE independent. So the maximum set of pairwise-independent
    // roots is the 4 rim sources = 4 (clamped by 5 distinct classes, no bite). A
    // greedy that picks the correlated hub FIRST returns 1; EXACT returns 4.
    const hub = "src:hub" as SourceId;
    const rim = ["src:r0", "src:r1", "src:r2", "src:r3"] as SourceId[];
    const rimAnchors: AnchorBinding[][] = [
      [domainAnchor(), orgAnchor()],
      [verifiedHumanAnchor(), orgAnchor()],
      [
        {
          anchorClass: AnchorClass.HARDWARE_ATTESTATION,
          realizedCost: 0.45 as Unit,
          independenceWeight: 0.45 as Unit,
        },
        orgAnchor(),
      ],
      [
        {
          anchorClass: AnchorClass.PHONE_SIM,
          realizedCost: 0.2 as Unit,
          independenceWeight: 0.2 as Unit,
        },
        orgAnchor(),
      ],
    ];
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [
      // Hub holds ONLY the shared ORG => correlated with every rim. Hub sorts
      // FIRST (smallest rootId) to bait a greedy that would take it and collapse.
      [hub, [orgAnchor()]],
      ...rim.map(
        (s, i) => [s, rimAnchors[i]!] as readonly [SourceId, AnchorBinding[]],
      ),
    ];
    const identity = layerWithAnchors(bindings);

    const roots = [
      root("root:0_hub", "class:hub", hub),
      root("root:1", "class:r0", rim[0]!),
      root("root:2", "class:r1", rim[1]!),
      root("root:3", "class:r2", rim[2]!),
      root("root:4", "class:r3", rim[3]!),
    ];

    expect(identity.independentRootCount(roots)).toBe(4);
  });

  it("STAR (clean rim): rim pairwise independent => exact max-IS = 4 > greedy 1", () => {
    // Fix the rim so rim sources do NOT share ORG with each other: give the hub a
    // DISTINCT shared anchor with each rim instead of one common ORG. Simpler: the
    // hub shares a DIFFERENT costly class with each rim, and rim sources hold only
    // their own unique class. Then rim pairs are fully disjoint (independent), and
    // the hub is correlated with each rim (shares that rim's class).
    const mk = (cls: AnchorClass, w: number): AnchorBinding => ({
      anchorClass: cls,
      realizedCost: w as Unit,
      independenceWeight: w as Unit,
    });
    const rimClasses = [
      AnchorClass.DOMAIN,
      AnchorClass.VERIFIED_HUMAN,
      AnchorClass.HARDWARE_ATTESTATION,
      AnchorClass.PHONE_SIM,
    ];
    const rimWeights = [0.35, 0.7, 0.45, 0.2];
    const hub = "src:hub" as SourceId;
    // Hub holds ALL four rim classes => shares one with each rim => correlated
    // with every rim. But rim sources each hold ONLY their own class => rim pairs
    // are disjoint => independent. Max set of pairwise-independent = the 4 rim.
    const hubAnchors = rimClasses.map((c, i) => mk(c, rimWeights[i]!));
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [
      [hub, hubAnchors],
    ];
    const roots = [root("root:0_hub", "class:hub", hub)];
    for (let i = 0; i < 4; i++) {
      const s = ("src:r" + i) as SourceId;
      bindings.push([s, [mk(rimClasses[i]!, rimWeights[i]!)]]);
      roots.push(root("root:" + (i + 1), "class:r" + i, s));
    }
    const identity = layerWithAnchors(bindings);

    // indep(hub, rim_i): hub shares rim_i's class => that class filtered from
    // BOTH; hub's other 3 classes are disjoint (rim_i has none of them) so
    // hub-side strength > 0, but rim_i's disjoint side is EMPTY => min = 0 =>
    // correlated. indep(rim_i, rim_j): fully disjoint single classes => > 0 =>
    // independent. So the maximum pairwise-independent set is {r0,r1,r2,r3} = 4,
    // and 5 distinct classes mean the clamp (5) does not bite. Greedy that takes
    // the hub first returns 1. EXACT returns 4.
    expect(identity.independentRootCount(roots)).toBe(4);
  });

  it("FAKE-FLOOD still collapses to 1 under exact max-IS (bomb defense intact)", () => {
    // Re-assert the contradiction-bomb defense survives the greedy→exact swap: N
    // sources all sharing ONE org anchor are pairwise correlated (no edges in the
    // independent graph) => max clique = 1.
    const N = 8;
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [];
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < N; i++) {
      const src = ("src:" + i) as SourceId;
      bindings.push([src, [orgAnchor()]]);
      roots.push(root("root:" + i, "class:" + i, src));
    }
    const identity = layerWithAnchors(bindings);
    expect(identity.independentRootCount(roots)).toBe(1);
  });

  it("LARGE root set (> MAX_EXACT_ROOTS) terminates via greedy fallback, no hang", () => {
    // n strictly above the exact threshold takes the deterministic greedy path.
    // All distinct classes + all fully disjoint (alternating DOMAIN / VH) so the
    // greedy maximal set is the full set, clamped by the distinct-class bound.
    const n = MAX_EXACT_ROOTS + 5;
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [];
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < n; i++) {
      const src = ("src:big:" + i) as SourceId;
      // Two disjoint costly classes alternating; each rim independent of the other
      // class. With only 2 classes the clamp pins this to 2 — and proves the path
      // returns promptly (no hang) on a set larger than the exact threshold.
      const anchor = i % 2 === 0 ? domainAnchor() : verifiedHumanAnchor();
      bindings.push([src, [anchor]]);
      roots.push(
        root("root:big:" + i, i % 2 === 0 ? "class:X" : "class:Y", src),
      );
    }
    const identity = layerWithAnchors(bindings);
    expect(identity.independentRootCount(roots)).toBe(2);
  });

  it("EXACT path at exactly MAX_EXACT_ROOTS terminates (boundary, no hang)", () => {
    // n === MAX_EXACT_ROOTS uses the EXACT Bron–Kerbosch path. All fully disjoint
    // distinct-class sources => max-IS = n, clamped only by distinct classes (= n
    // here). Proves the exact recursion terminates at the boundary size.
    const n = MAX_EXACT_ROOTS;
    const mk = (cls: AnchorClass, w: number): AnchorBinding => ({
      anchorClass: cls,
      realizedCost: w as Unit,
      independenceWeight: w as Unit,
    });
    const bindings: Array<readonly [SourceId, AnchorBinding[]]> = [];
    const roots: ProvenanceRoot[] = [];
    // Give each source a UNIQUE costly class so every pair is fully disjoint =>
    // every pair independent => the graph is complete => max clique = n.
    const palette = [
      AnchorClass.DOMAIN,
      AnchorClass.VERIFIED_HUMAN,
      AnchorClass.HARDWARE_ATTESTATION,
      AnchorClass.PHONE_SIM,
      AnchorClass.EMAIL_OAUTH,
      AnchorClass.ORGANIZATION,
      AnchorClass.EXTERNAL_AUTHORITY,
    ];
    for (let i = 0; i < n; i++) {
      const src = ("src:b:" + i) as SourceId;
      // Compose a unique anchor SET per source from the palette so no two sources
      // share every class — pairwise disjointness holds (each has a class no other
      // has, by mixing palette index + a synthetic per-i marker class is overkill;
      // a single distinct class per source suffices when we have ≤ palette*..).
      const cls = palette[i % palette.length]!;
      // Tag the class id uniquely per source via the independence CLASS (the
      // anchor class can repeat; independence is driven by anchor disjointness).
      // To keep anchor sets pairwise disjoint we give each source a distinct
      // anchor class by combining two palette entries uniquely.
      const second = palette[(i * 3 + 1) % palette.length]!;
      const set =
        cls === second ? [mk(cls, 0.5)] : [mk(cls, 0.5), mk(second, 0.5)];
      bindings.push([src, set]);
      roots.push(root("root:b:" + i, "class:b:" + i, src));
    }
    const identity = layerWithAnchors(bindings);
    const result = identity.independentRootCount(roots);
    // The result must be a finite count in [1, n] — the key assertion is that the
    // exact path TERMINATES at the boundary. (Exact value depends on the palette
    // overlap; it is at least 1 and never exceeds n.)
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(n);
  });
});

// ===========================================================================
// TASK B — anchor self-stack ladder cap (applySelfStackCap), now load-bearing.
//
// GUARANTEE under test: a single source's combined independence from a stack of
// anchors all in classes STRICTLY BELOW some class C can never reach
// ANCHOR_TABLE[C].independenceWeight. The cap is wired into independenceBetween,
// so it changes REAL pairwise outputs — a 10x EMAIL stack must NOT reach a
// disjoint DOMAIN source's independence floor.
// ===========================================================================

describe("anchor self-stack ladder cap (applySelfStackCap)", () => {
  const email = (): AnchorBinding => emailAnchor();
  const domain = (): AnchorBinding => domainAnchor();

  it("caps a 10x EMAIL stack at its own strongest weight (0.10), not noisy-OR ~0.65", () => {
    const tenEmails = Array.from({ length: 10 }, () => email());
    // Noisy-OR alone would be ~1 - 0.9^10 ≈ 0.651 — above DOMAIN's 0.35.
    const rawCombined = combineSublinear(
      tenEmails.map((e) => e.independenceWeight),
    );
    expect(rawCombined).toBeGreaterThan(0.6);
    // The cap clamps to the strongest single EMAIL weight, 0.10.
    const capped = applySelfStackCap(tenEmails, rawCombined);
    expect(capped).toBeCloseTo(0.1, 5);
    // And it is strictly below DOMAIN's table weight — cheap stack can't forge it.
    expect(capped).toBeLessThan(0.35);
  });

  it("a genuine single DOMAIN is UNAFFECTED by the cap (0.35 stays 0.35)", () => {
    const one = [domain()];
    const combined = combineSublinear(one.map((d) => d.independenceWeight));
    expect(combined).toBeCloseTo(0.35, 5);
    expect(applySelfStackCap(one, combined)).toBeCloseTo(0.35, 5);
  });

  it("empty stack stays 0, single domain stack stays its weight", () => {
    expect(applySelfStackCap([], 0 as Unit)).toBe(0);
    expect(applySelfStackCap([domain()], 0.35 as Unit)).toBeCloseTo(0.35, 5);
  });

  it("WIRED: a 10x EMAIL source vs a disjoint DOMAIN source stays below 0.35", () => {
    // The cap binds inside independenceBetween: even though the email side's
    // noisy-OR (~0.65) would otherwise exceed the domain side's 0.35, the email
    // side is capped to 0.10, so the pair MIN is 0.10 — a cheap stack cannot forge
    // independence at the strength of a real DOMAIN.
    const tenEmails = Array.from({ length: 10 }, () => email());
    const pair = independenceBetween(tenEmails, [domain()]);
    expect(pair).toBeLessThan(0.35);
    expect(pair).toBeCloseTo(0.1, 5);
  });

  it("WIRED: a 10x EMAIL stack never reaches HARDWARE's 0.45 either (ladder holds)", () => {
    // Disjoint HARDWARE source (weight 0.45). Email side capped to 0.10 => pair
    // bounded by 0.10, far below 0.45. Stacking cheap anchors can't forge a
    // costlier class the source does not hold.
    const tenEmails = Array.from({ length: 10 }, () => email());
    const hardware: AnchorBinding = {
      anchorClass: AnchorClass.HARDWARE_ATTESTATION,
      realizedCost: 0.45 as Unit,
      independenceWeight: 0.45 as Unit,
    };
    const pair = independenceBetween(tenEmails, [hardware]);
    expect(pair).toBeLessThan(0.45);
  });

  it("WIRED: two genuine disjoint strong anchors are NOT clamped below their min", () => {
    // A real DOMAIN (0.35) vs a real VERIFIED_HUMAN (0.70), fully disjoint. Each
    // side's cap equals its own single weight, so the pair MIN is 0.35 — the
    // genuine corroboration is preserved (the cap only bites multi-cheap stacks).
    const pair = independenceBetween([domain()], [verifiedHumanAnchor()]);
    expect(pair).toBeCloseTo(0.35, 5);
  });

  it("WIRED: a real DOMAIN + cheap EMAIL stack keeps its DOMAIN strength (cap = 0.35)", () => {
    // The cap is the source's STRONGEST single anchor — adding cheap emails to a
    // real domain does not lower the ceiling below 0.35, and noisy-OR would push
    // it slightly above 0.35; the cap holds it AT the domain's own 0.35 (its own
    // strongest real anchor), never inflating the cheap stack past it.
    const side = [domain(), email(), email(), email()];
    const other: AnchorBinding = {
      anchorClass: AnchorClass.VERIFIED_HUMAN,
      realizedCost: 0.7 as Unit,
      independenceWeight: 0.7 as Unit,
    };
    const pair = independenceBetween(side, [other]);
    // ceiling on `side` = max(0.35, 0.10) = 0.35; noisy-OR > 0.35 clamped to 0.35.
    expect(pair).toBeCloseTo(0.35, 5);
  });
});

// ===========================================================================
// Below-COLD eviction-permission gates (forgetting/tiers.ts).
//
// These are PURE-FUNCTION unit tests: strands, neighbors, and the caller-resolved
// EvictionEvidence bundle are constructed directly (no store/identity I/O — the
// gate layer is pure). The OVERRIDING property under test is FAIL CLOSED: a strand
// crosses below COLD ONLY when EVERY gate affirmatively passes; any missing/null/
// stale evidence FAILS its gate and KEEPS the strand. We assert a clean ALLOWED
// case plus a DENIED (kept) case per gate, the echo-discount, the pressure-path
// pass-throughs, and the canonical failedGates ORDER.
// ===========================================================================

describe("below-COLD eviction-permission gates (forgetting/tiers)", () => {
  const cfg = DEFAULT_FORGETTING_CONFIG;

  /** A provenance root in a given independence class established `ago` ms before `now`. */
  function root(
    cls: string,
    now: EpochMs,
    ago = 0,
  ): ProvenanceRoot {
    return {
      rootId: ("root:" + cls + ":" + ago) as ProvenanceRoot["rootId"],
      independenceClass: cls as ProvenanceRoot["independenceClass"],
      sourceId: null,
      establishedAt: asEpochMs((now as number) - ago),
    };
  }

  /**
   * Build a COLD strand that is past grace and under maximal decay pressure
   * (old last_fire_time, zero fire/reobserve counts), with the given description
   * value, provenance, and outranked_by. The pressure path is exercised so that a
   * clean gate result yields an ALLOWED eviction.
   */
  function coldStrand(opts: {
    now: EpochMs;
    descriptionValue: number;
    provenance: readonly ProvenanceRoot[];
    outrankedBy?: EdgeId | null;
  }): Strand {
    const { now, descriptionValue, provenance } = opts;
    // observedAt well before the grace floor; last_fire_time long ago => high pressure.
    const long = 365 * 24 * 60 * 60 * 1000;
    const observedAt = asEpochMs((now as number) - long);
    return {
      id: asStrandId("strand:under-eval"),
      entity: "entity:e" as EntityId,
      attribute: null,
      payload: { note: "under-eval" },
      content_hash: "hash:under-eval" as Strand["content_hash"],
      origin: FactOrigin.OBSERVED,
      fact_state: FactState.LIVE,
      tier: Tier.COLD,
      provenance,
      outEdges: [],
      inEdges: [],
      outranked_by: opts.outrankedBy ?? null,
      bridge: { earned_bridge_value: 0, far_side_potential: 0 },
      salience: { s: 0, last_fire_time: observedAt, lambda: 1, fire_count: 0 },
      description_value: descriptionValue,
      observedAt,
      external_reobservation_count: 0,
      contradiction_set: null,
      co_equal_claim_cardinality: 0,
      last_tier_reason: null,
      register: null,
    };
  }

  /** An INDEPENDENT witness neighbor: OBSERVED + LIVE in a given class set. */
  function indNeighbor(
    idRaw: string,
    classes: readonly string[],
    descriptionValue: number,
    now: EpochMs,
  ): ForgettingNeighborView {
    return {
      id: asStrandId(idRaw),
      fact_state: FactState.LIVE,
      origin: FactOrigin.OBSERVED,
      provenance: classes.map((c) => root(c, now)),
      description_value: descriptionValue,
      bridgesToSubject: false,
    };
  }

  /** A non-null stamp value (its fields are irrelevant to the gate — freshness is from provenance). */
  function someStamp(): IdentityStamp {
    return {
      source_id: "src:1" as SourceId,
      anchor_set: [],
      anchor_cost: 0 as Unit,
      reputation: 0 as Unit,
      stake_posted: 0,
    };
  }

  /** Clean, all-pass evidence: non-null stamp, single independent source, no outranker. */
  function cleanEvidence(): EvictionEvidence {
    return { stamp: someStamp(), independentSourceCount: 1, outrankerState: null };
  }

  it("ALLOWED: a clean below-COLD strand with all gates passing is evicted to ARCHIVE", () => {
    const now = asEpochMs(Date.now());
    // Strand in class A; ONE independent neighbor in class B that fully covers it.
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)]; // covers >= dv => uniqueBits 0

    const d = evaluateEviction(strand, neighbors, cleanEvidence(), now, cfg);

    expect(d.failedGates).toEqual([]);
    expect(d.allowed).toBe(true);
    expect(d.toTier).toBe(Tier.ARCHIVE);
    expect(d.reason).toBe(ReasonCode.CONVERGED);
  });

  it("DENIED LOW_UNIQUE_VALUE: no independent neighbor => full unique value (kept)", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });

    const d = evaluateEviction(strand, [], cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.LOW_UNIQUE_VALUE);
  });

  it("DENIED LOW_UNIQUE_VALUE: a neighbor sharing an independence-class with the strand is NOT a witness (kept)", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    // Neighbor in class A == strand's class => NOT class-disjoint => dropped from coverage.
    const neighbors = [indNeighbor("n:echo", ["A"], 99, now)];

    const d = evaluateEviction(strand, neighbors, cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.LOW_UNIQUE_VALUE);
  });

  it("DENIED LOW_UNIQUE_VALUE: a DEMOTED/DERIVED neighbor is not an independent witness (kept)", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    const demoted: ForgettingNeighborView = {
      ...indNeighbor("n:dem", ["B"], 99, now),
      fact_state: FactState.DEMOTED,
    };
    const derived: ForgettingNeighborView = {
      ...indNeighbor("n:der", ["C"], 99, now),
      origin: FactOrigin.DERIVED,
    };

    const d = evaluateEviction(strand, [demoted, derived], cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.LOW_UNIQUE_VALUE);
  });

  it("DENIED LOW_UNIQUE_VALUE echo-discount: two neighbors sharing a class collapse to multiplicity 1 (kept)", () => {
    const now = asEpochMs(Date.now());
    // Floor is 1.0 bit. Strand dv = 3. Two neighbors BOTH in class B, dv 2 each.
    //  - WRONG (summed) coverage = 4 -> capped 3 -> uniqueBits 0 < 1 => would PASS.
    //  - CORRECT (echo-discounted) coverage = max(2,2) = 2 -> uniqueBits 1 >= 1 => FAIL.
    const strand = coldStrand({ now, descriptionValue: 3, provenance: [root("A", now)] });
    const neighbors = [
      indNeighbor("n:b1", ["B"], 2, now),
      indNeighbor("n:b2", ["B"], 2, now),
    ];

    const d = evaluateEviction(strand, neighbors, cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.LOW_UNIQUE_VALUE);

    // Control: the SAME two values in DISTINCT classes B and C do sum to 4 -> capped 3
    // -> uniqueBits 0 < 1 => LOW_UNIQUE_VALUE passes (proving the collapse above is real).
    const distinct = [
      indNeighbor("n:b", ["B"], 2, now),
      indNeighbor("n:c", ["C"], 2, now),
    ];
    const d2 = evaluateEviction(strand, distinct, cleanEvidence(), now, cfg);
    expect(d2.failedGates).not.toContain(EvictionGate.LOW_UNIQUE_VALUE);
    expect(d2.allowed).toBe(true);
  });

  it("DENIED FRESH_INDEPENDENCE_STAMP: a null stamp keeps the strand", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), stamp: null };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.FRESH_INDEPENDENCE_STAMP);
  });

  it("DENIED FRESH_INDEPENDENCE_STAMP: stale provenance (freshest root older than window) keeps the strand", () => {
    const now = asEpochMs(Date.now());
    const stale = cfg.stampFreshnessMs + 1;
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now, stale)] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];

    const d = evaluateEviction(strand, neighbors, cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.FRESH_INDEPENDENCE_STAMP);
  });

  it("DENIED FRESH_INDEPENDENCE_STAMP: empty provenance keeps the strand", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];

    const d = evaluateEviction(strand, neighbors, cleanEvidence(), now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.FRESH_INDEPENDENCE_STAMP);
  });

  it("DENIED INDEP_SOURCE_COUNT_LE_1: a corroborated strand (count 2) is kept", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), independentSourceCount: 2 };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.INDEP_SOURCE_COUNT_LE_1);
  });

  it("DENIED INDEP_SOURCE_COUNT_LE_1: an unknown count (null) is kept", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), independentSourceCount: null };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.INDEP_SOURCE_COUNT_LE_1);
  });

  it("DENIED NOT_OUTRANKED_SIDE: losing side of a LIVE-winner dispute is kept", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({
      now,
      descriptionValue: 2,
      provenance: [root("A", now)],
      outrankedBy: asEdgeId("edge:outranks"),
    });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), outrankerState: FactState.LIVE };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.NOT_OUTRANKED_SIDE);
  });

  it("DENIED NOT_OUTRANKED_SIDE: outranked with an UNKNOWN winner state is kept (fail-closed)", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({
      now,
      descriptionValue: 2,
      provenance: [root("A", now)],
      outrankedBy: asEdgeId("edge:outranks"),
    });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), outrankerState: null };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.NOT_OUTRANKED_SIDE);
  });

  it("NOT_OUTRANKED_SIDE passes when the winner resolved to a non-LIVE (DEMOTED) state", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({
      now,
      descriptionValue: 2,
      provenance: [root("A", now)],
      outrankedBy: asEdgeId("edge:outranks"),
    });
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];
    const ev: EvictionEvidence = { ...cleanEvidence(), outrankerState: FactState.DEMOTED };

    const d = evaluateEviction(strand, neighbors, ev, now, cfg);

    expect(d.failedGates).not.toContain(EvictionGate.NOT_OUTRANKED_SIDE);
    expect(d.allowed).toBe(true);
  });

  it("PASS-THROUGH: ARCHIVE is the immortal fixed point (allowed=false, CONVERGED)", () => {
    const now = asEpochMs(Date.now());
    const strand: Strand = {
      ...coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] }),
      tier: Tier.ARCHIVE,
    };
    const d = evaluateEviction(strand, [], cleanEvidence(), now, cfg);
    expect(d.allowed).toBe(false);
    expect(d.toTier).toBe(Tier.ARCHIVE);
    expect(d.reason).toBe(ReasonCode.CONVERGED);
    expect(d.failedGates).toEqual([]);
  });

  it("PASS-THROUGH: the warm-tier pressure path moves WARM->COLD with all-null/withheld evidence (gates not consulted)", () => {
    const now = asEpochMs(Date.now());
    const strand: Strand = {
      ...coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] }),
      tier: Tier.WARM,
    };
    // Evidence fully withheld — the pressure path must NOT consult the gates.
    const withheld: EvictionEvidence = {
      stamp: null,
      independentSourceCount: null,
      outrankerState: null,
    };
    const d = evaluateEviction(strand, [], withheld, now, cfg);

    expect(d.allowed).toBe(true);
    expect(d.toTier).toBe(Tier.COLD);
    expect(d.reason).toBe(ReasonCode.NOVELTY_EXHAUSTED);
    expect(d.failedGates).toEqual([]);
  });

  it("PASS-THROUGH: a COLD strand with all gates passing but insufficient pressure stays put", () => {
    const now = asEpochMs(Date.now());
    const strand = coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] });
    // Make pressure LOW: just fired now + loud salience + heavy retrieval resistance.
    const lowPressure: Strand = {
      ...strand,
      salience: { s: 100, last_fire_time: now, lambda: 0, fire_count: 1000 },
      external_reobservation_count: 1000,
    };
    const neighbors = [indNeighbor("n:1", ["B"], 5, now)];

    const d = evaluateEviction(lowPressure, neighbors, cleanEvidence(), now, cfg);

    // Gates all pass, but pressure < pressureToStepDown => no eviction.
    expect(d.failedGates).toEqual([]);
    expect(d.allowed).toBe(false);
    expect(d.toTier).toBe(Tier.COLD);
  });

  it("AUDITABILITY: multiple failed gates are returned in canonical ALL_EVICTION_GATES order", () => {
    const now = asEpochMs(Date.now());
    // Fail LOW_UNIQUE_VALUE (no neighbor) + INDEP_SOURCE_COUNT_LE_1 (count 2)
    // + PAST_GRACE_FLOOR (observed just now, inside grace).
    const strand: Strand = {
      ...coldStrand({ now, descriptionValue: 2, provenance: [root("A", now)] }),
      observedAt: now, // inside grace => PAST_GRACE_FLOOR fails
    };
    const ev: EvictionEvidence = { ...cleanEvidence(), independentSourceCount: 2 };

    const d = evaluateEviction(strand, [], ev, now, cfg);

    expect(d.allowed).toBe(false);
    expect(d.failedGates).toContain(EvictionGate.LOW_UNIQUE_VALUE);
    expect(d.failedGates).toContain(EvictionGate.INDEP_SOURCE_COUNT_LE_1);
    expect(d.failedGates).toContain(EvictionGate.PAST_GRACE_FLOOR);

    // Order must match the canonical gate ordering (a stable, auditable contract).
    const canonical = ALL_EVICTION_GATES.filter((g) => d.failedGates.includes(g));
    expect(d.failedGates).toEqual(canonical);

    // Spot-check the actual ordering: LOW_UNIQUE_VALUE < INDEP_SOURCE_COUNT_LE_1 < PAST_GRACE_FLOOR.
    const idxLuv = d.failedGates.indexOf(EvictionGate.LOW_UNIQUE_VALUE);
    const idxCnt = d.failedGates.indexOf(EvictionGate.INDEP_SOURCE_COUNT_LE_1);
    const idxGrace = d.failedGates.indexOf(EvictionGate.PAST_GRACE_FLOOR);
    expect(idxLuv).toBeLessThan(idxCnt);
    expect(idxCnt).toBeLessThan(idxGrace);
  });
});
