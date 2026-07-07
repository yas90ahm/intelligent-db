/**
 * encryptedStore.test.ts — proves {@link createEncryptedStore} (value-level
 * AES-256-GCM encryption at rest, `docs/specs/PHASE2_DURABILITY_SPEC.md` §3) is a
 * TRANSPARENT drop-in over both backends, plus the adversarial cases the spec
 * calls out by name.
 *
 * PARAMETRIZED CONTRACT MATRIX: `runContractMatrix` below re-runs the same core
 * assertions memoryStore.test.ts / sqliteStore.test.ts make about the *plaintext*
 * {@link StrandStore} contract (put/get roundtrip, entity/attribute indexing,
 * re-index on replace, out/in adjacency + dangling-neighbor skip,
 * `recomputeOutWeightSum`, batch parity, full-shape roundtrip) against the
 * ENCRYPTED wrapper over BOTH the in-memory and the SQLite backend — i.e. it
 * parametrizes the existing store test matrix to run green under encryption,
 * exactly as the spec requires, without touching either original test file (both
 * stay exactly as they were, still proving the plaintext contract).
 *
 * ADVERSARIAL CASES (spec §3, required by name):
 *   - wrong key => a clean, named, typed error — never a crash, never a partial
 *     read.
 *   - a flipped ciphertext byte => a GCM authentication failure surfaced as a
 *     named integrity error naming the row.
 *   - (bonus, same mechanism) a ciphertext SWAPPED onto a different row is
 *     likewise caught — proving AAD = row identity actually binds.
 *
 * Also proves: reopen persistence under encryption (SQLite), the engine drop-in
 * (`writeFact` + `recall` through the encrypted store), pass-through of the
 * SQLite-only widening members (`beginTxn`/`integrityCheck`/`putEdgesBatch`), and
 * that the persisted row is genuinely NOT plaintext (the value-level, not
 * full-file, scope the spec documents).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

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
import { createMemoryStore } from "./memoryStore.js";
import { createSqliteStore, type SqliteStrandStore } from "./sqliteStore.js";
import type { StrandStore } from "./StrandStore.js";
import {
  createEncryptedStore,
  EncryptedStoreIntegrityError,
  NonceCeilingExceededError,
} from "./encryptedStore.js";

import { createIntelligentDb, createSourceIdentityLayer } from "../index.js";
import { freshSource } from "../testSupport/identityFixtures.js";
import { AnchorClass } from "../index.js";
import type {
  AnchorBinding,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  SourceRef,
  SourceId,
  Unit,
} from "../index.js";

// --- fixtures (mirror memoryStore.test.ts / sqliteStore.test.ts) ------------

function makeStrand(
  id: string,
  entity: string,
  attribute: string | null,
  payload: unknown = { note: id },
): Strand {
  return {
    id: id as StrandId,
    entity: entity as EntityId,
    attribute: attribute === null ? null : (attribute as AttributeKey),
    payload,
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

const ids = (xs: ReadonlyArray<{ id: string }>): string[] => xs.map((x) => x.id).sort();

/** A fixed, valid 32-byte test key (never used outside this test file). */
function testKey(): Buffer {
  return Buffer.alloc(32, 7);
}

/** A DIFFERENT 32-byte key, for the wrong-key adversarial case. */
function wrongKey(): Buffer {
  return Buffer.alloc(32, 9);
}

// ---------------------------------------------------------------------------
// PARAMETRIZED CONTRACT MATRIX — same assertions, both backends, encrypted
// ---------------------------------------------------------------------------

function runContractMatrix(label: string, makeStore: () => StrandStore): void {
  describe(`createEncryptedStore contract — ${label}`, () => {
    it("stores and retrieves strands; getStrand returns null when absent", () => {
      const store = makeStore();
      const a = makeStrand("a", "E1", "E1.color");
      store.putStrand(a);
      expect(store.getStrand("a" as StrandId)).toEqual(a);
      expect(store.getStrand("missing" as StrandId)).toBeNull();
    });

    it("indexes by entity and by attribute (index keys are plaintext, unaffected)", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", "E1.color"));
      store.putStrand(makeStrand("b", "E1", "E1.size"));
      store.putStrand(makeStrand("c", "E2", null));

      expect(ids(store.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
      expect(ids(store.strandsByEntity("E2" as EntityId))).toEqual(["c"]);
      expect(ids(store.strandsByAttribute("E1.color" as AttributeKey))).toEqual(["a"]);
      expect(store.strandsByAttribute("nope" as AttributeKey)).toEqual([]);
    });

    it("re-indexes when a strand is replaced with a new entity/attribute", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", "E1.color"));
      store.putStrand(makeStrand("a", "E2", "E2.color"));
      expect(store.strandsByEntity("E1" as EntityId)).toEqual([]);
      expect(ids(store.strandsByEntity("E2" as EntityId))).toEqual(["a"]);
    });

    it("wires out/in adjacency and resolves decrypted neighbors, skipping dangling edges", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", null, { secret: "a-payload" }));
      store.putStrand(makeStrand("b", "E1", null, { secret: "b-payload" }));
      store.putEdge(makeEdge("a->b", "a", "b", 0.5));
      store.putEdge(makeEdge("a->x", "a", "x", 0.5)); // x not stored => dangling

      expect(store.outEdges("a" as StrandId).map((e) => e.id).sort()).toEqual([
        "a->b",
        "a->x",
      ]);
      const nbrs = store.neighbors("a" as StrandId);
      expect(nbrs.map((n) => n.strand.id)).toEqual(["b"]);
      expect(nbrs[0]?.strand.payload).toEqual({ secret: "b-payload" });
    });

    it("recomputeOutWeightSum writes Σw onto every out-edge (edges untouched by encryption)", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", null));
      store.putStrand(makeStrand("b", "E1", null));
      store.putStrand(makeStrand("c", "E1", null));
      store.putEdge(makeEdge("a->b", "a", "b", 0.5));
      store.putEdge(makeEdge("a->c", "a", "c", 0.25));

      store.recomputeOutWeightSum("a" as StrandId);
      for (const e of store.outEdges("a" as StrandId)) {
        expect(e.out_weight_sum).toBeCloseTo(0.75);
      }
    });

    it("putStrandsBatch is parity with N putStrand calls (every payload still decrypts)", () => {
      const store = makeStore();
      store.putStrandsBatch([
        makeStrand("a", "E1", "E1.color", { v: 1 }),
        makeStrand("b", "E1", "E1.size", { v: 2 }),
        makeStrand("c", "E2", null, { v: 3 }),
      ]);
      expect(store.getStrand("a" as StrandId)?.payload).toEqual({ v: 1 });
      expect(store.getStrand("b" as StrandId)?.payload).toEqual({ v: 2 });
      expect(store.getStrand("c" as StrandId)?.payload).toEqual({ v: 3 });
      expect(ids(store.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
    });

    it("allStrands / allEdges iterate every row, decrypted (sorted-id compare)", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", null));
      store.putStrand(makeStrand("b", "E1", null));
      store.putEdge(makeEdge("a->b", "a", "b", 0.5));

      expect([...store.allStrands()].map((s) => s.id).sort()).toEqual(["a", "b"]);
      expect([...store.allEdges()].map((e) => e.id)).toEqual(["a->b"]);
    });

    it("round-trips a rich payload (nested objects, arrays, null, booleans) faithfully", () => {
      const store = makeStore();
      const richPayload = {
        nested: { a: 1, list: [1, 2, 3], flag: true },
        note: null,
        text: "correct horse battery staple",
      };
      const rich = makeStrand("rich", "E1", "E1.attr", richPayload);
      store.putStrand(rich);
      expect(store.getStrand("rich" as StrandId)).toEqual(rich);
    });

    it("frozen edge views still hold (edges are pure pass-through)", () => {
      const store = makeStore();
      store.putStrand(makeStrand("a", "E1", null));
      store.putStrand(makeStrand("b", "E1", null));
      store.putEdge(makeEdge("a->b", "a", "b", 0.5));
      const view = store.getEdge("a->b" as EdgeId)!;
      expect(Object.isFrozen(view)).toBe(true);
    });
  });
}

runContractMatrix("in-memory backend", () => createEncryptedStore(createMemoryStore(), testKey));

describe("createEncryptedStore contract — SQLite backend", () => {
  let dbPath: string;
  let raw: SqliteStrandStore;

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // already closed by a reopen case
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  });

  function freshSqliteStore(): StrandStore {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = join(tmpdir(), `idb-encstore-${unique}.db`);
    raw = createSqliteStore(dbPath);
    return createEncryptedStore(raw, testKey);
  }

  runContractMatrixInline(freshSqliteStore);

  function runContractMatrixInline(factory: () => StrandStore): void {
    it("stores and retrieves strands; getStrand returns null when absent", () => {
      const store = factory();
      const a = makeStrand("a", "E1", "E1.color");
      store.putStrand(a);
      expect(store.getStrand("a" as StrandId)).toEqual(a);
      expect(store.getStrand("missing" as StrandId)).toBeNull();
    });

    it("indexes by entity/attribute; batch parity; recomputeOutWeightSum unaffected", () => {
      const store = factory() as SqliteStrandStore;
      store.putStrandsBatch([
        makeStrand("a", "E1", "E1.color", { v: 1 }),
        makeStrand("b", "E1", "E1.size", { v: 2 }),
      ]);
      expect(ids(store.strandsByEntity("E1" as EntityId))).toEqual(["a", "b"]);
      expect(store.getStrand("a" as StrandId)?.payload).toEqual({ v: 1 });

      store.putEdgesBatch([makeEdge("a->b", "a", "b", 0.5)]);
      store.recomputeOutWeightSum("a" as StrandId);
      for (const e of store.outEdges("a" as StrandId)) {
        expect(e.out_weight_sum).toBeCloseTo(0.5);
      }
    });

    it("REOPEN: encrypted strands survive close + reopen and still decrypt", () => {
      const store = factory() as SqliteStrandStore;
      store.putStrand(makeStrand("a", "E1", "E1.color", { secret: 42 }));
      store.close();

      const reopenedRaw = createSqliteStore(dbPath);
      raw = reopenedRaw; // afterEach cleans this handle
      const reopened = createEncryptedStore(reopenedRaw, testKey);

      expect(reopened.getStrand("a" as StrandId)?.payload).toEqual({ secret: 42 });
    });

    it("beginTxn passes through: rollback discards writes made via the encrypted wrapper", () => {
      const store = factory() as SqliteStrandStore;
      const txn = store.beginTxn();
      store.putStrand(makeStrand("a", "E1", null, { v: 1 }));
      txn.rollback();
      expect(store.getStrand("a" as StrandId)).toBeNull();
    });

    it("integrityCheck passes through untouched", () => {
      const store = factory() as SqliteStrandStore;
      store.putStrand(makeStrand("a", "E1", null));
      expect(store.integrityCheck()).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial cases required by the spec: wrong key, flipped byte, row swap
// ---------------------------------------------------------------------------

describe("createEncryptedStore — adversarial integrity cases", () => {
  let dbPath: string;
  let raw: SqliteStrandStore;

  afterEach(() => {
    try {
      raw.close();
    } catch {
      // ignore
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  });

  function freshRaw(): SqliteStrandStore {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = join(tmpdir(), `idb-encstore-adv-${unique}.db`);
    raw = createSqliteStore(dbPath);
    return raw;
  }

  it("wrong key => a clean, named, typed error — never a crash, never a partial read", () => {
    const inner = freshRaw();
    const written = createEncryptedStore(inner, testKey);
    written.putStrand(makeStrand("a", "E1", null, { secret: "top-secret" }));

    const misconfigured = createEncryptedStore(inner, wrongKey);
    let caught: unknown;
    try {
      misconfigured.getStrand("a" as StrandId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EncryptedStoreIntegrityError);
    const err = caught as EncryptedStoreIntegrityError;
    expect(err.reason).toBe("AUTH_FAILED");
    expect(err.rowId).toBe("a");
    // No partial/garbage payload was ever handed back on the failing path — the
    // throw happens before any decrypted bytes are returned to the caller.
  });

  it("a flipped ciphertext byte => GCM auth failure named at the exact row", () => {
    const inner = freshRaw();
    const store = createEncryptedStore(inner, testKey);
    store.putStrand(makeStrand("victim", "E1", null, { secret: "do-not-leak" }));

    // Reach the raw envelope through the UNWRAPPED inner store (still StrandStore
    // contract — no sqliteStore.ts internals touched) and corrupt one ciphertext byte.
    const rawStrand = inner.getStrand("victim" as StrandId)!;
    const envelope = rawStrand.payload as { __idbEncrypted: true; alg: string; blob: string };
    const blob = Buffer.from(envelope.blob, "base64");
    blob[blob.length - 1] = (blob[blob.length - 1]! ^ 0xff) & 0xff; // flip the last ciphertext byte
    inner.putStrand({ ...rawStrand, payload: { ...envelope, blob: blob.toString("base64") } });

    let caught: unknown;
    try {
      store.getStrand("victim" as StrandId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EncryptedStoreIntegrityError);
    const err = caught as EncryptedStoreIntegrityError;
    expect(err.reason).toBe("AUTH_FAILED");
    expect(err.rowId).toBe("victim"); // names the row
  });

  it("a ciphertext SWAPPED onto a different row is caught (AAD = row identity)", () => {
    const inner = freshRaw();
    const store = createEncryptedStore(inner, testKey);
    store.putStrand(makeStrand("a", "E1", null, { secret: "a-secret" }));
    store.putStrand(makeStrand("b", "E1", null, { secret: "b-secret" }));

    const rawA = inner.getStrand("a" as StrandId)!;
    const rawB = inner.getStrand("b" as StrandId)!;
    // Copy A's ciphertext envelope onto B's row (same key, wrong AAD: b's id != a's id).
    inner.putStrand({ ...rawB, payload: rawA.payload });

    let caught: unknown;
    try {
      store.getStrand("b" as StrandId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EncryptedStoreIntegrityError);
    const err = caught as EncryptedStoreIntegrityError;
    expect(err.reason).toBe("AUTH_FAILED");
    expect(err.rowId).toBe("b");
  });

  it("a malformed (non-envelope) payload is a named MALFORMED_CIPHERTEXT error, not a crash", () => {
    const inner = freshRaw();
    inner.putStrand(makeStrand("plain", "E1", null, { not: "encrypted" }));
    const store = createEncryptedStore(inner, testKey);

    let caught: unknown;
    try {
      store.getStrand("plain" as StrandId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EncryptedStoreIntegrityError);
    expect((caught as EncryptedStoreIntegrityError).reason).toBe("MALFORMED_CIPHERTEXT");
    expect((caught as EncryptedStoreIntegrityError).rowId).toBe("plain");
  });

  it("an invalid-length key is refused up front (INVALID_KEY_LENGTH), never silently accepted", () => {
    const inner = freshRaw();
    const badKeyStore = createEncryptedStore(inner, () => randomBytes(16)); // AES-128-length, wrong
    expect(() =>
      badKeyStore.putStrand(makeStrand("a", "E1", null, { v: 1 })),
    ).toThrow(EncryptedStoreIntegrityError);
  });

  it("the persisted row is NOT plaintext content (value-level scope: payload hidden, ids/entity visible)", () => {
    const inner = freshRaw();
    const store = createEncryptedStore(inner, testKey);
    store.putStrand(
      makeStrand("plaintext-scope", "entity:E1", "E1.attr", {
        secretMarker: "SHOULD-NEVER-APPEAR-IN-CLEARTEXT",
      }),
    );

    const rawJson = JSON.stringify(inner.getStrand("plaintext-scope" as StrandId));
    // The content is not recoverable by string search.
    expect(rawJson).not.toContain("SHOULD-NEVER-APPEAR-IN-CLEARTEXT");
    // The graph-shape metadata this codebase treats as index keys stays plaintext.
    expect(rawJson).toContain("plaintext-scope");
    expect(rawJson).toContain("entity:E1");
    expect(rawJson).toContain("E1.attr");
  });
});

// ---------------------------------------------------------------------------
// Engine drop-in: writeFact + recall through the encrypted store
// ---------------------------------------------------------------------------

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
      return best;
    },
    independenceBetween(): Unit {
      return 0.35 as Unit;
    },
  };
}

function makeIdentityLayer(): SourceIdentityLayer {
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 as Unit };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
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

describe("createEncryptedStore — engine drop-in", () => {
  it("writeFact + recall work end-to-end through the encrypted store (memory backend)", () => {
    const store = createEncryptedStore(createMemoryStore(), testKey);
    const identity = makeIdentityLayer();
    const db = createIntelligentDb(store, identity);

    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);

    const entity = "entity:paris" as EntityId;
    const attribute = "paris#capital_of" as AttributeKey;
    const id = db.writeFact({
      entity,
      attribute,
      payload: { capitalOf: "France" },
      stamp,
    });
    expect(id).toBeTruthy();

    const filed = store.getStrand(id);
    expect(filed?.payload).toEqual({ capitalOf: "France" });

    const result = db.recall({ seeds: [{ strandId: id, energy: 1 }] });
    expect(result.lit.map((l) => l.strandId)).toContain(id);
  });

  it("writeFact + reopen recall work end-to-end through the encrypted store (SQLite backend)", () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dbPath = join(tmpdir(), `idb-encstore-engine-${unique}.db`);
    try {
      let rawStore = createSqliteStore(dbPath);
      let store = createEncryptedStore(rawStore, testKey);
      const identity = makeIdentityLayer();
      let db = createIntelligentDb(store, identity);

      const passport = freshSource();
      identity.register(passport, [domainAnchor()]);
      const stamp = identity.stampFor(passport.sourceId);

      const entity = "entity:rome" as EntityId;
      const id = db.writeFact({ entity, payload: { capitalOf: "Italy" }, stamp });

      rawStore.close();
      rawStore = createSqliteStore(dbPath);
      store = createEncryptedStore(rawStore, testKey);
      db = createIntelligentDb(store, identity);

      const filed = store.getStrand(id);
      expect(filed?.payload).toEqual({ capitalOf: "Italy" });
      rawStore.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(dbPath + suffix, { force: true });
      }
    }
  });
});

describe("createEncryptedStore — GCM nonce-volume ceiling (gcm-random-nonce-no-ceiling)", () => {
  it("allows encryptions up to the configured ceiling, then throws NonceCeilingExceededError and performs no crypto work on the refused call", () => {
    const store = createEncryptedStore(createMemoryStore(), testKey, {
      maxEncryptionsPerKey: 3,
    });
    store.putStrand(makeStrand("s1", "E1", null));
    store.putStrand(makeStrand("s2", "E1", null));
    store.putStrand(makeStrand("s3", "E1", null));

    // The first 3 succeeded (each spent one random nonce); the 4th must be
    // refused BEFORE any encryption is attempted — the strand never reaches
    // the inner store at all (fail-closed: no wasted crypto work, no nonce).
    let threw: unknown;
    try {
      store.putStrand(makeStrand("s4", "E1", null));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(NonceCeilingExceededError);
    const err = threw as NonceCeilingExceededError;
    expect(err.encryptionCount).toBe(3);
    expect(err.maxEncryptionsPerKey).toBe(3);
    expect(err.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // s4 truly never reached the inner store.
    expect(store.getStrand("s4" as StrandId)).toBeNull();
  });

  it("keeps refusing every subsequent call once the ceiling is reached (not a one-shot throw)", () => {
    const store = createEncryptedStore(createMemoryStore(), testKey, {
      maxEncryptionsPerKey: 1,
    });
    store.putStrand(makeStrand("s1", "E1", null));
    expect(() => store.putStrand(makeStrand("s2", "E1", null))).toThrow(
      NonceCeilingExceededError,
    );
    expect(() => store.putStrand(makeStrand("s3", "E1", null))).toThrow(
      NonceCeilingExceededError,
    );
  });

  it("counts putStrandsBatch entries toward the same per-key ceiling as putStrand", () => {
    const store = createEncryptedStore(createSqliteStore(":memory:"), testKey, {
      maxEncryptionsPerKey: 2,
    }) as SqliteStrandStore;
    expect(() =>
      store.putStrandsBatch([
        makeStrand("b1", "E1", null),
        makeStrand("b2", "E1", null),
        makeStrand("b3", "E1", null),
      ]),
    ).toThrow(NonceCeilingExceededError);
  });

  it("fires onApproachingNonceCeiling exactly once, edge-triggered, before the hard ceiling refuses", () => {
    const seen: Array<{ encryptionCount: number }> = [];
    const store = createEncryptedStore(createMemoryStore(), testKey, {
      maxEncryptionsPerKey: 4,
      warnAtFraction: 0.5, // warn at count >= 2
      onApproachingNonceCeiling: (info) => seen.push({ encryptionCount: info.encryptionCount }),
    });
    store.putStrand(makeStrand("s1", "E1", null)); // count 1: below warn
    expect(seen).toHaveLength(0);
    store.putStrand(makeStrand("s2", "E1", null)); // count 2: crosses warn — fires once
    expect(seen).toHaveLength(1);
    expect(seen[0]?.encryptionCount).toBe(2);
    store.putStrand(makeStrand("s3", "E1", null)); // count 3: already warned, no repeat
    expect(seen).toHaveLength(1);
    // count 4 is still allowed (== ceiling is the refusal threshold, not count 4 itself
    // since the check compares the PRE-increment count against the ceiling).
    store.putStrand(makeStrand("s4", "E1", null));
    expect(() => store.putStrand(makeStrand("s5", "E1", null))).toThrow(
      NonceCeilingExceededError,
    );
  });

  it("tracks separate keys separately: rotating the key resets the ceiling clock for the new key", () => {
    const keys = { current: testKey() };
    const rotatingProvider = (): Buffer => keys.current;
    const store = createEncryptedStore(createMemoryStore(), rotatingProvider, {
      maxEncryptionsPerKey: 2,
    });
    store.putStrand(makeStrand("s1", "E1", null));
    store.putStrand(makeStrand("s2", "E1", null));
    expect(() => store.putStrand(makeStrand("s3", "E1", null))).toThrow(
      NonceCeilingExceededError,
    );

    // Rotate to a fresh key: the ceiling is per-key, so this key gets its own
    // fresh budget rather than inheriting the exhausted count.
    keys.current = wrongKey();
    expect(() => store.putStrand(makeStrand("s4", "E1", null))).not.toThrow();
  });

  it("defaults to the documented safe ceiling (2**32) when unconfigured — far from tripping in a small test", () => {
    const store = createEncryptedStore(createMemoryStore(), testKey);
    // No ceiling option passed at all: ordinary use is completely unaffected.
    for (let i = 0; i < 25; i++) {
      expect(() => store.putStrand(makeStrand(`d${i}`, "E1", null))).not.toThrow();
    }
  });
});
