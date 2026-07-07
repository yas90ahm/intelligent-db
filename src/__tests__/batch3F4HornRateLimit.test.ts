/**
 * batch3F4HornRateLimit.test.ts — BATCH 3 acceptance gates.
 *
 * Locks the three bundled V2.md items:
 *
 *  F4a [STRUCTURAL, UNCONDITIONAL] — the engine applies a >= 2-independent-root floor on
 *      EVERY multi-class decisive auto-resolve, REGARDLESS of `highImpact`:
 *        A3  a single-source (#R = 1) multi-class dispute DEFERS for BOTH intents.
 *        A4  a genuinely >= 2-disjoint-root winner still RESOLVES (the false-defer guard,
 *            priced-not-prevented honesty control). [paired with A3 in one test]
 *      SCOPE (fp-4 guard): the SINGLE-CLASS echo-collapse path is NOT subject to the
 *      root-floor — a same-class flood still resolves in-graph (never a DEFER-DoS).
 *
 *  F4b [POLICY-interim] — an attribute-scoped corroboration COUNT floor at adjudicate:
 *      a winner with a high GLOBAL reputation but ZERO in-domain co-asserter on the
 *      disputed value DEFERS (CrossDomainSpend re-priced to one in-domain ratify); adding
 *      one in-domain co-asserter RESOLVES. Does NOT touch the global Beta LCB.
 *
 *  OD-2 [STRUCTURAL, control-plane] — the human horn is bounded so F4a's extra deferrals
 *      cannot become a DOS-DEFER:
 *        - cross-attribute dedup (same coalesce key already OPEN ⇒ no-op, chain not advanced),
 *        - per-source pending cap K (beyond K open pendings naming a source ⇒ no-op),
 *        - back-compat: omitting opts ⇒ exactly today's unconditional append.
 *        A5  an engine-level flood of N attributes from one source collapses to a BOUNDED
 *            number of enqueues (sub-linear; capped at K).
 *
 * Reputation is driven through a FIXED clock (`() => NOW`) injected into
 * createReputationLedger, so decay-on-read is Δt = 0 and the suite is not flaky.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
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
  ContradictionSetId,
  EntityId,
  IntelligentDb,
  SourceRegistryPort,
  SourceRef,
  PendingLedger,
  PendingRatification,
  ProvenanceRoot,
  RatificationDeps,
  ReputationLedger,
  ReputationLedgerPort,
  SourceId,
  StakeLedgerPort,
  Strand,
  Unit,
  ContentHash,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

const WINNER = "src:winner" as SourceId;
const CORROB = "src:corrob" as SourceId;
const CHAL = "src:chal" as SourceId;

// --- minimal pillar ports (mirrors engineOwnedEvidence.test.ts) -------------

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
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function bindingOf(anchorClass: AnchorClass, weight: number): AnchorBinding {
  return {
    anchorClass,
    realizedCost: weight as Unit,
    independenceWeight: weight as Unit,
  };
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
  // FIXED clock — decay-on-read is Δt = 0 (per the known flaky-helper guidance).
  const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
  // Staking is RETIRED (attribution replaces stake): a constant-zero port.
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  const repPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation: repPort,
    stake: stakePort,
  });
  const ledger = createPendingLedger({ reputation });
  const ratification: RatificationDeps = { ledger, systemSource: freshSource().sourceId };
  const db = createIntelligentDb(store, identity, null, reputation, ratification);
  return { store, identity, reputation, ledger, db };
}

function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  value: string,
  roots: readonly ProvenanceRoot[],
  attribute: AttributeKey = ATTR,
): Strand {
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute,
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
  };
  store.putStrand(s);
  return s;
}

// ===========================================================================
// F4a — §5.1: single-source DEFERS (A3) / legit >= 2-root RESOLVES (A4)
// ===========================================================================

describe("BATCH 3 — F4a unconditional >= 2-root floor (§5.1)", () => {
  it("A3+A4: single-source (#R=1) multi-class DEFERS for BOTH intents; a >= 2-disjoint-root winner RESOLVES", () => {
    // ---- A3: single-source DEFERS (at any point on the decay curve, regardless of intent)
    const a3 = makeEngine();
    a3.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    a3.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);
    // Earn the winner a DECISIVE, EARNED reputation so it WOULD have auto-resolved
    // pre-F4a — isolating F4a as the cause of the defer.
    for (let i = 0; i < 6; i++) a3.reputation.ratify(WINNER, NOW, 1);
    fileStrand(a3.store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    fileStrand(a3.store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    for (const highImpact of [false, true]) {
      const outcome = a3.db.adjudicate(ATTR, { highImpact });
      expect(outcome.kind).toBe("DEFERRED"); // #R = 1 < 2 ⇒ DEFER, unconditional
      expect(a3.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
      expect(a3.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.LIVE);
    }

    // ---- A4: a genuinely >= 2-anchor-disjoint-root winner still RESOLVES (false-defer guard)
    const a4 = makeEngine();
    a4.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    a4.identity.register({ ...freshSource(), sourceId: CORROB } as SourceRef, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    a4.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);
    for (let i = 0; i < 6; i++) a4.reputation.ratify(WINNER, NOW, 1);
    fileStrand(a4.store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    // A genuinely anchor-DISJOINT co-asserter of the SAME value ⇒ #R = 2 AND the F4b
    // in-domain corroboration count = 1.
    fileStrand(a4.store, "strand:agree", "Berlin", [rootOf("agree", "class:corrob", CORROB)]);
    fileStrand(a4.store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    const resolved = a4.db.adjudicate(ATTR, { highImpact: false });
    expect(resolved.kind).toBe("RESOLVED");
    expect(a4.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
    expect(a4.store.getStrand(asStrandId("strand:agree"))?.fact_state).toBe(FactState.LIVE);
    expect(a4.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.DEMOTED);
  });

  it("SCOPE (fp-4 guard): a SINGLE-CLASS echo dispute is NOT deferred by the root-floor — it resolves in-graph", () => {
    // Same independence class on every member (a same-root echo artifact) ⇒ the SAFE
    // path. F4a MUST NOT add a root-floor here (that would re-open the contradiction-bomb
    // as a DEFER-DoS). With no external-signal winner, the deterministic id tiebreak picks
    // one survivor and demotes the disagreeing echoes WITHOUT a vote — never a DEFER.
    const eng = makeEngine();
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, []);
    // Three same-class echoes (one shared class), one value disagreeing — a flood shape.
    fileStrand(eng.store, "strand:a", "Berlin", [rootOf("a", "class:same", WINNER)]);
    fileStrand(eng.store, "strand:b", "Berlin", [rootOf("b", "class:same", WINNER)]);
    fileStrand(eng.store, "strand:c", "Tokyo", [rootOf("c", "class:same", WINNER)]);

    const outcome = eng.db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED"); // single-class ⇒ resolved by external signal, NOT deferred
  });
});

// ===========================================================================
// F4b — POLICY-interim: attribute-scoped corroboration COUNT floor
// ===========================================================================

describe("BATCH 3 — F4b attribute-scoped corroboration count (CrossDomainSpend)", () => {
  it("a globally-high-rep winner with ZERO in-domain co-asserter DEFERS; adding one co-asserter RESOLVES", () => {
    const eng = makeEngine();
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    eng.identity.register({ ...freshSource(), sourceId: CORROB } as SourceRef, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    eng.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);
    // High GLOBAL reputation earned elsewhere (throwaway facts in another domain).
    for (let i = 0; i < 6; i++) eng.reputation.ratify(WINNER, NOW, 1);

    // The winning strand carries TWO anchor-DISJOINT roots in its OWN provenance, so the
    // F4a >= 2-root floor is ALREADY satisfied (#R = 2) — isolating F4b as the only gate
    // left. But there is NO separate agreeing strand on the disputed value, so the
    // in-domain corroboration count is 0.
    fileStrand(eng.store, "strand:win", "Berlin", [
      rootOf("win-a", "class:wa", WINNER),
      rootOf("win-b", "class:wb", CORROB),
    ]);
    fileStrand(eng.store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    // BEFORE: #R = 2 (F4a clears) but in-domain corroboration count = 0 ⇒ F4b DEFERS.
    expect(eng.db.adjudicate(ATTR).kind).toBe("DEFERRED");
    expect(eng.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.LIVE);

    // ADD one in-domain co-asserter of the SAME value ⇒ corroboration count = 1 ⇒ RESOLVE.
    fileStrand(eng.store, "strand:agree", "Berlin", [rootOf("agree", "class:wb", CORROB)]);
    const outcome = eng.db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED");
    expect(eng.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.DEMOTED);
  });
});

// ===========================================================================
// OD-2 — horn rate-limiting (ledger unit + engine-level §5.2 flood)
// ===========================================================================

function makePending(
  csid: string,
  attribute: string,
  members: string[],
): PendingRatification {
  return {
    contradictionSetId: ("cset:" + csid) as ContradictionSetId,
    attribute: attribute as AttributeKey,
    members: members.map((m) => asStrandId(m)),
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

describe("BATCH 3 — OD-2 horn rate-limiting (ledger unit)", () => {
  it("BACK-COMPAT: omitting opts appends unconditionally (exactly today's behavior); chain verifies", () => {
    const ledger = createPendingLedger();
    const signer = freshSource();
    // The SAME dispute appended twice WITHOUT opts ⇒ TWO records (no dedup), as today.
    ledger.appendPending(makePending("x", "a#1", ["m1"]), signer.sourceId);
    ledger.appendPending(makePending("x", "a#1", ["m1"]), signer.sourceId);
    expect(ledger.records().length).toBe(2);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("CROSS-ATTRIBUTE DEDUP: same coalesce key already OPEN ⇒ no-op returning the existing record (chain not advanced)", () => {
    const ledger = createPendingLedger();
    const signer = freshSource();
    const S = "src:attacker" as SourceId;

    const first = ledger.appendPending(makePending("c1", "attr#1", ["m1", "m2"]), signer.sourceId, {
      disputingSources: [S],
      coalesceKey: "KEY",
    });
    expect(ledger.records().length).toBe(1);

    // A DIFFERENT contradiction set / attribute but the SAME coalesce key (same source-pair
    // disputing the same value across attributes) ⇒ coalesced to a no-op.
    const dup = ledger.appendPending(makePending("c2", "attr#2", ["m3", "m4"]), signer.sourceId, {
      disputingSources: [S],
      coalesceKey: "KEY",
    });
    expect(dup.seq).toBe(first.seq); // returned the EXISTING open record
    expect(ledger.records().length).toBe(1); // chain NOT advanced — no second record
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("PER-SOURCE CAP K: beyond K open pendings naming a source, further pendings are no-ops", () => {
    const ledger = createPendingLedger();
    const signer = freshSource();
    const S = "src:attacker" as SourceId;
    const CAP = 3;

    // CAP distinct disputes (distinct coalesce keys) all naming S ⇒ all append.
    for (let i = 0; i < CAP; i++) {
      ledger.appendPending(makePending("c" + i, "attr#" + i, ["m" + i]), signer.sourceId, {
        disputingSources: [S],
        coalesceKey: "K" + i,
        perSourceCap: CAP,
      });
    }
    expect(ledger.records().length).toBe(CAP);

    // The CAP+1-th distinct dispute naming S is rejected (no-op) — S is at its cap.
    const overflow = ledger.appendPending(makePending("cX", "attr#X", ["mX"]), signer.sourceId, {
      disputingSources: [S],
      coalesceKey: "KX",
      perSourceCap: CAP,
    });
    expect(ledger.records().length).toBe(CAP); // still capped
    expect((overflow.payload as { contradictionSetId: string }).contradictionSetId).not.toBe(
      "cset:cX",
    ); // returned an EXISTING record, not the rejected one
    expect(ledger.verifyChain().ok).toBe(true);
  });
});

describe("BATCH 3 — OD-2 §5.2: an engine-level horn flood collapses to a bounded queue (A5)", () => {
  it("a flood of N attributes from one source produces a BOUNDED number of enqueues (capped at K=64)", () => {
    const eng = makeEngine();
    // Two FRESH (rep-0) sources — every dispute DEFERS at the decisive/earned gate (or the
    // F4a floor), so each adjudicate floods the horn. The attacker source S is named in
    // EVERY dispute, so the per-source cap (default 64) bounds the queue.
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, []);
    eng.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);

    const N = 80;
    for (let i = 0; i < N; i++) {
      const attr = ("flood#" + i) as AttributeKey;
      fileStrand(eng.store, "win-" + i, "V" + i, [rootOf("win-" + i, "class:win", WINNER)], attr);
      fileStrand(eng.store, "chal-" + i, "no", [rootOf("chal-" + i, "class:chal", CHAL)], attr);
      const outcome = eng.db.adjudicate(attr);
      expect(outcome.kind).toBe("DEFERRED");
    }

    // The horn did NOT grow linearly with the flood: it capped at K = 64 (default
    // per-source cap), well below N = 80. A SAFE-DEFER that floods unboundedly would be a
    // DOS-DEFER = breach; OD-2 makes it bounded.
    const open = eng.ledger.listPending().length;
    expect(open).toBe(64);
    expect(open).toBeLessThan(N);
    expect(eng.ledger.verifyChain().ok).toBe(true);
  });
});
