/**
 * batch5Mutation.test.ts — A1 (MUTATION audit coverage).
 *
 * V2.md RC-8 / "hide-a-disown". The audit chain used to commit ONLY doorbell traffic
 * (PENDING/APPROVAL); the undo engine's EFFECT (disown craters, demotions, reputation
 * moves, reverse-credits) had NO record, so a disown could be hidden with
 * `verifyChain()` green. This batch journals every control-plane mutation as a
 * content-addressed MUTATION receipt in the tamper-evident checksum chain.
 *
 * Matrix:
 *   1. LEDGER UNIT — appendMutation appends a MUTATION record, verifyChain stays ok,
 *      and a byte-flip in a MUTATION payload names its seq. MUTATION is inert to the
 *      doorbell.
 *   2. EFFECT COVERAGE — a disown through the engine produces committed
 *      DISOWN_CRATER + DEMOTE records in the chain, which verifies end-to-end; the
 *      chainHead() checkpoint advances past them (the artifact an operator exports
 *      to access-segregated storage — see pendingLedger.ts's honest disclosure).
 *
 * HONEST LIMIT (carried, not over-claimed): this is COVERAGE. The checksum chain
 * proves internal consistency AS STORED; an actor with live write access can rewrite
 * and re-checksum history. Insider-tamper evidence comes from shipping chainHead()
 * checkpoints to storage the writing process cannot reach.
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  independenceBetween,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
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
  Edge,
  PendingLedger,
  LedgerRecord,
  MutationPayload,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts) ----------------

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register: (p: SourceRef) => void known.add(p.sourceId),
    sourceIdOf: (s: SourceId) => (known.has(s) ? s : null),
    has: (s: SourceId) => known.has(s),
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind: (s, anchors) => void book.set(s, [...(book.get(s) ?? []), ...anchors]),
    anchorsOf: (s) => book.get(s) ?? [],
    aggregateCost: (anchors) => {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween: (a, b) => independenceBetween([...a], [...b]),
  };
}

function makeIdentity(reputation: ReputationLedgerPort): SourceIdentityLayer {
  // Staking is RETIRED (attribution replaces stake): a constant-zero port.
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

/** File an OBSERVED strand authored by `sourceId` in independence class `cls`. */
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
    content_hash: ("hash:" + idRaw) as Strand["content_hash"],
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

/** A DERIVATION edge derived -> witness (derived rested on witness). */
function derivationEdge(derived: StrandId, witness: StrandId): Edge {
  return {
    id: asEdgeId(`edge:der:${String(derived)}->${String(witness)}`),
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

type StrandId = ReturnType<typeof asStrandId>;

// ---------------------------------------------------------------------------
// 1. LEDGER UNIT — appendMutation is a plain chain widening
// ---------------------------------------------------------------------------

describe("A1 — appendMutation widens the checksum chain", () => {
  function mut(op: MutationPayload["op"], n: number): MutationPayload {
    return {
      op,
      subjectId: "subj:" + n,
      subjectHash: "sh:" + n,
      beforeHash: "bh:" + n,
      afterHash: "ah:" + n,
      at: NOW,
    };
  }

  it("appendMutation appends a MUTATION record and verifyChain stays ok", () => {
    const signer = freshSource();
    const ledger = createPendingLedger();
    ledger.appendMutation(mut("DISOWN_CRATER", 0), signer.sourceId);
    ledger.appendMutation(mut("DEMOTE", 1), signer.sourceId);
    expect(ledger.records().map((r) => r.kind)).toEqual(["MUTATION", "MUTATION"]);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // MUTATION is inert to the doorbell — never an open pending.
    expect(ledger.listPending()).toEqual([]);
  });

  it("a byte-flip in a MUTATION payload is named at its seq", () => {
    const signer = freshSource();
    const ledger = createPendingLedger();
    ledger.appendMutation(mut("DISOWN_CRATER", 0), signer.sourceId);
    ledger.appendMutation(mut("DEMOTE", 1), signer.sourceId);
    // Mutate the stored payload of seq 1 in place (the chain array is the source).
    const recs = ledger.records() as LedgerRecord[];
    (recs[1] as { payload: MutationPayload }).payload = {
      ...(recs[1]!.payload as MutationPayload),
      afterHash: "ah:TAMPERED",
    };
    const v = ledger.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(1);
  });

  it("chainHead() is the exported checkpoint: genesis-anchored when empty, the last record's checksum otherwise", () => {
    const signer = freshSource();
    const ledger = createPendingLedger();
    const empty = ledger.chainHead();
    expect(empty.seq).toBe(-1); // genesis anchor — nothing appended yet
    ledger.appendMutation(mut("DISOWN_CRATER", 0), signer.sourceId);
    const one = ledger.chainHead();
    expect(one.seq).toBe(0);
    expect(one.headHash).toBe(ledger.records()[0]!.thisHash);
    expect(one.headHash).not.toBe(empty.headHash);
  });
});

// ---------------------------------------------------------------------------
// 2. EFFECT COVERAGE — a disown's effects earn committed chain records
// ---------------------------------------------------------------------------

interface Engine {
  store: ReturnType<typeof createMemoryStore>;
  reputation: ReturnType<typeof createReputationLedger>;
  ledger: PendingLedger;
  systemSource: SourceId;
  db: ReturnType<typeof createIntelligentDb>;
}

function wireEngine(): Engine {
  const store = createMemoryStore();
  const reputation = createReputationLedger(() => 0.9 as Unit);
  const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
  const ledger = createPendingLedger({ reputation });
  const systemSource = freshSource().sourceId;
  const db = createIntelligentDb(store, identity, null, reputation, {
    ledger,
    systemSource,
  });
  return { store, reputation, ledger, systemSource, db };
}

/** Seed a disownable chain: a SEED strand (bad source) + a DERIVED child resting on it. */
function seedDisownChain(e: Engine): { bad: SourceId; seedId: StrandId; derivedId: StrandId } {
  const bad = ("src:bad") as SourceId;
  // The SEED is authored by the disowned source; the DERIVED child is authored by a
  // DIFFERENT source but RESTS ON the seed via a DERIVATION edge (so it is downstream
  // taint, not part of the seed). Its existence rests on tainted input ⇒ demoted.
  const seed = fileStrand(e.store, "strand:seed", bad, "class:bad", { v: "Germany" });
  const derived = fileStrand(e.store, "strand:derived", "src:downstream" as SourceId, "class:down", {
    v: "derived",
  });
  e.store.putEdge(derivationEdge(derived.id, seed.id));
  // Earn the bad source reputation so a crater is observable.
  for (let i = 0; i < 6; i++) e.reputation.ratify(bad, NOW);
  return { bad, seedId: seed.id, derivedId: derived.id };
}

describe("A1 — every trust mutation earns a committed chain record (hide-a-disown coverage)", () => {
  it("disown journals DISOWN_CRATER + DEMOTE records; the chain verifies and the checkpoint advances past them", () => {
    const e = wireEngine();
    const { bad, derivedId } = seedDisownChain(e);

    // Capture the PRE-disown checkpoint — the head an operator would have exported
    // to external storage before the sweep.
    const preHead = e.ledger.chainHead();
    const preLen = e.ledger.records().length;

    // The disown crater + demotion run as one atomic op and JOURNAL their effects.
    const result = e.db.disown(bad, { at: NOW });
    expect(result.seedClawedBack.length).toBeGreaterThan(0);
    expect(result.demotedDownstream).toContain(derivedId);

    // (1) Committed MUTATION records exist for the crater AND the demotion.
    const kinds = e.ledger.records().filter((r) => r.kind === "MUTATION");
    const ops = kinds.map((r) => (r.payload as MutationPayload).op);
    expect(ops).toContain("DISOWN_CRATER");
    expect(ops).toContain("DEMOTE");
    expect(e.ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // (2) The checkpoint ADVANCED past the disown's records: an operator holding the
    // exported post-disown head can prove a later chain that lacks these records (a
    // hide-the-disown rollback) is a rewrite — its head at this seq cannot match.
    const postHead = e.ledger.chainHead();
    expect(e.ledger.records().length).toBeGreaterThan(preLen);
    expect(postHead.seq).toBeGreaterThan(preHead.seq);
    expect(postHead.headHash).toBe(e.ledger.records()[postHead.seq]!.thisHash);
    expect(postHead.headHash).not.toBe(preHead.headHash);
  });

  it("an engine with NO ratification wired journals nothing (nowhere to journal)", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9 as Unit);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const db = createIntelligentDb(store, identity, null, reputation);
    const bad = "src:bad" as SourceId;
    fileStrand(store, "strand:seed", bad, "class:bad", { v: "Germany" });
    for (let i = 0; i < 3; i++) reputation.ratify(bad, NOW);
    const result = db.disown(bad, { at: NOW });
    expect(result.seedClawedBack.length).toBeGreaterThan(0); // the sweep still runs
  });
});
