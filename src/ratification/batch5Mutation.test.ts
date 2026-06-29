/**
 * batch5Mutation.test.ts — A1 (Merkle MUTATION coverage) + A2 (optional wiring).
 *
 * V2.md RC-8 / mk-m3 ("hide-a-disown") + mk-m4 ("unwired log"). The audit tree used to
 * commit ONLY doorbell traffic (PENDING/APPROVAL); the undo engine's EFFECT (disown
 * craters, demotions, reputation moves, reverse-credits) had NO leaf, so a disown could
 * be hidden with `verifyChain()` green. This batch journals every control-plane mutation
 * as a content-addressed MUTATION receipt and optionally wires a MerkleLog so a witness
 * detects the hidden disown.
 *
 * Matrix:
 *   1. LEDGER UNIT — appendMutation appends a MUTATION leaf, verifyChain stays ok, and a
 *      byte-flip in a MUTATION payload names its seq. MUTATION is inert to the doorbell.
 *   2. LEAF-CACHE — the incremental `#leaves` cache is byte-identical to a fresh log
 *      (the regression contract for the O(n²) anchor() fix).
 *   3. mk-m3 — a disown through the engine produces committed DISOWN_CRATER + DEMOTE
 *      leaves; a witness holding the post-disown STH detects a hidden (rolled-back) tree
 *      as ROLLBACK_OR_DELETION, while an honest extension witnesses ok.
 *   4. A2-OMITTED — with `ratification` but NO `merkle`: the verbs return null, no sink is
 *      written, the A1 MUTATION leaves are still present and verify.
 *
 * HONEST LIMIT (carried, not over-claimed): this is COVERAGE + WIRING. It does NOT close
 * mk-m2 (single signer can re-sign a coherent forged tree from genesis) or mk-m5 (no live
 * external witnesses — sinks are in-memory/SQLite test impls).
 */

import { describe, it, expect } from "vitest";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createStakeLedger,
  createPendingLedger,
  createReputationLedger,
  createMerkleLog,
  InMemoryPublicationSink,
  verifyInclusion,
  generatePassport,
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
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  Passport,
  Strand,
  Edge,
  PendingLedger,
  PendingRatification,
  LedgerRecord,
  MutationPayload,
  KeyPair,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts) ----------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register: (p: Passport) => void known.add(p.sourceId),
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
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };
  return createSourceIdentityLayer({
    keys: makeKeyRegistry(),
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

/** A read-only PendingLedger VIEW over a fixed record slice (the attacker's hidden tree). */
function ledgerView(records: readonly LedgerRecord[]): PendingLedger {
  const stub = (): never => {
    throw new Error("ledgerView: write op not supported on a read-only view");
  };
  return {
    records: () => records,
    appendPending: stub,
    appendMutation: stub,
    listPending: () => [],
    approve: stub,
    verifyChain: () => ({ ok: true, firstBrokenSeq: null }),
  } as unknown as PendingLedger;
}

// ---------------------------------------------------------------------------
// 1. LEDGER UNIT — appendMutation is a merkle-agnostic chain widening
// ---------------------------------------------------------------------------

describe("A1 — appendMutation widens the signed chain (merkle-agnostic)", () => {
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

  it("appendMutation appends a MUTATION leaf and verifyChain stays ok", () => {
    const signer = generatePassport();
    const ledger = createPendingLedger();
    ledger.appendMutation(mut("DISOWN_CRATER", 0), signer);
    ledger.appendMutation(mut("DEMOTE", 1), signer);
    expect(ledger.records().map((r) => r.kind)).toEqual(["MUTATION", "MUTATION"]);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // MUTATION is inert to the doorbell — never an open pending.
    expect(ledger.listPending()).toEqual([]);
  });

  it("a byte-flip in a MUTATION payload is named at its seq", () => {
    const signer = generatePassport();
    const ledger = createPendingLedger();
    ledger.appendMutation(mut("DISOWN_CRATER", 0), signer);
    ledger.appendMutation(mut("DEMOTE", 1), signer);
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
});

// ---------------------------------------------------------------------------
// 2. LEAF-CACHE — incremental #leaves is byte-identical (regression contract)
// ---------------------------------------------------------------------------

describe("A1 — the incremental leaf-cache is byte-identical to a fresh log", () => {
  it("a cached log's roots/proofs match a freshly-built log after incremental appends", () => {
    const signer = generatePassport();
    const ledger = createPendingLedger();
    const pendingOf = (n: number): PendingRatification => ({
      contradictionSetId: ("cset:" + n) as PendingRatification["contradictionSetId"],
      attribute: ATTR,
      members: [asStrandId("strand:" + n)],
      reason: "INDEPENDENT_DISPUTE",
      createdAt: NOW,
    });
    const sinks = [new InMemoryPublicationSink(), new InMemoryPublicationSink()];
    const cached = createMerkleLog({ ledger, signer, sinks });

    for (let i = 0; i < 9; i++) {
      // Mix doorbell + mutation records so the cache spans kinds.
      if (i % 2 === 0) ledger.appendPending(pendingOf(i), signer);
      else
        ledger.appendMutation(
          { op: "DEMOTE", subjectId: "s" + i, subjectHash: "h" + i, beforeHash: "b" + i, afterHash: "a" + i, at: NOW },
          signer,
        );
      // After each append, the cached root must equal a FRESH log's root (no cache drift).
      const fresh = createMerkleLog({ ledger, signer, sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()] });
      expect(cached.merkleRoot()).toBe(fresh.merkleRoot());
      // Every inclusion proof verifies against the live root, both logs agreeing.
      const root = cached.merkleRoot();
      for (let seq = 0; seq <= i; seq++) {
        const proof = cached.inclusionProof(seq);
        expect(verifyInclusion(cached.leafHashAt(seq), proof, root)).toBe(true);
        expect(fresh.inclusionProof(seq)).toEqual(proof);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. mk-m3 — a hidden disown is DETECTED by a witness; honest extension is ok
// ---------------------------------------------------------------------------

interface Engine {
  store: ReturnType<typeof createMemoryStore>;
  reputation: ReturnType<typeof createReputationLedger>;
  ledger: PendingLedger;
  signer: KeyPair;
  merkleSigner: KeyPair;
  db: ReturnType<typeof createIntelligentDb>;
  sinkA: InMemoryPublicationSink;
  sinkB: InMemoryPublicationSink;
}

function wireEngine(withMerkle: boolean): Engine {
  const store = createMemoryStore();
  const reputation = createReputationLedger(() => 0.9 as Unit);
  const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
  const ledger = createPendingLedger({ reputation });
  const signer = generatePassport();
  const merkleSigner = generatePassport();
  const sinkA = new InMemoryPublicationSink();
  const sinkB = new InMemoryPublicationSink();
  const db = createIntelligentDb(store, identity, null, reputation, {
    ledger,
    systemSigner: signer,
    ...(withMerkle ? { merkle: { signer: merkleSigner, sinks: [sinkA, sinkB] } } : {}),
  });
  return { store, reputation, ledger, signer, merkleSigner, db, sinkA, sinkB };
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

describe("mk-m3 — every trust mutation now has a committed Merkle leaf (hide-a-disown detected)", () => {
  it("disown produces DISOWN_CRATER + DEMOTE leaves; a hidden rollback is ROLLBACK_OR_DELETION", () => {
    const e = wireEngine(true);
    const { bad, derivedId } = seedDisownChain(e);

    // A2: publish the genesis STH to both sinks, then capture the PRE-disown record set
    // — the tree an attacker would roll back TO in order to hide the disown.
    expect(e.db.publishGenesis(NOW)).not.toBeNull();
    const preDisownRecords = [...e.ledger.records()];

    // The disown crater + demotion run as one atomic op and JOURNAL their effects.
    const result = e.db.disown(bad, { at: NOW });
    expect(result.seedClawedBack.length).toBeGreaterThan(0);
    expect(result.demotedDownstream).toContain(derivedId);

    // (1) Committed MUTATION leaves exist for the crater AND the demotion.
    const kinds = e.ledger.records().filter((r) => r.kind === "MUTATION");
    const ops = kinds.map((r) => (r.payload as MutationPayload).op);
    expect(ops).toContain("DISOWN_CRATER");
    expect(ops).toContain("DEMOTE");
    expect(e.ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // (2) anchorEpoch publishes the post-disown STH to BOTH sinks.
    const sth = e.db.anchorEpoch(NOW);
    expect(sth).not.toBeNull();
    expect(e.sinkA.latest()!.tree_size).toBe(e.ledger.records().length);
    expect(e.sinkB.latest()!.tree_size).toBe(e.ledger.records().length);

    // Honest paired assert (no false positive): the live tree extends the witness's STH.
    const honest = e.db.merkleLog()!.witness(e.sinkA, NOW);
    expect(honest.ok).toBe(true);
    expect(honest.reason).toBe("OK");

    // (3) HIDE THE DISOWN: the operator presents the PRE-disown tree (the mutation leaves
    // dropped). A witness holding the post-disown STH₁ checks that hidden tree and the
    // prior STH cannot be extended → ROLLBACK_OR_DELETION.
    const hiddenLog = createMerkleLog({
      ledger: ledgerView(preDisownRecords),
      signer: e.merkleSigner, // the operator re-signs with the SAME log key (mk-m2 residual)
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    });
    const caught = hiddenLog.witness(e.sinkA, NOW);
    expect(caught.ok).toBe(false);
    expect(caught.reason).toBe("ROLLBACK_OR_DELETION");

    // (4) The disown leaf has an O(log n) inclusion proof against the published root.
    const craterSeq = e.ledger
      .records()
      .findIndex((r) => r.kind === "MUTATION" && (r.payload as MutationPayload).op === "DISOWN_CRATER");
    const log = e.db.merkleLog()!;
    const proof = log.inclusionProof(craterSeq);
    expect(verifyInclusion(log.leafHashAt(craterSeq), proof, sth!.root)).toBe(true);
    // O(log n): proof path length is bounded by ceil(log2(treeSize)).
    expect(proof.path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(e.ledger.records().length)) + 1);
  });
});

// ---------------------------------------------------------------------------
// 4. A2-OMITTED — latent A1 journaling stays on; verbs return null; no sinks
// ---------------------------------------------------------------------------

describe("A2 omitted — back-compatible: null verbs, no sinks, latent A1 leaves present", () => {
  it("anchorEpoch / publishGenesis / merkleLog return null; disown still journals MUTATION leaves", () => {
    const e = wireEngine(false);
    const { bad, derivedId } = seedDisownChain(e);

    expect(e.db.merkleLog()).toBeNull();
    expect(e.db.anchorEpoch(NOW)).toBeNull();
    expect(e.db.publishGenesis(NOW)).toBeNull();

    const result = e.db.disown(bad, { at: NOW });
    expect(result.demotedDownstream).toContain(derivedId);

    // The A1 latent coverage is present even with no merkle layer: the MUTATION leaves
    // are in the chain and verify (a witness can attach later — V2.md).
    const ops = e.ledger
      .records()
      .filter((r) => r.kind === "MUTATION")
      .map((r) => (r.payload as MutationPayload).op);
    expect(ops).toContain("DISOWN_CRATER");
    expect(ops).toContain("DEMOTE");
    expect(e.ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // No sink was ever touched (no STH exists).
    expect(e.sinkA.latest()).toBeNull();
    expect(e.sinkB.latest()).toBeNull();
  });

  it("an engine with NO ratification at all has no merkle layer and journals nothing", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9 as Unit);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const db = createIntelligentDb(store, identity, null, reputation);
    expect(db.merkleLog()).toBeNull();
    expect(db.anchorEpoch(NOW)).toBeNull();
    expect(db.publishGenesis(NOW)).toBeNull();
  });
});
