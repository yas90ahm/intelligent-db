/**
 * createIntelligentDbOptionsOverload.test.ts — Wave-3
 * `createIntelligentDb-positional-nullable-params`.
 *
 * THE FINDING: `createIntelligentDb`'s classic form is a 7-parameter positional
 * function with five nullable optional trailing slots (`consolidation`,
 * `reputation`, `ratification`, `ingest`, `retrieval`) — a call site wiring only
 * the LAST of the five still has to spell out four `null`s to reach it
 * (`createIntelligentDb(store, identity, null, null, null, null, retrieval)`),
 * which is easy to miscount.
 *
 * THE FIX: an additional, purely ADDITIVE options-object overload —
 * `createIntelligentDb(store, identity, { retrieval })` — addresses each
 * dependency by name. The classic positional form is UNCHANGED and still fully
 * supported (every existing call site in this codebase keeps using it
 * unmodified).
 *
 * THIS TEST proves the two forms construct EQUIVALENTLY: given the identical
 * dependency wiring expressed either way, both engines behave identically
 * across (a) the trust-tiered ingest quarantine gate, (b) the retrieval
 * accelerator, (c) a deferred multi-class dispute recorded in the ratification
 * ledger, and (d) the "nothing wired" default (both throw the same typed error
 * from `disown()`).
 */

import { describe, expect, it } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  AnchorClass,
  FactOrigin,
  FactState,
  ReputationNotWiredError,
  Tier,
  asEpochMs,
  asStrandId,
  createIntelligentDb,
  createMemoryStore,
  createMemoryVectorSidecar,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
  independenceBetween,
} from "../index.js";
import { createHashingEmbedder } from "../examples/embedders.js";
import type {
  AnchorBinding,
  AnchorRegistryPort,
  AttributeKey,
  CreateIntelligentDbOptions,
  EntityId,
  ProvenanceRoot,
  RatificationDeps,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRef,
  SourceRegistryPort,
  StakeLedgerPort,
  Strand,
  StrandStore,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:overload" as EntityId;
const ATTR = "overload#claim" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts / smoke.test.ts) ----

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
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeIdentity(reputation: ReputationLedgerPort): SourceIdentityLayer {
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

function fileStrand(
  store: StrandStore,
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
    content_hash: ("hash:" + JSON.stringify(payload)) as Strand["content_hash"],
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
  };
  store.putStrand(s);
  return s;
}

/** One complete set of REAL (non-shared, freshly built) dependencies. */
function buildDeps(): {
  store: StrandStore;
  identity: SourceIdentityLayer;
  reputation: ReturnType<typeof createReputationLedger>;
  ratification: RatificationDeps;
} {
  const store = createMemoryStore();
  const reputation = createReputationLedger(() => 0.9 as Unit, undefined, () => NOW);
  const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
  const ledger = createPendingLedger({ reputation });
  const systemSource = freshSource().sourceId;
  const ratification: RatificationDeps = { ledger, systemSource };
  return { store, identity, reputation, ratification };
}

describe("createIntelligentDb — options-object overload (Wave-3)", () => {
  it("wires ingest + retrieval IDENTICALLY via both call forms", async () => {
    const posDeps = buildDeps();
    const optDeps = buildDeps();

    const vectorsPositional = createMemoryVectorSidecar();
    const vectorsOptions = createMemoryVectorSidecar();
    const embedder = createHashingEmbedder({ dim: 16 });

    // A custom (non-default) quarantine threshold, threaded through BOTH forms,
    // so this test actually proves the value was PASSED, not merely defaulted.
    const CUSTOM_THRESHOLD = 0.5;

    const dbPositional = createIntelligentDb(
      posDeps.store,
      posDeps.identity,
      null,
      null,
      null,
      { quarantineThreshold: CUSTOM_THRESHOLD },
      { embedder, vectors: vectorsPositional },
    );
    const dbOptions = createIntelligentDb(optDeps.store, optDeps.identity, {
      ingest: { quarantineThreshold: CUSTOM_THRESHOLD },
      retrieval: { embedder, vectors: vectorsOptions },
    });

    // A source whose strongest anchor (0.35, DOMAIN-grade) clears the DEFAULT
    // gate (0.10) but sits BELOW the custom 0.5 threshold above — it only
    // quarantines if the custom threshold really took effect.
    const domainAnchor: AnchorBinding = {
      anchorClass: AnchorClass.DOMAIN,
      realizedCost: 0.35 as Unit,
      independenceWeight: 0.35 as Unit,
    };
    const filerPositional = freshSource("filer-positional");
    posDeps.identity.register(filerPositional, [domainAnchor]);
    const stampPositional = posDeps.identity.stampFor(filerPositional.sourceId);

    const filerOptions = freshSource("filer-options");
    optDeps.identity.register(filerOptions, [domainAnchor]);
    const stampOptions = optDeps.identity.stampFor(filerOptions.sourceId);

    const idPositional = await dbPositional.writeFactWithEmbeddingAsync({
      entity: "entity:embed" as EntityId,
      payload: { text: "identical wiring across both call forms" },
      stamp: stampPositional,
    });
    const idOptions = await dbOptions.writeFactWithEmbeddingAsync({
      entity: "entity:embed" as EntityId,
      payload: { text: "identical wiring across both call forms" },
      stamp: stampOptions,
    });

    // (a) INGEST: the custom threshold quarantines this filer identically in
    // both engines (a DOMAIN-grade 0.35 < custom 0.5).
    const strandPositional = posDeps.store.getStrand(idPositional);
    const strandOptions = optDeps.store.getStrand(idOptions);
    expect(strandPositional?.fact_state).toBe(FactState.PROVISIONAL);
    expect(strandOptions?.fact_state).toBe(FactState.PROVISIONAL);

    // (b) RETRIEVAL: the embedder + sidecar were genuinely wired in both —
    // a vector landed under each engine's OWN sidecar instance.
    expect(strandPositional).not.toBeNull();
    expect(strandOptions).not.toBeNull();
    expect(vectorsPositional.get(strandPositional!.content_hash)).not.toBeNull();
    expect(vectorsOptions.get(strandOptions!.content_hash)).not.toBeNull();
  });

  it("wires reputation + ratification IDENTICALLY: a multi-class dispute defers in BOTH engines", () => {
    const posDeps = buildDeps();
    const optDeps = buildDeps();

    const dbPositional = createIntelligentDb(
      posDeps.store,
      posDeps.identity,
      null,
      posDeps.reputation,
      posDeps.ratification,
    );
    const options: CreateIntelligentDbOptions = {
      reputation: optDeps.reputation,
      ratification: optDeps.ratification,
    };
    const dbOptions = createIntelligentDb(optDeps.store, optDeps.identity, options);

    for (const [db, deps] of [
      [dbPositional, posDeps] as const,
      [dbOptions, optDeps] as const,
    ]) {
      fileStrand(deps.store, "strand:a", "src:a" as SourceId, "class:A", { v: "Germany" });
      fileStrand(deps.store, "strand:b", "src:b" as SourceId, "class:B", { v: "Atlantis" });

      const outcome = db.adjudicate(ATTR);
      expect(outcome.kind).toBe("DEFERRED");
      expect(db.listPending().length).toBe(1);
    }
  });

  it("omitting all trailing deps behaves IDENTICALLY in both forms: disown() throws the same typed error", () => {
    const posDeps = buildDeps();
    const optDeps = buildDeps();

    const dbPositionalBare = createIntelligentDb(posDeps.store, posDeps.identity);
    const dbOptionsBare = createIntelligentDb(optDeps.store, optDeps.identity, {});

    expect(() => dbPositionalBare.disown("src:whoever" as SourceId)).toThrow(
      ReputationNotWiredError,
    );
    expect(() => dbOptionsBare.disown("src:whoever" as SourceId)).toThrow(
      ReputationNotWiredError,
    );
  });
});
