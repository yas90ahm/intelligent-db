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
 * `disown` verb) are all IMPLEMENTED. A couple of `NOTE (crack-B seam)` markers below name
 * the optional `ConsolidationPort` keep-pressure recompute seam, which is a no-op until
 * a forgetting-layer adapter is injected — not an unfinished core. Every wiring, signature,
 * and type here is complete and type-checks against core/types.ts and the sibling contracts.
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

import { canonicalJson } from "./core/canonicalJson.js";

import type {
  StrandId,
  EdgeId,
  EntityId,
  AttributeKey,
  ContentHash,
  ContradictionSetId,
  IndependenceClassId,
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
  EmbedderPort,
} from "./core/types.js";

import type { StrandStore, StoreTxn } from "./store/StrandStore.js";
import type { VectorSidecar } from "./store/vectorSidecar.js";
import type { WalkSeed, WalkResult } from "./traversal/walk.js";
import { activationWalk } from "./traversal/walk.js";
import { strandText } from "./recall/cueResolver.js";
import type { HaltingController } from "./traversal/halting.js";
import { createHaltingController } from "./traversal/halting.js";
import type { SourceIdentityLayer } from "./identity/index.js";
import type { ReputationLedger, ReputationState } from "./identity/reputation.js";

import {
  buildContradictionSet,
  tryConsolidate,
} from "./forgetting/consolidation.js";
import type {
  ConsolidationOutcome,
  HighImpactContext,
  PendingRatificationReason,
} from "./forgetting/consolidation.js";
import { evaluateEviction, DEFAULT_FORGETTING_CONFIG } from "./forgetting/tiers.js";
import type {
  EvictionEvidence,
  EvictionGate,
  ForgettingConfig,
  NeighborView as EvictionNeighborView,
} from "./forgetting/tiers.js";
import type { ReasonCode } from "./core/types.js";

import type {
  PendingLedger,
  PendingPayload,
  ApprovalPayload,
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
import type { CorroborationLedger } from "./ratification/corroboration.js";
import type {
  AdjudicationProvenanceInput,
  AdjudicationProvenanceLedger,
} from "./ratification/adjudicationProvenance.js";
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
// NOTE (crack-B seam): forgetting/consolidation.ts exists but exposes no injectable
//   `ConsolidationLayer` interface — its functions are pure and store-driven. This
//   narrow port is therefore the engine's own keep-pressure recompute seam; a caller
//   that wants the hook live supplies an adapter assignable to ConsolidationPort.

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
 * The CAUSAL ORIGIN of an observed fact — WHERE the observation actually came
 * from, as distinct from WHO filed it (the {@link WriteFactInput.stamp}).
 *
 * This closes the RELAY-LAUNDERING hole: without it, the engine mints the new
 * strand's independence class from the FILING agent's identity alone
 * (`class:${source_id}`), so when agent A researches a fact, writes it, and then
 * tells agent B in-context — and B writes the SAME fact under B's own stamp —
 * the system mints TWO distinct independence classes for ONE relayed
 * observation. That is manufactured corroboration with zero attacker: the
 * engine's exact MIS count (`independentRootCount`), the high-impact gate, and
 * the depth-floor all trust that class assignment. The causal origin lets the
 * write path collapse the class AT WRITE TIME, so the existing Bron–Kerbosch
 * count does the rest unmodified.
 *
 *  - `TOOL_CALL` / `DOCUMENT` — the observation came from an external resource.
 *    `resourceId` MUST be the canonicalized UNDERLYING resource (normalized URL /
 *    content hash), never an ephemeral invocation id; canonicalization is the
 *    CALLER's job — this layer just hashes what it is given. The same resource
 *    then collapses to ONE independence class no matter WHICH agent fetched it.
 *  - `USER_STATEMENT` — the user said it directly to this agent: the filing
 *    source genuinely IS the witness, so today's per-source class is correct.
 *  - `AGENT_RELAY` — the filing agent learned it from strands already in the
 *    web (`consultedStrandIds`). The write COPIES the consulted strands'
 *    independence classes (one root per distinct upstream class) instead of
 *    minting a fresh one, so the relay counts as the SAME witness — and mints a
 *    DERIVATION edge per consulted strand so a later disown sweep taints it.
 *    A class is copied ONLY from a witness making the SAME CLAIM (same
 *    entity + attribute + payload — the ECHO GATE in `resolveCausalOrigin`):
 *    a contradicting payload citing a rival's strand cannot inherit the
 *    rival's class and launder itself into the single-class echo-dispute lane.
 */
export type CausalOrigin =
  | { readonly kind: "TOOL_CALL"; readonly resourceId: string }
  | { readonly kind: "DOCUMENT"; readonly resourceId: string }
  | { readonly kind: "USER_STATEMENT" }
  | { readonly kind: "AGENT_RELAY"; readonly consultedStrandIds: readonly StrandId[] };

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
  /**
   * OPTIONAL {@link CausalOrigin}: where the observation actually came from, as
   * distinct from who filed it. Omitted (or `USER_STATEMENT`) ⇒ today's behavior
   * exactly — the independence class is minted from the filing stamp's source id.
   * `TOOL_CALL`/`DOCUMENT` derive the class from the underlying resource so the
   * same resource collapses to ONE class across agents; `AGENT_RELAY` copies the
   * consulted strands' classes and mints DERIVATION citation edges, so a relayed
   * fact can never masquerade as fresh independent corroboration.
   */
  readonly causalOrigin?: CausalOrigin;
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
  /**
   * Seed ids the cue supplied that did NOT resolve in the store, forwarded from
   * the walk verbatim. ALWAYS present (empty when every seed resolved). When ALL
   * seeds fail to resolve, `halt.reason` is `ReasonCode.NO_SEEDS_RESOLVED` with
   * `degraded: true` — never a healthy-looking BRIDGE_SWEEP_CLEAR.
   */
  readonly unresolvedSeeds: readonly StrandId[];
  /** How many supplied seeds resolved in the store. ALWAYS present. */
  readonly seedsResolved: number;
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
// explain / beliefTimeline — READ-ONLY introspection shapes (the belief dossier
// and the time-travel history). These features OBSERVE the graph + the wired
// ledgers; they never influence the walk, never write, and never fabricate a
// timestamp (the fail-honest religion made mechanical via EvidenceFidelity).
// ---------------------------------------------------------------------------

/**
 * WHERE a reported timestamp / cause came from — the fidelity marker that makes
 * "honest degradation" structural instead of aspirational:
 *  - `RECEIPT`      — copied verbatim from a committed audit record (a MUTATION /
 *                     APPROVAL / PENDING / corroboration event). Exact as recorded
 *                     (note: `disown(opts.at)` is caller-supplied, so a receipt
 *                     witnesses the RECORDED time, not wall-clock truth).
 *  - `STRAND_FIELD` — read from a field the strand itself carries (`observedAt`,
 *                     `fact_state`, `outranked_by`). True NOW; historical
 *                     transitions to this state are not implied.
 *  - `INFERRED`     — derived from indirect evidence (e.g. a provenance root whose
 *                     `establishedAt > observedAt` implies a later ratify touched
 *                     the strand) — real evidence, but NOT a recorded transition.
 */
export type EvidenceFidelity = "RECEIPT" | "STRAND_FIELD" | "INFERRED";

/**
 * What the report could even SEE: which optional ledgers were wired when it was
 * built. A `false` flag means the matching arrays are structurally empty — absence
 * of records, not absence of history (the honest-gap disclosure carried in-band).
 */
export interface AuditCoverage {
  /** A ratification (audit) ledger is wired (`RatificationDeps` present). */
  readonly auditLedger: boolean;
  /** The corroboration-event ledger is wired. */
  readonly corroborationLedger: boolean;
  /** The adjudication-provenance ledger is wired. */
  readonly adjudicationProvenance: boolean;
  /** A reputation ledger is wired. */
  readonly reputationLedger: boolean;
}

/** One provenance root of the explained strand, verbatim plus derived flags. */
export interface ExplainRoot {
  readonly rootId: ProvenanceRootId;
  readonly independenceClass: IndependenceClassId;
  readonly sourceId: SourceId | null;
  readonly establishedAt: EpochMs;
  /** TRUE when the class was inherited from the causal origin, not earned. */
  readonly inherited: boolean;
  /**
   * `establishedAt > observedAt` — INFERRED evidence a later ratify appended this
   * root. NOT proof of a state flip (an echo ratify appends without flipping),
   * and a same-millisecond ratify is invisible (documented residual).
   */
  readonly appendedAfterWrite: boolean;
}

/** One distinct source backing the explained strand, with its canonical stamp. */
export interface ExplainSource {
  readonly sourceId: SourceId;
  /** The identity layer's canonical stamp — engine-owned evidence, never cached. */
  readonly stamp: IdentityStamp;
  /**
   * Registry metadata (label + kind) — the ENGINE always reports `null` (it has
   * no trust-registry handle); the facade's `explain` enriches it via
   * `trust.refOf`. Descriptive only, never load-bearing.
   */
  readonly registered: { readonly label: string | null; readonly kind: string } | null;
}

/**
 * WHY a DEMOTED strand was demoted, resolved from its `outranked_by` edge. The
 * demotion TIME is a RECEIPT (the first matching `DEMOTE` MUTATION) when the
 * audit ledger recorded one, else `null` + `STRAND_FIELD` — never invented.
 */
export type ExplainDemotion =
  | {
      readonly kind: "OUTRANKED_BY_STRAND";
      readonly outranksEdgeId: EdgeId;
      readonly winnerStrandId: StrandId;
      readonly at: EpochMs | null;
      readonly atFidelity: EvidenceFidelity;
    }
  | {
      /** The `from` was a disown sentinel: provenance was disowned, no peer won. */
      readonly kind: "DISOWN_SENTINEL";
      readonly outranksEdgeId: EdgeId;
      readonly disownedSourceId: SourceId;
      readonly at: EpochMs | null;
      readonly atFidelity: EvidenceFidelity;
    }
  | {
      /** `outranked_by` names an edge the store cannot resolve — reported, never invented. */
      readonly kind: "EDGE_MISSING";
      readonly outranksEdgeId: EdgeId;
    };

/** One dispute (open or resolved) the explained strand is/was a member of. */
export type ExplainDispute =
  | {
      readonly status: "OPEN";
      readonly contradictionSetId: ContradictionSetId;
      readonly reason: PendingRatificationReason;
      readonly createdAt: EpochMs;
      readonly members: readonly StrandId[];
    }
  | {
      readonly status: "RESOLVED_BY_APPROVAL";
      readonly contradictionSetId: ContradictionSetId;
      readonly winner: StrandId;
      readonly approverSourceId: SourceId;
      readonly approvedAt: EpochMs;
      readonly ownerOverride: boolean;
    }
  | {
      readonly status: "RESOLVED_BY_ADJUDICATION";
      readonly contradictionSetId: ContradictionSetId;
      readonly winner: StrandId;
      readonly margin: number;
      readonly at: EpochMs;
      /** Whether a later disown re-opened this resolution (`isReopened(csid)`). */
      readonly reopened: boolean;
    };

/** One corroboration event naming the explained strand (either role). */
export interface ExplainCorroborationEvent {
  readonly eventId: string;
  readonly at: EpochMs;
  readonly beneficiarySourceId: SourceId;
  readonly reputationDelta: number;
  /** RATIFIED = this strand earned the credit; CORROBORATOR = it funded one. */
  readonly role: "RATIFIED" | "CORROBORATOR";
  readonly reversed: boolean;
}

/**
 * THE BELIEF DOSSIER: "why does the system believe this?" — plain data assembling
 * what the graph + the wired ledgers already know about one strand. READ-ONLY:
 * built entirely from `getStrand`/`getEdge`/edge indexes, the identity layer, and
 * ledger scans; `independentRootCount` / `agreementStrandIds` are THE SAME numbers
 * the adjudication gates read (`#R` / `#deriveAgreementSet`), never a parallel
 * computation. Always recomputed fresh (no memoization — a dispute can open or
 * close between calls); deterministic for equal inputs via the explicit sort rules.
 */
export interface ExplainReport {
  readonly strandId: StrandId;
  readonly entity: EntityId;
  readonly attribute: AttributeKey | null;
  readonly payload: unknown;
  readonly contentHash: ContentHash;
  readonly factState: FactState;
  readonly origin: FactOrigin;
  readonly tier: Tier;
  readonly observedAt: EpochMs;
  readonly externalReobservationCount: number;
  /** The strand's provenance roots, in strand order, verbatim. */
  readonly roots: readonly ExplainRoot[];
  /** Distinct backing sources, first-appearance order over the roots. */
  readonly sources: readonly ExplainSource[];
  /** `#R(strand)` — the EXACT number the adjudication/high-impact gates read. */
  readonly independentRootCount: number;
  /** A sorted COPY of `#deriveAgreementSet(strand)` (the gates' own basis). */
  readonly agreementStrandIds: readonly StrandId[];
  /** Out-DERIVATION edges' `to` (what this strand rests on), sorted by edge id. */
  readonly restsOn: readonly StrandId[];
  /** In-DERIVATION edges' `from` (what rests on this strand), sorted by edge id. */
  readonly supports: readonly StrandId[];
  /** Demotion explanation; `null` unless `outranked_by` is set. */
  readonly demotion: ExplainDemotion | null;
  /** Member of any OPEN pending dispute (the same rule the recall label uses). */
  readonly contested: boolean;
  /** Every dispute naming this strand, ledger-chain order then provenance order. */
  readonly disputes: readonly ExplainDispute[];
  /** Corroboration events naming this strand (either role), append order. */
  readonly corroborationEvents: readonly ExplainCorroborationEvent[];
  /** MUTATION receipts whose `subjectId` IS this strand, chain order. */
  readonly mutationReceipts: readonly MutationPayload[];
  /**
   * MUTATION receipts whose `subjectId` is one of this strand's BACKING SOURCE
   * ids — surfaces e.g. a `DISOWN_CRATER` against the source of a still-LIVE
   * seed strand (the sweep demotes only derivatives; T8's honest residual).
   */
  readonly sourceMutationReceipts: readonly MutationPayload[];
  readonly coverage: AuditCoverage;
}

/**
 * One event in a (entity, attribute) belief timeline. EVERY dated event's `at` is
 * copied VERBATIM from a record field or strand field (the fabrication ban); an
 * event whose time is unknowable carries `at: null` and lives in
 * {@link BeliefTimeline.undatedEvents}. There are deliberately NO promotion
 * events (PROVISIONAL→LIVE / DERIVED→OBSERVED): no promotion receipt type exists,
 * so their absence IS the honest answer — `OBSERVED.birthState` is structurally
 * `"UNKNOWN"` because a strand's birth state is recorded nowhere.
 */
export type BeliefEvent =
  | {
      readonly kind: "OBSERVED";
      readonly strandId: StrandId;
      readonly at: EpochMs;
      readonly source: "STRAND_FIELD";
      /** Birth state (LIVE vs PROVISIONAL) is recorded NOWHERE — honesty is structural. */
      readonly birthState: "UNKNOWN";
    }
  | {
      readonly kind: "EXTERNAL_ROOT_APPENDED";
      readonly strandId: StrandId;
      readonly at: EpochMs;
      /** INFERRED: root-append ≠ state flip (an echo ratify appends without flipping). */
      readonly source: "INFERRED";
      readonly rootId: ProvenanceRootId;
      readonly sourceId: SourceId | null;
    }
  | {
      readonly kind: "DEMOTED";
      readonly strandId: StrandId;
      readonly at: EpochMs | null;
      readonly source: "RECEIPT" | "STRAND_FIELD";
      readonly outranksEdgeId: EdgeId | null;
      readonly by: "STRAND" | "DISOWN" | "UNKNOWN";
    }
  | {
      readonly kind: "DISPUTE_OPENED";
      readonly contradictionSetId: ContradictionSetId;
      readonly at: EpochMs;
      readonly source: "RECEIPT";
      readonly members: readonly StrandId[];
      readonly reason: PendingRatificationReason;
    }
  | {
      readonly kind: "DISPUTE_RESOLVED";
      readonly contradictionSetId: ContradictionSetId;
      readonly at: EpochMs;
      readonly source: "RECEIPT";
      readonly winner: StrandId;
      readonly approverSourceId: SourceId;
      readonly ownerOverride: boolean;
    }
  | {
      readonly kind: "DISPUTE_REOPENED";
      readonly contradictionSetId: ContradictionSetId;
      readonly at: EpochMs;
      readonly source: "RECEIPT";
      readonly winner: StrandId;
    }
  | {
      readonly kind: "CORROBORATION_CREDITED";
      readonly strandId: StrandId;
      readonly at: EpochMs;
      readonly source: "RECEIPT";
      readonly eventId: string;
      readonly beneficiarySourceId: SourceId;
      readonly reversed: boolean;
    };

/**
 * TIME-TRAVEL over one (entity, attribute): the ordered history of what was
 * believed, exactly as far as the records support it — and an explicit
 * `undatedEvents` bucket where they do not. `believedAt(t)` is NOT exactly
 * reconstructible in general (see the transition→record matrix in the spec):
 * demotions and dispute open/resolve/re-open are RECEIPT-exact iff a ratification
 * ledger was wired at transition time; birth state and promotions are never exact.
 */
export interface BeliefTimeline {
  readonly entity: EntityId;
  readonly attribute: AttributeKey;
  /** The member strands (attribute index filtered to `entity`), sorted (observedAt, id). */
  readonly members: readonly StrandId[];
  /** Dated events, ascending (at, kindRank, strandId/csid). NEVER an invented timestamp. */
  readonly events: readonly BeliefEvent[];
  /** `at: null` only (e.g. a receiptless DEMOTED) — the honest gap bucket. */
  readonly undatedEvents: readonly BeliefEvent[];
  /** Members with `fact_state === LIVE` NOW (a STRAND_FIELD read, not history). */
  readonly currentBelief: readonly StrandId[];
  readonly coverage: AuditCoverage;
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
   * {@link writeFact}, PLUS an accelerator: when a {@link RetrievalDeps} was
   * wired at construction (Phase-1 retrieval spec §1-2), embeds the fact's text
   * BEFORE opening the write transaction and — on success — populates the
   * vector sidecar keyed by the fresh strand's `content_hash` inside the SAME
   * transaction `writeFact` already uses (no `await` ever runs inside an open
   * txn). Embedding is an ACCELERATOR, NEVER A GATE: a failed/throwing embed
   * call (network error, unreachable model, …) is caught and the fact is
   * written WITHOUT a vector — `writeFactWithEmbeddingAsync` never rejects
   * because an embedder failed. An existing vector for the SAME `content_hash`
   * under the SAME `embedder.modelId` is reused (no redundant embed call —
   * echoes share one vector).
   *
   * When NO {@link RetrievalDeps} is wired (the default), this is IDENTICAL to
   * calling {@link writeFact} (wrapped in a resolved `Promise`) — the embedder
   * is never referenced.
   *
   * THE THESIS CONSTRAINT: the resulting vector is consumed EXCLUSIVELY by the
   * seed-selection seam (`recall/cueResolver.ts`'s `createEmbeddingCueResolver`).
   * It never touches `fact_state`, edge weights, adjudication, independence
   * counting, reputation, or eviction — this method mints EXACTLY the same
   * strand `writeFact` would, plus one extra sidecar row.
   *
   * NAMED `...Async` (Wave-3 `writeFactWithEmbedding-sole-async-verb`,
   * 2026-07-07 rename): this was the ONLY `Promise`-returning method on
   * {@link IntelligentDb} — every sibling verb (`writeFact`, `recall`, `ratify`,
   * `adjudicate`, `approve`, `disown`, `runForgetting`, `explain`) is
   * synchronous, so a caller skimming the interface could easily miss the one
   * method that needs an `await` (or a `.then`) and silently get back an
   * unresolved `Promise` instead of a `StrandId`. The `Async` suffix makes that
   * unmissable at the call site.
   *
   * @returns the id of the newly created strand (same semantics as {@link writeFact}).
   */
  writeFactWithEmbeddingAsync(input: WriteFactInput): Promise<StrandId>;

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
   *                 LEDGER (a checksum-chained PENDING record) for the second-admin
   *                 horn. NOTHING is demoted — only an external `approve()` may
   *                 resolve it.
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
   * RUN THE FORGETTING MAINTENANCE SWEEP (`forgetting/tiers.ts`'s `evaluateEviction`
   * / `nextTierDown`, wired at last — see KNOWN LIMITATIONS' `forgetting-never-wired`).
   * An EXPLICIT, caller-invoked maintenance operation (mirroring `disown()`'s
   * downstream sweep pattern) — it is NEVER run automatically on a write, so default
   * behavior (every strand minted WARM, per {@link writeFact}) is unchanged unless a
   * caller actually schedules this.
   *
   * For each targeted strand (every strand via `store.allStrands()`, or exactly
   * {@link ForgettingOptions.strandIds} when supplied):
   *   - HOT/WARM strands step down on PRESSURE alone (`decayPressure`), no gates;
   *   - a COLD strand crosses to ARCHIVE only if it clears ALL SIX fail-closed
   *     eviction gates, whose evidence this method assembles for REAL from the
   *     wired identity layer (never self-computed): the strand's stamp
   *     (`identity.stampFor` off its primary provenance root), its
   *     TEMPORALLY-DISCOUNTED independent-source count (`identity.independentRootCount`
   *     over its OWN provenance — invariant 2), and the OUTRANKS winner's fact_state
   *     (resolved by following `outranked_by`) — a strand missing/lacking any of
   *     these is KEPT, never evicted on withheld evidence;
   *   - ARCHIVE is the immortal fixed point (untouched).
   *
   * Movement is DOWNWARD ONLY and NEVER deletion (`putStrand` with a lowered
   * `tier` — the archive stub's content hash + provenance stay intact). Every
   * move stamps `Strand.last_tier_reason`. Runs inside ONE transaction over the
   * shared handle (a compound multi-strand write, same discipline as `disown`).
   *
   * @returns a {@link ForgettingResult} receipt: every strand evaluated, every move
   *          made (with its reason), and every strand KEPT (with the gates that
   *          failed it) — fully auditable, mirroring `DownstreamDisownResult`.
   */
  runForgetting(opts?: ForgettingOptions): ForgettingResult;

  /**
   * The OPEN deferred disputes awaiting a human/second-admin decision (the doorbell
   * queue), reputation-ranked for a reviewer. Requires a ratification ledger to be
   * wired; returns `[]` otherwise.
   */
  listPending(): readonly PendingPayload[];

  /**
   * RESOLVE a deferred dispute by an EXTERNAL approver's decision (the second-admin
   * answer). Records an APPROVAL receipt in the immortal checksum chain, then APPLIES
   * the resolution to the store: winner stays LIVE; losers DEMOTED + `outranked_by`
   * set (never deleted); the minted OUTRANKS edges persisted; reputation driven.
   * REQUIRES the approver to be DISTINCT from every source that authored a member
   * (rejects self-approval) and to be REGISTERED in the identity layer with at
   * least one anchor (fail-closed — "no provenance → no voice").
   *
   * PHASE 4: pass {@link ApproveOptions.allowAuthorApprover} `true` to invoke the
   * PERSONAL-tier OWNER-OVERRIDE policy hook (see {@link ApproveOptions}) — the
   * distinct-approver and RC-5 independence-vs-authors gates are bypassed and the
   * APPROVAL record is stamped `ownerOverride: true`. Default absent/false:
   * enterprise semantics unchanged.
   *
   * @throws if no ratification ledger is wired, the dispute is unknown / resolved,
   *         the winner is not a member, the approver is self / unregistered /
   *         anchorless / not anchor-independent of an author.
   */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: SourceId,
    now?: EpochMs,
    opts?: ApproveOptions,
  ): ResolvedDispute;

  /**
   * THE BELIEF DOSSIER (read-only): assemble everything the graph + the wired
   * ledgers already know about WHY one strand is believed (or not): claim, state,
   * backing sources with canonical stamps, the gates' OWN independence count and
   * agreement basis, DERIVATION citations both directions, demotion cause,
   * dispute status, corroboration events, and audit receipts. Performs ZERO
   * writes; observes (never influences) the walk; degrades honestly when ledgers
   * are unwired (`coverage` flags + empty arrays). Control-plane cost: O(chain)
   * ledger scans — never on the recall hot path.
   *
   * @returns `null` for an unknown strand (a query miss, not an error).
   */
  explain(strandId: StrandId): ExplainReport | null;

  /**
   * TIME-TRAVEL (read-only): the ordered belief history of one (entity,
   * attribute) — each member's appearance, dispute open/resolve/re-open,
   * receipted demotions, corroboration credits — with an explicit fidelity
   * marker per event and an `undatedEvents` bucket for transitions the records
   * cannot date (NEVER a fabricated timestamp). An unknown (entity, attribute)
   * yields empty arrays; never throws. Control-plane cost, read-only.
   */
  beliefTimeline(entity: EntityId, attribute: AttributeKey): BeliefTimeline;
}

// ---------------------------------------------------------------------------
// Trust-tiered ingest (Phase 3) — the quarantine gate policy
// ---------------------------------------------------------------------------

/**
 * TRUST-TIERED INGEST policy (design doc §4.1 "Ingestion wiring"): the ONE knob
 * governing whether a filed fact lands {@link FactState.LIVE} or is QUARANTINED
 * as {@link FactState.PROVISIONAL} — the EXISTING "visible superposition" state,
 * reused verbatim (no new enum, no new promotion machinery).
 *
 * THE RULE: the engine re-derives the filer's canonical stamp from the identity
 * layer (`identity.stampFor(stamp.source_id)` — engine-owned evidence, OD-8:
 * the caller-supplied `anchor_set` is NEVER trusted for this gate, since a
 * caller could inflate it) and takes the STRONGEST SINGLE anchor
 * `independenceWeight` — the same "strongest single anchor, never a sum" notion
 * `aggregateAnchorCost` / `applySelfStackCap` use, so a stack of cheap anchors
 * cannot buy its way past the gate. If that strongest weight is BELOW
 * `quarantineThreshold`, the fact lands PROVISIONAL/WARM (stored, traversable,
 * recallable — the spiderweb SHOWS superpositions — but unable to demote a LIVE
 * incumbent: `adjudicate` admits only LIVE members). At-or-above lands LIVE/WARM
 * exactly as before.
 *
 * THE DEFAULT ({@link DEFAULT_QUARANTINE_THRESHOLD} = 0.10, applied when the
 * policy is OMITTED — fail-open-forever was the bug being closed): BARE_KEY
 * (0.00) and PUBLISHER_UNVERIFIED (0.04) quarantine; SSO_TENANT_MEMBER (0.12),
 * PUBLISHER_TRACKED (0.18), LOCAL_DOCUMENT (0.35), DOMAIN (0.35), OWNER (0.90)
 * do not. `quarantineThreshold: 0` is the EXPLICIT escape hatch that restores
 * the legacy always-LIVE ingest (nothing has a strongest weight below 0).
 *
 * EXIT from quarantine is ONLY through the existing promotion paths: `ratify()`
 * by an anchor-INDEPENDENT external source (see the quarantine-exit gate in
 * `#ratifyImpl`) or an `approve()` resolution.
 */
export interface IngestPolicy {
  /**
   * Strongest-single-anchor `independenceWeight` below which an ingested fact
   * lands PROVISIONAL. Defaults to {@link DEFAULT_QUARANTINE_THRESHOLD}; set 0
   * to restore legacy always-LIVE ingest.
   */
  readonly quarantineThreshold?: number;
}

/**
 * The default {@link IngestPolicy.quarantineThreshold}. Sits exactly at
 * EMAIL_OAUTH's 0.10 (the cheapest non-bare rung of the anchor ladder): with a
 * strict `<` comparison, an email-grade-or-better anchor passes and only the
 * near-free classes below it (BARE_KEY 0.00, PUBLISHER_UNVERIFIED 0.04) — the
 * identities a Sybil can mint for ~nothing — are held at the door.
 */
export const DEFAULT_QUARANTINE_THRESHOLD = 0.1;

/**
 * Thrown by {@link createIntelligentDb} when {@link IngestPolicy.quarantineThreshold}
 * is not a finite number in `[0, 1]` (the same range every `independenceWeight` in
 * `identity/anchors.ts`'s `ANCHOR_TABLE` lives in — the gate compares the two
 * directly, `strongest < quarantineThreshold`). A `NaN`/`Infinity`/out-of-range value
 * would silently defeat the trust-tiered ingest gate (e.g. `NaN` makes every
 * comparison `false`, identical to the explicit `quarantineThreshold: 0` escape hatch,
 * with zero signal that anything is misconfigured) — fail CLOSED at construction
 * instead of fail-open-forever at every ingest.
 */
export class InvalidQuarantineThresholdError extends Error {
  constructor(public readonly value: number) {
    super(
      `createIntelligentDb: IngestPolicy.quarantineThreshold must be a finite number ` +
        `in [0, 1] (compared directly against each anchor class's independenceWeight, ` +
        `all of which live in that range); got ${JSON.stringify(value)}. Pass 0 for the ` +
        `explicit legacy always-LIVE escape hatch, or omit the option entirely for the ` +
        `default (${DEFAULT_QUARANTINE_THRESHOLD}).`,
    );
    this.name = "InvalidQuarantineThresholdError";
  }
}

/**
 * Validate {@link IngestPolicy.quarantineThreshold} at construction time — see
 * {@link InvalidQuarantineThresholdError}. A bare function (not a method) so it runs
 * before `this` exists, guarding the FIRST thing the constructor would otherwise do
 * with an unchecked caller value.
 */
function assertValidQuarantineThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new InvalidQuarantineThresholdError(threshold);
  }
}

// ---------------------------------------------------------------------------
// Engine precondition/wiring errors (Wave-3 `untyped-engine-error-taxonomy`)
//
// FINDING: the most-called engine verbs (`ratify`, `adjudicate`, `approve`,
// `disown`) used to throw a plain `Error` for their precondition/wiring
// failures, while peripheral subsystems already export named subclasses for
// the identical KIND of failure — `SharedHandleNotWalError`
// (store/sqliteStore.ts), `UnverifiedLedgerRestoreError` (store/backup.ts),
// `OffLedgerReputationError` (ratification/reconcile.ts),
// `UnknownFutureSchemaError` (store/migrations.ts), `InvalidQuarantineThresholdError`
// (above). A caller could not `catch`/`instanceof` these four engine failures
// without matching on message text. Fixed by adding named, exported classes
// here matching that existing pattern, and throwing them from the same
// call sites with the EXACT SAME message text (a stable contract for any
// existing caller matching on `.message`) — only the runtime `constructor`/
// `name`/`instanceof` identity changes.
// ---------------------------------------------------------------------------

/**
 * Thrown when an engine verb needs a {@link RatificationDeps} ratification
 * ledger to be wired at {@link createIntelligentDb} construction time but none
 * was supplied: `adjudicate`'s DEFERRED path (nowhere to journal an
 * INDEPENDENT_DISPUTE for the human horn — a deferral must never be silently
 * dropped) and `approve` (nowhere to record/resolve one). See the section doc
 * above for why this replaces a plain `Error` with an identical message.
 */
export class RatificationNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatificationNotWiredError";
  }
}

/**
 * Thrown by {@link IntelligentDb.disown} when no {@link ReputationLedger} was
 * wired at {@link createIntelligentDb} construction time — there is nothing to
 * claw back. See the section doc above for why this replaces a plain `Error`
 * with an identical message.
 */
export class ReputationNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReputationNotWiredError";
  }
}

/**
 * Thrown by {@link IntelligentDb.ratify} when `input.strandId` does not resolve
 * in the store — the ONLY promotion verb cannot ratify a strand that does not
 * exist. `verb`/`strandId` are carried as fields (not just interpolated into the
 * message) so a catcher can inspect which id was unknown without re-parsing the
 * message string. See the section doc above for why this replaces a plain
 * `Error` with an identical message.
 */
export class UnknownStrandError extends Error {
  constructor(
    public readonly verb: string,
    public readonly strandId: StrandId,
  ) {
    super(`${verb}: unknown strand ${String(strandId)}`);
    this.name = "UnknownStrandError";
  }
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
 * The forgetting/consolidation hook is optional. The eviction-permission gates
 * themselves are implemented in forgetting/ (tiers.ts + consolidation.ts), but no
 * `ConsolidationPort` adapter ships in the default wiring, so the keep-pressure
 * recompute seam is a no-op until a caller injects one.
 *
 * The reputation ledger is the LIVE CREDIT-SCORE backend (pillar 3). When supplied,
 * the `ratify` verb drives `ledger.ratify(...)` so earned trust accrues from the
 * only belief-raising verb, and the SAME ledger instance must back the identity
 * facade's `ReputationLedgerPort.scoreOf` so the next `stampFor` reflects it. When
 * null (the scaffold default), ratification raises belief but earns no reputation.
 *
 * The {@link IngestPolicy} is the trust-tiered ingest knob (Phase 3). OMITTED (or
 * null) means the DEFAULT gate at {@link DEFAULT_QUARANTINE_THRESHOLD} — a fact
 * from a source whose strongest single anchor weight is below 0.10 lands
 * PROVISIONAL, not LIVE. Pass `{ quarantineThreshold: 0 }` for the explicit
 * legacy always-LIVE escape hatch.
 *
 * The {@link RetrievalDeps} `retrieval` param (Phase-1 retrieval spec §1) is the
 * OPTIONAL embedder + vector-sidecar wiring. OMITTED (or null, the default)
 * means behavior is BIT-FOR-BIT today's: the core ships no embedder and never
 * calls one. When supplied, ONLY {@link IntelligentDb.writeFactWithEmbeddingAsync}
 * consults it (`writeFact` itself is UNCHANGED) — see that method's doc and
 * `core/types.ts`'s `EmbedderPort` doc for the non-negotiable "seeding only,
 * never belief" constraint.
 *
 * TWO CALL FORMS (Wave-3 `createIntelligentDb-positional-nullable-params`,
 * 2026-07-07): the classic 7-parameter POSITIONAL form above (five of them
 * nullable) is error-prone at a call site with several deps — `createIntelligentDb(
 * store, identity, null, null, ratification)` reads fine once you have counted
 * the `null`s, and reads WRONG the moment a caller miscounts them. An
 * OPTIONS-OBJECT overload, {@link CreateIntelligentDbOptions}, lets the caller
 * name each dependency instead: `createIntelligentDb(store, identity, {
 * ratification })`. Both forms construct the IDENTICAL engine — the options
 * bag is a pure ergonomic wrapper around the SAME five optional slots — and the
 * positional form is UNCHANGED / still fully supported (every existing call
 * site keeps working byte-for-byte; this is additive, not a replacement).
 * Discriminated at runtime by shape: the third positional argument is treated
 * as the options bag UNLESS it looks like a real {@link ConsolidationPort} (has
 * a callable `onExternalRatification` — the one method that interface defines,
 * which the options bag never carries).
 */
export function createIntelligentDb(
  store: StrandStore,
  identity: SourceIdentityLayer,
  options?: CreateIntelligentDbOptions,
): IntelligentDb;
export function createIntelligentDb(
  store: StrandStore,
  identity: SourceIdentityLayer,
  consolidation?: ConsolidationPort | null,
  reputation?: ReputationLedger | null,
  ratification?: RatificationDeps | null,
  ingest?: IngestPolicy | null,
  retrieval?: RetrievalDeps | null,
): IntelligentDb;
export function createIntelligentDb(
  store: StrandStore,
  identity: SourceIdentityLayer,
  arg3?: ConsolidationPort | CreateIntelligentDbOptions | null,
  reputationArg: ReputationLedger | null = null,
  ratificationArg: RatificationDeps | null = null,
  ingestArg: IngestPolicy | null = null,
  retrievalArg: RetrievalDeps | null = null,
): IntelligentDb {
  let consolidation: ConsolidationPort | null;
  let reputation: ReputationLedger | null;
  let ratification: RatificationDeps | null;
  let ingest: IngestPolicy | null;
  let retrieval: RetrievalDeps | null;

  if (isCreateIntelligentDbOptions(arg3)) {
    consolidation = arg3.consolidation ?? null;
    reputation = arg3.reputation ?? null;
    ratification = arg3.ratification ?? null;
    ingest = arg3.ingest ?? null;
    retrieval = arg3.retrieval ?? null;
  } else {
    consolidation = arg3 ?? null;
    reputation = reputationArg;
    ratification = ratificationArg;
    ingest = ingestArg;
    retrieval = retrievalArg;
  }

  return new IntelligentDbImpl(
    store,
    identity,
    consolidation,
    reputation,
    ratification,
    ingest,
    retrieval,
  );
}

/**
 * The named-dependency-bag form of {@link createIntelligentDb}'s five OPTIONAL
 * trailing parameters (`consolidation`/`reputation`/`ratification`/`ingest`/
 * `retrieval`) — every field mirrors that positional parameter's own doc
 * exactly (see the factory's doc above), just addressable by name instead of
 * position. Omitting a field is IDENTICAL to passing `null` for it positionally.
 */
export interface CreateIntelligentDbOptions {
  readonly consolidation?: ConsolidationPort | null;
  readonly reputation?: ReputationLedger | null;
  readonly ratification?: RatificationDeps | null;
  readonly ingest?: IngestPolicy | null;
  readonly retrieval?: RetrievalDeps | null;
}

/**
 * Runtime discriminant between {@link createIntelligentDb}'s two call forms'
 * shared third argument: a real {@link ConsolidationPort} (positional form) has
 * exactly one callable method, `onExternalRatification`; the options bag never
 * defines a property by that name, so its absence (or non-function-ness) is
 * what marks the argument as the options bag instead.
 */
function isCreateIntelligentDbOptions(
  arg: ConsolidationPort | CreateIntelligentDbOptions | null | undefined,
): arg is CreateIntelligentDbOptions {
  if (arg === null || arg === undefined) return false;
  return typeof (arg as Partial<ConsolidationPort>).onExternalRatification !== "function";
}

/**
 * OPTIONAL retrieval wiring (Phase-1 retrieval spec §1-2): the injected
 * {@link EmbedderPort} plus the {@link VectorSidecar} it writes into. Passed as
 * ONE bag (rather than two separate params) because they are always used
 * together — an embedder with nowhere to store its vectors, or a vector store
 * with no embedder to populate it, is not a coherent wiring.
 */
export interface RetrievalDeps {
  /** The injected embedder. Never called by anything except {@link IntelligentDb.writeFactWithEmbeddingAsync}. */
  readonly embedder: EmbedderPort;
  /** The vector sidecar {@link IntelligentDb.writeFactWithEmbeddingAsync} populates. */
  readonly vectors: VectorSidecar;
}

/**
 * The ratification wiring the engine needs to back the {@link PendingRatification}
 * horn: the append-only checksum-chained LEDGER (vault + doorbell) and the SYSTEM
 * source id attributed on every system-authored PENDING/MUTATION record. Optional —
 * when absent, the engine still adjudicates (RESOLVED/NOOP) but cannot DEFER or
 * approve (it throws on those paths so a deferred dispute is never silently dropped).
 */
export interface RatificationDeps {
  /** The immortal, hash-chained ratification ledger (a tamper-evident checksum chain). */
  readonly ledger: PendingLedger;
  /** The engine's own {@link SourceId}, attributed on every system-authored record. */
  readonly systemSource: SourceId;
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
 * Optional knobs for {@link IntelligentDb.approve} (PHASE 4 — surfacing the dispute
 * horn per tier). `allowAuthorApprover` is the PERSONAL tier's OWNER-OVERRIDE policy
 * hook, threaded verbatim into {@link ApproveContext.allowAuthorApprover} (where the
 * full WHY is documented): in a mom-and-pop deployment the OWNER is the trust root —
 * an EXTERNAL_AUTHORITY-grade anchor with no second admin to ring — and the owner
 * overriding a memory they themselves authored ("you told me X in March") is the
 * tier's ground truth, not self-dealing. Under the flag ONLY the distinct-approver
 * gate and the RC-5 independence-vs-authors check are bypassed; registered-with-
 * anchors, dispute-open, and winner-is-member stay unconditional, and the APPROVAL
 * record is stamped `ownerOverride: true` in the immortal chain. DEFAULT FALSE —
 * enterprise callers that omit it get exactly the pre-Phase-4 fail-closed gates.
 */
export interface ApproveOptions {
  /** PERSONAL-tier owner-override (see above). Default `false` (fail-closed). */
  readonly allowAuthorApprover?: boolean;
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

/**
 * Options for {@link IntelligentDb.runForgetting}. Omitting everything sweeps EVERY
 * strand in the store (`store.allStrands()`) at `now()` under the default forgetting
 * config — the maintenance-tick default a scheduler would call unattended.
 */
export interface ForgettingOptions {
  /** Witness time the sweep evaluates pressure/gates against (defaults to now). */
  readonly at?: EpochMs;
  /** Forgetting tunables (defaults to {@link DEFAULT_FORGETTING_CONFIG}). */
  readonly cfg?: ForgettingConfig;
  /** Restrict the sweep to exactly these strand ids; omitted = every strand. */
  readonly strandIds?: readonly StrandId[];
}

/** One strand actually MOVED down a tier by {@link IntelligentDb.runForgetting}. */
export interface ForgettingMove {
  readonly strandId: StrandId;
  readonly from: Tier;
  readonly to: Tier;
  readonly reason: ReasonCode;
}

/** One strand KEPT (not moved) by {@link IntelligentDb.runForgetting}, with why. */
export interface ForgettingKept {
  readonly strandId: StrandId;
  readonly tier: Tier;
  /** Empty for a HOT/WARM strand under-pressure (gates were never consulted). */
  readonly failedGates: readonly EvictionGate[];
}

/** The full, auditable receipt of one {@link IntelligentDb.runForgetting} sweep. */
export interface ForgettingResult {
  /** Total strands evaluated (the target set size). */
  readonly evaluated: number;
  /** Every strand actually moved down a tier, in evaluation order. */
  readonly moved: readonly ForgettingMove[];
  /** Every strand evaluated but KEPT at its current tier, in evaluation order. */
  readonly kept: readonly ForgettingKept[];
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
  // CANONICAL serialization (core/canonicalJson.ts): `content_hash` is the engine's
  // "same claim" fingerprint — the corroboration agreement set (#deriveAgreementSet),
  // the AGENT_RELAY echo gate (resolveCausalOrigin's claimHash), and disown's
  // dedupe-by-root all compare it — so it must be a function of the payload VALUE,
  // never of key insertion order. Raw JSON.stringify made {city, since} and
  // {since, city} hash differently: corroboration silently undercounted, and class
  // inheritance was refused to a byte-reordered relay of the SAME object (re-opening
  // the manufactured-corroboration hole the relay fix closed).
  //
  // MIGRATION NOTE (stated out loud): this CHANGES the computed content_hash for any
  // payload whose stored hash was minted from non-sorted key order, and there is no
  // schema-migration ladder (a documented GAP-LIST item) — hashes persisted in a
  // pre-existing database file simply predate this function. Acceptable for the
  // prototype; a real deployment would rehash under a user_version migration.
  h.update(canonicalJson(payload ?? null));
  return h.digest("hex") as ContentHash;
}

/**
 * Cheap, deterministic proxy for CLAUDE.md's `description_value` ("reconstruction-loss
 * bits vs independent neighbors, echo-discounted"). This is the ONLY real signal the
 * forgetting layer's LOW_UNIQUE_VALUE gate (`forgetting/tiers.ts`) has to work with —
 * without it every strand looks equally (un)unique and the gate is dead weight. Uses a
 * zero-dependency order-0 Shannon-entropy estimate over the JSON-serialized payload:
 * real information content, one pass, deterministic, no embeddings/ML. A rich,
 * non-repetitive payload scores many bits (hard to reconstruct from nothing); a
 * degenerate/empty one scores near zero (trivially reconstructable, cheap to let go).
 */
function descriptionValueOf(payload: unknown): number {
  const s = JSON.stringify(payload ?? null);
  const n = s.length;
  if (n === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropyPerChar = 0;
  for (const count of freq.values()) {
    const p = count / n;
    entropyPerChar -= p * Math.log2(p);
  }
  return entropyPerChar * n;
}

/**
 * Build a single provenance root from a source's stamp. The stamp's source id
 * becomes the root's source; the independence CLASS is offline-assigned elsewhere,
 * so the scaffold seeds it from the source id (one root, one class) — the identity
 * layer's `independentRootCount` is the authority that later collapses same-class
 * echoes. Shared by the new-strand DEFAULT root-set ({@link provenanceFromStamp} —
 * the fallback when no {@link CausalOrigin} says otherwise) and the external root
 * appended by `ratify`, so both mint roots identically. The ratify path is
 * DELIBERATELY untouched by the relay fix: an external ratifier is a genuine
 * per-source witness, not a relay.
 */
function provenanceRootFromStamp(stamp: IdentityStamp, at: EpochMs): ProvenanceRoot {
  return {
    rootId: (`root:${randomUUID()}` as ProvenanceRoot["rootId"]),
    // Offline-assigned in production; scaffold derives one class per source id.
    independenceClass: (`class:${String(stamp.source_id)}` as ProvenanceRoot["independenceClass"]),
    sourceId: stamp.source_id,
    establishedAt: at,
  };
}

/**
 * Build the provenance root-set for a newly observed strand from its stamp (one
 * root, one class — see {@link provenanceRootFromStamp}). This is the DEFAULT /
 * fallback path: `causalOrigin` omitted, `USER_STATEMENT`, or an `AGENT_RELAY`
 * whose consulted strands all failed to resolve (no worse than omission).
 */
function provenanceFromStamp(stamp: IdentityStamp, at: EpochMs): readonly ProvenanceRoot[] {
  return [provenanceRootFromStamp(stamp, at)];
}

/**
 * Mint a fresh provenance root carrying a CALLER-DETERMINED independence class
 * (the relay fix's copy/derive paths). Fresh `rootId` (a root is an occurrence,
 * never shared), the FILING stamp's `sourceId` (who filed it is still true and
 * is what a disown sweep keys on), `establishedAt = now` — only the CLASS is
 * taken from the causal origin instead of the filing source.
 *
 * `inheritedClass: true` marks the class as BELONGING to the causal origin (the
 * upstream witness / the external resource), NOT to the filing source. This is
 * load-bearing for the disown sweep: without it, disowning a RELAYER would taint
 * the honest UPSTREAM source's class (`taintedClasses` keys on roots whose
 * `sourceId === disowned`) and permanently scar every honest source rooted in
 * it — a suppression vector (relay a rival, get disowned, crater the rival).
 */
function mintRootWithClass(
  klass: IndependenceClassId,
  sourceId: SourceId,
  at: EpochMs,
): ProvenanceRoot {
  return {
    rootId: (`root:${randomUUID()}` as ProvenanceRoot["rootId"]),
    independenceClass: klass,
    sourceId,
    establishedAt: at,
    inheritedClass: true,
  };
}

/**
 * Deterministic independence class for a TOOL_CALL / DOCUMENT origin, derived
 * from (kind, resourceId) — NEVER from the filing agent — so the SAME underlying
 * resource collapses to ONE class regardless of WHICH agent fetched it. The kind
 * participates in the hash (domain separation: a document and a tool that happen
 * to share an id string are different witnesses), joined by the same NUL
 * separator {@link hashPayload} uses. `resourceId` is trusted to be the
 * canonicalized UNDERLYING resource (normalized URL / content hash) — the
 * caller's job; this layer just hashes what it is given.
 */
function resourceIndependenceClass(
  kind: "TOOL_CALL" | "DOCUMENT",
  resourceId: string,
): IndependenceClassId {
  const h = createHash("sha256");
  h.update(kind);
  h.update("\u0000");
  h.update(resourceId);
  return (`class:resource:${h.digest("hex")}` as IndependenceClassId);
}

/**
 * The write path's resolved view of a fact's {@link CausalOrigin}: the provenance
 * root-set the new strand will carry, plus the consulted strands (AGENT_RELAY
 * only) to mint DERIVATION citation edges to.
 */
interface ResolvedCausalOrigin {
  /** The provenance root-set for the new strand. */
  readonly provenance: readonly ProvenanceRoot[];
  /**
   * Resolved consulted strand ids (deduped, store-verified). One DERIVATION edge
   * (new strand → witness) is minted per entry; empty for every non-relay origin.
   */
  readonly derivationWitnesses: readonly StrandId[];
}

/**
 * Resolve a fact's {@link CausalOrigin} into the provenance roots + DERIVATION
 * witnesses the write path mints (the relay fix's class-computation rules):
 *
 *  - omitted or USER_STATEMENT ⇒ today's behavior EXACTLY: one fresh root in
 *    `class:${source_id}` (back-compatible fallback).
 *  - TOOL_CALL / DOCUMENT ⇒ one fresh root in the deterministic per-resource
 *    class ({@link resourceIndependenceClass}) — same resource, one class,
 *    regardless of the fetching agent.
 *  - AGENT_RELAY ⇒ COPY the independence class(es) of the resolved consulted
 *    strands' existing roots — one minted root per DISTINCT upstream class
 *    (fresh rootId, filing stamp's sourceId, establishedAt = now). Because
 *    Stage-1 of `independentRootCount` collapses same-class roots
 *    unconditionally, copying the class is what makes the relay count as the
 *    SAME witness — no new graph-reachability check anywhere else.
 *
 * THE ECHO GATE (adversarial finding, fail-open closed): a witness's class is
 * copied ONLY when the new fact is the SAME CLAIM as that witness — same
 * `content_hash` (which bakes in entity + payload) AND same `attribute`. Class
 * inheritance means "I am the same observation as my witness"; without the gate
 * a zero-reputation attacker could file a CONTRADICTING payload under
 * AGENT_RELAY citing the victim's strand, inherit the victim's class, and
 * collapse a genuine multi-class dispute into `tryConsolidate`'s single-class
 * echo lane (deterministic-id tiebreak — a coin-flip demotion of the honest
 * incumbent, strictly WORSE than omitting the origin). A witness that fails the
 * gate contributes NO class (the write falls back toward the default per-source
 * class — no worse than omission) but KEEPS its DERIVATION citation: the
 * consultation is a graph fact regardless of agreement, and the disown-sweep
 * taint BFS must still see it. A paraphrased relay (different payload bytes)
 * therefore minting a fresh class is the documented residual — it is exactly
 * today's pre-fix behavior, never worse.
 *
 * AGENT_RELAY edge cases, each handled deliberately:
 *  - EMPTY `consultedStrandIds` ⇒ fallback/default, identical to omission.
 *  - consulted ids that do NOT resolve ⇒ skipped; if NONE resolve, fallback —
 *    same as omission, no worse (and no dangling DERIVATION edges).
 *  - DUPLICATE consulted ids ⇒ deduped (one witness, one DERIVATION edge).
 *  - a consulted strand whose provenance carries MULTIPLE classes ⇒ each
 *    distinct class is copied exactly once across the whole consulted set.
 *  - (defensive) resolved witnesses whose provenance is EMPTY ⇒ no class to
 *    copy; fall back to the default root but KEEP the DERIVATION citations
 *    (the strand demonstrably rested on them — the disown sweep must see it).
 */
function resolveCausalOrigin(
  input: WriteFactInput,
  at: EpochMs,
  getStrand: (id: StrandId) => Strand | null,
): ResolvedCausalOrigin {
  const origin = input.causalOrigin;

  // Omitted / USER_STATEMENT: the filing source genuinely is the witness.
  if (origin === undefined || origin.kind === "USER_STATEMENT") {
    return { provenance: provenanceFromStamp(input.stamp, at), derivationWitnesses: [] };
  }

  if (origin.kind === "TOOL_CALL" || origin.kind === "DOCUMENT") {
    const klass = resourceIndependenceClass(origin.kind, origin.resourceId);
    return {
      provenance: [mintRootWithClass(klass, input.stamp.source_id, at)],
      derivationWitnesses: [],
    };
  }

  // AGENT_RELAY: copy upstream classes; cite the witnesses with DERIVATION edges.
  // The ECHO GATE (see the doc above): a class is inherited only from a witness
  // making the SAME CLAIM — same content_hash (entity + payload) + same attribute.
  const claimHash = hashPayload(input.entity, input.payload);
  const claimAttr = input.attribute ?? null; // Strand.attribute normalizes to null
  const witnesses: StrandId[] = [];
  const seenIds = new Set<StrandId>(); // dedupe duplicate consulted ids
  const classes = new Set<IndependenceClassId>(); // one copy per DISTINCT class
  for (const id of origin.consultedStrandIds) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const consulted = getStrand(id);
    if (consulted === null) continue; // unresolvable id: skip it, never abort
    witnesses.push(consulted.id); // the citation is kept even when the gate refuses
    if (consulted.content_hash !== claimHash) continue; // ECHO GATE: different claim
    if (consulted.attribute !== claimAttr) continue; //    ... or different attribute
    for (const root of consulted.provenance) classes.add(root.independenceClass);
  }

  // Empty consulted list, or nothing resolved: identical to omission (no worse).
  if (witnesses.length === 0) {
    return { provenance: provenanceFromStamp(input.stamp, at), derivationWitnesses: [] };
  }

  // No inheritable classes: either the ECHO GATE refused every witness (the fact
  // is a DIFFERENT claim from everything it consulted — an attacker-shaped input,
  // or an honest paraphrase/derivation), or (defensive; should not happen — every
  // engine-minted strand has ≥1 root) the witnesses carry no provenance. Either
  // way: the default per-source root (identical to omission, never worse), and
  // the DERIVATION citations are KEPT — the derivation is a fact about the graph
  // regardless of what class the roots collapse to.
  const provenance =
    classes.size > 0
      ? [...classes].map((k) => mintRootWithClass(k, input.stamp.source_id, at))
      : provenanceFromStamp(input.stamp, at);

  return { provenance, derivationWitnesses: witnesses };
}

/**
 * Mint the DERIVATION citation edge for an AGENT_RELAY write: `from` = the NEW
 * (derived) strand, `to` = the consulted witness — DERIVATION points
 * derived→witness, exactly the direction `downstreamDisownSweep`'s BFS expects
 * (it walks `store.inEdges(witness)` and takes each edge's `from` as the
 * downstream frontier), so a later disown of the upstream source taints the
 * relayed strand.
 *
 * Field values mirror the codebase's synthetic-edge precedent (disown.ts's
 * OUTRANKS stub and every test-built DERIVATION edge): unit link_confidence /
 * provenance_independence / recency / w. These are STRUCTURAL bookkeeping edges,
 * not librarian-confidence threads — the taint BFS filters by edgeType only and
 * never reads the weights. `out_weight_sum` starts at 1 and is reconciled to the
 * true Σw by the `recomputeOutWeightSum` call the write path issues after all of
 * a strand's citation edges are in (the store contract's required step, unlike
 * the disown sentinel whose synthetic `from` has exactly one edge by
 * construction).
 *
 * The id is deterministic in (derived, witness) — mirroring disown.ts's
 * `defaultMintEdgeId` — so a replayed write of the same strand cannot duplicate
 * citation edges.
 */
function derivationEdgeFor(derived: StrandId, witness: StrandId): Edge {
  return {
    id: asEdgeId(`edge:derivation:${String(derived)}->${String(witness)}`),
    from: derived,
    to: witness,
    edgeType: EdgeType.DERIVATION,
    link_confidence: 1,
    provenance_independence: 1,
    recency: 1,
    w: 1,
    out_weight_sum: 1, // provisional; recomputeOutWeightSum(derived) sets the true Σw
  };
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
 * un-forgeable grace window (CLAUDE.md forgetting floor); their `observedAt`
 * sets the grace floor. The provenance root-set is supplied by the caller
 * ({@link resolveCausalOrigin} owns the class-computation rules — the relay
 * fix), never re-derived here — and so is `factState` (the engine's
 * trust-tiered ingest gate owns the LIVE-vs-PROVISIONAL decision; see
 * {@link IngestPolicy}). EVERYTHING ELSE is identical for both states: a
 * quarantined PROVISIONAL strand gets the same WARM grace pin, the same fresh
 * salience, the same entity indexing (via `putStrand`) and the same real
 * `description_value` a LIVE one gets — only `fact_state` differs, so the
 * superposition is fully visible/traversable in the web while being unable to
 * demote a LIVE incumbent (adjudicate admits only LIVE members).
 */
function makeObservedStrand(
  input: WriteFactInput,
  at: EpochMs,
  provenance: readonly ProvenanceRoot[],
  factState: FactState,
): Strand {
  const id = asStrandId(`strand:${randomUUID()}`);
  return {
    id,
    entity: input.entity,
    attribute: input.attribute ?? null,
    payload: input.payload,
    content_hash: hashPayload(input.entity, input.payload),
    origin: FactOrigin.OBSERVED,
    fact_state: factState,
    tier: Tier.WARM, // pinned WARM for the grace window
    provenance,
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: emptyBridgeAccounting(),
    salience: freshSalience(at),
    description_value: descriptionValueOf(input.payload),
    observedAt: at,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
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
// explain / beliefTimeline construction helpers (read-only, deterministic)
// ---------------------------------------------------------------------------

/**
 * The disown sweep's synthetic-OUTRANKS sentinel prefix (`disownSentinelFor`,
 * ratification/disown.ts). An `outranked_by` edge whose `from` starts with this
 * names "your provenance was disowned", not a winning peer strand — the sentinel
 * must NEVER be resolved as a strand (it deliberately resolves to null). The
 * suffix after the prefix is the disowned SourceId, verbatim.
 */
const DISOWN_SENTINEL_PREFIX = "strand:disown-sentinel:";

/**
 * The disown sweep's deterministic OUTRANKS edge-id prefix (its `defaultMintEdgeId`
 * mints `edge:disown-outranks:<winner>-><loser>` with the sentinel as winner). A
 * DEMOTE receipt whose `refEventId` starts with this was a demote-by-disown.
 */
const DISOWN_OUTRANKS_EDGE_PREFIX = "edge:disown-outranks:";

/** Deterministic string ordering (explicit, locale-independent). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort edges by id — the spec's deterministic order for restsOn / supports. */
function byEdgeId(a: Edge, b: Edge): number {
  return compareStrings(String(a.id), String(b.id));
}

/**
 * The timeline's same-instant tiebreak rank (spec: OBSERVED=0,
 * EXTERNAL_ROOT_APPENDED=1, DISPUTE_OPENED=2, DISPUTE_RESOLVED=3,
 * DISPUTE_REOPENED=4, DEMOTED=5, CORROBORATION_CREDITED=6) — causally sensible
 * ordering for events sharing one millisecond (a dispute opens before it
 * resolves; a demotion lands after the resolution that caused it).
 */
const BELIEF_EVENT_KIND_RANK: Record<BeliefEvent["kind"], number> = {
  OBSERVED: 0,
  EXTERNAL_ROOT_APPENDED: 1,
  DISPUTE_OPENED: 2,
  DISPUTE_RESOLVED: 3,
  DISPUTE_REOPENED: 4,
  DEMOTED: 5,
  CORROBORATION_CREDITED: 6,
};

/** The per-event deterministic tie key (strandId for strand events, csid for disputes). */
function beliefEventTieKey(e: BeliefEvent): string {
  switch (e.kind) {
    case "DISPUTE_OPENED":
    case "DISPUTE_RESOLVED":
    case "DISPUTE_REOPENED":
      return String(e.contradictionSetId);
    default:
      return String(e.strandId);
  }
}

/**
 * Ascending (at, kindRank, tieKey) — the timeline's total order. Only DATED
 * events are ever sorted with this (the `events` array holds no `at: null` by
 * construction; nulls live in `undatedEvents`), so the null branch is defensive.
 */
function byBeliefEventOrder(a: BeliefEvent, b: BeliefEvent): number {
  const ta = a.at === null ? 0 : (a.at as number);
  const tb = b.at === null ? 0 : (b.at as number);
  if (ta !== tb) return ta - tb;
  const ra = BELIEF_EVENT_KIND_RANK[a.kind];
  const rb = BELIEF_EVENT_KIND_RANK[b.kind];
  if (ra !== rb) return ra - rb;
  return compareStrings(beliefEventTieKey(a), beliefEventTieKey(b));
}

/**
 * BOUNDED SCAR-LIMITER STORE (Wave-3 remediation item
 * `scar-limiter-unbounded-and-non-durable`) — the concrete storage backing
 * {@link IntelligentDbImpl}'s per-`(contradictor,target,class)` anti-grief scar
 * rate-limit (see `#admitScar` below). A plain `Map<string, EpochMs>` with no
 * pruning grows without bound for the lifetime of a long-lived process under
 * sustained disown/contradiction traffic — a slow memory leak, not a
 * belief/trust-invariant weakening: the rate-limit DECISION ({@link admit}) is
 * byte-identical to the original unbounded-Map logic; only the STORAGE is now
 * bounded, via two independent, non-interacting safety valves:
 *
 *  1. STALE PRUNE (age-based): any entry whose recorded scar time is already
 *     `>= windowMs` in the past can never again change a future {@link admit}
 *     decision for that key — a fresh call would already treat it as expired
 *     and re-arm. Sweeping such entries out is therefore a pure memory
 *     optimization with NO behavior change, amortized so a single `admit()`
 *     call never pays a full O(n) sweep: the sweep itself runs at most once
 *     per `pruneIntervalMs` of the injected clock's progress.
 *  2. SIZE CAP (oldest-first eviction): bounds worst-case memory even before
 *     entries age out, against a flood of never-repeating distinct keys
 *     inside one window. `Map` iteration order is INSERTION order (re-`set`ting
 *     an EXISTING key does not move its position), so evicting from the front
 *     is a cheap, deterministic "oldest tracked pair" proxy. Evicting an entry
 *     that happens to still be in-window only ever lets THAT ONE pair's rate
 *     limit re-arm early under extreme cardinality — it can never suppress a
 *     scar that should have fired (the failure direction is "check again",
 *     never "silently drop a real betrayal").
 *
 * PERSISTENCE ACROSS RESTART is deliberately OUT OF SCOPE, documented not
 * silently dropped: this store is a short-window (90-day) RATE LIMIT on how
 * often a repeat contradiction between the same pair/class may escalate into
 * the NON-DECAYING scar path — it is not the substantive penalty itself. The
 * substantive clawback (`scarBeta`, via the reputation ledger) is already
 * durably persisted through the store. Losing this limiter's state on restart
 * re-opens, at worst, ONE extra scar opportunity per `(contradictor,target,
 * class)` triple — bounded, and a strictly smaller exposure than the
 * durability work already shipped for facts/trust/audit — so an attacker
 * forcing a restart gains a single extra scar, never an unbounded one and
 * never a way to un-scar a betrayal already recorded in the reputation ledger.
 */
export class ScarLimiterStore {
  readonly #entries = new Map<string, EpochMs>();
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #pruneIntervalMs: number;
  #lastPrunedAt: number | null = null;

  constructor(windowMs: number, maxEntries = 50_000, pruneIntervalMs = Math.max(1, windowMs / 10)) {
    this.#windowMs = windowMs;
    this.#maxEntries = maxEntries;
    this.#pruneIntervalMs = pruneIntervalMs;
  }

  /** Current tracked-entry count. Bounded by `maxEntries` at all times; a diagnostic/test-only surface. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether `key` currently has a tracked (possibly stale-but-not-yet-swept) entry. */
  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /**
   * Byte-identical decision to the original unbounded-Map logic: true (and
   * records `at`) the first time `key` is admitted, or once `windowMs` has
   * elapsed since its last admission; false for a repeat inside the window.
   */
  admit(key: string, at: EpochMs): boolean {
    this.#pruneStale(at);
    const last = this.#entries.get(key);
    if (last !== undefined && (at as number) - (last as number) < this.#windowMs) {
      return false; // already admitted this key in-window
    }
    this.#entries.set(key, at);
    this.#evictOverflow();
    return true;
  }

  /** Amortized sweep: removes every entry whose age has already exceeded the window. */
  #pruneStale(at: EpochMs): void {
    const nowMs = at as number;
    if (this.#lastPrunedAt !== null && nowMs - this.#lastPrunedAt < this.#pruneIntervalMs) return;
    this.#lastPrunedAt = nowMs;
    for (const [key, ts] of this.#entries) {
      if (nowMs - (ts as number) >= this.#windowMs) this.#entries.delete(key);
    }
  }

  /** Hard size cap: evict oldest-inserted entries (LRU-style) until back at `maxEntries`. */
  #evictOverflow(): void {
    let overflow = this.#entries.size - this.#maxEntries;
    if (overflow <= 0) return;
    for (const key of this.#entries.keys()) {
      if (overflow <= 0) break;
      this.#entries.delete(key);
      overflow--;
    }
  }
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
   * disputes are recorded in `#ratification.ledger` attributed to
   * `#ratification.systemSource`, and `approve` resolves them. Null in the scaffold.
   */
  readonly #ratification: RatificationDeps | null;

  /** The per-pair scar rate-limit window (one decay half-life, 90 days). */
  readonly #SCAR_WINDOW_MS = 90 * 86_400_000;

  /**
   * M3 anti-grief (BATCH 4, OD-2 seam family) — the per-source-pair contradiction
   * RATE-LIMITER. Keyed `${contradictor}->${target}:${class}` → the witness time it
   * last SCARRED. A given contradictor→target pair may add a NON-DECAYING scar at most
   * ONCE per independence class per {@link #SCAR_WINDOW_MS}; a repeat inside the window
   * falls back to an ordinary (decaying) contradiction. This blocks a single attacker
   * STACKING many w-weighted contradictions to grief an honest incumbent, while leaving
   * a genuine SECOND independent class free to scar (different pair / different class).
   * First-arrival-safe: the scar penalizes the CONTRADICTED party, never the late-arriver.
   *
   * BACKED BY {@link ScarLimiterStore} (not a raw `Map`): bounded memory under a
   * long-lived process via age-based pruning + a hard size cap (see that class's
   * doc for the full rationale, including the deliberate persistence-out-of-scope
   * call). The rate-limit DECISION is unchanged; only the storage is now bounded.
   */
  readonly #scarLimiter = new ScarLimiterStore(this.#SCAR_WINDOW_MS);

  /**
   * TRUST-TIERED INGEST (Phase 3): the resolved {@link IngestPolicy.quarantineThreshold}.
   * A filed fact whose FILER's strongest single anchor `independenceWeight` (re-derived
   * from the identity layer, never the caller's stamp) is below this lands PROVISIONAL.
   * Defaults to {@link DEFAULT_QUARANTINE_THRESHOLD} when the policy is omitted; 0 is
   * the explicit legacy always-LIVE escape hatch.
   */
  readonly #quarantineThreshold: number;

  /**
   * OPTIONAL retrieval wiring (Phase-1 retrieval spec §1-2): the embedder + the
   * vector sidecar it writes into. `null` (the default) means
   * {@link writeFactWithEmbeddingAsync} degrades to a plain {@link writeFact}
   * call — the embedder is never invoked and no vector is ever written.
   */
  readonly #retrieval: RetrievalDeps | null;

  constructor(
    store: StrandStore,
    identity: SourceIdentityLayer,
    consolidation: ConsolidationPort | null,
    reputation: ReputationLedger | null,
    ratification: RatificationDeps | null,
    ingest: IngestPolicy | null,
    retrieval: RetrievalDeps | null = null,
  ) {
    const quarantineThreshold = ingest?.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
    assertValidQuarantineThreshold(quarantineThreshold);

    this.#store = store;
    this.#identity = identity;
    this.#consolidation = consolidation;
    this.#reputation = reputation;
    this.#ratification = ratification;
    this.#quarantineThreshold = quarantineThreshold;
    this.#retrieval = retrieval;
  }

  /**
   * THE INGEST GATE (Phase 3, design doc §4.1): decide whether a fact filed under
   * `filer` lands LIVE or is QUARANTINED as PROVISIONAL.
   *
   * ENGINE-OWNED EVIDENCE (OD-8): the gate re-stamps the filer through the identity
   * layer — exactly the way `#ratifyImpl` re-stamps its external witness — and reads
   * the ANCHOR-derived trust from THAT canonical stamp, never from the caller-supplied
   * `WriteFactInput.stamp` (whose `anchor_set` a caller could inflate to smuggle a
   * bare-key fact past the gate).
   *
   * THE MEASURE is the stamp's STRONGEST SINGLE anchor `independenceWeight` — the same
   * "strongest single anchor, never a sum" notion `aggregateAnchorCost` and
   * `applySelfStackCap` (identity/anchors.ts) pin: a source stacking N cheap anchors
   * is worth its one best anchor, so self-stacking can't buy passage here either. An
   * unregistered/anchorless filer has an empty canonical anchor set ⇒ strongest 0 ⇒
   * quarantined at any positive threshold (BARE_KEY's 0.00 row made mechanical).
   *
   * WHO is gated, not WHAT was consulted: this reads the FILER's stamp (who is
   * SPEAKING), never the fact's `causalOrigin` (what was consulted). A low-trust
   * filer relaying a high-trust strand still quarantines — the relay fix copies the
   * WITNESS's independence class so the observation is never double-counted as fresh
   * corroboration, but the SPEAKER's trust is what gates belief in the new assertion
   * (the relay copies the witness CLASS for independence-counting; it does not borrow
   * the witness's authority).
   */
  #ingestStateFor(filer: SourceId): FactState {
    const canonical: IdentityStamp = this.#identity.stampFor(filer);
    let strongest = 0;
    for (const binding of canonical.anchor_set) {
      if (binding.independenceWeight > strongest) strongest = binding.independenceWeight;
    }
    // Strict `<`: EMAIL_OAUTH's 0.10 passes the default 0.10 threshold, and the
    // `quarantineThreshold: 0` escape hatch never quarantines (strongest >= 0).
    return strongest < this.#quarantineThreshold ? FactState.PROVISIONAL : FactState.LIVE;
  }

  /**
   * A1 [MUTATION audit coverage] — journal ONE content-addressed MUTATION receipt into
   * the wired ratification ledger, attributed to the system source. A no-op when no
   * ratification ledger is wired (nowhere to journal — the latent-journaling gate). Call
   * sites sit INSIDE the compound op's `withTxn` envelope so receipt + mutation commit
   * atomically.
   */
  #emitMutation(payload: MutationPayload): void {
    if (this.#ratification !== null) {
      this.#ratification.ledger.appendMutation(payload, this.#ratification.systemSource);
    }
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
   *
   * Wave-2 [ratify-double-agreement-scan]: accepts an OPTIONAL pre-computed
   * `agreementSet` (the identical `#deriveAgreementSet(target)` this method would
   * otherwise derive itself) so a caller that already needed that O(entity-strand-
   * count) scan for its OWN purposes (e.g. `ratify`'s recorded corroborator list,
   * `explain`'s `agreementStrandIds`) can compute it ONCE and hand it in here,
   * rather than this method silently re-deriving the identical set a second time
   * in the same call. Omitted (every pre-existing caller) ⇒ derives it itself,
   * byte-identical to before.
   */
  #R(target: Strand | null, agreementSet?: readonly StrandId[]): number {
    if (target === null) return 0; // fail-closed
    const byRootId = new Map<ProvenanceRootId, ProvenanceRoot>();
    const absorb = (roots: readonly ProvenanceRoot[]): void => {
      for (const r of roots) if (!byRootId.has(r.rootId)) byRootId.set(r.rootId, r);
    };
    absorb(target.provenance);
    for (const sid of agreementSet ?? this.#deriveAgreementSet(target)) {
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
    return this.#scarLimiter.admit(key, at); // already scarred this pair/class in-window ⇒ false
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

    // 0) Resolve the CAUSAL ORIGIN into the provenance root-set + DERIVATION
    //    witnesses (the relay fix, see {@link resolveCausalOrigin}). Omitted /
    //    USER_STATEMENT is byte-identical to the old per-source class mint;
    //    TOOL_CALL/DOCUMENT collapse to a per-resource class; AGENT_RELAY copies
    //    the consulted strands' classes so the relay is the SAME witness under
    //    the identity layer's Stage-1 collapse (never manufactured corroboration).
    const resolved = resolveCausalOrigin(input, at, (id) => this.#store.getStrand(id));

    // 0.5) TRUST-TIERED INGEST (Phase 3): gate LIVE-vs-PROVISIONAL on the FILER's
    //    canonical anchor trust (#ingestStateFor — engine-owned evidence, never the
    //    caller's stamp; and the FILER, never the causal origin: who is SPEAKING
    //    gates belief, what was consulted only shapes independence classes above).
    const factState = this.#ingestStateFor(input.stamp.source_id);

    // 1) Mint the OBSERVED strand. `provenance_independence` for its edges is read
    //    FROM input.stamp (invariant 2); the strand itself carries the provenance
    //    root-set the causal origin resolved to and the gated fact_state.
    const fresh = makeObservedStrand(input, at, resolved.provenance, factState);

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
    // ATOMIC: the `putStrand` PLUS (AGENT_RELAY only) every DERIVATION citation edge
    // and the one `recomputeOutWeightSum` reconciling the new strand's Σw commit as
    // ONE unit — a crash mid-write must never leave a relayed strand standing with
    // its citations missing (that half-state IS the laundering hole: relay-classed
    // provenance is safe on its own, but the disown sweep's taint BFS needs the
    // edges). Non-relay writes stay the single put they were.
    withTxn(this.#store, () => {
      this.#store.putStrand(fresh);
      if (resolved.derivationWitnesses.length > 0) {
        for (const witness of resolved.derivationWitnesses) {
          this.#store.putEdge(derivationEdgeFor(fresh.id, witness));
        }
        // The store contract: after adding out-edges of a node, the caller MUST
        // reconcile the cached share-normalization denominator (one call for the
        // whole batch of citations, O(degree) total).
        this.#store.recomputeOutWeightSum(fresh.id);
      }
    });

    return fresh.id;
  }

  // -------------------------------------------------------------------------
  // writeFactWithEmbeddingAsync — writeFact + the optional vector-sidecar
  // accelerator (renamed 2026-07-07, Wave-3 `writeFactWithEmbedding-sole-async-verb`
  // — the `Async` suffix makes the ONE Promise-returning verb on this interface
  // unmissable at the call site; see the interface doc above)
  // -------------------------------------------------------------------------

  async writeFactWithEmbeddingAsync(input: WriteFactInput): Promise<StrandId> {
    if (this.#retrieval === null) {
      // No retrieval wiring: BIT-FOR-BIT writeFact (the embedder is never
      // referenced, matching "absent => today's behavior").
      return this.writeFact(input);
    }
    const { embedder, vectors } = this.#retrieval;

    // The content_hash the fresh strand WILL carry is a pure function of
    // (entity, payload) — identical to what makeObservedStrand computes below —
    // so we can key/reuse the vector BEFORE minting the strand or opening a txn.
    const contentHash = hashPayload(input.entity, input.payload);
    const text = strandText({ payload: input.payload });

    // EMBED BEFORE THE TXN OPENS (spec §2): no `await` may run inside an open
    // transaction. Reuse an existing vector for the SAME content_hash under the
    // SAME model (echoes share one vector, no redundant embed call); otherwise
    // embed fresh. A throwing/failing embed is caught here — embeddings are an
    // ACCELERATOR, never a gate, so the write proceeds without one.
    let vec: Float32Array | null = null;
    const existing = vectors.get(contentHash);
    if (existing !== null && existing.modelId === embedder.modelId) {
      vec = existing.vec;
    } else {
      try {
        const [embedded] = await embedder.embed([text]);
        vec = embedded ?? null;
      } catch {
        vec = null;
      }
    }

    // From here, mirror writeFact's synchronous core EXACTLY (same causal-origin
    // resolution, same trust-tiered ingest gate, same strand mint) — see
    // writeFactsBatch's "Mirror writeFact EXACTLY" precedent for why this
    // codebase duplicates rather than shares this body: the belief-relevant
    // write path stays easy to diff/audit against the original verb.
    const at = now();
    const resolved = resolveCausalOrigin(input, at, (id) => this.#store.getStrand(id));
    const factState = this.#ingestStateFor(input.stamp.source_id);
    const fresh = makeObservedStrand(input, at, resolved.provenance, factState);

    withTxn(this.#store, () => {
      this.#store.putStrand(fresh);
      if (resolved.derivationWitnesses.length > 0) {
        for (const witness of resolved.derivationWitnesses) {
          this.#store.putEdge(derivationEdgeFor(fresh.id, witness));
        }
        this.#store.recomputeOutWeightSum(fresh.id);
      }
      // Populate the vector sidecar — a plain, SYNCHRONOUS upsert (no await),
      // so it enrolls in this same transaction. Skipped entirely when the embed
      // step above yielded nothing (fail-open: the fact still lands, just
      // without an accelerator).
      if (vec !== null) {
        vectors.put(fresh.content_hash, embedder.modelId, vec);
      }
    });

    return fresh.id;
  }

  // -------------------------------------------------------------------------
  // writeFactsBatch — bulk FILE (same mint path as writeFact, one txn barrier)
  // -------------------------------------------------------------------------

  writeFactsBatch(inputs: readonly WriteFactInput[]): StrandId[] {
    // Mirror writeFact EXACTLY per fact: a per-fact `now()` timestamp, the same
    // causal-origin resolution (the relay fix — identical mint path per fact), and
    // the same `makeObservedStrand` mint (provenance from the resolved origin,
    // content hash, entity index key). The ONLY difference is the put is batched:
    // one `putStrandsBatch` under one `withTxn`, so the whole ingest pays ONE
    // durability barrier and the store maintains the SAME entity index as N
    // individual `putStrand` calls would.
    //
    // NOTE on in-batch relays: consulted ids are resolved against the STORE, before
    // this batch lands — semantically identical to sequential writeFact calls,
    // because a caller cannot name a fellow batch member anyway (strand ids are
    // minted here and only returned after the batch commits).
    const minted = inputs.map((input) => {
      const at = now();
      const resolved = resolveCausalOrigin(input, at, (id) => this.#store.getStrand(id));
      // IDENTICAL trust-tiered ingest semantics per fact (the same #ingestStateFor
      // gate writeFact applies — batch is never a quarantine bypass).
      const factState = this.#ingestStateFor(input.stamp.source_id);
      return {
        strand: makeObservedStrand(input, at, resolved.provenance, factState),
        witnesses: resolved.derivationWitnesses,
      };
    });

    withTxn(this.#store, () => {
      this.#store.putStrandsBatch(minted.map((m) => m.strand));
      // AGENT_RELAY citations, exactly as writeFact mints them (same edges, same
      // per-strand Σw reconciliation), enrolled in the same single transaction.
      for (const m of minted) {
        if (m.witnesses.length === 0) continue;
        for (const witness of m.witnesses) {
          this.#store.putEdge(derivationEdgeFor(m.strand.id, witness));
        }
        this.#store.recomputeOutWeightSum(m.strand.id);
      }
    });

    return minted.map((m) => m.strand.id);
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
      // Honest-seeding forward (never a silent stop): which cue ids failed to
      // resolve and how many did — with NO_SEEDS_RESOLVED already stamped by the
      // walk when the whole cue was dangling.
      unresolvedSeeds: result.unresolvedSeeds,
      seedsResolved: result.seedsResolved,
    };
  }

  // -------------------------------------------------------------------------
  // ratify — the ONLY promotion verb; requires an EXTERNAL witness
  // -------------------------------------------------------------------------

  ratify(input: RatifyInput): void {
    // ATOMIC: strand promotion + the reputation credit it earns + the corroboration
    // event that records that credit's exact α-mass commit as ONE unit. A crash
    // between any two of these must not leave a promoted strand with no matching
    // reputation gain, or a reputation gain with no recorded (and therefore later
    // reversible) corroboration event — exactly the off-ledger state
    // `assertRatifyEmitsEvent` is meant to catch, but that check runs only AFTER
    // the writes below, so it must never see a partially-committed txn.
    withTxn(this.#store, () => {
      this.#ratifyImpl(input);
    });
  }

  #ratifyImpl(input: RatifyInput): void {
    // The external stamp is the authority that makes this NOT self-ratification
    // (invariant 1). We re-stamp through the identity layer so the recorded root is
    // the layer's canonical view of the external source, not a caller-supplied one.
    const canonicalStamp: IdentityStamp = this.#identity.stampFor(
      input.externalStamp.source_id,
    );

    const strand: Strand | null = this.#store.getStrand(input.strandId);
    if (strand === null) {
      throw new UnknownStrandError("ratify", input.strandId);
    }

    const at = now();

    // Promotion semantics depend on the strand's current shape:
    //
    //   DERIVED fact            -> OBSERVED + LIVE   (the "window" in
    //                              wall-with-a-window: an external source turns a
    //                              web-computed belief into a witnessed one).
    //   PROVISIONAL (observed)  -> LIVE, ONLY through the QUARANTINE-EXIT GATE
    //                              below: the ratifier must be anchor-INDEPENDENT
    //                              of every source already on the strand's
    //                              provenance. An echo ratify still appends its
    //                              root + earns reputation, but does NOT flip
    //                              fact_state.
    //   otherwise (already LIVE/
    //   OBSERVED, or DEMOTED)   -> record an additional external root only; state
    //                              is unchanged, keep-pressure rises.
    //
    // In ALL cases the external root is appended to the strand's provenance so future
    // independent-root counts (read from the identity layer, never self-computed)
    // see a real outside witness. fact_state/origin are mutable on Strand; the
    // provenance set is readonly, so we re-`putStrand` a clone with the added root.
    const externalRoot: ProvenanceRoot = provenanceRootFromStamp(canonicalStamp, at);

    let nextOrigin = strand.origin;
    let nextState = strand.fact_state;

    if (strand.origin === FactOrigin.DERIVED) {
      // Graduate derived -> observed (and make it current).
      nextOrigin = FactOrigin.OBSERVED;
      nextState = FactState.LIVE;
    } else if (strand.fact_state === FactState.PROVISIONAL) {
      // THE QUARANTINE-EXIT GATE (Phase 3, the trust-tiered-ingest exit): a held
      // superposition collapses to LIVE only on INDEPENDENT corroboration. This is
      // the wall-with-a-window design applied to quarantine: confirmation is
      // corroboration by INDEPENDENT provenance — "two strands agreeing from the
      // same root is an echo, not corroboration" (CLAUDE.md) — so the ratifier must
      // be anchor-independent (identity.independentSources, the SAME RC-5 predicate
      // the approve-gate uses; fail-closed for unregistered/anchorless sides) of
      // EVERY source already on the strand's provenance. Otherwise a quarantined
      // source could launder its own claim LIVE by re-ratifying through itself or
      // through a fleet-correlated sibling — the self-witnessing the two governing
      // invariants forbid. An ECHO ratify (same/correlated source) still appends
      // the external root and still drives reputation below — the consultation is
      // a real event and keep-pressure may rise — but belief does NOT: the strand
      // stays a visible PROVISIONAL superposition until something genuinely
      // OUTSIDE its provenance vouches for it (or an approve() resolution does).
      if (this.#independentOfProvenance(canonicalStamp.source_id, strand)) {
        // Confirm provisional -> live.
        nextState = FactState.LIVE;
      }
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
    // NOTE (crack-B seam): the consolidation eviction-PERMISSION gates (low echo-discounted
    //   unique value, fresh independence stamp, not-the-outranked-side of a live
    //   contradiction, not an earned bridge, independent-source-count <= 1, past the
    //   grace floor) are implemented in forgetting/ (tiers.ts + consolidation.ts).
    //   This recompute is a no-op unless a ConsolidationPort adapter is injected.
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
      // ENGINE-OWNED EVIDENCE (OD-8): the corroborating set is DERIVED from the engine's
      // own agreement index (same entity + content_hash + LIVE), never supplied by the
      // caller. The CorroborationEvent ledger field is unchanged — only its source is.
      //
      // Wave-2 [ratify-double-agreement-scan]: computed ONCE and handed into `#R`
      // below (it used to re-derive the IDENTICAL O(entity-strand-count) set a
      // second time internally — same target strand, same result, wasted scan).
      const corroborating = this.#deriveAgreementSet(strand);
      // M2 (BATCH 4) — supply the engine-owned MIS corroboration DEPTH so the ledger can
      // raise its NON-DECAYING depth-floor MONOTONE-MAX. `#R` is the SAME shared agreement
      // basis (OD-6): the count of mutually anchor-INDEPENDENT roots backing this value
      // (strand's roots ∪ agreeing LIVE strands' roots, via `independentRootCount`). The
      // model never witnesses — the ledger only stores the max it is handed. A same-class
      // (depth-1) flood passes depth 1 ⇒ `floorMass(1)=0` ⇒ buys no floor.
      const depth = this.#R(strand, corroborating);
      const after = this.#reputation.ratify(canonicalStamp.source_id, at, undefined, depth);
      const deltaAlpha = after.alpha - beforeAlpha;
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
          // The raw MIS depth (#R) THIS event snapshotted — the depth-floor-reversal
          // recompute's input (a later disown's `survivingDepth` is the max of this
          // field over every OTHER, still-unreversed event for the same beneficiary;
          // see disown.ts's corroboration-reversal step).
          corroborationDepthAtEvent: depth,
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

  /**
   * The quarantine-exit predicate (Phase 3): is `ratifier` anchor-INDEPENDENT of
   * EVERY source already backing `strand`'s provenance?
   *
   * Delegates each pair to `identity.independentSources` — the ONE independence
   * notion the whole system shares (the RC-5 approve-gate and the forgetting count
   * read the same predicate; anti-drift). Its semantics do the heavy lifting here:
   *   - `a === b` ⇒ false (self-ratification is an echo — also caught explicitly
   *     below for clarity);
   *   - an UNREGISTERED / anchorless side ⇒ false, FAIL-CLOSED (a BARE_KEY-
   *     equivalent witness has independence_weight 0.00 and can never be
   *     independent of anything) — so neither an anonymous ratifier nor a strand
   *     filed by a never-registered source can clear quarantine through this gate;
   *   - fleet/operator correlation (same SSO tenant, same publisher operator) ⇒
   *     false, so a Sybil sibling can't vouch its fleet-mate LIVE.
   *
   * A strand with NO resolvable provenance source fails closed too: with nothing
   * to be independent OF, independence cannot be demonstrated ("no provenance →
   * no voice" — the approve() horn remains the resolution path for such strands).
   */
  #independentOfProvenance(ratifier: SourceId, strand: Strand): boolean {
    const existing = new Set<SourceId>();
    for (const root of strand.provenance) {
      if (root.sourceId !== null) existing.add(root.sourceId);
    }
    if (existing.size === 0) return false; // fail-closed: nothing to corroborate against
    for (const source of existing) {
      if (source === ratifier) return false; // echo: the strand's own author "confirming" it
      if (!this.#identity.independentSources(ratifier, source)) return false;
    }
    return true;
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
        // immortal checksum-chained ledger for the second-admin horn. Refuse to
        // silently drop a deferral when no ledger is wired.
        if (this.#ratification === null) {
          throw new RatificationNotWiredError(
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
          this.#ratification.systemSource,
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
   * HARDENING 3 — build an {@link AdjudicationProvenance} record (shared by BOTH
   * producers, see below) so a later disown can RE-OPEN this dispute if a tainted
   * strand merely tipped its margin.
   *
   *  - `winner`: the caller-designated winning member (already resolved to LIVE).
   *  - `margin`: the LCB gap = winner's best-source reputation minus the strongest
   *    NON-winner member's best-source reputation (the gap that cleared the decision;
   *    clamped at 0).
   *  - `contributingStrandIds`: the winner strand PLUS every member that shares a
   *    backing source with the winner (the support that supplied the winner's margin).
   *    These are the strands whose taint would erode the recorded margin.
   *
   * RE-AUDIT FIX (2026-07-07, `promote()`d winners never protected by a future
   * HARDENING-3 reopen): this used to be inlined into `#recordAdjudicationProvenance`,
   * whose ONLY caller was `adjudicate()`'s auto-resolve branch — so a winner installed
   * by `approve()` (an ordinary human resolution, OR the `disown-reopen-winner-flip`
   * `promote()` path) got NO provenance record at all, making it permanently invisible
   * to a later disown's re-open sweep (`recordsContributedBy` has nothing to find).
   * Extracted so `approve()` can call it too — see the call site in `approve()` below.
   *
   * @returns the record to append, or `null` if `winnerId` is not among `members`
   *          (defensive; should not happen for a real resolution).
   */
  #buildAdjudicationProvenance(
    contradictionSetId: ContradictionSetId,
    attribute: AttributeKey,
    members: readonly Strand[],
    winnerId: StrandId,
    losingMemberIds: readonly StrandId[],
    at: EpochMs,
  ): AdjudicationProvenanceInput | null {
    const winner = members.find((m) => m.id === winnerId);
    if (winner === undefined) return null;

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

    return {
      contradictionSetId,
      attribute,
      winner: winnerId,
      margin,
      contributingStrandIds,
      // The ORIGINAL losing member ids (this resolution's demotions) — threaded
      // through so a later disown's RE-OPEN can offer them as members of the
      // reopened dispute (disown.ts), letting a genuinely surviving claim be picked
      // instead of structurally reconfirming this exact winner.
      losingMemberIds: [...losingMemberIds],
      at,
    };
  }

  /**
   * HARDENING 3 (adjudicate() producer) — records the {@link AdjudicationProvenance}
   * of an auto-RESOLVED dispute. See {@link #buildAdjudicationProvenance} for the
   * shared record-building logic (also called from `approve()`, below).
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
    const losingMemberIds: StrandId[] =
      outcome.kind === "RESOLVED" ? outcome.demotions.map((d) => d.demoted) : [];
    const rec = this.#buildAdjudicationProvenance(
      contradictionSetId,
      attribute,
      members,
      winnerId,
      losingMemberIds,
      at,
    );
    if (rec !== null) ledger.record(rec);
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
    approver: SourceId,
    at?: EpochMs,
    opts?: ApproveOptions,
  ): ResolvedDispute {
    if (this.#ratification === null) {
      throw new RatificationNotWiredError("approve: no ratification ledger is wired.");
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
        // DANGLING member id (defensive-only: strands are never deleted;
        // reachable via external store tampering / a mismatched store+ledger
        // pairing) ⇒ return null so the ledger SKIPS that loser fail-closed.
        // Throwing here would roll the whole approve back and leave the dispute
        // permanently un-resolvable (every retry re-throws on the same id) —
        // pendingQuestions would resurface an answerable-looking question the
        // owner can never actually answer.
        if (s === null) return null;
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
      // PHASE 4 — thread the explicit owner-override policy hook through to the
      // ledger's gates VERBATIM, emit-only-when-true (exactOptionalPropertyTypes:
      // omit the property entirely unless the caller explicitly opted in, so the
      // fail-closed default is structural, not a runtime default).
      ...(opts?.allowAuthorApprover === true ? { allowAuthorApprover: true } : {}),
    };

    // ATOMIC: the ledger's APPROVAL append (the checksum-chained audit record) + the
    // reputation moves it drives + the engine's store persistence (each OUTRANKS edge,
    // each demoted loser) commit as ONE unit. A crash between "append the APPROVAL" and
    // "demote the losers" would otherwise desync the immortal audit chain from the state
    // it describes — a record claiming a resolution the store never applied (or vice versa).
    // With the audit ledger + reputation ledger riding the SAME shared db handle as the
    // store, all three enroll in this single transaction.
    //
    // RESYNC ON ROLLBACK: `ledger.approve()` (called inside the txn below) both
    // durably APPENDS the APPROVAL row AND incrementally updates the ledger's
    // OWN in-memory open-pending index (a plain JS Map/Set, not itself
    // transactional). A LATER throw in this same txn (e.g. a store write that
    // fails) rolls the SQL row back, but that in-memory index update does not
    // self-undo — a residual store-vs-ledger desync one layer deeper than the
    // one this txn closes. `resyncIndex()` (optional; only the shared-handle
    // SQLite ledger implements it) re-derives the index from what is ACTUALLY
    // persisted, so a caught rollback here never leaves `listPending()` /
    // `approve()`'s own dispute lookup believing a resolution that the store
    // never durably applied.
    let resolved: ResolvedDispute;
    try {
      resolved = withTxn(this.#store, () => {
        // Resolve the dispute's ORIGINAL pending record (members + attribute) BEFORE
        // the ledger resolves it (`listPending()` no longer shows it afterwards).
        // Needed for the A1 reputation-effect snapshot below AND for the HARDENING-3
        // adjudication-provenance record this method now writes (see below).
        const pendingBefore = this.#ratification!.ledger
          .listPending()
          .find((p) => p.contradictionSetId === contradictionSetId);
        const memberIds: readonly StrandId[] = pendingBefore?.members ?? [];

        // A1 — snapshot the dispute authors' reputation BEFORE the ledger drives its moves
        // (winner ratified / losers contradicted happen INSIDE `ledger.approve`), so the
        // EFFECT receipts can carry an exact before/after. Authors are resolved through
        // the same `ctx` the gate uses.
        const repBefore = new Map<SourceId, ReputationState | null>();
        if (this.#reputation !== null) {
          for (const m of memberIds) {
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

        // PERSIST THE PROMOTED WINNER (the disown-reopen-cannot-change-winner fix): a
        // `REOPENED_BY_DISOWN` dispute's winner can be a strand the ORIGINAL
        // resolution had already demoted; `plan.winnerPromotion` is non-null exactly
        // when the ledger flipped it back to LIVE, mirroring the demotion persistence
        // above (persist the EXACT object the ledger mutated in place — `handed` — so
        // the promotion survives on a clone-on-read backend too).
        if (plan.winnerPromotion !== null) {
          const fromStore = this.#store.getStrand(winnerStrandId);
          const beforeHash = fromStore !== null ? hashStrandState(fromStore) : EMPTY_STATE_HASH;
          const winnerObj = handed.get(winnerStrandId) ?? fromStore;
          if (winnerObj !== null) {
            this.#store.putStrand(winnerObj);
            this.#emitMutation(
              mutationReceipt(
                "PROMOTE",
                String(winnerStrandId),
                String(winnerObj.content_hash),
                beforeHash,
                hashStrandState(winnerObj),
                when,
              ),
            );
          }

          // Supersede the STALE reverse-direction OUTRANKS edge the PRIOR resolution
          // minted (old-winner -> this now-promoted winner). Without removal it sits in
          // the persisted graph contradicting THIS resolution's new winner -> old-winner
          // edge (two OUTRANKS edges pointing opposite ways between the same pair). Scoped
          // to THIS dispute's demoted losers, so no unrelated OUTRANKS relationship is
          // touched. Belief was never edge-derived (it lives on fact_state / outranked_by),
          // so this is graph-hygiene for a provenance-walking consumer, not a belief change.
          const flipLoserIds = new Set<StrandId>(plan.demotions.map((d) => d.demoted));
          for (const stale of this.#store.inEdges(winnerStrandId)) {
            if (stale.edgeType === EdgeType.OUTRANKS && flipLoserIds.has(stale.from)) {
              this.#store.removeEdge(stale.id);
            }
          }
        }

        // HARDENING 3 (RE-AUDIT FIX, 2026-07-07 — "winner-flip promotions never
        // protected by a future HARDENING-3 reopen"): record adjudication provenance
        // for THIS resolution's winner, mirroring `adjudicate()`'s auto-resolve
        // producer (`#recordAdjudicationProvenance`). Pre-fix, `approve()` NEVER
        // wrote this record, so a winner it installed — an ordinary human
        // resolution, or (since the disown-reopen-winner-flip fix) a `promote()`d
        // strand that FLIPPED a reopened dispute's winner to a different strand —
        // was permanently invisible to a LATER disown's own re-open sweep
        // (`recordsContributedBy` had nothing naming it). Resolve the member
        // strands through the SAME `ctx.memberStrand` the ledger used (so a
        // clone-on-read backend sees the post-resolution objects, not stale
        // re-reads); a dangling member id is skipped fail-closed, matching the
        // ledger's own missing-strand discipline.
        const adjProvenanceLedger = this.#ratification!.adjudicationProvenance;
        if (adjProvenanceLedger !== undefined && pendingBefore !== undefined) {
          const memberStrands: Strand[] = [];
          for (const id of memberIds) {
            const s = ctx.memberStrand(id);
            if (s !== null) memberStrands.push(s);
          }
          const losingMemberIds = plan.demotions.map((d) => d.demoted);
          const rec = this.#buildAdjudicationProvenance(
            contradictionSetId,
            pendingBefore.attribute,
            memberStrands,
            winnerStrandId,
            losingMemberIds,
            when,
          );
          if (rec !== null) adjProvenanceLedger.record(rec);
        }

        // A1 — journal the reputation EFFECTS the ledger drove (one receipt per distinct
        // author per effect, deterministic by source id). The APPROVAL record already
        // commits the DECISION; these add the EFFECT records so a hidden reputation move
        // is detectable. before = the pre-approve snapshot; after = the now-final state.
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

          // RECONCILE_DRIFT FIX: `ledger.approve()` credits winner authors via
          // `reputation.ratify` but historically wrote NO corroboration event, so
          // `reconcileLedger` permanently flagged earned > explained drift. Record
          // the EXACT α-mass each winner author just earned — same discipline as
          // `#ratifyImpl`. Empty `corroboratingStrandIds`: human approval is not
          // agreement-funded (disown of the author still craters via `disownSweep`;
          // empty ids never intersect a tainted closure, so we do not falsely
          // reverse approval credit when an unrelated loser is disowned).
          const corrob = this.#ratification!.corroboration;
          if (corrob !== undefined) {
            for (const a of sortIds(winnerAuthors)) {
              const beforeAlpha = repBefore.get(a)?.alpha ?? 1;
              const afterAlpha = this.#reputation.stateOf(a)?.alpha ?? 1;
              const deltaAlpha = afterAlpha - beforeAlpha;
              if (deltaAlpha > 0) {
                corrob.record({
                  ratifiedStrandId: winnerStrandId,
                  corroboratingStrandIds: [],
                  beneficiarySourceId: a,
                  reputationDelta: deltaAlpha,
                  corroborationDepthAtEvent: 0,
                  at: when,
                });
              }
            }
          }
        }
        return plan;
      });
    } catch (err) {
      // RESYNC ON ROLLBACK (see the doc above `withTxn` call): the ledger's
      // in-memory open-pending index may have advanced past what the store's
      // rolled-back transaction actually committed. Re-derive it from the
      // durable table so `listPending()` never reports a phantom resolution.
      this.#ratification!.ledger.resyncIndex?.();
      throw err;
    }

    return resolved;
  }

  // -------------------------------------------------------------------------
  // disown — the full retroactive undo engine (wired to downstreamDisownSweep)
  // -------------------------------------------------------------------------

  disown(sourceId: SourceId, opts?: DisownOptions): DownstreamDisownResult {
    if (this.#reputation === null) {
      throw new ReputationNotWiredError(
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
    // own system source id. checkSurvivingSupport defaults ON at the engine seam (a disown
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
      ...(this.#ratification?.systemSource !== undefined
        ? { systemSource: this.#ratification.systemSource }
        : {}),
      ...(opts?.decisiveMargin !== undefined ? { decisiveMargin: opts.decisiveMargin } : {}),
      checkSurvivingSupport: opts?.checkSurvivingSupport ?? true,
      ...(opts?.minSurvivingSupport !== undefined
        ? { minSurvivingSupport: opts.minSurvivingSupport }
        : {}),
      // HARDENING 4 shares the ONE canonical independence notion (operator-fleet-aware
      // Bron-Kerbosch) with RC-5 and forgetting — so two roots behind one attacker fleet
      // collapse to a single surviving support instead of miscounting as two.
      independentRootCount: (rootSet): number =>
        this.#identity.independentRootCount(rootSet),
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

  // -------------------------------------------------------------------------
  // runForgetting — the eviction/tier-movement maintenance sweep (wires
  // forgetting/tiers.ts's evaluateEviction/nextTierDown; see the interface doc)
  // -------------------------------------------------------------------------

  /**
   * Resolve the {@link EvictionEvidence} bundle for one strand from the wired
   * identity layer — NEVER self-computed (CLAUDE.md invariant 2: "the web cannot
   * compute this about itself"). A strand with no resolvable provenance root
   * (`sourceId` null on every root) gets a `null` stamp, so
   * FRESH_INDEPENDENCE_STAMP fails closed. `independentSourceCount` is always the
   * identity layer's OWN count over the strand's OWN provenance (never
   * self-computed here). `outrankerState` follows `strand.outranked_by` to the
   * winning strand's CURRENT `fact_state`; a dangling edge or unresolvable winner
   * leaves it `null` (fail-closed, matching NOT_OUTRANKED_SIDE's allowlist).
   */
  #evictionEvidenceFor(strand: Strand): EvictionEvidence {
    let primarySourceId: SourceId | null = null;
    for (const root of strand.provenance) {
      if (root.sourceId !== null) {
        primarySourceId = root.sourceId;
        break;
      }
    }
    const stamp = primarySourceId !== null ? this.#identity.stampFor(primarySourceId) : null;
    const independentSourceCount = this.#identity.independentRootCount(strand.provenance);

    let outrankerState: FactState | null = null;
    if (strand.outranked_by !== null) {
      const edge = this.#store.getEdge(strand.outranked_by);
      const winner = edge !== null ? this.#store.getStrand(edge.from) : null;
      outrankerState = winner !== null ? winner.fact_state : null;
    }

    return { stamp, independentSourceCount, outrankerState };
  }

  /**
   * True iff a CONFIRMED CROSS_WEB_BRIDGE edge connects the SUBJECT strand (whose
   * out/in edges the caller already fetched ONCE) and `b` (either direction).
   * RE-AUDIT FIX (perf/test-quality lane, MEDIUM): this used to take the subject's
   * id and re-fetch `store.outEdges`/`store.inEdges` on EVERY call — but
   * `#forgettingNeighborsOf` calls this once per same-entity neighbor for the SAME
   * fixed subject strand, so the subject's own edges were re-fetched once per
   * neighbor (the exact redundant-refetch shape Wave-2 fixed for the activation
   * walk's `outEdgesCache`, reintroduced here). Callers now fetch the subject's
   * edges ONCE and pass them in; this method is a pure in-memory array scan.
   */
  #isBridgeBetween(outEdgesOfSubject: readonly Edge[], inEdgesOfSubject: readonly Edge[], b: StrandId): boolean {
    const isBridge = (e: Edge): boolean => e.edgeType === EdgeType.CROSS_WEB_BRIDGE;
    for (const e of outEdgesOfSubject) if (e.to === b && isBridge(e)) return true;
    for (const e of inEdgesOfSubject) if (e.from === b && isBridge(e)) return true;
    return false;
  }

  /**
   * The LOW_UNIQUE_VALUE gate's candidate neighbor pool for `strand`: every OTHER
   * strand sharing its `entity` — the SAME connectivity notion `writeFact`'s
   * SHARED_ENTITY attachment and the activation walk already use ("threads connect
   * only on shared entity"). A narrower candidate pool only ever RAISES the
   * strand's computed unique value (biasing toward KEEP — the gate's own
   * fail-closed direction), and the gate itself filters to
   * OBSERVED+LIVE+class-disjoint+has-provenance qualifiers, so non-qualifying
   * candidates here are simply inert.
   */
  #forgettingNeighborsOf(strand: Strand): EvictionNeighborView[] {
    const out: EvictionNeighborView[] = [];
    // Fetch the SUBJECT's own edges ONCE per strand (was once per same-entity
    // neighbor — see `#isBridgeBetween`'s doc above).
    const outEdgesOfSubject = this.#store.outEdges(strand.id);
    const inEdgesOfSubject = this.#store.inEdges(strand.id);
    for (const n of this.#store.strandsByEntity(strand.entity)) {
      if (n.id === strand.id) continue;
      out.push({
        id: n.id,
        fact_state: n.fact_state,
        origin: n.origin,
        provenance: n.provenance,
        description_value: n.description_value,
        bridgesToSubject: this.#isBridgeBetween(outEdgesOfSubject, inEdgesOfSubject, n.id),
      });
    }
    return out;
  }

  runForgetting(opts?: ForgettingOptions): ForgettingResult {
    const at = opts?.at ?? now();
    const cfg = opts?.cfg ?? DEFAULT_FORGETTING_CONFIG;

    // TARGET SET: every strand (the maintenance-tick default), or exactly the
    // caller-supplied ids — mirroring `disown()`'s `allStrands()` full-scan
    // (OFFLINE maintenance is exactly what that primitive is for).
    const targets: Strand[] =
      opts?.strandIds !== undefined
        ? opts.strandIds
            .map((id) => this.#store.getStrand(id))
            .filter((s): s is Strand => s !== null)
        : [...this.#store.allStrands()];

    const moved: ForgettingMove[] = [];
    const kept: ForgettingKept[] = [];

    // ATOMIC: every tier move in this sweep commits (or rolls back) as ONE unit
    // over the shared handle, the same discipline as `disown`/`adjudicate`/`approve`.
    withTxn(this.#store, () => {
      for (const strand of targets) {
        if (strand.tier === Tier.ARCHIVE) continue; // immortal fixed point: untouched

        const neighbors = this.#forgettingNeighborsOf(strand);
        const evidence = this.#evictionEvidenceFor(strand);
        const decision = evaluateEviction(strand, neighbors, evidence, at, cfg);

        if (!decision.allowed) {
          kept.push({
            strandId: strand.id,
            tier: strand.tier,
            failedGates: decision.failedGates,
          });
          continue;
        }

        // DEMOTE-NEVER-DELETE: a tier move is just `putStrand` with a lowered
        // `tier` (StrandStore.putStrand's own doc) — content_hash + provenance
        // (the archive stub) are untouched.
        const from = strand.tier;
        strand.tier = decision.toTier;
        strand.last_tier_reason = decision.reason;
        this.#store.putStrand(strand);
        moved.push({ strandId: strand.id, from, to: decision.toTier, reason: decision.reason });
      }
    });

    return { evaluated: targets.length, moved, kept };
  }

  // -------------------------------------------------------------------------
  // explain / beliefTimeline — READ-ONLY introspection (observe, never influence)
  // -------------------------------------------------------------------------

  /** The {@link AuditCoverage} of THIS engine's wiring (what a report could see). */
  #auditCoverage(): AuditCoverage {
    return {
      auditLedger: this.#ratification !== null,
      corroborationLedger: this.#ratification?.corroboration !== undefined,
      adjudicationProvenance: this.#ratification?.adjudicationProvenance !== undefined,
      reputationLedger: this.#reputation !== null,
    };
  }

  /**
   * The union of OPEN pending members (as id strings) — the ONE "contested" rule
   * both `explain` and the facade's recall label share. Reuses the ledger's own
   * open semantics (`listPending`), never a reimplementation. O(open pendings);
   * always computed fresh (a dispute can open/close between calls).
   */
  #openPendingMemberSet(): Set<string> {
    const out = new Set<string>();
    if (this.#ratification === null) return out;
    for (const p of this.#ratification.ledger.listPending()) {
      for (const m of p.members) out.add(String(m));
    }
    return out;
  }

  explain(strandId: StrandId): ExplainReport | null {
    const strand = this.#store.getStrand(strandId);
    if (strand === null) return null; // unknown strand: a query miss, not an error

    // --- roots (strand order, verbatim) + distinct sources (first appearance) --
    const roots: ExplainRoot[] = strand.provenance.map((r) => ({
      rootId: r.rootId,
      independenceClass: r.independenceClass,
      sourceId: r.sourceId,
      establishedAt: r.establishedAt,
      inherited: r.inheritedClass === true,
      // Strict `>`: a same-millisecond ratify is invisible (documented residual;
      // never guess). INFERRED evidence only — root-append ≠ state flip.
      appendedAfterWrite: (r.establishedAt as number) > (strand.observedAt as number),
    }));

    const seenSources = new Set<SourceId>();
    const sources: ExplainSource[] = [];
    for (const r of strand.provenance) {
      if (r.sourceId === null || seenSources.has(r.sourceId)) continue;
      seenSources.add(r.sourceId);
      sources.push({
        sourceId: r.sourceId,
        // Canonical, engine-owned stamp (OD-8) — never a caller-supplied one.
        stamp: this.#identity.stampFor(r.sourceId),
        // The engine has no trust-registry handle; the FACADE enriches this.
        registered: null,
      });
    }

    // --- the gates' OWN numbers (OD-6/OD-8): #R + a SORTED COPY of the shared
    // agreement basis. The shared helpers' return order is untouched.
    //
    // Wave-2 [ratify-double-agreement-scan]: computed ONCE and handed into `#R`
    // (the same redundant-double-scan pattern the audit named in `ratify`, found
    // here too — same target strand, same O(entity-strand-count) set, no reason
    // to derive it twice).
    const agreementSet = this.#deriveAgreementSet(strand);
    const independentRootCount = this.#R(strand, agreementSet);
    const agreementStrandIds = [...agreementSet].sort((a, b) =>
      compareStrings(String(a), String(b)),
    );

    // --- DERIVATION citations, both directions, sorted by edge id ------------
    const restsOn = this.#store
      .outEdges(strandId)
      .filter((e) => e.edgeType === EdgeType.DERIVATION)
      .sort(byEdgeId)
      .map((e) => e.to);
    const supports = this.#store
      .inEdges(strandId)
      .filter((e) => e.edgeType === EdgeType.DERIVATION)
      .sort(byEdgeId)
      .map((e) => e.from);

    // --- MUTATION receipts (Wave-2 [explain-full-ledger-scans]): POINT LOOKUPS
    // against the ledger's subject-indexed `mutationsForSubjects`, never a full
    // scan of `records()`. Splits strand-subject receipts from backing-source-
    // subject receipts (disjoint id namespaces in practice, but the strand-
    // subject query wins any coincidental collision — mirroring the original
    // if/else-if exclusivity exactly), and captures the FIRST DEMOTE receipt's
    // time (chain/seq order, same as the old scan) for the demotion explanation
    // below.
    const sourceIdStrings = new Set<string>([...seenSources].map(String));
    const strandIdString = String(strandId);
    const mutationReceipts: MutationPayload[] =
      this.#ratification?.ledger
        .mutationsForSubjects([strandIdString])
        .map((r) => r.payload as MutationPayload) ?? [];
    const sourceMutationReceipts: MutationPayload[] =
      this.#ratification?.ledger
        .mutationsForSubjects(sourceIdStrings)
        .filter((r) => (r.payload as MutationPayload).subjectId !== strandIdString)
        .map((r) => r.payload as MutationPayload) ?? [];
    let demoteReceiptAt: EpochMs | null = null;
    for (const p of mutationReceipts) {
      if (p.op === "DEMOTE") {
        demoteReceiptAt = p.at;
        break;
      }
    }

    // --- demotion explanation (resolved from outranked_by; time from receipt) --
    let demotion: ExplainDemotion | null = null;
    if (strand.outranked_by !== null) {
      const edge = this.#store.getEdge(strand.outranked_by);
      if (edge === null) {
        // A dangling outranks edge is REPORTED, never invented around.
        demotion = { kind: "EDGE_MISSING", outranksEdgeId: strand.outranked_by };
      } else {
        const at = demoteReceiptAt;
        const atFidelity: EvidenceFidelity = at !== null ? "RECEIPT" : "STRAND_FIELD";
        const from = String(edge.from);
        if (from.startsWith(DISOWN_SENTINEL_PREFIX)) {
          // NEVER getStrand the sentinel (it resolves null by design); the
          // disowned source id is the suffix, per disownSentinelFor's format.
          demotion = {
            kind: "DISOWN_SENTINEL",
            outranksEdgeId: edge.id,
            disownedSourceId: from.slice(DISOWN_SENTINEL_PREFIX.length) as SourceId,
            at,
            atFidelity,
          };
        } else {
          demotion = {
            kind: "OUTRANKED_BY_STRAND",
            outranksEdgeId: edge.id,
            winnerStrandId: edge.from,
            at,
            atFidelity,
          };
        }
      }
    }

    // --- disputes (Wave-2 [explain-full-ledger-scans]): OPEN via the ledger's
    // own open semantics; RESOLVED_BY_APPROVAL by correlating each APPROVAL to
    // its latest earlier PENDING (same csid); both emitted in CHAIN order — now
    // over `disputeRecordsForMember`'s POINT LOOKUP (every PENDING/APPROVAL for
    // any csid this strand was EVER a member of), never a full `records()` scan.
    // RESOLVED_BY_ADJUDICATION appended after, in provenance-ledger append order.
    const contested = this.#openPendingMemberSet().has(String(strandId));
    const disputes: ExplainDispute[] = [];
    if (this.#ratification !== null) {
      const openCsids = new Set<string>(
        this.#ratification.ledger.listPending().map((p) => String(p.contradictionSetId)),
      );
      const latestPendingByCsid = new Map<string, PendingPayload>();
      const openEmitted = new Set<string>();
      for (const rec of this.#ratification.ledger.disputeRecordsForMember(strandId)) {
        if (rec.kind === "PENDING") {
          const p = rec.payload as PendingPayload;
          const csid = String(p.contradictionSetId);
          latestPendingByCsid.set(csid, p);
          if (
            openCsids.has(csid) &&
            !openEmitted.has(csid) &&
            p.members.some((m) => m === strandId)
          ) {
            openEmitted.add(csid);
            disputes.push({
              status: "OPEN",
              contradictionSetId: p.contradictionSetId,
              reason: p.reason,
              createdAt: p.createdAt,
              members: [...p.members],
            });
          }
        } else if (rec.kind === "APPROVAL") {
          const a = rec.payload as ApprovalPayload;
          const matched = latestPendingByCsid.get(String(a.contradictionSetId));
          // Losers are NOT in the APPROVAL payload: membership comes from the
          // matched PENDING's members (T7's recovery rule).
          if (matched !== undefined && matched.members.some((m) => m === strandId)) {
            disputes.push({
              status: "RESOLVED_BY_APPROVAL",
              contradictionSetId: a.contradictionSetId,
              winner: a.winner,
              approverSourceId: a.approverSourceId,
              approvedAt: a.approvedAt,
              ownerOverride: a.ownerOverride === true,
            });
          }
        }
      }
    }
    const adjProvenance = this.#ratification?.adjudicationProvenance;
    if (adjProvenance !== undefined) {
      // Wave-2 [explain-full-ledger-scans]: POINT LOOKUP via the ledger's own
      // `contributingStrandIds` index, never a full `all()` scan. Sound because
      // `#recordAdjudicationProvenance` (the SOLE producer) always seeds
      // `contributingStrandIds` with `[winnerId, ...]` first (see its doc
      // comment) — so "winner === strandId" is STRUCTURALLY implied by
      // "contributingStrandIds includes strandId", never a separate case to
      // miss.
      for (const rec of adjProvenance.recordsContributedBy([strandId])) {
        disputes.push({
          status: "RESOLVED_BY_ADJUDICATION",
          contradictionSetId: rec.contradictionSetId,
          winner: rec.winner,
          margin: rec.margin,
          at: rec.at,
          reopened: adjProvenance.isReopened(rec.contradictionSetId),
        });
      }
    }

    // --- corroboration events naming this strand (either role), append order --
    // Wave-2 [explain-full-ledger-scans]: POINT LOOKUP via `eventsInvolving`
    // (the ratified + corroborator indexes), never a full `all()` scan.
    const corroborationEvents: ExplainCorroborationEvent[] = [];
    const corroboration = this.#ratification?.corroboration;
    if (corroboration !== undefined) {
      for (const ev of corroboration.eventsInvolving(strandId)) {
        const ratified = ev.ratifiedStrandId === strandId;
        corroborationEvents.push({
          eventId: ev.eventId,
          at: ev.at,
          beneficiarySourceId: ev.beneficiarySourceId,
          reputationDelta: ev.reputationDelta,
          role: ratified ? "RATIFIED" : "CORROBORATOR",
          reversed: corroboration.isReversed(ev.eventId),
        });
      }
    }

    return {
      strandId: strand.id,
      entity: strand.entity,
      attribute: strand.attribute,
      payload: strand.payload,
      contentHash: strand.content_hash,
      factState: strand.fact_state,
      origin: strand.origin,
      tier: strand.tier,
      observedAt: strand.observedAt,
      externalReobservationCount: strand.external_reobservation_count,
      roots,
      sources,
      independentRootCount,
      agreementStrandIds,
      restsOn,
      supports,
      demotion,
      contested,
      disputes,
      corroborationEvents,
      mutationReceipts,
      sourceMutationReceipts,
      coverage: this.#auditCoverage(),
    };
  }

  beliefTimeline(entity: EntityId, attribute: AttributeKey): BeliefTimeline {
    // Members: the attribute index is attribute-keyed only, so filter to the
    // entity here; sorted (observedAt, id) for a deterministic roster.
    const memberStrands = this.#store
      .strandsByAttribute(attribute)
      .filter((s) => s.entity === entity)
      .sort(
        (a, b) =>
          (a.observedAt as number) - (b.observedAt as number) ||
          compareStrings(String(a.id), String(b.id)),
      );
    const members = memberStrands.map((s) => s.id);
    const memberIdSet = new Set<string>(members.map(String));

    const dated: BeliefEvent[] = [];
    const undated: BeliefEvent[] = [];

    // OBSERVED per member (STRAND_FIELD; birth state recorded nowhere), plus
    // EXTERNAL_ROOT_APPENDED (INFERRED) per root established strictly after the
    // write — the same-ms residual is documented, never guessed at.
    for (const s of memberStrands) {
      dated.push({
        kind: "OBSERVED",
        strandId: s.id,
        at: s.observedAt,
        source: "STRAND_FIELD",
        birthState: "UNKNOWN",
      });
      for (const r of s.provenance) {
        if ((r.establishedAt as number) > (s.observedAt as number)) {
          dated.push({
            kind: "EXTERNAL_ROOT_APPENDED",
            strandId: s.id,
            at: r.establishedAt,
            source: "INFERRED",
            rootId: r.rootId,
            sourceId: r.sourceId,
          });
        }
      }
    }

    // Ledger-backed events (RECEIPT). Dispute records are admitted only when the
    // attribute matches AND the members intersect the filtered roster — the guard
    // against the per-attribute csid collision leaking another entity's dispute.
    const demoteReceipted = new Set<string>();
    if (this.#ratification !== null) {
      const latestPendingByCsid = new Map<string, PendingPayload>();
      for (const rec of this.#ratification.ledger.records()) {
        if (rec.kind === "PENDING") {
          const p = rec.payload as PendingPayload;
          latestPendingByCsid.set(String(p.contradictionSetId), p);
          if (p.attribute !== attribute) continue;
          if (!p.members.some((m) => memberIdSet.has(String(m)))) continue;
          if (p.reason === "REOPENED_BY_DISOWN") {
            // A disown re-open re-contests the RECORDED WINNER only (T9:
            // members are exactly [winner]; losers are DEMOTED, not members).
            dated.push({
              kind: "DISPUTE_REOPENED",
              contradictionSetId: p.contradictionSetId,
              at: p.createdAt,
              source: "RECEIPT",
              winner: p.members[0]!,
            });
          } else {
            dated.push({
              kind: "DISPUTE_OPENED",
              contradictionSetId: p.contradictionSetId,
              at: p.createdAt,
              source: "RECEIPT",
              members: [...p.members],
              reason: p.reason,
            });
          }
        } else if (rec.kind === "APPROVAL") {
          const a = rec.payload as ApprovalPayload;
          const matched = latestPendingByCsid.get(String(a.contradictionSetId));
          if (matched === undefined || matched.attribute !== attribute) continue;
          if (!matched.members.some((m) => memberIdSet.has(String(m)))) continue;
          dated.push({
            kind: "DISPUTE_RESOLVED",
            contradictionSetId: a.contradictionSetId,
            at: a.approvedAt,
            source: "RECEIPT",
            winner: a.winner,
            approverSourceId: a.approverSourceId,
            ownerOverride: a.ownerOverride === true,
          });
        } else {
          const p = rec.payload as MutationPayload;
          if (p.op !== "DEMOTE" || !memberIdSet.has(p.subjectId)) continue;
          demoteReceipted.add(p.subjectId);
          const ref = p.refEventId;
          dated.push({
            kind: "DEMOTED",
            strandId: asStrandId(p.subjectId),
            at: p.at,
            source: "RECEIPT",
            outranksEdgeId: ref === undefined ? null : asEdgeId(ref),
            by:
              ref === undefined
                ? "UNKNOWN"
                : ref.startsWith(DISOWN_OUTRANKS_EDGE_PREFIX)
                  ? "DISOWN"
                  : "STRAND",
          });
        }
      }
    }

    // Fallback UNDATED demotion per currently-DEMOTED member with no receipt —
    // receipt wins, never both. `at: null` (Edge carries no timestamp; the time
    // is unknowable) — the fabrication ban routes it to the honest gap bucket.
    for (const s of memberStrands) {
      if (s.fact_state !== FactState.DEMOTED) continue;
      if (demoteReceipted.has(String(s.id))) continue;
      let by: "STRAND" | "DISOWN" | "UNKNOWN" = "UNKNOWN";
      if (s.outranked_by !== null) {
        const edge = this.#store.getEdge(s.outranked_by);
        if (edge !== null) {
          by = String(edge.from).startsWith(DISOWN_SENTINEL_PREFIX) ? "DISOWN" : "STRAND";
        }
      }
      undated.push({
        kind: "DEMOTED",
        strandId: s.id,
        at: null,
        source: "STRAND_FIELD",
        outranksEdgeId: s.outranked_by,
        by,
      });
    }

    // CORROBORATION_CREDITED per event whose ratified strand is a member.
    const corroboration = this.#ratification?.corroboration;
    if (corroboration !== undefined) {
      for (const ev of corroboration.all()) {
        if (!memberIdSet.has(String(ev.ratifiedStrandId))) continue;
        dated.push({
          kind: "CORROBORATION_CREDITED",
          strandId: ev.ratifiedStrandId,
          at: ev.at,
          source: "RECEIPT",
          eventId: ev.eventId,
          beneficiarySourceId: ev.beneficiarySourceId,
          reversed: corroboration.isReversed(ev.eventId),
        });
      }
    }

    dated.sort(byBeliefEventOrder);

    return {
      entity,
      attribute,
      members,
      events: dated,
      undatedEvents: undated,
      currentBelief: memberStrands
        .filter((s) => s.fact_state === FactState.LIVE)
        .map((s) => s.id),
      coverage: this.#auditCoverage(),
    };
  }
}
