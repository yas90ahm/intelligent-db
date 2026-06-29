/**
 * api.ts — THE TOP-LEVEL ENGINE API for Intelligent DB.
 *
 * This module is the thin orchestration seam the outside world talks to. It holds
 * NO hard algorithmic cores of its own; it WIRES the subsystems the design
 * (CLAUDE.md) settled on:
 *
 *   - the StrandStore           (latent memory; nothing sits in a readable list)
 *   - the traversal layer       (spreading activation + the resolved two-phase
 *                                halting) — the walk body is crack-A
 *   - the Source-Identity Layer (external "passport control"; the web is NOT
 *                                allowed to be its own witness about identity)
 *   - the forgetting layer      (downward tier movement; never deletion) — the
 *                                eviction-permission gates are crack-B
 *
 * Three verbs, mapped straight onto the two governing invariants of the design:
 *
 *   writeFact(observed)  — the model FILES a memory. It reads, it does not witness.
 *                          The per-edge `provenance_independence` halting weight is
 *                          taken FROM the stamp, never self-computed (invariant 2).
 *   recall(traversal)    — the model SPEAKS. A cue energizes seeds; activation
 *                          spreads; only lit strands are assembled. The model never
 *                          confirms what it recalls (invariant 1).
 *   ratify(external)     — the ONLY verb that may raise belief. It REQUIRES an
 *                          external IdentityStamp. This is the "window" in the
 *                          "wall-with-a-window": a DERIVED fact graduates to
 *                          OBSERVED, or a PROVISIONAL fact is confirmed LIVE, only
 *                          because something OUTSIDE the web ratified it.
 *
 * STATUS: production-grade single-process wiring. The activation-walk body
 * (traversal/walk.ts), the two-phase halting gates (traversal/halting.ts), the
 * contradiction adjudication / tier-eviction permission (forgetting/consolidation.ts),
 * and the full retroactive disown sweep (ratification/disown.ts, reached via the
 * `disown` verb) are all IMPLEMENTED. A couple of `// TODO(crack-B)` markers below name
 * the optional `ConsolidationPort` keep-pressure recompute seam, which is a no-op until
 * a forgetting layer is injected — not an unfinished core. Every wiring, signature, and
 * type here is complete and type-checks against core/types.ts and the sibling contracts.
 *
 * STACK NOTE: ESM + NodeNext means relative imports carry the `.js` extension;
 * `verbatimModuleSyntax` means every type-only import MUST use `import type`.
 */

import { randomUUID, createHash } from "node:crypto";

import {
  FactState,
  FactOrigin,
  EdgeType,
  Tier,
  DEFAULT_WALK_CONFIG,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "./core/types.js";

import type {
  StrandId,
  EdgeId,
  EntityId,
  AttributeKey,
  ContentHash,
  ContradictionSetId,
  SourceId,
  ProvenanceRootId,
  EpochMs,
  IdentityStamp,
  ProvenanceRoot,
  Edge,
  Strand,
  Salience,
  BridgeAccounting,
  WalkConfig,
  LitStrand,
  HaltStamp,
} from "./core/types.js";

import type { StrandStore, StoreTxn } from "./store/StrandStore.js";
import type { WalkSeed, WalkResult } from "./traversal/walk.js";
import { activationWalk } from "./traversal/walk.js";
import type { HaltingController } from "./traversal/halting.js";
import { createHaltingController } from "./traversal/halting.js";
import type { SourceIdentityLayer } from "./identity/index.js";
import type { ReputationLedger, ReputationState } from "./identity/reputation.js";
import type { KeyPair } from "./identity/keys.js";

import {
  buildContradictionSet,
  tryConsolidate,
} from "./forgetting/consolidation.js";
import type {
  ConsolidationOutcome,
  HighImpactContext,
} from "./forgetting/consolidation.js";

import type {
  PendingLedger,
  PendingPayload,
  ResolvedDispute,
  ApproveContext,
  MutationPayload,
} from "./ratification/pendingLedger.js";
import { EMPTY_STATE_HASH } from "./ratification/pendingLedger.js";
import {
  hashReputationState,
  hashStrandState,
  hashSubjectId,
  mutationReceipt,
} from "./ratification/mutationReceipt.js";
import type {
  MerkleLog,
  PublicationSink,
  STH,
} from "./ratification/merkleLog.js";
import { createMerkleLog } from "./ratification/merkleLog.js";
import type { CorroborationLedger } from "./ratification/corroboration.js";
import type { AdjudicationProvenanceLedger } from "./ratification/adjudicationProvenance.js";
import type { WeakInfluenceLedger } from "./ratification/weakInfluence.js";
import { assertRatifyEmitsEvent } from "./ratification/reconcile.js";
import {
  downstreamDisownSweep,
  type DownstreamDisownResult,
  type DisownHardeningDeps,
} from "./ratification/disown.js";

// ---------------------------------------------------------------------------
// Forgetting/consolidation integration port (crack-B seam)
// ---------------------------------------------------------------------------
//
// forgetting/consolidation.ts owns the eviction-PERMISSION gates, which are a
// crack-B core. The only lifecycle hook the ENGINE needs from it is "an external
// ratification just changed this strand's independent-root count — recompute its
// keep-pressure." That single collaborator method is declared locally as a narrow
// PORT so api.ts stays decoupled from (and type-checks ahead of) the concrete
// consolidation module landing. When forgetting/consolidation.ts ships its
// `ConsolidationLayer`, it is intended to be assignable to this port and injected
// where `#consolidation` is set.
//
// TODO(crack-B): replace this local port with a direct
//   `import type { ConsolidationLayer } from "./forgetting/consolidation.js";`
//   once that module exists, keeping the same keep-pressure recompute method.

/**
 * The narrow forgetting-layer surface the engine drives. Keeps api.ts independent
 * of the crack-B consolidation internals (decay pressure + the AND-of-gates
 * eviction permission), which the engine never calls directly.
 */
export interface ConsolidationPort {
  /**
   * Recompute keep-pressure for a strand after an EXTERNAL ratification added an
   * independent root to it. A fresh external root raises the strand's
   * independent-source count (a forgetting-layer input read from the identity
   * layer, never self-computed), which can only ever protect it from eviction.
   *
   * The body lives in forgetting/consolidation.ts behind the crack-B gates; this
   * is purely the call site.
   */
  onExternalRatification(strandId: StrandId, externalStamp: IdentityStamp): void;
}

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

/**
 * Input to {@link IntelligentDb.writeFact}. Files a single OBSERVED fact.
 *
 * The `stamp` is mandatory: an observed fact with no identity stamp has no voice
 * (CLAUDE.md invariant 1: "No provenance → no voice"). The engine reads
 * `provenance_independence` for the new strand's edges out of this stamp — it is
 * NEVER self-computed by the web (invariant 2).
 */
export interface WriteFactInput {
  /** The real-world entity this fact is about (the mechanical shared-entity join key). */
  readonly entity: EntityId;
  /** The (entity, attribute) this fact claims something about, if applicable. */
  readonly attribute?: AttributeKey;
  /** Opaque payload of the claim (the librarian decides structure, not this layer). */
  readonly payload: unknown;
  /** The Source-Identity Layer's stamp for the source behind this observation. */
  readonly stamp: IdentityStamp;
}

/**
 * Input to {@link IntelligentDb.recall}. A cue is one or more seed strands to
 * energize; activation spreads from them across the web until the halting
 * controller says to stop and speak.
 */
export interface RecallCue {
  /** Seed strands to energize (the cue's points of contact with the web). */
  readonly seeds: readonly WalkSeed[];
  /** Optional walk tuning; {@link DEFAULT_WALK_CONFIG} is used when absent. */
  readonly config?: WalkConfig;
}

/**
 * Output of {@link IntelligentDb.recall}. `lit` are the strands that lit up (to be
 * assembled into an answer); `halt` explains how/why the walk stopped — never a
 * silent stop (CLAUDE.md: halting fails open and always stamps a reason).
 */
export interface RecallResult {
  /** The strands that lit, with the activation each ended the walk holding. */
  readonly lit: readonly LitStrand[];
  /** The halt stamp: reason code + pop/bridge counts + degraded flag. */
  readonly halt: HaltStamp;
}

/**
 * Input to {@link IntelligentDb.ratify}. Promotes a single strand on the strength
 * of an EXTERNAL identity stamp.
 *
 * This is the only engine verb that may raise belief, and it structurally requires
 * an `externalStamp`: the web cannot ratify itself (invariant 1, "never its own
 * witness"). Depending on the strand's current state this either graduates a
 * DERIVED fact to OBSERVED (the "window") or confirms a PROVISIONAL fact LIVE.
 */
export interface RatifyInput {
  /** The strand to promote. */
  readonly strandId: StrandId;
  /** The external source's stamp authorizing the promotion (mandatory). */
  readonly externalStamp: IdentityStamp;
  // NOTE (OD-8, engine-owned-evidence): there is deliberately NO caller-supplied
  // corroborator list. When this ratify raises the source's reputation AND a
  // corroboration ledger is wired, the engine DERIVES the agreement set itself
  // (#deriveAgreementSet — same entity + content_hash + LIVE) and records the event
  // with the EXACT applied delta, so a later disown can reverse precisely that credit.
  // The caller can no longer inject which strands "corroborated" the claim.
}

// ---------------------------------------------------------------------------
// The engine interface
// ---------------------------------------------------------------------------

/**
 * The top-level Intelligent DB engine. Three verbs, two invariants. All belief
 * changes flow through here; nothing else mutates `fact_state`.
 */
export interface IntelligentDb {
  /**
   * File a new OBSERVED fact. Mints an OBSERVED strand, reads
   * `provenance_independence` for its edges out of `input.stamp`, and attaches it
   * to the web.
   *
   * Scaffold attachment policy: the librarian (the AI model that decides WHERE a
   * strand attaches) is out of scope here, so attachment is purely the mechanical,
   * checkable rule — SHARED_ENTITY. That relation is an INDEX, not a materialized
   * clique: the store's `strandsByEntity` index (maintained by `putStrand`) IS the
   * shared-entity join, and the activation walk DERIVES same-entity siblings from it
   * at read time. No SHARED_ENTITY edges are minted here, so the shared-entity part
   * of writeFact is O(1) (one put), not O(siblings). Confirmed-relationship
   * (CONFIRMED_LINK) and CROSS_WEB_BRIDGE edges are the librarian's job, unchanged.
   *
   * @returns the id of the newly created strand.
   */
  writeFact(input: WriteFactInput): StrandId;

  /**
   * Bulk-ingest equivalent of calling {@link writeFact} N times. Mints the SAME
   * OBSERVED strands `writeFact` would (per-fact `now()` timestamp, identical
   * provenance/attachment semantics — see {@link writeFact}), but commits them as
   * ONE transaction paying ONE durability barrier instead of N. Semantically there
   * is no difference between `writeFactsBatch([a, b, c])` and
   * `writeFact(a); writeFact(b); writeFact(c)` in the resulting stored strands; the
   * batch verb simply amortizes the per-fact mint/serialization round-trips and the
   * per-write commit cost across the whole input.
   *
   * @returns the ids of the newly created strands, in input order (one per input).
   */
  writeFactsBatch(inputs: readonly WriteFactInput[]): StrandId[];

  /**
   * Run a traversal. Builds a {@link HaltingController} and a share-normalized
   * best-first activation walk over the store seeded by the cue, then returns the
   * lit strands plus the halt stamp. The model SPEAKS here; it does not confirm.
   */
  recall(cue: RecallCue): RecallResult;

  /**
   * Promote a strand because an EXTERNAL source ratified it. DERIVED → OBSERVED
   * (the wall's window) or PROVISIONAL → LIVE. Requires an external stamp; the web
   * is never its own witness.
   */
  ratify(input: RatifyInput): void;

  /**
   * ADJUDICATE a contradiction over an (entity, attribute): resolve the member
   * strands from the store, build the per-root identity stamps, run the PURE
   * {@link tryConsolidate}, and ROUTE the outcome:
   *   - RESOLVED  → persist each loser's demotion + the OUTRANKS edge, and drive
   *                 `reputation.contradict` on the losers.
   *   - DEFERRED  → record the {@link PendingRatification} in the ratification
   *                 LEDGER (a signed PENDING record) for the second-admin horn.
   *                 NOTHING is demoted — only an external `approve()` may resolve it.
   *   - NOOP      → nothing to do.
   *
   * Returns the raw {@link ConsolidationOutcome} so the caller can observe the
   * routing decision. The web NEVER picks an in-graph winner for an independent
   * dispute; it only queues it.
   *
   * Set {@link AdjudicateOptions.highImpact} `true` to flag the decision IRREVERSIBLE: a
   * decisive LCB margin then becomes necessary but NOT sufficient — the winner must also
   * clear the ENGINE-BUILT count/recency/≥2-independent-root gate (the engine constructs
   * that evidence from its own trust layer; the caller supplies only the intent flag),
   * else DEFER no matter the gap.
   */
  adjudicate(attribute: AttributeKey, opts?: AdjudicateOptions): ConsolidationOutcome;

  /**
   * RETROACTIVELY DISOWN A FRAUDULENT SOURCE (the full undo engine, ARCHITECTURE.md §4 +
   * pillar 4). Enumerates every strand the source asserted (its seed), then runs the
   * store-aware {@link downstreamDisownSweep} inside ONE transaction over the store + the
   * wired reputation/corroboration/adjudication/weak-influence ledgers:
   *   - craters the disowned source's earned credit to the prior Beta(1,1);
   *   - DEMOTES (never deletes) every strand transitively DERIVED from a tainted strand,
   *     SPARING those whose independent corroboration survives (false-disown protection);
   *   - reverses the EXACT recorded corroboration credit on each beneficiary;
   *   - RE-OPENS any RESOLVED dispute a tainted strand merely tipped (as PENDING);
   *   - routes consulted-but-not-cited works to a HUMAN review queue.
   *
   * Requires a reputation ledger to be wired (the credit substrate); the hardening
   * ledgers are taken from the wired {@link RatificationDeps} when present. Idempotent:
   * a second disown of the same source is a clean no-op.
   *
   * @throws if no reputation ledger is wired (there is nothing to claw back).
   * @returns the {@link DownstreamDisownResult} receipt (demotions, reversals, re-opens).
   */
  disown(sourceId: SourceId, opts?: DisownOptions): DownstreamDisownResult;

  /**
   * The OPEN deferred disputes awaiting a human/second-admin decision (the doorbell
   * queue), reputation-ranked for a reviewer. Requires a ratification ledger to be
   * wired; returns `[]` otherwise.
   */
  listPending(): readonly PendingPayload[];

  /**
   * RESOLVE a deferred dispute by an EXTERNAL approver's decision (the second-admin
   * answer). Records a signed APPROVAL receipt in the immortal ledger, then APPLIES
   * the resolution to the store: winner stays LIVE; losers DEMOTED + `outranked_by`
   * set (never deleted); the minted OUTRANKS edges persisted; reputation driven.
   * REQUIRES the approver to be DISTINCT from every source that authored a member
   * (rejects self-approval) and to present a verifiable passport.
   *
   * @throws if no ratification ledger is wired, the dispute is unknown / resolved,
   *         the winner is not a member, the approver is self / forged.
   */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    now?: EpochMs,
  ): ResolvedDispute;

  /**
   * A2 EPOCH TICK: publish the current Signed Tree Head to every wired sink
   * (operator/cron-driven, NEVER per-op — this is the per-op anchoring VETO honored at
   * the engine seam). Returns the published {@link STH}, or `null` when no merkle layer
   * is wired. Off the write/recall path.
   */
  anchorEpoch(now?: EpochMs): STH | null;

  /**
   * A2: publish the GENESIS STH (the empty tree) once at init so pre-first-anchor history
   * is not attacker-choosable. Returns the published STH, or `null` when unwired.
   */
  publishGenesis(now?: EpochMs): STH | null;

  /**
   * A2: the wired {@link MerkleLog} (for witness checks / inclusion proofs), or `null`
   * when no merkle layer is wired.
   */
  merkleLog(): MerkleLog | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct an {@link IntelligentDb} over a concrete {@link StrandStore} and a
 * {@link SourceIdentityLayer}. The store is pluggable (the in-memory store is the
 * default backend; a faster one may replace it later); the identity layer is the
 * external trust root the web defers to for source independence.
 *
 * The forgetting/consolidation hook is optional in the scaffold (the eviction
 * gates are crack-B). Pass one once forgetting/consolidation.ts lands; until then
 * keep-pressure recompute is a no-op.
 *
 * The reputation ledger is the LIVE CREDIT-SCORE backend (pillar 3). When supplied,
 * the `ratify` verb drives `ledger.ratify(...)` so earned trust accrues from the
 * only belief-raising verb, and the SAME ledger instance must back the identity
 * facade's `ReputationLedgerPort.scoreOf` so the next `stampFor` reflects it. When
 * null (the scaffold default), ratification raises belief but earns no reputation.
 */
export function createIntelligentDb(
  store: StrandStore,
  identity: SourceIdentityLayer,
  consolidation: ConsolidationPort | null = null,
  reputation: ReputationLedger | null = null,
  ratification: RatificationDeps | null = null,
): IntelligentDb {
  return new IntelligentDbImpl(store, identity, consolidation, reputation, ratification);
}

/**
 * The ratification wiring the engine needs to back the {@link PendingRatification}
 * horn: the append-only signed LEDGER (vault + doorbell) and the SYSTEM signer (the
 * engine's own passport) used to sign PENDING records. Optional — when absent, the
 * engine still adjudicates (RESOLVED/NOOP) but cannot DEFER or approve (it throws on
 * those paths so a deferred dispute is never silently dropped).
 */
export interface RatificationDeps {
  /** The immortal, hash-chained, signed ratification ledger. */
  readonly ledger: PendingLedger;
  /** The engine's passport, signing every system-authored PENDING record. */
  readonly systemSigner: KeyPair;
  /**
   * Optional CORROBORATION-EVENT LEDGER. When supplied, the `ratify` verb RECORDS a
   * corroboration event with the EXACT applied reputation delta whenever an external
   * ratification both raises a source's score AND names the strand(s) it corroborated
   * — closing the formerly-deferred crack-A credit-reversal. The SAME instance must be
   * passed to {@link downstreamDisownSweep} so a later disown can reverse the credit.
   */
  readonly corroboration?: CorroborationLedger;
  /**
   * Optional ADJUDICATION-PROVENANCE LEDGER (HARDENING 3, threshold-effects channel).
   * When supplied, `adjudicate` RECORDS the winning margin + contributing strands of
   * every RESOLVED dispute, so a later disown can RE-OPEN a dispute a tainted strand
   * merely tipped. The SAME instance the engine's {@link IntelligentDb.disown} verb
   * passes into {@link downstreamDisownSweep}.
   */
  readonly adjudicationProvenance?: AdjudicationProvenanceLedger;
  /**
   * Optional WEAK-INFLUENCE LEDGER (HARDENING 1, uncited-influence channel). When
   * supplied, the engine's {@link IntelligentDb.disown} verb routes consulted-but-not-
   * cited works of the disowned source to a HUMAN review queue (never auto-demoting
   * them). Recorded out-of-band by the librarian when a strand is consulted without a
   * DERIVATION citation.
   */
  readonly weakInfluence?: WeakInfluenceLedger;
  /**
   * A2 [optional/latent] — wire a {@link MerkleLog} over the SAME ratification ledger so
   * a witness can detect a hidden disown (mk-m3). OMITTED (the default) ⇒ behavior is
   * back-compatible: A1 MUTATION receipts are STILL journaled latently into the ledger
   * (the audit COVERAGE), but NO STH is published and no sink is written. When supplied,
   * the engine builds the log at construction (`createMerkleLog` enforces ≥2 independent
   * sinks — fail-closed at wiring time) and exposes {@link IntelligentDb.anchorEpoch} /
   * {@link IntelligentDb.publishGenesis} / {@link IntelligentDb.merkleLog}.
   */
  readonly merkle?: { readonly signer: KeyPair; readonly sinks: readonly PublicationSink[] };
}

/**
 * Optional knobs for {@link IntelligentDb.adjudicate}. Setting `highImpact: true`
 * flags the decision IRREVERSIBLE — a decisive LCB margin then becomes NECESSARY BUT
 * NOT SUFFICIENT: the winner must additionally clear the ENGINE-BUILT corroboration-
 * count, recency-clean, and ≥2-independent-root gate (ARCHITECTURE.md §2), else the
 * dispute DEFERS to a human no matter the gap. Omit it for ordinary adjudication.
 */
export interface AdjudicateOptions {
  /**
   * INTENT only: flag this decision IRREVERSIBLE. The engine builds the gate
   * evidence from its OWN trust layer (#reputation + #identity + the agreement
   * index); the caller supplies NO evidence proxy (OD-8, engine-owned-evidence).
   */
  readonly highImpact?: boolean;
}

/**
 * Options for {@link IntelligentDb.disown}. The disown verb craters the source's earned
 * credit, demotes its derivatives (sparing independently-corroborated ones), reverses
 * the exact corroboration credit, and re-opens any dispute a tainted strand merely
 * tipped — all atomically over the store + the wired ledgers.
 */
export interface DisownOptions {
  /**
   * Enable the FALSE-DISOWN-AS-SUPPRESSION protection (HARDENING 4): a derived strand
   * whose GENUINELY-INDEPENDENT corroboration survives removal of the tainted set is
   * SPARED demotion. DEFAULT `true` at the engine seam — disowning a rival must not
   * silently suppress their independently-corroborated downstream work. Set `false`
   * to restore the demote-every-derivative closure.
   */
  readonly checkSurvivingSupport?: boolean;
  /** Minimum distinct surviving independent classes to spare a strand (HARDENING 4; default 2). */
  readonly minSurvivingSupport?: number;
  /** The decisive-margin threshold a re-opened dispute's surviving margin is checked against (HARDENING 3). */
  readonly decisiveMargin?: number;
  /** Witness time of the disown (defaults to now). */
  readonly at?: EpochMs;
}

// ---------------------------------------------------------------------------
// Strand / edge construction helpers (SIMPLE parts — fully implemented)
// ---------------------------------------------------------------------------

/** Now, as the branded {@link EpochMs} the model uses everywhere. */
function now(): EpochMs {
  return asEpochMs(Date.now());
}

/** Content-address a payload for the immortal archive stub + cold-store backpointer. */
function hashPayload(entity: EntityId, payload: unknown): ContentHash {
  const h = createHash("sha256");
  h.update(String(entity));
  h.update("\u0000");
  h.update(JSON.stringify(payload ?? null));
  return h.digest("hex") as ContentHash;
}

/**
 * Build the provenance root-set for a newly observed strand from its stamp. The
 * source's passport key becomes the root's source; the independence CLASS is
 * offline-assigned elsewhere, so the scaffold seeds it from the source id (one
 * root, one class) — the identity layer's `independentRootCount` is the authority
 * that later collapses same-class echoes.
 */
function provenanceFromStamp(stamp: IdentityStamp, at: EpochMs): readonly ProvenanceRoot[] {
  return [
    {
      rootId: (`root:${randomUUID()}` as ProvenanceRoot["rootId"]),
      // Offline-assigned in production; scaffold derives one class per source key.
      independenceClass: (`class:${String(stamp.source_id)}` as ProvenanceRoot["independenceClass"]),
      sourceId: stamp.source_id,
      establishedAt: at,
    },
  ];
}

/** Default per-traversal-independent salience for a freshly observed strand. */
function freshSalience(at: EpochMs): Salience {
  return { s: 1, last_fire_time: at, lambda: 0.05, fire_count: 0 };
}

/** Zeroed bridge accounting; only meaningful once a strand owns CROSS_WEB_BRIDGE edges. */
function emptyBridgeAccounting(): BridgeAccounting {
  return { earned_bridge_value: 0, far_side_potential: 0 };
}

/**
 * Construct a fresh OBSERVED strand. New observed strands are pinned WARM for an
 * un-forgeable grace window (CLAUDE.md forgetting floor) and start LIVE; their
 * `observedAt` sets the grace floor.
 */
function makeObservedStrand(input: WriteFactInput, at: EpochMs): Strand {
  const id = asStrandId(`strand:${randomUUID()}`);
  return {
    id,
    entity: input.entity,
    attribute: input.attribute ?? null,
    payload: input.payload,
    content_hash: hashPayload(input.entity, input.payload),
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM, // pinned WARM for the grace window
    provenance: provenanceFromStamp(input.stamp, at),
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: emptyBridgeAccounting(),
    salience: freshSalience(at),
    description_value: 0,
    observedAt: at,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  };
}

// ---------------------------------------------------------------------------
// Atomic compound-write helper (one all-or-nothing unit of work)
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside ONE store transaction so a COMPOUND operation — many strand/edge
 * writes plus the reputation/audit-record writes that ride the SAME shared db handle
 * — is ALL-OR-NOTHING: a crash or thrown error mid-operation leaves either the FULL
 * effect or NONE, never a half-applied state (a demoted loser with no OUTRANKS edge,
 * an audit record with no matching demotion, a half-finished disown sweep).
 *
 * Mechanics: if the store exposes {@link StrandStore.beginTxn} (the durable SQLite
 * backend), open a txn, run `fn`, and `commit()`; on throw, `rollback()` and rethrow.
 * Because the reputation ledger and the ratification (audit) ledger write through the
 * SAME `DatabaseSync` handle when wired in shared-handle mode, their INSERT/UPDATEs
 * enroll in this transaction automatically — facts, trust, and audit commit together.
 *
 * NO-OP path: if the store has no `beginTxn` (the in-memory backend, already
 * atomic-per-call by construction), `fn` simply runs directly — exactly what the
 * {@link StoreTxn} contract permits. The engine is correct either way.
 */
function withTxn<T>(store: StrandStore, fn: () => T): T {
  const begin = store.beginTxn?.bind(store);
  if (begin === undefined) {
    // In-memory backend: no unit of work; each call is already atomic. Run directly.
    return fn();
  }
  const txn: StoreTxn = begin();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    // A throw mid-operation must ALWAYS reach rollback (sync API; no await can skip it).
    txn.rollback();
    throw err;
  }
  txn.commit();
  return result;
}

// ---------------------------------------------------------------------------
// Concrete engine
// ---------------------------------------------------------------------------

/**
 * Concrete engine. Holds the store + identity layer (+ optional consolidation
 * hook). Kept un-exported: callers depend on the {@link IntelligentDb} interface
 * and the {@link createIntelligentDb} factory only.
 */
class IntelligentDbImpl implements IntelligentDb {
  readonly #store: StrandStore;
  readonly #identity: SourceIdentityLayer;
  /** Optional forgetting hook; null in the scaffold (crack-B gates live there). */
  readonly #consolidation: ConsolidationPort | null;
  /**
   * Optional LIVE reputation backend (pillar 3). When present, `ratify` drives its
   * `ratify(...)` so earned trust accrues; it MUST be the same instance the
   * identity facade reads `scoreOf` from, or the stamp won't move. Its `contradict`
   * is exposed/ready for the demotion / adjudication path A (not driven here yet).
   */
  readonly #reputation: ReputationLedger | null;
  /**
   * Optional ratification backing (the vault + doorbell). When present, DEFERRED
   * disputes are recorded in `#ratification.ledger` signed by
   * `#ratification.systemSigner`, and `approve` resolves them. Null in the scaffold.
   */
  readonly #ratification: RatificationDeps | null;

  /**
   * A2 [optional/latent] — the wired Merkle log over the ratification ledger, or null
   * when `ratification.merkle` was omitted. Built once at construction; never touched on
   * a verb path (anchoring is exclusively {@link anchorEpoch}).
   */
  readonly #merkleLog: MerkleLog | null;

  /**
   * M3 anti-grief (BATCH 4, OD-2 seam family) — the per-source-pair contradiction
   * RATE-LIMITER. Keyed `${contradictor}->${target}:${class}` → the witness time it
   * last SCARRED. A given contradictor→target pair may add a NON-DECAYING scar at most
   * ONCE per independence class per {@link #SCAR_WINDOW_MS}; a repeat inside the window
   * falls back to an ordinary (decaying) contradiction. This blocks a single attacker
   * STACKING many w-weighted contradictions to grief an honest incumbent, while leaving
   * a genuine SECOND independent class free to scar (different pair / different class).
   * First-arrival-safe: the scar penalizes the CONTRADICTED party, never the late-arriver.
   */
  readonly #scarLimiter = new Map<string, EpochMs>();
  /** The per-pair scar rate-limit window (one decay half-life, 90 days). */
  readonly #SCAR_WINDOW_MS = 90 * 86_400_000;

  constructor(
    store: StrandStore,
    identity: SourceIdentityLayer,
    consolidation: ConsolidationPort | null,
    reputation: ReputationLedger | null,
    ratification: RatificationDeps | null,
  ) {
    this.#store = store;
    this.#identity = identity;
    this.#consolidation = consolidation;
    this.#reputation = reputation;
    this.#ratification = ratification;
    // A2: build the Merkle log over the SAME ratification ledger when wired.
    // `createMerkleLog` throws on <2 sinks — correct fail-closed, surfaced at construction.
    this.#merkleLog =
      ratification?.merkle !== undefined
        ? createMerkleLog({
            ledger: ratification.ledger,
            signer: ratification.merkle.signer,
            sinks: ratification.merkle.sinks,
          })
        : null;
  }

  /**
   * A1 [Merkle MUTATION coverage] — journal ONE content-addressed MUTATION receipt into
   * the wired ratification ledger, signed by the system signer. A no-op when no
   * ratification ledger is wired (nowhere to journal — the latent-journaling gate). Call
   * sites sit INSIDE the compound op's `withTxn` envelope so receipt + mutation commit
   * atomically.
   */
  #emitMutation(payload: MutationPayload): void {
    if (this.#ratification !== null) {
      this.#ratification.ledger.appendMutation(payload, this.#ratification.systemSigner);
    }
  }

  anchorEpoch(at?: EpochMs): STH | null {
    return this.#merkleLog === null ? null : this.#merkleLog.anchor(at ?? now());
  }

  publishGenesis(at?: EpochMs): STH | null {
    return this.#merkleLog === null ? null : this.#merkleLog.publishGenesis(at ?? now());
  }

  merkleLog(): MerkleLog | null {
    return this.#merkleLog;
  }

  // -------------------------------------------------------------------------
  // Engine-owned evidence: the shared R-primitive (OD-6) + the high-impact gate
  // context the engine CONSTRUCTS from its own trust layer (OD-8).
  // -------------------------------------------------------------------------

  /**
   * The AGREEMENT SET of a strand: every OTHER strand asserting the SAME VALUE about the
   * SAME ENTITY and still LIVE. Agreement = same `entity` + same `content_hash` (the
   * mechanical value fingerprint) + LIVE. Resolved via the store's ENTITY INDEX
   * (`strandsByEntity`), so it is O(k) in the entity's strand count — NEVER an
   * `allStrands()` scan (perf VETO). `attribute` may be null; entity-scoping plus
   * content_hash equality IS the value test.
   *
   * The single shared agreement basis (OD-6): both the ratify corroboration recorder and
   * {@link #R} read THIS, so the three downstream consumers cannot drift into ad-hoc sets.
   */
  #deriveAgreementSet(target: Strand): StrandId[] {
    const out: StrandId[] = [];
    for (const s of this.#store.strandsByEntity(target.entity)) {
      if (s.id === target.id) continue;
      if (s.fact_state !== FactState.LIVE) continue;
      if (s.content_hash !== target.content_hash) continue; // same VALUE fingerprint
      out.push(s.id);
    }
    return out;
  }

  /**
   * The R-primitive (OD-6): the number of mutually anchor-INDEPENDENT actors backing the
   * winning VALUE. Unions the provenance roots of `target` with every agreeing LIVE
   * strand's roots (deduped by `rootId` so a same-root flood counts once), then defers to
   * the identity layer's exact MIS (`independentRootCount`, Bron–Kerbosch +
   * `min(distinctClassCount, maxSetSize)` clamp). The clamp is anti-inflationary: the
   * count can only make the gate HARDER → never a false CLEAR, worst case over-defer.
   *
   * Per-VALUE (requires same `content_hash`) — corroboration arrives BOTH as `ratify`
   * appending an external root AND as separate agreeing strands; the old single-strand
   * `winner.provenance` read under-counted the latter.
   */
  #R(target: Strand | null): number {
    if (target === null) return 0; // fail-closed
    const byRootId = new Map<ProvenanceRootId, ProvenanceRoot>();
    const absorb = (roots: readonly ProvenanceRoot[]): void => {
      for (const r of roots) if (!byRootId.has(r.rootId)) byRootId.set(r.rootId, r);
    };
    absorb(target.provenance);
    for (const sid of this.#deriveAgreementSet(target)) {
      const s = this.#store.getStrand(sid);
      if (s !== null) absorb(s.provenance);
    }
    return this.#identity.independentRootCount([...byRootId.values()]);
  }

  /**
   * The PRIMARY (representative) source backing a strand — its first non-null provenance
   * `sourceId` — used as the contradictor identity in the per-pair scar rate-limit. Null
   * if the strand is unknown or carries no resolvable source.
   */
  #primarySourceOf(strandId: StrandId | null, members: readonly Strand[]): SourceId | null {
    if (strandId === null) return null;
    const s = members.find((m) => m.id === strandId) ?? this.#store.getStrand(strandId);
    if (s === null) return null;
    for (const root of s.provenance) if (root.sourceId !== null) return root.sourceId;
    return null;
  }

  /**
   * M3 anti-grief — decide whether an ADJUDICATED contradiction may SCAR (route into the
   * NON-DECAYING `scarBeta`) under the per-source-pair rate-limit. Returns true (and
   * records the witness time) the FIRST time a given `contradictor→target` pair scars a
   * given independence `class` within {@link #SCAR_WINDOW_MS}; returns false for a repeat
   * inside the window (so the caller falls back to an ordinary decaying contradiction).
   * A null contradictor (unknown winner source) still scars once per (target, class) —
   * fail-safe toward recording the betrayal, not toward griefing (the window still caps it).
   */
  #admitScar(contradictor: SourceId | null, target: SourceId, klass: string, at: EpochMs): boolean {
    const key = `${String(contradictor ?? "?")}->${String(target)}:${klass}`;
    const last = this.#scarLimiter.get(key);
    if (last !== undefined && (at as number) - (last as number) < this.#SCAR_WINDOW_MS) {
      return false; // already scarred this pair/class in-window ⇒ ordinary contradiction
    }
    this.#scarLimiter.set(key, at);
    return true;
  }

  /**
   * Build the {@link HighImpactContext} the pure consolidation gate consumes — entirely
   * from the engine's OWN trust layer (#reputation + #identity + the agreement index),
   * keyed by the prospective winner's {@link StrandId} (OD-8: no caller-supplied evidence
   * proxy). The pure module's interface is UNCHANGED; only its CONSTRUCTION lives here.
   */
  #buildHighImpactContext(members: readonly Strand[]): HighImpactContext {
    const byId = new Map<StrandId, Strand>();
    for (const m of members) byId.set(m.id, m);

    const rootsOf = (winner: StrandId): readonly ProvenanceRoot[] => {
      const w = byId.get(winner);
      return w ? w.provenance : [];
    };

    return {
      // (a) earned corroboration count — from the reputation ledger the engine owns.
      corroborationCountOf: (winner): number => {
        if (this.#reputation === null) return 0; // fail-closed: no ledger ⇒ 0
        let best = 0;
        for (const root of rootsOf(winner)) {
          if (root.sourceId === null) continue;
          const st = this.#reputation.stateOf(root.sourceId);
          if (st && st.ratifiedCount > best) best = st.ratifiedCount;
        }
        return best;
      },
      // (b) most-recent contradiction time — fail-closed if unknown: a contradicted
      //     source carrying no timestamp is treated as contradicted-now so the recency
      //     window FAILS and the dispute DEFERS.
      lastContradictionAtOf: (winner): EpochMs | null => {
        if (this.#reputation === null) return null;
        let latest: EpochMs | null = null;
        for (const root of rootsOf(winner)) {
          if (root.sourceId === null) continue;
          const st = this.#reputation.stateOf(root.sourceId);
          if (!st) continue;
          const t: EpochMs | null =
            st.lastContradictionAt ?? (st.contradictedCount > 0 ? now() : null);
          if (t !== null && (latest === null || (t as number) > (latest as number))) latest = t;
        }
        return latest;
      },
      // (c) F1: count independent ROOTS, not anchor CLASSES — the R-primitive.
      anchorClassCountOf: (winner): number => this.#R(byId.get(winner) ?? null),
    };
  }

  /**
   * OD-2 [horn rate-limiting]: the distinct disputing SOURCE ids behind a dispute's
   * members — engine-OWNED evidence the ledger cannot derive (it sees only StrandIds and
   * has no identity layer). Unions `provenance[].sourceId` across the disputed members,
   * dropping nulls, deduped + sorted for determinism. O(members), control-plane.
   */
  #disputingSourcesOf(members: readonly Strand[]): SourceId[] {
    const set = new Set<SourceId>();
    for (const m of members) {
      for (const root of m.provenance) {
        if (root.sourceId !== null) set.add(root.sourceId);
      }
    }
    return [...set].sort();
  }

  /**
   * OD-2 [horn rate-limiting]: the cross-attribute dedup key — a hash of the disputed
   * VALUE fingerprint (the sorted member `content_hash`es) + the sorted disputing-source
   * set, with `attribute` EXCLUDED. So the SAME source-pair disputing the SAME value
   * across many attributes coalesces to ONE enqueue. O(members), control-plane.
   */
  #disputeCoalesceKey(members: readonly Strand[]): string {
    const values = [...new Set(members.map((m) => String(m.content_hash)))].sort();
    const sources = this.#disputingSourcesOf(members).map(String);
    return createHash("sha256")
      .update("vals:" + values.join(",") + "|srcs:" + sources.join(","), "utf8")
      .digest("hex");
  }

  // -------------------------------------------------------------------------
  // writeFact — the model FILES (it does not witness)
  // -------------------------------------------------------------------------

  writeFact(input: WriteFactInput): StrandId {
    const at = now();

    // 1) Mint the OBSERVED strand. `provenance_independence` for its edges is read
    //    FROM input.stamp (invariant 2); the strand itself carries the source's
    //    provenance root derived from the same stamp.
    const fresh = makeObservedStrand(input, at);

    // 2) Mechanical attachment by SHARED_ENTITY — represented as an INDEX, not a
    //    materialized clique. "All facts about entity E are related" is a lookup
    //    (the store's `strandsByEntity` index, already maintained by `putStrand`),
    //    NOT an O(N^2) edge mesh. We therefore mint NO SHARED_ENTITY edges here: the
    //    fresh strand is simply put, and the activation walk DERIVES a fired strand's
    //    same-entity siblings on the fly from `strandsByEntity` at read time,
    //    spreading the same share-normalized energy the old per-edge fan delivered
    //    (so a hot entity still self-starves; spam can't dominate). This makes the
    //    shared-entity part of writeFact O(1) instead of O(siblings): a hot account
    //    attribute hammered by a swarm no longer pays an ever-growing fan-out per
    //    write. CONFIRMED_LINK relationships (the librarian's job, out of scope here)
    //    and CROSS_WEB_BRIDGE edges are unchanged and still materialized.
    //
    // ATOMIC: a single `putStrand`. Trivially all-or-nothing (one write), and the
    // entity index it maintains is the read-time substrate the walk now derives
    // siblings from. No sibling rewrites, no edge inserts, no out_weight_sum recompute.
    withTxn(this.#store, () => {
      this.#store.putStrand(fresh);
    });

    return fresh.id;
  }

  // -------------------------------------------------------------------------
  // writeFactsBatch — bulk FILE (same mint path as writeFact, one txn barrier)
  // -------------------------------------------------------------------------

  writeFactsBatch(inputs: readonly WriteFactInput[]): StrandId[] {
    // Mirror writeFact EXACTLY per fact: a per-fact `now()` timestamp and the same
    // `makeObservedStrand` mint (provenance root from the stamp, content hash, entity
    // index key). The ONLY difference is the put is batched: one `putStrandsBatch`
    // under one `withTxn`, so the whole ingest pays ONE durability barrier and the
    // store maintains the SAME entity index as N individual `putStrand` calls would.
    const fresh = inputs.map((input) => makeObservedStrand(input, now()));

    withTxn(this.#store, () => {
      this.#store.putStrandsBatch(fresh);
    });

    return fresh.map((s) => s.id);
  }

  // -------------------------------------------------------------------------
  // recall — the model SPEAKS (it does not confirm)
  // -------------------------------------------------------------------------

  recall(cue: RecallCue): RecallResult {
    const config: WalkConfig = cue.config ?? DEFAULT_WALK_CONFIG;

    // Build the halting controller for THIS traversal. It owns the two-phase stop
    // (local saturation, then the mandatory bridge sweep) and the hard backstop;
    // it — not the model — decides when to stop walking and start speaking.
    const halting: HaltingController = createHaltingController(config);

    // Run the share-normalized best-first activation walk. `seeds` is copied into a
    // fresh mutable array because the walk signature takes `WalkSeed[]` while our
    // cue holds them readonly. The walk body (the pop loop,
    // child = parent * (edge.w / edge.out_weight_sum) * γ, the refractory lock,
    // delegation to the HaltingController) and the controller's two-phase gates are
    // both fully implemented (traversal/walk.ts, traversal/halting.ts).
    const result: WalkResult = activationWalk(this.#store, [...cue.seeds], config, halting);

    return {
      lit: result.lit,
      halt: result.halt,
    };
  }

  // -------------------------------------------------------------------------
  // ratify — the ONLY promotion verb; requires an EXTERNAL witness
  // -------------------------------------------------------------------------

  ratify(input: RatifyInput): void {
    // The external stamp is the authority that makes this NOT self-ratification
    // (invariant 1). We re-stamp through the identity layer so the recorded root is
    // the layer's canonical view of the external source, not a caller-supplied one.
    const canonicalStamp: IdentityStamp = this.#identity.stampFor(
      input.externalStamp.source_id,
    );

    const strand: Strand | null = this.#store.getStrand(input.strandId);
    if (strand === null) {
      throw new Error(`ratify: unknown strand ${String(input.strandId)}`);
    }

    const at = now();

    // Promotion semantics depend on the strand's current shape:
    //
    //   DERIVED fact            -> OBSERVED + LIVE   (the "window" in
    //                              wall-with-a-window: an external source turns a
    //                              web-computed belief into a witnessed one).
    //   PROVISIONAL (observed)  -> LIVE              (the external source confirms
    //                              the held superposition, collapsing it to current).
    //   otherwise (already LIVE/
    //   OBSERVED, or DEMOTED)   -> record an additional external root only; state
    //                              is unchanged, keep-pressure rises.
    //
    // In ALL cases the external root is appended to the strand's provenance so future
    // independent-root counts (read from the identity layer, never self-computed)
    // see a real outside witness. fact_state/origin are mutable on Strand; the
    // provenance set is readonly, so we re-`putStrand` a clone with the added root.
    const externalRoot: ProvenanceRoot = {
      rootId: (`root:${randomUUID()}` as ProvenanceRoot["rootId"]),
      independenceClass: (`class:${String(canonicalStamp.source_id)}` as ProvenanceRoot["independenceClass"]),
      sourceId: canonicalStamp.source_id,
      establishedAt: at,
    };

    let nextOrigin = strand.origin;
    let nextState = strand.fact_state;

    if (strand.origin === FactOrigin.DERIVED) {
      // Graduate derived -> observed (and make it current).
      nextOrigin = FactOrigin.OBSERVED;
      nextState = FactState.LIVE;
    } else if (strand.fact_state === FactState.PROVISIONAL) {
      // Confirm provisional -> live.
      nextState = FactState.LIVE;
    }
    // else: already witnessed/current (or demoted) — state unchanged; the new
    // external root below still strengthens keep-pressure.

    const promoted: Strand = {
      ...strand,
      origin: nextOrigin,
      fact_state: nextState,
      provenance: [...strand.provenance, externalRoot],
      external_reobservation_count: strand.external_reobservation_count + 1,
    };
    this.#store.putStrand(promoted);

    // A fresh external ratification changes the strand's independent-root count, a
    // forgetting-layer input. Ask consolidation to recompute keep-pressure.
    //
    // TODO(crack-B): the consolidation eviction-PERMISSION gates (low echo-discounted
    //   unique value, fresh independence stamp, not-the-outranked-side of a live
    //   contradiction, not an earned bridge, independent-source-count <= 1, past the
    //   grace floor) live in forgetting/consolidation.ts and are stubbed there. This
    //   recompute inherits that stub via the ConsolidationPort.
    this.#consolidation?.onExternalRatification(input.strandId, canonicalStamp);

    // Drive the LIVE credit-score pillar: an external ratification is exactly the
    // "past claim later ratified by an independent anchor" event reputation earns
    // from. Up SLOW, ceilinged at the source's rep_cap (the ledger owns the math).
    // Because the SAME ledger backs the facade's scoreOf, the NEXT stampFor for
    // this source reflects the earned bump. Null in the scaffold => no-op.
    //
    // RECORD FIDELITY (closes crack-A) under the BETA model: the corroboration
    // event's `reputationDelta` is the EXACT independence-weighted α-mass this
    // ratification added (`after.alpha - before.alpha` = the `w` applied), NOT a
    // readout difference. `reverseCredit` subtracts that same α-mass back out, so an
    // exact disown reversal still holds under the Beta model. The event is recorded
    // only when the caller NAMED the strands this ratification corroborated AND a
    // corroboration ledger is wired AND α actually moved (never guessed/coincidental).
    if (this.#reputation !== null) {
      const beforeAlpha = this.#reputation.stateOf(canonicalStamp.source_id)?.alpha ?? 1;
      // M2 (BATCH 4) — supply the engine-owned MIS corroboration DEPTH so the ledger can
      // raise its NON-DECAYING depth-floor MONOTONE-MAX. `#R` is the SAME shared agreement
      // basis (OD-6): the count of mutually anchor-INDEPENDENT roots backing this value
      // (strand's roots ∪ agreeing LIVE strands' roots, via `independentRootCount`). The
      // model never witnesses — the ledger only stores the max it is handed. A same-class
      // (depth-1) flood passes depth 1 ⇒ `floorMass(1)=0` ⇒ buys no floor.
      const depth = this.#R(strand);
      const after = this.#reputation.ratify(canonicalStamp.source_id, at, undefined, depth);
      const deltaAlpha = after.alpha - beforeAlpha;
      // ENGINE-OWNED EVIDENCE (OD-8): the corroborating set is DERIVED from the engine's
      // own agreement index (same entity + content_hash + LIVE), never supplied by the
      // caller. The CorroborationEvent ledger field is unchanged — only its source is.
      const corroborating = this.#deriveAgreementSet(strand);
      const namedCorroborators = corroborating.length > 0;
      let recorded = false;
      if (
        this.#ratification?.corroboration !== undefined &&
        namedCorroborators &&
        deltaAlpha > 0
      ) {
        this.#ratification.corroboration.record({
          ratifiedStrandId: input.strandId,
          corroboratingStrandIds: [...corroborating],
          beneficiarySourceId: canonicalStamp.source_id,
          reputationDelta: deltaAlpha,
          at,
        });
        recorded = true;
      }
      // HARDENING 2 — WRITE-TIME TOTAL-LEDGER INVARIANT: a reputation-earning ratify
      // that NAMED corroborating strands MUST emit a recorded corroboration event, so
      // the credit is reversible by a later disown. A positive α-gain on this earning
      // path with no recorded event is OFF-LEDGER (unreversible) and throws. (An
      // ordinary ratify that names no corroborators carries no such obligation; a
      // zero/negative gain — at cap, or decayed — has nothing to record or reverse.)
      assertRatifyEmitsEvent(canonicalStamp.source_id, deltaAlpha, namedCorroborators, recorded);
    }
  }

  // -------------------------------------------------------------------------
  // adjudicate — run the pure consolidation core and ROUTE its outcome
  // -------------------------------------------------------------------------

  adjudicate(attribute: AttributeKey, opts?: AdjudicateOptions): ConsolidationOutcome {
    // 1) Resolve the co-equal disputed members from the store's attribute index.
    //    Only LIVE claims participate (a DEMOTED loser is already history).
    const members = this.#store
      .strandsByAttribute(attribute)
      .filter((s) => s.fact_state === FactState.LIVE);

    if (members.length < 2) {
      return { kind: "NOOP" };
    }

    // 2) Build the contradiction set + the per-root identity stamps the PURE core
    //    adjudicates on. Each member's provenance roots are stamped via the identity
    //    layer (the external signal — reputation / anchor_cost / stake — never the
    //    web's own topology).
    const set = buildContradictionSet(members);
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>();
    for (const m of members) {
      for (const root of m.provenance) {
        if (stampsByRoot.has(root.rootId)) continue;
        if (root.sourceId === null) continue;
        stampsByRoot.set(root.rootId, this.#identity.stampFor(root.sourceId));
      }
    }

    const at = now();
    // When the caller flags this decision IRREVERSIBLE, the engine CONSTRUCTS the
    // high-impact gate context from its OWN trust layer (#reputation + #identity + the
    // agreement index) — the caller supplied only an intent flag (OD-8). A decisive LCB
    // margin is then necessary but NOT sufficient (the winner must also clear count +
    // recency + ≥2 INDEPENDENT ROOTS via #R).
    const highImpactCtx =
      opts?.highImpact === true ? this.#buildHighImpactContext(members) : undefined;

    // F4a + F4b (engine-owned evidence, OD-8): the engine ALWAYS supplies the real
    // callbacks built from its OWN trust layer (#R / #deriveAgreementSet, the batch-1
    // shared basis — OD-6, no second agreement set). The pure module's defaults
    // (`() => 2` / `() => Infinity`) are never relied on in production.
    //  - F4a: the count of mutually anchor-INDEPENDENT roots backing the winner (#R).
    //    A self-stacked / lone winner is R=1 and DEFERS on EVERY multi-class resolve,
    //    high-impact or not (the unconditional structural second lock).
    //  - F4b: the count of in-domain co-asserters on the disputed value
    //    (#deriveAgreementSet size) — the POLICY-interim CrossDomainSpend re-pricing.
    const byId = new Map<StrandId, Strand>(members.map((m) => [m.id, m]));
    const agreementRootCountOf = (winner: StrandId): number =>
      this.#R(byId.get(winner) ?? null);
    const attrCorroborationCountOf = (winner: StrandId): number => {
      const w = byId.get(winner);
      return w ? this.#deriveAgreementSet(w).length : 0; // fail-closed: 0 ⇒ DEFER
    };
    const outcome = tryConsolidate(
      set,
      members,
      stampsByRoot,
      at,
      undefined,
      undefined,
      highImpactCtx,
      agreementRootCountOf,
      attrCorroborationCountOf,
    );

    switch (outcome.kind) {
      case "RESOLVED": {
        // Persist the in-graph resolution of the SAFE (single-class) case: each
        // loser was demoted in place by the pure core; mint + persist the OUTRANKS
        // edge, write the loser back, and drive reputation DOWN on the loser's
        // authors. The winner stays LIVE (untouched).
        //
        // ATOMIC: every loser's OUTRANKS edge + demotion write + reputation crater
        // commit as ONE unit. A crash mid-loop must not leave a loser demoted with no
        // OUTRANKS edge, an edge with no demotion, or a reputation move desynced from
        // the demotion it punishes. (When the reputation ledger rides the SAME shared
        // db handle, its writes enroll in this txn too.)
        withTxn(this.#store, () => {
          for (const d of outcome.demotions) {
            const loser = this.#store.getStrand(d.demoted);
            if (loser === null) continue;
            // The pure core mutated `loser`'s object identity only if it was the
            // SAME object passed in. `members` holds those objects, so persist them.
            const loserObj = members.find((m) => m.id === d.demoted) ?? loser;
            // Mint and persist the OUTRANKS edge that explains this demotion.
            const winnerId = this.#winnerOf(members, outcome);
            if (winnerId !== null) {
              const edge: Edge = {
                id: d.outranks,
                from: winnerId,
                to: d.demoted,
                edgeType: EdgeType.OUTRANKS,
                link_confidence: 1,
                provenance_independence: 1,
                recency: 1,
                w: 1,
                out_weight_sum: 1,
              };
              this.#store.putEdge(edge);
            }
            // A1 — capture the loser's pre-persist (store-side) state for the receipt,
            // then persist the demotion.
            const demoteBefore = hashStrandState(loser);
            this.#store.putStrand(loserObj);
            // A1 — journal the DEMOTE EFFECT (afterHash commits fact_state + outranked_by;
            // refEventId names the OUTRANKS edge). Inside this withTxn ⇒ atomic.
            this.#emitMutation(
              mutationReceipt(
                "DEMOTE",
                String(d.demoted),
                String(loserObj.content_hash),
                demoteBefore,
                hashStrandState(loserObj),
                at,
                String(d.outranks),
              ),
            );
            // Reputation: a contradicted claim craters its authors' earned trust. M3
            // (BATCH 4): this is an ADJUDICATED contradiction, so it SCARS (routes `c·w`
            // into the NON-DECAYING `scarBeta`, suppressing the betrayer's depth-floor)
            // — UNLESS the per-source-pair rate-limit (OD-2 seam family) has already
            // scarred this contradictor→target pair for this class in the window, in
            // which case it falls back to an ordinary (decaying) contradiction so a
            // single attacker cannot STACK many scars to grief an honest incumbent. The
            // scar penalizes the CONTRADICTED (loser) party, never the late-arriver
            // (first-arrival-safe).
            if (this.#reputation !== null) {
              const contradictor = this.#primarySourceOf(winnerId, members);
              for (const root of loserObj.provenance) {
                if (root.sourceId === null) continue;
                const scarring = this.#admitScar(contradictor, root.sourceId, root.independenceClass, at);
                const before = this.#reputation.stateOf(root.sourceId);
                const post = this.#reputation.contradict(root.sourceId, at, undefined, scarring);
                // A1 — journal the REPUTATION_CONTRADICT EFFECT (before/after rep state).
                this.#emitMutation(
                  mutationReceipt(
                    "REPUTATION_CONTRADICT",
                    String(root.sourceId),
                    hashSubjectId(String(root.sourceId)),
                    hashReputationState(before),
                    hashReputationState(post),
                    at,
                  ),
                );
              }
            }
          }

          // HARDENING 3 — record ADJUDICATION PROVENANCE so a later disown can RE-OPEN
          // this dispute if a tainted strand merely tipped its margin. The MARGIN is
          // the LCB gap (winner reputation minus the strongest non-winner member); the
          // CONTRIBUTING strands are the winner plus every member backed by the SAME
          // source as the winner (the support that supplied the winner's margin).
          if (this.#ratification?.adjudicationProvenance !== undefined) {
            this.#recordAdjudicationProvenance(set.id, attribute, members, outcome, at);
          }
        });
        return outcome;
      }
      case "DEFERRED": {
        // The INDEPENDENT dispute: the web decided NOTHING. Record it in the
        // immortal signed ledger for the second-admin horn. Refuse to silently drop
        // a deferral when no ledger is wired.
        if (this.#ratification === null) {
          throw new Error(
            "adjudicate: an INDEPENDENT_DISPUTE was DEFERRED but no ratification ledger is wired; " +
              "pass a RatificationDeps to createIntelligentDb so the dispute is recorded for a human.",
          );
        }
        // OD-2 [horn rate-limiting]: supply the engine-OWNED dedup/cap evidence (the
        // ledger has no identity layer — OD-8). The disputing source-pair and the
        // attribute-INDEPENDENT coalesce key are resolved from the disputed members'
        // provenance; with these the ledger bounds the human horn (cross-attribute dedup
        // + per-source cap K) so F4a's extra deferrals can't become a DOS-DEFER.
        const disputingSources = this.#disputingSourcesOf(members);
        const coalesceKey = this.#disputeCoalesceKey(members);
        this.#ratification.ledger.appendPending(
          outcome.pending,
          this.#ratification.systemSigner,
          { disputingSources, coalesceKey },
        );
        return outcome;
      }
      case "NOOP":
        return outcome;
    }
  }

  /**
   * The winning strand of a RESOLVED outcome: the unique member that was NOT
   * demoted. Used to wire the persisted OUTRANKS edges' `from`. Returns null if it
   * cannot be determined (defensive; should not happen for a real RESOLVED).
   */
  #winnerOf(members: readonly Strand[], outcome: ConsolidationOutcome): StrandId | null {
    if (outcome.kind !== "RESOLVED") return null;
    const demoted = new Set<StrandId>(outcome.demotions.map((d) => d.demoted));
    for (const m of members) {
      if (!demoted.has(m.id) && m.fact_state === FactState.LIVE) return m.id;
    }
    return null;
  }

  /**
   * HARDENING 3 — record the {@link AdjudicationProvenance} of a RESOLVED dispute so a
   * later disown can RE-OPEN it if a tainted strand merely tipped its margin.
   *
   *  - `winner`: the un-demoted member.
   *  - `margin`: the LCB gap = winner's best-source reputation minus the strongest
   *    NON-winner member's best-source reputation (the gap that cleared the decision;
   *    clamped at 0).
   *  - `contributingStrandIds`: the winner strand PLUS every member that shares a
   *    backing source with the winner (the support that supplied the winner's margin).
   *    These are the strands whose taint would erode the recorded margin.
   */
  #recordAdjudicationProvenance(
    contradictionSetId: ContradictionSetId,
    attribute: AttributeKey,
    members: readonly Strand[],
    outcome: ConsolidationOutcome,
    at: EpochMs,
  ): void {
    const ledger = this.#ratification?.adjudicationProvenance;
    if (ledger === undefined) return;
    const winnerId = this.#winnerOf(members, outcome);
    if (winnerId === null) return;
    const winner = members.find((m) => m.id === winnerId);
    if (winner === undefined) return;

    // The winner's backing sources (its margin's owners) and best reputation.
    const repOf = (s: Strand): number => {
      let best = 0;
      for (const root of s.provenance) {
        if (root.sourceId === null) continue;
        const r = this.#identity.stampFor(root.sourceId).reputation;
        if (r > best) best = r;
      }
      return best;
    };
    // The winner's backing sources, widened to the ONE engine-owned agreement basis
    // (`{winner} ∪ #deriveAgreementSet(winner)`) so a winner corroborated by SEPARATE
    // agreeing LIVE strands is not under-counted — the same set `#R` reads (OD-6). This
    // is the HARDENING-3 adjudication-provenance receipt (feeds margin-collapse re-open),
    // NOT a security gate: a wider contributing set can only make a future re-open fire
    // MORE readily (fail-safe-to-human), never auto-resolve anything.
    const winnerSources = new Set<SourceId>();
    const absorbSources = (roots: readonly ProvenanceRoot[]): void => {
      for (const root of roots) {
        if (root.sourceId !== null) winnerSources.add(root.sourceId);
      }
    };
    absorbSources(winner.provenance);
    for (const sid of this.#deriveAgreementSet(winner)) {
      const s = this.#store.getStrand(sid);
      if (s !== null) absorbSources(s.provenance);
    }

    // The strongest NON-winner member's reputation (the runner-up the margin cleared).
    let runnerUp = 0;
    for (const m of members) {
      if (m.id === winnerId) continue;
      const r = repOf(m);
      if (r > runnerUp) runnerUp = r;
    }
    const margin = Math.max(0, repOf(winner) - runnerUp);

    // Contributing strands: the winner plus every member sharing a winner source.
    const contributingStrandIds: StrandId[] = [winnerId];
    for (const m of members) {
      if (m.id === winnerId) continue;
      let shares = false;
      for (const root of m.provenance) {
        if (root.sourceId !== null && winnerSources.has(root.sourceId)) {
          shares = true;
          break;
        }
      }
      if (shares) contributingStrandIds.push(m.id);
    }

    ledger.record({
      contradictionSetId,
      attribute,
      winner: winnerId,
      margin,
      contributingStrandIds,
      at,
    });
  }

  // -------------------------------------------------------------------------
  // listPending / approve — the second-admin doorbell
  // -------------------------------------------------------------------------

  listPending(): readonly PendingPayload[] {
    if (this.#ratification === null) return [];
    return this.#ratification.ledger.listPending();
  }

  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    at?: EpochMs,
  ): ResolvedDispute {
    if (this.#ratification === null) {
      throw new Error("approve: no ratification ledger is wired.");
    }
    const when = at ?? now();

    // The store-reading context the ledger's distinct-approver gate + resolution
    // need. This is exactly the purity boundary: the ledger stays free of the
    // StrandStore; the engine supplies the reads/writes through this port.
    //
    // CRITICAL with a CLONE-ON-READ backend (SQLite): the ledger calls
    // `ctx.memberStrand(loser)` and DEMOTES the returned object IN PLACE. With the
    // in-memory store `getStrand` returns the live object, so a later re-read sees the
    // demotion; with SQLite every `getStrand` parses a FRESH object, so a re-read would
    // be the UN-demoted strand. We therefore CACHE the exact objects handed to the
    // ledger and persist THOSE (the ones the ledger actually mutated) — never a fresh
    // re-read — so the demotion is faithfully written under both backends.
    const handed = new Map<StrandId, Strand>();
    const ctx: ApproveContext = {
      authorsOf: (memberId: StrandId): readonly SourceId[] => {
        const s = handed.get(memberId) ?? this.#store.getStrand(memberId);
        if (s == null) return [];
        const out: SourceId[] = [];
        for (const root of s.provenance) {
          if (root.sourceId !== null) out.push(root.sourceId);
        }
        return out;
      },
      memberStrand: (memberId: StrandId) => {
        const cached = handed.get(memberId);
        if (cached !== undefined) return cached;
        const s = this.#store.getStrand(memberId);
        if (s === null) {
          throw new Error(`approve: member strand ${String(memberId)} not in store.`);
        }
        handed.set(memberId, s);
        return s;
      },
      mintEdgeId: (winner: StrandId, loser: StrandId): EdgeId =>
        asEdgeId(`edge:outranks:${randomUUID()}:${String(winner)}->${String(loser)}`),
      // RC-5 — the two anchor-independence predicates the approve-gate consults.
      // Both delegate to the SAME identity layer the rest of the web reads, so
      // there is exactly ONE independence notion (no drift) and the ledger stays
      // pure (no identity import — the engine supplies these).
      independentSources: (a: SourceId, b: SourceId): boolean =>
        this.#identity.independentSources(a, b),
      approverHasAnchors: (sourceId: SourceId): boolean =>
        this.#identity.stampFor(sourceId).anchor_cost > 0,
    };

    // ATOMIC: the ledger's APPROVAL append (the signed audit record) + the reputation
    // moves it drives + the engine's store persistence (each OUTRANKS edge, each demoted
    // loser) commit as ONE unit. A crash between "append the signed APPROVAL" and "demote
    // the losers" would otherwise desync the immortal audit chain from the state it
    // describes — a record claiming a resolution the store never applied (or vice versa).
    // With the audit ledger + reputation ledger riding the SAME shared db handle as the
    // store, all three enroll in this single transaction.
    const resolved = withTxn(this.#store, () => {
      // A1 — snapshot the dispute authors' reputation BEFORE the ledger drives its moves
      // (winner ratified / losers contradicted happen INSIDE `ledger.approve`), so the
      // EFFECT receipts can carry an exact before/after. Members come from the open
      // pending; authors are resolved through the same `ctx` the gate uses.
      const repBefore = new Map<SourceId, ReputationState | null>();
      if (this.#reputation !== null) {
        const members =
          this.#ratification!.ledger
            .listPending()
            .find((p) => p.contradictionSetId === contradictionSetId)?.members ?? [];
        for (const m of members) {
          for (const a of ctx.authorsOf(m)) {
            if (!repBefore.has(a)) repBefore.set(a, this.#reputation.stateOf(a));
          }
        }
      }

      const plan = this.#ratification!.ledger.approve(
        contradictionSetId,
        winnerStrandId,
        approver,
        when,
        ctx,
      );

      // APPLY the resolution to the store (the ledger emitted the PLAN; the engine is
      // the only thing that may write the StrandStore). Persist each minted OUTRANKS
      // edge and write back each demoted loser — the EXACT object the ledger mutated
      // in place (cached in `handed`), so the DEMOTED state + outranked_by persist even
      // on a clone-on-read backend. Fall back to a fresh read only if (defensively) the
      // loser was never handed out.
      for (const edge of plan.outranksEdges) {
        this.#store.putEdge(edge);
      }
      const edgeFor = new Map<StrandId, EdgeId>();
      for (const edge of plan.outranksEdges) edgeFor.set(edge.to, edge.id);
      for (const d of plan.demotions) {
        // A1 — capture the loser's pre-persist store state for the DEMOTE receipt.
        const fromStore = this.#store.getStrand(d.demoted);
        const beforeHash = fromStore !== null ? hashStrandState(fromStore) : EMPTY_STATE_HASH;
        const loser = handed.get(d.demoted) ?? fromStore;
        if (loser !== null) {
          this.#store.putStrand(loser);
          const refEdge = edgeFor.get(d.demoted);
          this.#emitMutation(
            mutationReceipt(
              "DEMOTE",
              String(d.demoted),
              String(loser.content_hash),
              beforeHash,
              hashStrandState(loser),
              when,
              refEdge === undefined ? undefined : String(refEdge),
            ),
          );
        }
      }

      // A1 — journal the reputation EFFECTS the ledger drove (one receipt per distinct
      // author per effect, deterministic by source id). The signed APPROVAL leaf already
      // commits the DECISION; these add the EFFECT leaves so a hidden reputation move is
      // detectable. before = the pre-approve snapshot; after = the now-final state.
      if (this.#reputation !== null) {
        const loserAuthors = new Set<SourceId>();
        for (const d of plan.demotions) {
          for (const a of ctx.authorsOf(d.demoted)) loserAuthors.add(a);
        }
        const winnerAuthors = new Set<SourceId>(ctx.authorsOf(winnerStrandId));
        const sortIds = (xs: Iterable<SourceId>): SourceId[] =>
          [...xs].sort((x, y) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0));
        for (const a of sortIds(loserAuthors)) {
          this.#emitMutation(
            mutationReceipt(
              "REPUTATION_CONTRADICT",
              String(a),
              hashSubjectId(String(a)),
              hashReputationState(repBefore.get(a) ?? null),
              hashReputationState(this.#reputation.stateOf(a)),
              when,
            ),
          );
        }
        for (const a of sortIds(winnerAuthors)) {
          this.#emitMutation(
            mutationReceipt(
              "REPUTATION_RATIFY",
              String(a),
              hashSubjectId(String(a)),
              hashReputationState(repBefore.get(a) ?? null),
              hashReputationState(this.#reputation.stateOf(a)),
              when,
            ),
          );
        }
      }
      return plan;
    });

    return resolved;
  }

  // -------------------------------------------------------------------------
  // disown — the full retroactive undo engine (wired to downstreamDisownSweep)
  // -------------------------------------------------------------------------

  disown(sourceId: SourceId, opts?: DisownOptions): DownstreamDisownResult {
    if (this.#reputation === null) {
      throw new Error(
        "disown: no reputation ledger is wired; there is nothing to claw back. " +
          "Pass a ReputationLedger to createIntelligentDb.",
      );
    }
    const at = opts?.at ?? now();

    // ENUMERATE THE SEED: every strand this source asserted (a provenance root whose
    // sourceId === sourceId). Nothing here is found by content scan in the query path,
    // but disown is an OFFLINE maintenance op, so the full-strand iterator is exactly
    // the right primitive (StrandStore.allStrands is for maintenance like this).
    const seed: StrandId[] = [];
    for (const strand of this.#store.allStrands()) {
      for (const root of strand.provenance) {
        if (root.sourceId === sourceId) {
          seed.push(strand.id);
          break;
        }
      }
    }

    // Assemble the hardening deps from the wired ratification ledgers + the engine's
    // own system signer. checkSurvivingSupport defaults ON at the engine seam (a disown
    // must never silently suppress a rival's independently-corroborated downstream work).
    const hardening: DisownHardeningDeps = {
      ...(this.#ratification?.corroboration !== undefined
        ? { corroboration: this.#ratification.corroboration }
        : {}),
      ...(this.#ratification?.weakInfluence !== undefined
        ? { weakInfluence: this.#ratification.weakInfluence }
        : {}),
      ...(this.#ratification?.adjudicationProvenance !== undefined
        ? { adjudicationProvenance: this.#ratification.adjudicationProvenance }
        : {}),
      ...(this.#ratification?.ledger !== undefined
        ? { pending: this.#ratification.ledger }
        : {}),
      ...(this.#ratification?.systemSigner !== undefined
        ? { systemSigner: this.#ratification.systemSigner }
        : {}),
      ...(opts?.decisiveMargin !== undefined ? { decisiveMargin: opts.decisiveMargin } : {}),
      checkSurvivingSupport: opts?.checkSurvivingSupport ?? true,
      ...(opts?.minSurvivingSupport !== undefined
        ? { minSurvivingSupport: opts.minSurvivingSupport }
        : {}),
    };

    // The sweep already wraps itself in ONE store transaction (withSweepTxn): the
    // direct-seed crater + every demotion/OUTRANKS stub + every contradict + every
    // precise reverseCredit/markReversed commit as one all-or-nothing unit over the
    // shared handle. The reputation + corroboration + audit ledgers ride the same db
    // handle in shared-handle mode, so their writes enroll automatically.
    return downstreamDisownSweep(
      sourceId,
      seed,
      this.#store,
      this.#reputation,
      at,
      undefined,
      undefined,
      hardening,
    );
  }
}
