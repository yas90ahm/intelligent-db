/**
 * index.ts — THE PUBLIC BARREL for Intelligent DB.
 *
 * This is the single entry point the outside world imports. It re-exports the
 * stable public surface of every layer the design (CLAUDE.md) settled on:
 *
 *   - core         the shared strand/edge/identity CONTRACT (types + enums).
 *   - store        the pluggable {@link StrandStore} and its in-memory backend.
 *   - traversal    the share-normalized activation walk + two-phase halting.
 *   - forgetting   downward tier movement, decay pressure, echo collapse.
 *   - identity     the external "passport control" Source-Identity Layer.
 *   - api          the three-verb engine (writeFact / recall / ratify).
 *
 * Import discipline (STACK NOTE): ESM + NodeNext means relative specifiers carry
 * the `.js` extension; `verbatimModuleSyntax` means every TYPE-only re-export MUST
 * use `export type`. Re-exports are EXPLICIT (not blanket `export *`) so that the
 * two distinct `NeighborView` shapes — the store's edge+strand view and the
 * forgetting gate's neighbor projection — never collide; the forgetting one is
 * re-exported under the alias {@link ForgettingNeighborView}.
 *
 * Status: production-grade single-process prototype. The hard algorithmic cores (the
 * activation-walk body, the two-phase halting gates, the tier-eviction permission
 * gates, contradiction adjudication, the disown sweep) are all IMPLEMENTED and
 * re-exported here, alongside the crypto-free trust registry, the tamper-evident
 * checksum audit chain, Beta(α,β) trust with decay-on-read, the undo-engine
 * hardening, and the durable SQLite backends. The engine's `disown` verb wires the
 * full retroactive undo sweep. See CLAUDE.md for the design and the residual gaps.
 */

// ===========================================================================
// core — the shared contract (types + enums + pure helpers + defaults)
// ===========================================================================

export {
  // enums (runtime values)
  FactState,
  Tier,
  EdgeType,
  FactOrigin,
  AnchorClass,
  ReasonCode,
  // pure helpers / constructors (runtime values)
  asEpochMs,
  asStrandId,
  asEdgeId,
  computeEdgeWeight,
  // defaults (runtime values)
  DEFAULT_WALK_CONFIG,
} from "./core/types.js";

// Canonical (key-order-independent) JSON — the content_hash serialization.
export { canonicalJson } from "./core/canonicalJson.js";

export type {
  // branded ids
  Brand,
  StrandId,
  EdgeId,
  EntityId,
  AttributeKey,
  ProvenanceRootId,
  IndependenceClassId,
  OperatorClassId,
  SourceId,
  ContradictionSetId,
  ContentHash,
  EpochMs,
  // numeric aliases
  Unit,
  Activation,
  // provenance + identity
  ProvenanceRoot,
  AnchorBinding,
  IdentityStamp,
  // graph model
  Edge,
  BridgeAccounting,
  Salience,
  Strand,
  // undo-engine hardening records
  WeakInfluenceEdge,
  ReviewQueueEntry,
  AdjudicationProvenance,
  // shared result/option shapes
  LitStrand,
  HaltStamp,
  WalkConfig,
  // Phase-1 retrieval spec §1 — the optional, injected embedder port
  EmbedderPort,
} from "./core/types.js";

// ===========================================================================
// store — the pluggable storage contract + the default in-memory backend
// ===========================================================================

export { MemoryStrandStore, createMemoryStore } from "./store/memoryStore.js";

export { createSqliteStore } from "./store/sqliteStore.js";

export type { SqliteStrandStore } from "./store/sqliteStore.js";

export type {
  StrandStore,
  NeighborView,
  EdgeQuery,
  StoreTxn,
} from "./store/StrandStore.js";

// Schema migration ladder (docs/specs/PHASE2_DURABILITY_SPEC.md §1): `PRAGMA
// user_version` as the schema version, an ordered ladder, refuse-to-open on a
// newer-than-known version.
export {
  runMigrations,
  readUserVersion,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  UnknownFutureSchemaError,
} from "./store/migrations.js";

export type { Migration } from "./store/migrations.js";

// Online snapshot + WAL archiving + point-in-time restore
// (docs/specs/PHASE2_DURABILITY_SPEC.md §2).
export {
  snapshotDb,
  readSnapshotManifest,
  manifestPathFor,
  createWalArchiver,
  restoreToTimestamp,
} from "./store/backup.js";

export type {
  ChainHeadLike,
  SnapshotManifest,
  WalArchiveOptions,
  WalArchiver,
  ArchivedSegmentMeta,
  ArchiveBaseMeta,
  ChainVerifier,
  RestoreOptions,
  RestoreResult,
} from "./store/backup.js";

// Value-level AES-256-GCM encryption-at-rest adapter (docs/specs/PHASE2_DURABILITY_SPEC.md §3).
export { createEncryptedStore, EncryptedStoreIntegrityError } from "./store/encryptedStore.js";

export type {
  KeyProvider,
  EncryptedStoreErrorReason,
} from "./store/encryptedStore.js";

// The vector sidecar (Phase-1 retrieval spec §2) — pure storage, never belief.
export {
  createMemoryVectorSidecar,
  createSqliteVectorSidecar,
  cosineSimilarity,
} from "./store/vectorSidecar.js";

export type {
  VectorSidecar,
  SqliteVectorSidecar,
  StoredVector,
  VectorMatch,
} from "./store/vectorSidecar.js";

// ===========================================================================
// traversal — spreading-activation walk + two-phase halting controller
// ===========================================================================

export {
  MaxPriorityQueue,
  frontierComparator,
  activationWalk,
} from "./traversal/walk.js";

export type {
  Comparator,
  WalkSeed,
  WalkResult,
  FrontierCandidate,
} from "./traversal/walk.js";

export { createHaltingController } from "./traversal/halting.js";

export type {
  HaltingController,
  HaltStoreView,
  HaltContext,
  BridgeCrossing,
  CrossingYield,
} from "./traversal/halting.js";

// ===========================================================================
// forgetting — tier movement, decay pressure, eviction gates, consolidation
// ===========================================================================

export {
  nextTierDown,
  decayPressure,
  evaluateEviction,
  isPastGraceFloor,
  EvictionGate,
  ALL_EVICTION_GATES,
  DEFAULT_FORGETTING_CONFIG,
} from "./forgetting/tiers.js";

export type {
  // aliased to avoid collision with the store's NeighborView
  NeighborView as ForgettingNeighborView,
  EvictionDecision,
  EvictionEvidence,
  ForgettingConfig,
} from "./forgetting/tiers.js";

export {
  collapseSameRootEchoes,
  buildContradictionSet,
  demote,
  promote,
  tryConsolidate,
  DEFAULT_ADJUDICATION_POLICY,
} from "./forgetting/consolidation.js";

export type {
  ContradictionSet,
  DemotionResult,
  PromotionResult,
  ConsolidationOutcome,
  PendingRatification,
  PendingRatificationReason,
  AdjudicationPolicy,
  HighImpactContext,
} from "./forgetting/consolidation.js";

// ===========================================================================
// identity — the external Source-Identity Layer (crypto-free trust registry)
// ===========================================================================

export {
  createSourceIdentityLayer,
  MAX_EXACT_ROOTS,
  ZERO_STAKE_PORT,
} from "./identity/index.js";

export type {
  SourceIdentityLayer,
  SourceIdentityLayerDeps,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
} from "./identity/index.js";

// --- plain source identity (sameness) + the crypto-free trust registry ---

export { sourceIdFor } from "./identity/sources.js";

export type { SourceRef, SourceKind } from "./identity/sources.js";

export { createTrustRegistry } from "./identity/trustRegistry.js";

export type {
  TrustRegistry,
  TrustRegistryConfig,
  SsoMemberInput,
  SystemOfRecordInput,
} from "./identity/trustRegistry.js";

export {
  ANCHOR_TABLE,
  STAKE_INDEPENDENCE_MIN,
  STAKE_INDEPENDENCE_MAX,
  STAKE_SATURATION_DEPOSIT,
  stakeIndependenceWeight,
  repCapFor,
  independenceBetween,
  combineSublinear,
  applySelfStackCap,
  aggregateAnchorCost,
} from "./identity/anchors.js";

export type { AnchorSpec } from "./identity/anchors.js";

// --- the eTLD+1 (public-suffix) resolver: the publisher/domain class axis ---

export {
  registrableDomain as pslRegistrableDomain,
  publicSuffixOf as pslPublicSuffixOf,
  pslResolver,
} from "./identity/binders/publicSuffix.js";

export type { ETldResolver } from "./identity/binders/publicSuffix.js";

export {
  DEFAULT_REPUTATION_PARAMS,
  newReputationState,
  decay,
  lcbReadout,
  floorMass,
  scarCapReduction,
  applyRatification,
  applyContradiction,
  applyCreditReversal,
  createReputationLedger,
  createSqliteReputationLedger,
  disownSweep,
} from "./identity/reputation.js";

export type {
  ReputationParams,
  ReputationState,
  ReputationLedger,
  SqliteReputationLedger,
  DisownSweepResult,
} from "./identity/reputation.js";

// STAKING IS RETIRED (attribution replaces stake: facts are permanently
// attributed to named sources — that IS the deterrent). The FINANCIAL_STAKE
// row above stays as INERT anchor-table data only; there is no stake ledger,
// no producer, and no public staking surface. `StakeLedgerPort` +
// `ZERO_STAKE_PORT` (exported from identity/index.js above) survive purely so
// the stamp's `stake_posted: 0` shape stays stable.

// ===========================================================================
// ratification — the VAULT (append-only checksum chain) + DOORBELL (approve flow)
// ===========================================================================

export {
  createPendingLedger,
  createSqlitePendingLedger,
  recordPreimage,
  EMPTY_STATE_HASH,
} from "./ratification/pendingLedger.js";

export type {
  PendingLedger,
  SqlitePendingLedger,
  LedgerRecord,
  LedgerRecordKind,
  PendingPayload,
  ApprovalPayload,
  MutationPayload,
  MutationOp,
  ChainVerification,
  ChainHead,
  AppendSink,
  ResolvedDispute,
  ApproveContext,
  AppendPendingOptions,
} from "./ratification/pendingLedger.js";

export {
  hashStrandState,
  hashReputationState,
  hashSubjectId,
  mutationReceipt,
} from "./ratification/mutationReceipt.js";

// --- PHASE 4: the ENTERPRISE dispute-routing adapter (pure decision layer) ---

export { createDisputeRouter } from "./ratification/disputeRouting.js";

export type {
  DisputeRouter,
  DisputeRoutingConfig,
  DisputeRoute,
  DisputeRouteMatch,
  DisputeRouteOptions,
  RoutedDispute,
  PendingSource,
} from "./ratification/disputeRouting.js";

export {
  downstreamDisownSweep,
  defaultSurvivingMargin,
  CORROBORATION_CREDIT_SUBSTRATE_SPEC,
  DEFAULT_DECISIVE_MARGIN,
} from "./ratification/disown.js";

export type {
  DownstreamDisownResult,
  DisownHardeningDeps,
} from "./ratification/disown.js";

export {
  createCorroborationLedger,
  createSqliteCorroborationLedger,
} from "./ratification/corroboration.js";

export type {
  CorroborationLedger,
  SqliteCorroborationLedger,
  CorroborationEvent,
  CorroborationEventInput,
} from "./ratification/corroboration.js";

// --- undo-engine hardening (roadmap item 4): the three new ledgers + audit ---

export { createWeakInfluenceLedger, createSqliteWeakInfluenceLedger } from "./ratification/weakInfluence.js";

export type {
  WeakInfluenceLedger,
  SqliteWeakInfluenceLedger,
  WeakInfluenceEdgeInput,
} from "./ratification/weakInfluence.js";

export {
  createAdjudicationProvenanceLedger,
  createSqliteAdjudicationProvenanceLedger,
} from "./ratification/adjudicationProvenance.js";

export type {
  AdjudicationProvenanceLedger,
  SqliteAdjudicationProvenanceLedger,
  AdjudicationProvenanceInput,
} from "./ratification/adjudicationProvenance.js";

export {
  reconcileLedger,
  assertRatifyEmitsEvent,
  OffLedgerReputationError,
  DEFAULT_RECONCILE_TOLERANCE,
} from "./ratification/reconcile.js";

export type {
  ReconciliationReport,
  SourceReconciliation,
  AlphaSnapshot,
} from "./ratification/reconcile.js";

// ===========================================================================
// api — the top-level three-verb engine
// ===========================================================================

export {
  createIntelligentDb,
  DEFAULT_QUARANTINE_THRESHOLD,
  InvalidQuarantineThresholdError,
  RatificationNotWiredError,
  ReputationNotWiredError,
  UnknownStrandError,
} from "./api.js";

export type {
  IntelligentDb,
  ConsolidationPort,
  CreateIntelligentDbOptions,
  RatificationDeps,
  RetrievalDeps,
  AdjudicateOptions,
  ApproveOptions,
  DisownOptions,
  ForgettingOptions,
  ForgettingMove,
  ForgettingKept,
  ForgettingResult,
  IngestPolicy,
  CausalOrigin,
  WriteFactInput,
  RecallCue,
  RecallResult,
  RatifyInput,
  // explain / beliefTimeline — the read-only belief dossier + time-travel shapes
  EvidenceFidelity,
  AuditCoverage,
  ExplainRoot,
  ExplainSource,
  ExplainDemotion,
  ExplainDispute,
  ExplainCorroborationEvent,
  ExplainReport,
  BeliefEvent,
  BeliefTimeline,
} from "./api.js";

// ===========================================================================
// recall — the CUE RESOLVER (the cue→seed entry point) + its pluggable seam
// ===========================================================================

export {
  createLexicalCueResolver,
  tokenize,
  strandText,
  DEFAULT_STOPWORDS,
  DEFAULT_TOP_K,
  DEFAULT_ENERGY_FLOOR,
  // Phase-1 retrieval spec §3 — the embedder-seeded UNION resolver
  createEmbeddingCueResolver,
  DEFAULT_EMBED_SEED_K,
  DEFAULT_EMBED_SEED_ENERGY_CAP,
} from "./recall/cueResolver.js";

export type {
  Cue,
  CueResolver,
  LexicalCueResolverOptions,
  EmbeddingCueResolverOptions,
  EmbeddingSeededCueResolver,
} from "./recall/cueResolver.js";

// ===========================================================================
// recall — Phase 1b/1c BLENDED + RRF PRESENTATION RANKING
// (docs/specs/PHASE1B_RANKING_SPEC.md, docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md)
// ===========================================================================

export {
  DEFAULT_PRESENTATION_WEIGHTS,
  DEFAULT_UNION_TOP_N,
  DEFAULT_RRF_K,
  STATE_WEIGHT,
  stateWeightOf,
  buildUnionCandidateSet,
  scorePresentation,
  scorePresentationRrf,
  rankForPresentation,
  cosineTopNCandidates,
  rankRecallResult,
} from "./recall/presentationRank.js";

export type {
  RankMode,
  PresentationScoreMode,
  PresentationWeights,
  RecallOptions,
  WalkLitCandidate,
  CosineCandidate,
  PresentationCandidate,
  ScoredCandidate,
  CosineDeps,
} from "./recall/presentationRank.js";

// ===========================================================================
// agent — the ergonomic AGENT MEMORY FACADE ("attach and use")
// ===========================================================================

export { createAgentMemory, deriveEntity } from "./agent/agentMemory.js";

export type {
  AgentMemory,
  AgentMemoryOptions,
  ApproverIdentity,
  RememberInput,
  RememberOrigin,
  RecallOutput,
  CitedFact,
  SourceSelector,
  PendingQuestion,
  PendingQuestionOption,
} from "./agent/agentMemory.js";

// ===========================================================================
// mcp — the minimal ZERO-DEP MCP server (pure handler + stdio transport)
// ===========================================================================

export {
  handleMcpRequest,
  TOOLS as MCP_TOOLS,
  SERVER_INFO as MCP_SERVER_INFO,
  MCP_PROTOCOL_VERSION,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
  // Boundary input caps (named limits the handler enforces; see handler.ts).
  REMEMBER_TEXT_MAX_CHARS,
  ENTITY_ATTRIBUTE_MAX_CHARS,
  RESOURCE_ID_MAX_CHARS,
  RECALL_QUERY_MAX_CHARS,
  RESOLVE_ID_MAX_CHARS,
  // Display cap for the belief dossier's rendered claim payload.
  EXPLAIN_PAYLOAD_MAX_RENDER_CHARS,
} from "./mcp/handler.js";

export type {
  McpRequest,
  McpResponse,
  McpError,
} from "./mcp/handler.js";

export {
  processLine as mcpProcessLine,
  main as mcpMain,
  // The bounded stdin line splitter (unit-testable transport state machine).
  BoundedLineSplitter,
  MAX_LINE_BYTES,
} from "./mcp/server.js";
