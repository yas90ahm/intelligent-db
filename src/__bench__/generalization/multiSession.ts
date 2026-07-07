/**
 * generalization/multiSession.ts — the DURABILITY construction behind TASK B.
 *
 * Proves a contradiction-adjudication DEMOTION survives a process restart: SESSION 1
 * ingests a Sybil poison cluster + a corroborated gold value into a FILE-BACKED SQLite
 * store, pre-earns the primary gold source, adjudicates (poison → DEMOTED, gold → LIVE),
 * then CLOSES the handle. SESSION 2 reopens the SAME file with a FRESH handle and reads
 * `fact_state` straight off disk — no re-adjudication. The attack written in session 1
 * stays neutralized in session 2.
 *
 * The ingest replicates the hard-won adjudication recipe EXACTLY (see arms.ts /
 * highImpactGateR.test.ts):
 *   - GOLD true value = 2 co-asserter strands sharing one content_hash but holding
 *     DISJOINT anchor classes (DOMAIN + ORGANIZATION) ⇒ engine #R = 2 (clears the
 *     structural lock + co-asserter floor). Only the PRIMARY gold source is pre-earned;
 *     the 2nd is an UNEARNED corroborator (rep 0) that only supplies the 2nd disjoint
 *     root (pre-earning both would tie the decisive-margin top-2 at 0 ⇒ DEFER).
 *   - POISON = K Sybil strands sharing ONE anchor class (EMAIL_OAUTH) AND one
 *     content_hash ⇒ #R = 1 ⇒ loses to the corroborated gold ⇒ DEMOTED.
 *
 * This module is pure infra (no test runner). The .test.ts gates it behind an env flag.
 */

import { createRequire } from "node:module";
import { freshSource } from "../../testSupport/identityFixtures.js";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { PRIMARY_WARMUP_RATIFIES } from "../trustWarmup.js";

import {
  createIntelligentDb,
  createSqliteStore,
  createSqliteReputationLedger,
  createSqlitePendingLedger,
  createSourceIdentityLayer,
  asStrandId,
  asEpochMs,
  FactState,
  FactOrigin,
  Tier,
  AnchorClass,
} from "../../index.js";

import type {
  Strand,
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
  SqliteStrandStore,
} from "../../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => DatabaseSyncType;
};

const NOW: EpochMs = asEpochMs(1_700_000_000_000);

/** The world under test: one (entity, attribute) with a gold value + a Sybil poison cluster. */
export interface MultiSessionWorld {
  readonly entity: string;
  readonly attribute: string;
  readonly attrKey: string;
  readonly goldValue: string;
  readonly poisonValue: string;
  /** ids of the two gold co-asserter strands. */
  readonly goldStrandIds: readonly string[];
  /** ids of every Sybil poison strand. */
  readonly poisonStrandIds: readonly string[];
}

const attrKeyOf = (entity: string, attribute: string): string => `${entity}::${attribute}`;

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
 * independenceBetween > 0 iff the two sources' anchor CLASSES are disjoint — so the gold
 * value's two sources (DOMAIN + ORGANIZATION) are independent (#R = 2) while the Sybil
 * cluster (all EMAIL_OAUTH) collapses to a single witness (#R = 1).
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
      for (const c of ca) if (cb.has(c)) return 0 as Unit;
      return 0.5 as Unit;
    },
  };
}

/**
 * SESSION 1 — open the file-backed store, ingest poison + gold, pre-earn, adjudicate so
 * the Sybil cluster is DEMOTED, then CLOSE the handle. Returns the world descriptor so
 * session 2 knows which strand ids / values to assert against. `poisonCount` = K Sybils.
 */
export function ingestSession1(dbPath: string, poisonCount = 8): MultiSessionWorld {
  const entity = "entity:berlin";
  const attribute = "capital_status";
  const attrKey = attrKeyOf(entity, attribute);
  const goldValue = "Berlin";
  const poisonValue = "Atlantis";
  const goldHash = `chash:${attrKey}:${goldValue}`;
  const poisonHash = `chash:${attrKey}:${poisonValue}`;

  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  // The OWNER of this fresh shared handle sets WAL before any shared-handle
  // ledger/store constructor borrows it — `createSqliteReputationLedger`'s and
  // `createSqlitePendingLedger`'s `{ db }` overloads now VERIFY journal_mode=WAL
  // and throw `SharedHandleNotWalError` otherwise (Wave-2 wal-verification fix).
  db.exec("PRAGMA journal_mode=WAL");

  const known = new Set<string>();
  const anchorBindings = new Map<string, AnchorBinding[]>();
  const trustedSources = new Set<string>();

  // --- GOLD: two co-asserters, same content_hash, DISJOINT anchor classes (#R = 2) ---
  const goldPrimary = "src:gold:true1";
  const goldCorrob = "src:gold:true2";
  anchorBindings.set(goldPrimary, [binding(AnchorClass.DOMAIN)]);
  anchorBindings.set(goldCorrob, [binding(AnchorClass.ORGANIZATION)]);
  known.add(goldPrimary);
  known.add(goldCorrob);
  trustedSources.add(goldPrimary);
  trustedSources.add(goldCorrob);

  const goldStrandIds: string[] = [];
  {
    const id1 = "s:gold:0";
    const id2 = "s:gold:1";
    goldStrandIds.push(id1, id2);
  }

  // --- POISON: K Sybils, ONE shared anchor class + ONE shared content_hash (#R = 1) ---
  const poisonStrandIds: string[] = [];
  for (let i = 0; i < poisonCount; i++) {
    const src = `src:sybil:${i}`;
    anchorBindings.set(src, [binding(AnchorClass.EMAIL_OAUTH)]);
    known.add(src);
    poisonStrandIds.push(`s:poison:${i}`);
  }

  // Reputation: gold sources are credible (high cap); Sybils are not.
  const repCapOf = (s: SourceId): Unit => (trustedSources.has(String(s)) ? 0.95 : 0.05) as Unit;
  const reputation: ReputationLedger = createSqliteReputationLedger(repCapOf, {
    db,
    clock: () => NOW,
  });
  const reputationPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 as Unit };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(known),
    anchors: makeAnchorRegistry(anchorBindings),
    reputation: reputationPort,
    stake: stakePort,
  });
  const ratification: RatificationDeps = {
    ledger: createSqlitePendingLedger({ db, reputation }),
    systemSource: freshSource().sourceId,
  };

  const store: SqliteStrandStore = createSqliteStore({ db });
  const engine = createIntelligentDb(store, identity, null, reputation, ratification);

  // File the strands (gold first, then poison).
  store.putStrand(
    makeValueStrand(goldStrandIds[0]!, entity, attrKey, goldValue, goldHash, [
      makeRoot(goldPrimary, "class:gold-domain", "gold-0"),
    ]),
  );
  store.putStrand(
    makeValueStrand(goldStrandIds[1]!, entity, attrKey, goldValue, goldHash, [
      makeRoot(goldCorrob, "class:gold-org", "gold-1"),
    ]),
  );
  for (let i = 0; i < poisonCount; i++) {
    store.putStrand(
      makeValueStrand(poisonStrandIds[i]!, entity, attrKey, poisonValue, poisonHash, [
        makeRoot(`src:sybil:${i}`, "class:sybil", `poison-${i}`),
      ]),
    );
  }

  // Pre-earn ONLY the primary gold source (the corroborator stays at rep 0).
  for (let r = 0; r < PRIMARY_WARMUP_RATIFIES; r++) reputation.ratify(goldPrimary as SourceId, NOW, 1 as Unit);

  // Adjudicate the disputed (entity, attribute): gold (#R=2) wins, poison (#R=1) demoted.
  const outcome = engine.adjudicate(attrKey as AttributeKey);
  if (outcome.kind !== "RESOLVED") {
    store.close();
    throw new Error(`SESSION 1 expected RESOLVED adjudication, got ${outcome.kind}`);
  }

  // Durability barrier: close the OWNING handle (flushes WAL).
  store.close();

  return {
    entity,
    attribute,
    attrKey,
    goldValue,
    poisonValue,
    goldStrandIds,
    poisonStrandIds,
  };
}

/** A read-only session-2 view over the reopened store. */
export interface Session2 {
  /** fact_state of a strand straight off disk (null if missing). */
  factStateOf(strandId: string): FactState | null;
  /** distinct LIVE values for the disputed attribute — what a reader would be told. */
  liveValues(attrKey: string): string[];
  close(): void;
}

/**
 * SESSION 2 — reopen the SAME sqlite file with a FRESH handle. No engine, no reputation,
 * NO re-adjudication: just read `fact_state` and the LIVE value set off disk.
 */
export function openSession2(dbPath: string): Session2 {
  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  const store: SqliteStrandStore = createSqliteStore({ db });
  return {
    factStateOf(strandId: string): FactState | null {
      return store.getStrand(asStrandId(strandId))?.fact_state ?? null;
    },
    liveValues(attrKey: string): string[] {
      const live = store
        .strandsByAttribute(attrKey as AttributeKey)
        .filter((s) => s.fact_state === FactState.LIVE);
      return [...new Set(live.map((s) => (s.payload as { value: string }).value))];
    },
    close(): void {
      store.close();
    },
  };
}
