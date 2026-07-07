/**
 * strandCloneParity.test.ts — regression for `strand-aliasing-backend-inconsistent`
 * (HIGH, `audit-api-dx-types-verified.md`).
 *
 * THE BUG (pre-fix): `MemoryStrandStore.getStrand()`/`strandsByEntity()`/
 * `strandsByAttribute()`/`allStrands()`/`neighbors()` returned the LIVE
 * `strandMap` reference, never a copy — unlike `Edge`, which the in-memory store
 * already ran through `freezeEdge` (clone-on-read). `SqliteStrandStore.getStrand()`
 * happened to be safe by ACCIDENT of implementation (every read re-parses a fresh
 * object from a JSON column), never by a documented, enforced contract. The two
 * backends therefore diverged on a load-bearing property: a caller that reads a
 * `Strand` and mutates it in place (the documented `mutate-then-putStrand()` idiom
 * `forgetting/consolidation.ts`'s `demote()` uses) silently corrupted the
 * in-memory store's OWN state with no `putStrand()` call — and, because
 * `MemoryStrandStore` has no real `beginTxn`, a surrounding compound op that threw
 * before ever calling `putStrand()` had no way to "un-happen" a mutation that had
 * already landed. `Strand`'s belief-state fields (`fact_state`, `tier`,
 * `outranked_by`, `description_value`, `external_reobservation_count`,
 * `contradiction_set`, `co_equal_claim_cardinality`, `last_tier_reason`,
 * `register`) are deliberately NOT `readonly` (the mutate-then-`putStrand` idiom
 * needs them mutable) — which makes clone-ON-READ/WRITE, not type-level
 * immutability, the only thing that can close this gap. See `memoryStore.ts`'s
 * `cloneStrand` doc for the fix's rationale on that backend.
 *
 * THIS FILE proves the fix holds IDENTICALLY on BOTH backends, over the exact
 * read paths a real compound op uses (`getStrand`, `strandsByAttribute`,
 * `strandsByEntity`, `neighbors`) and the write boundary (`putStrand`) — so a
 * future regression on EITHER backend is caught, not just the one the original
 * audit happened to reproduce against.
 */

import { describe, expect, it } from "vitest";

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
import { createSqliteStore } from "./sqliteStore.js";
import type { StrandStore } from "./StrandStore.js";

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

function makeEdge(id: string, from: string, to: string): Edge {
  return {
    id: id as EdgeId,
    from: from as StrandId,
    to: to as StrandId,
    edgeType: EdgeType.SHARED_ENTITY,
    link_confidence: 1,
    provenance_independence: 1,
    recency: 1,
    w: computeEdgeWeight(1, 1, 1),
    out_weight_sum: 0,
  };
}

/** Corrupt a strand the way the real `demote()` does, in place. */
function mutateLikeDemote(s: Strand): void {
  s.fact_state = FactState.DEMOTED;
  s.tier = Tier.ARCHIVE;
  s.outranked_by = "edge:injected-outranker" as EdgeId;
  s.description_value = 999;
  s.external_reobservation_count = 999;
  s.co_equal_claim_cardinality = 999;
}

const backends: ReadonlyArray<{ name: string; make: () => StrandStore }> = [
  { name: "MemoryStrandStore", make: () => createMemoryStore() },
  { name: "SqliteStrandStore (:memory:)", make: () => createSqliteStore(":memory:") },
];

describe.each(backends)("Strand clone-on-read/write parity — $name", ({ make }) => {
  it("mutating a strand returned by getStrand() never corrupts the store's own copy", () => {
    const store = make();
    const id = "strand:x" as StrandId;
    store.putStrand(makeStrand("strand:x", "E1", "E1.color"));

    const got = store.getStrand(id);
    expect(got).not.toBeNull();
    mutateLikeDemote(got!);

    // The caller's mutation must be real (proves this is an aliasing test, not a
    // silent no-op) ...
    expect(got!.fact_state).toBe(FactState.DEMOTED);

    // ... but the store's OWN copy, read fresh, must be UNCHANGED: no putStrand()
    // was ever called.
    const again = store.getStrand(id);
    expect(again).not.toBeNull();
    expect(again!.fact_state).toBe(FactState.LIVE);
    expect(again!.tier).toBe(Tier.WARM);
    expect(again!.outranked_by).toBeNull();
    expect(again!.description_value).toBe(0);
    expect(again!.external_reobservation_count).toBe(0);
  });

  it("mutating a strand returned via strandsByAttribute() never corrupts the store", () => {
    const store = make();
    const id = "strand:y" as StrandId;
    store.putStrand(makeStrand("strand:y", "E1", "E1.color"));

    const [viaAttr] = store.strandsByAttribute("E1.color" as AttributeKey);
    expect(viaAttr).toBeDefined();
    mutateLikeDemote(viaAttr!);

    const reread = store
      .strandsByAttribute("E1.color" as AttributeKey)
      .find((s) => s.id === id);
    expect(reread).toBeDefined();
    expect(reread!.fact_state).toBe(FactState.LIVE);
    expect(reread!.outranked_by).toBeNull();

    const viaGetStrand = store.getStrand(id);
    expect(viaGetStrand!.fact_state).toBe(FactState.LIVE);
  });

  it("mutating a strand returned via strandsByEntity() never corrupts the store", () => {
    const store = make();
    const id = "strand:z" as StrandId;
    store.putStrand(makeStrand("strand:z", "E2", null));

    const [viaEntity] = store.strandsByEntity("E2" as EntityId);
    expect(viaEntity).toBeDefined();
    mutateLikeDemote(viaEntity!);

    const reread = store.getStrand(id);
    expect(reread!.fact_state).toBe(FactState.LIVE);
  });

  it("mutating a strand returned via neighbors() never corrupts the store", () => {
    const store = make();
    const fromId = "strand:from" as StrandId;
    const toId = "strand:to" as StrandId;
    store.putStrand(makeStrand("strand:from", "E3", null));
    store.putStrand(makeStrand("strand:to", "E3", null));
    store.putEdge(makeEdge("edge:from-to", "strand:from", "strand:to"));

    const [view] = store.neighbors(fromId);
    expect(view).toBeDefined();
    mutateLikeDemote(view!.strand);

    const reread = store.getStrand(toId);
    expect(reread!.fact_state).toBe(FactState.LIVE);
  });

  it("mutating a strand returned via allStrands() never corrupts the store", () => {
    const store = make();
    const id = "strand:w" as StrandId;
    store.putStrand(makeStrand("strand:w", "E4", null));

    const [viaScan] = [...store.allStrands()];
    expect(viaScan).toBeDefined();
    mutateLikeDemote(viaScan!);

    const reread = store.getStrand(id);
    expect(reread!.fact_state).toBe(FactState.LIVE);
  });

  it("mutating the object passed to putStrand AFTER the call never retroactively changes the stored copy", () => {
    const store = make();
    const s = makeStrand("strand:v", "E5", null);
    store.putStrand(s);

    // Mutate the caller's own local reference post-put — the store must have taken
    // its own private copy at put-time, not aliased the caller's object.
    mutateLikeDemote(s);

    const got = store.getStrand("strand:v" as StrandId);
    expect(got!.fact_state).toBe(FactState.LIVE);
    expect(got!.tier).toBe(Tier.WARM);
  });

  it("the two backends behave IDENTICALLY: getStrand() never returns the same object twice", () => {
    // Not a public contract requirement in general (SQLite reparses every time;
    // the in-memory store now clones every time too) — but asserting NON-identity
    // on both backends is the sharpest possible proof the aliasing hole is closed
    // on both, not just "mutation doesn't stick" (which a value-equal-but-aliased
    // object could also satisfy by coincidence in a simpler repro).
    const store = make();
    store.putStrand(makeStrand("strand:u", "E6", null));
    const first = store.getStrand("strand:u" as StrandId);
    const second = store.getStrand("strand:u" as StrandId);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
