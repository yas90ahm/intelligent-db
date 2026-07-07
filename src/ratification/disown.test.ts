/**
 * disown.test.ts — THE DOWNSTREAM TRANSITIVE-CLOSURE disown sweep
 * (`downstreamDisownSweep`), pillar 4: "claws back reputation across everything
 * that anchor ever asserted ... including credit conferred on OTHER sources that
 * used these strands as a witness."
 *
 * Pins every hard requirement:
 *  - a DERIVED strand computed (via DERIVATION) from a disowned seed is DEMOTED;
 *  - a coincidentally-agreeing strand of a DIFFERENT independence class with no
 *    DERIVATION path is NOT touched (the bounded requirement);
 *  - IDEMPOTENT: a second sweep is a complete no-op;
 *  - CYCLE-SAFE: mutual DERIVATION edges complete without hanging;
 *  - DEMOTE-NEVER-DELETE: the demoted strand is still retrievable, content_hash +
 *    provenance (the archive stub) intact;
 *  - DEDUPE BY ROOT: a seed sharing one content_hash counts once.
 *
 * Exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  downstreamDisownSweep,
  createReputationLedger,
  DEFAULT_REPUTATION_PARAMS,
  createMemoryStore,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "../index.js";

import type {
  Strand,
  StrandId,
  Edge,
  EntityId,
  AttributeKey,
  SourceId,
  Unit,
  EpochMs,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  ContentHash,
  StrandStore,
  ReputationLedger,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

/** Build a strand. `roots` are (class, sourceId) pairs; `origin` defaults OBSERVED. */
function makeStrand(opts: {
  idRaw: string;
  contentHashRaw?: string;
  origin?: FactOrigin;
  roots: ReadonlyArray<{ classRaw: string; sourceIdRaw: string | null; rootIdRaw?: string }>;
}): Strand {
  const { idRaw, origin = FactOrigin.OBSERVED, roots } = opts;
  const provenance: ProvenanceRoot[] = roots.map((r, i) => ({
    rootId: (r.rootIdRaw ?? `${idRaw}#root${i}`) as ProvenanceRootId,
    independenceClass: r.classRaw as IndependenceClassId,
    sourceId: r.sourceIdRaw === null ? null : (r.sourceIdRaw as SourceId),
    establishedAt: NOW,
  }));
  return {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload: { note: idRaw },
    content_hash: (opts.contentHashRaw ?? `hash:${idRaw}`) as ContentHash,
    origin,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance,
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
  };
}

/**
 * A DERIVATION edge: `derived` was computed FROM `witness`
 * (derived-fact -> the strands it was computed from). Taint flows the other way:
 * disowning `witness` taints `derived`.
 */
function derivationEdge(derived: StrandId, witness: StrandId): Edge {
  return {
    id: asEdgeId(`deriv:${String(derived)}->${String(witness)}`),
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

/** A reputation ledger with a generous flat cap so earned credit is observable. */
function ledgerWithCap(cap = 0.9): ReputationLedger {
  // Pin the decay-on-read clock to the test's logical NOW so reads at NOW are Δt=0
  // (the fixture earns at the synthetic NOW; without pinning, the default Date.now()
  // clock would treat the whole gap to the real wall clock as dormancy).
  return createReputationLedger(() => cap as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
}

/** Earn a source up off the floor so a later contradiction is observable. */
function earn(ledger: ReputationLedger, src: SourceId, n = 30): void {
  for (let i = 0; i < n; i++) ledger.ratify(src, NOW);
}

describe("downstreamDisownSweep — downstream demote", () => {
  it("a DERIVED strand computed from a disowned seed is DEMOTED with outranked_by set", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    // Seed: an OBSERVED strand the fraudulent source asserted.
    const seed = makeStrand({
      idRaw: "strand:seed",
      roots: [{ classRaw: "class:A", sourceIdRaw: fraud }],
    });
    // Downstream: a DERIVED fact computed FROM the seed.
    const derived = makeStrand({
      idRaw: "strand:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: fraud }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    expect(res.demotedDownstream).toContain(derived.id);
    const after = store.getStrand(derived.id)!;
    expect(after.fact_state).toBe(FactState.DEMOTED);
    expect(after.outranked_by).not.toBeNull();
    // The seed itself is the direct clawback, not a downstream demotion.
    expect(res.seedClawedBack).toEqual([seed.id]);
  });

  it("taint propagates TRANSITIVELY: derived-of-derived is also demoted", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const d1 = makeStrand({ idRaw: "s:d1", origin: FactOrigin.DERIVED, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const d2 = makeStrand({ idRaw: "s:d2", origin: FactOrigin.DERIVED, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(seed);
    store.putStrand(d1);
    store.putStrand(d2);
    store.putEdge(derivationEdge(d1.id, seed.id)); // d1 derived from seed
    store.putEdge(derivationEdge(d2.id, d1.id)); //   d2 derived from d1

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    expect(res.demotedDownstream).toEqual(expect.arrayContaining([d1.id, d2.id]));
    expect(store.getStrand(d1.id)!.fact_state).toBe(FactState.DEMOTED);
    expect(store.getStrand(d2.id)!.fact_state).toBe(FactState.DEMOTED);
  });
});

describe("downstreamDisownSweep — fails closed on a dangling edge", () => {
  it("a DERIVATION edge whose `from` was never putStrand'd is SKIPPED: no throw, no partial sweep", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // A SECOND, real downstream derived strand — proves the sweep does not merely
    // abort early once it meets the dangling edge; the rest of the graph still
    // processes to completion (no PARTIAL sweep).
    const realDerived = makeStrand({
      idRaw: "s:real-derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: fraud }],
    });
    store.putStrand(seed);
    store.putStrand(realDerived);
    store.putEdge(derivationEdge(realDerived.id, seed.id));

    // The DANGLING edge: its `from` (the derived side) was NEVER putStrand'd —
    // `disown.ts`'s module doc: "FAILS CLOSED: a dangling edge / missing strand
    // skips that NODE only."
    const danglingId = asStrandId("s:never-stored");
    store.putEdge(derivationEdge(danglingId, seed.id));

    let res: ReturnType<typeof downstreamDisownSweep> | undefined;
    expect(() => {
      res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);
    }).not.toThrow();

    // NOT a partial sweep: the real downstream strand is still demoted, and the
    // seed's direct clawback still happened.
    expect(res!.demotedDownstream).toContain(realDerived.id);
    expect(store.getStrand(realDerived.id)!.fact_state).toBe(FactState.DEMOTED);
    expect(res!.seedClawedBack).toEqual([seed.id]);

    // The dangling id was never resolved to a strand: it cannot appear anywhere
    // in the receipt, and the store still (correctly) reports it unknown.
    expect(res!.demotedDownstream).not.toContain(danglingId);
    expect(res!.survivedDemotion).not.toContain(danglingId);
    expect(store.getStrand(danglingId)).toBeNull();
  });
});

describe("downstreamDisownSweep — bounded: coincidental different-class agreement is NOT touched", () => {
  it("an independent-class strand with NO derivation path stays LIVE and its source keeps reputation", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;
    const honest = "src:honest" as SourceId;

    // Earn the honest source some reputation up off the floor.
    earn(ledger, honest);
    const honestBefore = ledger.scoreOf(honest);
    expect(honestBefore).toBeGreaterThan(0.05);

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // A coincidentally-agreeing OBSERVED strand in a DIFFERENT independence class,
    // with NO DERIVATION edge to the seed — it agreed independently.
    const coincidental = makeStrand({
      idRaw: "s:coincidental",
      roots: [{ classRaw: "class:INDEPENDENT", sourceIdRaw: honest }],
    });
    store.putStrand(seed);
    store.putStrand(coincidental);
    // NOTE: no DERIVATION edge between them.

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    // Untouched: still LIVE, no demotion, source reputation unchanged.
    expect(res.demotedDownstream).not.toContain(coincidental.id);
    expect(store.getStrand(coincidental.id)!.fact_state).toBe(FactState.LIVE);
    expect(res.contradictedSources).not.toContain(honest);
    expect(ledger.scoreOf(honest)).toBe(honestBefore);
  });

  it("a DERIVATION-reachable strand of a DIFFERENT independence class is DEMOTED but its source is NOT contradicted", () => {
    // The two decisions are separate: existence-rests-on (demote) vs credit-funded-by
    // (contradict). A derived strand backed only by a genuinely independent class is
    // demoted (it rested on tainted input) yet its source keeps its reputation.
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;
    const independent = "src:independent" as SourceId;

    earn(ledger, independent);
    const indepBefore = ledger.scoreOf(independent);

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      // Backed ONLY by an independent class/source (no tainted class on it).
      roots: [{ classRaw: "class:INDEPENDENT", sourceIdRaw: independent }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    // Demoted (existence rested on tainted input) ...
    expect(res.demotedDownstream).toContain(derived.id);
    expect(store.getStrand(derived.id)!.fact_state).toBe(FactState.DEMOTED);
    // ... but NOT contradicted (its class is not the tainted class — coincidental).
    expect(res.contradictedSources).not.toContain(independent);
    expect(ledger.scoreOf(independent)).toBe(indepBefore);
  });

  it("a downstream source IN the tainted class IS contradicted", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;
    const downstream = "src:downstream" as SourceId;

    earn(ledger, downstream);
    const before = ledger.scoreOf(downstream);
    expect(before).toBeGreaterThan(0.05);

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // A derived strand whose OWN root is in the tainted class:A, sourced by downstream.
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: downstream }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    expect(res.contradictedSources).toContain(downstream);
    expect(ledger.scoreOf(downstream)).toBeLessThan(before);
  });

  it("a downstream tainted-class source is SCARRED (non-decaying): its LCB stays suppressed after the clock advances, while a coincidental independent agreer is NOT scarred (F3)", () => {
    // BATCH-4 M3 wiring: the disowned source's own crater scars permanently; this
    // proves the TRANSITIVELY-tainted downstream source ALSO receives the permanent,
    // non-decaying scar — its LCB drop cannot be waited out — while the F3 guard still
    // spares a coincidental independent agreer (untainted class => no scar, no claw).
    const store: StrandStore = createMemoryStore();
    const DAY_MS = 86_400_000;
    // A MOVABLE clock so we can advance time and prove the scar does NOT decay away.
    let nowMs = NOW as number;
    const ledger = createReputationLedger(
      () => 0.9 as Unit,
      DEFAULT_REPUTATION_PARAMS,
      () => asEpochMs(nowMs),
    );
    const fraud = "src:fraud" as SourceId;
    const tainted = "src:tainted" as SourceId; // downstream, IN the tainted class:A
    const coincidental = "src:coincidental" as SourceId; // independent agreer (untainted)

    earn(ledger, tainted);
    earn(ledger, coincidental);
    const taintedEarned = ledger.scoreOf(tainted);
    const coincidentalEarned = ledger.scoreOf(coincidental);
    expect(taintedEarned).toBeGreaterThan(0.05);

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // Rests on the disowned seed AND is itself backed by the tainted class:A.
    const derivedTainted = makeStrand({
      idRaw: "s:derived-tainted",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: tainted }],
    });
    // A coincidental independent strand: agrees but has NO derivation path and an
    // untainted class — the F3 guard must spare it entirely.
    const coincidentalStrand = makeStrand({
      idRaw: "s:coincidental",
      roots: [{ classRaw: "class:INDEPENDENT", sourceIdRaw: coincidental }],
    });
    store.putStrand(seed);
    store.putStrand(derivedTainted);
    store.putStrand(coincidentalStrand);
    store.putEdge(derivationEdge(derivedTainted.id, seed.id));

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, asEpochMs(nowMs));

    // The tainted-class downstream source is contradicted AND permanently scarred.
    expect(res.contradictedSources).toContain(tainted);
    const taintedState = ledger.stateOf(tainted)!;
    expect(taintedState.scarBeta).toBeGreaterThan(0); // NON-DECAYING scar stamped
    const taintedRightAfter = ledger.scoreOf(tainted);
    expect(taintedRightAfter).toBeLessThan(taintedEarned);

    // F3 guard: the coincidental independent agreer is untouched — no claw, no scar.
    expect(res.contradictedSources).not.toContain(coincidental);
    expect(ledger.stateOf(coincidental)!.scarBeta).toBe(0);
    expect(ledger.scoreOf(coincidental)).toBe(coincidentalEarned);

    // ADVANCE the clock far into the future (~36 half-lives). A non-scarring (decaying)
    // contradiction would let the source's LCB recover toward the prior; the scar does
    // NOT decay, so the tainted source's drop LASTS — its LCB stays below its earned
    // value, while the untouched coincidental source merely drifts to the prior.
    nowMs = (NOW as number) + 36 * 90 * DAY_MS;
    expect(ledger.scoreOf(tainted)).toBeLessThan(taintedEarned);
  });
});

describe("downstreamDisownSweep — idempotent", () => {
  it("a SECOND sweep of the same source is a complete no-op", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({ idRaw: "s:derived", origin: FactOrigin.DERIVED, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    const first = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);
    expect(first.demotedDownstream).toContain(derived.id);

    const second = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);
    expect(second.seedClawedBack).toEqual([]);
    expect(second.demotedDownstream).toEqual([]);
    expect(second.contradictedSources).toEqual([]);
    expect(second.visitedCount).toBe(0);
  });
});

describe("downstreamDisownSweep — cycle-safe", () => {
  it("mutual DERIVATION edges complete without hanging; each strand visited once", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const a = makeStrand({ idRaw: "s:a", origin: FactOrigin.DERIVED, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const b = makeStrand({ idRaw: "s:b", origin: FactOrigin.DERIVED, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    store.putStrand(seed);
    store.putStrand(a);
    store.putStrand(b);
    store.putEdge(derivationEdge(a.id, seed.id)); // a derived from seed
    store.putEdge(derivationEdge(a.id, b.id)); //    a derived from b
    store.putEdge(derivationEdge(b.id, a.id)); //    b derived from a  (cycle a<->b)

    const res = downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    // Completed (no hang). Both a and b reached and demoted exactly once.
    expect(res.demotedDownstream).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(res.demotedDownstream.filter((id) => id === a.id).length).toBe(1);
    expect(res.demotedDownstream.filter((id) => id === b.id).length).toBe(1);
    // visited = seed + a + b.
    expect(res.visitedCount).toBe(3);
  });
});

describe("downstreamDisownSweep — demote-never-delete", () => {
  it("the demoted downstream strand is still retrievable with content_hash + provenance intact", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;

    const seed = makeStrand({ idRaw: "s:seed", roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const derived = makeStrand({
      idRaw: "s:derived",
      contentHashRaw: "hash:archive-stub",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: fraud, rootIdRaw: "root:keepme" }],
    });
    store.putStrand(seed);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, seed.id));

    downstreamDisownSweep(fraud, [seed.id], store, ledger, NOW);

    const after = store.getStrand(derived.id);
    expect(after).not.toBeNull();
    // Archive stub intact: content_hash + provenance preserved; only fact_state moved.
    expect(after!.content_hash).toBe("hash:archive-stub");
    expect(after!.provenance.map((p) => String(p.rootId))).toContain("root:keepme");
    expect(after!.fact_state).toBe(FactState.DEMOTED);
  });
});

describe("downstreamDisownSweep — dedupe by root", () => {
  it("a seed of 3 strands sharing one content_hash counts once (single frontier expansion, single contradiction)", () => {
    const store: StrandStore = createMemoryStore();
    const ledger = ledgerWithCap();
    const fraud = "src:fraud" as SourceId;
    const downstream = "src:downstream" as SourceId;

    earn(ledger, downstream);
    const before = ledger.scoreOf(downstream);
    const scarBefore = ledger.stateOf(downstream)!.scarBeta;

    // Three seed strands that are all echoes of one root (shared content_hash).
    const shared = "hash:one-root";
    const e1 = makeStrand({ idRaw: "s:e1", contentHashRaw: shared, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const e2 = makeStrand({ idRaw: "s:e2", contentHashRaw: shared, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    const e3 = makeStrand({ idRaw: "s:e3", contentHashRaw: shared, roots: [{ classRaw: "class:A", sourceIdRaw: fraud }] });
    // One downstream derived strand, reachable from the (deduped) root via e1.
    const derived = makeStrand({
      idRaw: "s:derived",
      origin: FactOrigin.DERIVED,
      roots: [{ classRaw: "class:A", sourceIdRaw: downstream }],
    });
    store.putStrand(e1);
    store.putStrand(e2);
    store.putStrand(e3);
    store.putStrand(derived);
    store.putEdge(derivationEdge(derived.id, e1.id));

    const res = downstreamDisownSweep(fraud, [e1.id, e2.id, e3.id], store, ledger, NOW);

    // The shared-root flood collapsed to one frontier representative, so the derived
    // strand is demoted exactly once and the downstream source contradicted once.
    expect(res.demotedDownstream.filter((id) => id === derived.id).length).toBe(1);
    expect(res.contradictedSources.filter((s) => s === downstream).length).toBe(1);
    // Exactly ONE contradiction step under the Beta model: the downstream claw-back now
    // SCARS (non-decaying), so the NON-DECAYING scar mass rose by exactly c·w (= 4·1),
    // NOT 3× that — proving the shared-root flood collapsed to one contradiction, not
    // three. The LCB dropped (down-fast asymmetry: bad news 4×).
    const scarAfter = ledger.stateOf(downstream)!.scarBeta;
    expect(scarAfter - scarBefore).toBeCloseTo(4, 6); // one step of c·w with c=4, w=1
    expect(ledger.scoreOf(downstream)).toBeLessThan(before); // dropped, not tripled
  });
});
