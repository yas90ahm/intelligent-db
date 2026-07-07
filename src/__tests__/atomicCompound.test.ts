/**
 * atomicCompound.test.ts — HARDENING TICK 3: proves COMPOUND operations are
 * ALL-OR-NOTHING over the shared SQLite handle, that committed compound state
 * survives a simulated crash (reopen without a clean close), and that corruption is
 * DETECTED (PRAGMA integrity_check + the audit chain verifier) — never silently
 * served as correct.
 *
 * The remaining weakness tick 3 closes: facts + trust + audit each persist crash-safe
 * PER committed write, but a COMPOUND op (adjudicate RESOLVED, approve, disownSweep,
 * writeFact's multi-edge attach) is MANY writes; a crash MID-OP could leave a
 * half-state (a loser demoted with no OUTRANKS edge; an APPROVAL record with no
 * matching demotion; a half-finished disown sweep). For a bank these must be atomic.
 *
 * Harness: one shared `DatabaseSync` handle backs the StrandStore + the reputation
 * ledger + the ratification (audit) ledger, so a compound op's writes across all
 * three ride ONE `store.beginTxn()` transaction. The engine wraps each compound op in
 * that txn; a thrown error rolls the WHOLE unit back.
 *
 * Test matrix:
 *   1. ROLLBACK LEAVES NOTHING: force a mid-op throw inside adjudicate's RESOLVED loop
 *      (a putStrand that throws on the 2nd loser) and inside downstreamDisownSweep
 *      (a contradict that throws) — assert NO demotion, NO OUTRANKS edge, NO rep
 *      change, NO audit record persisted (the db is byte-for-byte the pre-op state).
 *   2. COMMITTED SURVIVES REOPEN (simulated crash): drive a full approve() compound
 *      op, then REOPEN a fresh handle on the same path WITHOUT a clean close of the
 *      first (WAL recovery) — assert demotions + OUTRANKS edges + reputation + the
 *      APPROVAL record are ALL present and verifyChain() is ok.
 *   3. INTEGRITY / CORRUPTION: integrityCheck() true on a clean db; flip a byte in a
 *      persisted audit row -> verifyChain().ok === false naming the first broken seq.
 *
 * Temp db files live under os.tmpdir(); afterEach closes tracked handles and removes
 * the db + its WAL/SHM siblings (close-first is load-bearing on Windows).
 */

import { createRequire } from "node:module";
import { freshSource } from "../testSupport/identityFixtures.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  createAdjudicationProvenanceLedger,
  createIntelligentDb,
  createSourceIdentityLayer,
  createSqliteStore,
  createSqliteReputationLedger,
  createSqlitePendingLedger,
  createSqliteCorroborationLedger,
  downstreamDisownSweep,
  independenceBetween,
  repCapFor,
  AnchorClass,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  AttributeKey,
  ContradictionSetId,
  CorroborationLedger,
  EdgeId,
  EntityId,
  IntelligentDb,
  PendingLedger,
  SourceRegistryPort,
  SourceRef,
  RatificationDeps,
  ReputationLedger,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SqliteStrandStore,
  StakeLedgerPort,
  Strand,
  StrandId,
  Unit,
} from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSyncType;
};

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- temp db lifecycle ------------------------------------------------------

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-atomic-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

function trackClose(fn: () => void): void {
  closers.push(() => {
    try {
      fn();
    } catch {
      // already closed
    }
  });
}

beforeEach(() => {
  paths = [];
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const base of paths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- identity-layer wiring backed by the SHARED reputation ledger -----------

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

function kycAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.VERIFIED_HUMAN,
    realizedCost: 0.7 as Unit,
    independenceWeight: 0.7 as Unit,
  };
}

/** A DOMAIN anchor — a DIFFERENT class than KYC, so it is mutually INDEPENDENT of a
 *  KYC-anchored source (independenceBetween > 0). Used to corroborate a winning value
 *  with a genuinely anchor-disjoint root so the F4a >= 2-root floor clears. */
function domainAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.DOMAIN,
    realizedCost: 0.35 as Unit,
    independenceWeight: 0.35 as Unit,
  };
}

/**
 * Build a fully-wired engine over ONE shared SQLite handle: the StrandStore, the
 * reputation ledger, and the ratification (audit) ledger all ride `db`, and the
 * identity facade reads `scoreOf` from the SAME reputation ledger. This is the
 * shared-handle atomic-durability configuration a compound op needs.
 */
interface Wired {
  db: DatabaseSyncType;
  store: SqliteStrandStore;
  identity: SourceIdentityLayer;
  reputation: ReputationLedger;
  ratification: RatificationDeps;
  engine: IntelligentDb;
  anchors: AnchorRegistryPort;
  sources: SourceRegistryPort;
  corroboration?: CorroborationLedger;
}

function wire(path: string, opts?: { withCorroboration?: boolean }): Wired {
  const db: DatabaseSyncType = new DatabaseSync(path);
  // The OWNER of this shared handle sets WAL before any shared-handle store/ledger
  // constructor borrows it (see store/sqliteStore.ts's assertSharedHandleWal): those
  // constructors now VERIFY journal_mode=WAL and throw if it never took. WAL mode is
  // recorded in the database file header, so every later reopen of this SAME path
  // (the crash-recovery / corruption-detection tests below) inherits it automatically.
  db.exec("PRAGMA journal_mode=WAL");
  trackClose(() => db.close());

  const sources = makeSourceRegistry();
  const anchors = makeAnchorRegistry();
  const repCapOf = (s: SourceId): Unit => repCapFor([...anchors.anchorsOf(s)]);
  // Pin the decay-on-read clock to the test's logical NOW: the fixture earns at the
  // synthetic NOW, so reads at NOW are Δt=0 (the default Date.now() clock would treat
  // the gap to the real wall clock as dormancy and crater the pre-earned incumbent).
  const reputation = createSqliteReputationLedger(repCapOf, { db, clock: () => NOW });

  const reputationPort: ReputationLedgerPort = {
    scoreOf: (s: SourceId): Unit => reputation.scoreOf(s),
  };
  // Staking is RETIRED (attribution replaces stake): a constant-zero port.
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };

  const identity = createSourceIdentityLayer({
    sources,
    anchors,
    reputation: reputationPort,
    stake: stakePort,
  });

  const store = createSqliteStore({ db });
  const systemSource = freshSource().sourceId;
  const ledger = createSqlitePendingLedger({ db, reputation });
  // Optional CORROBORATION-EVENT LEDGER, same shared handle (only when a test needs
  // `ratify`'s corroboration-recording path — the other compound-op tests don't).
  const corroboration =
    opts?.withCorroboration === true ? createSqliteCorroborationLedger({ db }) : undefined;
  const ratification: RatificationDeps = {
    ledger,
    systemSource,
    ...(corroboration !== undefined ? { corroboration } : {}),
  };

  const engine = createIntelligentDb(store, identity, null, reputation, ratification);
  return {
    db,
    store,
    identity,
    reputation,
    ratification,
    engine,
    anchors,
    sources,
    ...(corroboration !== undefined ? { corroboration } : {}),
  };
}

/** Register a fresh KYC-anchored source and return its passport + stamp. */
function newSource(w: Wired): { passport: SourceRef; sourceId: SourceId } {
  const passport = freshSource();
  w.sources.register(passport);
  w.anchors.bind(passport.sourceId, [kycAnchor()]);
  return { passport, sourceId: passport.sourceId };
}

// ---------------------------------------------------------------------------
// 1. ROLLBACK LEAVES NOTHING — a forced mid-op throw rolls the WHOLE op back
// ---------------------------------------------------------------------------

describe("atomic compound writes — a forced mid-op error rolls back fully (no partial state)", () => {
  it("adjudicate RESOLVED: a putStrand throwing on the 2nd loser leaves NO demotion, edge, or rep move", () => {
    const path = freshPath("adj-rollback");
    const w = wire(path);

    // One high-rep incumbent (winner) + TWO fresh same-class echoes (losers) so the
    // RESOLVED demotion loop has >= 2 iterations to fail partway through. Same source
    // for the two losers => single independence class => the SAFE in-graph case.
    const incumbent = newSource(w);
    // Earn the incumbent real reputation so it deterministically outranks the echoes.
    for (let i = 0; i < 30; i++) w.reputation.ratify(incumbent.sourceId, NOW);

    const winnerStamp = w.identity.stampFor(incumbent.sourceId);
    const echoStamp = w.identity.stampFor(incumbent.sourceId); // same source for both losers' class
    void echoStamp;

    // The winner's claim.
    const winnerId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Germany" },
      stamp: winnerStamp,
    });

    // F4a/F4b (batch 3): a MULTI-CLASS auto-resolve now requires the WINNING VALUE to be
    // backed by >= 2 mutually anchor-INDEPENDENT roots (F4a) AND >= 1 in-domain co-asserter
    // (F4b). Corroborate "Germany" from a DOMAIN-anchored source DISJOINT from the
    // incumbent's KYC anchor, so the engine-derived #R(winner) = 2 and the in-domain
    // corroboration count = 1. The corroborator AGREES, so it is NOT one of the two losers;
    // the RESOLVED demotion loop still demotes BOTH Tokyo + Paris (>= 2 iterations).
    const corroborator = freshSource();
    w.sources.register(corroborator);
    w.anchors.bind(corroborator.sourceId, [domainAnchor()]);
    w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Germany" },
      stamp: w.identity.stampFor(corroborator.sourceId),
    });

    // Two losing claims from FRESH zero-rep sources (so they lose), same class each
    // other is irrelevant — what matters is a single-class dispute resolves in-graph.
    const loserA = newSource(w);
    const loserB = newSource(w);
    const loserAId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Tokyo" },
      stamp: w.identity.stampFor(loserA.sourceId),
    });
    const loserBId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Paris" },
      stamp: w.identity.stampFor(loserB.sourceId),
    });

    // Snapshot the pre-adjudication state of every member + reputation.
    const before = {
      winner: w.store.getStrand(winnerId)!,
      loserA: w.store.getStrand(loserAId)!,
      loserB: w.store.getStrand(loserBId)!,
      repLoserA: w.reputation.stateOf(loserA.sourceId),
      repLoserB: w.reputation.stateOf(loserB.sourceId),
      edgeCount: [...w.store.allEdges()].length,
    };
    // No demotion has happened yet.
    expect(before.loserA.fact_state).toBe(FactState.LIVE);
    expect(before.loserB.fact_state).toBe(FactState.LIVE);

    // Monkeypatch putStrand to THROW on the SECOND demotion write — a crash mid-loop.
    const realPut = w.store.putStrand.bind(w.store);
    let demoteWrites = 0;
    w.store.putStrand = (s: Strand): void => {
      // Only count writes of a DEMOTED loser (the adjudication's demotion persist).
      if (s.fact_state === FactState.DEMOTED) {
        demoteWrites++;
        if (demoteWrites === 2) {
          throw new Error("INJECTED mid-adjudication crash on the 2nd loser");
        }
      }
      realPut(s);
    };

    // The compound op must throw...
    expect(() => w.engine.adjudicate(ATTR)).toThrow(/INJECTED/);

    // ...and roll back ENTIRELY: restore the real putStrand and read the db back.
    w.store.putStrand = realPut;

    const afterLoserA = w.store.getStrand(loserAId)!;
    const afterLoserB = w.store.getStrand(loserBId)!;
    const afterWinner = w.store.getStrand(winnerId)!;

    // NO demotion is visible (even the first loser, written before the throw, is rolled back).
    expect(afterLoserA.fact_state).toBe(FactState.LIVE);
    expect(afterLoserB.fact_state).toBe(FactState.LIVE);
    expect(afterLoserA.outranked_by).toBeNull();
    expect(afterLoserB.outranked_by).toBeNull();
    // Winner untouched.
    expect(afterWinner.fact_state).toBe(FactState.LIVE);

    // NO new OUTRANKS edge persisted.
    const outranks = [...w.store.allEdges()].filter((e) => e.edgeType === EdgeType.OUTRANKS);
    expect(outranks.length).toBe(0);
    expect([...w.store.allEdges()].length).toBe(before.edgeCount);

    // NO reputation crater on either loser (no contradict committed).
    expect(w.reputation.stateOf(loserA.sourceId)?.contradictedCount ?? 0).toBe(
      before.repLoserA?.contradictedCount ?? 0,
    );
    expect(w.reputation.stateOf(loserB.sourceId)?.contradictedCount ?? 0).toBe(
      before.repLoserB?.contradictedCount ?? 0,
    );

    // The structural integrity of the db is intact after the rollback.
    expect(w.store.integrityCheck()).toBe(true);

    // A1 — the rollback covered the MUTATION RECEIPTS too: the DEMOTE/contradict receipt
    // for the FIRST loser (emitted before the 2nd-loser throw) left NO orphan leaf.
    expect(
      w.ratification.ledger.records().filter((r) => r.kind === "MUTATION").length,
    ).toBe(0);

    // PROVE this was genuinely the RESOLVED path (not a vacuous DEFERRED that demotes
    // nothing anyway): with putStrand restored, re-running adjudicate now SUCCEEDS and
    // resolves the SAME dispute, demoting BOTH losers — confirming the rolled-back op
    // was a real 2-demotion compound op AND that the db was left cleanly re-runnable.
    const redo = w.engine.adjudicate(ATTR);
    expect(redo.kind).toBe("RESOLVED");
    if (redo.kind === "RESOLVED") {
      expect(redo.demotions.length).toBe(2);
    }
    expect(w.store.getStrand(loserAId)!.fact_state).toBe(FactState.DEMOTED);
    expect(w.store.getStrand(loserBId)!.fact_state).toBe(FactState.DEMOTED);
    // The redo cleanly produced the MUTATION effect leaves AND the chain verifies.
    expect(
      w.ratification.ledger.records().filter((r) => r.kind === "MUTATION").length,
    ).toBeGreaterThan(0);
    expect(w.ratification.ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });

  it("downstreamDisownSweep: a ledger.contradict throwing mid-sweep leaves NO demotion or clawback", () => {
    const path = freshPath("disown-rollback");
    const w = wire(path);

    // Build a tiny derived chain: a SEED strand (the disowned source's) with a
    // derived child resting on it via a DERIVATION edge. Disowning must demote the
    // child + contradict its source — atomically.
    const bad = newSource(w);
    const seedId = asStrandId("strand:seed");
    const derivedId = asStrandId("strand:derived");

    const seed = makeStrand(seedId, ENTITY, ATTR, bad.sourceId, "class:bad");
    const derived = makeStrand(derivedId, ENTITY, ATTR, bad.sourceId, "class:bad");
    w.store.putStrand(seed);
    w.store.putStrand(derived);
    // DERIVATION edge points derived -> seed (derived rested on seed).
    w.store.putEdge({
      id: "edge:der" as EdgeId,
      from: derivedId,
      to: seedId,
      edgeType: EdgeType.DERIVATION,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    });
    // Give the bad source some earned reputation so a crater is observable.
    for (let i = 0; i < 5; i++) w.reputation.ratify(bad.sourceId, NOW);

    const beforeEdges = [...w.store.allEdges()].length;
    const beforeDerived = w.store.getStrand(derivedId)!;
    expect(beforeDerived.fact_state).toBe(FactState.LIVE);

    // Make ledger.contradict throw — the sweep contradicts the tainted downstream
    // source AFTER demoting the derived strand, so the demotion is already written
    // when the throw fires: the transaction must roll it back too.
    const realContradict = w.reputation.contradict.bind(w.reputation);
    w.reputation.contradict = (): never => {
      throw new Error("INJECTED mid-sweep crash in contradict");
    };

    expect(() =>
      downstreamDisownSweep(bad.sourceId, [seedId], w.store, w.reputation, NOW),
    ).toThrow(/INJECTED/);

    w.reputation.contradict = realContradict;

    // The derived strand's demotion was rolled back: still LIVE, no outranked_by.
    const afterDerived = w.store.getStrand(derivedId)!;
    expect(afterDerived.fact_state).toBe(FactState.LIVE);
    expect(afterDerived.outranked_by).toBeNull();

    // No disown OUTRANKS stub persisted.
    const stubs = [...w.store.allEdges()].filter((e) => e.edgeType === EdgeType.OUTRANKS);
    expect(stubs.length).toBe(0);
    expect([...w.store.allEdges()].length).toBe(beforeEdges);

    // The disowned source's crater was rolled back too (the direct-seed disownSweep
    // write is inside the same txn). Its score is whatever it earned, NOT cratered to 0.
    expect(w.reputation.scoreOf(bad.sourceId)).toBeGreaterThan(0);

    expect(w.store.integrityCheck()).toBe(true);
  });

  it("downstreamDisownSweep HARDENING-3 reopen: an appendPending throw mid-sweep resyncs the pending ledger's index instead of leaving it stale (disown-reopen index-staleness)", () => {
    // Wave-2 fix mirroring ebaced0 (approve()'s atomicity fix), one layer deeper:
    // HARDENING 3's re-opening path calls `pending.appendPending(...)` for a
    // REOPENED_BY_DISOWN dispute INSIDE the sweep's own transaction. The
    // shared-handle SQLite ledger both durably INSERTs the row AND incrementally
    // updates its OWN in-memory open-pending index (a plain JS Map/Set). If a
    // LATER step in the SAME sweep throws, the surrounding txn rolls back the SQL
    // row — but the in-memory index update does not self-undo unless the caller
    // calls `resyncIndex()` on the rollback path.
    const path = freshPath("disown-reopen-resync");
    const w = wire(path);

    const bad = newSource(w);
    const seedId = asStrandId("strand:reopen-seed");
    const winnerId = asStrandId("strand:reopen-winner");
    const seed = makeStrand(seedId, ENTITY, ATTR, bad.sourceId, "class:bad");
    const winner = makeStrand(winnerId, ENTITY, ATTR, bad.sourceId, "class:bad");
    w.store.putStrand(seed);
    w.store.putStrand(winner);

    const adj = createAdjudicationProvenanceLedger();
    const csid = "cset:reopen-resync" as ContradictionSetId;
    // The winner's margin (0.4) was supplied SOLELY by tainted contributors (the
    // seed + the winner itself): removing them collapses it well below the 0.3
    // decisiveMargin, so the sweep's HARDENING-3 gate re-opens this dispute.
    adj.record({
      contradictionSetId: csid,
      attribute: ATTR,
      winner: winnerId,
      margin: 0.4,
      contributingStrandIds: [winnerId, seedId],
      at: NOW,
    });

    // BEFORE the sweep: nothing pending for this csid (the pre-op truth).
    expect(
      w.ratification.ledger.listPending().some((p) => p.contradictionSetId === csid),
    ).toBe(false);

    // Rig the REAL SQLite pending ledger's appendPending to perform the REAL work
    // (the durable INSERT + the ledger's own in-memory index update) and THEN
    // throw — simulating a later step in the same disown-sweep transaction
    // failing. `withSweepTxn` rolls the WHOLE store transaction back (undoing the
    // `ratification_records` INSERT, since the ledger rides the SAME shared db
    // handle), but the ledger's in-memory index update does not self-undo without
    // the fix.
    const realLedger = w.ratification.ledger;
    const realAppendPending = realLedger.appendPending.bind(realLedger);
    const rigged: PendingLedger = {
      appendPending(pending, systemSource, opts) {
        realAppendPending(pending, systemSource, opts);
        throw new Error("INJECTED mid-sweep crash after reopen appendPending");
      },
      listPending: realLedger.listPending.bind(realLedger),
      approve: realLedger.approve.bind(realLedger),
      appendMutation: realLedger.appendMutation.bind(realLedger),
      verifyChain: realLedger.verifyChain.bind(realLedger),
      chainHead: realLedger.chainHead.bind(realLedger),
      records: realLedger.records.bind(realLedger),
      ...(realLedger.resyncIndex !== undefined
        ? { resyncIndex: realLedger.resyncIndex.bind(realLedger) }
        : {}),
    };

    expect(() =>
      downstreamDisownSweep(bad.sourceId, [seedId], w.store, w.reputation, NOW, undefined, undefined, {
        adjudicationProvenance: adj,
        pending: rigged,
        systemSource: w.ratification.systemSource,
        decisiveMargin: 0.3,
      }),
    ).toThrow(/INJECTED/);

    // THE ASSERTION: listPending() reflects the PRE-OP TRUTH — the reopen never
    // durably happened (the whole sweep transaction rolled back), so it must not
    // report OPEN. Pre-fix, the ledger's in-memory index still (incorrectly)
    // reported it open even though the underlying SQL row was rolled back.
    expect(
      realLedger.listPending().some((p) => p.contradictionSetId === csid),
    ).toBe(false);
    // The audit chain itself is untouched by the rolled-back append.
    expect(realLedger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // No PENDING record for this csid was left durably persisted either.
    expect(
      realLedger
        .records()
        .some((r) => r.kind === "PENDING" && (r.payload as { contradictionSetId?: unknown }).contradictionSetId === csid),
    ).toBe(false);
  });

  it("ratify: a reputation.ratify throwing mid-op leaves NO promotion, credit, or corroboration event", () => {
    const path = freshPath("ratify-rollback");
    const w = wire(path, { withCorroboration: true });

    // The strand to be ratified: DERIVED + PROVISIONAL, so a successful ratify has a
    // visible PROMOTION (DERIVED -> OBSERVED, PROVISIONAL -> LIVE) in addition to the
    // provenance-root append. A second, already-LIVE strand shares its `content_hash`
    // (the same VALUE fingerprint) so `#deriveAgreementSet` names it as a corroborator,
    // giving the ratify a NAMED-corroborator, positive-delta earning path that MUST
    // record a corroboration event.
    const targetId = asStrandId("strand:ratify-target");
    const corroboratorId = asStrandId("strand:ratify-corroborator");
    const sharedHash = "hash:shared-ratify-value" as Strand["content_hash"];

    const target: Strand = {
      ...makeStrand(targetId, ENTITY, ATTR, null, "class:derived"),
      origin: FactOrigin.DERIVED,
      fact_state: FactState.PROVISIONAL,
      content_hash: sharedHash,
    };
    const corroborator: Strand = {
      ...makeStrand(corroboratorId, ENTITY, ATTR, null, "class:corrob"),
      content_hash: sharedHash,
    };
    w.store.putStrand(target);
    w.store.putStrand(corroborator);

    // The external witness whose reputation earns credit from this ratify.
    const witness = newSource(w);
    const externalStamp = w.identity.stampFor(witness.sourceId);

    const before = {
      target: w.store.getStrand(targetId)!,
      repWitness: w.reputation.stateOf(witness.sourceId),
      corroborationEvents: w.corroboration!.all().length,
    };
    expect(before.target.origin).toBe(FactOrigin.DERIVED);
    expect(before.target.fact_state).toBe(FactState.PROVISIONAL);
    expect(before.target.provenance.length).toBe(1);
    expect(before.target.external_reobservation_count).toBe(0);

    // Force a mid-op crash BETWEEN the strand-promotion write and the reputation
    // credit it earns (ratify's `putStrand` runs first; `reputation.ratify` runs
    // second — exactly the seam the bug report names).
    const realRatify = w.reputation.ratify.bind(w.reputation);
    w.reputation.ratify = (): never => {
      throw new Error("INJECTED mid-ratify crash in reputation.ratify");
    };

    expect(() =>
      w.engine.ratify({ strandId: targetId, externalStamp }),
    ).toThrow(/INJECTED/);

    w.reputation.ratify = realRatify;

    // NOTHING committed: the strand promotion (and its provenance append) rolled back
    // along with the reputation credit and the corroboration event.
    const afterTarget = w.store.getStrand(targetId)!;
    expect(afterTarget.origin).toBe(FactOrigin.DERIVED);
    expect(afterTarget.fact_state).toBe(FactState.PROVISIONAL);
    expect(afterTarget.provenance.length).toBe(1);
    expect(afterTarget.external_reobservation_count).toBe(0);

    expect(w.reputation.stateOf(witness.sourceId)).toEqual(before.repWitness);
    expect(w.corroboration!.all().length).toBe(before.corroborationEvents);

    expect(w.store.integrityCheck()).toBe(true);

    // A clean re-run genuinely succeeds afterward: the strand promotes, the witness
    // earns credit, and (because a corroborator with the same value fingerprint is
    // LIVE) exactly one corroboration event is recorded.
    w.engine.ratify({ strandId: targetId, externalStamp });

    const redoTarget = w.store.getStrand(targetId)!;
    expect(redoTarget.origin).toBe(FactOrigin.OBSERVED);
    expect(redoTarget.fact_state).toBe(FactState.LIVE);
    expect(redoTarget.provenance.length).toBe(2);
    expect(redoTarget.external_reobservation_count).toBe(1);

    expect(w.reputation.scoreOf(witness.sourceId)).toBeGreaterThan(before.repWitness?.alpha ?? 0);
    expect(w.corroboration!.all().length).toBe(before.corroborationEvents + 1);

    expect(w.store.integrityCheck()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. COMMITTED COMPOUND OP SURVIVES A SIMULATED CRASH (reopen WITHOUT clean close)
// ---------------------------------------------------------------------------

describe("crash recovery — a committed compound op is fully present after an unclean reopen", () => {
  it("approve(): demotions + OUTRANKS edges + reputation + the APPROVAL record all survive WAL recovery", () => {
    const path = freshPath("approve-crash");

    // --- session 1: drive a full DEFERRED -> approve compound op, then SIMULATE A
    //     CRASH by abandoning the handle WITHOUT a clean store/ledger close. ---
    const winnerId = asStrandId("strand:winner");
    const loserId = asStrandId("strand:loser");
    const csid = "cset:berlin#capital_of" as Parameters<IntelligentDb["approve"]>[0];

    let approverPassport: SourceRef;
    {
      const w = wire(path);
      const winnerSrc = newSource(w);
      const loserSrc = newSource(w);

      // Persist the two disputed member strands directly (the DEFERRED queue holds ids).
      w.store.putStrand(
        makeStrand(winnerId, ENTITY, ATTR, winnerSrc.sourceId, "class:winner"),
      );
      w.store.putStrand(
        makeStrand(loserId, ENTITY, ATTR, loserSrc.sourceId, "class:loser"),
      );

      // Queue the dispute as a PENDING record on the checksum chain.
      w.ratification.ledger.appendPending(
        {
          contradictionSetId: csid,
          attribute: ATTR,
          members: [winnerId, loserId],
          reason: "INDEPENDENT_DISPUTE",
          createdAt: NOW,
        },
        w.ratification.systemSource,
      );

      // A DISTINCT external approver resolves it (compound: APPROVAL append + demote +
      // OUTRANKS + reputation, all in ONE txn over the shared handle).
      approverPassport = freshSource();
      w.sources.register(approverPassport);
      // RC-5: the approver needs a priced anchor (no anchor → no voice) that is
      // disjoint from the members' KYC anchors (DOMAIN ⊥ VERIFIED_HUMAN ⇒ independent).
      w.anchors.bind(approverPassport.sourceId, [domainAnchor()]);
      const resolved = w.engine.approve(csid, winnerId, approverPassport.sourceId, NOW);
      expect(resolved.demotions.length).toBe(1);
      expect(resolved.outranksEdges.length).toBe(1);
      expect(w.ratification.ledger.verifyChain()).toEqual({
        ok: true,
        firstBrokenSeq: null,
      });

      // SIMULATED CRASH: do NOT close the store/ledgers. We leave the WAL behind and
      // let a fresh handle recover. (We registered the raw db.close in trackClose for
      // afterEach cleanup only; we do not call it here — this is the "unclean" path.)
    }

    // --- session 2: reopen a FRESH handle on the same path (WAL recovery). ---
    const db2: DatabaseSyncType = new DatabaseSync(path);
    trackClose(() => db2.close());
    const store2 = createSqliteStore({ db: db2 });
    const repCapOf = (): Unit => 0.9 as Unit;
    const rep2 = createSqliteReputationLedger(repCapOf, { db: db2 });
    const ledger2 = createSqlitePendingLedger({ db: db2, reputation: rep2 });

    // The demotion survived: loser DEMOTED + outranked_by set; winner still LIVE.
    const loserAfter = store2.getStrand(loserId)!;
    expect(loserAfter.fact_state).toBe(FactState.DEMOTED);
    expect(loserAfter.outranked_by).not.toBeNull();
    expect(store2.getStrand(winnerId)!.fact_state).toBe(FactState.LIVE);

    // The OUTRANKS edge survived.
    const outranks = [...store2.allEdges()].filter((e) => e.edgeType === EdgeType.OUTRANKS);
    expect(outranks.length).toBe(1);
    expect(outranks[0]!.from).toBe(winnerId);
    expect(outranks[0]!.to).toBe(loserId);

    // The APPROVAL record survived AND the chain re-verifies (the record was
    // persisted in the SAME committed txn — no desync between audit + state).
    // The doorbell sequence (PENDING/APPROVAL) survived; the A1 latent MUTATION effect
    // leaves are additive (filter them out to recover the doorbell sequence).
    expect(ledger2.records().map((r) => r.kind).filter((k) => k !== "MUTATION")).toEqual([
      "PENDING",
      "APPROVAL",
    ]);
    expect(ledger2.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // The dispute is resolved (no longer open).
    expect(ledger2.listPending().length).toBe(0);

    // Reputation move survived: the loser's author was contradicted (the rep write
    // committed in the SAME atomic txn as the demotion it punishes). We resolve the
    // loser's author from the persisted strand and read the durable rep state.
    const loserAuthor = loserAfter.provenance.find((r) => r.sourceId !== null)?.sourceId;
    expect(loserAuthor).toBeDefined();
    expect(rep2.stateOf(loserAuthor!)?.contradictedCount ?? 0).toBeGreaterThanOrEqual(1);

    // Structural integrity holds after WAL recovery.
    expect(store2.integrityCheck()).toBe(true);
  });

  it("committed writeFacts survive an unclean reopen and stay recall-connected via the entity index", () => {
    const path = freshPath("writefact-crash");
    let a: StrandId;
    let b: StrandId;
    let c: StrandId;
    {
      const w = wire(path);
      const src = newSource(w);
      const stamp = w.identity.stampFor(src.sourceId);
      a = w.engine.writeFact({ entity: ENTITY, payload: { n: 1 }, stamp });
      b = w.engine.writeFact({ entity: ENTITY, payload: { n: 2 }, stamp });
      c = w.engine.writeFact({ entity: ENTITY, payload: { n: 3 }, stamp });
      // SIMULATED CRASH: abandon the handle (no clean close here).
    }

    const db2: DatabaseSyncType = new DatabaseSync(path);
    trackClose(() => db2.close());
    const store2 = createSqliteStore({ db: db2 });

    // SHARED_ENTITY is an INDEX, not a materialized clique: writeFact mints no
    // sibling edges (the O(N^2) mesh is gone), so the durable artifact is the ENTITY
    // INDEX. All three committed facts survived the unclean reopen (WAL recovery).
    expect(store2.strandsByEntity(ENTITY).map((s) => s.id).sort()).toEqual([a, b, c].sort());

    // INTENT preserved (durable recall connectivity): after the unclean reopen, a
    // recall seeded at `a` still lights `b` and `c` because the walk derives the
    // same-entity siblings from the (durable) entity index on the fly.
    const identity2 = createSourceIdentityLayer({
      sources: makeSourceRegistry(),
      anchors: makeAnchorRegistry(),
      reputation: { scoreOf: () => 0 as Unit },
      stake: { postedFor: () => 0 },
    });
    const engine2 = createIntelligentDb(store2, identity2);
    const result = engine2.recall({ seeds: [{ strandId: a, energy: 1 }] });
    const litIds = result.lit.map((l) => l.strandId);
    expect(litIds).toContain(a);
    expect(litIds).toContain(b);
    expect(litIds).toContain(c);

    expect(store2.integrityCheck()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. CORRUPTION DETECTION — integrity_check on a clean db; verifyChain on a torn one
// ---------------------------------------------------------------------------

describe("corruption detection — never silently served as correct", () => {
  it("integrityCheck() is true on a clean db after a committed compound op", () => {
    const path = freshPath("integrity-ok");
    const w = wire(path);
    const src = newSource(w);
    const stamp = w.identity.stampFor(src.sourceId);
    w.engine.writeFact({ entity: ENTITY, attribute: ATTR, payload: { v: "Germany" }, stamp });
    expect(w.store.integrityCheck()).toBe(true);
  });

  it("a flipped byte in a persisted audit row makes verifyChain() flag the broken seq", () => {
    const path = freshPath("integrity-tamper");
    const csid = "cset:tamper" as Parameters<IntelligentDb["approve"]>[0];
    const winnerId = asStrandId("strand:w");
    const loserId = asStrandId("strand:l");
    {
      const w = wire(path);
      const winnerSrc = newSource(w);
      const loserSrc = newSource(w);
      w.store.putStrand(makeStrand(winnerId, ENTITY, ATTR, winnerSrc.sourceId, "class:w"));
      w.store.putStrand(makeStrand(loserId, ENTITY, ATTR, loserSrc.sourceId, "class:l"));
      w.ratification.ledger.appendPending(
        {
          contradictionSetId: csid,
          attribute: ATTR,
          members: [winnerId, loserId],
          reason: "INDEPENDENT_DISPUTE",
          createdAt: NOW,
        },
        w.ratification.systemSource,
      );
      const approver = freshSource();
      w.sources.register(approver);
      // RC-5: priced, member-disjoint anchor (DOMAIN ⊥ the members' KYC anchors).
      w.anchors.bind(approver.sourceId, [domainAnchor()]);
      w.engine.approve(csid, winnerId, approver.sourceId, NOW);
      // Clean close so the WAL is checkpointed into the main file we then tamper.
      w.db.close();
    }

    // Reach into the raw file and flip a field inside the seq-1 (APPROVAL) record.
    const raw: DatabaseSyncType = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT json FROM ratification_records WHERE seq = 1")
      .get() as { json: string };
    const rec = JSON.parse(row.json) as { payload: { winner: string } };
    rec.payload.winner = "strand:TAMPERED";
    raw
      .prepare("UPDATE ratification_records SET json = ? WHERE seq = 1")
      .run(JSON.stringify(rec));
    raw.close();

    // Reopen through the durable ledger: the chain verifier catches it at seq 1.
    const db2: DatabaseSyncType = new DatabaseSync(path);
    trackClose(() => db2.close());
    const ledger2 = createSqlitePendingLedger({ db: db2 });
    const store2 = createSqliteStore({ db: db2 });
    const v = ledger2.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(1);
    // The structural integrity_check still passes (a valid row was rewritten with a
    // valid-but-wrong value): the SEMANTIC verifier — not integrity_check — is what
    // catches a content tamper. Both layers exist precisely because they catch
    // different damage; neither silently serves the tampered chain as correct.
    expect(store2.integrityCheck()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. TXN-DEPTH POISONING — commit-after-inner-rollback throws; the store is NOT
//    poisoned afterward (BEGIN is still really issued for later compound ops)
// ---------------------------------------------------------------------------
//
// THE BUG BEING PINNED: an inner handle's rollback() collapses #txnDepth to 0 and
// issues ROLLBACK; the old outer commit() then decremented depth to -1 (no COMMIT,
// reporting success on rolled-back work), and every subsequent beginTxn() saw
// depth !== 0 and never issued BEGIN again — so every later withTxn-wrapped
// compound op (adjudicate, approve, disown, writeFact, ratify) ran as N
// autocommitted writes with ZERO atomicity. The fix makes the stale outer commit
// THROW, and the next outermost beginTxn() opens a real transaction again.

describe("txn depth — commit after inner rollback throws and never poisons the store", () => {
  it("outer commit after an inner rollback throws; the write is absent; later compound ops still roll back atomically and then commit durably", () => {
    const path = freshPath("txn-poison");
    const w = wire(path);

    // --- (a) outer beginTxn → inner beginTxn → putStrand → inner rollback →
    //     outer commit THROWS, and the strand is ABSENT (really rolled back). ---
    const orphanId = asStrandId("strand:txn-orphan");
    const outer = w.store.beginTxn();
    const inner = w.store.beginTxn();
    w.store.putStrand(makeStrand(orphanId, ENTITY, ATTR, null, "class:orphan"));
    inner.rollback();
    expect(() => outer.commit()).toThrow(
      /commit after inner rollback: this unit of work was already rolled back/,
    );
    expect(w.store.getStrand(orphanId)).toBeNull();

    // --- (b) the store is NOT poisoned: a subsequent compound op with a forced
    //     mid-op throw STILL fully rolls back — proving beginTxn really issued a
    //     BEGIN (the pre-fix poisoned store would autocommit the first demotion
    //     and leave it standing). Same fixture as the adjudicate-rollback test:
    //     a high-rep incumbent + an anchor-disjoint corroborator + two fresh
    //     losers, and a putStrand that throws on the 2nd demotion write. ---
    const incumbent = newSource(w);
    for (let i = 0; i < 30; i++) w.reputation.ratify(incumbent.sourceId, NOW);
    const winnerId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Germany" },
      stamp: w.identity.stampFor(incumbent.sourceId),
    });
    const corroborator = freshSource();
    w.sources.register(corroborator);
    w.anchors.bind(corroborator.sourceId, [domainAnchor()]);
    w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Germany" },
      stamp: w.identity.stampFor(corroborator.sourceId),
    });
    const loserA = newSource(w);
    const loserB = newSource(w);
    const loserAId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Tokyo" },
      stamp: w.identity.stampFor(loserA.sourceId),
    });
    const loserBId = w.engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { capitalOf: "Paris" },
      stamp: w.identity.stampFor(loserB.sourceId),
    });

    const realPut = w.store.putStrand.bind(w.store);
    let demoteWrites = 0;
    w.store.putStrand = (s: Strand): void => {
      if (s.fact_state === FactState.DEMOTED) {
        demoteWrites++;
        if (demoteWrites === 2) {
          throw new Error("INJECTED mid-adjudication crash on the 2nd loser");
        }
      }
      realPut(s);
    };
    expect(() => w.engine.adjudicate(ATTR)).toThrow(/INJECTED/);
    w.store.putStrand = realPut;

    // FULL rollback — the un-poisoned proof: even the FIRST loser's demotion
    // (written before the throw) is gone, because it rode a real transaction.
    expect(w.store.getStrand(loserAId)!.fact_state).toBe(FactState.LIVE);
    expect(w.store.getStrand(loserBId)!.fact_state).toBe(FactState.LIVE);
    expect(
      [...w.store.allEdges()].filter((e) => e.edgeType === EdgeType.OUTRANKS).length,
    ).toBe(0);
    expect(w.store.integrityCheck()).toBe(true);

    // --- (c) a CLEAN compound op afterward genuinely commits… ---
    const redo = w.engine.adjudicate(ATTR);
    expect(redo.kind).toBe("RESOLVED");
    if (redo.kind === "RESOLVED") expect(redo.demotions.length).toBe(2);
    expect(w.store.getStrand(loserAId)!.fact_state).toBe(FactState.DEMOTED);
    expect(w.store.getStrand(loserBId)!.fact_state).toBe(FactState.DEMOTED);

    // …and SURVIVES an unclean reopen (WAL recovery) — the commit was real.
    const db2: DatabaseSyncType = new DatabaseSync(path);
    trackClose(() => db2.close());
    const store2 = createSqliteStore({ db: db2 });
    expect(store2.getStrand(loserAId)!.fact_state).toBe(FactState.DEMOTED);
    expect(store2.getStrand(loserBId)!.fact_state).toBe(FactState.DEMOTED);
    expect(store2.getStrand(winnerId)!.fact_state).toBe(FactState.LIVE);
    expect(store2.getStrand(orphanId)).toBeNull(); // the rolled-back write never landed
    expect(store2.integrityCheck()).toBe(true);
  });

  it("a stale outer commit landing after a fresh unit of work throws the distinct no-open-transaction message", () => {
    const path = freshPath("txn-stale-commit");
    const w = wire(path);

    // An inner rollback collapses the outer unit of work…
    const outer = w.store.beginTxn();
    const inner = w.store.beginTxn();
    inner.rollback();

    // …then a FRESH outermost unit of work opens (clearing the aborted flag),
    // writes, and commits cleanly — the store recovered exactly as designed.
    const survivorId = asStrandId("strand:txn-survivor");
    const fresh = w.store.beginTxn();
    w.store.putStrand(makeStrand(survivorId, ENTITY, ATTR, null, "class:survivor"));
    fresh.commit();
    expect(w.store.getStrand(survivorId)).not.toBeNull();

    // The STALE outer handle finally commits: nothing is open and its own unit of
    // work is long gone — loud, with the message distinct from the aborted case.
    expect(() => outer.commit()).toThrow(/commit with no open transaction/);
    expect(w.store.integrityCheck()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. OPEN-TIME GUARDS — journal-mode verification + the network-path refusal
// ---------------------------------------------------------------------------

describe("open-time guards — WAL verified on open; UNC paths refused by default", () => {
  it("journal-mode verification passes on a temp-file db (WAL took) and on :memory: (memory mode is legitimate)", () => {
    const path = freshPath("wal-verify");
    const fileStore = createSqliteStore(path); // throws if journal_mode were silently downgraded
    trackClose(() => fileStore.close());
    expect(fileStore.integrityCheck()).toBe(true);

    // The in-memory test substrate reports journal_mode "memory" — deliberately
    // accepted (non-durable BY DESIGN), so the guard must not break it.
    const memStore = createSqliteStore(":memory:");
    trackClose(() => memStore.close());
    expect(memStore.integrityCheck()).toBe(true);
  });

  it("a UNC-shaped path is rejected without allowNetworkPath (both \\\\ and // spellings)", () => {
    expect(() => createSqliteStore("\\\\server\\share\\memory.db")).toThrow(
      /network \(UNC\) path.*allowNetworkPath/s,
    );
    expect(() => createSqliteStore("//server/share/memory.db")).toThrow(
      /network \(UNC\) path.*allowNetworkPath/s,
    );
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeStrand(
  id: StrandId,
  entity: EntityId,
  attribute: AttributeKey | null,
  sourceId: SourceId | null,
  klass: string,
): Strand {
  return {
    id,
    entity,
    attribute,
    payload: { id: String(id) },
    content_hash: ("hash:" + String(id)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + String(id)) as Strand["provenance"][number]["rootId"],
        independenceClass: klass as Strand["provenance"][number]["independenceClass"],
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
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}
