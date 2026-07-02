/**
 * relayFix.test.ts — ADVERSARIAL regression suite for the RELAY FIX (CausalOrigin).
 *
 * THE BUG BEING PINNED: `provenanceRootFromStamp` mints `class:${source_id}` from
 * the FILING agent's identity alone, so when agent A researches a fact and agent B
 * re-files what A told it in-context, the web minted TWO independence classes for
 * ONE relayed observation — manufactured corroboration with zero attacker. The fix:
 * `WriteFactInput.causalOrigin` lets the write path derive the class from where the
 * observation ACTUALLY came from (`TOOL_CALL`/`DOCUMENT` ⇒ a deterministic
 * per-resource class; `AGENT_RELAY` ⇒ COPY the consulted strands' classes + mint
 * DERIVATION citation edges), so the existing Stage-1 class collapse in
 * `independentRootCount` does the rest UNMODIFIED — no new reachability check.
 *
 * Each test targets a specific attack or contract:
 *   1. RELAY LAUNDERING (the headline): B relays A's strand ⇒ same class, a
 *      DERIVATION edge B→A, and MIS count 1 over the union of both root sets.
 *   2. TRANSITIVE RELAY: C relays B's already-relayed strand ⇒ still A's class.
 *   3. SAME-RESOURCE COLLAPSE: two agents citing the SAME (kind, resourceId) share
 *      ONE class; different resources (or DOCUMENT vs TOOL_CALL) stay distinct.
 *   4. GENUINE-INDEPENDENCE POSITIVE CONTROL: the fix must NOT under-count real
 *      independence — two plain sources still count 2.
 *   5. FALLBACK EXACTNESS: omitted / USER_STATEMENT mint EXACTLY `class:${source_id}`
 *      (string-equal), so every pre-fix caller is bit-for-bit unaffected.
 *   6. FAIL-SAFE EDGES: empty / all-unresolvable relays fall back to the default
 *      class with NO dangling edges; duplicate consulted ids dedupe to one edge;
 *      multi-witness relays reconcile Σw (out_weight_sum) correctly.
 *   7. ATOMICITY (SQLite): a throw AFTER the strand put, DURING relay edge minting,
 *      rolls the WHOLE writeFact back — a relayed strand standing without its
 *      citations IS the laundering half-state the txn exists to forbid.
 *   8. BATCH PARITY: writeFactsBatch with causal origins ≡ N writeFact calls.
 *   9. DISOWN-A-RELAYER (adversarial finding 1): disowning the RELAYER must not
 *      taint the honest UPSTREAM source's class — relay-copied roots are marked
 *      `inheritedClass` and the sweep's tainted-class set excludes them, so no
 *      honest class:A source is contradicted/scarred for B's unrelated fraud;
 *      the clawback still fires in full for classes the fraudster OWNED.
 *  10. ECHO-GATE (adversarial finding 2): an AGENT_RELAY whose payload (or
 *      attribute) DIFFERS from the cited witness inherits NO class — a
 *      contradicting "relay" cannot launder itself into the victim's class and
 *      collapse a genuine multi-class dispute into the single-class echo lane
 *      (it still DEFERS to the human horn, never worse than omission).
 *
 * IDENTITY WIRING (deliberate, adversary-favorable): the identity layer here uses an
 * OPTIMISTIC anchor port (`independenceBetween` ⇒ 1), so Stage-2 anchor math NEVER
 * collapses a pair — `independentRootCount` is driven purely by the Stage-1 class
 * structure the write path mints. That is exactly the direction that EXPOSES the
 * bug: if the relay fix failed to copy the class, the count would read 2 (laundered
 * corroboration) and these tests would fail. A pessimistic port (the bench fixture's
 * constant 0) would mask the regression by collapsing everything to 1.
 */

import { rmSync } from "node:fs";
import { freshSource } from "../testSupport/identityFixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnchorClass,
  EdgeType,
  FactState,
  createIntelligentDb,
  createMemoryStore,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
  createSqliteStore,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  AttributeKey,
  Edge,
  EntityId,
  IntelligentDb,
  SourceRegistryPort,
  SourceRef,
  ProvenanceRoot,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  StakeLedgerPort,
  Strand,
  StrandId,
  StrandStore,
  Unit,
} from "../index.js";

import type { CausalOrigin, WriteFactInput } from "../api.js";

import { bareStamp } from "../__bench__/fixtures.js";

// --- temp db lifecycle (mirrors writeFactsBatch.test.ts) ----------------------
//
// On Windows the SQLite file stays locked until the handle is closed, so afterEach
// CLOSES every tracked store FIRST (close-first is load-bearing) and only then
// removes the db + its WAL/SHM siblings.

let paths: string[] = [];
let openStores: StrandStore[] = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-relay-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

/** Remember a store so afterEach can close it before removing its file. */
function track<S extends StrandStore>(store: S): S {
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      (store as Partial<{ close(): void }>).close?.();
    } catch {
      // already closed
    }
  }
  for (const base of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- fixtures -----------------------------------------------------------------

const SRC_A = "src:alpha" as SourceId; // the original researcher
const SRC_B = "src:beta" as SourceId; // the relaying agent
const SRC_C = "src:gamma" as SourceId; // the second-hop relayer

const ENTITY = "entity:relay" as EntityId;
const ATTR = "relay#claim" as AttributeKey;
const PAYLOAD = { value: "the-sky-is-blue" };

/** The exact fallback class string `provenanceRootFromStamp` has always minted. */
function legacyClassOf(src: SourceId): string {
  return `class:${String(src)}`;
}

/** Build a WriteFactInput; `causalOrigin` only present when supplied (exactOptional). */
function fact(src: SourceId, causalOrigin?: CausalOrigin): WriteFactInput {
  return {
    entity: ENTITY,
    attribute: ATTR,
    payload: PAYLOAD,
    stamp: bareStamp(src),
    ...(causalOrigin !== undefined ? { causalOrigin } : {}),
  };
}

/**
 * An identity layer whose anchor port treats every class-disjoint pair as
 * independent (`independenceBetween` ⇒ 1) — see the header: Stage-2 never rescues
 * the count downward, so `independentRootCount` reads the class structure the write
 * path minted, which is precisely what the relay fix manipulates.
 */
function optimisticIdentity(): SourceIdentityLayer {
  const known = new Set<SourceId>();
  const sources: SourceRegistryPort = {
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
  const anchors: AnchorRegistryPort = {
    bind(): void {},
    anchorsOf(): readonly AnchorBinding[] {
      // Every source reads as DOMAIN-anchored (weight 0.35 ≥ the Phase-3 ingest
      // gate's 0.10 default), so writeFact lands LIVE exactly as it did when this
      // suite was written — these tests pin the relay CLASS mechanics, not the
      // trust-tiered quarantine (an anchorless filer would now land PROVISIONAL,
      // which is deliberately out of this suite's scope). The fixture stays
      // adversary-favorable for the MIS: `independenceBetween` is still the
      // optimistic constant 1, so Stage-2 never rescues the count and the class
      // structure the write path mints remains the only thing under test.
      return [
        {
          anchorClass: AnchorClass.DOMAIN,
          realizedCost: 0.35 as Unit,
          independenceWeight: 0.35 as Unit,
        },
      ];
    },
    aggregateCost(): Unit {
      return 0;
    },
    independenceBetween(): Unit {
      return 1; // optimistic: class disjointness alone decides the MIS
    },
  };
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 };
  const stake: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({ sources, anchors, reputation, stake });
}

interface Rig {
  readonly db: IntelligentDb;
  readonly identity: SourceIdentityLayer;
}

/** Engine + the identity layer whose `independentRootCount` the assertions read. */
function rig(store: StrandStore): Rig {
  const identity = optimisticIdentity();
  return { db: createIntelligentDb(store, identity), identity };
}

/** Resolve a stored strand by id, asserting it exists. */
function get(store: StrandStore, id: StrandId): Strand {
  const s = store.getStrand(id);
  expect(s).not.toBeNull();
  return s as Strand;
}

/** The strand's independence classes as sorted plain strings. */
function classesOf(store: StrandStore, id: StrandId): string[] {
  return get(store, id)
    .provenance.map((r) => String(r.independenceClass))
    .sort();
}

/** The strand's outgoing DERIVATION (citation) edges. */
function derivationsOf(store: StrandStore, id: StrandId): Edge[] {
  return store.outEdges(id).filter((e) => e.edgeType === EdgeType.DERIVATION);
}

/** `independentRootCount` over the UNION of the named strands' root sets. */
function unionCount(r: Rig, store: StrandStore, ...ids: StrandId[]): number {
  const roots: ProvenanceRoot[] = [];
  for (const id of ids) roots.push(...get(store, id).provenance);
  return r.identity.independentRootCount(roots);
}

// --- parametrized over both backends (writeFact's mint path is store-agnostic) --

const backends: ReadonlyArray<readonly [string, () => StrandStore]> = [
  ["memory", () => track(createMemoryStore())],
  ["sqlite", () => track(createSqliteStore(freshPath("ok")))],
];

describe.each(backends)("relay fix over %s store", (_name, makeStore) => {
  it("RELAY LAUNDERING (headline): B relaying A's strand copies A's class, cites A, and counts as ONE root", () => {
    const store = makeStore();
    const r = rig(store);

    // A researches and files the fact (no causal origin: A genuinely witnessed it).
    const idA = r.db.writeFact(fact(SRC_A));
    const classA = classesOf(store, idA);
    expect(classA).toEqual([legacyClassOf(SRC_A)]);

    // B re-files the SAME payload it learned from A's strand in-context.
    const idB = r.db.writeFact(
      fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [idA] }),
    );

    // (a) B's root(s) carry A's independence class — NEVER a fresh class:B.
    const classB = classesOf(store, idB);
    expect(classB).toEqual(classA);
    expect(classB).not.toContain(legacyClassOf(SRC_B));
    // ... while the FILING source stays B on the copied root (who filed is still
    // true, and it is what a later disown sweep keys on).
    expect(get(store, idB).provenance.map((root) => root.sourceId)).toEqual([SRC_B]);

    // (b) A DERIVATION citation edge exists, pointed derived→witness (B→A) — the
    // direction downstreamDisownSweep's BFS expects (it walks inEdges(witness)).
    const cites = derivationsOf(store, idB);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.from).toBe(idB);
    expect(cites[0]!.to).toBe(idA);
    expect(
      store.inEdges(idA).filter((e) => e.edgeType === EdgeType.DERIVATION),
    ).toHaveLength(1);

    // (c) The identity layer sees ONE witness across BOTH strands' roots: the
    // Stage-1 class collapse does the whole job — no reachability check anywhere.
    expect(unionCount(r, store, idA, idB)).toBe(1);
  });

  it("TRANSITIVE RELAY: C relaying B's already-relayed strand still carries A's ORIGINAL class; count over all three = 1", () => {
    const store = makeStore();
    const r = rig(store);

    const idA = r.db.writeFact(fact(SRC_A));
    const idB = r.db.writeFact(
      fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [idA] }),
    );
    const idC = r.db.writeFact(
      fact(SRC_C, { kind: "AGENT_RELAY", consultedStrandIds: [idB] }),
    );

    // The class survives the second hop unchanged: copy-of-a-copy is still A.
    expect(classesOf(store, idC)).toEqual([legacyClassOf(SRC_A)]);

    // C cites its DIRECT witness (B), not A — the taint closure walks the chain.
    const cites = derivationsOf(store, idC);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.to).toBe(idB);

    // One observation, three filings, ONE witness.
    expect(unionCount(r, store, idA, idB, idC)).toBe(1);
  });

  it("SAME-RESOURCE COLLAPSE: same (kind, resourceId) is ONE class across agents; different resources stay distinct", () => {
    const store = makeStore();
    const r = rig(store);
    const URL = "https://example.com/report#canonical";

    // Two DIFFERENT agents fetch the SAME underlying resource.
    const id1 = r.db.writeFact(fact(SRC_A, { kind: "TOOL_CALL", resourceId: URL }));
    const id2 = r.db.writeFact(fact(SRC_B, { kind: "TOOL_CALL", resourceId: URL }));

    const c1 = classesOf(store, id1);
    const c2 = classesOf(store, id2);
    expect(c1).toHaveLength(1);
    expect(c1).toEqual(c2); // agent-independent: derived from the resource alone
    expect(c1[0]!.startsWith("class:resource:")).toBe(true);
    expect(c1[0]).not.toBe(legacyClassOf(SRC_A));
    expect(unionCount(r, store, id1, id2)).toBe(1);

    // A DIFFERENT resource is a DIFFERENT witness: two classes, count 2.
    const id3 = r.db.writeFact(
      fact(SRC_A, { kind: "TOOL_CALL", resourceId: "https://other.example.org/x" }),
    );
    expect(classesOf(store, id3)).not.toEqual(c1);
    expect(unionCount(r, store, id1, id3)).toBe(2);

    // Domain separation: DOCUMENT vs TOOL_CALL sharing an id string are DIFFERENT
    // witnesses (the kind participates in the class hash).
    const id4 = r.db.writeFact(fact(SRC_A, { kind: "DOCUMENT", resourceId: URL }));
    expect(classesOf(store, id4)).not.toEqual(c1);
    expect(unionCount(r, store, id1, id4)).toBe(2);
  });

  it("GENUINE INDEPENDENCE (positive control): two plain sources still mint two classes and count 2", () => {
    const store = makeStore();
    const r = rig(store);

    // No causal origin on either side: each filing source genuinely witnessed it.
    const idA = r.db.writeFact(fact(SRC_A));
    const idB = r.db.writeFact(fact(SRC_B));
    expect(classesOf(store, idA)).not.toEqual(classesOf(store, idB));
    expect(unionCount(r, store, idA, idB)).toBe(2);

    // USER_STATEMENT is the same genuine-witness path: the fix must not
    // under-count real independence in either spelling.
    const idC = r.db.writeFact(fact(SRC_C, { kind: "USER_STATEMENT" }));
    expect(unionCount(r, store, idA, idB, idC)).toBe(3);
  });

  it("FALLBACK EXACTNESS: omitted and USER_STATEMENT both mint EXACTLY class:${source_id}", () => {
    const store = makeStore();
    const r = rig(store);

    const omitted = get(store, r.db.writeFact(fact(SRC_A)));
    expect(omitted.provenance).toHaveLength(1);
    // String-equal to the pre-fix mint: pre-fix callers are bit-for-bit unaffected.
    expect(String(omitted.provenance[0]!.independenceClass)).toBe(legacyClassOf(SRC_A));
    expect(omitted.provenance[0]!.sourceId).toBe(SRC_A);
    expect(derivationsOf(store, omitted.id)).toHaveLength(0);

    const stated = get(store, r.db.writeFact(fact(SRC_A, { kind: "USER_STATEMENT" })));
    expect(stated.provenance).toHaveLength(1);
    expect(String(stated.provenance[0]!.independenceClass)).toBe(legacyClassOf(SRC_A));
    expect(derivationsOf(store, stated.id)).toHaveLength(0);
  });

  it("FAIL-SAFE EDGES: empty/unresolvable relays fall back exactly; duplicate ids dedupe; multi-witness reconciles Σw", () => {
    const store = makeStore();
    const r = rig(store);

    // AGENT_RELAY with [] ⇒ identical to omission: the default fresh class, no edges.
    const empty = get(
      store,
      r.db.writeFact(fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [] })),
    );
    expect(classesOf(store, empty.id)).toEqual([legacyClassOf(SRC_B)]);
    expect(derivationsOf(store, empty.id)).toHaveLength(0);

    // AGENT_RELAY naming ONLY unknown strands ⇒ same fallback, NO dangling edges.
    const ghost = get(
      store,
      r.db.writeFact(
        fact(SRC_B, {
          kind: "AGENT_RELAY",
          consultedStrandIds: [
            "strand:no-such-1" as StrandId,
            "strand:no-such-2" as StrandId,
          ],
        }),
      ),
    );
    expect(classesOf(store, ghost.id)).toEqual([legacyClassOf(SRC_B)]);
    expect(store.outEdges(ghost.id)).toHaveLength(0);

    // DUPLICATE consulted ids ⇒ exactly ONE edge per DISTINCT witness (a replayed
    // citation list cannot inflate the graph), with Σw = 1 on the lone edge.
    const idA = r.db.writeFact(fact(SRC_A));
    const dup = get(
      store,
      r.db.writeFact(
        fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [idA, idA, idA] }),
      ),
    );
    const dupCites = derivationsOf(store, dup.id);
    expect(dupCites).toHaveLength(1);
    expect(dupCites[0]!.to).toBe(idA);
    expect(dupCites[0]!.out_weight_sum).toBe(1);

    // TWO DISTINCT witnesses (distinct classes) ⇒ one root per upstream class, one
    // edge per witness, and the share-normalization denominator reconciled to Σw=2.
    const idC = r.db.writeFact(fact(SRC_C));
    const multi = get(
      store,
      r.db.writeFact(
        fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [idA, idC] }),
      ),
    );
    expect(classesOf(store, multi.id)).toEqual(
      [legacyClassOf(SRC_A), legacyClassOf(SRC_C)].sort(),
    );
    const multiCites = derivationsOf(store, multi.id);
    expect(multiCites).toHaveLength(2);
    expect(multiCites.map((e) => e.to).sort()).toEqual([idA, idC].sort());
    for (const e of multiCites) expect(e.out_weight_sum).toBe(2);
    // The relayed pair of copied classes still counts as the ORIGINAL two
    // witnesses, not four: union over all three strands stays 2.
    expect(unionCount(r, store, idA, idC, multi.id)).toBe(2);
  });
});

// --- atomicity (SQLite — the txn matters) --------------------------------------

describe("relay writeFact atomicity (SQLite)", () => {
  it("a throw DURING relay edge minting (after the strand put) rolls the WHOLE writeFact back", () => {
    const store = track(createSqliteStore(freshPath("atomic")));
    const r = rig(store);

    // The witness lands first, committed on its own.
    const idA = r.db.writeFact(fact(SRC_A));

    // Force the failure AFTER putStrand, DURING citation minting: writeFact puts
    // the fresh strand, then mints the DERIVATION edge — which throws. Because
    // both ride ONE withTxn over the SQLite handle, the already-written strand
    // must roll back too. (A relayed strand standing WITHOUT its citations is the
    // laundering half-state: relay-classed provenance is safe on its own, but the
    // disown sweep's taint BFS needs the edges.)
    store.putEdge = (_e: Edge): void => {
      throw new Error("boom: mid-relay edge mint");
    };

    const relayInput = fact(SRC_B, {
      kind: "AGENT_RELAY",
      consultedStrandIds: [idA],
    });
    expect(() => r.db.writeFact(relayInput)).toThrow(/boom/);

    // FULL rollback: no half-written relay strand, no edge into the witness, and
    // the file is structurally intact.
    expect(store.strandsByEntity(ENTITY)).toHaveLength(1); // only the witness
    expect(store.strandsByEntity(ENTITY)[0]!.id).toBe(idA);
    expect(store.inEdges(idA)).toHaveLength(0);
    expect(store.integrityCheck()).toBe(true);

    // Restore the real putEdge: a clean re-run genuinely lands strand + citation.
    delete (store as Partial<StrandStore>).putEdge;
    const idB = r.db.writeFact(relayInput);
    expect(classesOf(store, idB)).toEqual([legacyClassOf(SRC_A)]);
    const cites = derivationsOf(store, idB);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.to).toBe(idA);
    expect(store.integrityCheck()).toBe(true);
    // afterEach closes the tracked handle before removing the file (close-first).
  });
});

// --- batch parity ---------------------------------------------------------------

describe.each(backends)("writeFactsBatch relay parity over %s store", (_name, makeStore) => {
  it("a batch with causal origins behaves IDENTICALLY to N writeFact calls (classes + edges)", () => {
    // Two independent rigs, each pre-seeded with its OWN witness strand (a caller
    // can only name strands that already exist in ITS store).
    const mk = (): { store: StrandStore; r: Rig; wid: StrandId } => {
      const store = makeStore();
      const r = rig(store);
      const wid = r.db.writeFact(fact(SRC_A));
      return { store, r, wid };
    };
    const viaBatch = mk();
    const viaOne = mk();

    const inputsFor = (wid: StrandId): WriteFactInput[] => [
      fact(SRC_B), // omitted ⇒ legacy per-source class
      fact(SRC_B, { kind: "USER_STATEMENT" }), // ⇒ same legacy class
      fact(SRC_B, { kind: "TOOL_CALL", resourceId: "https://example.com/r" }),
      fact(SRC_C, { kind: "AGENT_RELAY", consultedStrandIds: [wid] }),
    ];

    const batchIds = viaBatch.r.db.writeFactsBatch(inputsFor(viaBatch.wid));
    const oneIds = inputsFor(viaOne.wid).map((i) => viaOne.r.db.writeFact(i));
    expect(batchIds).toHaveLength(4);
    expect(oneIds).toHaveLength(4);

    // Index-for-index: same classes (deterministic strings on every path), same
    // filing sources, same DERIVATION citation count.
    for (let i = 0; i < 4; i++) {
      expect(classesOf(viaBatch.store, batchIds[i]!)).toEqual(
        classesOf(viaOne.store, oneIds[i]!),
      );
      expect(
        get(viaBatch.store, batchIds[i]!).provenance.map((root) => root.sourceId),
      ).toEqual(get(viaOne.store, oneIds[i]!).provenance.map((root) => root.sourceId));
      expect(derivationsOf(viaBatch.store, batchIds[i]!)).toHaveLength(
        derivationsOf(viaOne.store, oneIds[i]!).length,
      );
    }

    // The relay input (index 3) landed the SAME semantics on both paths: A's
    // class copied, one citation to the store's own witness, MIS union = 1.
    for (const { store, r, wid, id } of [
      { ...viaBatch, id: batchIds[3]! },
      { ...viaOne, id: oneIds[3]! },
    ]) {
      expect(classesOf(store, id)).toEqual([legacyClassOf(SRC_A)]);
      const cites = derivationsOf(store, id);
      expect(cites).toHaveLength(1);
      expect(cites[0]!.to).toBe(wid);
      expect(unionCount(r, store, wid, id)).toBe(1);
    }

    // And the non-relay batch members minted NO citation edges.
    for (let i = 0; i < 3; i++) {
      expect(derivationsOf(viaBatch.store, batchIds[i]!)).toHaveLength(0);
    }
  });
});

// --- adversarial finding 1: disowning a RELAYER must not scar the honest upstream --
//
// The relay fix mints roots carrying the UPSTREAM class but the FILER's sourceId.
// `downstreamDisownSweep` computes its tainted-class set as "classes of seed roots
// whose sourceId === disowned" — so WITHOUT the `inheritedClass` marker, disowning
// relayer B tainted honest A's class and permanently scarred (`contradict` with
// scarBeta) every honest source rooted in class:A: honest second-hop relayer C, and
// even origin A itself — the suppression vector (relay a rival, get disowned,
// crater the rival). Parametrized over BOTH backends: SQLite additionally proves
// the `inheritedClass` marker survives the JSON row round-trip the sweep re-reads.

describe.each(backends)("disown-a-relayer taint bound over %s store", (_name, makeStore) => {
  it("disowning relayer B leaves upstream A's class untainted: A and C are NOT contradicted, O stays LIVE", () => {
    const store = makeStore();
    const identity = optimisticIdentity();
    const reputation = createReputationLedger(() => 0.9);
    const db = createIntelligentDb(store, identity, null, reputation);

    // Honest A files O; B relays O -> P; honest C relays P -> S. All three strands
    // sit in A's class (the relay fix working as designed).
    const idO = db.writeFact(fact(SRC_A));
    const idP = db.writeFact(fact(SRC_B, { kind: "AGENT_RELAY", consultedStrandIds: [idO] }));
    const idS = db.writeFact(fact(SRC_C, { kind: "AGENT_RELAY", consultedStrandIds: [idP] }));
    expect(classesOf(store, idS)).toEqual([legacyClassOf(SRC_A)]);

    const aBefore = reputation.stateOf(SRC_A);
    const cBefore = reputation.stateOf(SRC_C);

    // B is disowned for unrelated fraud.
    const result = db.disown(SRC_B);

    // (a) THE FIX: B never OWNED class:A (its seed root is inheritedClass), so the
    // tainted-class set is empty and NO honest source is contradicted or scarred.
    expect(result.contradictedSources).toEqual([]);
    expect(reputation.stateOf(SRC_A)).toEqual(aBefore);
    expect(reputation.stateOf(SRC_C)).toEqual(cBefore);

    // (b) A's ORIGINAL strand is upstream of the fraud, not downstream: untouched.
    expect(get(store, idO).fact_state).toBe(FactState.LIVE);
    expect(get(store, idO).outranked_by).toBeNull();

    // (c) The sweep still DEMOTES the derivation-downstream of the fraud's strand
    // (S's existence rested on P; demote-never-delete is untouched by the fix) —
    // only the CLASS-bounded reputation clawback is withheld.
    expect(result.demotedDownstream).toContain(idS);
    expect(get(store, idS).fact_state).toBe(FactState.DEMOTED);
  });

  it("POSITIVE CONTROL: the clawback still fires in full for a class the fraudster OWNED", () => {
    const store = makeStore();
    const identity = optimisticIdentity();
    const reputation = createReputationLedger(() => 0.9);
    const db = createIntelligentDb(store, identity, null, reputation);

    // B ORIGINATES a claim of its own (non-inherited class:B), and C relays it —
    // C's root is class:B (inherited). class:B IS the fraudster's own class.
    const idB = db.writeFact(fact(SRC_B));
    const idS = db.writeFact(fact(SRC_C, { kind: "AGENT_RELAY", consultedStrandIds: [idB] }));
    expect(classesOf(store, idS)).toEqual([legacyClassOf(SRC_B)]);

    const cBefore = reputation.stateOf(SRC_C);
    const result = db.disown(SRC_B);

    // The tainted set is {class:B}: C rooted its relay in the fraudster's OWN class,
    // so C's credit for propagating the fraud IS clawed back (class-bounded, as
    // before the fix) — the inheritedClass marker narrows the taint to classes the
    // disowned source originated; it does not neuter the sweep.
    expect(result.demotedDownstream).toContain(idS);
    expect(get(store, idS).fact_state).toBe(FactState.DEMOTED);
    expect(result.contradictedSources).toContain(SRC_C);
    expect(reputation.stateOf(SRC_C)).not.toEqual(cBefore);
  });
});

// --- adversarial finding 2: the ECHO GATE (no class inheritance without agreement) --
//
// Without the gate, a zero-reputation attacker files a CONTRADICTING payload under
// AGENT_RELAY citing the victim's strand: the write copies the victim's class, the
// dispute reads as SINGLE-class, and tryConsolidate routes it down the echo lane
// (deterministic-id tiebreak at rep 0 — a coin-flip demotion of the honest
// incumbent). That is strictly WORSE than omitting causalOrigin, where the dispute
// is multi-class and DEFERS to the human horn. The gate: a witness's class is
// copied ONLY when the new fact is the SAME CLAIM (same content_hash — entity +
// payload — AND same attribute).

describe.each(backends)("relay ECHO GATE over %s store", (_name, makeStore) => {
  const LIE = { value: "the-sky-is-green" };

  it("a CONTRADICTING 'relay' inherits NO class: the dispute stays multi-class and DEFERS (incumbent stays LIVE)", () => {
    const store = makeStore();
    const identity = optimisticIdentity();
    const reputation = createReputationLedger(() => 0.9);
    const ledger = createPendingLedger({ reputation });
    const systemSource = freshSource().sourceId;
    const db = createIntelligentDb(store, identity, null, reputation, { ledger, systemSource });

    // Honest A files the TRUE claim.
    const idO = db.writeFact(fact(SRC_A));

    // Attacker B files a DIFFERENT payload for the same (entity, attribute) while
    // declaring AGENT_RELAY over A's strand — a dishonest declaration.
    const idP = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: LIE,
      stamp: bareStamp(SRC_B),
      causalOrigin: { kind: "AGENT_RELAY", consultedStrandIds: [idO] },
    });

    // (a) THE GATE: no agreement, no inheritance — B's strand carries a fresh
    // class:B, never the victim's class:A.
    expect(classesOf(store, idP)).toEqual([legacyClassOf(SRC_B)]);

    // (b) The DERIVATION citation is still recorded (the consultation is a graph
    // fact; the disown-sweep taint BFS must still see it).
    const cites = derivationsOf(store, idP);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.to).toBe(idO);

    // (c) The dispute is genuinely MULTI-class, so the web never picks a winner
    // in-graph: it DEFERS to the human horn and the honest incumbent stays LIVE —
    // exactly what the identical attack with causalOrigin OMITTED gets. Never worse.
    const outcome = db.adjudicate(ATTR);
    expect(outcome.kind).toBe("DEFERRED");
    expect(get(store, idO).fact_state).toBe(FactState.LIVE);
    expect(get(store, idO).outranked_by).toBeNull();
    expect(get(store, idP).fact_state).toBe(FactState.LIVE);
  });

  it("CROSS-ATTRIBUTE laundering is refused too: reusing the victim's PAYLOAD under a different attribute inherits nothing", () => {
    const store = makeStore();
    const r = rig(store);
    const ATTR2 = "relay#other-claim" as AttributeKey;

    // A's strand O carries (ENTITY, ATTR, PAYLOAD). The attacker replays A's exact
    // PAYLOAD (same entity ⇒ same content_hash as O) but files it under a DIFFERENT
    // attribute, citing O — hoping to carry class:A into ATTR2's contradiction set,
    // where A holds a different value. The attribute check refuses the copy.
    const idO = r.db.writeFact(fact(SRC_A));
    const idQ = r.db.writeFact({
      entity: ENTITY,
      attribute: ATTR2,
      payload: PAYLOAD,
      stamp: bareStamp(SRC_B),
      causalOrigin: { kind: "AGENT_RELAY", consultedStrandIds: [idO] },
    });
    expect(get(store, idQ).content_hash).toBe(get(store, idO).content_hash); // the lure is real
    expect(classesOf(store, idQ)).toEqual([legacyClassOf(SRC_B)]); // ... and refused

    // POSITIVE CONTROL in the same rig: the honest same-claim relay still inherits.
    const idR = r.db.writeFact(fact(SRC_C, { kind: "AGENT_RELAY", consultedStrandIds: [idO] }));
    expect(classesOf(store, idR)).toEqual([legacyClassOf(SRC_A)]);
  });
});
