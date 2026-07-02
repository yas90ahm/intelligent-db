/**
 * canonicalHash.test.ts — CANONICAL content_hash: "same claim" is a function of the
 * payload VALUE, never of key insertion order.
 *
 * THE BUG BEING PINNED: `hashPayload` (api.ts) hashed raw `JSON.stringify(payload)`,
 * so `{ city: "Tokyo", since: 2024 }` and `{ since: 2024, city: "Tokyo" }` minted
 * DIFFERENT content_hash values — silently breaking every "same claim" comparison:
 *   - `#deriveAgreementSet` (corroboration undercounting: an agreeing strand whose
 *     payload keys arrived in a different order stopped counting as agreement),
 *   - the AGENT_RELAY ECHO GATE (class inheritance refused for a byte-reordered
 *     relay of the SAME object ⇒ a fresh per-source class minted ⇒ the exact
 *     manufactured-corroboration hole the relay fix closed, re-opened),
 *   - disown's dedupe-by-root (a reordered same-root flood counted twice).
 *
 * THE FIX: `core/canonicalJson.ts` — normalize through JSON.parse(JSON.stringify(…))
 * (exact JSON semantics: toJSON honored, undefined-valued keys dropped, non-finite
 * numbers → null, cycles throw), then serialize with object keys sorted at every
 * depth and array order PRESERVED. hashPayload feeds the hash from that.
 *
 * Test tiers:
 *   1. UNIT — canonicalJson's contract (reordered objects equal, nested included;
 *      arrays order-SENSITIVE; undefined-valued keys ignored; JSON-semantics edge
 *      cases pinned).
 *   2. INTEGRATION — two writeFacts with key-reordered identical payloads mint
 *      strands with EQUAL content_hash.
 *   3. ADVERSARIAL REGRESSION — an AGENT_RELAY citing a strand whose payload was
 *      key-reordered still INHERITS the witness's independence class (the echo gate
 *      recognizes the same claim) instead of minting a fresh per-source class.
 *
 * IDENTITY WIRING mirrors relayFix.test.ts: an OPTIMISTIC anchor port (every source
 * DOMAIN-anchored so ingest lands LIVE; `independenceBetween` ⇒ 1 so Stage-2 never
 * rescues a count downward) — the direction that EXPOSES a class-inheritance failure.
 */

import { describe, expect, it } from "vitest";

import {
  AnchorClass,
  EdgeType,
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  AttributeKey,
  EntityId,
  IntelligentDb,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRef,
  SourceRegistryPort,
  StakeLedgerPort,
  Strand,
  StrandId,
  StrandStore,
  Unit,
} from "../index.js";

import { canonicalJson } from "../core/canonicalJson.js";
import { bareStamp } from "../__bench__/fixtures.js";

const SRC_A = "src:alpha" as SourceId; // the original witness
const SRC_B = "src:beta" as SourceId; // the relaying agent

const ENTITY = "entity:canonical" as EntityId;
const ATTR = "canonical#claim" as AttributeKey;

/** The exact fallback class string `provenanceRootFromStamp` mints. */
function legacyClassOf(src: SourceId): string {
  return `class:${String(src)}`;
}

/** Optimistic identity layer (mirrors relayFix.test.ts — see the header). */
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
      return 1;
    },
  };
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 };
  const stake: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({ sources, anchors, reputation, stake });
}

function rig(store: StrandStore): IntelligentDb {
  return createIntelligentDb(store, optimisticIdentity());
}

function get(store: StrandStore, id: StrandId): Strand {
  const s = store.getStrand(id);
  expect(s).not.toBeNull();
  return s as Strand;
}

// ---------------------------------------------------------------------------
// 1. UNIT — the canonicalJson contract
// ---------------------------------------------------------------------------

describe("canonicalJson — key-order-independent, array-order-sensitive, exact JSON semantics", () => {
  it("key-reordered identical objects (including nested ones) serialize identically", () => {
    expect(canonicalJson({ city: "Tokyo", since: 2024 })).toBe(
      canonicalJson({ since: 2024, city: "Tokyo" }),
    );
    // Nested at every depth — reordering inside arrays of objects too.
    const a = { outer: { x: 1, y: { p: true, q: null } }, list: [{ m: 1, n: 2 }] };
    const b = { list: [{ n: 2, m: 1 }], outer: { y: { q: null, p: true }, x: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("arrays stay ORDER-SENSITIVE: element order is part of the value", () => {
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
    expect(canonicalJson({ k: [1, 2] })).not.toBe(canonicalJson({ k: [2, 1] }));
  });

  it("undefined-valued keys are ignored (JSON.stringify drops them)", () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("pins the JSON-semantics edge cases: primitives, non-finite numbers, top-level undefined", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("s")).toBe('"s"');
    // Non-finite numbers normalize to null (JSON.stringify semantics).
    expect(canonicalJson({ n: Number.NaN })).toBe(canonicalJson({ n: null }));
    // A top-level value JSON cannot represent canonicalizes as null — the same
    // shape the engine's `payload ?? null` discipline has always produced.
    expect(canonicalJson(undefined)).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// 2. INTEGRATION — content_hash equality across key-reordered writeFacts
// ---------------------------------------------------------------------------

describe("content_hash — a function of the value, not of key insertion order", () => {
  it("two writeFacts with key-reordered identical payloads mint EQUAL content_hash", () => {
    const store = createMemoryStore();
    const db = rig(store);

    const id1 = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { city: "Tokyo", since: 2024 },
      stamp: bareStamp(SRC_A),
    });
    const id2 = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { since: 2024, city: "Tokyo" },
      stamp: bareStamp(SRC_B),
    });

    expect(get(store, id1).content_hash).toBe(get(store, id2).content_hash);

    // A genuinely DIFFERENT value still hashes differently (no over-collapse).
    const id3 = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { city: "Kyoto", since: 2024 },
      stamp: bareStamp(SRC_A),
    });
    expect(get(store, id3).content_hash).not.toBe(get(store, id1).content_hash);
  });
});

// ---------------------------------------------------------------------------
// 3. ADVERSARIAL REGRESSION — the AGENT_RELAY echo gate across reordering
// ---------------------------------------------------------------------------

describe("AGENT_RELAY echo gate — class inheritance survives key reordering", () => {
  it("a relay citing a strand whose payload keys were reordered still inherits the witness's class", () => {
    const store = createMemoryStore();
    const db = rig(store);

    // A witnesses and files the claim with one key order…
    const idA = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { city: "Tokyo", since: 2024 },
      stamp: bareStamp(SRC_A),
    });

    // …and B relays the SAME object, re-serialized with the other key order (what
    // any JSON round-trip through another agent's runtime can do to key order).
    const idB = db.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { since: 2024, city: "Tokyo" },
      stamp: bareStamp(SRC_B),
      causalOrigin: { kind: "AGENT_RELAY", consultedStrandIds: [idA] },
    });

    // The echo gate recognized the SAME CLAIM: B's root carries A's independence
    // class — never a fresh class:B (which would be manufactured corroboration).
    const classesB = get(store, idB)
      .provenance.map((r) => String(r.independenceClass))
      .sort();
    expect(classesB).toEqual([legacyClassOf(SRC_A)]);
    expect(classesB).not.toContain(legacyClassOf(SRC_B));

    // The DERIVATION citation edge is minted as usual (derived → witness).
    const cites = store.outEdges(idB).filter((e) => e.edgeType === EdgeType.DERIVATION);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.to).toBe(idA);
  });
});
