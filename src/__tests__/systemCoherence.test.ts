/**
 * systemCoherence.test.ts — THE END-TO-END SYSTEM-COHERENCE TEST.
 *
 * ONE integration test that wires the WHOLE pipeline together over a SINGLE,
 * SHARED SQLite handle (facts + trust + corroboration + adjudication-provenance +
 * audit, one crash-consistent file) and proves the four roadmap pillars compose as a
 * SYSTEM — surfacing any capability that is built-but-UNWIRED. It exercises, in order:
 *
 *   (a) ANCHOR BINDING → INDEPENDENCE: a source proves a DOMAIN anchor through the real
 *       binder + fleet-capped {@link createAnchorRegistry}.ingest(signed attestation);
 *       its stamp gains real anchor_cost (independence > 0), and a SECOND domain source
 *       behind a DIFFERENT registrar/eTLD is genuinely independent of it.
 *   (b) writeFact lands provenance-rooted strands attached by SHARED_ENTITY.
 *   (c) CORROBORATION → BETA REPUTATION + EVENT: db.ratify(..., corroboratingStrandIds)
 *       raises the source's Beta LCB AND records an append-only corroboration event.
 *   (d) DECISIVE-OR-DEFER: a multi-class dispute with a decisively-out-earned winner
 *       AUTO-RESOLVES on the LCB margin; the SAME dispute flagged HIGH-IMPACT (winner
 *       fails the count/anchor-class gate) DEFERS to listPending().
 *   (e) DISOWN (the newly-wired engine verb): db.disown(source) craters the source,
 *       DEMOTES its derivatives (sparing an independently-corroborated one via false-
 *       disown protection), reverses the EXACT corroboration credit, and RE-OPENS a
 *       dispute a tainted strand merely tipped.
 *   (f) MERKLE STH: the audit chain's Merkle Signed Tree Head verifies, and a rollback
 *       to a smaller tree is CAUGHT against a witness's published prior STH.
 *   (g) reconcileLedger reports ok (no off-ledger drift).
 *
 * COMPOSITION-ROOT NOTE (the stranded capability this test resolves): before this work,
 * `downstreamDisownSweep` (the full undo engine) was reachable ONLY as a free function
 * from the barrel — NOT through the `IntelligentDb` engine. It is now WIRED as the
 * `db.disown(...)` verb (api.ts), assembling its `DisownHardeningDeps` from the wired
 * RatificationDeps. The Merkle `MerkleLog` witness layer is, by design, a STANDALONE
 * tamper-evidence layer composed DIRECTLY over the same audit chain (the shared pending
 * ledger's records ARE its leaves) — kept explicit rather than over-coupling the engine.
 *
 * Everything runs through the public barrel (`../index.js`). A controllable clock is
 * injected EVERYWHERE time matters (reputation decay-on-read, attestation TTL, STH) so
 * no assertion is wall-clock-dependent.
 */

import { rmSync } from "node:fs";
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
  createAnchorRegistry,
  createStakeLedger,
  createMerkleLog,
  InMemoryPublicationSink,
  verifyTreeHead,
  signAttestation,
  repCapFor,
  AnchorClass,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  reconcileLedger,
  generatePassport,
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
  KeyRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  Passport,
  KeyPair,
  HighImpactContext,
  AlphaSnapshot,
  AnchorAttestation,
  IndependenceClassId,
  OperatorClassId,
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

// --- minimal key-registry port (the real registry owns anchors) -------------

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

/** Hand-build + sign a DOMAIN attestation binding `sourceId` to a domain/operator. */
function domainAttestation(
  sourceId: SourceId,
  classId: string,
  operatorClassId: string,
  verifier: KeyPair,
  now: EpochMs,
): AnchorAttestation {
  const weight = 0.35 as Unit; // DOMAIN independence weight
  return signAttestation(
    {
      sourceId,
      anchorType: AnchorClass.DOMAIN,
      anchorId: `anchorid:${classId}`,
      operatorClassId: operatorClassId as unknown as OperatorClassId,
      proofRef: `_iddb-challenge.${classId}`,
      weight,
      classId: classId as unknown as IndependenceClassId,
      notBefore: now,
      notAfter: asEpochMs((now as number) + 30 * DAY),
    },
    verifier,
  );
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
  it("binds anchors -> earns Beta credit + events -> decisive/high-impact adjudication -> disown demotes+reverses+re-opens -> Merkle STH verifies + rollback caught -> reconcile ok", () => {
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
    // The verifier whose key signs every attestation; the registry validates against it.
    const verifier = generatePassport();
    const realAnchors = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => NOW,
    });

    const repCapOf = (s: SourceId): Unit => repCapFor([...realAnchors.anchorsOf(s)]);
    const reputation = createSqliteReputationLedger(repCapOf, { db, clock: () => NOW });
    const corroboration = createSqliteCorroborationLedger({ db });
    const adjudicationProvenance = createSqliteAdjudicationProvenanceLedger({ db });
    const store = createSqliteStore({ db });
    const systemSigner = generatePassport();
    const auditLedger = createSqlitePendingLedger({ db, reputation });

    const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
    const stakeLedger = createStakeLedger();
    const stakePort: StakeLedgerPort = { postedFor: (s) => stakeLedger.posted(s) };
    const identity: SourceIdentityLayer = createSourceIdentityLayer({
      keys: makeKeyRegistry(),
      anchors: realAnchors,
      reputation: reputationPort,
      stake: stakePort,
    });

    const ratification: RatificationDeps = {
      ledger: auditLedger,
      systemSigner,
      corroboration,
      adjudicationProvenance,
    };
    const engine = createIntelligentDb(store, identity, null, reputation, ratification);

    // =====================================================================
    // (a) ANCHOR BINDING -> INDEPENDENCE
    // =====================================================================
    const winnerSrc = "src:winner-domain" as SourceId; // the strong, anchored incumbent
    const corroboratorSrc = "src:corroborator-domain" as SourceId; // independent witness
    const challengerSrc = "src:challenger" as SourceId; // fresh, weightless
    const beneficiarySrc = "src:beneficiary" as SourceId; // earns corroboration credit

    identity.register({ ...generatePassport(), sourceId: winnerSrc } as Passport, []);
    identity.register({ ...generatePassport(), sourceId: corroboratorSrc } as Passport, []);

    // Ingest signed DOMAIN attestations on DIFFERENT eTLD+1 + DIFFERENT registrar so the
    // two sources are genuinely INDEPENDENT under the fleet cap (not same-operator).
    expect(
      realAnchors.ingest(
        domainAttestation(winnerSrc, "winner.example", "registrar:A", verifier, NOW),
        NOW,
      ),
    ).toBe(true);
    expect(
      realAnchors.ingest(
        domainAttestation(corroboratorSrc, "corrob.example", "registrar:B", verifier, NOW),
        NOW,
      ),
    ).toBe(true);
    // A FORGED attestation (signed by a stranger, not the verifier) is fail-closed.
    const forger = generatePassport();
    expect(
      realAnchors.ingest(
        domainAttestation("src:forged" as SourceId, "evil.example", "registrar:Z", forger, NOW),
        NOW,
      ),
    ).toBe(false);

    // The stamp now carries real independence (anchor_cost > 0) for an anchored source,
    // and 0 for a BARE_KEY (fail-closed default).
    const winnerStamp: IdentityStamp = identity.stampFor(winnerSrc);
    expect(winnerStamp.anchor_cost).toBeGreaterThan(0);
    expect(identity.stampFor(challengerSrc).anchor_cost).toBe(0);
    // The two anchored sources are genuinely independent (different eTLD+1 + registrar).
    expect(realAnchors.independentSources!(winnerSrc, corroboratorSrc)).toBe(true);

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
    // The two same-entity strands were joined by bidirectional SHARED_ENTITY threads.
    const sharedEdges = [...store.allEdges()].filter((e) => e.edgeType === EdgeType.SHARED_ENTITY);
    expect(sharedEdges.length).toBeGreaterThanOrEqual(2);
    expect(store.getStrand(f2)!.inEdges.length).toBeGreaterThanOrEqual(1);

    // =====================================================================
    // (c) CORROBORATION -> Beta reputation + a recorded event
    // =====================================================================
    // The BENEFICIARY filed its own claim (fBen); it is externally ratified AS
    // CORROBORATED BY the (later-disowned) winner's strand f1. The beneficiary earned
    // credit BECAUSE its claim agreed with f1 — so a later disown of f1's source must
    // reverse exactly this credit. The ratify raises the beneficiary's Beta LCB AND
    // records an append-only corroboration event carrying the EXACT applied alpha-mass.
    const fBen = engine.writeFact({
      entity: ENTITY,
      payload: { note: "beneficiary agrees with the winner" },
      stamp: identity.stampFor(beneficiarySrc),
    });
    const beforeBeneficiary = reputation.scoreOf(beneficiarySrc);
    expect(beforeBeneficiary).toBe(0); // fresh => LCB 0
    engine.ratify({
      strandId: fBen,
      externalStamp: identity.stampFor(beneficiarySrc),
      corroboratingStrandIds: [f1], // agreed with the winner's strand (later disowned)
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
    const hiWinner = fileStrand(store, "strand:hi-win", winnerSrc, "class:HIWIN", { v: "Berlin" }, ATTR_HI);
    const hiChallenger = fileStrand(
      store,
      "strand:hi-chal",
      challengerSrc,
      "class:HICHAL",
      { v: "Tokyo" },
      ATTR_HI,
    );
    const highImpact: HighImpactContext = {
      corroborationCountOf: () => 1, // < minCorroborationCount (2) => fails gate
      lastContradictionAtOf: () => NOW, // contradicted "now" => not recency-clean
      anchorClassCountOf: () => 1, // < minWinnerAnchorClasses (2) => fails gate
    };
    const highImpactOutcome = engine.adjudicate(ATTR_HI, { highImpact });
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
    // (f) MERKLE STH verifies; a rollback is caught against a witness's prior STH
    // =====================================================================
    // The audit chain (the shared pending ledger) IS the Merkle log's leaves. Two
    // independent sinks witness each Signed Tree Head.
    const sinkA = new InMemoryPublicationSink();
    const sinkB = new InMemoryPublicationSink();
    const merkle = createMerkleLog({ ledger: auditLedger, signer: systemSigner, sinks: [sinkA, sinkB] });
    merkle.publishGenesis(NOW);
    const sth = merkle.anchor(asEpochMs((NOW as number) + DAY)); // publish the current STH to both sinks
    // The STH verifies against the log's public key (authentic, non-repudiable).
    expect(verifyTreeHead(sth, merkle.logPublicKeyPem())).toBe(true);
    expect(sth.tree_size).toBe(auditLedger.records().length);
    // A healthy witness check (the live tree still extends the witnessed prior STH) passes.
    expect(merkle.witness(sinkA, asEpochMs((NOW as number) + 2 * DAY)).ok).toBe(true);

    // ROLLBACK CAUGHT: an operator that rolls the log back to a SMALLER tree cannot serve
    // a consistency proof from the witness's prior STH — detected as ROLLBACK_OR_DELETION.
    const rolledBack = createPendingLedger();
    const rolledLog = createMerkleLog({
      ledger: rolledBack,
      signer: systemSigner,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    });
    const caught = rolledLog.witness(sinkA, asEpochMs((NOW as number) + 3 * DAY));
    expect(caught.ok).toBe(false);
    expect(caught.reason).toBe("ROLLBACK_OR_DELETION");

    // The untampered audit chain itself still hash-verifies end-to-end.
    expect(auditLedger.verifyChain().ok).toBe(true);
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
