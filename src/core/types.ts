/**
 * core/types.ts — THE SHARED CONTRACT for Intelligent DB.
 *
 * This module is the single source of truth for the strand data model and all
 * cross-cutting types described in CLAUDE.md. Every other module imports from
 * here. It has NO runtime dependencies and must type-check standalone.
 *
 * Design grounding (see CLAUDE.md):
 *  - Memory is a "memory palace / spider-web": facts are LATENT and surface only
 *    via spreading activation along structural threads (edges). Nothing sits in a
 *    readable list.
 *  - "Web of webs": dense local webs are loosely bridged by rare CROSS_WEB_BRIDGE
 *    threads; a bridge crossing is what makes "something from last week" relevant.
 *  - Provenance is first-class on every strand. Corroboration requires INDEPENDENT
 *    provenance; two strands from the same root are an echo, not corroboration.
 *  - The two quantities the web cannot compute about itself —
 *    `provenance_independence` (a per-edge halting weight) and the independent
 *    root count used by forgetting — are READ FROM THE SOURCE-IDENTITY STAMP, not
 *    self-computed.
 *
 * Convention: branded id types prevent accidental mixing of id namespaces while
 * remaining plain strings at runtime (zero overhead).
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

/** Opaque string brand helper. `Brand<string, "Foo">` is assignable to `string`
 * one-way only through the `as` constructors, preventing id cross-wiring. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Stable identity of a single strand (node) in the web. */
export type StrandId = Brand<string, "StrandId">;
/** Stable identity of a directed edge (thread) between two strands. */
export type EdgeId = Brand<string, "EdgeId">;
/** Identity of a real-world entity a strand is "about" (shared-entity join key). */
export type EntityId = Brand<string, "EntityId">;
/** A (entity, attribute) pair key; co-equal claims are counted per this key. */
export type AttributeKey = Brand<string, "AttributeKey">;
/** Identity of a provenance root (a source lineage), assigned by the id layer. */
export type ProvenanceRootId = Brand<string, "ProvenanceRootId">;
/**
 * Offline-assigned INDEPENDENCE-CLASS id. Two roots in the same class are NOT
 * independent of each other. Ancestor sketches and convergence are computed over
 * these ids, never over raw root ids. (CLAUDE.md: "incremental ancestor-sketch
 * (MinHash/HLL over offline-assigned independence-class ids)".)
 */
export type IndependenceClassId = Brand<string, "IndependenceClassId">;
/**
 * Deterministic OPERATOR-CLASS id: the registrar / hosting ASN / KYC issuer /
 * email provider behind an anchor — the FLEET AXIS. Two anchors that share an
 * operator class are NOT independent on that axis even if their per-anchor
 * `classId`s (eTLD+1, normalized address) differ, so a flood of N anchors behind
 * one operator collapses toward ONE independent class, not N. (ARCHITECTURE.md
 * §1: "per-registrar/ASN/issuer fleet-size caps … so 10k cheap domains behind one
 * registrar collapse toward one class rather than 10k".)
 */
export type OperatorClassId = Brand<string, "OperatorClassId">;
/** Identity of a source as witnessed by the Source-Identity Layer (a deterministic
 * checksum id over the external issuer+subject pair that already authenticated it). */
export type SourceId = Brand<string, "SourceId">;
/** Identity of a contradiction set: the cluster of co-equal disagreeing claims. */
export type ContradictionSetId = Brand<string, "ContradictionSetId">;

/** Content-addressing hash of a strand's payload (used for the immortal archive stub). */
export type ContentHash = Brand<string, "ContentHash">;

/** Milliseconds since the Unix epoch. */
export type EpochMs = Brand<number, "EpochMs">;

/** Construct an {@link EpochMs} from a raw number (e.g. `Date.now()`). */
export const asEpochMs = (n: number): EpochMs => n as EpochMs;
/** Construct a {@link StrandId} from a raw string. */
export const asStrandId = (s: string): StrandId => s as StrandId;
/** Construct an {@link EdgeId} from a raw string. */
export const asEdgeId = (s: string): EdgeId => s as EdgeId;

// ---------------------------------------------------------------------------
// Bounded numeric aliases (documentation-only; not runtime-enforced)
// ---------------------------------------------------------------------------

/** A value in [0, 1]. Used for confidences, independence, recency, weights. */
export type Unit = number;
/** A non-negative activation energy carried during a traversal. */
export type Activation = number;

// ---------------------------------------------------------------------------
// Enums (the small, fully-implemented contract pieces)
// ---------------------------------------------------------------------------

/**
 * Fact lifecycle state (CLAUDE.md "Fact states"). Contradiction DEMOTES, never
 * deletes; a `DEMOTED` strand is retained as history. A `PROVISIONAL` strand is a
 * visible superposition held until ratified (e.g. "Berlin→Tokyo pending").
 */
export enum FactState {
  /** Current, believed, speakable (with provenance). */
  LIVE = "LIVE",
  /** Visible superposition held until ratified by an external source. */
  PROVISIONAL = "PROVISIONAL",
  /** Was true; kept as history after being outranked by a contradiction. */
  DEMOTED = "DEMOTED",
  /** Evicted past COLD into an archive stub; only the hash + roots remain hot. */
  COLD = "COLD",
}

/**
 * Storage / decay tier (CLAUDE.md "forgetting"). Forgetting is DOWNWARD MOVEMENT,
 * never deletion while a provenance edge points at the strand. ARCHIVE is the
 * immortal stub (content hash + independent roots + timestamps).
 */
export enum Tier {
  HOT = "HOT",
  WARM = "WARM",
  COLD = "COLD",
  ARCHIVE = "ARCHIVE",
}

/**
 * Structural class of an edge. CROSS_WEB_BRIDGE is the rare inter-web thread; its
 * crossings are budgeted separately and accrue earned-bridge value only when
 * ratified by >=2 independent roots.
 */
export enum EdgeType {
  /** Shared-entity join inside one dense local web. */
  SHARED_ENTITY = "SHARED_ENTITY",
  /** A confirmed relationship (the "link" the librarian asserted). */
  CONFIRMED_LINK = "CONFIRMED_LINK",
  /** Records that one strand outranks another (explains a demotion). */
  OUTRANKS = "OUTRANKS",
  /** Provenance/derivation edge (derived fact -> the strands it was computed from). */
  DERIVATION = "DERIVATION",
  /** Rare inter-web thread; the only way activation reaches a distant web. */
  CROSS_WEB_BRIDGE = "CROSS_WEB_BRIDGE",
}

/**
 * Why a fact exists. "Wall with a window": a DERIVED fact may be believed and
 * spoken (with derivation shown) but is never its own witness — it graduates to
 * OBSERVED only when an external source ratifies it.
 */
export enum FactOrigin {
  /** From outside the web: user / document / tool. Can serve as a witness. */
  OBSERVED = "OBSERVED",
  /** Computed by the web walking itself. Never its own witness. */
  DERIVED = "DERIVED",
}

/**
 * Anchor classes from CLAUDE.md's anchor-cost table, in ascending real-world
 * cost. Independence between two sources is set-disjointness over their anchor
 * sets, weighted by anchor cost; `rep_cap` ceilings a source rooted only in this
 * class. The concrete weight/rep_cap data lives in identity/anchors.
 */
export enum AnchorClass {
  /** Bare key: sameness only, no independence. Default for anonymous input. */
  BARE_KEY = "BARE_KEY",
  EMAIL_OAUTH = "EMAIL_OAUTH",
  PHONE_SIM = "PHONE_SIM",
  DOMAIN = "DOMAIN",
  HARDWARE_ATTESTATION = "HARDWARE_ATTESTATION",
  VERIFIED_HUMAN = "VERIFIED_HUMAN",
  ORGANIZATION = "ORGANIZATION",
  /** Posted bond; weight scales with stake size, composes with any other row.
   * RETIRED as a live pillar (attribution replaced stake); the row stays as
   * inert policy data — no producer mints it. */
  FINANCIAL_STAKE = "FINANCIAL_STAKE",
  /** Notarized real-world event; the "window" that ratifies derived -> observed. */
  EXTERNAL_AUTHORITY = "EXTERNAL_AUTHORITY",
  /** The deployment OWNER — the personal tier's ground truth (external-authority grade). */
  OWNER = "OWNER",
  /** A registry-configured authoritative system (Workday-for-HR etc.). */
  SYSTEM_OF_RECORD = "SYSTEM_OF_RECORD",
  /** An owner-admitted local file/document. */
  LOCAL_DOCUMENT = "LOCAL_DOCUMENT",
  /** Bare SSO tenant membership — deliberately email-grade: a fresh tenant is
   * near-free to mint (a five-minute self-service action), so this row must never
   * approach ORGANIZATION weight without a verified custom domain on the tenant. */
  SSO_TENANT_MEMBER = "SSO_TENANT_MEMBER",
  /** Fetched web content whose eTLD+1 has no track record ("some page said so"). */
  PUBLISHER_UNVERIFIED = "PUBLISHER_UNVERIFIED",
  /** A publisher with earned tenure — kept BELOW DOMAIN's ceiling deliberately. */
  PUBLISHER_TRACKED = "PUBLISHER_TRACKED",
}

/**
 * Reason stamped on every stop / tier-move (CLAUDE.md: halting "never a silent
 * stop"; tier moves carry a reason_code). Halting fails open: a truncated or
 * bridge-starved answer is surfaced WITH a stamp rather than hidden.
 */
export enum ReasonCode {
  /** Local saturation: new independent corroboration fell below epsilon. */
  CONVERGED = "CONVERGED",
  /** Frontier exhausted of novel independent corroboration before the cap. */
  NOVELTY_EXHAUSTED = "NOVELTY_EXHAUSTED",
  /** Bridge sweep ran and every lit bridge was crossed (or cleared). */
  BRIDGE_SWEEP_CLEAR = "BRIDGE_SWEEP_CLEAR",
  /** Bridge sub-budget ran out before all lit bridges were crossed. */
  BRIDGE_STARVED = "BRIDGE_STARVED",
  /** Hard backstop tripped: pop-cap or wall-clock. Answer is partial. */
  TRUNCATED = "TRUNCATED",
  /**
   * No seed strand resolved in the store: the cue never touched the web. Answer
   * is empty and DEGRADED, not clear — without this stamp an all-dangling-seeds
   * recall was indistinguishable from a genuinely healthy empty answer
   * (BRIDGE_SWEEP_CLEAR / popCount 0 / degraded false): a silent stop wearing a
   * success stamp. Distinct from an EMPTY cue (zero seeds supplied), which stays
   * the caller's legitimate no-op.
   */
  NO_SEEDS_RESOLVED = "NO_SEEDS_RESOLVED",
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * A provenance root attached to a strand. Confirmation = corroboration by
 * INDEPENDENT provenance, so each root carries its offline-assigned independence
 * class (two roots in the same class corroborate nothing) plus when it was first
 * established (used by recency and by the forgetting grace floor).
 */
export interface ProvenanceRoot {
  readonly rootId: ProvenanceRootId;
  /** Offline-assigned class; independence is judged across classes, not raw ids. */
  readonly independenceClass: IndependenceClassId;
  /** The witnessing source behind this root, if known to the layer. */
  readonly sourceId: SourceId | null;
  /** When this root was first established (witness time, not file time). */
  readonly establishedAt: EpochMs;
  /**
   * TRUE when this root's `independenceClass` was INHERITED from the fact's causal
   * origin (an AGENT_RELAY copy of an upstream witness's class, or a per-resource
   * TOOL_CALL/DOCUMENT class) rather than minted from the filing source's OWN
   * identity. The class then BELONGS to the upstream witness/resource, not to
   * `sourceId` — so a disown of `sourceId` must NOT taint it (tainting an
   * inherited class would let a fraudster who merely RELAYED an honest source
   * scar every honest source rooted in that class — a suppression vector).
   * Absent (the default) on every root whose class is the source's own — the
   * pre-relay-fix invariant `class == class:${sourceId}` made this implicit.
   */
  readonly inheritedClass?: true;
}

// ---------------------------------------------------------------------------
// Source-Identity stamp (the layer's output the web consumes)
// ---------------------------------------------------------------------------

/**
 * One entry of a source's anchor set: which class, and the cost actually realized
 * for THIS source (e.g. an aged domain or a large stake realizes more than the
 * class floor). `independenceWeight` is what this anchor contributes to the
 * independence score against a disjoint other source.
 */
export interface AnchorBinding {
  readonly anchorClass: AnchorClass;
  /** Realized mint-cost proxy in [0,1]; >= the class floor, may be raised by age/stake. */
  readonly realizedCost: Unit;
  /** Independence contribution in [0,1] for this binding (see anchor table). */
  readonly independenceWeight: Unit;
}

/**
 * The stamp emitted by the Source-Identity Layer for every incoming OBSERVED fact
 * (CLAUDE.md "Interface to the web"). The web reads `provenance_independence` and
 * the independent-root count FROM here instead of self-computing them.
 *
 * Field names mirror the design doc exactly:
 *   { source_id, anchor_set, anchor_cost, reputation, stake_posted }.
 */
export interface IdentityStamp {
  /** Proves sameness: same issuer+subject => same source => never corroboration. */
  readonly source_id: SourceId;
  /** The source's anchor bindings; independence is disjointness over these. */
  readonly anchor_set: readonly AnchorBinding[];
  /** Aggregate (sublinear) anchor cost for this source — the "price" of its identity. */
  readonly anchor_cost: Unit;
  /** Earned-slowly / lost-fast reputation in [0,1], ceilinged by the rep_caps of its anchors. */
  readonly reputation: Unit;
  /** Stake currently posted backing this source's assertions (burns on falsity). */
  readonly stake_posted: number;
}

// ---------------------------------------------------------------------------
// EmbedderPort (Phase-1 retrieval spec §1) — OPTIONAL, INJECTED, zero-dep core
// ---------------------------------------------------------------------------

/**
 * OPTIONAL, INJECTED batch text embedder. The library ships NO implementation of
 * this in the core (zero runtime deps preserved); reference implementations (an
 * Ollama HTTP embedder and the hashing-trick embedder) live in
 * `src/examples/embedders.ts`, never imported from the barrel.
 *
 * THE THESIS CONSTRAINT (non-negotiable, see docs/specs/PHASE1_RETRIEVAL_SPEC.md):
 * embeddings may only ever propose WHERE TO LOOK (seeding candidates for
 * `recall`). They must NEVER influence edge weights, `fact_state`, adjudication,
 * independence counting, reputation, eviction, or what the walk does after
 * seeding. An `EmbedderPort` is consumed EXCLUSIVELY by the seed-selection step
 * (`recall/cueResolver.ts`'s `createEmbeddingCueResolver`) and the vector sidecar
 * writer (`api.ts`'s `writeFactWithEmbedding`) — nowhere else.
 *
 * `createIntelligentDb(..., retrieval?: { embedder, vectors })` — absent (the
 * default) means behavior is bit-for-bit today's; the engine never calls this
 * port unless a caller wires it.
 */
export interface EmbedderPort {
  /** Batch-embed. Deterministic for identical inputs within a session. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Fixed output dimensionality of every vector this embedder produces. */
  readonly dim: number;
  /** Identifies the model so stored vectors are never mixed across models. */
  readonly modelId: string;
}

// ---------------------------------------------------------------------------
// Edges (threads)
// ---------------------------------------------------------------------------

/**
 * A directed thread between two strands. The halting weight is
 *   w = link_confidence * provenance_independence * recency
 * and `out_weight_sum` is Σ w over the source strand's out-edges; the walk uses
 * `w / out_weight_sum` for share-normalization so high-degree hubs self-starve.
 *
 * `provenance_independence` is NOT self-computed — it is read from the identity
 * stamp of the source(s) behind this thread.
 */
export interface Edge {
  readonly id: EdgeId;
  readonly from: StrandId;
  readonly to: StrandId;
  readonly edgeType: EdgeType;

  /** Librarian's confidence in the relationship, [0,1]. */
  readonly link_confidence: Unit;
  /** Independence of the provenance behind this thread, READ FROM the id stamp, [0,1]. */
  readonly provenance_independence: Unit;
  /** Temporal discount, [0,1] — fresher threads weigh more. */
  readonly recency: Unit;

  /** Cached w = link_confidence * provenance_independence * recency. */
  readonly w: Unit;
  /** Cached Σ w over the *source* strand's out-edges (share-normalization denominator). */
  readonly out_weight_sum: Unit;
}

/** Compute the raw halting weight w for an edge's three factors. Pure, total. */
export function computeEdgeWeight(
  link_confidence: Unit,
  provenance_independence: Unit,
  recency: Unit,
): Unit {
  return link_confidence * provenance_independence * recency;
}

// ---------------------------------------------------------------------------
// Bridge accounting (CROSS_WEB_BRIDGE only)
// ---------------------------------------------------------------------------

/**
 * Per-strand bridge accounting. `earned_bridge_value` and `far_side_potential`
 * accrue ONLY from crossings ratified by >=2 independent roots and are recomputed
 * OFFLINE — the query stream must never write them (CLAUDE.md). They protect an
 * earned bridge from eviction.
 */
export interface BridgeAccounting {
  /** Accrued value of this bridge from ratified crossings (offline-written only). */
  readonly earned_bridge_value: number;
  /** Estimated yield of crossing into the far web (offline-written only). */
  readonly far_side_potential: number;
}

// ---------------------------------------------------------------------------
// Salience / decay
// ---------------------------------------------------------------------------

/**
 * Decay state of a strand. `s` is salience; `λ` (lambda) the decay rate;
 * `fire_count` counts REAL retrievals (not speculative pops). Decay sets eviction
 * PRESSURE; the actual permission to evict is a separate gate (forgetting/tiers).
 */
export interface Salience {
  /** Current salience s. */
  readonly s: number;
  /** Last time this strand actually fired (was retrieved). */
  readonly last_fire_time: EpochMs;
  /** Decay rate λ. */
  readonly lambda: number;
  /** Count of real retrievals. */
  readonly fire_count: number;
}

// ---------------------------------------------------------------------------
// Per-traversal mutable register
// ---------------------------------------------------------------------------

/**
 * Per-traversal activation register (CLAUDE.md strand model). Reset / scoped to a
 * single traversal. `refractoryUntil` implements the refractory lock that kills
 * A->B->A echo within one walk.
 */
export interface ActivationRegister {
  /** Energy currently held by this strand in the active traversal. */
  activation: Activation;
  /** Until this (logical) time the strand will not re-fire — kills echo. */
  refractoryUntil: EpochMs;
  /** Count of distinct independent-provenance ancestors — ORDERING ONLY, never a stop gate. */
  convergence_factor: number;
}

// ---------------------------------------------------------------------------
// The Strand (node)
// ---------------------------------------------------------------------------

/**
 * A strand: one latent memory node. Carries at least every field the council
 * converged on in CLAUDE.md "Strand data model". Edges are stored separately (in
 * the StrandStore) and referenced by `outEdges` / `inEdges`; this keeps the node
 * payload independent of edge churn.
 */
export interface Strand {
  readonly id: StrandId;

  /** The real-world entity this strand is about (mechanical shared-entity join key). */
  readonly entity: EntityId;
  /** The (entity, attribute) this strand makes a claim about, if applicable. */
  readonly attribute: AttributeKey | null;
  /** Opaque human/agent-readable payload of the claim. */
  readonly payload: unknown;

  /** Content hash for the immortal archive stub + cold-store backpointer. */
  readonly content_hash: ContentHash;

  /** Observed vs derived ("wall with a window"). */
  readonly origin: FactOrigin;
  /** Lifecycle state; contradiction demotes, never deletes. */
  fact_state: FactState;
  /** Storage / decay tier; forgetting only ever moves this downward. */
  tier: Tier;

  /** Provenance root-set with per-root independence class + establishment time. */
  readonly provenance: readonly ProvenanceRoot[];

  /** Out-edge ids (threads leaving this strand). */
  readonly outEdges: readonly EdgeId[];
  /** In-edge ids (threads entering this strand). */
  readonly inEdges: readonly EdgeId[];

  /** The single OUTRANKS edge that explains a demotion, when DEMOTED. */
  outranked_by: EdgeId | null;

  /** Bridge accounting (meaningful when this strand owns CROSS_WEB_BRIDGE edges). */
  bridge: BridgeAccounting;

  /** Salience / decay state. */
  salience: Salience;

  /**
   * `description_value`: reconstruction-loss bits vs independent neighbors,
   * echo-discounted. CONSOLIDATION-ELIGIBILITY GATE ONLY — not an activation input.
   */
  description_value: number;

  /** Observation age floor: a freshly observed strand is grace-protected until here. */
  readonly observedAt: EpochMs;
  /** Count of independent external re-observations (raises keep-pressure). */
  external_reobservation_count: number;

  /** Contradiction-set membership, if this strand is a co-equal disputed claim. */
  contradiction_set: ContradictionSetId | null;
  /** Per-(entity,attribute) count of co-equal claims (contradiction-bomb signal). */
  co_equal_claim_cardinality: number;

  /** Reason stamped by the last tier-move affecting this strand, if any. */
  last_tier_reason: ReasonCode | null;

  /** Per-traversal register; null when no traversal currently touches it. */
  register: ActivationRegister | null;
}

// ---------------------------------------------------------------------------
// Cross-module shared result/option shapes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Undo-engine hardening records (ARCHITECTURE.md §4 "Undo-engine hardening")
// ---------------------------------------------------------------------------

/**
 * A WEAK-INFLUENCE edge: a "consulted-but-not-cited" read. `strandId` is the
 * influenced work (the strand a human/model produced after being swayed by what it
 * READ); `consultedStrandId` is the strand it consulted but did NOT formally cite via
 * a DERIVATION edge. This records LAUNDERED influence — a dependency the DERIVATION
 * graph alone cannot see — so a disown of `consultedStrandId`'s source can flag the
 * influenced work for HUMAN REVIEW (never auto-demote: we don't know it actually
 * depended on the tainted strand). See {@link ReviewQueueEntry}.
 */
export interface WeakInfluenceEdge {
  /** The influenced work (the strand produced after consulting another). */
  readonly strandId: StrandId;
  /** The strand that was consulted-but-not-cited (no DERIVATION edge). */
  readonly consultedStrandId: StrandId;
  /** Free-form context the recorder attached (why/where the consult happened). */
  readonly context: string;
  /** Witness time the consultation was recorded. */
  readonly at: EpochMs;
}

/**
 * A REVIEW-QUEUE entry emitted by a disown sweep when a strand that was merely
 * CONSULTED (via a {@link WeakInfluenceEdge}, not derived-from) had its source
 * disowned. This is NOT an auto-demotion — uncited influence is unprovable from the
 * graph, so the influenced work is flagged for a human to decide, closing the
 * laundered-influence channel WITHOUT over-tainting.
 */
export interface ReviewQueueEntry {
  /** The influenced work flagged for human review. */
  readonly strandId: StrandId;
  /** Always `WEAK_INFLUENCE_REVIEW` — the only reason today; the union may grow. */
  readonly reason: "WEAK_INFLUENCE_REVIEW";
  /** The disowned source whose consulted strand triggered the review. */
  readonly disownedSource: SourceId;
  /** Witness time the review was queued. */
  readonly at: EpochMs;
}

/**
 * An ADJUDICATION-PROVENANCE record: written when an adjudication RESOLVES a dispute
 * (single-class, or decisive multi-class). It captures the MARGIN that cleared the
 * decision and the exact strands that supplied that margin, so a later disown can
 * recompute the margin with the tainted strands removed and — if the margin drops
 * below the decisive threshold — RE-OPEN the dispute for a human (a tainted strand
 * that merely TIPPED an adjudication becomes reversible). See ARCHITECTURE.md §4(c).
 */
export interface AdjudicationProvenance {
  /** The contradiction set this adjudication resolved. */
  readonly contradictionSetId: ContradictionSetId;
  /**
   * The (entity, attribute) the dispute was about — carried so a disown can
   * reconstruct a valid {@link "../forgetting/consolidation".PendingRatification}
   * when it RE-OPENS the dispute.
   */
  readonly attribute: AttributeKey;
  /** The winning strand of the resolved dispute. */
  readonly winner: StrandId;
  /** The LCB gap (winner reputation minus runner-up) that cleared the decision. */
  readonly margin: number;
  /**
   * The strands/sources that gave the winner its margin — the winner strand plus the
   * support whose removal would lower the recomputed margin. Intersecting this set
   * with a disown's tainted set is how the sweep knows to recompute and maybe re-open.
   */
  readonly contributingStrandIds: readonly StrandId[];
  /** Witness time the adjudication was recorded. */
  readonly at: EpochMs;
}

/** A lit strand plus the activation it ended the walk with (assembled into answers). */
export interface LitStrand {
  readonly strandId: StrandId;
  readonly activation: Activation;
}

/** Stamp explaining how/why a traversal stopped (never a silent stop). */
export interface HaltStamp {
  readonly reason: ReasonCode;
  /** Total strands popped before halting. */
  readonly popCount: number;
  /** Bridges crossed during the mandatory sweep. */
  readonly bridgesCrossed: number;
  /**
   * B1 — count of bridge crossings whose seed energy was down-weighted (factor
   * < 1) by a resolved-but-weak origin independence stamp (0 < indep < 1).
   * Bare-key bridges (indep == 0) stay at γ by design and are NOT counted.
   */
  readonly bridgeSeedsDownweighted: number;
  /** True when the result is partial (TRUNCATED or BRIDGE_STARVED). */
  readonly degraded: boolean;
}

/** Tunable walk constants. Defaults mirror CLAUDE.md (γ≈0.6, cap≈2000, ~20% bridge budget). */
export interface WalkConfig {
  /** Decay per hop γ (~0.6). */
  readonly gamma: number;
  /** Local-saturation epsilon: below this new independent corroboration, phase 1 stops. */
  readonly epsilon: number;
  /** Absolute pop cap backstop (~2000). */
  readonly popCap: number;
  /** Wall-clock backstop in ms. */
  readonly wallClockMs: number;
  /** Fraction of budget reserved for the bridge sweep (~0.20). */
  readonly bridgeBudgetFraction: number;
  /** Consecutive zero-yield crossings that trip the bridge circuit-breaker (2). */
  readonly bridgeZeroYieldBreaker: number;

  // -- Phase-1 retrieval spec §3: embedder seed-union knobs (OPTIONAL) ------
  /**
   * Cosine top-K candidates pulled from the vector sidecar when seeding a recall
   * with an {@link EmbedderPort} configured (`createEmbeddingCueResolver`).
   * Consulted ONLY by that seam; the core walk never reads this. Default 16
   * when omitted.
   */
  readonly embedSeedK?: number;
  /**
   * Hard ceiling on an embedding-PROPOSED seed's energy, in ADDITION to the
   * mandatory dynamic clamp ("similarity may never outrank an exact lexical/
   * entity hit" — see `createEmbeddingCueResolver`). Default 1 (no extra
   * ceiling beyond the dynamic per-cue clamp) when omitted.
   */
  readonly embedSeedEnergyCap?: number;

  // -- Phase-1 retrieval spec §4a: reinforcement mode (FLAGGED) -------------
  /**
   * Reinforcement mode for the activation walk. `"dominance"` (the default when
   * omitted) is TODAY's best-first-dominance body, byte-for-byte unchanged: a
   * strand fires once at the max single-path energy any path delivers.
   * `"summation"` sums ALL incoming path deliveries per strand (including
   * deliveries that arrive after the strand has already fired/expanded),
   * clamped to `summationCap` × that strand's max single-path delivery — this
   * preserves the monotone-non-increasing termination bound (a cycle cannot
   * amplify energy without limit) while letting genuinely convergent evidence
   * (many independent paths agreeing) reinforce a strand's reported activation.
   * Firing (which strand expands its out-edges, and when) is UNCHANGED between
   * modes; only the REPORTED activation of a lit strand differs.
   *
   * NOT FROZEN TO "summation" globally (spec §6 measurement, 2026-07-06):
   * the real-LoCoMo `EmbedSeeded` sweep (see `DEFAULT_EMBED_SEED_K`'s doc)
   * selected `summation` as the dev-optimal reinforcement mode for THAT arm,
   * but the margin over `dominance` was razor-thin (recall@10 +0.002,
   * nDCG@10 +0.001, recall@20/MRR tied) — within measurement noise, not a
   * clear win. Flipping this DEFAULT was tried and reverted: it broke
   * `reinforcementSummation.test.ts`'s own regression pins that assert
   * `DEFAULT_WALK_CONFIG` produces dominance-shaped activation numbers (the
   * feature's OWN landing invariant, "default 'dominance' — no silent
   * behavior change"). A global flip is out of proportion to a same-dataset,
   * near-noise signal on ONE bench arm, so the conservative reading wins:
   * the default stays `"dominance"`; a caller wanting the (theoretically
   * marginally better, on this one dataset) summation behavior opts in
   * per-call via this field, exactly as today.
   */
  readonly reinforcement?: "dominance" | "summation";
  /**
   * Per-strand summation clamp multiplier — only consulted when
   * `reinforcement === "summation"`. Default 2.0 when omitted.
   */
  readonly summationCap?: number;

  // -- Phase-1 retrieval spec §4b: graded novelty (FLAGGED) -----------------
  /**
   * Novelty signal shape fed into the halting EWMA. `"binary"` (the default
   * when omitted) is TODAY's 0/1 signal (`noveltyOf`'s "did this pop contribute
   * at least one previously-unseen independence class" test), unchanged.
   * `"graded"` replaces it with the saturating curve
   * `novelty = 1 - exp(-newIndependentRoots / noveltyTau)`, so 2 new
   * independent roots register more novelty than 1 without ever reaching a
   * hard ceiling. Affects ONLY the halting EWMA input — ordering (convergence
   * is unchanged), the stop CONTRACT, and the ReasonCode mapping are unchanged.
   */
  readonly noveltyMode?: "binary" | "graded";
  /**
   * Tau knob for graded novelty — only consulted when `noveltyMode ===
   * "graded"`. Default 1.0 when omitted.
   */
  readonly noveltyTau?: number;
}

/** Default walk configuration grounded in CLAUDE.md's resolved halting design. */
export const DEFAULT_WALK_CONFIG: WalkConfig = {
  gamma: 0.6,
  epsilon: 0.02,
  popCap: 2000,
  wallClockMs: 2000,
  bridgeBudgetFraction: 0.2,
  bridgeZeroYieldBreaker: 2,
};
