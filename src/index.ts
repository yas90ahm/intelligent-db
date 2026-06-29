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
 * re-exported here, alongside the four ARCHITECTURE.md roadmap pillars (anchor
 * binding, Merkle tamper-evidence, Beta(α,β) trust with decay-on-read, undo-engine
 * hardening) and the durable SQLite backends. The engine's `disown` verb wires the
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
  ActivationRegister,
  Strand,
  // undo-engine hardening records
  WeakInfluenceEdge,
  ReviewQueueEntry,
  AdjudicationProvenance,
  // shared result/option shapes
  LitStrand,
  HaltStamp,
  WalkConfig,
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

// ===========================================================================
// traversal — spreading-activation walk + two-phase halting controller
// ===========================================================================

export {
  MaxPriorityQueue,
  frontierComparator,
  activationWalk,
  makeChildCandidate,
  orderingKeyFor,
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
  tryConsolidate,
  DEFAULT_ADJUDICATION_POLICY,
} from "./forgetting/consolidation.js";

export type {
  ContradictionSet,
  DemotionResult,
  ConsolidationOutcome,
  PendingRatification,
  PendingRatificationReason,
  AdjudicationPolicy,
  HighImpactContext,
} from "./forgetting/consolidation.js";

// ===========================================================================
// identity — the external Source-Identity Layer (the four pillars)
// ===========================================================================

export { createSourceIdentityLayer, MAX_EXACT_ROOTS } from "./identity/index.js";

export type {
  SourceIdentityLayer,
  SourceIdentityLayerDeps,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  Passport,
} from "./identity/index.js";

export {
  generatePassport,
  sourceIdFromPublicKey,
  sign,
  verify,
} from "./identity/keys.js";

export type { KeyPair } from "./identity/keys.js";

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

// --- anchor-binding pipeline: attestations + binders + the real registry ---

export {
  signAttestation,
  verifyAttestation,
  isRejection,
  createDomainBinder,
  createEmailBinder,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_ATTESTATION_TTL_MS,
} from "./identity/binding.js";

export type {
  AnchorAttestation,
  Challenge,
  Rejection,
  AnchorBinder,
  BindProof,
  DomainProofChecker,
  RegistrarLookup,
  ETldResolver,
  DomainBinderDeps,
  EmailConfirmationPort,
  EmailBinderDeps,
} from "./identity/binding.js";

// --- REAL DNS-01 prover (node:dns) behind an injected resolver seam ---

export {
  createDnsDomainProofChecker,
  createNodeDnsResolver,
  fakeResolver,
  deriveOperatorClass,
  bindDomainViaDns,
  UNKNOWN_DNS_OPERATOR,
  DEFAULT_CHALLENGE_PREFIX,
  DEFAULT_ATTESTATION_TTL_MS as DNS_DEFAULT_ATTESTATION_TTL_MS,
} from "./identity/binders/dnsDomainProver.js";

export type {
  DnsResolver,
  DnsDomainProofCheckerOpts,
  DnsDomainBindDeps,
} from "./identity/binders/dnsDomainProver.js";

export {
  registrableDomain as pslRegistrableDomain,
  publicSuffixOf as pslPublicSuffixOf,
  pslResolver,
} from "./identity/binders/publicSuffix.js";

export { createAnchorRegistry } from "./identity/anchorRegistry.js";

export type {
  AnchorRegistry,
  AnchorRegistryDeps,
} from "./identity/anchorRegistry.js";

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

export {
  FINANCIAL_STAKE_WEIGHT_MIN,
  FINANCIAL_STAKE_WEIGHT_MAX,
  STAKE_ANCHOR_CLASS,
  createStakeLedger,
  financialStakeWeight,
  stakeMultiplier,
} from "./identity/stake.js";

export type { Stake, StakeLedger } from "./identity/stake.js";

// ===========================================================================
// ratification — the VAULT (append-only signed ledger) + DOORBELL (approve flow)
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

// --- Merkle-anchored, externally-witnessed tamper-evidence (roadmap item 2) ---

export {
  createMerkleLog,
  signTreeHead,
  verifyTreeHead,
  verifyInclusion,
  verifyConsistency,
  detectSplitView,
  leafHashOf,
  leafHashOfPreimage,
  nodeHash,
  EMPTY_TREE_ROOT,
  InMemoryPublicationSink,
  createSqlitePublicationSink,
} from "./ratification/merkleLog.js";

export type {
  MerkleLog,
  Hash,
  STH,
  InclusionProof,
  PublicationSink,
  SqlitePublicationSink,
  WitnessResult,
  WitnessReason,
  SplitViewResult,
} from "./ratification/merkleLog.js";

// ===========================================================================
// api — the top-level three-verb engine
// ===========================================================================

export { createIntelligentDb } from "./api.js";

export type {
  IntelligentDb,
  ConsolidationPort,
  RatificationDeps,
  AdjudicateOptions,
  DisownOptions,
  WriteFactInput,
  RecallCue,
  RecallResult,
  RatifyInput,
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
} from "./recall/cueResolver.js";

export type {
  Cue,
  CueResolver,
  LexicalCueResolverOptions,
} from "./recall/cueResolver.js";

// ===========================================================================
// agent — the ergonomic AGENT MEMORY FACADE ("attach and use")
// ===========================================================================

export { createAgentMemory, deriveEntity } from "./agent/agentMemory.js";

export type {
  AgentMemory,
  AgentMemoryOptions,
  RememberInput,
  RecallOutput,
  CitedFact,
  SourceRef,
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
} from "./mcp/handler.js";

export type {
  McpRequest,
  McpResponse,
  McpError,
} from "./mcp/handler.js";

export { processLine as mcpProcessLine, main as mcpMain } from "./mcp/server.js";
