/**
 * reconcileDriftApproveRegression.test.ts — approve() RECONCILE_DRIFT fix.
 *
 * HISTORICALLY (CLAUDE.md KNOWN LIMITATIONS, torture `KNOWN_NONCRASH_VIOLATION_KINDS`):
 * every `approve()`-resolved dispute permanently tripped `reconcileLedger`'s
 * off-ledger-drift audit for the winner's author, because `ledger.approve()`
 * credited via `reputation.ratify` with NO corroboration-event record.
 *
 * FIXED: `api.ts`'s `approve()` now records the exact α-mass each winner author
 * earned into the corroboration-event ledger (empty `corroboratingStrandIds` —
 * human approval is not agreement-funded; disown of the author still craters via
 * `disownSweep`). This test drives the REAL engine verbs and asserts reconcile
 * is CLEAN after approve — the inverse of the pre-fix permanent-drift pin.
 */

import { describe, expect, it } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  createCorroborationLedger,
  reconcileLedger,
  independenceBetween,
  FactOrigin,
  FactState,
  Tier,
  AnchorClass,
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
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  SourceRef,
  Strand,
  ContradictionSetId,
  RatificationDeps,
} from "../index.js";

import { KNOWN_NONCRASH_VIOLATION_KINDS } from "../__torture__/invariantChecker.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:reconcile-drift-approve" as EntityId;
const ATTR = "reconcile-drift-approve#claim" as AttributeKey;

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

function makeIdentity(reputation: ReputationLedgerPort): SourceIdentityLayer {
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

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
  };
  store.putStrand(s);
  return s;
}

describe("approve() RECONCILE_DRIFT fix — default-suite regression", () => {
  it("retains the shared torture exclusion hook (empty after approve reconcile fix)", () => {
    // Historical tag lived here; approve() now records corroboration mass, so
    // RECONCILE_DRIFT is no longer an expected permanent exclusion.
    expect(KNOWN_NONCRASH_VIOLATION_KINDS.has("RECONCILE_DRIFT")).toBe(false);
  });

  it("a clean two-write-one-adjudicate-one-approve run reconciles: approve records corroboration mass", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9, undefined, () => NOW);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const corroboration = createCorroborationLedger();
    const systemSource = freshSource().sourceId;
    const ratification: RatificationDeps = {
      ledger,
      systemSource,
      corroboration,
    };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    const winnerSourceId = "src:winner" as SourceId;
    const loserSourceId = "src:loser" as SourceId;
    const winnerStrand = fileStrand(store, "strand:winner", winnerSourceId, "class:winner", {
      v: "Germany",
    });
    fileStrand(store, "strand:loser", loserSourceId, "class:loser", { v: "Atlantis" });
    identity.register({ ...freshSource(), sourceId: winnerSourceId } as SourceRef, [
      { anchorClass: AnchorClass.VERIFIED_HUMAN, realizedCost: 0.7 as Unit, independenceWeight: 0.7 as Unit },
    ]);
    identity.register({ ...freshSource(), sourceId: loserSourceId } as SourceRef, [
      { anchorClass: AnchorClass.HARDWARE_ATTESTATION, realizedCost: 0.45 as Unit, independenceWeight: 0.45 as Unit },
    ]);

    expect(db.adjudicate(ATTR).kind).toBe("DEFERRED");

    const approver = freshSource();
    identity.register(approver, [
      { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit },
    ]);
    const csid = ledger.listPending()[0]!.contradictionSetId as ContradictionSetId;
    const resolved = db.approve(csid, winnerStrand.id, approver.sourceId, NOW);
    expect(resolved.winner).toBe(winnerStrand.id);

    const winnerAlpha = reputation.stateOf(winnerSourceId)?.alpha ?? 1;
    expect(winnerAlpha).toBeGreaterThan(1);
    expect(reputation.scoreOf(winnerSourceId)).toBeGreaterThan(0);

    // THE FIX: approve recorded an explaining corroboration event for the winner.
    const events = corroboration.all().filter((e) => e.beneficiarySourceId === winnerSourceId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.ratifiedStrandId).toBe(winnerStrand.id);
    expect(events[0]!.corroboratingStrandIds).toEqual([]);
    expect(events[0]!.reputationDelta).toBeGreaterThan(0);

    const report = reconcileLedger(
      [{ sourceId: winnerSourceId, alpha: winnerAlpha }],
      corroboration,
    );
    expect(report.ok).toBe(true);
    expect(report.drifted).toHaveLength(0);
    expect(report.reconciled).toHaveLength(1);
    expect(report.reconciled[0]!.sourceId).toBe(winnerSourceId);
    expect(report.reconciled[0]!.explained).toBeGreaterThan(0);
  });
});
