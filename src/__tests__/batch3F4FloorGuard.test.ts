/**
 * batch3F4FloorGuard.test.ts — BATCH 3 junior acceptance (focused, one case per `it`).
 *
 * Independently re-locks the four BATCH 3 invariants the senior bundled, each as a
 * single isolated assertion so a future regression names the exact broken case:
 *
 *  (a) A3  — a single-source (#R = 1) multi-class dispute DEFERS for BOTH intents
 *            (the F4a >= 2-independent-root floor, unconditional on highImpact).
 *  (b) A4  — §5.1 FALSE-DEFER GUARD: a legit dispute whose winning value is backed by
 *            >= 2 genuinely anchor-DISJOINT roots still RESOLVES (must not over-defer —
 *            the priced-not-prevented honesty control).
 *  (c) A5  — §5.2 horn flood: one source contradicting N attributes coalesces to a
 *            BOUNDED number of pending entries (OD-2 per-source cap dedup works).
 *  (d) fp-4 — F4a does NOT touch the single-class echo-collapse path: a same-class echo
 *            still resolves by deterministic tiebreak, never a DEFER-DoS.
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
  ContentHash,
  EntityId,
  IntelligentDb,
  SourceRegistryPort,
  SourceRef,
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

const WINNER = "src:winner" as SourceId;
const CORROB = "src:corrob" as SourceId;
const CHAL = "src:chal" as SourceId;

// --- minimal pillar ports (mirrors batch3F4HornRateLimit.test.ts) -----------

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
// (a) A3 — single-source (#R = 1) multi-class dispute DEFERS for BOTH intents.
// ===========================================================================

describe("BATCH 3 (a) — F4a: single-source #R=1 multi-class DEFERS unconditionally", () => {
  it("a lone high-rep source vs a fresh challenger DEFERS for highImpact ∈ {false, true}", () => {
    const eng = makeEngine();
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    eng.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);
    // Earn the winner a DECISIVE, EARNED reputation so it WOULD auto-resolve pre-F4a —
    // isolating the >= 2-root floor as the SOLE cause of the defer.
    for (let i = 0; i < 6; i++) eng.reputation.ratify(WINNER, NOW, 1);
    fileStrand(eng.store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    fileStrand(eng.store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    for (const highImpact of [false, true]) {
      const outcome = eng.db.adjudicate(ATTR, { highImpact });
      expect(outcome.kind).toBe("DEFERRED"); // #R = 1 < 2 ⇒ DEFER, regardless of intent
      expect(eng.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
      expect(eng.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.LIVE);
    }
    // The defer was routed to the human horn, not silently dropped.
    expect(eng.ledger.listPending().length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// (b) A4 — FALSE-DEFER GUARD: a legit >= 2-disjoint-root winner still RESOLVES.
// ===========================================================================

describe("BATCH 3 (b) — §5.1 false-defer guard: >= 2 anchor-disjoint roots RESOLVES", () => {
  it("a winning value co-asserted by two genuinely anchor-disjoint roots is NOT over-deferred", () => {
    const eng = makeEngine();
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, [
      bindingOf(AnchorClass.DOMAIN, 0.35),
    ]);
    eng.identity.register({ ...freshSource(), sourceId: CORROB } as SourceRef, [
      bindingOf(AnchorClass.PHONE_SIM, 0.2),
    ]);
    eng.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);
    for (let i = 0; i < 6; i++) eng.reputation.ratify(WINNER, NOW, 1);

    fileStrand(eng.store, "strand:win", "Berlin", [rootOf("win", "class:win", WINNER)]);
    // A genuinely anchor-DISJOINT co-asserter of the SAME value ⇒ #R = 2 (clears F4a) AND
    // the F4b in-domain corroboration count = 1 (clears F4b).
    fileStrand(eng.store, "strand:agree", "Berlin", [rootOf("agree", "class:corrob", CORROB)]);
    fileStrand(eng.store, "strand:chal", "Tokyo", [rootOf("chal", "class:chal", CHAL)]);

    const outcome = eng.db.adjudicate(ATTR, { highImpact: false });
    expect(outcome.kind).toBe("RESOLVED");
    expect(eng.store.getStrand(asStrandId("strand:win"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.store.getStrand(asStrandId("strand:agree"))?.fact_state).toBe(FactState.LIVE);
    expect(eng.store.getStrand(asStrandId("strand:chal"))?.fact_state).toBe(FactState.DEMOTED);
    // A genuine RESOLVE enqueues NOTHING on the human horn.
    expect(eng.ledger.listPending().length).toBe(0);
  });
});

// ===========================================================================
// (c) A5 — §5.2 horn flood: one source over N attributes coalesces to bounded K.
// ===========================================================================

describe("BATCH 3 (c) — OD-2 §5.2: one source flooding N attributes collapses to bounded K", () => {
  it("an N=80 multi-attribute flood from one named source caps the open queue at K=64", () => {
    const eng = makeEngine();
    // Two FRESH (rep-0) sources — every dispute DEFERS at the F4a floor (each side is a
    // lone root, #R = 1), so each adjudicate would flood the horn UNBOUNDED without OD-2.
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, []);
    eng.identity.register({ ...freshSource(), sourceId: CHAL } as SourceRef, []);

    const N = 80;
    for (let i = 0; i < N; i++) {
      const attr = ("flood#" + i) as AttributeKey;
      fileStrand(eng.store, "win-" + i, "V" + i, [rootOf("win-" + i, "class:win", WINNER)], attr);
      fileStrand(eng.store, "chal-" + i, "no", [rootOf("chal-" + i, "class:chal", CHAL)], attr);
      expect(eng.db.adjudicate(attr).kind).toBe("DEFERRED");
    }

    const open = eng.ledger.listPending().length;
    expect(open).toBe(64); // default per-source cap K — sub-linear in N, not 80
    expect(open).toBeLessThan(N);
    expect(eng.ledger.verifyChain().ok).toBe(true);
  });
});

// ===========================================================================
// (d) fp-4 — F4a does NOT touch the single-class echo-collapse path.
// ===========================================================================

describe("BATCH 3 (d) — fp-4 scope: single-class echo resolves by tiebreak, never deferred", () => {
  it("a same-class flood (R=1 by construction) RESOLVES in-graph and is NOT a DEFER-DoS", () => {
    const eng = makeEngine();
    eng.identity.register({ ...freshSource(), sourceId: WINNER } as SourceRef, []);
    // Three same-class echoes (one shared independence class), one value disagreeing — the
    // exact contradiction-bomb flood shape. The single-class path is the SAFE mechanical
    // tidy-up: with no external-signal winner the deterministic id tiebreak picks a survivor
    // and demotes the disagreeing echo WITHOUT a vote. F4a's >= 2-root floor MUST NOT reach
    // here (it would re-open the bomb as a DEFER-DoS — the already-REJECTED fp-4).
    fileStrand(eng.store, "strand:a", "Berlin", [rootOf("a", "class:same", WINNER)]);
    fileStrand(eng.store, "strand:b", "Berlin", [rootOf("b", "class:same", WINNER)]);
    fileStrand(eng.store, "strand:c", "Tokyo", [rootOf("c", "class:same", WINNER)]);

    const outcome = eng.db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED"); // single-class ⇒ resolved by external signal, NOT deferred
    expect(eng.ledger.listPending().length).toBe(0); // no human enqueue — never a DEFER-DoS
  });
});
