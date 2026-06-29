/**
 * batch4M4DepthMargin.test.ts — BATCH 4 (RC-1) M4: the DEPTH-MARGIN gate on the
 * multi-class decisive auto-resolve. A SHALLOW challenger cannot overturn a DEEP
 * incumbent on reputation MAGNITUDE alone — the incumbency term reads
 * `independentRootCount` (the engine's `#R`) ONLY, never reputation magnitude /
 * establishment timestamp / arrival order. M4 can only ADD deferrals.
 *
 *  (a) M4 DEFER:  winner and runner-up of EQUAL depth (both 2) ⇒ winner not strictly
 *                 deeper ⇒ DEFER even with a decisive earned reputation gap.
 *  (b) M4 GUARD:  a DEEPER true challenger (depth 3 vs incumbent depth 2) with decisive
 *                 reputation RESOLVES — a deep true claim overturns a shallow one
 *                 (requirement (a) of the hard theorem preserved; anti-over-fix).
 *
 * Reputation is driven through a FIXED clock (`() => NOW`) so decay-on-read is Δt = 0.
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
  createStakeLedger,
  generatePassport,
  independenceBetween,
  AnchorClass,
  FactOrigin,
  FactState,
  Tier,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  AttributeKey,
  ContentHash,
  EntityId,
  IntelligentDb,
  KeyRegistryPort,
  Passport,
  PendingLedger,
  ProvenanceRoot,
  RatificationDeps,
  ReputationLedger,
  ReputationLedgerPort,
  SourceId,
  StakeLedgerPort,
  Strand,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: Passport): void {
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
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function bindingOf(anchorClass: AnchorClass, weight: number): AnchorBinding {
  return { anchorClass, realizedCost: weight as Unit, independenceWeight: weight as Unit };
}

function valueHash(value: string): ContentHash {
  return ("hash:" + value) as ContentHash;
}

function rootOf(idRaw: string, cls: string, sourceId: SourceId): ProvenanceRoot {
  return {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
}

function makeEngine(): {
  store: ReturnType<typeof createMemoryStore>;
  identity: ReturnType<typeof createSourceIdentityLayer>;
  reputation: ReputationLedger;
  ledger: PendingLedger;
  db: IntelligentDb;
} {
  const store = createMemoryStore();
  const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };
  const repPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const identity = createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: repPort,
    stake: stakePort,
  });
  const ledger = createPendingLedger({ reputation });
  const ratification: RatificationDeps = { ledger, systemSigner: generatePassport() };
  const db = createIntelligentDb(store, identity, null, reputation, ratification);
  return { store, identity, reputation, ledger, db };
}

function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  value: string,
  roots: readonly ProvenanceRoot[],
): Strand {
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { v: value },
    content_hash: valueHash(value),
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [...roots],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1 as Unit, last_fire_time: NOW, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: NOW,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
  store.putStrand(s);
  return s;
}

const SAME = "class:same";

// Distinct anchor classes so each source is a mutually-independent MIS root.
const W1 = "src:win1" as SourceId;
const W2 = "src:win2" as SourceId;
const W3 = "src:win3" as SourceId;
const C1 = "src:chal1" as SourceId;
const C2 = "src:chal2" as SourceId;

describe("BATCH 4 (a) — M4: equal-depth winner vs runner-up DEFERS (not strictly deeper)", () => {
  it("two depth-2 claims with a decisive earned reputation gap still DEFER on the depth-margin", () => {
    const eng = makeEngine();
    // Berlin (incumbent value): two anchor-disjoint actors ⇒ depth 2.
    eng.identity.register({ ...generatePassport(), sourceId: W1 } as Passport, [bindingOf(AnchorClass.DOMAIN, 0.35)]);
    eng.identity.register({ ...generatePassport(), sourceId: W2 } as Passport, [bindingOf(AnchorClass.PHONE_SIM, 0.2)]);
    // Tokyo (challenger value): two anchor-disjoint actors ⇒ depth 2 — and the HIGHER
    // reputation (the magnitude-only lever M4 must NOT honor over equal depth).
    eng.identity.register({ ...generatePassport(), sourceId: C1 } as Passport, [bindingOf(AnchorClass.HARDWARE_ATTESTATION, 0.45)]);
    eng.identity.register({ ...generatePassport(), sourceId: C2 } as Passport, [bindingOf(AnchorClass.VERIFIED_HUMAN, 0.7)]);
    // Earn ONLY the PRIMARY challenger source a decisive, earned reputation (the
    // co-asserter stays rep-0 so the top-vs-runner DECISIVE gap is real and the dispute
    // WOULD auto-resolve pre-M4 — isolating the depth-margin as the SOLE defer cause).
    for (let i = 0; i < 8; i++) eng.reputation.ratify(C1, NOW, 1);

    fileStrand(eng.store, "strand:w1", "Berlin", [rootOf("w1", "class:w1", W1)]);
    fileStrand(eng.store, "strand:w2", "Berlin", [rootOf("w2", "class:w2", W2)]);
    fileStrand(eng.store, "strand:c1", "Tokyo", [rootOf("c1", "class:c1", C1)]);
    fileStrand(eng.store, "strand:c2", "Tokyo", [rootOf("c2", "class:c2", C2)]);

    const outcome = eng.db.adjudicate(ATTR);
    expect(outcome.kind).toBe("DEFERRED"); // dWin(2) < dRun(2) + 1 ⇒ DEFER
    // Nothing demoted — the human horn owns this equal-depth dispute.
    expect(eng.store.getStrand(asStrandId("strand:w1"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.store.getStrand(asStrandId("strand:c1"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.ledger.listPending().length).toBeGreaterThanOrEqual(1);
  });
});

describe("BATCH 4 (b) — M4 GUARD: a strictly DEEPER true challenger RESOLVES (anti-over-fix)", () => {
  it("a depth-3 challenger with decisive reputation overturns a depth-2 incumbent", () => {
    const eng = makeEngine();
    // Tokyo (deeper challenger value): THREE anchor-disjoint actors ⇒ depth 3.
    eng.identity.register({ ...generatePassport(), sourceId: C1 } as Passport, [bindingOf(AnchorClass.HARDWARE_ATTESTATION, 0.45)]);
    eng.identity.register({ ...generatePassport(), sourceId: C2 } as Passport, [bindingOf(AnchorClass.VERIFIED_HUMAN, 0.7)]);
    eng.identity.register({ ...generatePassport(), sourceId: W3 } as Passport, [bindingOf(AnchorClass.DOMAIN, 0.35)]);
    // Berlin (shallow incumbent value): two anchor-disjoint actors ⇒ depth 2.
    eng.identity.register({ ...generatePassport(), sourceId: W1 } as Passport, [bindingOf(AnchorClass.PHONE_SIM, 0.2)]);
    eng.identity.register({ ...generatePassport(), sourceId: W2 } as Passport, [bindingOf(AnchorClass.ORGANIZATION, 0.75)]);
    // Only the PRIMARY challenger source earns the decisive reputation (the depth-3
    // comes from DISJOINT ANCHORS, not reputation — depth is anchor-keyed, not magnitude).
    for (let i = 0; i < 8; i++) eng.reputation.ratify(C1, NOW, 1);

    // Tokyo backed by 3 disjoint actors (depth 3).
    fileStrand(eng.store, "strand:c1", "Tokyo", [rootOf("c1", "class:c1", C1)]);
    fileStrand(eng.store, "strand:c2", "Tokyo", [rootOf("c2", "class:c2", C2)]);
    fileStrand(eng.store, "strand:c3", "Tokyo", [rootOf("c3", "class:c3", W3)]);
    // Berlin backed by 2 disjoint actors (depth 2).
    fileStrand(eng.store, "strand:b1", "Berlin", [rootOf("b1", "class:b1", W1)]);
    fileStrand(eng.store, "strand:b2", "Berlin", [rootOf("b2", "class:b2", W2)]);

    const outcome = eng.db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED"); // dWin(3) >= dRun(2) + 1 ⇒ the deeper claim wins
    // The deeper TRUE value stays LIVE; the shallow losers fall.
    expect(eng.store.getStrand(asStrandId("strand:c1"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.store.getStrand(asStrandId("strand:c2"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.store.getStrand(asStrandId("strand:b1"))?.fact_state).toBe(FactState.DEMOTED);
    expect(eng.store.getStrand(asStrandId("strand:b2"))?.fact_state).toBe(FactState.DEMOTED);
  });
});

// ===========================================================================
// M3 anti-grief — the per-source-pair contradiction RATE-LIMIT (OD-2 seam family).
// A single contradictor→target pair may add a NON-DECAYING scar at most ONCE per
// class per window; a stacked re-adjudication falls back to an ordinary contradiction
// so one attacker cannot pile scars on an honest incumbent.
// ===========================================================================

describe("BATCH 4 — M3 anti-grief: per-source-pair scar rate-limit (single-class adjudicate)", () => {
  it("re-adjudicating the SAME winner→loser pair within the window scars at most ONCE", () => {
    const eng = makeEngine();
    // One independence class (echo dispute, the SAFE in-graph path): a high-rep winner
    // outranks a rep-0 loser by EXTERNAL signal — losers are demoted + their source
    // contradicted. The FIRST adjudicated contradiction SCARS; a stacked re-run does NOT.
    eng.identity.register({ ...generatePassport(), sourceId: W1 } as Passport, [bindingOf(AnchorClass.DOMAIN, 0.35)]);
    eng.identity.register({ ...generatePassport(), sourceId: C1 } as Passport, [bindingOf(AnchorClass.DOMAIN, 0.35)]);
    for (let i = 0; i < 8; i++) eng.reputation.ratify(W1, NOW, 1); // the winner earns trust

    fileStrand(eng.store, "strand:win", "Berlin", [rootOf("win", SAME, W1)]);
    fileStrand(eng.store, "strand:lose1", "Tokyo", [rootOf("lose1", SAME, C1)]);

    expect(eng.db.adjudicate(ATTR).kind).toBe("RESOLVED");
    const afterFirst = eng.reputation.stateOf(C1)!;
    expect(afterFirst.scarBeta).toBeCloseTo(4, 12); // first betrayal: scarred (c·w = 4)

    // STACK a second dispute from the SAME loser source (same pair, same class, same
    // window). It is demoted again, but the contradiction is RATE-LIMITED ⇒ ordinary
    // (decaying) β, NOT another non-decaying scar.
    fileStrand(eng.store, "strand:lose2", "Paris", [rootOf("lose2", SAME, C1)]);
    expect(eng.db.adjudicate(ATTR).kind).toBe("RESOLVED");
    const afterSecond = eng.reputation.stateOf(C1)!;
    expect(afterSecond.scarBeta).toBeCloseTo(4, 12); // scar did NOT stack (rate-limited)
    expect(afterSecond.contradictedCount).toBeGreaterThan(afterFirst.contradictedCount); // still recorded
  });
});
