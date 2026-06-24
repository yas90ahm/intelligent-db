/**
 * engineAdjudicate.test.ts — the ENGINE wiring of adjudicate / listPending / approve.
 *
 * Pins the invariants the verifier checks at the api.ts seam:
 *  - INVARIANT 3 (NO AUTO-RESOLVE): a multi-independence-class dispute, adjudicated
 *    through the engine, is DEFERRED — recorded as a signed PENDING in the ledger —
 *    and EVERY member stays LIVE. The web never picks an in-graph winner.
 *  - END-TO-END APPROVE: an external, distinct approver resolves the deferred
 *    dispute through the engine; the loser is persisted DEMOTED + outranked_by, the
 *    OUTRANKS edge is written to the store, and the chain still verifies.
 *  - SAFE CASE still resolves in-graph (single class) without the human horn.
 *
 * Everything runs through the public barrel + a real in-memory store + identity layer.
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createStakeLedger,
  createPendingLedger,
  createReputationLedger,
  createAdjudicationProvenanceLedger,
  createCorroborationLedger,
  downstreamDisownSweep,
  OffLedgerReputationError,
  generatePassport,
  independenceBetween,
  FactState,
  FactOrigin,
  Tier,
  EdgeType,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  AttributeKey,
  EntityId,
  SourceId,
  Unit,
  AnchorBinding,
  ProvenanceRoot,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  Passport,
  Strand,
  ContradictionSetId,
  RatificationDeps,
} from "../index.js";

// (IdentityStamp imported indirectly via the identity layer; no direct use here.)

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- minimal pillar ports (mirrors smoke.test.ts) --------------------------

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
      return best;
    },
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

/** A reputation-bearing identity layer wired over a shared reputation ledger. */
function makeIdentity(reputation: ReputationLedgerPort): SourceIdentityLayer {
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };
  return createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

/**
 * Hand-build an OBSERVED strand about (ENTITY, ATTR) authored by `sourceId` in
 * independence class `cls`, then file it directly into the store (bypassing
 * writeFact so we control the independence class — writeFact derives one class per
 * source key, but we want explicit multi-class disputes).
 */
function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  sourceId: SourceId,
  cls: string,
  payload: unknown,
): Strand {
  const root: ProvenanceRoot = {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload,
    content_hash: ("hash:" + JSON.stringify(payload)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [root],
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
  store.putStrand(s);
  return s;
}

describe("engine.adjudicate — routing the consolidation outcome", () => {
  it("INVARIANT 3: a multi-class dispute DEFERS, records a signed PENDING, demotes NOTHING", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const systemSigner = generatePassport();
    const ratification: RatificationDeps = { ledger, systemSigner };

    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // Two DISAGREEING claims from DISTINCT independence classes => independent.
    const a = fileStrand(store, "strand:a", "src:a" as SourceId, "class:A", { v: "Germany" });
    const b = fileStrand(store, "strand:b", "src:b" as SourceId, "class:B", { v: "Atlantis" });

    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("DEFERRED");

    // The web decided NOTHING: both members stay LIVE, neither outranked.
    expect(store.getStrand(a.id)?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(b.id)?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(a.id)?.outranked_by).toBeNull();
    expect(store.getStrand(b.id)?.outranked_by).toBeNull();

    // A signed PENDING is now in the immortal ledger, and it verifies.
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
    expect(ledger.verifyChain().ok).toBe(true);

    // listPending surfaces the open dispute for a human reviewer (rep-ranked).
    const open = db.listPending();
    expect(open.length).toBe(1);
    expect(open[0]!.attribute).toBe(ATTR);
  });

  it("END-TO-END: an external approve() through the engine resolves the deferred dispute", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const systemSigner = generatePassport();
    const db = createIntelligentDb(store, identity, null, reputation, {
      ledger,
      systemSigner,
    });

    const a = fileStrand(store, "strand:a", "src:a" as SourceId, "class:A", { v: "Germany" });
    const b = fileStrand(store, "strand:b", "src:b" as SourceId, "class:B", { v: "Atlantis" });
    expect(db.adjudicate(ATTR).kind).toBe("DEFERRED");

    // An EXTERNAL, distinct approver designates a as the winner.
    const approver = generatePassport(); // not src:a, not src:b
    const csid = ledger.listPending()[0]!.contradictionSetId as ContradictionSetId;
    const resolved = db.approve(csid, a.id, approver, NOW);

    expect(resolved.winner).toBe(a.id);

    // Winner LIVE; loser persisted DEMOTED + outranked_by; OUTRANKS edge in the store.
    expect(store.getStrand(a.id)?.fact_state).toBe(FactState.LIVE);
    const loser = store.getStrand(b.id)!;
    expect(loser.fact_state).toBe(FactState.DEMOTED);
    expect(loser.outranked_by).not.toBeNull();

    const edge = store.getEdge(resolved.outranksEdges[0]!.id);
    expect(edge).not.toBeNull();
    expect(edge?.edgeType).toBe(EdgeType.OUTRANKS);
    expect(edge?.from).toBe(a.id);
    expect(edge?.to).toBe(b.id);

    // The immortal record now holds PENDING + APPROVAL and verifies end-to-end.
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    expect(db.listPending().length).toBe(0);

    // Reputation: winner's author earned trust; loser's author was contradicted.
    expect(reputation.scoreOf("src:a" as SourceId)).toBeGreaterThan(0);
    expect(reputation.stateOf("src:b" as SourceId)?.contradictedCount).toBe(1);
  });

  it("engine.approve through a self-approver (authored a member) is REJECTED", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const systemSigner = generatePassport();
    const db = createIntelligentDb(store, identity, null, reputation, {
      ledger,
      systemSigner,
    });

    // The approver's OWN source authors member a => self-approval must be rejected.
    const approver = generatePassport();
    const a = fileStrand(store, "strand:a", approver.sourceId, "class:A", { v: "Germany" });
    const b = fileStrand(store, "strand:b", "src:b" as SourceId, "class:B", { v: "Atlantis" });
    expect(db.adjudicate(ATTR).kind).toBe("DEFERRED");
    void a;
    void b;

    const csid = ledger.listPending()[0]!.contradictionSetId as ContradictionSetId;
    expect(() => db.approve(csid, b.id, approver, NOW)).toThrow(/self-approval/i);

    // Nothing demoted; the dispute is still open and only the PENDING record exists.
    expect(store.getStrand(a.id)?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(b.id)?.fact_state).toBe(FactState.LIVE);
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
  });

  it("SAFE single-class dispute RESOLVES in-graph (no human horn) and demotes the loser", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const db = createIntelligentDb(store, identity, null, reputation, {
      ledger,
      systemSigner: generatePassport(),
    });

    // Same independence class => echo dispute => SAFE; reputation drives the winner.
    // Pre-earn reputation for src:a so it outranks the fresh src:b.
    reputation.ratify("src:a" as SourceId, NOW);
    const a = fileStrand(store, "strand:a", "src:a" as SourceId, "class:X", { v: "Germany" });
    const b = fileStrand(store, "strand:b", "src:b" as SourceId, "class:X", { v: "Atlantis" });

    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED");

    // The lower-reputation challenger b is demoted; a stays LIVE. No PENDING recorded.
    expect(store.getStrand(a.id)?.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(b.id)?.fact_state).toBe(FactState.DEMOTED);
    expect(store.getStrand(b.id)?.outranked_by).not.toBeNull();
    expect(ledger.records().length).toBe(0); // resolved in-graph, no human horn
  });

  it("DEFERRED with NO ledger wired THROWS (a deferral is never silently dropped)", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    // No ratification deps passed.
    const db = createIntelligentDb(store, identity, null, reputation);

    fileStrand(store, "strand:a", "src:a" as SourceId, "class:A", { v: "Germany" });
    fileStrand(store, "strand:b", "src:b" as SourceId, "class:B", { v: "Atlantis" });

    expect(() => db.adjudicate(ATTR)).toThrow(/no ratification ledger is wired/i);
  });
});

// ===========================================================================
// UNDO-ENGINE HARDENING — engine-level integration (api.ts wiring)
// ===========================================================================

describe("engine hardening integration", () => {
  it("HARDENING 3: adjudicate RECORDS provenance, and a later disown RE-OPENS the tipped dispute", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const systemSigner = generatePassport();
    const adjudicationProvenance = createAdjudicationProvenanceLedger();
    const ratification: RatificationDeps = { ledger, systemSigner, adjudicationProvenance };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // SAFE single-class dispute: src:a (pre-earned) outranks fresh src:b => RESOLVED,
    // and the engine records the adjudication provenance (winner + margin + support).
    reputation.ratify("src:winner" as SourceId, NOW);
    const a = fileStrand(store, "strand:a", "src:winner" as SourceId, "class:X", { v: "Germany" });
    const b = fileStrand(store, "strand:b", "src:loser" as SourceId, "class:X", { v: "Atlantis" });

    expect(db.adjudicate(ATTR).kind).toBe("RESOLVED");
    const recs = adjudicationProvenance.all();
    expect(recs.length).toBe(1);
    expect(recs[0]!.winner).toBe(a.id);
    expect(recs[0]!.contributingStrandIds).toContain(a.id);
    void b;

    // Now DISOWN the winner's source: the recorded margin's sole contributor (the
    // winner strand) is tainted, so the dispute re-opens for a human.
    const res = downstreamDisownSweep(
      "src:winner" as SourceId,
      [a.id],
      store,
      reputation,
      NOW,
      undefined,
      undefined,
      { adjudicationProvenance, pending: ledger, systemSigner, decisiveMargin: 0.3 },
    );
    expect(res.reopenedDisputes).toContain(recs[0]!.contradictionSetId);
    const reopened = db.listPending().find((p) => p.contradictionSetId === recs[0]!.contradictionSetId);
    expect(reopened?.reason).toBe("REOPENED_BY_DISOWN");
  });

  it("HARDENING 2: ratify() THROWS OffLedgerReputationError when it earns credit naming corroborators but no corroboration ledger is wired", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    // NOTE: no `corroboration` in the ratification deps — so a corroboration-naming
    // ratify that earns α has NO place to record the event ⇒ off-ledger ⇒ throws.
    const db = createIntelligentDb(store, identity, null, reputation, {
      ledger,
      systemSigner: generatePassport(),
    });

    const witness = fileStrand(store, "strand:w", "src:w" as SourceId, "class:W", { v: "x" });
    const target = fileStrand(store, "strand:t", "src:t" as SourceId, "class:T", { v: "y" });
    const externalStamp = identity.stampFor("src:ext" as SourceId);

    expect(() =>
      db.ratify({
        strandId: target.id,
        externalStamp,
        corroboratingStrandIds: [witness.id],
      }),
    ).toThrow(OffLedgerReputationError);
  });

  it("HARDENING 2: the same ratify SUCCEEDS and records an event when a corroboration ledger IS wired", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const corroboration = createCorroborationLedger();
    const db = createIntelligentDb(store, identity, null, reputation, {
      ledger,
      systemSigner: generatePassport(),
      corroboration,
    });

    const witness = fileStrand(store, "strand:w", "src:w" as SourceId, "class:W", { v: "x" });
    const target = fileStrand(store, "strand:t", "src:t" as SourceId, "class:T", { v: "y" });
    const externalStamp = identity.stampFor("src:ext" as SourceId);

    db.ratify({ strandId: target.id, externalStamp, corroboratingStrandIds: [witness.id] });
    expect(corroboration.all().length).toBe(1);
    expect(corroboration.all()[0]!.beneficiarySourceId).toBe("src:ext" as SourceId);
  });
});
