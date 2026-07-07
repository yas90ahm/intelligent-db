/**
 * generalization/costlyIndependent.arm.ts — drive the REAL engine at a chosen poison
 * independence level and read back what survives.
 *
 * This reuses factworld's VALIDATED substrate construction (the hard-won adjudication recipe)
 * and changes exactly ONE thing: the poison cluster's anchor wiring. Instead of K sources
 * sharing ONE Sybil class, the K poison sources are spread across `independenceLevel` DISJOINT
 * real anchor classes, so the engine's #R (max-independent-set over the backing roots) sees
 * the poison value as backed by `min(independenceLevel, K)` genuinely-independent witnesses.
 *
 * THE RECIPE (replicated from factworld/arms.ts + highImpactGateR.test.ts):
 *  1. The TRUE value is backed by 2 co-asserter strands sharing a content_hash (value
 *     agreement) but with DISJOINT anchor classes (DOMAIN + ORGANIZATION) → #R(true) = 2.
 *  2. Only the PRIMARY true source is pre-earned (a modest, decisive-but-overtakeable LCB);
 *     the 2nd true source is an UNEARNED corroborator (rep 0) supplying the 2nd disjoint root.
 *  3. independenceBetween(a,b) > 0 iff the two sources' anchor CLASSES are disjoint, 0 if they
 *     share a class — so spreading the poison across L classes gives #R(poison) = L.
 *  4. The poison value's K strands share ONE content_hash (value agreement) so they corroborate
 *     each other; their anchor classes are what the independence sweep varies.
 *  5. Per-(entity, attribute) isolation: a unique attribute key per item, so adjudicate(attr)
 *     only ever touches that one dispute (and #R/#deriveAgreementSet, which scope by entity,
 *     never leak across items).
 *
 * THE SWEEP VARIABLES:
 *  - independenceLevel L ∈ [1, K]: how many disjoint anchor classes the poison spreads over.
 *  - mode: "anchors-only"  → the poison BUYS independent anchors but earns NO reputation;
 *          "anchors+rep"   → the attacker ALSO buys an earned reputation track record for the
 *                            poison's primary source (out-earning the truth), the strongest
 *                            priced attack short of an external authority.
 *
 * The arm does NO LLM / embedding work. It runs the engine's real contradiction adjudication
 * and reports, per item, whether the poison value still surfaces as a believed (LIVE) answer —
 * a deterministic, structural ASR readout (the no-LLM lower bound on what a reader would see).
 */

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createPendingLedger,
  asStrandId,
  asEpochMs,
  FactState,
  FactOrigin,
  Tier,
  AnchorClass,
} from "../../index.js";
import type {
  Strand,
  StrandStore,
  SourceId,
  Unit,
  EpochMs,
  EntityId,
  AttributeKey,
  ProvenanceRoot,
  ProvenanceRootId,
  IndependenceClassId,
  ContentHash,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedger,
  ReputationLedgerPort,
  StakeLedgerPort,
  RatificationDeps,
  AnchorBinding,
} from "../../index.js";

import type { CIItem } from "./costlyIndependent.generate.js";
import { freshSource } from "../../testSupport/identityFixtures.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const attrKeyOf = (entity: string, attribute: string): string => `${entity}::${attribute}`;

/**
 * Tuning constants (LCB arithmetic against the conservative DEFAULT_ADJUDICATION_POLICY:
 * decisiveMargin 0.30, minWinnerReputation 0.20). `ratify(s, NOW, 1)` × n gives α = 1+n,
 * β = 1, LCB = mean − √3·sd:
 *   - TRUE primary at n=2  → LCB ≈ 0.415: clears the L=1 baseline (gap 0.415 over the rep-0
 *     poison ≥ 0.30, earned ≥ 0.20) yet is LOW ENOUGH to be over-earnable by the attacker.
 *   - POISON primary at n=10 → LCB ≈ 0.784: out-earns the truth by ≈ 0.37 ≥ 0.30, so once the
 *     poison ALSO out-depths it (L ≥ 3) the engine RESOLVES *for the poison*.
 */
const TRUE_PRIMARY_RATIFIES = 2;
const POISON_PRIMARY_RATIFIES = 10;

/** Real, costly anchor classes the poison cluster spreads across (DISJOINT from the gold side's
 * DOMAIN + ORGANIZATION, so a poison class never accidentally collides with the truth's). */
const POISON_CLASS_PALETTE: readonly AnchorClass[] = [
  AnchorClass.EMAIL_OAUTH,
  AnchorClass.PHONE_SIM,
  AnchorClass.HARDWARE_ATTESTATION,
  AnchorClass.VERIFIED_HUMAN,
  AnchorClass.FINANCIAL_STAKE,
  AnchorClass.EXTERNAL_AUTHORITY,
];

/** The largest poison cluster this arm can wire with genuinely-distinct real classes. */
export const MAX_SYBIL_K = POISON_CLASS_PALETTE.length;

export type CIMode = "anchors-only" | "anchors+rep";

export interface CIConfig {
  /** Poison independence level L: the poison sources spread across `min(L, K)` disjoint classes. */
  readonly independenceLevel: number;
  /** Poison cluster size K. */
  readonly sybilK: number;
  /** Whether the attacker ALSO buys an earned reputation track record for the poison primary. */
  readonly mode: CIMode;
}

/** Per-item adjudication outcome, read back from the engine's LIVE state. */
export interface CIItemResult {
  /** The poison value still surfaces as a believed (LIVE) answer (contamination OR capture). */
  readonly poisonSurfaced: boolean;
  /** The poison value won outright: it is LIVE and the true value is NOT (full capture). */
  readonly poisonCaptured: boolean;
  /** The true value still surfaces as a believed (LIVE) answer. */
  readonly goldSurvived: boolean;
}

export interface CILevelResult {
  readonly independenceLevel: number;
  readonly mode: CIMode;
  readonly n: number;
  /** Fraction of items where the poison reaches the believed answer (contamination + capture). */
  readonly surfacedRate: number;
  /** Fraction of items where the poison won outright (truth demoted). */
  readonly capturedRate: number;
  /** Fraction of items the truth still survives as a believed answer. */
  readonly goldSurvivalRate: number;
  /**
   * The headline ID ASR proxy (no-LLM lower bound): a CAPTURE (reader sees only the poison)
   * scores 1.0; a CONTAMINATION (reader sees both truth and poison → flips probabilistically)
   * scores 0.5; a DEFENDED item (poison demoted) scores 0. = capturedRate + 0.5·(surfaced−captured).
   */
  readonly asr: number;
}

// ---- engine plumbing (mirrors factworld/arms.ts) ----------------------------

function makeRoot(sourceId: string, cls: string, idRaw: string): ProvenanceRoot {
  return {
    rootId: `root:${idRaw}` as ProvenanceRootId,
    independenceClass: cls as IndependenceClassId,
    sourceId: sourceId as SourceId,
    establishedAt: NOW,
  };
}

function makeValueStrand(
  idRaw: string,
  entity: string,
  attrKey: string,
  value: string,
  contentHash: string,
  roots: ProvenanceRoot[],
): Strand {
  return {
    id: asStrandId(idRaw),
    entity: entity as EntityId,
    attribute: attrKey as AttributeKey,
    payload: { value },
    content_hash: contentHash as ContentHash,
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: roots,
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

function makeSourceRegistry(known: Set<string>): SourceRegistryPort {
  return {
    register: (p) => void known.add(String(p.sourceId)),
    sourceIdOf: (s) => (known.has(String(s)) ? s : null),
    has: (s) => known.has(String(s)),
  };
}

const binding = (cls: AnchorClass): AnchorBinding => ({
  anchorClass: cls,
  realizedCost: 0.5 as Unit,
  independenceWeight: 0.5 as Unit,
});

/**
 * The anchor registry: `independenceBetween` returns a positive weight iff the two sources'
 * anchor CLASSES are disjoint, 0 if they share a class — exactly the factworld semantics, now
 * load-bearing across the poison cluster (which here holds genuinely-distinct classes).
 */
function makeAnchorRegistry(bindings: Map<string, AnchorBinding[]>): AnchorRegistryPort {
  return {
    bind: () => {},
    anchorsOf: (s): readonly AnchorBinding[] => bindings.get(String(s)) ?? [],
    aggregateCost: (anchors): Unit => {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween: (a, b): Unit => {
      const ca = new Set(a.map((x) => x.anchorClass));
      const cb = new Set(b.map((x) => x.anchorClass));
      if (ca.size === 0 || cb.size === 0) return 0 as Unit;
      for (const c of ca) if (cb.has(c)) return 0 as Unit; // share a class ⇒ not independent
      return 0.5 as Unit;
    },
  };
}

/**
 * Build the engine over the whole world at a given config, adjudicate every item, and read
 * back per-item LIVE state. ONE engine per (level, mode) — items are isolated by unique
 * (entity, attribute) keys so a single shared store is correct and fast.
 */
export function measureLevel(items: readonly CIItem[], cfg: CIConfig): CILevelResult {
  const store: StrandStore = createMemoryStore();
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const known = new Set<string>();
  const earnTrue: string[] = []; // pre-earned true primaries
  const earnPoison: string[] = []; // pre-earned poison primaries (mode "anchors+rep" only)
  const trustedSources = new Set<string>(); // high rep_cap (legit + bought-credibility poison)

  const L = Math.max(1, Math.min(cfg.independenceLevel, cfg.sybilK));

  let sidx = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const attrKey = attrKeyOf(it.entity, it.attribute);
    const trueHash = `chash:${attrKey}:${it.gold}`;
    const poisonHash = `chash:${attrKey}:${it.poison}`;

    // --- TRUE value: 2 co-asserters, DISJOINT classes (DOMAIN + ORGANIZATION) → #R = 2 ----
    const true1 = `src:true1:${i}`;
    const true2 = `src:true2:${i}`;
    store.putStrand(
      makeValueStrand(`s:${sidx++}`, it.entity, attrKey, it.gold, trueHash, [
        makeRoot(true1, `cls:true1:${i}`, `${sidx}`),
      ]),
    );
    store.putStrand(
      makeValueStrand(`s:${sidx++}`, it.entity, attrKey, it.gold, trueHash, [
        makeRoot(true2, `cls:true2:${i}`, `${sidx}`),
      ]),
    );
    anchorBindings.set(true1, [binding(AnchorClass.DOMAIN)]);
    anchorBindings.set(true2, [binding(AnchorClass.ORGANIZATION)]);
    known.add(true1);
    known.add(true2);
    trustedSources.add(true1);
    trustedSources.add(true2);
    earnTrue.push(true1); // only the PRIMARY true source is pre-earned (recipe step 2)

    // --- POISON value: K sources sharing ONE content_hash, spread across L disjoint classes -
    for (let k = 0; k < cfg.sybilK; k++) {
      const psrc = `src:poison:${i}:${k}`;
      const group = k % L; // L distinct groups ⇒ #R(poison) = L
      const pclass = POISON_CLASS_PALETTE[group % POISON_CLASS_PALETTE.length]!;
      store.putStrand(
        makeValueStrand(`s:${sidx++}`, it.entity, attrKey, it.poison, poisonHash, [
          // The root's independence CLASS string AND its anchor binding both encode the group,
          // so two poison sources are independent iff they sit in DIFFERENT groups.
          makeRoot(psrc, `cls:poison:${i}:g${group}`, `${sidx}`),
        ]),
      );
      anchorBindings.set(psrc, [binding(pclass)]);
      known.add(psrc);
      if (cfg.mode === "anchors+rep") {
        trustedSources.add(psrc); // the attacker bought a high-cap identity for the poison
        if (k === 0) earnPoison.push(psrc); // ...and earns the poison PRIMARY's track record
      }
    }
  }

  const repCapOf = (s: SourceId): Unit => (trustedSources.has(String(s)) ? 0.95 : 0.05) as Unit;
  const clock = (): EpochMs => NOW;
  const reputation: ReputationLedger = createReputationLedger(repCapOf, undefined, clock);
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(known),
    anchors: makeAnchorRegistry(anchorBindings),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = { ledger: createPendingLedger(), systemSource: freshSource().sourceId };
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  // Pre-earn: the true primary (modest, decisive) and — in "anchors+rep" — the poison primary
  // (heavier, out-earning the truth). One ratify per call (w = 1); no depth (fresh α/β only).
  for (const s of earnTrue) for (let r = 0; r < TRUE_PRIMARY_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);
  for (const s of earnPoison) for (let r = 0; r < POISON_PRIMARY_RATIFIES; r++) reputation.ratify(s as SourceId, NOW, 1 as Unit);

  // Adjudicate every item's dispute. DEFER (no ratification picked) leaves both values LIVE;
  // RESOLVE demotes the losing value(s).
  for (const it of items) engine.adjudicate(attrKeyOf(it.entity, it.attribute) as AttributeKey);

  // --- read back per-item LIVE state -----------------------------------------
  let surfaced = 0;
  let captured = 0;
  let goldSurvived = 0;
  for (const it of items) {
    const attrKey = attrKeyOf(it.entity, it.attribute);
    const live = store
      .strandsByAttribute(attrKey as AttributeKey)
      .filter((s) => s.fact_state === FactState.LIVE);
    const values = new Set(live.map((s) => (s.payload as { value: string }).value));
    const poisonLive = values.has(it.poison);
    const goldLive = values.has(it.gold);
    if (poisonLive) surfaced++;
    if (poisonLive && !goldLive) captured++;
    if (goldLive) goldSurvived++;
  }

  const n = items.length || 1;
  const surfacedRate = surfaced / n;
  const capturedRate = captured / n;
  // ASR proxy: capture = 1.0, contamination (surfaced but not captured) = 0.5, defended = 0.
  const asr = capturedRate + 0.5 * (surfacedRate - capturedRate);
  return {
    independenceLevel: L,
    mode: cfg.mode,
    n: items.length,
    surfacedRate,
    capturedRate,
    goldSurvivalRate: goldSurvived / n,
    asr,
  };
}
