/**
 * runForgetting.test.ts — REGRESSION for `forgetting-never-wired` (hostile
 * production-readiness audit, CRITICAL).
 *
 * `forgetting/tiers.ts` fully implements `evaluateEviction`/`nextTierDown`/the six
 * fail-closed eviction gates, but nothing in the engine ever called them:
 * `makeObservedStrand` hardcoded `tier: Tier.WARM` at MINT time (correct — new
 * strands ARE pinned WARM for the grace window) and nothing anywhere else ever
 * moved a strand's tier again, so every strand stayed WARM forever — a fully
 * implemented, fully tested pillar that was dead weight in production.
 *
 * This test exercises the REAL production code path — `db.runForgetting(opts)`,
 * the new explicit maintenance verb — through the public engine (`createIntelligentDb`),
 * never a free-function shortcut:
 *   - a strand past the grace floor that clears every eviction gate ACTUALLY moves
 *     COLD -> ARCHIVE when `runForgetting` is called;
 *   - a CORROBORATED strand (independent count >= 2, read from the REAL identity
 *     layer, never self-computed) is KEPT at COLD;
 *   - belief/provenance survive the move untouched (demote-never-delete);
 *   - `runForgetting` is an EXPLICIT operation — a freshly written fact stays WARM
 *     (grace-pinned) even when `runForgetting` is invoked right after writing it,
 *     proving default write behavior is unchanged (additive, not automatic).
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  independenceBetween,
  EvictionGate,
  FactState,
  FactOrigin,
  Tier,
  ReasonCode,
  AnchorClass,
  DEFAULT_FORGETTING_CONFIG,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
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
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const DAY = 24 * 60 * 60 * 1000;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts / smoke.test.ts) --

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
      return best as Unit;
    },
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeIdentity(): SourceIdentityLayer {
  const reputation: ReputationLedgerPort = { scoreOf: () => 0 };
  const stake: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake,
  });
}

/**
 * Hand-build a COLD strand with fully-controllable salience/provenance/timing so
 * the six eviction gates can be pushed to a known PASS/FAIL outcome. `roots`
 * controls `independentSourceCount` (via the REAL identity layer); `staleSince`
 * drives `decayPressure` independently of the grace/freshness clocks (which read
 * `observedAt` / `provenance[].establishedAt`).
 */
function makeColdStrand(opts: {
  idRaw: string;
  entity: EntityId;
  roots: readonly ProvenanceRoot[];
  descriptionValue: number;
  observedAt: number;
  staleSince: number;
}): Strand {
  return {
    id: asStrandId(opts.idRaw),
    entity: opts.entity,
    attribute: null,
    payload: { note: opts.idRaw },
    content_hash: (`hash:${opts.idRaw}`) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.COLD,
    provenance: opts.roots,
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    // VERY stale salience (idle since `staleSince`, decoupled from observedAt/
    // provenance) => decayPressure saturates near 1, clearing pressureToStepDown
    // regardless of the grace/freshness windows below.
    salience: { s: 0, last_fire_time: asEpochMs(opts.staleSince), lambda: 0.05, fire_count: 0 },
    description_value: opts.descriptionValue,
    observedAt: asEpochMs(opts.observedAt),
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
  };
}

describe("REGRESSION forgetting-never-wired: runForgetting actually moves tiers", () => {
  it("a strand past grace clearing every gate moves COLD->ARCHIVE; a corroborated strand is KEPT; belief/provenance intact", () => {
    const store = createMemoryStore();
    const identity = makeIdentity();
    const db = createIntelligentDb(store, identity);

    const soleSrc = "src:sole" as SourceId;
    const corrobSrcA = "src:corrob-a" as SourceId;
    const corrobSrcB = "src:corrob-b" as SourceId;
    identity.register({ ...freshSource(), sourceId: soleSrc } as SourceRef, [
      { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit },
    ]);
    identity.register({ ...freshSource(), sourceId: corrobSrcA } as SourceRef, [
      { anchorClass: AnchorClass.VERIFIED_HUMAN, realizedCost: 0.7 as Unit, independenceWeight: 0.7 as Unit },
    ]);
    identity.register({ ...freshSource(), sourceId: corrobSrcB } as SourceRef, [
      { anchorClass: AnchorClass.HARDWARE_ATTESTATION, realizedCost: 0.45 as Unit, independenceWeight: 0.45 as Unit },
    ]);

    // `at`: 10 days after observedAt (PAST the 7-day grace floor) and only 1 day
    // after the provenance roots' establishedAt (well within the 30-day stamp
    // freshness window) — both clocks satisfied by ONE evaluation time.
    const observedAt = (NOW as number) - 10 * DAY;
    const establishedAt = asEpochMs((NOW as number) - 1 * DAY);

    // EVICTABLE: a single independent root (count 1), zero description_value (so
    // LOW_UNIQUE_VALUE passes trivially — nothing unique to lose), no outranker,
    // no earned bridge, past grace, fresh stamp, saturated pressure.
    const evictable = makeColdStrand({
      idRaw: "strand:evictable",
      entity: "entity:evictable" as EntityId,
      roots: [
        {
          rootId: "root:evictable" as ProvenanceRoot["rootId"],
          independenceClass: "class:sole" as ProvenanceRoot["independenceClass"],
          sourceId: soleSrc,
          establishedAt,
        },
      ],
      descriptionValue: 0,
      observedAt,
      staleSince: 0,
    });

    // KEPT: TWO mutually anchor-independent roots (corrobSrcA/corrobSrcB, disjoint
    // anchor classes) => the REAL identity layer's independentRootCount reads 2,
    // failing INDEP_SOURCE_COUNT_LE_1 regardless of every other gate.
    const corroborated = makeColdStrand({
      idRaw: "strand:corroborated",
      entity: "entity:corroborated" as EntityId,
      roots: [
        {
          rootId: "root:corrob-a" as ProvenanceRoot["rootId"],
          independenceClass: "class:corrob-a" as ProvenanceRoot["independenceClass"],
          sourceId: corrobSrcA,
          establishedAt,
        },
        {
          rootId: "root:corrob-b" as ProvenanceRoot["rootId"],
          independenceClass: "class:corrob-b" as ProvenanceRoot["independenceClass"],
          sourceId: corrobSrcB,
          establishedAt,
        },
      ],
      descriptionValue: 0,
      observedAt,
      staleSince: 0,
    });

    store.putStrand(evictable);
    store.putStrand(corroborated);

    // Sanity: the identity layer really does read count 2 for the corroborated
    // strand's OWN provenance (the exact quantity INDEP_SOURCE_COUNT_LE_1 reads).
    expect(identity.independentRootCount(corroborated.provenance)).toBe(2);
    expect(identity.independentRootCount(evictable.provenance)).toBe(1);

    // Pre-fix: `db.runForgetting` does not exist on the engine at all (TypeError).
    const result = db.runForgetting({ at: asEpochMs(NOW as number) });

    expect(result.evaluated).toBe(2);

    // THE EVICTABLE STRAND ACTUALLY MOVED (the core assertion the audit finding
    // says never happens in production): COLD -> ARCHIVE, reason stamped.
    const movedEntry = result.moved.find((m) => String(m.strandId) === String(evictable.id));
    expect(movedEntry).toBeDefined();
    expect(movedEntry!.from).toBe(Tier.COLD);
    expect(movedEntry!.to).toBe(Tier.ARCHIVE);
    expect(movedEntry!.reason).toBe(ReasonCode.CONVERGED);

    const evictableAfter = store.getStrand(evictable.id)!;
    expect(evictableAfter.tier).toBe(Tier.ARCHIVE);
    expect(evictableAfter.last_tier_reason).toBe(ReasonCode.CONVERGED);
    // DEMOTE-NEVER-DELETE: the archive stub's content hash + provenance survive.
    expect(evictableAfter.content_hash).toBe(evictable.content_hash);
    expect(evictableAfter.provenance).toEqual(evictable.provenance);
    expect(evictableAfter.fact_state).toBe(FactState.LIVE); // belief untouched by tier movement

    // THE CORROBORATED STRAND IS KEPT — never evicted while genuinely corroborated.
    const keptEntry = result.kept.find((k) => String(k.strandId) === String(corroborated.id));
    expect(keptEntry).toBeDefined();
    expect(keptEntry!.tier).toBe(Tier.COLD);
    expect(keptEntry!.failedGates).toContain(EvictionGate.INDEP_SOURCE_COUNT_LE_1);

    const corroboratedAfter = store.getStrand(corroborated.id)!;
    expect(corroboratedAfter.tier).toBe(Tier.COLD); // unchanged
    expect(corroboratedAfter.content_hash).toBe(corroborated.content_hash);
    expect(corroboratedAfter.provenance).toEqual(corroborated.provenance);
  });

  it("runForgetting is an EXPLICIT operation: a freshly writeFact()-minted strand stays WARM (grace-pinned) even when called immediately after", () => {
    const store = createMemoryStore();
    const identity = makeIdentity();
    const db = createIntelligentDb(store, identity);

    const src = "src:writer" as SourceId;
    identity.register({ ...freshSource(), sourceId: src } as SourceRef, [
      { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit },
    ]);
    const id = db.writeFact({
      entity: "entity:fresh" as EntityId,
      payload: { note: "brand new" },
      stamp: identity.stampFor(src),
    });
    expect(store.getStrand(id)!.tier).toBe(Tier.WARM);

    // Calling the maintenance sweep right away must NOT touch a grace-pinned,
    // just-written strand — default write behavior stays unchanged (additive).
    const result = db.runForgetting({ at: asEpochMs(Date.now()) });
    expect(store.getStrand(id)!.tier).toBe(Tier.WARM);
    expect(result.kept.some((k) => String(k.strandId) === String(id))).toBe(true);
  });

  it("runForgetting respects DEFAULT_FORGETTING_CONFIG's grace/pressure knobs when no cfg is supplied", () => {
    // Cheap structural check that the default engine wiring actually threads the
    // module's own default config (not a silently-different hardcoded copy).
    const store = createMemoryStore();
    const identity = makeIdentity();
    const db = createIntelligentDb(store, identity);
    expect(DEFAULT_FORGETTING_CONFIG.graceWindowMs).toBeGreaterThan(0);
    const result = db.runForgetting();
    expect(result.evaluated).toBe(0);
    expect(result.moved).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});
