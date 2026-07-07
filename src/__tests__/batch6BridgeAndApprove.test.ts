/**
 * batch6BridgeAndApprove.test.ts — BATCH 6 (final): B1 + B2 + RC-5.
 *
 * Each attack probe is paired with its anti-over-fix guard in ONE test (G3):
 *
 *  B1 [STRUCTURAL-soft/PARTIAL] — bridge-seed γ down-weight by ORIGIN independence.
 *    • a weak-stamped (0<indep<1) bridge is seeded BELOW γ (poison bridge blunted);
 *    • a BARE-KEY (indep==0) bridge STAYS at γ (fail-open — an honest bare-key
 *      INSIGHT bridge is internally indistinguishable, so it must not be suppressed);
 *    • the down-weight NEVER applies on the LOCAL activation walk
 *      (bridgesCrossed==0 meaningfulness assert proves B1 did not leak, not vacuous).
 *
 *  B2 — order the bounded ~20% sub-budget by `earned_bridge_value` DESC so SIGNAL
 *    (earned bridges) is spent before DECOYS (earned_value 0), id-tiebroken ASC.
 *
 *  RC-5 [STRUCTURAL] — approve() MIS anchor-disjointness gate:
 *    • a BARE-KEY approver (anchor_cost==0) is REJECTED even if class-disjoint;
 *    • an ANCHOR-CORRELATED approver (not independentSources of an author) is REJECTED;
 *    • a genuinely anchor-INDEPENDENT + ANCHORED approver STILL RESOLVES the dispute.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  // B1/B2 — the halting controller + its config
  createHaltingController,
  DEFAULT_WALK_CONFIG,
  // engine + store for the full-recall local-walk meaningfulness assert
  createIntelligentDb,
  createMemoryStore,
  // identity layer wiring for the RC-5 predicate unit test
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  independenceBetween,
  // enums / brand helpers
  AnchorClass,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
  computeEdgeWeight,
} from "../index.js";

import type {
  Activation,
  Unit,
  EdgeId,
  StrandId,
  EpochMs,
  HaltContext,
  HaltStoreView,
  Edge,
  Strand,
  SourceId,
  AnchorBinding,
  SourceRef,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  ApproveContext,
  EntityId,
  AttributeKey,
  ContradictionSetId,
  PendingRatification,
} from "../index.js";

// ===========================================================================
// Shared controller-driving harness (B1 + B2)
// ===========================================================================

const NEAR = asStrandId("strand:near");

/**
 * A mock {@link HaltStoreView}: the near strand owns `bridges`; each bridge maps
 * to an independence stamp (B1) and an earned_bridge_value (B2) and a far target.
 */
function mockStore(
  bridges: readonly EdgeId[],
  indep: ReadonlyMap<EdgeId, number>,
  earned: ReadonlyMap<EdgeId, number>,
): HaltStoreView {
  return {
    independentClassCount: () => 1,
    litBridgesFrom: (s: StrandId) => (s === NEAR ? bridges : []),
    bridgeTarget: (e: EdgeId) => asStrandId("far:" + String(e)),
    bridgeIndependence: (e: EdgeId) => indep.get(e) ?? 0,
    bridgeEarnedValue: (e: EdgeId) => earned.get(e) ?? 0,
  };
}

function ctxFor(store: HaltStoreView): HaltContext {
  return {
    strandId: NEAR,
    activation: 1 as Activation,
    newIndependentCorroboration: 0 as Unit,
    now: asEpochMs(0),
    store,
  };
}

/** Drive a controller through onPop(near) → sweep, returning the ordered crossings. */
function crossingsOf(
  bridges: readonly EdgeId[],
  indep: ReadonlyMap<EdgeId, number>,
  earned: ReadonlyMap<EdgeId, number>,
): { seeds: Activation[]; order: EdgeId[]; downweighted: number } {
  const store = mockStore(bridges, indep, earned);
  const ctx = ctxFor(store);
  const ctl = createHaltingController(DEFAULT_WALK_CONFIG);
  ctl.onPop(ctx); // records `near` into litStrands so the sweep can enumerate it
  ctl.beginBridgeSweep(ctx);

  const seeds: Activation[] = [];
  const order: EdgeId[] = [];
  for (;;) {
    const c = ctl.nextBridgeCrossing(ctx);
    if (c === null) break;
    order.push(c.bridgeEdge);
    seeds.push(c.seedActivation);
    // Report a positive yield so the zero-yield circuit-breaker never trips and the
    // sweep visits every owed bridge (B2 ordering needs the full enumeration).
    ctl.recordCrossingYield({
      bridgeEdge: c.bridgeEdge,
      yieldCorroboration: 1 as Unit,
      popsConsumed: 1,
    });
  }
  return { seeds, order, downweighted: ctl.finalStamp().bridgeSeedsDownweighted };
}

// ===========================================================================
// B1 — bridge-seed γ down-weight by origin independence
// ===========================================================================

describe("B1 — bridge-seed down-weight (gated, fail-open)", () => {
  const gamma = DEFAULT_WALK_CONFIG.gamma;

  it("weak stamp (0<indep<1) down-weights the seed BELOW γ; bare-key STAYS at γ (G3)", () => {
    const weak = asEdgeId("edge:weak"); // resolved-but-weak anchor stamp
    const bare = asEdgeId("edge:bare"); // bare-key / stamp-absent
    const { seeds, order, downweighted } = crossingsOf(
      [weak, bare],
      new Map([
        [weak, 0.5],
        [bare, 0], // 0 ⇒ fail-open ⇒ stays at γ
      ]),
      new Map(), // earned 0 for both ⇒ id tiebreak: edge:bare < edge:weak
    );

    const seedOf = (e: EdgeId): number => seeds[order.indexOf(e)]!;
    // ATTACK side: the weak-stamped poison bridge is seeded proportionally below γ.
    expect(seedOf(weak)).toBeCloseTo(gamma * 0.5, 10);
    expect(seedOf(weak)).toBeLessThan(gamma);
    // ANTI-OVER-FIX side: the indistinguishable bare-key bridge is NEVER suppressed.
    expect(seedOf(bare)).toBe(gamma);
    // Exactly ONE crossing was down-weighted (the weak one), and the seed is never 0.
    expect(downweighted).toBe(1);
    expect(seedOf(weak)).toBeGreaterThan(0);
  });

  it("indep >= 1 clamps the factor to 1 (never an UP-weight — termination proof intact)", () => {
    const e = asEdgeId("edge:clamp");
    const { seeds, downweighted } = crossingsOf([e], new Map([[e, 1]]), new Map());
    expect(seeds[0]).toBe(gamma); // factor clamps to 1; seed ∈ [0, γ]
    expect(downweighted).toBe(0); // factor==1 is not a down-weight
  });

  it("B1 NEVER applies on the LOCAL walk (bridgesCrossed==0 meaningfulness assert)", () => {
    // A two-strand LOCAL web joined by a SHARED_ENTITY edge whose own
    // provenance_independence is WEAK (0.5). If B1 leaked onto the local walk, the
    // sibling would be seeded below γ; it must NOT — local seeds are untouched.
    const at = asEpochMs(Date.now());
    const mk = (idRaw: string, ent: string, cls: string): Strand => ({
      id: asStrandId(idRaw),
      entity: ent as EntityId,
      attribute: null,
      payload: { note: idRaw },
      content_hash: idRaw as Strand["content_hash"],
      origin: FactOrigin.OBSERVED,
      fact_state: FactState.LIVE,
      tier: Tier.WARM,
      provenance: [
        {
          rootId: ("root:" + idRaw) as Strand["provenance"][number]["rootId"],
          independenceClass: cls as Strand["provenance"][number]["independenceClass"],
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
    });

    // DIFFERENT entities so the ONLY path to `sib` is the explicit SHARED_ENTITY
    // edge (no index-derived sibling fan to perturb the exact local energy).
    let seed = mk("strand:seed", "entity:web1", "class:a");
    let sib = mk("strand:sib", "entity:web2", "class:b");
    const wLocal = computeEdgeWeight(1 as Unit, 0.5 as Unit, 1 as Unit); // WEAK indep=0.5
    const localEdge: Edge = {
      id: asEdgeId("edge:local"),
      from: seed.id,
      to: sib.id,
      edgeType: EdgeType.SHARED_ENTITY, // NOT a bridge — B1 must never touch it
      link_confidence: 1 as Unit,
      provenance_independence: 0.5 as Unit,
      recency: 1 as Unit,
      w: wLocal,
      out_weight_sum: wLocal,
    };
    seed = { ...seed, outEdges: [localEdge.id] };
    sib = { ...sib, inEdges: [localEdge.id] };

    const store = createMemoryStore();
    store.putStrand(seed);
    store.putStrand(sib);
    store.putEdge(localEdge);
    store.recomputeOutWeightSum(seed.id);

    const db = createIntelligentDb(store, makeIdentityLayer());
    const result = db.recall({ seeds: [{ strandId: seed.id, energy: 1 }] });

    const litIds = result.lit.map((l) => l.strandId);
    // MEANINGFULNESS: the local walk actually RAN (sibling lit) — not a vacuous pass.
    expect(litIds).toContain(seed.id);
    expect(litIds).toContain(sib.id);
    // No bridge existed ⇒ no crossing, and B1's stamp must read 0 (it never fired).
    expect(result.halt.bridgesCrossed).toBe(0);
    expect(result.halt.bridgeSeedsDownweighted).toBe(0);
    // The sibling's energy is the share-normalized LOCAL energy (single out edge ⇒
    // share factor 1 ⇒ exactly γ), NOT γ*0.5: B1 did NOT down-weight the local seed.
    const sibEnergy = result.lit.find((l) => l.strandId === sib.id)?.activation ?? 0;
    expect(sibEnergy).toBe(gamma);
    expect(sibEnergy).not.toBe(gamma * 0.5);
  });
});

// ===========================================================================
// B2 — order pendingBridges by earned_bridge_value (signal before decoys)
// ===========================================================================

describe("B2 — bridge-sweep ordering (signal before decoys)", () => {
  it("a genuine bridge (earned>0) is crossed BEFORE a decoy (earned==0)", () => {
    const decoy = asEdgeId("edge:decoy");
    const signal = asEdgeId("edge:signal");
    // Enumerated DECOY-FIRST on purpose — the sort must REORDER signal to the front.
    const { order } = crossingsOf(
      [decoy, signal],
      new Map(), // indep 0 for both ⇒ B1 irrelevant here (seeds stay γ)
      new Map([
        [decoy, 0],
        [signal, 5],
      ]),
    );
    expect(order[0]).toBe(signal); // earned 5 sorts first
    expect(order[1]).toBe(decoy); // earned 0 sorts last
  });

  it("ties (equal earned_value) break DETERMINISTICALLY by EdgeId ASC", () => {
    const b = asEdgeId("edge:b");
    const a = asEdgeId("edge:a");
    // Enumerated b-first; both earned 0 ⇒ tiebreak must put a (asc id) first.
    const { order } = crossingsOf([b, a], new Map(), new Map());
    expect(order[0]).toBe(a);
    expect(order[1]).toBe(b);
  });
});

// ===========================================================================
// RC-5 — approve() MIS anchor-disjointness gate
// ===========================================================================

// ---- minimal identity-layer pillar ports (lean on the REAL anchor math) -----

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register: (p: SourceRef) => void known.add(p.sourceId),
    sourceIdOf: (s: SourceId) => (known.has(s) ? s : null),
    has: (s: SourceId) => known.has(s),
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind: (s: SourceId, anchors: readonly AnchorBinding[]) =>
      book.set(s, [...(book.get(s) ?? []), ...anchors]),
    anchorsOf: (s: SourceId) => book.get(s) ?? [],
    aggregateCost: (anchors: readonly AnchorBinding[]) => {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween: (a, b) => independenceBetween([...a], [...b]),
  };
}

function makeIdentityLayer(): SourceIdentityLayer {
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: { scoreOf: () => 0 as Unit } satisfies ReputationLedgerPort,
    // Staking is RETIRED (attribution replaces stake): a constant-zero port.
    stake: { postedFor: () => 0 } satisfies StakeLedgerPort,
  });
}

const domainAnchor = (): AnchorBinding => ({
  anchorClass: AnchorClass.DOMAIN,
  realizedCost: 0.35 as Unit,
  independenceWeight: 0.35 as Unit,
});
const humanAnchor = (): AnchorBinding => ({
  anchorClass: AnchorClass.VERIFIED_HUMAN,
  realizedCost: 0.7 as Unit,
  independenceWeight: 0.7 as Unit,
});

describe("RC-5 — identity facade independence predicates (engine-supplied)", () => {
  it("anchored + anchor-disjoint ⇒ independent; same-class ⇒ NOT; bare-key ⇒ no anchors", () => {
    const id = makeIdentityLayer();
    const approver = freshSource();
    const authorDisjoint = freshSource();
    const authorSameClass = freshSource();
    const bareKey = freshSource();

    id.register(approver, [domainAnchor()]);
    id.register(authorDisjoint, [humanAnchor()]); // disjoint costly anchor
    id.register(authorSameClass, [domainAnchor()]); // shares the DOMAIN class
    id.register(bareKey, []); // no priced anchor

    // independentSources: disjoint costly anchors ⇒ true; shared class ⇒ false.
    expect(id.independentSources(approver.sourceId, authorDisjoint.sourceId)).toBe(true);
    expect(id.independentSources(approver.sourceId, authorSameClass.sourceId)).toBe(false);
    // approverHasAnchors precondition (anchor_cost > 0).
    expect(id.stampFor(approver.sourceId).anchor_cost).toBeGreaterThan(0);
    expect(id.stampFor(bareKey.sourceId).anchor_cost).toBe(0);
    // a source is never independent of itself (echo).
    expect(id.independentSources(approver.sourceId, approver.sourceId)).toBe(false);
  });
});

// ---- the approve() gate itself (ledger-level, controllable ctx) --------------

const NOW = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;
const CSID = "cset:berlin#capital_of" as ContradictionSetId;

function disputeStrand(idRaw: string, sourceId: SourceId): Strand {
  return {
    id: asStrandId(idRaw),
    entity: "entity:berlin" as EntityId,
    attribute: ATTR,
    payload: { v: idRaw },
    content_hash: idRaw as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + idRaw) as Strand["provenance"][number]["rootId"],
        independenceClass: ("class:" + idRaw) as Strand["provenance"][number]["independenceClass"],
        sourceId,
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
    contradiction_set: CSID,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}

const pendingOf = (members: StrandId[]): PendingRatification => ({
  contradictionSetId: CSID,
  attribute: ATTR,
  members,
  reason: "INDEPENDENT_DISPUTE",
  createdAt: NOW,
});

/** A configurable ApproveContext: the RC-5 predicates are knobs per test. */
function ctxOver(
  byId: Map<StrandId, Strand>,
  opts: { hasAnchors: boolean; independent: boolean },
): ApproveContext {
  return {
    authorsOf(memberId: StrandId): readonly SourceId[] {
      const s = byId.get(memberId);
      if (s === undefined) return [];
      const out: SourceId[] = [];
      for (const r of s.provenance) if (r.sourceId !== null) out.push(r.sourceId);
      return out;
    },
    memberStrand(memberId: StrandId): Strand {
      const s = byId.get(memberId);
      if (s === undefined) throw new Error("no member " + String(memberId));
      return s;
    },
    mintEdgeId: (w: StrandId, l: StrandId) =>
      ("edge:outranks:" + String(w) + "->" + String(l)) as EdgeId,
    independentSources: (_a: SourceId, _b: SourceId) => opts.independent,
    approverHasAnchors: (_s: SourceId) => opts.hasAnchors,
  };
}

describe("RC-5 — approve() rejects bare-key / correlated approvers, resolves the genuine one", () => {
  function setup(): { byId: Map<StrandId, Strand>; a: StrandId; b: StrandId } {
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      [a, disputeStrand("strand:a", "src:a" as SourceId)],
      [b, disputeStrand("strand:b", "src:b" as SourceId)],
    ]);
    return { byId, a, b };
  }

  it("(a) a BARE-KEY approver is REJECTED even though class-disjoint (no anchor → no voice)", () => {
    const { byId, a, b } = setup();
    const sys = freshSource();
    const approver = freshSource();
    const ledger = createPendingLedger();
    ledger.appendPending(pendingOf([a, b]), sys.sourceId);

    // independent==true, but hasAnchors==false ⇒ rejected on the precondition.
    expect(() =>
      ledger.approve(CSID, a, approver.sourceId, NOW, ctxOver(byId, { hasAnchors: false, independent: true })),
    ).toThrow(/no priced anchor/i);
    // No APPROVAL was appended; the dispute remains open (fail-closed, additive).
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
    expect(ledger.listPending().length).toBe(1);
  });

  it("(b) an ANCHOR-CORRELATED approver (not independentSources of an author) is REJECTED", () => {
    const { byId, a, b } = setup();
    const sys = freshSource();
    const approver = freshSource();
    const ledger = createPendingLedger();
    ledger.appendPending(pendingOf([a, b]), sys.sourceId);

    // anchored, but NOT MIS-independent of a member author ⇒ rejected.
    expect(() =>
      ledger.approve(CSID, a, approver.sourceId, NOW, ctxOver(byId, { hasAnchors: true, independent: false })),
    ).toThrow(/not anchor-independent/i);
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
    expect(ledger.listPending().length).toBe(1);
  });

  it("(c) a genuinely anchor-INDEPENDENT + ANCHORED approver STILL RESOLVES (anti-over-fix)", () => {
    const { byId, a, b } = setup();
    const sys = freshSource();
    const approver = freshSource();
    const reputation = createReputationLedger(() => 0.9);
    const ledger = createPendingLedger({ reputation });
    ledger.appendPending(pendingOf([a, b]), sys.sourceId);

    const resolved = ledger.approve(
      CSID,
      a,
      approver.sourceId,
      NOW,
      ctxOver(byId, { hasAnchors: true, independent: true }),
    );

    // Winner LIVE, loser DEMOTED + outranked_by + OUTRANKS edge persisted.
    expect(resolved.winner).toBe(a);
    expect(byId.get(a)!.fact_state).toBe(FactState.LIVE);
    expect(byId.get(b)!.fact_state).toBe(FactState.DEMOTED);
    expect(byId.get(b)!.outranked_by).not.toBeNull();
    expect(resolved.outranksEdges.length).toBe(1);
    // Reputation moved (winner author up, loser author contradicted) and the
    // APPROVAL is appended with a verifying chain.
    expect(reputation.scoreOf("src:a" as SourceId)).toBeGreaterThan(0);
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    expect(ledger.listPending().length).toBe(0);
  });
});
