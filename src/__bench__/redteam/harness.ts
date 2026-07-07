import { freshSource } from "../../testSupport/identityFixtures.js";
/**
 * __bench__/redteam/harness.ts — REAL-ENGINE SYBIL RED-TEAM HARNESS (gated REDTEAM=1).
 *
 * Materializes designed Sybil attacks as ACTUAL Intelligent DB engine state and runs
 * the REAL engine verbs (writeFact / ratify / adjudicate / disown) over a shared
 * in-memory store + a fully-wired Source-Identity Layer (registered source ids, an anchor
 * registry that models the OFFLINE class-assignment + operator/fleet axis, a live
 * Beta(α,β) reputation ledger on a controllable clock, a stake ledger) + the full
 * ratification stack (pending / corroboration / adjudication-provenance / weak-influence
 * ledgers). Nothing here decides an outcome: every classification an attack returns is
 * read back out of REAL engine state (fact_state LIVE/DEMOTED, the ConsolidationOutcome
 * kind, independentRootCount, listPending depth, post-disown reputation).
 *
 * ZERO engine edits: this lives entirely under src/__bench__ and only imports the public
 * barrel (src/index.ts). It is never loaded by `npm test` unless REDTEAM=1.
 */

import {
  AnchorClass,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  createMemoryStore,
  createIntelligentDb,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  createCorroborationLedger,
  createAdjudicationProvenanceLedger,
  createWeakInfluenceLedger,
  repCapFor,
  aggregateAnchorCost,
  independenceBetween,
} from "../../index.js";

import type {
  AnchorBinding,
  AttributeKey,
  ContentHash,
  EntityId,
  EpochMs,
  IdentityStamp,
  IntelligentDb,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedger,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  StrandStore,
  Strand,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  SourceId,
  StrandId,
  Unit,
  ConsolidationOutcome,
  RatificationDeps,
  SourceRef,
} from "../../index.js";

export const DAY = 86_400_000;

/** A registered source plus the OFFLINE-assigned independence/operator labels. */
export interface SourceRec {
  readonly sourceId: SourceId;
  readonly key: SourceRef;
  readonly label: string;
  readonly anchors: AnchorBinding[];
  /** Offline-assigned independence class (the human-judgment seam the attacks probe). */
  readonly indClass: string;
  /** Operator/registrar/ASN fleet axis; same value across two sources ⇒ fleet-collapsed. */
  readonly operatorClass: string | null;
}

/** Build an AnchorBinding for a class, using the table weights unless overridden. */
export function anchorOf(
  cls: AnchorClass,
  opts: { realizedCost?: number; independenceWeight?: number } = {},
): AnchorBinding {
  // The table values live in ANCHOR_TABLE; we read them indirectly via repCapFor/
  // independenceBetween, but for the binding we just need representative weights.
  const weights: Record<AnchorClass, number> = {
    [AnchorClass.BARE_KEY]: 0.0,
    [AnchorClass.EMAIL_OAUTH]: 0.1,
    [AnchorClass.PHONE_SIM]: 0.2,
    [AnchorClass.DOMAIN]: 0.35,
    [AnchorClass.HARDWARE_ATTESTATION]: 0.45,
    [AnchorClass.VERIFIED_HUMAN]: 0.7,
    [AnchorClass.ORGANIZATION]: 0.75,
    [AnchorClass.FINANCIAL_STAKE]: 0.3,
    [AnchorClass.EXTERNAL_AUTHORITY]: 0.9,
    [AnchorClass.OWNER]: 0.9,
    [AnchorClass.SYSTEM_OF_RECORD]: 0.9,
    [AnchorClass.LOCAL_DOCUMENT]: 0.35,
    [AnchorClass.SSO_TENANT_MEMBER]: 0.12,
    [AnchorClass.PUBLISHER_UNVERIFIED]: 0.04,
    [AnchorClass.PUBLISHER_TRACKED]: 0.18,
  };
  const w = opts.independenceWeight ?? weights[cls];
  return {
    anchorClass: cls,
    realizedCost: (opts.realizedCost ?? w) as Unit,
    independenceWeight: w as Unit,
  };
}

let RID = 0;

/**
 * One fully-wired engine instance under a controllable logical clock. Every helper
 * drives REAL engine state; the attacks read it back to classify.
 */
export class Harness {
  nowMs: number;
  readonly store: StrandStore;
  readonly reputation: ReputationLedger;
  readonly identity: SourceIdentityLayer;
  readonly engine: IntelligentDb;
  readonly systemSource: SourceId;
  readonly ratification: RatificationDeps;

  private readonly sources = new Map<SourceId, SourceRec>();
  private readonly anchorMap = new Map<SourceId, AnchorBinding[]>();
  private readonly stakeMap = new Map<SourceId, number>();

  constructor(startMs = 1_700_000_000_000) {
    this.nowMs = startMs;
    const clock = (): EpochMs => asEpochMs(this.nowMs);

    const keys: SourceRegistryPort = (() => {
      const known = new Set<SourceId>();
      return {
        register: (p) => void known.add(p.sourceId),
        sourceIdOf: (s) => (known.has(s) ? s : null),
        has: (s) => known.has(s),
      };
    })();

    const self = this;
    const anchors: AnchorRegistryPort = {
      bind(sourceId, a) {
        self.anchorMap.set(sourceId, [...a]);
      },
      anchorsOf(sourceId) {
        return self.anchorMap.get(sourceId) ?? [];
      },
      aggregateCost(a) {
        return aggregateAnchorCost(a);
      },
      independenceBetween(a, b) {
        return independenceBetween(a as AnchorBinding[], b as AnchorBinding[]);
      },
      // SOURCE-AWARE independence predicate — the registry axis the real engine
      // prefers. Models the OFFLINE class assignment (indClass) + the operator/fleet
      // cap (operatorClass). This is exactly the seam the class-assignment attacks
      // poison: two genuinely-correlated sources mislabeled with distinct indClass
      // read as independent; a shared operatorClass collapses a fleet.
      independentSources(a, b) {
        const ra = self.sources.get(a);
        const rb = self.sources.get(b);
        if (ra === undefined || rb === undefined) return true; // unresolved ⇒ class fallback
        if (
          ra.operatorClass !== null &&
          rb.operatorClass !== null &&
          ra.operatorClass === rb.operatorClass
        ) {
          return false; // same registrar/ASN fleet ⇒ not independent
        }
        return ra.indClass !== rb.indClass;
      },
    };

    const repCapOf = (s: SourceId): Unit => repCapFor([...(this.anchorMap.get(s) ?? [])]);
    this.reputation = createReputationLedger(repCapOf, undefined, clock);
    const reputationPort: ReputationLedgerPort = { scoreOf: (s) => this.reputation.scoreOf(s) };
    const stakePort: StakeLedgerPort = { postedFor: (s) => this.stakeMap.get(s) ?? 0 };

    this.identity = createSourceIdentityLayer({
      sources: keys,
      anchors,
      reputation: reputationPort,
      stake: stakePort,
    });

    this.store = createMemoryStore();
    this.systemSource = freshSource().sourceId;
    this.ratification = {
      ledger: createPendingLedger({ reputation: this.reputation }),
      systemSource: this.systemSource,
      corroboration: createCorroborationLedger(),
      adjudicationProvenance: createAdjudicationProvenanceLedger(),
      weakInfluence: createWeakInfluenceLedger(),
    };
    this.engine = createIntelligentDb(
      this.store,
      this.identity,
      null,
      this.reputation,
      this.ratification,
    );
  }

  now(): EpochMs {
    return asEpochMs(this.nowMs);
  }

  advanceDays(d: number): void {
    this.nowMs += d * DAY;
  }

  /** Register a source + bind anchors + record offline labels. */
  addSource(opts: {
    label: string;
    anchors?: AnchorBinding[];
    indClass?: string;
    operatorClass?: string | null;
    stake?: number;
  }): SourceRec {
    const key = freshSource();
    const anchors = opts.anchors ?? [];
    const rec: SourceRec = {
      sourceId: key.sourceId,
      key,
      label: opts.label,
      anchors,
      indClass: opts.indClass ?? `ind:${key.sourceId}`,
      operatorClass: opts.operatorClass ?? null,
    };
    this.identity.register(key, anchors);
    this.sources.set(rec.sourceId, rec);
    if (opts.stake) this.stakeMap.set(rec.sourceId, opts.stake);
    return rec;
  }

  /** A bare-key (anchorless) source — the free Sybil. */
  bareSource(label: string): SourceRec {
    return this.addSource({ label, anchors: [] });
  }

  /** File a REAL observed fact; returns the strand id. */
  write(rec: SourceRec, entity: string, attr: string, value: string): StrandId {
    const stamp: IdentityStamp = this.identity.stampFor(rec.sourceId);
    return this.engine.writeFact({
      entity: entity as EntityId,
      attribute: this.attr(entity, attr),
      payload: { value },
      stamp,
    });
  }

  attr(entity: string, attr: string): AttributeKey {
    return `${entity}.${attr}` as AttributeKey;
  }

  /** Current EARNED reputation (LCB readout, decayed to the logical clock). */
  repOf(rec: SourceRec): number {
    return this.identity.stampFor(rec.sourceId).reputation;
  }

  /**
   * Earn reputation up to (at least) `target` via repeated independence-weighted
   * ratifications at the current clock — REAL ledger.ratify calls. Bounded.
   */
  earnTo(rec: SourceRec, target: number, w = 0.1): void {
    let guard = 0;
    while (this.repOf(rec) < target && guard++ < 2000) {
      this.reputation.ratify(rec.sourceId, this.now(), w);
    }
  }

  /** One explicit corroboration of `rec` (raises its Beta α by w). */
  ratifyOnce(rec: SourceRec, w = 1): void {
    this.reputation.ratify(rec.sourceId, this.now(), w);
  }

  /**
   * REAL adjudication over an (entity, attribute). Optionally high-impact.
   *
   * V2 (OD-8, engine-owned-evidence): `highImpact` is now an INTENT-only boolean.
   * The engine BUILDS the {@link HighImpactContext} from its OWN trust layer —
   * `anchorClassCountOf := #R` (the independent-ROOT count over the agreement-set
   * root union), `corroborationCountOf := #R`, and `lastContradictionAtOf` from
   * `ReputationState.lastContradictionAt`. The caller can no longer inject those
   * callbacks (the V1 injection surface is gone by design); we pass only the flag and
   * let the engine's real high-impact gate stand.
   */
  adjudicate(entity: string, attr: string, highImpact = false): ConsolidationOutcome {
    const attribute = this.attr(entity, attr);
    return this.engine.adjudicate(attribute, { highImpact });
  }

  disown(rec: SourceRec): ReturnType<IntelligentDb["disown"]> {
    return this.engine.disown(rec.sourceId);
  }

  state(id: StrandId): FactState | null {
    return this.store.getStrand(id)?.fact_state ?? null;
  }

  isLive(id: StrandId): boolean {
    return this.state(id) === FactState.LIVE;
  }

  isDemoted(id: StrandId): boolean {
    return this.state(id) === FactState.DEMOTED;
  }

  pendingDepth(): number {
    return this.engine.listPending().length;
  }

  /** The independent-root count the forgetting/high-impact gates read, over given strands. */
  independentRootCountOver(...ids: StrandId[]): number {
    const roots: ProvenanceRoot[] = [];
    for (const id of ids) {
      const s = this.store.getStrand(id);
      if (s !== null) roots.push(...s.provenance);
    }
    return this.identity.independentRootCount(roots);
  }

  /** Count an arbitrary fabricated provenance set (e.g. null-source roots). */
  independentRootCountRaw(roots: ProvenanceRoot[]): number {
    return this.identity.independentRootCount(roots);
  }

  /** Fabricate K distinct-class provenance roots (optionally null-sourced). */
  fabricatedRoots(k: number, sourceId: SourceId | null): ProvenanceRoot[] {
    const out: ProvenanceRoot[] = [];
    for (let i = 0; i < k; i++) {
      out.push({
        rootId: `frR:${RID++}` as ProvenanceRootId,
        independenceClass: `frC:${i}:${RID}` as IndependenceClassId,
        sourceId,
        establishedAt: this.now(),
      });
    }
    return out;
  }

  /**
   * Insert a RAW strand with a caller-supplied provenance set (bypasses writeFact) so
   * an attack can plant null-source / multi-root provenance the writeFact path cannot
   * express. Still a real store strand the engine adjudicates over.
   */
  putRawStrand(
    entity: string,
    attr: string,
    value: string,
    provenance: ProvenanceRoot[],
  ): StrandId {
    const id = asStrandId(`raw:${RID++}:${entity}.${attr}.${value}`);
    const at = this.now();
    const strand: Strand = {
      id,
      entity: entity as EntityId,
      attribute: this.attr(entity, attr),
      payload: { value },
      content_hash: `hash:${entity}.${attr}.${value}` as ContentHash,
      origin: FactOrigin.OBSERVED,
      fact_state: FactState.LIVE,
      tier: Tier.WARM,
      provenance,
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
    };
    this.store.putStrand(strand);
    return id;
  }

  /** Reputation Beta audit state for a source (null if untouched). */
  repState(rec: SourceRec): { alpha: number; beta: number; ratifiedCount: number } | null {
    const s = this.reputation.stateOf(rec.sourceId);
    return s === null ? null : { alpha: s.alpha, beta: s.beta, ratifiedCount: s.ratifiedCount };
  }
}

export { FactState };
