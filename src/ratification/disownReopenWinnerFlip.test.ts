/**
 * disownReopenWinnerFlip.test.ts — REGRESSION for `disown-reopen-cannot-change-winner`
 * (hostile production-readiness audit, CRITICAL).
 *
 * `disown.ts`'s HARDENING 3 (adjudication re-opening) used to re-open a tipped
 * dispute with `PendingPayload.members: [rec.winner]` ONLY. Since `approve()`
 * unconditionally rejects any proposed winner that is not a MEMBER of the dispute,
 * a re-opened dispute could STRUCTURALLY only ever reconfirm the exact (now-tainted)
 * winner whose margin had just collapsed — a functionally broken remedy for the
 * security-relevant scenario the hardening exists to address.
 *
 * This test exercises the REAL production code path end-to-end through the public
 * engine verbs (`db.adjudicate`, `db.disown`, `db.approve` — no free-function
 * shortcuts, no re-derived assertions):
 *   1. A genuine multi-class dispute auto-RESOLVES (decisive margin) to winner W.
 *   2. W's backing source is DISOWNED, collapsing its margin below the decisive
 *      threshold — the dispute RE-OPENS.
 *   3. An external, distinct, anchor-independent approver picks the SURVIVING
 *      original loser L as the new winner. Pre-fix this throws ("winner is not a
 *      member"); post-fix it succeeds and L ends up genuinely LIVE, with the
 *      tainted W flipped to DEMOTED — the re-decision actually changes belief.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  createAdjudicationProvenanceLedger,
  independenceBetween,
  FactState,
  FactOrigin,
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

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts) ----------------

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

/** Hand-file an OBSERVED strand about (ENTITY, ATTR), controlling its independence class. */
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

describe("REGRESSION disown-reopen-cannot-change-winner: a re-opened dispute can flip the winner", () => {
  it("a genuine multi-class dispute auto-resolves, disown re-opens it, and an external approver CAN select the surviving loser (belief actually flips)", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9, undefined, () => NOW);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const adjudicationProvenance = createAdjudicationProvenanceLedger();
    const systemSource = freshSource().sourceId;
    const ratification: RatificationDeps = {
      ledger,
      systemSource,
      adjudicationProvenance,
    };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    const winnerSrc = "src:winner" as SourceId;
    const challengerSrc = "src:challenger" as SourceId;
    const corroboratorSrc = "src:corroborator" as SourceId;

    // Register every author with a REAL, disjoint anchor so the identity layer's
    // independence math (and later RC-5) has something to reason about.
    identity.register(
      { ...freshSource(), sourceId: winnerSrc } as SourceRef,
      [{ anchorClass: AnchorClass.VERIFIED_HUMAN, realizedCost: 0.7 as Unit, independenceWeight: 0.7 as Unit }],
    );
    identity.register(
      { ...freshSource(), sourceId: corroboratorSrc } as SourceRef,
      [{ anchorClass: AnchorClass.HARDWARE_ATTESTATION, realizedCost: 0.45 as Unit, independenceWeight: 0.45 as Unit }],
    );
    identity.register(
      { ...freshSource(), sourceId: challengerSrc } as SourceRef,
      [{ anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit }],
    );

    // Pre-earn the winner's source to a DECISIVE LCB (>> the 0.3 margin / 0.2 floor).
    for (let i = 0; i < 6; i++) reputation.ratify(winnerSrc, NOW, 1);
    expect(reputation.scoreOf(winnerSrc)).toBeGreaterThan(0.5);

    // A genuine MULTI-CLASS dispute: winner (class:WIN) vs challenger (class:CHAL),
    // plus a SEPARATE, anchor-independent co-asserter agreeing with the winning
    // value (class:WINCORROB) so F4a (#R >= 2) and F4b (>= 1 in-domain co-asserter)
    // both clear and the dispute auto-RESOLVES instead of deferring.
    const winStrand = fileStrand(store, "strand:win", winnerSrc, "class:WIN", { v: "Berlin" });
    const chalStrand = fileStrand(store, "strand:chal", challengerSrc, "class:CHAL", { v: "Tokyo" });
    fileStrand(store, "strand:win-corrob", corroboratorSrc, "class:WINCORROB", { v: "Berlin" });

    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED");
    expect(store.getStrand(winStrand.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(chalStrand.id)!.fact_state).toBe(FactState.DEMOTED);

    // The adjudication-provenance record was captured, INCLUDING the original
    // losing member id (the field the fix threads into the reopened dispute).
    const adjRec = adjudicationProvenance.all().find((r) => r.winner === winStrand.id);
    expect(adjRec).toBeDefined();
    expect(adjRec!.losingMemberIds?.map(String)).toEqual([String(chalStrand.id)]);
    const csid = adjRec!.contradictionSetId;

    // DISOWN the winner's source: this collapses its recorded margin (the winner
    // itself is now tainted) and RE-OPENS the dispute.
    const disownResult = db.disown(winnerSrc, { at: NOW });
    expect(disownResult.reopenedDisputes.map(String)).toContain(String(csid));

    // THE CORE ASSERTION (pre-fix this failed: members was exactly [winStrand.id]):
    // the reopened dispute's members include the ORIGINAL LOSER, not just the
    // tainted winner — approve() can therefore genuinely select it.
    const reopened = db.listPending().find((p) => p.contradictionSetId === csid);
    expect(reopened).toBeDefined();
    expect(reopened!.reason).toBe("REOPENED_BY_DISOWN");
    expect(reopened!.members.map(String).sort()).toEqual(
      [String(winStrand.id), String(chalStrand.id)].sort(),
    );

    // An EXTERNAL, distinct approver — anchor-independent of BOTH disputed
    // authors — genuinely picks the SURVIVING original loser as the new winner.
    const approver = freshSource();
    identity.register(approver, [
      { anchorClass: AnchorClass.ORGANIZATION, realizedCost: 0.75 as Unit, independenceWeight: 0.75 as Unit },
    ]);

    // Pre-fix: this threw "approve: winner strand:chal is not a member of ...".
    const resolved = db.approve(csid as ContradictionSetId, chalStrand.id, approver.sourceId, NOW);
    expect(resolved.winner).toBe(chalStrand.id);

    // THE BELIEF ACTUALLY FLIPPED: the surviving claim is genuinely LIVE (not just
    // "approve() didn't throw" — without the promote() half of the fix this stays
    // DEMOTED forever, since approve() never previously flipped a pre-demoted
    // member back to LIVE), and the tainted original winner is now DEMOTED.
    const chalAfter = store.getStrand(chalStrand.id)!;
    expect(chalAfter.fact_state).toBe(FactState.LIVE);
    expect(chalAfter.outranked_by).toBeNull();
    const winAfter = store.getStrand(winStrand.id)!;
    expect(winAfter.fact_state).toBe(FactState.DEMOTED);
    expect(winAfter.outranked_by).not.toBeNull();

    // Provenance / content-addressing intact (demote-never-delete, both directions).
    expect(chalAfter.content_hash).toBe(chalStrand.content_hash);
    expect(chalAfter.provenance).toEqual(chalStrand.provenance);
    expect(winAfter.content_hash).toBe(winStrand.content_hash);
    expect(winAfter.provenance).toEqual(winStrand.provenance);

    // The dispute is genuinely closed and the audit chain still verifies.
    expect(db.listPending().find((p) => p.contradictionSetId === csid)).toBeUndefined();
    expect(ledger.verifyChain().ok).toBe(true);
  });
});
