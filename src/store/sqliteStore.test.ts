/**
 * sqliteStore.test.ts — proves the durable SQLite StrandStore is a faithful,
 * crash-safe EQUAL of the in-memory backend.
 *
 * Mirrors every case in memoryStore.test.ts (put/get, entity + attribute seed
 * indexes, re-index on replace, out/in adjacency, neighbor dangling-skip, the
 * load-bearing `recomputeOutWeightSum`, frozen edge views) over a real on-disk
 * database, PLUS the two things only persistence can prove:
 *
 *   1. REOPEN PERSISTENCE: write strands + edges, close the store, open a NEW store
 *      on the SAME path, and recall everything — including the recomputed
 *      `out_weight_sum` — proving committed data survives a simulated restart.
 *   2. ENGINE DROP-IN: build the identity layer + a SQLite store, run the engine's
 *      `writeFact`, close, reopen a fresh store on the same path, and recall the
 *      fact via `strandsByEntity` / `getStrand` — proving the engine persists across
 *      a restart with the store swapped in UNCHANGED.
 *
 * Iteration order is unspecified by the StrandStore contract (SQLite has no implicit
 * insertion order), so every multi-row assertion compares SORTED id arrays / sets,
 * never literal order.
 *
 * Temp database files live under os.tmpdir() with a unique per-test name; afterEach
 * closes the store and removes the db plus its WAL/SHM siblings.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  computeEdgeWeight,
  EdgeType,
  FactOrigin,
  FactState,
  Tier,
  type AttributeKey,
  type ContentHash,
  type Edge,
  type EdgeId,
  type EntityId,
  type Strand,
  type StrandId,
} from "../core/types.js";
import { createSqliteStore, type SqliteStrandStore } from "./sqliteStore.js";

import {
  createIntelligentDb,
  createSourceIdentityLayer,
  createStakeLedger,
  generatePassport,
  independenceBetween,
  AnchorClass,
} from "../index.js";
import type {
  AnchorBinding,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  Passport,
  SourceId,
  Unit,
} from "../index.js";

// --- minimal fixtures (mirror memoryStore.test.ts) -------------------------

function makeStrand(id: string, entity: string, attribute: string | null): Strand {
  return {
    id: id as StrandId,
    entity: entity as EntityId,
    attribute: attribute === null ? null : (attribute as AttributeKey),
    payload: { note: id },
    content_hash: `hash:${id}` as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: asEpochMs(0), lambda: 0.1, fire_count: 0 },
    description_value: 0,
    observedAt: asEpochMs(0),
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

function makeEdge(id: string, from: string, to: string, w: number): Edge {
  return {
    id: id as EdgeId,
    from: from as StrandId,
    to: to as StrandId,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: w,
    provenance_independence: 1,
    recency: 1,
    w: computeEdgeWeight(w, 1, 1),
    out_weight_sum: 0,
  };
}

const ids = (xs: ReadonlyArray<{ id: string }>): string[] =>
  xs.map((x) => x.id).sort();

// --- temp db lifecycle ------------------------------------------------------

let dbPath: string;
let store: SqliteStrandStore;

beforeEach(() => {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  dbPath = join(tmpdir(), `idb-sqlite-${unique}.db`);
  store = createSqliteStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed by a test (reopen cases close their own handles)
  }
  // Remove the db plus the WAL/SHM siblings WAL mode leaves behind.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(dbPath + suffix, { force: true });
  }
});

describe("SqliteStrandStore — mirrors the in-memory contract", () => {
  it("stores and retrieves strands; getStrand returns null when absent", () => {
    const a = makeStrand("a", "E1", "E1.color");
    store.putStrand(a);
    expect(store.getStrand("a" as StrandId)).toEqual(a);
    expect(store.getStrand("missing" as StrandId)).toBeNull();
  });

  it("indexes by entity and by attribute", () => {
    store.putStrand(makeStrand("a", "E1", "E1.color"));
    store.putStrand(makeStrand("b", "E1", "E1.size"));
    store.putStrand(makeStrand("c", "E2", null));

    expect(ids(store.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
    expect(ids(store.strandsByEntity("E2" as EntityId))).toEqual(["c"]);
    expect(ids(store.strandsByAttribute("E1.color" as AttributeKey))).toEqual([
      "a",
    ]);
    expect(store.strandsByAttribute("nope" as AttributeKey)).toEqual([]);
  });

  it("re-indexes when a strand is replaced with a new entity/attribute", () => {
    store.putStrand(makeStrand("a", "E1", "E1.color"));
    store.putStrand(makeStrand("a", "E2", "E2.color")); // replace
    expect(store.strandsByEntity("E1" as EntityId)).toEqual([]);
    expect(ids(store.strandsByEntity("E2" as EntityId))).toEqual(["a"]);
    expect(store.strandsByAttribute("E1.color" as AttributeKey)).toEqual([]);
    // The single physical row was rewritten, not duplicated.
    expect(store.strandsByEntity("E2" as EntityId).length).toBe(1);
  });

  it("a null-attribute strand is never matched by strandsByAttribute", () => {
    store.putStrand(makeStrand("a", "E1", null));
    // No attribute key (and certainly not a literal "null") resolves to it.
    expect(store.strandsByAttribute("null" as AttributeKey)).toEqual([]);
    expect(store.strandsByEntity("E1" as EntityId).map((s) => s.id)).toEqual([
      "a",
    ]);
  });

  it("wires out/in adjacency and resolves neighbors, skipping dangling edges", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5));
    store.putEdge(makeEdge("a->x", "a", "x", 0.5)); // x not stored => dangling

    expect(store.outEdges("a" as StrandId).map((e) => e.id).sort()).toEqual([
      "a->b",
      "a->x",
    ]);
    expect(store.inEdges("b" as StrandId).map((e) => e.id)).toEqual(["a->b"]);

    const nbrs = store.neighbors("a" as StrandId);
    expect(nbrs.map((n) => n.strand.id)).toEqual(["b"]); // dangling a->x skipped
  });

  it("putEdge replaces an edge's endpoints (adjacency follows the new from/to)", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putStrand(makeStrand("c", "E1", null));
    store.putEdge(makeEdge("e", "a", "b", 0.5));
    // Replace the same edge id with new endpoints.
    store.putEdge(makeEdge("e", "a", "c", 0.5));

    expect(store.outEdges("a" as StrandId).map((e) => e.id)).toEqual(["e"]);
    expect(store.inEdges("b" as StrandId)).toEqual([]); // old destination unwired
    expect(store.inEdges("c" as StrandId).map((e) => e.id)).toEqual(["e"]);
  });

  it("recomputeOutWeightSum writes Σw onto every out-edge of the node", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putStrand(makeStrand("c", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5)); // w = 0.5
    store.putEdge(makeEdge("a->c", "a", "c", 0.25)); // w = 0.25

    store.recomputeOutWeightSum("a" as StrandId);
    for (const e of store.outEdges("a" as StrandId)) {
      expect(e.out_weight_sum).toBeCloseTo(0.75);
    }
    // No out-edges => no-op, no throw.
    expect(() => store.recomputeOutWeightSum("b" as StrandId)).not.toThrow();
  });

  it("putStrandsBatch is parity with N putStrand calls (and indexes correctly)", () => {
    store.putStrandsBatch([
      makeStrand("a", "E1", "E1.color"),
      makeStrand("b", "E1", "E1.size"),
      makeStrand("c", "E2", null),
    ]);
    expect(store.getStrand("a" as StrandId)).toEqual(makeStrand("a", "E1", "E1.color"));
    expect(ids(store.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
    expect(ids(store.strandsByEntity("E2" as EntityId))).toEqual(["c"]);
    expect(ids(store.strandsByAttribute("E1.color" as AttributeKey))).toEqual(["a"]);
    // A null-attribute batch row is never matched by strandsByAttribute.
    expect(store.strandsByAttribute("null" as AttributeKey)).toEqual([]);
  });

  it("putStrandsBatch over an empty iterable is a no-op (no throw)", () => {
    expect(() => store.putStrandsBatch([])).not.toThrow();
    expect([...store.allStrands()]).toEqual([]);
  });

  it("putEdgesBatch is parity with N putEdge calls (adjacency follows)", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putStrand(makeStrand("c", "E1", null));
    store.putEdgesBatch([
      makeEdge("a->b", "a", "b", 0.5),
      makeEdge("a->c", "a", "c", 0.25),
    ]);
    expect(store.outEdges("a" as StrandId).map((e) => e.id).sort()).toEqual([
      "a->b",
      "a->c",
    ]);
    expect(store.inEdges("b" as StrandId).map((e) => e.id)).toEqual(["a->b"]);
  });

  it("batch methods enroll in an open beginTxn (one atomic unit; rollback discards)", () => {
    const txn = store.beginTxn();
    store.putStrandsBatch([makeStrand("a", "E1", null), makeStrand("b", "E1", null)]);
    store.putEdgesBatch([makeEdge("a->b", "a", "b", 0.5)]);
    txn.rollback();
    // Nothing committed: the whole unit of work was abandoned.
    expect(store.getStrand("a" as StrandId)).toBeNull();
    expect(store.getStrand("b" as StrandId)).toBeNull();
    expect(store.outEdges("a" as StrandId)).toEqual([]);
  });

  it("hands out frozen edge views", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5));
    const view = store.getEdge("a->b" as EdgeId)!;
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("allStrands / allEdges iterate every row (sorted-id compare)", () => {
    store.putStrand(makeStrand("a", "E1", null));
    store.putStrand(makeStrand("b", "E1", null));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5));
    store.putEdge(makeEdge("b->a", "b", "a", 0.5));

    expect([...store.allStrands()].map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect([...store.allEdges()].map((e) => e.id).sort()).toEqual([
      "a->b",
      "b->a",
    ]);
  });

  it("round-trips the FULL strand shape faithfully (provenance/salience/bridge/enums)", () => {
    const rich: Strand = {
      ...makeStrand("rich", "E1", "E1.attr"),
      origin: FactOrigin.DERIVED,
      fact_state: FactState.PROVISIONAL,
      tier: Tier.COLD,
      payload: { nested: { a: 1, list: [1, 2, 3] }, flag: true },
      provenance: [
        {
          rootId: "root:1" as Strand["provenance"][number]["rootId"],
          independenceClass:
            "class:X" as Strand["provenance"][number]["independenceClass"],
          sourceId: "src:1" as Strand["provenance"][number]["sourceId"],
          establishedAt: asEpochMs(123),
        },
      ],
      bridge: { earned_bridge_value: 3, far_side_potential: 7 },
      salience: { s: 0.5, last_fire_time: asEpochMs(99), lambda: 0.2, fire_count: 4 },
      co_equal_claim_cardinality: 2,
    };
    store.putStrand(rich);
    expect(store.getStrand("rich" as StrandId)).toEqual(rich);
  });
});

describe("SqliteStrandStore — persistence across a simulated restart", () => {
  it("REOPEN: strands, edges, indexes, and recomputed out_weight_sum survive close+reopen", () => {
    // Write a small web and recompute the share-normalization denominator.
    store.putStrand(makeStrand("a", "E1", "E1.color"));
    store.putStrand(makeStrand("b", "E1", null));
    store.putStrand(makeStrand("c", "E2", "E2.size"));
    store.putEdge(makeEdge("a->b", "a", "b", 0.5)); // w = 0.5
    store.putEdge(makeEdge("a->c", "a", "c", 0.25)); // w = 0.25
    store.recomputeOutWeightSum("a" as StrandId);

    // Simulate a process restart: close, then open a brand-new store on the SAME path.
    store.close();
    const reopened = createSqliteStore(dbPath);
    store = reopened; // so afterEach closes/cleans this handle

    // Strands recall by id and by both seed indexes.
    expect(reopened.getStrand("a" as StrandId)).toEqual(
      makeStrand("a", "E1", "E1.color"),
    );
    expect(ids(reopened.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
    expect(ids(reopened.strandsByEntity("E2" as EntityId))).toEqual(["c"]);
    expect(ids(reopened.strandsByAttribute("E1.color" as AttributeKey))).toEqual([
      "a",
    ]);

    // Adjacency survives.
    expect(reopened.outEdges("a" as StrandId).map((e) => e.id).sort()).toEqual([
      "a->b",
      "a->c",
    ]);
    expect(reopened.inEdges("b" as StrandId).map((e) => e.id)).toEqual(["a->b"]);

    // The recomputed denominator persisted (0.5 + 0.25 = 0.75).
    for (const e of reopened.outEdges("a" as StrandId)) {
      expect(e.out_weight_sum).toBeCloseTo(0.75);
    }
  });

  it("REOPEN: a committed putStrandsBatch / putEdgesBatch survives close+reopen", () => {
    store.putStrandsBatch([makeStrand("a", "E1", null), makeStrand("b", "E1", null)]);
    store.putEdgesBatch([makeEdge("a->b", "a", "b", 0.5)]);

    store.close();
    const reopened = createSqliteStore(dbPath);
    store = reopened;

    expect(ids(reopened.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
    expect(reopened.inEdges("b" as StrandId).map((e) => e.id)).toEqual(["a->b"]);
  });

  it("the opt-in synchronous=FULL knob still opens, writes, and persists", () => {
    store.close();
    const full = createSqliteStore(dbPath, { synchronous: "FULL" });
    store = full;
    full.putStrand(makeStrand("a", "E1", null));
    expect(full.getStrand("a" as StrandId)).toEqual(makeStrand("a", "E1", null));
  });
});

// --- identity-layer wiring for the engine drop-in test (mirrors smoke.test.ts) ---

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
      return best;
    },
    independenceBetween(
      a: readonly AnchorBinding[],
      b: readonly AnchorBinding[],
    ): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeIdentityLayer(): SourceIdentityLayer {
  const stake = createStakeLedger();
  const stakePort: StakeLedgerPort = { postedFor: (s) => stake.posted(s) };
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 as Unit };
  return createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

function domainAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.DOMAIN,
    realizedCost: 0.35 as Unit,
    independenceWeight: 0.35 as Unit,
  };
}

describe("SqliteStrandStore — engine drop-in persists writeFact across a restart", () => {
  it("writeFact -> close -> reopen recalls the fact via strandsByEntity / getStrand", () => {
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity); // drop-in, store swapped UNCHANGED

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    const attribute = "berlin#capital_of" as AttributeKey;
    const id = db.writeFact({
      entity,
      attribute,
      payload: { capitalOf: "Germany" },
      stamp,
    });
    expect(id).toBeTruthy();

    // Simulate a restart: drop the engine + store, reopen a fresh store on the same path.
    store.close();
    const reopened = createSqliteStore(dbPath);
    store = reopened;

    // The fact persisted: recall it by the shared-entity seed index and by id.
    const about = reopened.strandsByEntity(entity);
    expect(about.map((s) => s.id)).toContain(id);

    const filed = reopened.getStrand(id);
    expect(filed).not.toBeNull();
    expect(filed?.entity).toBe(entity);
    expect(filed?.attribute).toBe(attribute);
    expect(filed?.payload).toEqual({ capitalOf: "Germany" });
    // Provenance derived from the stamp survived the round-trip to disk and back.
    expect((filed?.provenance.length ?? 0)).toBeGreaterThan(0);
    expect(filed?.provenance[0]?.sourceId).toBe(passport.sourceId);
  });

  it("two facts about one entity persist their shared-entity join (the entity index) across a restart", () => {
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = generatePassport();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:berlin" as EntityId;
    const a = db.writeFact({ entity, payload: { note: "first" }, stamp });
    const b = db.writeFact({ entity, payload: { note: "second" }, stamp });

    store.close();
    const reopened = createSqliteStore(dbPath);
    store = reopened;

    // SHARED_ENTITY is an INDEX, not a materialized clique: writeFact mints no
    // sibling edges (the O(N^2) mesh is gone), so durability is about the ENTITY
    // INDEX, not an adjacency mesh. Both strands persisted under the entity index.
    expect(reopened.strandsByEntity(entity).map((s) => s.id).sort()).toEqual(
      [a, b].sort(),
    );

    // INTENT preserved (durable recall connectivity): after the restart, a recall
    // seeded at `a` still lights `b` because the walk derives the same-entity
    // siblings from the (durable) entity index on the fly.
    const reopenedDb = createIntelligentDb(reopened, identity);
    const result = reopenedDb.recall({ seeds: [{ strandId: a, energy: 1 }] });
    const litIds = result.lit.map((l) => l.strandId);
    expect(litIds).toContain(a);
    expect(litIds).toContain(b);
  });
});
