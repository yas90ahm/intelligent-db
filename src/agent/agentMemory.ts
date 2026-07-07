/**
 * agent/agentMemory.ts — THE AGENT-FACING ERGONOMIC FACADE ("attach and use").
 *
 * The engine (api.ts) is powerful but raw: using it requires manually managing the
 * StrandStore, the identity layer (source registration / IdentityStamps), the cue→seed step,
 * and mapping lit strands back to readable facts. This facade wires all of that into
 * ONE object an agent constructs and uses:
 *
 *     const mem = createAgentMemory();           // zero identity management
 *     mem.remember({ text: "Berlin is the capital of Germany" });
 *     const { facts } = mem.recall("what is the capital of Germany?");
 *     // facts: cited, grounded, prompt-ready
 *
 * IT WIRES: a store (SQLite if `dbPath`, else in-memory) + the Source-Identity Layer
 * over the crypto-free trust registry + the three-verb engine + the cue resolver,
 * and AUTO-PROVISIONS a default single-agent SOURCE (the deployment OWNER — the
 * PERSONAL preset's ground truth, registered once, stamped once) so the simple
 * single-agent case needs ZERO identity management. Multi-source callers reach the
 * registry's claim producers (SSO member / publisher / system-of-record) via
 * {@link AgentMemory.trust}.
 *
 * INVARIANTS PRESERVED. `recall` only returns strands whose provenance roots a real
 * source (no provenance → no voice, structurally): an ungrounded strand is never
 * spoken. The engine remains the only thing that mints facts and the model never
 * witnesses — the facade just makes the verbs ergonomic and cites the output.
 *
 * ZERO external deps (node:crypto for content hashes only; node:sqlite via the store).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax` ⇒
 * every type-only import uses `import type`.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  StrandId,
  EntityId,
  AttributeKey,
  SourceId,
  Unit,
  AnchorBinding,
  IdentityStamp,
  ProvenanceRoot,
  HaltStamp,
  EpochMs,
  ContradictionSetId,
  FactState,
} from "../core/types.js";
import { asEpochMs } from "../core/types.js";

import type { StrandStore } from "../store/StrandStore.js";
import { createMemoryStore } from "../store/memoryStore.js";
import { createSqliteStore } from "../store/sqliteStore.js";
import type { SqliteStrandStore } from "../store/sqliteStore.js";

import { createSourceIdentityLayer } from "../identity/index.js";
import type {
  SourceIdentityLayer,
  ReputationLedgerPort,
  SourceRef,
} from "../identity/index.js";
import { createTrustRegistry } from "../identity/trustRegistry.js";
import type { TrustRegistry, TrustRegistryConfig } from "../identity/trustRegistry.js";
import { createSqliteReputationLedger } from "../identity/reputation.js";
import type { ReputationLedger } from "../identity/reputation.js";
import { repCapFor } from "../identity/anchors.js";

import { createIntelligentDb } from "../api.js";
import type {
  CausalOrigin,
  IntelligentDb,
  RatificationDeps,
  DisownOptions,
  AdjudicateOptions,
  ExplainReport,
  ExplainSource,
  BeliefTimeline,
} from "../api.js";
import type { ConsolidationOutcome } from "../forgetting/consolidation.js";
import { createPendingLedger, createSqlitePendingLedger } from "../ratification/pendingLedger.js";
import type { AppendSink } from "../ratification/pendingLedger.js";
import type { PendingLedger, PendingPayload, ResolvedDispute } from "../ratification/pendingLedger.js";
import { sourceIdFor } from "../identity/sources.js";
import type { DownstreamDisownResult } from "../ratification/disown.js";

/**
 * Load `node:sqlite`'s {@link DatabaseSync} constructor via a runtime `require`
 * rather than a static `import` — see `store/sqliteStore.ts`'s identical note
 * (bundlers/test transformers choke on a static `import "node:sqlite"` for a
 * built-in newer than their hardcoded list). Zero new runtime deps: still Node
 * stdlib, resolved by Node's own loader exactly as in production.
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

import { createLexicalCueResolver, strandText } from "../recall/cueResolver.js";
import type { Cue, CueResolver, LexicalCueResolverOptions } from "../recall/cueResolver.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A source SELECTOR for the MULTI-source case (distinct from the identity
 * layer's {@link SourceRef}, which DESCRIBES a source). Supply a `stamp`
 * directly, or a `sourceId` the facade will stamp through the identity layer.
 * Omit it entirely and the facade uses the auto-provisioned default agent source.
 */
export interface SourceSelector {
  /** An explicit identity stamp (e.g. assembled by a caller managing identity). */
  readonly stamp?: IdentityStamp;
  /** A registered source id to stamp through the identity layer. */
  readonly sourceId?: SourceId;
}

/**
 * WHERE a remembered fact came from, in facade-friendly terms — the boundary
 * seam that makes the engine's trust-tiered quarantine REACHABLE from the
 * facade. Without it every `remember()` was filed under the auto-provisioned
 * OWNER source (weight 0.90): a fact scraped off some web page arrived at the
 * engine wearing the owner's ground-truth stamp, so the quarantine gate and the
 * relay fix were structurally unreachable from the ergonomic path.
 *
 *  - `"user"` (or omitting `origin` entirely) — the user said it to this agent:
 *    the owner stamp, bit-for-bit today's behavior.
 *  - `"web"` — fetched web content. The fact is FILED UNDER the page's publisher
 *    (`trust.registerPublisher(resourceId)` — one source per eTLD+1); an
 *    unconfigured publisher carries the low unverified weight and lands
 *    PROVISIONAL via the existing quarantine gate. The causal origin is the
 *    DOCUMENT resource, so the same page collapses to ONE independence class no
 *    matter which agent fetched it.
 *  - `"document"` / `"tool"` — a local document / a tool's output. Filed under a
 *    DETERMINISTIC per-resource source (`sourceIdFor("iddb:document"|"iddb:tool",
 *    resourceId)`) registered with NO anchors — BARE_KEY-equivalent, weight 0 —
 *    so it quarantines, and the causal origin is the per-resource
 *    DOCUMENT/TOOL_CALL class (same resource ⇒ one witness across agents).
 *
 * `resourceId` is REQUIRED for `web`/`document`/`tool` (the canonical URL /
 * document id / tool id — canonicalization is the caller's job). An explicit
 * {@link RememberInput.source} still wins the STAMP (a multi-source caller
 * managing identity explicitly), with the origin still shaping the causal class.
 */
export interface RememberOrigin {
  /** Where the fact came from. `"user"` ≡ omitting `origin` (owner stamp). */
  readonly kind: "user" | "web" | "document" | "tool";
  /** The canonical underlying resource. REQUIRED for web/document/tool. */
  readonly resourceId?: string;
}

/** Input to {@link AgentMemory.remember}. */
export interface RememberInput {
  /** The fact text, in plain English. */
  readonly text: string;
  /** The entity this fact is about. Derived from the text (a slug) when absent. */
  readonly entity?: string;
  /** Optional (entity, attribute) claim key. */
  readonly attribute?: string;
  /** Optional source for the multi-source case; defaults to the agent's own source. */
  readonly source?: SourceSelector;
  /**
   * WHERE the fact came from (facade-friendly). Omitted or `"user"` ⇒ today's
   * owner-stamped behavior exactly; `web`/`document`/`tool` file under a
   * low-trust per-resource source (quarantined until independently corroborated)
   * and thread the matching {@link CausalOrigin}. See {@link RememberOrigin}.
   */
  readonly origin?: RememberOrigin;
  /**
   * POWER-USER escape hatch: an explicit engine-level {@link CausalOrigin}
   * (e.g. `AGENT_RELAY` with consulted strand ids, which {@link RememberOrigin}
   * cannot express). Passed straight through to `engine.writeFact`. When both
   * this and `origin` are present, this field wins the causal origin; `origin`
   * still selects the filing source.
   */
  readonly causalOrigin?: CausalOrigin;
}

/** One cited, grounded, prompt-ready fact returned by {@link AgentMemory.recall}. */
export interface CitedFact {
  /**
   * The strand behind this fact — the handle {@link AgentMemory.explain} (and
   * the MCP `why_do_you_believe_this` tool) takes to build the belief dossier.
   * `PendingQuestionOption` already carried its strand id; recall now does too.
   */
  readonly strandId: StrandId;
  /** The raw payload the fact was stored with (the librarian's structure). */
  readonly fact: unknown;
  /** The human-readable text of the fact (for dropping straight into a prompt). */
  readonly text: string;
  /** The provenance source that grounds this fact (no provenance → no voice). */
  readonly source: SourceId;
  /** A short human-readable citation string ("source <id-prefix> @ <observedAt>"). */
  readonly citation: string;
  /** The activation energy this strand ended the walk holding (relevance signal). */
  readonly activation: number;
  /**
   * The strand's belief state — the label that makes a held superposition
   * DISTINGUISHABLE from a believed fact at the consumption boundary. The
   * spiderweb deliberately surfaces PROVISIONAL (trust-tiered-ingest
   * quarantine, not yet independently corroborated) and DEMOTED (outranked
   * history, demote-never-delete) strands; the consuming agent MUST see the
   * state or it would drop an unverified claim into its prompt as if it were
   * a believed one — exactly the hallucination the quarantine tier exists to
   * prevent. LIVE = believed; anything else is context, not authority.
   */
  readonly fact_state: FactState;
  /**
   * CONTESTED-FACT LABEL (label, never hide): `true` iff this strand is a MEMBER
   * of an OPEN pending dispute (`listPending()` — the ledger's own open
   * semantics; a resolved dispute un-contests structurally). Computed ONCE per
   * recall call, AFTER the walk returns — O(open pendings), never per
   * strand-pop; ordering, energy, and filtering are untouched (the walk
   * observes nothing about disputes). Always `false` when no ratification
   * ledger is wired.
   */
  readonly contested: boolean;
}

/** Output of {@link AgentMemory.recall}. */
export interface RecallOutput {
  /** The cited, grounded facts that lit up, most-activated first. */
  readonly facts: CitedFact[];
  /** The halt stamp explaining how/why the walk stopped (never a silent stop). */
  readonly halt: HaltStamp;
}

/**
 * PHASE 4 [personal-tier dispute horn] — one side of an open dispute, rendered as
 * plain data an agent can phrase to the owner ("option (a): ..."). Text rendering
 * reuses {@link strandText} — the SAME rendering {@link CitedFact.text} uses — so
 * what the owner is asked about is exactly what recall would speak.
 */
export interface PendingQuestionOption {
  /** The disputed member strand (pass back to {@link AgentMemory.resolvePending}). */
  readonly strandId: StrandId;
  /** The claim's human-readable text (the payload, rendered like a CitedFact). */
  readonly text: string;
  /**
   * Human-readable label of the source behind this claim — "label (KIND)" when the
   * trust registry knows the ref, else a short source-id prefix. Descriptive only.
   */
  readonly source: string;
  /** The claim's belief state (LIVE = believed; labeled, never hidden). */
  readonly fact_state: FactState;
  /** When this claim was observed, ISO-8601 ("you told me X in March"). */
  readonly whenObserved: string;
}

/**
 * PHASE 4 [personal-tier dispute horn] — one open deferred dispute rendered as a
 * QUESTION TO THE OWNER: plain data an agent can phrase conversationally ("Two
 * sources disagree about X — which is correct?") and answer via
 * {@link AgentMemory.resolvePending} with the chosen option's `strandId`.
 */
export interface PendingQuestion {
  /** The dispute's id (pass back to {@link AgentMemory.resolvePending}). */
  readonly contradictionSetId: ContradictionSetId;
  /** A human-readable one-liner naming what is disputed. */
  readonly question: string;
  /** The disputed claims, reputation-ranked strongest-first (order decides nothing). */
  readonly options: readonly PendingQuestionOption[];
  /** When the dispute was deferred to the horn. */
  readonly createdAt: EpochMs;
}

/** Options for {@link createAgentMemory}. */
export interface AgentMemoryOptions {
  /** SQLite db path for durable memory; in-memory (non-durable) when absent. */
  readonly dbPath?: string;
  /** Cue-resolver tuning (top-K, stopwords, energy floor). */
  readonly resolver?: LexicalCueResolverOptions;
  /**
   * EXTRA anchors to bind the auto-provisioned default agent source to, on top
   * of the OWNER claim it already carries (the PERSONAL preset's ground truth).
   * Default `[]`.
   */
  readonly defaultSourceAnchors?: readonly AnchorBinding[];
  /**
   * The deployment's trust policy (the swappable trust root): tenured
   * publishers, verified tenant domains, the publisher operator hook. Omit for
   * the PERSONAL preset (owner-only ground truth, nothing to configure).
   */
  readonly trust?: TrustRegistryConfig;
  /**
   * REAL-TIME AUDIT SHIPPING (insider-tamper mitigation, see
   * {@link "../ratification/pendingLedger".AppendSink}): every audit record the
   * dispute horn writes (PENDING / APPROVAL / MUTATION) is handed to this sink
   * BEFORE the local write, so a copy lives somewhere the writing process cannot
   * rewrite. Omit for a local-only chain (the PERSONAL default — the owner is the
   * only insider, so there is no one to protect the history from).
   */
  readonly onLedgerAppend?: AppendSink;
}

/**
 * The approver identity the engine's `approve` verb expects — read from the
 * engine's own signature so this facade tracks the engine, not a concrete type.
 */
export type ApproverIdentity = Parameters<IntelligentDb["approve"]>[2];

/**
 * THE ERGONOMIC AGENT MEMORY. Attach once; remember and recall in plain English with
 * zero identity management for the single-agent case, with the richer engine verbs
 * (adjudicate / disown / ratify / listPending / approve) exposed for the multi-source
 * case.
 */
export interface AgentMemory {
  /**
   * Mint a fact and index its tokens for recall. Derives an entity slug from the text
   * when none is given (so it stays recallable). Returns the new strand id. Uses the
   * default agent source unless `input.source` names another.
   */
  remember(input: RememberInput): { id: StrandId };

  /**
   * Resolve a cue (string or {@link Cue}) to seeds, run the activation walk, and map
   * the lit strands to cited, grounded facts. Only strands with real provenance are
   * returned (no provenance → no voice). Facts come back most-activated first.
   */
  recall(cue: string | Cue): RecallOutput;

  /**
   * RATIFY a strand on an external source's authority (DERIVED → OBSERVED, or
   * PROVISIONAL → LIVE). Multi-source case. `source` defaults to the agent source.
   */
  ratify(strandId: StrandId, source?: SourceSelector): void;

  /** ADJUDICATE a contradiction over an (entity, attribute). Multi-source case. */
  adjudicate(attribute: AttributeKey, opts?: AdjudicateOptions): ConsolidationOutcome;

  /** RETROACTIVELY DISOWN a fraudulent source (the full undo sweep). */
  disown(sourceId: SourceId, opts?: DisownOptions): DownstreamDisownResult;

  /** The open deferred disputes awaiting a human decision. */
  listPending(): readonly PendingPayload[];

  /**
   * PHASE 4 — THE PERSONAL-TIER DISPUTE HORN AS A CONVERSATION. Every open
   * deferred dispute, rendered as plain data an agent can phrase as a question to
   * the OWNER: what attribute is disputed, and each side's text / source /
   * belief-state / observation time. The owner answers with
   * {@link resolvePending}.
   *
   * QUARANTINE INTERACTION (Phase 3): disputes only ever FORM among LIVE strands
   * (`adjudicate` admits only LIVE members), so this surfaces genuine
   * believed-fact conflicts — a PROVISIONAL (quarantined) flood can never ring
   * this horn, no matter its size. Quarantine noise stays noise.
   */
  pendingQuestions(): readonly PendingQuestion[];

  /**
   * PHASE 4 — THE OWNER ANSWERS a pending question: `chosenStrandId` (one of the
   * question's option strand ids) wins; the other members are DEMOTED (kept as
   * history, never deleted). Under the hood this is `approve()` with the
   * auto-provisioned OWNER source as the approver, under the EXPLICIT
   * owner-override policy hook ({@link ApproveOptions.allowAuthorApprover}) —
   * because in the personal tier the owner often authored one side themselves
   * ("you told me X in March"), and the owner overriding their own memory is the
   * tier's ground truth, not self-dealing (the OWNER anchor is
   * EXTERNAL_AUTHORITY-grade and there is no second admin in a mom-and-pop
   * deployment). The APPROVAL record in the immortal chain is stamped
   * `ownerOverride: true`; enterprise `approve()` callers are untouched.
   */
  resolvePending(
    contradictionSetId: ContradictionSetId,
    chosenStrandId: StrandId,
  ): ResolvedDispute;

  /** RESOLVE a deferred dispute by an external approver's decision. */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: ApproverIdentity,
    at?: EpochMs,
  ): ResolvedDispute;

  /**
   * THE BELIEF DOSSIER: "why does the memory believe this?" Takes a strand id or
   * a recalled {@link CitedFact} (which carries its `strandId`) and returns the
   * engine's read-only {@link ExplainReport}, ENRICHED with the trust registry's
   * descriptive metadata (`sources[].registered` via `trust.refOf` — label +
   * kind where the registry knows the source). Returns `null` for an unknown
   * strand (a query miss, not an error). Zero writes; always recomputed fresh.
   */
  explain(target: StrandId | CitedFact): ExplainReport | null;

  /**
   * TIME-TRAVEL: the ordered belief history of one (entity, attribute) — see
   * {@link IntelligentDb.beliefTimeline}. Plain-string ergonomics matching
   * {@link remember} (branded casts happen here). Read-only; never throws for
   * an unknown key (empty arrays instead).
   */
  beliefTimeline(entity: string, attribute: string): BeliefTimeline;

  /** Register an additional source (multi-source case) and return its stamp.
   * Prefer the {@link trust} registry's claim producers for the standard kinds. */
  registerSource(source: SourceRef, anchors?: readonly AnchorBinding[]): IdentityStamp;

  /**
   * The crypto-free trust registry behind this memory — the claim producers
   * (registerOwner / registerSsoMember / registerPublisher /
   * registerSystemOfRecord) named additional sources map onto.
   */
  readonly trust: TrustRegistry;

  /** The auto-provisioned default agent source id (the single-agent voice). */
  readonly defaultSourceId: SourceId;

  /** Build a stamp for a registered source (multi-source helper). */
  stampFor(sourceId: SourceId): IdentityStamp;

  /** The underlying engine, for advanced callers. */
  readonly engine: IntelligentDb;

  /** Close the underlying store (flushes the SQLite WAL). No-op for in-memory. */
  close(): void;
}

// ---------------------------------------------------------------------------
// In-process pillar wiring the facade owns
//
// The crypto-free trust registry (identity/trustRegistry.ts) serves BOTH the
// source-registry and anchor-registry ports over one book, so the single-agent
// case needs no external identity infrastructure. The OWNER claim the default
// source carries is sufficient for single-agent; multi-source callers use the
// registry's claim producers (or registerSource for manual bindings).
// ---------------------------------------------------------------------------

function makeReputationLedgerPort(): ReputationLedgerPort {
  // The single-agent facade does not earn/score reputation by default (no external
  // ratifier in the simple case); a fresh source sits at its floor (0).
  return {
    scoreOf(_sourceId: SourceId): Unit {
      return 0 as Unit;
    },
  };
}

// ---------------------------------------------------------------------------
// Entity derivation (so a fact with no entity is still recallable)
// ---------------------------------------------------------------------------

/**
 * Derive an entity id from fact text when the caller gives none: a `entity:<slug>`
 * built from the first few salient tokens (lowercase, alnum, dash-joined). Falls back
 * to a content hash when the text yields no usable tokens, so the result is always a
 * stable, non-empty, recallable entity.
 */
export function deriveEntity(text: string): EntityId {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    tokens.push(raw);
    if (tokens.length >= 6) break;
  }
  if (tokens.length > 0) {
    return ("entity:" + tokens.join("-")) as EntityId;
  }
  const hash = createHash("sha256").update(text).digest("base64url").slice(0, 16);
  return ("entity:" + hash) as EntityId;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct an {@link AgentMemory}. Wires a store (SQLite if `dbPath`, else in-memory),
 * the identity layer over the crypto-free trust registry, the engine, and the lexical
 * cue resolver, then AUTO-PROVISIONS a default agent source (the deployment OWNER —
 * register → stamp) so the single-agent case needs no identity management. The cue
 * resolver rebuilds its index from the store on construction, so a SQLite reopen
 * restores recall.
 *
 * ATOMICITY (fixes `approve-desync-default-facade`): when `dbPath` is given, the
 * facade OWNS a single `DatabaseSync` handle and shares it across the StrandStore,
 * the reputation ledger, AND the ratification (audit/pending) ledger — the exact
 * "facts + trust + audit in one crash-consistent file" recipe `api.ts`'s `withTxn`
 * doc describes and `atomicCompound.test.ts`/`systemCoherence.test.ts` exercise.
 * Previously this facade opened its OWN separate SQLite handle for the store but
 * wired the ratification ledger IN-MEMORY regardless of `dbPath`: a mid-`approve()`
 * (or mid-`adjudicate`/`disown`) throw rolled the store's SQLite transaction back
 * but left the in-memory ledger's already-appended APPROVAL/PENDING record
 * permanent — a durable-store-vs-volatile-ledger desync, reproduced end-to-end (an
 * ordinary thrown exception, no crash required). Sharing ONE handle means the
 * ledger's `INSERT`s ride the SAME `store.beginTxn()` transaction `withTxn` opens,
 * so they roll back together. The in-memory path (`dbPath` omitted) is unaffected —
 * it stays the fast, non-durable, already-atomic-per-call default.
 */
export function createAgentMemory(opts?: AgentMemoryOptions): AgentMemory {
  // The single shared handle this facade OWNS when durable (null for in-memory).
  // Only the owner may close it — see `close()` below.
  let ownedDb: DatabaseSyncType | null = null;
  let store: StrandStore;

  if (opts?.dbPath !== undefined) {
    const db = new DatabaseSync(opts.dbPath);
    // The OWNER of a shared handle must set WAL BEFORE any shared-handle
    // constructor borrows it (`createSqliteStore`'s `{ db }` overload verifies
    // WAL and throws `SharedHandleNotWalError` otherwise — see sqliteStore.ts).
    db.exec("PRAGMA journal_mode=WAL");
    ownedDb = db;
    store = createSqliteStore({ db });
  } else {
    store = createMemoryStore();
  }

  // ONE registry instance serves both the sameness and independence ports, so
  // register/has and anchorsOf/independentSources read from the same book.
  const trust: TrustRegistry = createTrustRegistry(opts?.trust);

  // DURABLE reputation ledger sharing the owned handle when `dbPath` is given
  // (so the winner-ratify / loser-contradict moves `approve()`/`adjudicate()`
  // drive ride the SAME transaction as the store + ledger writes); the
  // in-memory path keeps the original constant-0 stub — it was never wired to
  // anything durable to begin with, and this facade's identity/reputation
  // wiring is otherwise unchanged.
  let reputationLedger: ReputationLedger | null = null;
  let reputationPort: ReputationLedgerPort;
  if (ownedDb !== null) {
    const repCapOf = (s: SourceId): Unit => repCapFor([...trust.anchorsOf(s)]);
    reputationLedger = createSqliteReputationLedger(repCapOf, { db: ownedDb });
    reputationPort = { scoreOf: (s: SourceId): Unit => reputationLedger!.scoreOf(s) };
  } else {
    reputationPort = makeReputationLedgerPort();
  }

  const identity: SourceIdentityLayer = createSourceIdentityLayer({
    sources: trust,
    anchors: trust,
    reputation: reputationPort,
    // stake omitted: the retired pillar defaults to the constant-zero port.
  });

  // PHASE 4 — WIRE THE DISPUTE HORN. Without a ratification ledger the engine
  // REFUSES to defer (it throws rather than silently drop an independent
  // dispute), which made the horn unreachable from the facade. The facade now
  // wires the checksum-chained pending ledger so a genuine independent dispute
  // lands as an open PENDING the owner can answer via pendingQuestions() /
  // resolvePending(). DURABLE + sharing `ownedDb` when `dbPath` is given (see
  // the atomicity doc above); in-memory otherwise (the fast default — an open
  // pending is RE-DERIVABLE by re-running adjudicate over the same LIVE
  // members, so losing it on process exit is harmless there).
  const onAppend = opts?.onLedgerAppend !== undefined ? { onAppend: opts.onLedgerAppend } : {};
  const ledger: PendingLedger =
    ownedDb !== null
      ? createSqlitePendingLedger({ db: ownedDb, reputation: reputationLedger, ...onAppend })
      : createPendingLedger(onAppend);
  const ratification: RatificationDeps = {
    ledger,
    // The engine's own voice on system-authored PENDING/MUTATION records —
    // asserted attribution only, deliberately NOT a registered witness (the
    // system must never count as a source of truth about claims).
    systemSource: sourceIdFor("iddb:system", "agent-memory"),
  };
  const engine: IntelligentDb = createIntelligentDb(
    store,
    identity,
    null,
    reputationLedger,
    ratification,
  );
  const resolver: CueResolver = createLexicalCueResolver(store, opts?.resolver);

  // AUTO-PROVISION the default single-agent source: the deployment OWNER (the
  // PERSONAL preset's ground truth), registered once, its stamp cached. The
  // single-agent caller never touches identity.
  const defaultSource: SourceRef = trust.registerOwner("agent");
  const extraAnchors = [...(opts?.defaultSourceAnchors ?? [])];
  if (extraAnchors.length > 0) identity.register(defaultSource, extraAnchors);
  const defaultStamp: IdentityStamp = identity.stampFor(defaultSource.sourceId);

  function resolveStamp(source?: SourceSelector): IdentityStamp {
    if (source === undefined) return defaultStamp;
    if (source.stamp !== undefined) return source.stamp;
    if (source.sourceId !== undefined) return identity.stampFor(source.sourceId);
    return defaultStamp;
  }

  /**
   * Resolve a {@link RememberInput}'s ORIGIN into (stamp, causalOrigin) — the
   * boundary seam that makes the quarantine gate + relay fix reachable from the
   * facade (see {@link RememberOrigin} for the full policy). Omitted / "user" is
   * bit-for-bit today's behavior; web/document/tool derive a low-trust
   * per-resource FILER (unless the caller explicitly selected a source) and the
   * matching per-resource {@link CausalOrigin}. An explicit `input.causalOrigin`
   * always wins the causal-origin slot (the power-user escape hatch).
   */
  function resolveOrigin(input: RememberInput): {
    stamp: IdentityStamp;
    causalOrigin: CausalOrigin | undefined;
  } {
    const origin = input.origin;
    if (origin === undefined || origin.kind === "user") {
      // Today's behavior exactly: the owner stamp (or the caller's selector).
      return { stamp: resolveStamp(input.source), causalOrigin: input.causalOrigin };
    }

    const resourceId = origin.resourceId;
    if (resourceId === undefined || resourceId.length === 0) {
      throw new Error(
        `remember: origin.resourceId is required for origin.kind "${origin.kind}" ` +
          `(the canonical URL / document id / tool id the fact came from).`,
      );
    }

    // The per-resource CAUSAL class: the same page/document/tool output collapses
    // to ONE independence class no matter which agent filed it (the relay fix's
    // TOOL_CALL/DOCUMENT lane) — web pages and documents are both DOCUMENT-kind
    // resources; tool output is TOOL_CALL.
    const causalOrigin: CausalOrigin =
      input.causalOrigin ??
      (origin.kind === "tool"
        ? { kind: "TOOL_CALL", resourceId }
        : { kind: "DOCUMENT", resourceId });

    // An EXPLICIT source selector wins the stamp (a multi-source caller managing
    // identity); the origin still shapes the causal class above. WHO is speaking
    // gates belief; WHAT was consulted shapes independence (api.ts ingest gate).
    if (input.source !== undefined) {
      return { stamp: resolveStamp(input.source), causalOrigin };
    }

    if (origin.kind === "web") {
      // File under the page's PUBLISHER: one source per eTLD+1, priced by the
      // trust registry (unconfigured ⇒ PUBLISHER_UNVERIFIED 0.04 < the 0.10
      // quarantine gate ⇒ PROVISIONAL). Throws on an unresolvable host
      // (fail-closed — an unattributable page must never mint a source).
      const publisher = trust.registerPublisher(resourceId);
      return { stamp: identity.stampFor(publisher.sourceId), causalOrigin };
    }

    // document / tool: a DETERMINISTIC per-resource filer registered with NO
    // anchors — BARE_KEY-equivalent (independence weight 0), so it quarantines at
    // any positive threshold. Deterministic (sourceIdFor over a fixed issuer +
    // the resource id) so the SAME resource files under the SAME source forever:
    // re-observations echo-collapse instead of minting fresh witnesses.
    const issuer = origin.kind === "tool" ? "iddb:tool" : "iddb:document";
    const filerId = sourceIdFor(issuer, resourceId);
    identity.register(
      { sourceId: filerId, kind: "OTHER", label: `${origin.kind}:${resourceId}` },
      [],
    );
    return { stamp: identity.stampFor(filerId), causalOrigin };
  }

  function citationFor(sourceId: SourceId, observedAt: EpochMs): string {
    const prefix = String(sourceId).slice(0, 12);
    return `source ${prefix} @ ${new Date(observedAt as number).toISOString()}`;
  }

  return {
    defaultSourceId: defaultSource.sourceId,
    trust,
    engine,

    remember(input: RememberInput): { id: StrandId } {
      const entity: EntityId =
        input.entity !== undefined
          ? (input.entity as EntityId)
          : deriveEntity(input.text);
      // Origin threading (see RememberOrigin): who FILES the fact (the stamp the
      // quarantine gate prices) + where it CAME FROM (the causal origin the relay
      // fix collapses classes on). Omitted/user origin ⇒ today's owner stamp.
      const { stamp, causalOrigin } = resolveOrigin(input);

      const id = engine.writeFact({
        entity,
        ...(input.attribute !== undefined
          ? { attribute: input.attribute as AttributeKey }
          : {}),
        payload: { text: input.text },
        stamp,
        ...(causalOrigin !== undefined ? { causalOrigin } : {}),
      });

      // Index the freshly stored strand's tokens for cue resolution. Read it back so
      // the resolver sees the exact provenance/entity/attribute the engine minted.
      const stored = store.getStrand(id);
      if (stored !== null) resolver.index(stored);

      return { id };
    },

    recall(cue: string | Cue): RecallOutput {
      const c: Cue = typeof cue === "string" ? { text: cue } : cue;
      const seeds = resolver.resolve(c);

      // No seeds resolved ⇒ nothing to walk. Return an empty, non-degraded result by
      // running the (empty-seed) walk so the halt stamp is still real, never invented.
      const result = engine.recall({ seeds });

      // CONTESTED-FACT LABELS (feature C): the open-dispute member set, computed
      // ONCE per recall call AFTER the walk returns — O(open pendings), never per
      // strand-pop, so the recall hot path stays hot. No caching across calls (a
      // dispute can open/close between recalls; freshness beats micro-perf). The
      // walk itself observed nothing: ordering/energy/filtering are byte-identical
      // to a no-dispute run — this is a LABEL at the consumption boundary.
      const contestedIds = new Set<string>();
      for (const p of engine.listPending()) {
        for (const m of p.members) contestedIds.add(String(m));
      }

      const facts: CitedFact[] = [];
      for (const lit of result.lit) {
        const strand = store.getStrand(lit.strandId);
        if (strand === null) continue;

        // NO PROVENANCE → NO VOICE: only return strands grounded in a REAL source.
        // A strand whose provenance is empty or whose every root has a null sourceId
        // is ungrounded and must never be spoken.
        let groundingSource: SourceId | null = null;
        let groundingRoot: ProvenanceRoot | null = null;
        for (const root of strand.provenance) {
          if (root.sourceId !== null) {
            groundingSource = root.sourceId;
            groundingRoot = root;
            break;
          }
        }
        if (groundingSource === null || groundingRoot === null) continue;

        facts.push({
          strandId: strand.id,
          fact: strand.payload,
          text: strandText(strand),
          source: groundingSource,
          citation: citationFor(groundingSource, strand.observedAt),
          activation: lit.activation,
          // Carry the belief state to the caller VERBATIM (never filtered here:
          // the web shows superpositions by design — labeled, not hidden).
          fact_state: strand.fact_state,
          // Label, never hide: a member of an OPEN dispute is flagged, not dropped.
          contested: contestedIds.has(String(strand.id)),
        });
      }

      // Most-activated first (prompt-ready ordering).
      facts.sort((a, b) => b.activation - a.activation);

      return { facts, halt: result.halt };
    },

    ratify(strandId: StrandId, source?: SourceSelector): void {
      const stamp = resolveStamp(source);
      engine.ratify({ strandId, externalStamp: stamp });
    },

    adjudicate(attribute: AttributeKey, adjOpts?: AdjudicateOptions): ConsolidationOutcome {
      return engine.adjudicate(attribute, adjOpts);
    },

    disown(sourceId: SourceId, disownOpts?: DisownOptions): DownstreamDisownResult {
      return engine.disown(sourceId, disownOpts);
    },

    listPending(): readonly PendingPayload[] {
      return engine.listPending();
    },

    pendingQuestions(): readonly PendingQuestion[] {
      // Disputes only ever FORM among LIVE strands (adjudicate admits only LIVE
      // members — the Phase-3 quarantine gate), so everything rendered here is a
      // genuine believed-fact conflict; a PROVISIONAL flood produces ZERO
      // pending questions. Members are resolved from the store fail-closed: a
      // dangling member id renders nothing (never throws, never invents).
      const questions: PendingQuestion[] = [];
      for (const p of engine.listPending()) {
        const options: PendingQuestionOption[] = [];
        let entity: EntityId | null = null;
        for (const memberId of p.members) {
          const strand = store.getStrand(memberId);
          if (strand === null) continue;
          if (entity === null) entity = strand.entity;

          // The grounding source: the first provenance root with a real sourceId
          // — the SAME "no provenance → no voice" rule recall's citations use.
          let groundingSource: SourceId | null = null;
          for (const root of strand.provenance) {
            if (root.sourceId !== null) {
              groundingSource = root.sourceId;
              break;
            }
          }
          const ref = groundingSource !== null ? trust.refOf(groundingSource) : null;
          const sourceLabel =
            ref !== null
              ? `${ref.label ?? String(ref.sourceId).slice(0, 12)} (${ref.kind})`
              : groundingSource !== null
                ? `source ${String(groundingSource).slice(0, 12)}`
                : "unknown source";

          options.push({
            strandId: strand.id,
            text: strandText(strand),
            source: sourceLabel,
            fact_state: strand.fact_state,
            whenObserved: new Date(strand.observedAt as number).toISOString(),
          });
        }
        if (options.length === 0) continue; // nothing resolvable to ask about

        const about =
          entity !== null ? `${String(entity)} ${String(p.attribute)}` : String(p.attribute);
        // Grammar tracks the RESOLVABLE option count: a dispute degraded to one
        // surviving option (its siblings dangling — see the fail-closed skip
        // above) is phrased as a confirmation, never "1 sources disagree".
        const question =
          options.length === 1
            ? `A disputed claim about ${about} has one remaining option — is it correct?`
            : `${options.length === 2 ? "Two" : String(options.length)} sources disagree about ${about} — which is correct?`;
        questions.push({
          contradictionSetId: p.contradictionSetId,
          question,
          options,
          createdAt: p.createdAt,
        });
      }
      return questions;
    },

    resolvePending(
      contradictionSetId: ContradictionSetId,
      chosenStrandId: StrandId,
    ): ResolvedDispute {
      // THE OWNER ANSWERS — approve() with the auto-provisioned OWNER source as
      // the approver, under the EXPLICIT owner-override policy hook. WHY the
      // hook: the enterprise distinct-approver gate rejects an approver who
      // AUTHORED a disputed member, but in the personal tier the owner often DID
      // author one side ("you told me X in March"); the owner is the tier's
      // trust root (EXTERNAL_AUTHORITY-grade OWNER anchor, no second admin in a
      // mom-and-pop deployment), so overriding their own memory is ground
      // truth, not self-dealing. The flag is set HERE ONLY, for the owner
      // source; the enterprise gates are untouched, and the APPROVAL record in
      // the immortal chain is stamped `ownerOverride: true` for the audit trail.
      return engine.approve(
        contradictionSetId,
        chosenStrandId,
        defaultSource.sourceId,
        undefined,
        { allowAuthorApprover: true },
      );
    },

    approve(
      contradictionSetId: ContradictionSetId,
      winnerStrandId: StrandId,
      approver: ApproverIdentity,
      at?: EpochMs,
    ): ResolvedDispute {
      return engine.approve(contradictionSetId, winnerStrandId, approver, at);
    },

    explain(target: StrandId | CitedFact): ExplainReport | null {
      // A CitedFact carries its strandId; a bare id is used as-is (round-trip:
      // mem.recall(...).facts[0] → mem.explain(fact) explains that exact strand).
      const strandId: StrandId = typeof target === "string" ? target : target.strandId;
      const report = engine.explain(strandId);
      if (report === null) return null; // unknown strand: a query miss, not an error

      // ENRICH sources with the trust registry's descriptive metadata (label +
      // kind) — the engine reports `registered: null` because it holds no
      // registry handle; the facade owns that handle. Descriptive only, never
      // load-bearing (the stamp is the trust evidence; the label is a name).
      const sources: ExplainSource[] = report.sources.map((s) => {
        const ref = trust.refOf(s.sourceId);
        return ref === null
          ? s
          : { ...s, registered: { label: ref.label ?? null, kind: String(ref.kind) } };
      });
      return { ...report, sources };
    },

    beliefTimeline(entity: string, attribute: string): BeliefTimeline {
      // Branded casts matching remember()'s ergonomics (plain strings in).
      return engine.beliefTimeline(entity as EntityId, attribute as AttributeKey);
    },

    registerSource(
      source: SourceRef,
      sourceAnchors?: readonly AnchorBinding[],
    ): IdentityStamp {
      identity.register(source, [...(sourceAnchors ?? [])]);
      return identity.stampFor(source.sourceId);
    },

    stampFor(sourceId: SourceId): IdentityStamp {
      return identity.stampFor(sourceId);
    },

    close(): void {
      // The store/reputation-ledger/pending-ledger `close()` calls are no-ops
      // for a BORROWED (shared) handle — see each backend's own `ownsDb` guard.
      // This facade OWNS `ownedDb` directly (it opened it above), so IT closes
      // the handle — the single point that actually flushes the SQLite WAL.
      const closable = store as Partial<SqliteStrandStore>;
      if (typeof closable.close === "function") closable.close();
      if (ownedDb !== null) ownedDb.close();
    },
  };
}

// Re-export the Cue/CueResolver seam + RatificationDeps for callers wiring the
// multi-source case against this facade.
export type { Cue, CueResolver, RatificationDeps, EpochMs };
// Keep asEpochMs reachable for callers building EpochMs values (single import surface).
export { asEpochMs };
