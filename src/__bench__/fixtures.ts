/**
 * __bench__/fixtures.ts — SHARED, CHEAP bench fixtures (NO `bench()` here).
 *
 * The bench files import these builders to pre-seed webs, provenance root-sets,
 * identity layers, reputation ledgers and Merkle logs WITHOUT going through the
 * (expensive) engine for seed-only data. Seeding via `store.putStrand` /
 * `store.putEdge` + the `asStrandId` / `asEpochMs` constructors is FAR cheaper than
 * N × `writeFact`, so a 10k-strand web is built once in a `beforeAll`, not per
 * iteration.
 *
 * Determinism: every generator is PRNG-free (ids derived from an index), so a web
 * of size N is byte-identical across runs and machines. This keeps the bench
 * comparable run-to-run.
 *
 * This module registers ZERO tests and ZERO benches, so even if a stray glob picked
 * it up under `vitest run` it is harmless.
 */

import {
  EdgeType,
  FactOrigin,
  FactState,
  Tier,
  asEdgeId,
  asEpochMs,
  asStrandId,
  computeEdgeWeight,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  repCapFor,
  generatePassport,
} from "../index.js";

import type {
  AnchorBinding,
  AttributeKey,
  ContentHash,
  Edge,
  EntityId,
  EpochMs,
  IdentityStamp,
  IndependenceClassId,
  ProvenanceRoot,
  ProvenanceRootId,
  SourceId,
  Strand,
  StrandId,
  StrandStore,
  SourceIdentityLayer,
  ReputationLedger,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  Unit,
} from "../index.js";

/** A fixed logical clock so nothing in the bench depends on the wall clock. */
export const NOW: EpochMs = asEpochMs(1_700_000_000_000);
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Strand / edge constructors (bypass the engine; seed-only)
// ---------------------------------------------------------------------------

/** Build one OBSERVED LIVE strand with a single provenance root in `cls`. */
export function makeStrand(
  idRaw: string,
  entity: EntityId,
  sourceId: SourceId | null,
  cls: string,
  payload: unknown,
  attribute: AttributeKey | null = null,
  at: EpochMs = NOW,
): Strand {
  const root: ProvenanceRoot = {
    rootId: (`root:${idRaw}` as ProvenanceRootId),
    independenceClass: (cls as IndependenceClassId),
    sourceId,
    establishedAt: at,
  };
  return {
    id: asStrandId(idRaw),
    entity,
    attribute,
    payload,
    content_hash: (`hash:${idRaw}` as ContentHash),
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [root],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: at, lambda: 0.05, fire_count: 0 },
    description_value: 0,
    observedAt: at,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

/** Build one edge of `edgeType` from -> to with unit confidence/recency. */
export function makeEdge(
  idRaw: string,
  from: StrandId,
  to: StrandId,
  edgeType: EdgeType,
  provenanceIndependence: Unit = 1,
): Edge {
  const w = computeEdgeWeight(1, provenanceIndependence, 1);
  return {
    id: asEdgeId(idRaw),
    from,
    to,
    edgeType,
    link_confidence: 1,
    provenance_independence: provenanceIndependence,
    recency: 1,
    w,
    out_weight_sum: w,
  };
}

// ---------------------------------------------------------------------------
// Web builders (the recall / store substrate)
// ---------------------------------------------------------------------------

export interface SeededWeb {
  readonly store: StrandStore;
  /** The strand id used as a walk seed (a hub at index 0). */
  readonly seedId: StrandId;
  /** An entity present in the web (for strandsByEntity benches). */
  readonly entity: EntityId;
  /** A strand id known to exist (for getStrand / outEdges benches). */
  readonly probeId: StrandId;
  readonly size: number;
}

/**
 * Build a connected web of `size` strands as a "web of small clusters": strands are
 * grouped into clusters of `clusterSize`; inside a cluster every strand links to the
 * cluster hub and back (a dense local web), and consecutive cluster hubs are chained
 * so activation can spread across the whole web from a single seed. Each strand has
 * its own independence class so the walk's novelty signal stays live across hops.
 *
 * All edges are SHARED_ENTITY (the type the walk traverses); `out_weight_sum` is set
 * correctly per source node so share-normalization is exercised honestly.
 */
export function buildWeb(size: number, entity: EntityId, clusterSize = 16): SeededWeb {
  const store = createMemoryStore();
  const ids: StrandId[] = [];

  // 1) Strands.
  for (let i = 0; i < size; i++) {
    const s = makeStrand(
      `bw:${size}:${i}`,
      entity,
      (`src:${i % 32}` as SourceId),
      `cls:${i}`,
      { i },
    );
    store.putStrand(s);
    ids.push(s.id);
  }

  // 2) Edges: per-cluster star to the hub (+ back), plus a hub chain.
  const hubs: StrandId[] = [];
  for (let base = 0; base < size; base += clusterSize) {
    const hub = ids[base]!;
    hubs.push(hub);
    const end = Math.min(base + clusterSize, size);
    for (let j = base + 1; j < end; j++) {
      const member = ids[j]!;
      store.putEdge(makeEdge(`bw:${size}:e:${base}->${j}`, hub, member, EdgeType.SHARED_ENTITY));
      store.putEdge(makeEdge(`bw:${size}:e:${j}->${base}`, member, hub, EdgeType.SHARED_ENTITY));
    }
  }
  // Chain consecutive hubs so the seed reaches the whole web.
  for (let h = 0; h + 1 < hubs.length; h++) {
    store.putEdge(makeEdge(`bw:${size}:hub:${h}`, hubs[h]!, hubs[h + 1]!, EdgeType.SHARED_ENTITY));
  }

  // 3) Recompute out_weight_sum on every node whose out-edges we wrote.
  for (const id of ids) store.recomputeOutWeightSum(id);

  return { store, seedId: ids[0]!, entity, probeId: ids[(size >> 1)]!, size };
}

// ---------------------------------------------------------------------------
// Provenance root-sets (the MIS / independentRootCount substrate)
// ---------------------------------------------------------------------------

/**
 * A FULLY-INDEPENDENT root set of size `n`: every root has a DISTINCT independence
 * class AND a distinct source with NO resolvable anchors, so the null-source fallback
 * keeps every pair independent. This is the WORST CASE for the exact Bron–Kerbosch
 * branch (one giant clique). Sources are null so no anchor port is consulted.
 */
export function independentRoots(n: number): ProvenanceRoot[] {
  const out: ProvenanceRoot[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      rootId: (`root:ind:${i}` as ProvenanceRootId),
      independenceClass: (`cls:ind:${i}` as IndependenceClassId),
      sourceId: null,
      establishedAt: NOW,
    });
  }
  return out;
}

/**
 * A FLEET-COLLAPSED root set of size `n`: every root shares ONE independence class,
 * so the "independent" graph is edgeless (count collapses to 1). This is the cheap
 * case — the distinct-class clamp short-circuits the answer to 1.
 */
export function collapsedRoots(n: number): ProvenanceRoot[] {
  const out: ProvenanceRoot[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      rootId: (`root:col:${i}` as ProvenanceRootId),
      independenceClass: (`cls:col:shared` as IndependenceClassId),
      sourceId: null,
      establishedAt: NOW,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity layer + reputation (the stamp / adjudication / reputation substrate)
// ---------------------------------------------------------------------------

/** A trivial in-memory key registry that accepts any registered source. */
function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p): void {
      known.add(p.sourceId);
    },
    sourceIdOf(s): SourceId | null {
      return known.has(s) ? s : null;
    },
    has(s): boolean {
      return known.has(s);
    },
  };
}

/**
 * A simple anchor registry over a `Map<SourceId, AnchorBinding[]>`. Independence is
 * the real `independenceBetween` math; no fleet/operator axis (good enough for the
 * micro-benches, which target the MIS recursion and the anchor math directly).
 */
function makeAnchorRegistry(
  bindings: Map<SourceId, readonly AnchorBinding[]>,
): AnchorRegistryPort {
  return {
    bind(sourceId, anchors): void {
      bindings.set(sourceId, [...anchors]);
    },
    anchorsOf(sourceId): readonly AnchorBinding[] {
      return bindings.get(sourceId) ?? [];
    },
    aggregateCost(anchors): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best;
    },
    independenceBetween(): Unit {
      // The MIS micro-bench drives this through the real exported function in
      // anchors.bench.ts; here null-source roots short-circuit before it is reached,
      // so a cheap stub keeps the identity layer construction free.
      return 0;
    },
  };
}

export interface IdentityFixture {
  readonly identity: SourceIdentityLayer;
  readonly reputation: ReputationLedger;
  readonly anchorsOf: (s: SourceId) => readonly AnchorBinding[];
}

/**
 * Wire a full {@link SourceIdentityLayer} + a live reputation ledger over a fixed
 * clock, with `bindings` already populated. The reputation ledger's `scoreOf` backs
 * the facade's `ReputationLedgerPort`, so stamps reflect earned trust.
 */
export function makeIdentity(
  bindings: Map<SourceId, readonly AnchorBinding[]> = new Map(),
  clock: () => EpochMs = () => NOW,
): IdentityFixture {
  const anchorsRegistry = makeAnchorRegistry(bindings);
  const anchorsOf = (s: SourceId): readonly AnchorBinding[] => anchorsRegistry.anchorsOf(s);
  const repCapOf = (s: SourceId): Unit => repCapFor([...anchorsOf(s)]);
  const reputation = createReputationLedger(repCapOf, undefined, clock);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  const identity = createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: anchorsRegistry,
    reputation: reputationPort,
    stake: stakePort,
  });
  return { identity, reputation, anchorsOf };
}

/** A bare-key (zero-anchor) stamp for a given source — the default writeFact stamp. */
export function bareStamp(sourceId: SourceId): IdentityStamp {
  return {
    source_id: sourceId,
    anchor_set: [],
    anchor_cost: 0,
    reputation: 0,
    stake_posted: 0,
  };
}

/** A stamp carrying a realized anchor cost (so writeFact edges get non-zero independence). */
export function costStamp(sourceId: SourceId, anchorCost: Unit): IdentityStamp {
  return {
    source_id: sourceId,
    anchor_set: [],
    anchor_cost: anchorCost,
    reputation: 0,
    stake_posted: 0,
  };
}

/** Mint a real ed25519 passport once (keys are expensive — never per iteration). */
export { generatePassport };
