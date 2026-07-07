/**
 * disownReopenProvenanceProtection.test.ts — RE-AUDIT REGRESSION (MEDIUM):
 * "a disown-reopen-winner-flip promotion is never protected by future HARDENING-3
 * re-opening."
 *
 * `#recordAdjudicationProvenance` — the SOLE producer of `AdjudicationProvenance`
 * records, which HARDENING-3's re-open sweep (`disown.ts`'s `recordsContributedBy`)
 * depends on to find a dispute to reopen — used to be called ONLY from
 * `adjudicate()`'s auto-RESOLVE branch. `approve()` never wrote a fresh
 * `AdjudicationProvenance` record for the winner it resolved to, whether that was an
 * ordinary human resolution OR (newly possible since the Wave-1
 * disown-reopen-winner-flip fix) a `REOPENED_BY_DISOWN` dispute whose winner just
 * FLIPPED to a different strand via `promote()`.
 *
 * Before the Wave-1 fix this didn't matter for the reopen path, because a reopened
 * dispute could only ever reconfirm the SAME winner (which already had a valid
 * provenance record from the original auto-resolve). The winner-flip fix makes it
 * possible, for the FIRST time, for the LIVE winner of a once-auto-resolved dispute to
 * become a DIFFERENT strand with NO provenance record at all — making it permanently
 * invisible to a later disown of ITS OWN backing source (worse off than an ordinary
 * auto-resolved winner, which DOES get protected on its first disown).
 *
 * THE FIX: `approve()` now calls the SAME provenance-recording logic
 * (`#buildAdjudicationProvenance`, factored out of `#recordAdjudicationProvenance`)
 * for the winner it just resolved to — so a `promote()`d, winner-flipped strand gets
 * exactly the same protection an auto-resolved winner always had.
 *
 * This test extends `disownReopenWinnerFlip.test.ts`'s exact scenario ONE STEP
 * FURTHER (mirroring the re-audit's own live probe): auto-resolve -> disown the
 * winner's source -> reopen -> approve() picks the surviving loser as the NEW winner
 * (the winner-flip) -> disown the NEW winner's OWN backing source for the FIRST TIME
 * -> assert the dispute REOPENS A SECOND TIME (a "double reopen"), where pre-fix it
 * silently did nothing (`reopenedDisputes === []`, the new winner permanently LIVE).
 * Drives the REAL production path throughout (`db.adjudicate`, `db.disown`,
 * `db.approve`, `db.listPending`) — no re-derived assertions.
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

// --- minimal pillar ports (mirrors disownReopenWinnerFlip.test.ts verbatim) -------

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

describe("RE-AUDIT winner-flip promotions ARE protected by a future HARDENING-3 reopen", () => {
  it("double-reopen: a promote()'d winner-flipped strand gets its OWN adjudication-provenance record and is re-opened again on its own backing source's first disown", () => {
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

    // Pre-earn the winner's source to a DECISIVE LCB so the ORIGINAL dispute
    // auto-RESOLVES (exactly `disownReopenWinnerFlip.test.ts`'s setup).
    for (let i = 0; i < 6; i++) reputation.ratify(winnerSrc, NOW, 1);
    expect(reputation.scoreOf(winnerSrc)).toBeGreaterThan(0.5);

    const winStrand = fileStrand(store, "strand:win", winnerSrc, "class:WIN", { v: "Berlin" });
    const chalStrand = fileStrand(store, "strand:chal", challengerSrc, "class:CHAL", { v: "Tokyo" });
    fileStrand(store, "strand:win-corrob", corroboratorSrc, "class:WINCORROB", { v: "Berlin" });

    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED");
    expect(store.getStrand(winStrand.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(chalStrand.id)!.fact_state).toBe(FactState.DEMOTED);

    // Confirm the FIRST (auto-resolve) provenance record exists, naming winStrand.
    const firstRec = adjudicationProvenance.all().find((r) => r.winner === winStrand.id);
    expect(firstRec).toBeDefined();
    const csid = firstRec!.contradictionSetId;

    // STEP 1 — disown the ORIGINAL winner's source: collapses its recorded margin
    // and RE-OPENS the dispute (identical to disownReopenWinnerFlip.test.ts).
    const disown1 = db.disown(winnerSrc, { at: NOW });
    expect(disown1.reopenedDisputes.map(String)).toContain(String(csid));
    const reopened = db.listPending().find((p) => p.contradictionSetId === csid);
    expect(reopened).toBeDefined();
    expect(reopened!.reason).toBe("REOPENED_BY_DISOWN");
    expect(reopened!.members.map(String).sort()).toEqual(
      [String(winStrand.id), String(chalStrand.id)].sort(),
    );

    // STEP 2 — an external, distinct, anchor-independent approver picks the
    // SURVIVING original loser (chalStrand) as the NEW winner: the winner FLIPS.
    const approver = freshSource();
    identity.register(approver, [
      { anchorClass: AnchorClass.ORGANIZATION, realizedCost: 0.75 as Unit, independenceWeight: 0.75 as Unit },
    ]);
    const resolved = db.approve(csid as ContradictionSetId, chalStrand.id, approver.sourceId, NOW);
    expect(resolved.winner).toBe(chalStrand.id);
    const chalAfter = store.getStrand(chalStrand.id)!;
    expect(chalAfter.fact_state).toBe(FactState.LIVE);
    const winAfter = store.getStrand(winStrand.id)!;
    expect(winAfter.fact_state).toBe(FactState.DEMOTED);
    expect(db.listPending().find((p) => p.contradictionSetId === csid)).toBeUndefined();

    // THE FIX — assert directly: a SECOND `AdjudicationProvenance` record now names
    // chalStrand as winner. Pre-fix, `approve()` wrote NOTHING here — this is
    // EXACTLY the gap the re-audit found.
    const secondRec = adjudicationProvenance
      .all()
      .find((r) => r.winner === chalStrand.id && r.contradictionSetId === csid);
    expect(secondRec).toBeDefined();
    expect(secondRec!.contributingStrandIds.map(String)).toContain(String(chalStrand.id));
    // The new record threads the (new) losing member — winStrand, the just-demoted
    // original winner — forward too, mirroring the original resolution's
    // `losingMemberIds` contract (the SAME field a future reopen's `approve()`
    // membership-widening reads).
    expect(secondRec!.losingMemberIds?.map(String)).toEqual([String(winStrand.id)]);

    // STEP 3 — give the new winner's source (challengerSrc) a little earned
    // reputation (so it is a genuine, tracked source, not an untouched stub), then
    // disown IT for the FIRST TIME EVER — a completely fresh disown, never
    // previously touched by any sweep.
    reputation.ratify(challengerSrc, NOW, 1);
    const disown2 = db.disown(challengerSrc, { at: NOW });

    // THE CORE ASSERTION (pre-fix this was `[]`, and chalStrand stayed LIVE forever,
    // permanently un-protected): the SAME dispute re-opens a SECOND time — a genuine
    // "double reopen" — because chalStrand (the seed, since it is challengerSrc's own
    // asserted strand) is now the recorded winner of a provenance record whose
    // surviving margin (with the winner itself tainted) collapses to 0.
    expect(disown2.reopenedDisputes.map(String)).toContain(String(csid));
    const reopenedAgain = db.listPending().find((p) => p.contradictionSetId === csid);
    expect(reopenedAgain).toBeDefined();
    expect(reopenedAgain!.reason).toBe("REOPENED_BY_DISOWN");
    // The re-opened membership again threads the (new) loser (winStrand) back in,
    // so a human can genuinely re-decide instead of the dispute being a dead letter.
    expect(reopenedAgain!.members.map(String)).toContain(String(winStrand.id));

    expect(ledger.verifyChain().ok).toBe(true);
  });

  it("REGRESSION GUARD: an ordinary (non-reopened) approve()-resolved dispute ALSO gets a provenance record protecting it on the winner's own first disown", () => {
    // A simpler, DIRECT-approve scenario (no adjudicate()/auto-resolve at all): a
    // DEFERRED multi-class dispute resolved by approve() the FIRST time. Confirms the
    // fix is not narrowly scoped to the winner-flip/reopen path — ANY approve()
    // resolution now records provenance, exactly like adjudicate()'s auto-resolve.
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9, undefined, () => NOW);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const adjudicationProvenance = createAdjudicationProvenanceLedger();
    const systemSource = freshSource().sourceId;
    const ratification: RatificationDeps = { ledger, systemSource, adjudicationProvenance };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    const aSrc = "src:a" as SourceId;
    const bSrc = "src:b" as SourceId;
    identity.register(
      { ...freshSource(), sourceId: aSrc } as SourceRef,
      [{ anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit }],
    );
    identity.register(
      { ...freshSource(), sourceId: bSrc } as SourceRef,
      [{ anchorClass: AnchorClass.HARDWARE_ATTESTATION, realizedCost: 0.45 as Unit, independenceWeight: 0.45 as Unit }],
    );
    const aStrand = fileStrand(store, "strand:a", aSrc, "class:A", { v: "X" });
    const bStrand = fileStrand(store, "strand:b", bSrc, "class:B", { v: "Y" });

    // Neither source is decisively earned: a genuine multi-class dispute DEFERS.
    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("DEFERRED");
    const pending = db.listPending()[0]!;
    expect(adjudicationProvenance.all().length).toBe(0); // nothing recorded yet (DEFERRED, not RESOLVED)

    const approver = freshSource();
    identity.register(approver, [
      { anchorClass: AnchorClass.ORGANIZATION, realizedCost: 0.75 as Unit, independenceWeight: 0.75 as Unit },
    ]);
    const resolved = db.approve(pending.contradictionSetId, aStrand.id, approver.sourceId, NOW);
    expect(resolved.winner).toBe(aStrand.id);

    // THE FIX: approve() now records provenance for its winner too.
    const rec = adjudicationProvenance.all().find((r) => r.winner === aStrand.id);
    expect(rec).toBeDefined();
    expect(rec!.contradictionSetId).toBe(pending.contradictionSetId);
    expect(rec!.losingMemberIds?.map(String)).toEqual([String(bStrand.id)]);

    // And it is genuinely load-bearing: disowning the winner's OWN source now
    // re-opens the dispute (bStrand is DEMOTED, so its own class contributes
    // nothing; the winner's seed strand itself is tainted -> surviving margin 0).
    const disownResult = db.disown(aSrc, { at: NOW });
    expect(disownResult.reopenedDisputes.map(String)).toContain(String(pending.contradictionSetId));
  });
});
