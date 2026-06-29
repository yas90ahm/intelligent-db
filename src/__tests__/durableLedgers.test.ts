/**
 * durableLedgers.test.ts — proves the THREE trust + audit ledgers are DURABLE
 * (SQLite-backed) and that the audit chain stays tamper-evident across a restart.
 *
 * Tick-2 hardening: tick 1 made FACTS persist; the TRUST + AUDIT state was still
 * in-memory and lost on restart. These tests pin that the SQLite drop-ins behind the
 * EXISTING interfaces survive a close + reopen:
 *
 *   1. REPUTATION: earn via ratify, close, reopen on the SAME path, scoreOf / stateOf
 *      unchanged; the disown idempotency set is durable.
 *   2. CORROBORATION: record events + markReversed one, reopen, all() order +
 *      eventsIntersecting + isReversed survive; a minted `corrob:<seq>` continues
 *      from the persisted count.
 *   3. RATIFICATION (THE AUDIT TRAIL): appendPending + approve, verifyChain ok=true,
 *      close + reopen, verifyChain STILL ok=true on the untampered chain, then flip a
 *      byte in a PERSISTED row -> verifyChain ok=false naming that seq.
 *   4. END-TO-END RESTART over ONE SHARED db handle (facts + trust + audit in one
 *      crash-consistent file): drive rep + a corroboration event + a full approve,
 *      close everything, reopen, confirm the FULL picture is intact and verifiable.
 *
 * Temp db files live under os.tmpdir(); afterEach removes the db plus its WAL/SHM
 * siblings (close-first is load-bearing on Windows: an open handle blocks deletion).
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
  createSqliteReputationLedger,
  createSqliteCorroborationLedger,
  createSqlitePendingLedger,
  generatePassport,
  FactState,
  FactOrigin,
  Tier,
} from "../index.js";

import type {
  ApproveContext,
  AttributeKey,
  ContradictionSetId,
  EdgeId,
  EpochMs,
  PendingPayload,
  PendingRatification,
  SourceId,
  Strand,
  StrandId,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;
const CSID = "cset:berlin#capital_of" as ContradictionSetId;

// --- temp db lifecycle ------------------------------------------------------

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-durable-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

/** Track a close() so afterEach always releases the handle before unlinking. */
function track<T extends { close(): void }>(x: T): T {
  closers.push(() => {
    try {
      x.close();
    } catch {
      // already closed by the test (reopen cases close their own handles)
    }
  });
  return x;
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

// --- fixtures (mirror pendingLedger.test.ts) --------------------------------

function pendingOf(members: StrandId[]): PendingRatification {
  return {
    contradictionSetId: CSID,
    attribute: ATTR,
    members,
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

function memberStrand(idRaw: string, sourceId: SourceId | null, payload: unknown): Strand {
  return {
    id: asStrandId(idRaw),
    entity: "entity:berlin" as Strand["entity"],
    attribute: ATTR,
    payload,
    content_hash: ("hash:" + idRaw) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: ("root:" + idRaw) as Strand["provenance"][number]["rootId"],
        independenceClass: ("class:" + idRaw) as Strand["provenance"][number]["independenceClass"],
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

function ctxOver(byId: Map<StrandId, Strand>): ApproveContext {
  return {
    authorsOf(memberId: StrandId): readonly SourceId[] {
      const s = byId.get(memberId);
      if (s === undefined) return [];
      const out: SourceId[] = [];
      for (const r of s.provenance) if (r.sourceId !== null) out.push(r.sourceId);
      return out;
    },
    memberStrand(memberId: StrandId): Strand {
      const s = byId.get(memberId);
      if (s === undefined) throw new Error("no member " + String(memberId));
      return s;
    },
    mintEdgeId(winner: StrandId, loser: StrandId): EdgeId {
      return ("edge:outranks:" + String(winner) + "->" + String(loser)) as EdgeId;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Reputation survives reopen
// ---------------------------------------------------------------------------

describe("SqliteReputationLedger — scores survive a restart", () => {
  it("earn via ratify, close, reopen: scoreOf / stateOf unchanged", () => {
    const path = freshPath("rep");
    const src = "src:domain" as SourceId;
    const repCap = (): Unit => 0.6 as Unit;
    // Pin the decay-on-read clock to the test's logical NOW so the before/after-reopen
    // readouts are deterministic (the source earned AT NOW; the default Date.now() clock
    // would decay each read to a slightly different wall instant, breaking the 12-dp
    // round-trip equality this durability test asserts).
    const clock = (): EpochMs => NOW;

    const led = track(createSqliteReputationLedger(repCap, { path, clock }));
    // Earn some reputation across several ratifications.
    led.ratify(src, NOW);
    led.ratify(src, NOW);
    led.ratify(src, NOW);
    const earned = led.scoreOf(src);
    const stateBefore = led.stateOf(src)!;
    expect(earned).toBeGreaterThan(0);
    expect(stateBefore.ratifiedCount).toBe(3);

    led.close();

    // Simulated restart: a brand-new ledger on the SAME path.
    const reopened = track(createSqliteReputationLedger(repCap, { path, clock }));
    expect(reopened.scoreOf(src)).toBeCloseTo(earned, 12);
    const stateAfter = reopened.stateOf(src)!;
    expect(stateAfter.score).toBeCloseTo(stateBefore.score, 12);
    expect(stateAfter.ratifiedCount).toBe(3);
    expect(stateAfter.contradictedCount).toBe(0);

    // A fresh, never-seen source still reads 0 after reopen.
    expect(reopened.scoreOf("src:ghost" as SourceId)).toBe(0);
  });

  it("disown idempotency set is durable across reopen", () => {
    const path = freshPath("rep-disown");
    const src = "src:bad" as SourceId;
    const led = track(createSqliteReputationLedger(() => 0.6 as Unit, { path }));

    led.ratify(src, NOW); // earn something to crater
    expect(led.scoreOf(src)).toBeGreaterThan(0);
    const first = led.disownSweep(src, [asStrandId("s1"), asStrandId("s1"), asStrandId("s2")]);
    expect(first.clawedBack.map((x) => String(x)).sort()).toEqual(["s1", "s2"]); // deduped
    expect(led.scoreOf(src)).toBe(0); // cratered to floor

    led.close();

    // After reopen, a SECOND sweep of the same source is a durable no-op.
    const reopened = track(createSqliteReputationLedger(() => 0.6 as Unit, { path }));
    expect(reopened.scoreOf(src)).toBe(0);
    const second = reopened.disownSweep(src, [asStrandId("s3")]);
    expect(second.clawedBack).toEqual([]); // already disowned => no-op
  });
});

// ---------------------------------------------------------------------------
// 2. Corroboration events + reversed set survive reopen
// ---------------------------------------------------------------------------

describe("SqliteCorroborationLedger — events + reversed set survive a restart", () => {
  it("record two events, markReversed one, reopen: all / intersecting / isReversed intact", () => {
    const path = freshPath("corrob");
    const led = track(createSqliteCorroborationLedger({ path }));

    const e0 = led.record({
      ratifiedStrandId: asStrandId("r0"),
      corroboratingStrandIds: [asStrandId("c0"), asStrandId("cShared")],
      beneficiarySourceId: "src:b0" as SourceId,
      reputationDelta: 0.05,
      at: NOW,
    });
    const e1 = led.record({
      ratifiedStrandId: asStrandId("r1"),
      corroboratingStrandIds: [asStrandId("cShared")],
      beneficiarySourceId: "src:b1" as SourceId,
      reputationDelta: 0.03,
      at: NOW,
    });
    expect(e0.eventId).toBe("corrob:0");
    expect(e1.eventId).toBe("corrob:1");

    expect(led.markReversed(e0.eventId)).toBe(true);
    expect(led.markReversed(e0.eventId)).toBe(false); // idempotent

    led.close();

    const reopened = track(createSqliteCorroborationLedger({ path }));

    // Append order preserved.
    expect(reopened.all().map((e) => e.eventId)).toEqual(["corrob:0", "corrob:1"]);
    // Full event shape round-tripped.
    const got0 = reopened.all()[0]!;
    expect(got0.beneficiarySourceId).toBe("src:b0");
    expect(got0.reputationDelta).toBe(0.05);
    expect(got0.corroboratingStrandIds.map((x) => String(x))).toEqual(["c0", "cShared"]);

    // Intersection query against the tainted strand set, in stable append order.
    const hit = reopened.eventsIntersecting([asStrandId("cShared")]);
    expect(hit.map((e) => e.eventId)).toEqual(["corrob:0", "corrob:1"]);
    expect(reopened.eventsByCorroboratingStrand(asStrandId("c0")).map((e) => e.eventId)).toEqual([
      "corrob:0",
    ]);

    // Reversed set survived.
    expect(reopened.isReversed("corrob:0")).toBe(true);
    expect(reopened.isReversed("corrob:1")).toBe(false);
    expect(reopened.markReversed("corrob:0")).toBe(false); // still reversed after reopen

    // A newly minted id continues from the persisted count (no collision).
    const e2 = reopened.record({
      ratifiedStrandId: asStrandId("r2"),
      corroboratingStrandIds: [asStrandId("c2")],
      beneficiarySourceId: "src:b2" as SourceId,
      reputationDelta: 0.01,
      at: NOW,
    });
    expect(e2.eventId).toBe("corrob:2");
  });
});

// ---------------------------------------------------------------------------
// 3. Ratification audit chain survives reopen AND stays tamper-evident
// ---------------------------------------------------------------------------

describe("SqlitePendingLedger — audit chain survives a restart and stays tamper-evident", () => {
  function drive(path: string): { a: StrandId; b: StrandId } {
    const sys = generatePassport();
    const approver = generatePassport();
    const led = track(createSqlitePendingLedger({ path }));

    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      [a, memberStrand("strand:a", "src:a" as SourceId, { v: "Germany" })],
      [b, memberStrand("strand:b", "src:b" as SourceId, { v: "Atlantis" })],
    ]);

    led.appendPending(pendingOf([a, b]), sys);
    led.approve(CSID, a, approver, NOW, ctxOver(byId));
    expect(led.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    led.close();
    return { a, b };
  }

  it("verifyChain ok=true after close + reopen on the untampered chain", () => {
    const path = freshPath("chain-ok");
    drive(path);

    const reopened = track(createSqlitePendingLedger({ path }));
    // Two records persisted, in chain order, and the whole chain re-verifies with
    // an EMPTY process memory (signer keys were persisted in signer_keys).
    expect(reopened.records().map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(reopened.records()[1]!.prevHash).toBe(reopened.records()[0]!.thisHash);
    expect(reopened.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });

  it("tamper a PERSISTED row after reopen -> verifyChain ok=false naming that seq", () => {
    const path = freshPath("chain-tamper");
    drive(path);

    // Reach into the raw db file and flip a byte inside the seq-1 record's payload.
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => DatabaseSyncType;
    };
    const raw: DatabaseSyncType = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT json FROM ratification_records WHERE seq = 1")
      .get() as { json: string };
    const rec = JSON.parse(row.json) as { payload: { winner: string } };
    // Mutate the APPROVAL winner — a field inside the canonical hash preimage.
    rec.payload.winner = "strand:TAMPERED";
    raw
      .prepare("UPDATE ratification_records SET json = ? WHERE seq = 1")
      .run(JSON.stringify(rec));
    raw.close();

    // Reopen through the durable ledger and verify the tamper is caught at seq 1.
    const reopened = track(createSqlitePendingLedger({ path }));
    const v = reopened.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(1);
  });

  it("listPending reflects the persisted state after reopen", () => {
    const path = freshPath("chain-pending");
    const sys = generatePassport();
    const led = track(createSqlitePendingLedger({ path }));
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    led.appendPending(pendingOf([a, b]), sys);
    led.close();

    const reopened = track(createSqlitePendingLedger({ path }));
    const open = reopened.listPending();
    expect(open.length).toBe(1);
    expect((open[0] as PendingPayload).contradictionSetId).toBe(CSID);
  });

  it("OD-2 (SQLite path): cross-attribute dedup + per-source cap bound the durable horn; chain stays verifiable", () => {
    const path = freshPath("od2-bound");
    const sys = generatePassport();
    const led = track(createSqlitePendingLedger({ path }));
    const S = "src:attacker" as SourceId;
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");

    // First dispute appends.
    const first = led.appendPending(
      { ...pendingOf([a, b]), contradictionSetId: "cset:od2-1" as ContradictionSetId, attribute: "attr#1" as AttributeKey },
      sys,
      { disputingSources: [S], coalesceKey: "DUP", perSourceCap: 2 },
    );
    expect(led.records().length).toBe(1);

    // Same coalesce key across a DIFFERENT attribute ⇒ no-op returning the existing record.
    const dup = led.appendPending(
      { ...pendingOf([a, b]), contradictionSetId: "cset:od2-2" as ContradictionSetId, attribute: "attr#2" as AttributeKey },
      sys,
      { disputingSources: [S], coalesceKey: "DUP", perSourceCap: 2 },
    );
    expect(dup.seq).toBe(first.seq);
    expect(led.records().length).toBe(1); // chain NOT advanced

    // A distinct dispute naming S still appends (1 -> 2)...
    led.appendPending(
      { ...pendingOf([a, b]), contradictionSetId: "cset:od2-3" as ContradictionSetId, attribute: "attr#3" as AttributeKey },
      sys,
      { disputingSources: [S], coalesceKey: "K3", perSourceCap: 2 },
    );
    expect(led.records().length).toBe(2);

    // ...but the per-source cap (2) now rejects a further pending naming S (no-op).
    led.appendPending(
      { ...pendingOf([a, b]), contradictionSetId: "cset:od2-4" as ContradictionSetId, attribute: "attr#4" as AttributeKey },
      sys,
      { disputingSources: [S], coalesceKey: "K4", perSourceCap: 2 },
    );
    expect(led.records().length).toBe(2);
    expect(led.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // The bound survives a close + reopen (the dedup/cap fields persisted in the JSON blob).
    led.close();
    const reopened = track(createSqlitePendingLedger({ path }));
    expect(reopened.records().length).toBe(2);
    expect(reopened.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end "restart": all three ledgers over ONE SHARED db handle
// ---------------------------------------------------------------------------

describe("END-TO-END restart — facts/trust/audit in ONE crash-consistent file", () => {
  it("drive rep + corroboration + a full approve, close everything, reopen: full picture intact", () => {
    const path = freshPath("e2e");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => DatabaseSyncType;
    };

    const srcA = "src:a" as SourceId;
    const srcB = "src:b" as SourceId;
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");

    // Pin the decay-on-read clock to NOW so the before/after-reopen score round-trip is
    // deterministic (the credit is earned at NOW; a wall-clock read would differ per call).
    const pinned = (): EpochMs => NOW;

    // --- session 1: one shared handle backs all three ledgers (one db file) ---
    const db1: DatabaseSyncType = new DatabaseSync(path);
    const rep1 = createSqliteReputationLedger(() => 0.9 as Unit, { db: db1, clock: pinned });
    const corrob1 = createSqliteCorroborationLedger({ db: db1 });
    const ledger1 = createSqlitePendingLedger({ db: db1, reputation: rep1 });

    // Drive a corroboration event (trust substrate).
    corrob1.record({
      ratifiedStrandId: a,
      corroboratingStrandIds: [b],
      beneficiarySourceId: srcA,
      reputationDelta: 0.07,
      at: NOW,
    });

    // Drive a full dispute -> approve (audit + reputation move through the SAME rep1).
    const sys = generatePassport();
    const approver = generatePassport();
    const byId = new Map<StrandId, Strand>([
      [a, memberStrand("strand:a", srcA, { v: "Germany" })],
      [b, memberStrand("strand:b", srcB, { v: "Atlantis" })],
    ]);
    ledger1.appendPending(pendingOf([a, b]), sys);
    ledger1.approve(CSID, a, approver, NOW, ctxOver(byId));

    const scoreABefore = rep1.scoreOf(srcA);
    expect(scoreABefore).toBeGreaterThan(0); // winner author ratified
    expect(rep1.stateOf(srcB)?.contradictedCount).toBe(1); // loser author contradicted
    expect(ledger1.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    db1.close(); // close everything (one handle, one file)

    // --- session 2: reopen the SAME file; confirm scores + events + chain intact ---
    const db2: DatabaseSyncType = new DatabaseSync(path);
    const rep2 = createSqliteReputationLedger(() => 0.9 as Unit, { db: db2, clock: pinned });
    const corrob2 = createSqliteCorroborationLedger({ db: db2 });
    const ledger2 = createSqlitePendingLedger({ db: db2, reputation: rep2 });

    // Reputation survived (winner up, loser contradicted).
    expect(rep2.scoreOf(srcA)).toBeCloseTo(scoreABefore, 12);
    expect(rep2.stateOf(srcB)?.contradictedCount).toBe(1);

    // Corroboration event survived.
    expect(corrob2.all().map((e) => e.eventId)).toEqual(["corrob:0"]);
    expect(corrob2.eventsIntersecting([b]).map((e) => e.eventId)).toEqual(["corrob:0"]);

    // Audit chain survived AND re-verifies, and the dispute is resolved.
    expect(ledger2.records().map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(ledger2.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    expect(ledger2.listPending().length).toBe(0);

    db2.close();
  });
});
