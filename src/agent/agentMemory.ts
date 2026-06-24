/**
 * agent/agentMemory.ts — THE AGENT-FACING ERGONOMIC FACADE ("attach and use").
 *
 * The engine (api.ts) is powerful but raw: using it requires manually managing the
 * StrandStore, the identity layer (passports / IdentityStamps), the cue→seed step,
 * and mapping lit strands back to readable facts. This facade wires all of that into
 * ONE object an agent constructs and uses:
 *
 *     const mem = createAgentMemory();           // zero identity management
 *     mem.remember({ text: "Berlin is the capital of Germany" });
 *     const { facts } = mem.recall("what is the capital of Germany?");
 *     // facts: cited, grounded, prompt-ready
 *
 * IT WIRES: a store (SQLite if `dbPath`, else in-memory) + the Source-Identity Layer
 * over lightweight in-process pillar ports + the three-verb engine + the cue resolver,
 * and AUTO-PROVISIONS a default single-agent SOURCE (one passport, registered, stamped
 * once) so the simple single-agent case needs ZERO identity management.
 *
 * INVARIANTS PRESERVED. `recall` only returns strands whose provenance roots a real
 * source (no provenance → no voice, structurally): an ungrounded strand is never
 * spoken. The engine remains the only thing that mints facts and the model never
 * witnesses — the facade just makes the verbs ergonomic and cites the output.
 *
 * ZERO external deps (node:crypto via the identity layer; node:sqlite via the store).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax` ⇒
 * every type-only import uses `import type`.
 */

import { createHash } from "node:crypto";

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
} from "../core/types.js";
import { asEpochMs } from "../core/types.js";

import type { StrandStore } from "../store/StrandStore.js";
import { createMemoryStore } from "../store/memoryStore.js";
import { createSqliteStore } from "../store/sqliteStore.js";
import type { SqliteStrandStore } from "../store/sqliteStore.js";

import { createSourceIdentityLayer } from "../identity/index.js";
import type {
  SourceIdentityLayer,
  KeyRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  Passport,
} from "../identity/index.js";
import { generatePassport } from "../identity/keys.js";
import type { KeyPair } from "../identity/keys.js";
import { independenceBetween } from "../identity/anchors.js";

import { createIntelligentDb } from "../api.js";
import type {
  IntelligentDb,
  RatificationDeps,
  DisownOptions,
  AdjudicateOptions,
} from "../api.js";
import type { ConsolidationOutcome } from "../forgetting/consolidation.js";
import type { PendingPayload, ResolvedDispute } from "../ratification/pendingLedger.js";
import type { DownstreamDisownResult } from "../ratification/disown.js";

import { createLexicalCueResolver, strandText } from "../recall/cueResolver.js";
import type { Cue, CueResolver, LexicalCueResolverOptions } from "../recall/cueResolver.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A source descriptor for the MULTI-source case. Supply a `stamp` directly, or a
 * `sourceId` the facade will stamp through the identity layer. Omit it entirely and
 * the facade uses the auto-provisioned default agent source.
 */
export interface SourceRef {
  /** An explicit identity stamp (e.g. assembled by a caller managing identity). */
  readonly stamp?: IdentityStamp;
  /** A registered source id to stamp through the identity layer. */
  readonly sourceId?: SourceId;
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
  readonly source?: SourceRef;
}

/** One cited, grounded, prompt-ready fact returned by {@link AgentMemory.recall}. */
export interface CitedFact {
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
}

/** Output of {@link AgentMemory.recall}. */
export interface RecallOutput {
  /** The cited, grounded facts that lit up, most-activated first. */
  readonly facts: CitedFact[];
  /** The halt stamp explaining how/why the walk stopped (never a silent stop). */
  readonly halt: HaltStamp;
}

/** Options for {@link createAgentMemory}. */
export interface AgentMemoryOptions {
  /** SQLite db path for durable memory; in-memory (non-durable) when absent. */
  readonly dbPath?: string;
  /** Cue-resolver tuning (top-K, stopwords, energy floor). */
  readonly resolver?: LexicalCueResolverOptions;
  /**
   * Anchors to bind the auto-provisioned default agent source to. Default `[]`
   * (a bare key — fine for the single-agent case where there is no independence to
   * adjudicate). Supply anchors to give the default source real independence weight.
   */
  readonly defaultSourceAnchors?: readonly AnchorBinding[];
}

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
  ratify(
    strandId: StrandId,
    source?: SourceRef,
    corroboratingStrandIds?: readonly StrandId[],
  ): void;

  /** ADJUDICATE a contradiction over an (entity, attribute). Multi-source case. */
  adjudicate(attribute: AttributeKey, opts?: AdjudicateOptions): ConsolidationOutcome;

  /** RETROACTIVELY DISOWN a fraudulent source (the full undo sweep). */
  disown(sourceId: SourceId, opts?: DisownOptions): DownstreamDisownResult;

  /** The open deferred disputes awaiting a human decision. */
  listPending(): readonly PendingPayload[];

  /** RESOLVE a deferred dispute by an external approver's decision. */
  approve(
    contradictionSetId: ContradictionSetId,
    winnerStrandId: StrandId,
    approver: KeyPair,
    at?: EpochMs,
  ): ResolvedDispute;

  /** Register an additional source (multi-source case) and return its stamp. */
  registerSource(passport: Passport, anchors?: readonly AnchorBinding[]): IdentityStamp;

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
// In-process pillar ports (the lightweight identity wiring the facade owns)
//
// Same shape as smoke.test's pillar mocks, leaning on the REAL anchor math so the
// single-agent case needs no external identity infrastructure. A bare default source
// is sufficient for single-agent; multi-source callers bind anchors via registerSource.
// ---------------------------------------------------------------------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(passport: Passport): void {
      known.add(passport.sourceId);
    },
    sourceIdOf(sourceId: SourceId): SourceId | null {
      return known.has(sourceId) ? sourceId : null;
    },
    has(sourceId: SourceId): boolean {
      return known.has(sourceId);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void {
      const prev = book.get(sourceId) ?? [];
      book.set(sourceId, [...prev, ...anchors]);
    },
    anchorsOf(sourceId: SourceId): readonly AnchorBinding[] {
      return book.get(sourceId) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween(
      a: readonly AnchorBinding[],
      b: readonly AnchorBinding[],
    ): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeReputationLedgerPort(): ReputationLedgerPort {
  // The single-agent facade does not earn/score reputation by default (no external
  // ratifier in the simple case); a fresh source sits at its floor (0).
  return {
    scoreOf(_sourceId: SourceId): Unit {
      return 0 as Unit;
    },
  };
}

function makeStakePort(): StakeLedgerPort {
  return {
    postedFor(_sourceId: SourceId): number {
      return 0;
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
 * the identity layer, the engine, and the lexical cue resolver, then AUTO-PROVISIONS a
 * default agent source (passport → register → stamp) so the single-agent case needs no
 * identity management. The cue resolver rebuilds its index from the store on
 * construction, so a SQLite reopen restores recall.
 */
export function createAgentMemory(opts?: AgentMemoryOptions): AgentMemory {
  const store: StrandStore = opts?.dbPath !== undefined
    ? createSqliteStore(opts.dbPath)
    : createMemoryStore();

  const keys = makeKeyRegistry();
  const anchors = makeAnchorRegistry();
  const identity: SourceIdentityLayer = createSourceIdentityLayer({
    keys,
    anchors,
    reputation: makeReputationLedgerPort(),
    stake: makeStakePort(),
  });

  const engine: IntelligentDb = createIntelligentDb(store, identity);
  const resolver: CueResolver = createLexicalCueResolver(store, opts?.resolver);

  // AUTO-PROVISION the default single-agent source: one passport, registered once,
  // its stamp cached. The single-agent caller never touches identity.
  const defaultPassport: KeyPair = generatePassport();
  identity.register(defaultPassport, [...(opts?.defaultSourceAnchors ?? [])]);
  const defaultStamp: IdentityStamp = identity.stampFor(defaultPassport.sourceId);

  function resolveStamp(source?: SourceRef): IdentityStamp {
    if (source === undefined) return defaultStamp;
    if (source.stamp !== undefined) return source.stamp;
    if (source.sourceId !== undefined) return identity.stampFor(source.sourceId);
    return defaultStamp;
  }

  function citationFor(sourceId: SourceId, observedAt: EpochMs): string {
    const prefix = String(sourceId).slice(0, 12);
    return `source ${prefix} @ ${new Date(observedAt as number).toISOString()}`;
  }

  return {
    defaultSourceId: defaultPassport.sourceId,
    engine,

    remember(input: RememberInput): { id: StrandId } {
      const entity: EntityId =
        input.entity !== undefined
          ? (input.entity as EntityId)
          : deriveEntity(input.text);
      const stamp = resolveStamp(input.source);

      const id = engine.writeFact({
        entity,
        ...(input.attribute !== undefined
          ? { attribute: input.attribute as AttributeKey }
          : {}),
        payload: { text: input.text },
        stamp,
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
          fact: strand.payload,
          text: strandText(strand),
          source: groundingSource,
          citation: citationFor(groundingSource, strand.observedAt),
          activation: lit.activation,
        });
      }

      // Most-activated first (prompt-ready ordering).
      facts.sort((a, b) => b.activation - a.activation);

      return { facts, halt: result.halt };
    },

    ratify(
      strandId: StrandId,
      source?: SourceRef,
      corroboratingStrandIds?: readonly StrandId[],
    ): void {
      const stamp = resolveStamp(source);
      engine.ratify({
        strandId,
        externalStamp: stamp,
        ...(corroboratingStrandIds !== undefined
          ? { corroboratingStrandIds }
          : {}),
      });
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

    approve(
      contradictionSetId: ContradictionSetId,
      winnerStrandId: StrandId,
      approver: KeyPair,
      at?: EpochMs,
    ): ResolvedDispute {
      return engine.approve(contradictionSetId, winnerStrandId, approver, at);
    },

    registerSource(
      passport: Passport,
      sourceAnchors?: readonly AnchorBinding[],
    ): IdentityStamp {
      identity.register(passport, [...(sourceAnchors ?? [])]);
      return identity.stampFor(passport.sourceId);
    },

    stampFor(sourceId: SourceId): IdentityStamp {
      return identity.stampFor(sourceId);
    },

    close(): void {
      const closable = store as Partial<SqliteStrandStore>;
      if (typeof closable.close === "function") closable.close();
    },
  };
}

// Re-export the Cue/CueResolver seam + RatificationDeps for callers wiring the
// multi-source case against this facade.
export type { Cue, CueResolver, RatificationDeps, EpochMs };
// Keep asEpochMs reachable for callers building EpochMs values (single import surface).
export { asEpochMs };
