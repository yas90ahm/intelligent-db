/**
 * systemCoherence.test.ts — THE END-TO-END SYSTEM-COHERENCE TEST.
 *
 * ONE integration test that wires the WHOLE pipeline together over a SINGLE,
 * SHARED SQLite handle (facts + trust + corroboration + adjudication-provenance +
 * audit, one crash-consistent file) and proves the pillars compose as a SYSTEM —
 * surfacing any capability that is built-but-UNWIRED. It exercises, in order:
 *
 *   (a) TRUST-REGISTRY CLAIMS → INDEPENDENCE: two SSO members of DIFFERENT tenants
 *       with registry-CONFIGURED verified custom domains each gain a DOMAIN-grade
 *       claim through {@link createTrustRegistry}; their stamps gain real
 *       anchor_cost (independence > 0) and the two are genuinely independent,
 *       while an unresolvable publisher URL and an UNCONFIGURED domain hint are
 *       fail-closed (no source minted / no lift granted).
 *   (b) writeFact lands provenance-rooted strands attached by SHARED_ENTITY.
 *   (c) CORROBORATION → BETA REPUTATION + EVENT: db.ratify(...) raises the
 *       source's Beta LCB AND records an append-only corroboration event.
 *   (d) DECISIVE-OR-DEFER: a multi-class dispute with a decisively-out-earned winner
 *       AUTO-RESOLVES on the LCB margin; the SAME dispute flagged HIGH-IMPACT (winner
 *       fails the count/anchor-class gate) DEFERS to listPending().
 *   (e) DISOWN (the newly-wired engine verb): db.disown(source) craters the source,
 *       DEMOTES its derivatives (sparing an independently-corroborated one via false-
 *       disown protection), reverses the EXACT corroboration credit, and RE-OPENS a
 *       dispute a tainted strand merely tipped.
 *   (f) THE CHECKSUM CHAIN: the audit chain hash-verifies end-to-end; a byte
 *       flipped in a persisted record is caught NAMING the first broken seq; and a
 *       chainHead() CHECKPOINT exported to external storage exposes a wholesale
 *       chain rewrite/rollback (the head a replacement chain reaches never matches).
 *   (g) reconcileLedger reports ok (no off-ledger drift).
 *
 * COMPOSITION-ROOT NOTE (the stranded capability this test resolves): before this work,
 * `downstreamDisownSweep` (the full undo engine) was reachable ONLY as a free function
 * from the barrel — NOT through the `IntelligentDb` engine. It is now WIRED as the
 * `db.disown(...)` verb (api.ts), assembling its `DisownHardeningDeps` from the wired
 * RatificationDeps.
 *
 * Everything runs through the public barrel (`../index.js`). A controllable clock is
 * injected EVERYWHERE time matters (reputation decay-on-read) so no assertion is
 * wall-clock-dependent.
 */

import { rmSync } from "node:fs";
import { freshSource } from "../testSupport/identityFixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIntelligentDb,
  createSqliteStore,
  createSqliteReputationLedger,
  createSqliteCorroborationLedger,
  createSqliteAdjudicationProvenanceLedger,
  createSqlitePendingLedger,
  createPendingLedger,
  createSourceIdentityLayer,
  createTrustRegistry,
  repCapFor,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  reconcileLedger,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "../index.js";

import type {
  SourceId,
  StrandId,
  Unit,
  EpochMs,
  EntityId,
  AttributeKey,
  Edge,
  Strand,
  ProvenanceRoot,
  IdentityStamp,
  ContradictionSetId,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  AlphaSnapshot,
  IndependenceClassId,
  LedgerRecord,
  RatificationDeps,
} from "../index.js";

// A controllable logical clock (everything time-sensitive reads this).
const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const DAY = 86_400_000;
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey; // the decisive (auto-resolved) dispute
const ATTR_HI = "berlin#mayor_of" as AttributeKey; // the high-impact (deferred) dispute

// --- temp db lifecycle ------------------------------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshPath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-coherence-${unique}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* handle not yet released */
      }
    }
  });
  return p;
}

/**
 * Hand-file an OBSERVED strand about (ENTITY, ATTR) authored by `sourceId` in a chosen
 * independence class (so we control multi-class disputes; writeFact derives one class
 * per source key). Mirrors engineAdjudicate.test.ts's fileStrand.
 */
function fileStrand(
  store: ReturnType<typeof createSqliteStore>,
  idRaw: string,
  sourceId: SourceId,
  cls: string,
  payload: unknown,
  attribute: AttributeKey = ATTR,
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
    attribute,
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

/** A DERIVATION edge: derived RESTS ON witness (points derived -> witness). */
function derivationEdge(derived: StrandId, witness: StrandId): Edge {
  return {
    id: asEdgeId(`deriv:${String(derived)}->${String(witness)}`),
    from: derived,
    to: witness,
    edgeType: EdgeType.DERIVATION,
    link_confidence: 1 as Unit,
    provenance_independence: 1 as Unit,
    recency: 1 as Unit,
    w: 1 as Unit,
    out_weight_sum: 1 as Unit,
  };
}

describe("END-TO-END SYSTEM COHERENCE — the whole pipeline over one shared SQLite handle", () => {
  it("registers trust-registry claims -> earns Beta credit + events -> decisive/high-impact adjudication -> disown demotes+reverses+re-opens -> checksum chain verifies + tamper/rewrite caught -> reconcile ok", () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => DatabaseSyncType;
    };

    const path = freshPath();
    const db: DatabaseSyncType = new DatabaseSync(path);
    cleanups.push(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    });

    // ---- ONE shared handle backs the WHOLE substrate -----------------------
    // The crypto-free TRUST REGISTRY is the deployment's swappable trust root: the
    // CONFIG (not any proof machinery in this codebase) asserts which tenants hold
    // verified custom domains. One instance serves BOTH facade ports.
    const trust = createTrustRegistry({
      verifiedTenantDomains: {
        "tenant:winner": "winner.example",
        "tenant:corrob": "corrob.example",
      },
    });

    const repCapOf = (s: SourceId): Unit => repCapFor([...trust.anchorsOf(s)]);
    const reputation = createSqliteReputationLedger(repCapOf, { db, clock: () => NOW });
    const corroboration = createSqliteCorroborationLedger({ db });
    const adjudicationProvenance = createSqliteAdjudicationProvenanceLedger({ db });
    const store = createSqliteStore({ db });
    const systemSource = freshSource().sourceId;
    const auditLedger = createSqlitePendingLedger({ db, reputation });

    const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
    // Staking is RETIRED (attribution replaces stake): a constant-zero port.
    const stakePort: StakeLedgerPort = { postedFor: () => 0 };
    const identity: SourceIdentityLayer = createSourceIdentityLayer({
      sources: trust,
      anchors: trust,
      reputation: reputationPort,
      stake: stakePort,
    });

    const ratification: RatificationDeps = {
      ledger: auditLedger,
      systemSource,
      corroboration,
      adjudicationProvenance,
    };
    const engine = createIntelligentDb(store, identity, null, reputation, ratification);

    // =====================================================================
    // (a) TRUST-REGISTRY CLAIMS -> INDEPENDENCE
    // =====================================================================
    // Two SSO members of DIFFERENT tenants, each with a registry-CONFIGURED verified
    // custom domain, so each holds SSO_TENANT_MEMBER + a DOMAIN-grade claim on a
    // DIFFERENT eTLD+1 / different fleet ⇒ genuinely INDEPENDENT under the fleet cap.
    const winnerSrc = trust.registerSsoMember({
      issuer: "https://idp.winner.example",
      subject: "alice",
      tenantId: "tenant:winner",
      verifiedCustomDomain: "winner.example",
      label: "winner",
    }).sourceId; // the strong, anchored incumbent
    const corroboratorSrc = trust.registerSsoMember({
      issuer: "https://idp.corrob.example",
      subject: "bob",
      tenantId: "tenant:corrob",
      verifiedCustomDomain: "corrob.example",
      label: "corroborator",
    }).sourceId; // independent witness
    const challengerSrc = "src:challenger" as SourceId; // fresh, weightless, bare
    const beneficiarySrc = "src:beneficiary" as SourceId; // earns corroboration credit

    // FAIL-CLOSED, twice over:
    //  - an unresolvable publisher URL must never mint a source;
    expect(() => trust.registerPublisher("")).toThrow(RangeError);
    //  - an UNCONFIGURED tenant claiming a custom-domain hint gains NO DOMAIN lift
    //    (the config asserts the claim; a caller hint alone grants nothing).
    const pretenderSrc = trust.registerSsoMember({
      issuer: "https://idp.evil.example",
      subject: "mallory",
      tenantId: "tenant:evil", // not in verifiedTenantDomains
      verifiedCustomDomain: "winner.example",
    }).sourceId;
    expect(
      trust.anchorsOf(pretenderSrc).every((b) => b.independenceWeight <= 0.12),
    ).toBe(true);

    // The stamp now carries real independence (anchor_cost > 0) for a claimed source,
    // and 0 for a bare source (fail-closed default).
    const winnerStamp: IdentityStamp = identity.stampFor(winnerSrc);
    expect(winnerStamp.anchor_cost).toBeGreaterThan(0);
    expect(identity.stampFor(challengerSrc).anchor_cost).toBe(0);
    // The two claimed sources are genuinely independent (different eTLD+1 + tenant).
    expect(trust.independentSources(winnerSrc, corroboratorSrc)).toBe(true);
    // ... while the pretender shares no verified domain and stays correlated-to-nothing
    // useful: it is NOT independent of a bare id (fail-closed empty side).
    expect(trust.independentSources(pretenderSrc, challengerSrc)).toBe(false);

    // =====================================================================
    // (b) writeFact lands provenance-rooted strands (SHARED_ENTITY attach)
    // =====================================================================
    const f1 = engine.writeFact({ entity: ENTITY, payload: { note: "berlin seed 1" }, stamp: winnerStamp });
    const f2 = engine.writeFact({
      entity: ENTITY,
      payload: { note: "berlin seed 2" },
      stamp: identity.stampFor(corroboratorSrc),
    });
    const s1 = store.getStrand(f1)!;
    expect(s1.origin).toBe(FactOrigin.OBSERVED);
    expect(s1.provenance.some((r) => r.sourceId === winnerSrc)).toBe(true);
    // The two same-entity strands are joined by the SHARED_ENTITY relation, now an
    // INDEX rather than a materialized clique (writeFact mints no sibling edges).
    // INTENT preserved (connectivity): a recall seeded at f1 lights f2 because the
    // walk derives same-entity siblings from the entity index on the fly.
    const f1f2 = engine.recall({ seeds: [{ strandId: f1, energy: 1 }] });
    const f1f2Lit = f1f2.lit.map((l) => l.strandId);
    expect(f1f2Lit).toContain(f1);
    expect(f1f2Lit).toContain(f2);

    // =====================================================================
    // (c) CORROBORATION -> Beta reputation + a recorded event
    // =====================================================================
    // The BENEFICIARY filed its own claim (fBen); it is externally ratified AS
    // CORROBORATED BY the (later-disowned) winner's strand f1. The beneficiary earned
    // credit BECAUSE its claim agreed with f1 — so a later disown of f1's source must
    // reverse exactly this credit. The ratify raises the beneficiary's Beta LCB AND
    // records an append-only corroboration event carrying the EXACT applied alpha-mass.
    // SAME entity + SAME payload as f1 ⇒ SAME content_hash, so the engine DERIVES the
    // agreement set itself (#deriveAgreementSet finds f1) — no caller-supplied list (OD-8).
    const fBen = engine.writeFact({
      entity: ENTITY,
      payload: { note: "berlin seed 1" },
      stamp: identity.stampFor(beneficiarySrc),
    });
    const beforeBeneficiary = reputation.scoreOf(beneficiarySrc);
    expect(beforeBeneficiary).toBe(0); // fresh => LCB 0
    engine.ratify({
      strandId: fBen,
      externalStamp: identity.stampFor(beneficiarySrc),
    });
    expect(reputation.scoreOf(beneficiarySrc)).toBeGreaterThan(0); // earned slow, off 0
    const corrobEvents = corroboration.all();
    expect(corrobEvents.length).toBe(1);
    expect(corrobEvents[0]!.beneficiarySourceId).toBe(beneficiarySrc);
    expect(corrobEvents[0]!.corroboratingStrandIds.map(String)).toContain(String(f1));
    expect(corrobEvents[0]!.reputationDelta).toBeGreaterThan(0);

    // =====================================================================
    // (d) DECISIVE-OR-DEFER adjudication: auto-resolve, and high-impact defers
    // =====================================================================
    // Pre-earn the winner's source to a DECISIVE LCB (>> 0.2) so it out-earns a fresh
    // challenger by more than the 0.3 decisive margin. (Decay-on-read is pinned to NOW.)
    for (let i = 0; i < 6; i++) reputation.ratify(winnerSrc, NOW, 1);
    expect(reputation.scoreOf(winnerSrc)).toBeGreaterThan(0.5);

    // A genuine MULTI-CLASS dispute: winner (class:WIN, anchored+earned) vs challenger
    // (class:CHAL, fresh). Hand-filed so the classes are explicit.
    const winStrand = fileStrand(store, "strand:win", winnerSrc, "class:WIN", { v: "Berlin" });
    const chalStrand = fileStrand(store, "strand:chal", challengerSrc, "class:CHAL", { v: "Tokyo" });
    // F4a/F4b (batch 3): a multi-class auto-resolve now requires the WINNING VALUE to be
    // backed by >= 2 mutually anchor-INDEPENDENT roots (F4a structural floor) AND >= 1
    // in-domain co-asserter (F4b). corroboratorSrc is anchor-DISJOINT from winnerSrc
    // (asserted above), so a second "Berlin" strand makes the engine-derived #R = 2 and
    // the in-domain corroboration count = 1 — the decisive winner RESOLVES. The
    // corroborator AGREES (same value), so it is NOT demoted.
    fileStrand(store, "strand:win-corrob", corroboratorSrc, "class:WINCORROB", { v: "Berlin" });

    // ORDINARY adjudication: a decisive, earned winner AUTO-RESOLVES the independent
    // dispute (reputation is an EXTERNAL signal; never headcount). Loser demoted.
    const decisive = engine.adjudicate(ATTR);
    expect(decisive.kind).toBe("RESOLVED");
    expect(store.getStrand(winStrand.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(chalStrand.id)!.fact_state).toBe(FactState.DEMOTED);
    // The adjudication provenance was recorded (so a later disown can re-open it).
    const adjRec = adjudicationProvenance.all().find((r) => r.winner === winStrand.id);
    expect(adjRec).toBeDefined();
    const tippedCsid = adjRec!.contradictionSetId;

    // HIGH-IMPACT variant: a fresh, comparable multi-class dispute where the winner
    // CANNOT clear the irreversible-decision gate (only 1 corroboration, 1 anchor class,
    // recently contradicted) DEFERS to a human no matter the LCB gap.
    // NB (batch 3): the winning value here is "Bonn" — DISTINCT from the resolved dispute's
    // "Berlin" — because the engine's agreement set is entity+content_hash scoped (NOT
    // attribute-scoped), so reusing "Berlin" would let the independent ATTR co-asserter above
    // leak in and lift the engine-derived #R to 2. A unique value keeps hiWinner a SINGLE
    // actor (#R = 1), which is the whole point of the high-impact DEFER below.
    const hiWinner = fileStrand(store, "strand:hi-win", winnerSrc, "class:HIWIN", { v: "Bonn" }, ATTR_HI);
    const hiChallenger = fileStrand(
      store,
      "strand:hi-chal",
      challengerSrc,
      "class:HICHAL",
      { v: "Tokyo" },
      ATTR_HI,
    );
    // OD-8: the caller supplies only the INTENT flag; the engine BUILDS the gate evidence
    // from its own trust layer. hiWinner is backed by a SINGLE actor (winnerSrc) across one
    // value fingerprint, so the engine-derived #R = 1 < minWinnerAnchorClasses (2) ⇒ the
    // high-impact gate fails ⇒ DEFER no matter the decisive LCB gap.
    const highImpactOutcome = engine.adjudicate(ATTR_HI, { highImpact: true });
    expect(highImpactOutcome.kind).toBe("DEFERRED");
    // The high-impact dispute is now in the human queue; nothing demoted.
    expect(store.getStrand(hiWinner.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(hiChallenger.id)!.fact_state).toBe(FactState.LIVE);
    const deferredCsids = engine.listPending().map((p) => p.contradictionSetId);
    if (highImpactOutcome.kind === "DEFERRED") {
      expect(deferredCsids).toContain(highImpactOutcome.pending.contradictionSetId);
    }

    // =====================================================================
    // (e) DISOWN (the newly-wired engine verb): demote + spare + reverse + re-open
    // =====================================================================
    // Set up derivatives of the winner's WIN strand. They are authored by DOWNSTREAM
    // sources (NOT the winner) so they are reached only via the DERIVATION edge — a
    // genuine downstream frontier, not part of the disowned source's own seed:
    //  - `derivedTainted` rests SOLELY on the tainted class:WIN => DEMOTED + its source
    //    contradicted (class-bounded clawback).
    //  - `derivedSurvives` has TWO disjoint independent (non-tainted) classes => SPARED
    //    by false-disown protection (its existence does not solely rest on tainted input).
    const derivedTainted: Strand = {
      ...fileStrand(store, "strand:derived-tainted", "src:derived-author" as SourceId, "class:WIN", {
        v: "derived from winner only",
      }),
      origin: FactOrigin.DERIVED,
    };
    store.putStrand(derivedTainted);
    store.putEdge(derivationEdge(derivedTainted.id, winStrand.id));

    const derivedSurvives: Strand = {
      ...fileStrand(store, "strand:derived-survives", "src:i1" as SourceId, "class:IND1", {
        v: "independently corroborated",
      }),
      origin: FactOrigin.DERIVED,
      provenance: [
        {
          rootId: "root:ds1" as ProvenanceRoot["rootId"],
          independenceClass: "class:IND1" as IndependenceClassId,
          sourceId: "src:i1" as SourceId,
          establishedAt: NOW,
        },
        {
          rootId: "root:ds2" as ProvenanceRoot["rootId"],
          independenceClass: "class:IND2" as IndependenceClassId,
          sourceId: "src:i2" as SourceId,
          establishedAt: NOW,
        },
      ],
    };
    store.putStrand(derivedSurvives);
    store.putEdge(derivationEdge(derivedSurvives.id, winStrand.id));

    // Record the beneficiary's earned alpha BEFORE the disown so we can prove the EXACT
    // corroboration credit is reversed.
    const beneficiaryAlphaBefore = reputation.stateOf(beneficiarySrc)!.alpha;
    expect(beneficiaryAlphaBefore).toBeGreaterThan(1); // it earned credit in (c)

    const disownResult = engine.disown(winnerSrc, { at: NOW });

    // The disowned source is cratered back to the prior Beta(1,1) (LCB 0).
    expect(reputation.scoreOf(winnerSrc)).toBe(0);
    expect(reputation.stateOf(winnerSrc)!.alpha).toBe(1);

    // The tainted derivative is DEMOTED; the independently-corroborated one SURVIVES.
    expect(disownResult.demotedDownstream.map(String)).toContain(String(derivedTainted.id));
    expect(store.getStrand(derivedTainted.id)!.fact_state).toBe(FactState.DEMOTED);
    expect(disownResult.survivedDemotion.map(String)).toContain(String(derivedSurvives.id));
    expect(store.getStrand(derivedSurvives.id)!.fact_state).toBe(FactState.LIVE);

    // The EXACT corroboration credit reversed: the event's beneficiary lost precisely the
    // recorded alpha-mass (the event intersected the disowned source's seed via f1).
    expect(disownResult.reversedCorroborationEventIds.length).toBeGreaterThanOrEqual(1);
    const beneficiaryAlphaAfter = reputation.stateOf(beneficiarySrc)!.alpha;
    expect(beneficiaryAlphaAfter).toBeCloseTo(
      beneficiaryAlphaBefore - corrobEvents[0]!.reputationDelta,
      9,
    );
    expect(corroboration.isReversed(corrobEvents[0]!.eventId)).toBe(true);

    // The dispute the (now-tainted) winner strand TIPPED is RE-OPENED for a human.
    expect(disownResult.reopenedDisputes.map(String)).toContain(String(tippedCsid));
    const reopened = engine
      .listPending()
      .find((p) => p.contradictionSetId === (tippedCsid as ContradictionSetId));
    expect(reopened).toBeDefined();
    expect(reopened!.reason).toBe("REOPENED_BY_DISOWN");

    // DISOWN IS IDEMPOTENT: a second disown of the same source is a clean no-op.
    const second = engine.disown(winnerSrc, { at: NOW });
    expect(second.seedClawedBack).toEqual([]);
    expect(second.demotedDownstream).toEqual([]);
    expect(second.reversedCorroborationEventIds).toEqual([]);

    // =====================================================================
    // (f) THE CHECKSUM CHAIN: verify end-to-end; tamper caught; checkpoint
    //     exposes a rewrite/rollback
    // =====================================================================
    // The untampered audit chain hash-verifies end-to-end, and the current
    // chainHead() CHECKPOINT is exactly the last record's checksum — the plain
    // `{seq, headHash}` artifact an operator exports to ACCESS-SEGREGATED external
    // storage for insider-tamper evidence (the honest-disclosure residual: an actor
    // with live write access could rewrite the whole chain and re-checksum it, so
    // the exported head is what pins history).
    expect(auditLedger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    const records = auditLedger.records();
    expect(records.length).toBeGreaterThan(0);
    const head = auditLedger.chainHead();
    expect(head.seq).toBe(records.length - 1);
    expect(head.headHash).toBe(records[records.length - 1]!.thisHash);

    // BYTE-TAMPER CAUGHT: flip one persisted checksum byte at rest (raw SQL, behind
    // the ledger's back) — verifyChain reports ok:false NAMING that exact seq.
    const row = db
      .prepare("SELECT seq, json FROM ratification_records ORDER BY seq LIMIT 1")
      .get() as { seq: number; json: string };
    const tamperedRec = JSON.parse(row.json) as LedgerRecord & { thisHash: string };
    tamperedRec.thisHash =
      (tamperedRec.thisHash[0] === "0" ? "1" : "0") + tamperedRec.thisHash.slice(1);
    db.prepare("UPDATE ratification_records SET json = ? WHERE seq = ?").run(
      JSON.stringify(tamperedRec),
      row.seq,
    );
    expect(auditLedger.verifyChain()).toEqual({ ok: false, firstBrokenSeq: row.seq });
    // Restore the original row; the chain verifies again (side-effect-free check).
    db.prepare("UPDATE ratification_records SET json = ? WHERE seq = ?").run(row.json, row.seq);
    expect(auditLedger.verifyChain().ok).toBe(true);

    // REWRITE/ROLLBACK EXPOSED BY THE CHECKPOINT: a wholesale replacement chain
    // (an insider's re-checksummed history, or a rollback to a shorter chain)
    // verifies internally — that is the disclosed limit of a checksum chain — but
    // it can NEVER reproduce the externally-stored head: seq/hash diverge.
    const rewritten = createPendingLedger();
    expect(rewritten.verifyChain().ok).toBe(true); // internally consistent...
    const rewrittenHead = rewritten.chainHead();
    expect(rewrittenHead.seq).not.toBe(head.seq); // ...but the checkpoint exposes it
    expect(rewrittenHead.headHash).not.toBe(head.headHash);

    expect(store.integrityCheck!()).toBe(true);

    // =====================================================================
    // (g) reconcile reports ok (no off-ledger reputation drift)
    // =====================================================================
    // Snapshot every source's live alpha; the reconciler proves earned mass is fully
    // explained by recorded (non-reversed) corroboration events — beyond which is drift.
    const sources: SourceId[] = [
      winnerSrc,
      corroboratorSrc,
      challengerSrc,
      beneficiarySrc,
      "src:i1" as SourceId,
      "src:i2" as SourceId,
    ];
    const snapshots: AlphaSnapshot[] = sources.map((s) => ({
      sourceId: s,
      alpha: reputation.stateOf(s)?.alpha ?? 1,
    }));
    const report = reconcileLedger(snapshots, corroboration);
    expect(report.ok).toBe(true);
    expect(report.drifted).toEqual([]);

    db.close();
  });
});
