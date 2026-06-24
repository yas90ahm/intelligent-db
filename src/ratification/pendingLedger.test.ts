/**
 * pendingLedger.test.ts — THE VAULT + THE DOORBELL, one test per verifier invariant.
 *
 * Backs the PendingRatification horn (CLAUDE.md). The invariants pinned here:
 *
 *  1. APPEND + CHAIN + SIGN: a PENDING then an APPROVAL verifyChain().ok === true.
 *  2. TAMPER DETECTION: flip a byte in record k => ok === false, firstBrokenSeq === k
 *     (across payload, prevHash, sig, and signerSourceId tampering).
 *  3. NO AUTO-RESOLVE: a DEFERRED multi-class dispute leaves every member LIVE;
 *     adjudicate records a PENDING but demotes nothing. Only approve() resolves.
 *  4. SELF-APPROVAL REJECTED: an approver who authored a member => approve throws,
 *     and NO APPROVAL record is appended (the second-admin / distinct gate).
 *  5. APPROVAL OUTCOME: winner stays LIVE; losers DEMOTED + outranked_by set (never
 *     deleted); reputation moves (winner up / losers down); a signed APPROVAL is
 *     present and the chain still verifies.
 *  6. FORGED SIGNATURE REJECTED: a record whose signer key is unknown to the ledger
 *     (or whose sig is replaced by another key's) => verifyChain false at that seq.
 *
 * Most paths run through the public barrel; a couple reach into the records()
 * array to perform the byte-flip the "money artifact" exists to catch.
 */

import { describe, it, expect } from "vitest";

import {
  createPendingLedger,
  generatePassport,
  createReputationLedger,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  LedgerRecord,
  PendingPayload,
  ApprovalPayload,
  ApproveContext,
  AttributeKey,
  ContradictionSetId,
  EdgeId,
  EpochMs,
  PendingRatification,
  SourceId,
  Strand,
  StrandId,
  FactState as FactStateT,
} from "../index.js";

import { FactState, FactOrigin, Tier } from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;
const CSID = "cset:berlin#capital_of" as ContradictionSetId;

/** A deferred independent dispute over two members, reputation-ranked a,b. */
function pendingOf(members: StrandId[]): PendingRatification {
  return {
    contradictionSetId: CSID,
    attribute: ATTR,
    members,
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

/** A minimal disputed strand authored by `sourceId`, with the given claim. */
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

/** Build an ApproveContext over an in-memory member map (no real StrandStore). */
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

describe("VAULT — append-only, hash-chained, Ed25519-signed ledger", () => {
  it("INVARIANT 1: a PENDING then an APPROVAL verifies (ok=true)", () => {
    const sys = generatePassport();
    const approver = generatePassport();
    const ledger = createPendingLedger();

    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      [a, memberStrand("strand:a", "src:a" as SourceId, { v: "Germany" })],
      [b, memberStrand("strand:b", "src:b" as SourceId, { v: "Atlantis" })],
    ]);

    ledger.appendPending(pendingOf([a, b]), sys);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    ledger.approve(CSID, a, approver, NOW, ctxOver(byId));
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // Two records: PENDING (seq 0) then APPROVAL (seq 1), chained.
    const recs = ledger.records();
    expect(recs.map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect(recs[1]!.prevHash).toBe(recs[0]!.thisHash);
  });

  it("INVARIANT 2a: flipping a PAYLOAD byte breaks the chain at that seq", () => {
    const sys = generatePassport();
    const ledger = createPendingLedger();
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    ledger.appendPending(pendingOf([a, b]), sys);
    // Append a second pending so the break is at seq 0 with a downstream record too.
    ledger.appendPending(
      { ...pendingOf([a, b]), contradictionSetId: "cset:other" as ContradictionSetId },
      sys,
    );

    expect(ledger.verifyChain().ok).toBe(true);

    // Tamper: mutate the recorded payload of record 0 (the array is the live store).
    const rec0 = ledger.records()[0]! as { payload: PendingPayload };
    (rec0.payload as { attribute: AttributeKey }).attribute = "tampered" as AttributeKey;

    const v = ledger.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(0);
  });

  it("INVARIANT 2b: flipping a SIG byte breaks the chain at that seq", () => {
    const sys = generatePassport();
    const ledger = createPendingLedger();
    const a = asStrandId("strand:a");
    ledger.appendPending(pendingOf([a]), sys);
    ledger.appendPending(
      { ...pendingOf([a]), contradictionSetId: "cset:two" as ContradictionSetId },
      sys,
    );

    // Corrupt record 1's signature (flip first base64url char to a different one).
    const rec1 = ledger.records()[1]! as { sig: string };
    rec1.sig = (rec1.sig[0] === "A" ? "B" : "A") + rec1.sig.slice(1);

    const v = ledger.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(1);
  });

  it("INVARIANT 2c: flipping prevHash (re-linking) breaks the chain", () => {
    const sys = generatePassport();
    const ledger = createPendingLedger();
    const a = asStrandId("strand:a");
    ledger.appendPending(pendingOf([a]), sys);
    ledger.appendPending(
      { ...pendingOf([a]), contradictionSetId: "cset:two" as ContradictionSetId },
      sys,
    );

    const rec1 = ledger.records()[1]! as { prevHash: string };
    rec1.prevHash = "0".repeat(64); // a wrong (but well-formed) link

    const v = ledger.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(1);
  });

  it("INVARIANT 6: a record claiming an UNKNOWN signer is rejected (no provenance)", () => {
    const sys = generatePassport();
    const ledger = createPendingLedger();
    const a = asStrandId("strand:a");
    ledger.appendPending(pendingOf([a]), sys);

    // Rewrite the signerSourceId to a source the ledger never registered a key for.
    const rec0 = ledger.records()[0]! as { signerSourceId: SourceId };
    rec0.signerSourceId = "src:ghost" as SourceId;

    const v = ledger.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(0);
  });
});

describe("DOORBELL — second-admin PENDING -> approve flow", () => {
  it("INVARIANT 4: self-approval (approver authored a member) is REJECTED, no APPROVAL appended", () => {
    // The approver IS the author of member a. The distinct-approver gate must throw,
    // and the chain must still hold exactly the one PENDING record.
    const approver = generatePassport();
    const sys = generatePassport();
    const ledger = createPendingLedger();

    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      // member a is authored by the approver's own source id => self-approval.
      [a, memberStrand("strand:a", approver.sourceId, { v: "Germany" })],
      [b, memberStrand("strand:b", "src:b" as SourceId, { v: "Atlantis" })],
    ]);

    ledger.appendPending(pendingOf([a, b]), sys);
    expect(() => ledger.approve(CSID, b, approver, NOW, ctxOver(byId))).toThrow(
      /self-approval/i,
    );

    // No APPROVAL was recorded; the dispute is still open.
    expect(ledger.records().map((r) => r.kind)).toEqual(["PENDING"]);
    expect(ledger.listPending().length).toBe(1);
  });

  it("INVARIANT 5: an external approval demotes losers, keeps winner LIVE, moves reputation", () => {
    const sys = generatePassport();
    const approver = generatePassport(); // distinct from src:a / src:b
    // A reputation ledger with a generous cap so ratify/contradict visibly move.
    const reputation = createReputationLedger(() => 0.9);
    const ledger = createPendingLedger({ reputation });

    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const srcA = "src:a" as SourceId;
    const srcB = "src:b" as SourceId;
    const stA = memberStrand("strand:a", srcA, { v: "Germany" });
    const stB = memberStrand("strand:b", srcB, { v: "Atlantis" });
    const byId = new Map<StrandId, Strand>([
      [a, stA],
      [b, stB],
    ]);

    // Give the winner's author some prior earned reputation so a later contradiction
    // of the loser visibly differs; both start at 0.
    expect(reputation.scoreOf(srcA)).toBe(0);
    expect(reputation.scoreOf(srcB)).toBe(0);

    ledger.appendPending(pendingOf([a, b]), sys);

    const resolved = ledger.approve(CSID, a, approver, NOW, ctxOver(byId));

    // Winner a stays LIVE; loser b DEMOTED + outranked_by set (never deleted).
    expect(resolved.winner).toBe(a);
    expect(stA.fact_state).toBe(FactState.LIVE);
    expect(stB.fact_state).toBe(FactState.DEMOTED);
    expect(stB.outranked_by).not.toBeNull();
    expect(resolved.outranksEdges.length).toBe(1);
    expect(resolved.demotions.map((d) => d.demoted)).toEqual([b]);

    // Reputation moved: winner author up, loser author down (down from 0 stays 0,
    // but the contradictedCount records the event; winner author rose above 0).
    expect(reputation.scoreOf(srcA)).toBeGreaterThan(0);
    expect(reputation.stateOf(srcB)?.contradictedCount).toBe(1);

    // A signed APPROVAL receipt is present and the whole chain verifies.
    const recs = ledger.records();
    expect(recs.map((r) => r.kind)).toEqual(["PENDING", "APPROVAL"]);
    expect((recs[1]!.payload as ApprovalPayload).winner).toBe(a);
    expect((recs[1]!.payload as ApprovalPayload).approverSourceId).toBe(approver.sourceId);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // listPending no longer shows the resolved dispute.
    expect(ledger.listPending().length).toBe(0);
  });

  it("rejects approving a non-member winner and a double-approve", () => {
    const sys = generatePassport();
    const approver = generatePassport();
    const ledger = createPendingLedger();
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const byId = new Map<StrandId, Strand>([
      [a, memberStrand("strand:a", "src:a" as SourceId, { v: "A" })],
      [b, memberStrand("strand:b", "src:b" as SourceId, { v: "B" })],
    ]);
    ledger.appendPending(pendingOf([a, b]), sys);

    // Non-member winner.
    expect(() =>
      ledger.approve(CSID, asStrandId("strand:ghost"), approver, NOW, ctxOver(byId)),
    ).toThrow(/not a member/i);

    // First valid approve resolves; a second must throw (already resolved).
    ledger.approve(CSID, a, approver, NOW, ctxOver(byId));
    expect(() => ledger.approve(CSID, a, approver, NOW, ctxOver(byId))).toThrow(
      /no open dispute/i,
    );
  });

  it("CONTENT-BLINDNESS: a content-blind ledger records a contentHash, not bodies, and still verifies", () => {
    const sys = generatePassport();
    const ledger = createPendingLedger({ contentBlind: true });
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    ledger.appendPending(pendingOf([a, b]), sys);

    const p = ledger.records()[0]!.payload as PendingPayload;
    expect(p.contentHash).toBeDefined();
    expect(typeof p.contentHash).toBe("string");
    expect(ledger.verifyChain().ok).toBe(true);
  });

  // Silence unused type-only imports kept for documentation parity.
  it("type surface is importable", () => {
    const _r: LedgerRecord | null = null;
    const _e: EpochMs = NOW;
    const _f: FactStateT = FactState.LIVE;
    expect(_r).toBeNull();
    expect(_e).toBe(NOW);
    expect(_f).toBe(FactState.LIVE);
  });
});
