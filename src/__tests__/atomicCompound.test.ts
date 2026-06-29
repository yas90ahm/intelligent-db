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
 *      signed APPROVAL record are ALL present and verifyChain() is ok.
 *   3. INTEGRITY / CORRUPTION: integrityCheck() true on a clean db; flip a byte in a
 *      persisted audit row -> verifyChain().ok === false naming the first broken seq.
 *
 * Temp db files live under os.tmpdir(); afterEach closes tracked handles and removes
 * the db + its WAL/SHM siblings (close-first is load-bearing on Windows).
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  createIntelligentDb,
  createSourceIdentityLayer,
  createSqliteStore,
  createSqliteReputationLedger,
  createSqlitePendingLedger,
  createStakeLedger,
  downstreamDisownSweep,
  generatePassport,
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
  EdgeId,
  EntityId,
  IntelligentDb,
  KeyPair,
  KeyRegistryPort,
  Passport,
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
  keys: KeyRegistryPort;
}

function wire(path: string): Wired {
  const db: DatabaseSyncType = new DatabaseSync(path);
  trackClose(() => db.close());

  const keys = makeKeyRegistry();
  const anchors = makeAnchorRegistry();
  const repCapOf = (s: SourceId): Unit => repCapFor([...anchors.anchorsOf(s)]);
  // Pin the decay-on-read clock to the test's logical NOW: the fixture earns at the
  // synthetic NOW, so reads at NOW are Δt=0 (the default Date.now() clock would treat
  // the gap to the real wall clock as dormancy and crater the pre-earned incumbent).
  const reputation = createSqliteReputationLedger(repCapOf, { db, clock: () => NOW });

  const reputationPort: ReputationLedgerPort = {
    scoreOf: (s: SourceId): Unit => reputation.scoreOf(s),
  };
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };

  const identity = createSourceIdentityLayer({
    keys,
    anchors,
    reputation: reputationPort,
    stake: stakePort,
  });

  const store = createSqliteStore({ db });
  const systemSigner = generatePassport();
  const ledger = createSqlitePendingLedger({ db, reputation });
  const ratification: RatificationDeps = { ledger, systemSigner };

  const engine = createIntelligentDb(store, identity, null, reputation, ratification);
  return { db, store, identity, reputation, ratification, engine, anchors, keys };
}

/** Register a fresh KYC-anchored source and return its passport + stamp. */
function newSource(w: Wired): { passport: KeyPair; sourceId: SourceId } {
  const passport = generatePassport();
  w.keys.register(passport);
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
    const corroborator = generatePassport();
    w.keys.register(corroborator);
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
});

// ---------------------------------------------------------------------------
// 2. COMMITTED COMPOUND OP SURVIVES A SIMULATED CRASH (reopen WITHOUT clean close)
// ---------------------------------------------------------------------------

describe("crash recovery — a committed compound op is fully present after an unclean reopen", () => {
  it("approve(): demotions + OUTRANKS edges + reputation + signed APPROVAL all survive WAL recovery", () => {
    const path = freshPath("approve-crash");

    // --- session 1: drive a full DEFERRED -> approve compound op, then SIMULATE A
    //     CRASH by abandoning the handle WITHOUT a clean store/ledger close. ---
    const winnerId = asStrandId("strand:winner");
    const loserId = asStrandId("strand:loser");
    const csid = "cset:berlin#capital_of" as Parameters<IntelligentDb["approve"]>[0];

    let approverPassport: KeyPair;
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

      // Queue the dispute as a signed PENDING record.
      w.ratification.ledger.appendPending(
        {
          contradictionSetId: csid,
          attribute: ATTR,
          members: [winnerId, loserId],
          reason: "INDEPENDENT_DISPUTE",
          createdAt: NOW,
        },
        w.ratification.systemSigner,
      );

      // A DISTINCT external approver resolves it (compound: APPROVAL append + demote +
      // OUTRANKS + reputation, all in ONE txn over the shared handle).
      approverPassport = generatePassport();
      w.keys.register(approverPassport);
      // RC-5: the approver needs a priced anchor (no anchor → no voice) that is
      // disjoint from the members' KYC anchors (DOMAIN ⊥ VERIFIED_HUMAN ⇒ independent).
      w.anchors.bind(approverPassport.sourceId, [domainAnchor()]);
      const resolved = w.engine.approve(csid, winnerId, approverPassport, NOW);
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

    // The signed APPROVAL record survived AND the chain re-verifies (signer key was
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
      keys: makeKeyRegistry(),
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
        w.ratification.systemSigner,
      );
      const approver = generatePassport();
      w.keys.register(approver);
      // RC-5: priced, member-disjoint anchor (DOMAIN ⊥ the members' KYC anchors).
      w.anchors.bind(approver.sourceId, [domainAnchor()]);
      w.engine.approve(csid, winnerId, approver, NOW);
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
    register: null,
  };
}
