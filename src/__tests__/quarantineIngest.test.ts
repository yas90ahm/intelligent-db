/**
 * quarantineIngest.test.ts — TRUST-TIERED INGEST (Phase 3): the quarantine gate.
 *
 * THE GAP BEING PINNED: `makeObservedStrand` used to mint EVERY observed strand
 * as LIVE/WARM unconditionally, so a bare-key Sybil's claim entered the web with
 * the same belief status as the deployment owner's. Phase 3 closes it with ONE
 * policy knob ({@link IngestPolicy.quarantineThreshold}, default 0.10): a fact
 * whose FILER's strongest single anchor `independenceWeight` — re-derived from
 * the identity layer, NEVER the caller-supplied stamp — is below the threshold
 * lands {@link FactState.PROVISIONAL} (the EXISTING "visible superposition"
 * state, reused verbatim; no new enum, no new promotion machinery). Exit is
 * ONLY through the existing promotion paths: `ratify()` by an anchor-INDEPENDENT
 * external source (the quarantine-exit gate) or an `approve()` resolution.
 *
 * Each test targets a specific contract of the gate (design doc §4.1):
 *   1. TIER TABLE — BARE_KEY (0.00) and PUBLISHER_UNVERIFIED (0.04) quarantine;
 *      SSO_TENANT_MEMBER (0.12), PUBLISHER_TRACKED (0.18), LOCAL_DOCUMENT
 *      (0.35), OWNER (0.90) land LIVE. All WARM (the grace pin is state-blind).
 *   2. ENGINE-OWNED EVIDENCE (OD-8) — a caller-inflated stamp claiming an OWNER
 *      anchor_set for an UNREGISTERED source still quarantines: the gate reads
 *      `identity.stampFor`, never the (inflatable) caller stamp.
 *   3. PROVISIONAL FLOOD IMPOTENCE (the poisoning headline) — N quarantined
 *      contradictions cannot even ENTER a contradiction set against a LIVE
 *      incumbent (`adjudicate` admits only LIVE members ⇒ NOOP for any N).
 *   4. QUARANTINE EXIT (INDEPENDENT) — a class-disjoint registered ratifier
 *      flips PROVISIONAL→LIVE and earns reputation for the ratification.
 *   5. QUARANTINE EXIT (ECHO DENIED) — the filer itself, or a fleet-correlated
 *      sibling (same configured publisher operator), appends its root but does
 *      NOT flip fact_state ("two strands agreeing from the same root is an
 *      echo, not corroboration" — CLAUDE.md).
 *   6. RECALL VISIBILITY — a PROVISIONAL strand still lights in a walk: the
 *      superposition is SHOWN, never hidden (recall callers see fact_state).
 *   7. ESCAPE HATCH — `quarantineThreshold: 0` restores legacy always-LIVE;
 *      0.5 quarantines even LOCAL_DOCUMENT (0.35) but never OWNER (0.90).
 *   8. RELAY INTERACTION — a low-trust filer relaying a high-trust strand is
 *      STILL quarantined (the SPEAKER's trust gates belief) while the witness's
 *      independence class is still copied (the relay is never fresh
 *      corroboration): both halves of "who speaks" vs "what was consulted".
 *   9. BATCH PARITY — `writeFactsBatch` applies the identical per-fact gate
 *      (batch is never a quarantine bypass).
 *  10. DISOWN INTERACTION — the sweep's demote path handles PROVISIONAL
 *      strands: a quarantined relay DERIVED from a disowned filer's strand is
 *      DEMOTED (PROVISIONAL→DEMOTED, never deleted; archive stub intact). The
 *      disowned filer's OWN seed strand receives the reputation crater, not a
 *      demotion (the established direct-clawback contract pinned by
 *      ratification/disown.test.ts — "the seed itself is the direct clawback,
 *      not a downstream demotion").
 *
 * Everything runs through the public barrel (`../index.js`) plus the two
 * engine-input types from `../api.js` (mirroring relayFix.test.ts); time is
 * pinned to a logical clock so no assertion is wall-clock-dependent. The tier
 * table and batch parity run over BOTH backends (memory + SQLite) — the gate
 * decides `fact_state` at mint time, so the persisted row must carry it too.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";
import { bareStamp } from "../__bench__/fixtures.js";

import {
  ANCHOR_TABLE,
  AnchorClass,
  DEFAULT_QUARANTINE_THRESHOLD,
  EdgeType,
  FactState,
  Tier,
  asEpochMs,
  createIntelligentDb,
  createMemoryStore,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
  createSqliteStore,
  createTrustRegistry,
  repCapFor,
} from "../index.js";

import type {
  AttributeKey,
  EntityId,
  IdentityStamp,
  IngestPolicy,
  IntelligentDb,
  ProvenanceRoot,
  SourceId,
  SourceIdentityLayer,
  Strand,
  StrandId,
  StrandStore,
  TrustRegistryConfig,
  Unit,
} from "../index.js";

import type { WriteFactInput } from "../api.js";

// A controllable logical clock (reputation decay-on-read is pinned to this).
const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- temp db lifecycle (SQLite tests only; mirrors relayFix.test.ts) ----------
//
// On Windows the SQLite file stays locked until the handle is closed, so
// afterEach CLOSES every tracked store FIRST (close-first is load-bearing) and
// only then removes the db + its WAL/SHM siblings.

let paths: string[] = [];
let openStores: StrandStore[] = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-quarantine-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

/** Remember a store so afterEach can close it before removing its file. */
function track<S extends StrandStore>(store: S): S {
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      (store as Partial<{ close(): void }>).close?.();
    } catch {
      // already closed
    }
  }
  for (const base of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- harness -------------------------------------------------------------------

/**
 * One pipeline over ONE trust registry (mirrors cryptoFreeTrust.test.ts's
 * harness): the registry serves BOTH facade ports, reputation is a real Beta
 * ledger repCap'd by the registry's anchors, and the engine gets the full
 * ratification wiring (so a DEFER would land in the human horn, never throw).
 * `ingest` is the Phase-3 knob under test: OMITTED (null) means the default
 * gate at {@link DEFAULT_QUARANTINE_THRESHOLD} — fail-open-forever was the bug.
 */
function makeHarness(
  opts: {
    store?: StrandStore;
    config?: TrustRegistryConfig;
    ingest?: IngestPolicy;
  } = {},
) {
  const store = opts.store ?? createMemoryStore();
  const trust = createTrustRegistry(opts.config);
  const repCapOf = (s: SourceId): Unit => repCapFor([...trust.anchorsOf(s)]);
  const reputation = createReputationLedger(repCapOf, undefined, () => NOW);
  const identity = createSourceIdentityLayer({
    sources: trust,
    anchors: trust,
    reputation: { scoreOf: (s) => reputation.scoreOf(s) },
    // stake omitted: the retired pillar defaults to the constant-zero port.
  });
  const ledger = createPendingLedger({ reputation });
  const systemSource = freshSource().sourceId;
  const engine = createIntelligentDb(
    store,
    identity,
    null,
    reputation,
    { ledger, systemSource },
    opts.ingest ?? null,
  );
  return { store, trust, reputation, identity, ledger, engine };
}

/** Build a WriteFactInput under a bare CARRIER stamp — the gate must not read it. */
function fact(
  src: SourceId,
  payload: unknown,
  attribute: AttributeKey = ATTR,
): WriteFactInput {
  return { entity: ENTITY, attribute, payload, stamp: bareStamp(src) };
}

/** Resolve a stored strand by id, asserting it exists. */
function get(store: StrandStore, id: StrandId): Strand {
  const s = store.getStrand(id);
  expect(s).not.toBeNull();
  return s as Strand;
}

/**
 * Register a LOCAL_DOCUMENT-anchored source through the identity facade's
 * generic register path (the trust registry has no producer for this class;
 * the direct binding feeds `anchorsOf`, which is exactly what the ingest gate
 * reads). Weight comes from the anchor table, never hand-typed.
 */
function registerLocalDocument(identity: SourceIdentityLayer, label: string): SourceId {
  const ref = freshSource(label);
  const w = ANCHOR_TABLE[AnchorClass.LOCAL_DOCUMENT].independenceWeight;
  identity.register(ref, [
    { anchorClass: AnchorClass.LOCAL_DOCUMENT, realizedCost: w, independenceWeight: w },
  ]);
  return ref.sourceId;
}

// --- parametrized over both backends (the gate decides fact_state at mint time) --

const backends: ReadonlyArray<readonly [string, () => StrandStore]> = [
  ["memory", () => track(createMemoryStore())],
  ["sqlite", () => track(createSqliteStore(freshPath("gate")))],
];

// ============================================================================
// 1. TIER TABLE — who quarantines and who does not, at the default threshold
// ============================================================================

describe.each(backends)("1. TIER TABLE over %s store — the default 0.10 gate", (_name, makeStore) => {
  it("BARE_KEY + PUBLISHER_UNVERIFIED land PROVISIONAL; SSO / TRACKED / LOCAL_DOCUMENT / OWNER land LIVE; ALL are WARM-pinned", () => {
    // The default sits exactly at EMAIL_OAUTH's 0.10 rung (strict `<`): only the
    // near-free classes below it are held at the door.
    expect(DEFAULT_QUARANTINE_THRESHOLD).toBe(0.1);

    const { store, trust, identity, engine } = makeHarness({
      store: makeStore(),
      config: { trackedPublishers: ["reuters.example"] },
      // ingest OMITTED on purpose: the default MUST be the gate, not legacy.
    });

    // BARE_KEY (0.00): a raw SourceId that never showed ID at the door.
    const bare = "src:bare-tier" as SourceId;
    // PUBLISHER_UNVERIFIED (0.04): fetched web content, no tenure.
    const sketchy = trust.registerPublisher("https://sketchy-blog.example/post/1").sourceId;
    // SSO_TENANT_MEMBER (0.12): an IdP-verified member — email-grade, but past the gate.
    const sso = trust.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "tenant:acme",
    }).sourceId;
    // PUBLISHER_TRACKED (0.18): a config-listed tenured publisher.
    const tracked = trust.registerPublisher("https://reuters.example/world/story").sourceId;
    // LOCAL_DOCUMENT (0.35): an owner-admitted local file.
    const localDoc = registerLocalDocument(identity, "tier-local-doc");
    // OWNER (0.90): the deployment's ground truth.
    const owner = trust.registerOwner("tier-owner").sourceId;

    const rows: ReadonlyArray<readonly [string, SourceId, FactState]> = [
      ["BARE_KEY", bare, FactState.PROVISIONAL],
      ["PUBLISHER_UNVERIFIED", sketchy, FactState.PROVISIONAL],
      ["SSO_TENANT_MEMBER", sso, FactState.LIVE],
      ["PUBLISHER_TRACKED", tracked, FactState.LIVE],
      ["LOCAL_DOCUMENT", localDoc, FactState.LIVE],
      ["OWNER", owner, FactState.LIVE],
    ];

    for (const [label, src, expected] of rows) {
      const id = engine.writeFact(fact(src, { v: `claim-by-${label}` }, `berlin#${label}` as AttributeKey));
      const s = get(store, id);
      // The gate decides EXACTLY fact_state; everything else about ingest is
      // state-blind — every fresh observed strand is pinned WARM for the grace
      // window, quarantined or not.
      expect(s.fact_state, label).toBe(expected);
      expect(s.tier, label).toBe(Tier.WARM);
    }
  });
});

// ============================================================================
// 2. ENGINE-OWNED EVIDENCE (OD-8) — a caller-inflated stamp buys nothing
// ============================================================================

describe("2. ENGINE-OWNED EVIDENCE — the gate reads identity.stampFor, never the caller's stamp", () => {
  it("an UNREGISTERED source claiming a full OWNER anchor_set in WriteFactInput.stamp still lands PROVISIONAL", () => {
    const { store, identity, engine } = makeHarness();

    // The attacker mints a stamp asserting OWNER-grade anchors for a source the
    // trust registry has never seen — the exact inflation the gate must ignore.
    const ghost = "src:ghost-inflated" as SourceId;
    const ownerWeight = ANCHOR_TABLE[AnchorClass.OWNER].independenceWeight;
    const inflated: IdentityStamp = {
      source_id: ghost,
      anchor_set: [
        {
          anchorClass: AnchorClass.OWNER,
          realizedCost: ownerWeight,
          independenceWeight: ownerWeight,
        },
      ],
      anchor_cost: ownerWeight,
      reputation: 0.9,
      stake_posted: 0,
    };

    // The identity layer's CANONICAL view of the ghost is anchorless (bare).
    expect(identity.stampFor(ghost).anchor_set).toHaveLength(0);

    const id = engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: { v: "smuggled" },
      stamp: inflated,
    });

    // Quarantined regardless of what the caller's stamp asserted.
    expect(get(store, id).fact_state).toBe(FactState.PROVISIONAL);
  });
});

// ============================================================================
// 3. PROVISIONAL FLOOD IMPOTENCE — the poisoning headline
// ============================================================================

describe("3. PROVISIONAL FLOOD — N quarantined contradictions never even enter a dispute", () => {
  it("adjudicate() is NOOP for any N (only LIVE members are admitted); the incumbent stays LIVE", () => {
    const { store, trust, engine } = makeHarness();

    // The incumbent: the OWNER's fact lands LIVE.
    const owner = trust.registerOwner("flood-owner").sourceId;
    const incumbentId = engine.writeFact(fact(owner, { v: "Berlin" }));
    expect(get(store, incumbentId).fact_state).toBe(FactState.LIVE);

    // THE FLOOD: N bare Sybils (each a free mint) assert the same wrong value.
    // Every one of them is held at the door as a visible PROVISIONAL superposition.
    const N = 7;
    const floodIds: StrandId[] = [];
    for (let i = 0; i < N; i++) {
      const id = engine.writeFact(fact(`src:sybil-${i}` as SourceId, { v: "Atlantis" }));
      expect(get(store, id).fact_state).toBe(FactState.PROVISIONAL);
      floodIds.push(id);
    }

    // adjudicate admits only LIVE members: the flood structurally cannot form a
    // contradiction set against the incumbent — ONE live member ⇒ NOOP. This is
    // the contradiction bomb defused a layer EARLIER than reputation: the noise
    // never reaches the adjudicator at all.
    expect(engine.adjudicate(ATTR)).toEqual({ kind: "NOOP" });
    expect(engine.adjudicate(ATTR, { highImpact: true })).toEqual({ kind: "NOOP" });

    // Nothing demoted, nothing deferred, nothing in the human horn.
    expect(get(store, incumbentId).fact_state).toBe(FactState.LIVE);
    expect(get(store, incumbentId).outranked_by).toBeNull();
    for (const id of floodIds) {
      expect(get(store, id).fact_state).toBe(FactState.PROVISIONAL);
    }
    expect(engine.listPending()).toHaveLength(0);
  });
});

// ============================================================================
// 4. QUARANTINE EXIT — an INDEPENDENT ratifier collapses the superposition
// ============================================================================

describe("4. QUARANTINE EXIT (INDEPENDENT) — a class-disjoint registered ratifier flips PROVISIONAL -> LIVE", () => {
  it("the OWNER (anchor-independent of the publisher author) promotes the held claim and earns reputation", () => {
    const { store, trust, reputation, identity, engine } = makeHarness();

    const sketchy = trust.registerPublisher("https://sketchy-blog.example/scoop").sourceId;
    const owner = trust.registerOwner("exit-owner").sourceId;

    // Precondition: genuinely independent sides (disjoint claims, disjoint fleets).
    expect(identity.independentSources(owner, sketchy)).toBe(true);

    const id = engine.writeFact(fact(sketchy, { v: "held-claim" }));
    expect(get(store, id).fact_state).toBe(FactState.PROVISIONAL);

    // The EXISTING promotion path — ratify by an external, independent source.
    engine.ratify({ strandId: id, externalStamp: bareStamp(owner) });

    const after = get(store, id);
    expect(after.fact_state).toBe(FactState.LIVE);
    // The ratifier's root was appended (a real outside witness on the strand).
    expect(after.provenance).toHaveLength(2);
    expect(after.provenance.map((r) => r.sourceId)).toContain(owner);
    expect(after.external_reobservation_count).toBe(1);

    // ... and the ratification EARNED reputation for the external source (the
    // live credit-score pillar is driven by the same verb that raised belief).
    const state = reputation.stateOf(owner);
    expect(state).not.toBeNull();
    expect(state!.ratifiedCount).toBe(1);
    expect(state!.alpha).toBeGreaterThan(1);
  });
});

// ============================================================================
// 5. QUARANTINE EXIT — ECHO DENIED (same root / same fleet is not corroboration)
// ============================================================================

describe("5. QUARANTINE EXIT (ECHO DENIED) — self and fleet-correlated ratifies append but never flip", () => {
  it("the filer itself, then a same-operator publisher sibling, leave the strand PROVISIONAL; a genuine independent still exits", () => {
    // mirror-a and mirror-b are two eTLD+1s behind ONE configured operator (the
    // publisher FLEET axis): distinct source ids, correlated identities.
    const { store, trust, identity, engine } = makeHarness({
      config: {
        operatorOf: (etld1) =>
          ["mirror-a.example", "mirror-b.example"].includes(etld1)
            ? "op:syndicate"
            : etld1,
      },
    });

    const author = trust.registerPublisher("https://mirror-a.example/claim").sourceId;
    const sibling = trust.registerPublisher("https://mirror-b.example/copy").sourceId;
    const owner = trust.registerOwner("echo-owner").sourceId;
    expect(sibling).not.toBe(author); // distinct ids — the echo is in the FLEET
    expect(identity.independentSources(author, sibling)).toBe(false);

    const id = engine.writeFact(fact(author, { v: "echoed-claim" }));
    expect(get(store, id).fact_state).toBe(FactState.PROVISIONAL);

    // (i) SELF-RATIFY: the strand's own author "confirming" it is the purest
    // echo. The root is appended (the consultation is a real event) but belief
    // is withheld — fact_state does not move.
    engine.ratify({ strandId: id, externalStamp: bareStamp(author) });
    let s = get(store, id);
    expect(s.fact_state).toBe(FactState.PROVISIONAL);
    expect(s.provenance).toHaveLength(2);
    expect(s.external_reobservation_count).toBe(1);

    // (ii) FLEET SIBLING: a different source id behind the SAME operator is
    // still an echo (`independentSources` sees the shared operatorClassId).
    engine.ratify({ strandId: id, externalStamp: bareStamp(sibling) });
    s = get(store, id);
    expect(s.fact_state).toBe(FactState.PROVISIONAL);
    expect(s.provenance).toHaveLength(3);
    expect(s.external_reobservation_count).toBe(2);

    // (iii) POSITIVE CONTROL (anti-over-strictness): the OWNER is independent of
    // EVERY provenance source (author + author-echo + sibling), so the exit gate
    // opens — the accumulated echo roots must not poison a genuine exit.
    engine.ratify({ strandId: id, externalStamp: bareStamp(owner) });
    expect(get(store, id).fact_state).toBe(FactState.LIVE);
  });
});

// ============================================================================
// 6. RECALL VISIBILITY — the superposition is SHOWN, never hidden
// ============================================================================

describe("6. RECALL VISIBILITY — a PROVISIONAL strand still lights in a walk", () => {
  it("energy seeded at a LIVE sibling reaches the quarantined strand across the shared-entity join", () => {
    const { store, trust, engine } = makeHarness();

    const owner = trust.registerOwner("recall-owner").sourceId;
    const liveId = engine.writeFact(fact(owner, { v: "Berlin" }));
    const heldId = engine.writeFact(fact("src:anon-tip" as SourceId, { v: "Atlantis" }));
    expect(get(store, heldId).fact_state).toBe(FactState.PROVISIONAL);

    // Seed the LIVE incumbent; the walk derives same-entity siblings from the
    // entity index, so the PROVISIONAL strand must light too — quarantine gates
    // BELIEF (fact_state), never traversability. The caller sees the state and
    // can render the superposition ("Berlin — pending: Atlantis").
    const result = engine.recall({ seeds: [{ strandId: liveId, energy: 1 }] });
    const litIds = result.lit.map((l) => l.strandId);
    expect(litIds).toContain(liveId);
    expect(litIds).toContain(heldId);
    expect(get(store, heldId).fact_state).toBe(FactState.PROVISIONAL); // visible AS held
  });
});

// ============================================================================
// 7. ESCAPE HATCH — the threshold is a policy knob, 0 restores legacy
// ============================================================================

describe("7. ESCAPE HATCH — quarantineThreshold 0 restores always-LIVE; 0.5 holds LOCAL_DOCUMENT but never OWNER", () => {
  it("threshold 0: even a bare source lands LIVE (the explicit legacy opt-out)", () => {
    const { store, engine } = makeHarness({ ingest: { quarantineThreshold: 0 } });
    const id = engine.writeFact(fact("src:bare-legacy" as SourceId, { v: "legacy" }));
    // Strict `<` against 0: nothing has a strongest weight below 0.
    expect(get(store, id).fact_state).toBe(FactState.LIVE);
    expect(get(store, id).tier).toBe(Tier.WARM);
  });

  it("threshold 0.5: LOCAL_DOCUMENT (0.35) quarantines, OWNER (0.90) does not", () => {
    const { store, trust, identity, engine } = makeHarness({
      ingest: { quarantineThreshold: 0.5 },
    });
    const localDoc = registerLocalDocument(identity, "hatch-local-doc");
    const owner = trust.registerOwner("hatch-owner").sourceId;

    const docId = engine.writeFact(fact(localDoc, { v: "from-a-file" }, "berlin#doc" as AttributeKey));
    const ownId = engine.writeFact(fact(owner, { v: "from-the-owner" }, "berlin#own" as AttributeKey));

    expect(get(store, docId).fact_state).toBe(FactState.PROVISIONAL);
    expect(get(store, ownId).fact_state).toBe(FactState.LIVE);
  });
});

// ============================================================================
// 7b. CONSTRUCTION VALIDATION (quarantine-threshold-unvalidated) — the gate's
//     own threshold must itself be a sane number, or it silently defeats itself
// ============================================================================

describe("7b. quarantineThreshold is validated at construction — a bad knob throws, never silently disarms the gate", () => {
  /** The exact createIntelligentDb(...) construction call path (real production code,
   *  not a re-derived assertion) — only `ingest` varies across cases. */
  function construct(quarantineThreshold: number): IntelligentDb {
    const store = createMemoryStore();
    const trust = createTrustRegistry();
    const repCapOf = (s: SourceId): Unit => repCapFor([...trust.anchorsOf(s)]);
    const reputation = createReputationLedger(repCapOf, undefined, () => NOW);
    const identity = createSourceIdentityLayer({
      sources: trust,
      anchors: trust,
      reputation: { scoreOf: (s) => reputation.scoreOf(s) },
    });
    return createIntelligentDb(store, identity, null, reputation, null, {
      quarantineThreshold,
    });
  }

  it("NaN throws (the exact audit repro: NaN < anything is false, silently identical to the always-LIVE escape hatch with zero signal)", () => {
    expect(() => construct(NaN)).toThrow(/quarantineThreshold/);
  });

  it("1.5 (above the [0,1] anchor-weight range) throws", () => {
    expect(() => construct(1.5)).toThrow(/quarantineThreshold/);
  });

  it("-1 (below the [0,1] anchor-weight range) throws", () => {
    expect(() => construct(-1)).toThrow(/quarantineThreshold/);
  });

  it("Infinity / -Infinity throw (non-finite, same failure mode as NaN)", () => {
    expect(() => construct(Infinity)).toThrow(/quarantineThreshold/);
    expect(() => construct(-Infinity)).toThrow(/quarantineThreshold/);
  });

  it("0 (the documented escape hatch) and 0.1 (the default) construct successfully", () => {
    expect(() => construct(0)).not.toThrow();
    expect(() => construct(0.1)).not.toThrow();
  });

  it("the thrown error is the typed InvalidQuarantineThresholdError, catchable by name", () => {
    let caught: unknown;
    try {
      construct(NaN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("InvalidQuarantineThresholdError");
  });
});

// ============================================================================
// 8. RELAY INTERACTION — who SPEAKS gates belief; what was CONSULTED shapes class
// ============================================================================

describe("8. RELAY INTERACTION — a low-trust filer relaying a high-trust strand is quarantined AND class-collapsed", () => {
  it("AGENT_RELAY citing the owner's strand: the relay lands PROVISIONAL, inherits the owner's class, cites the witness", () => {
    const { store, trust, identity, engine } = makeHarness();

    const owner = trust.registerOwner("relay-owner").sourceId;
    const relayer = "src:bare-relayer" as SourceId; // never registered — bare
    const PAYLOAD = { v: "the-owner-said-so" };

    // The high-trust witness: the owner's strand, LIVE.
    const witnessId = engine.writeFact(fact(owner, PAYLOAD));
    expect(get(store, witnessId).fact_state).toBe(FactState.LIVE);

    // The low-trust relay of the SAME claim (echo gate passes ⇒ class copies).
    const relayId = engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: PAYLOAD,
      stamp: bareStamp(relayer),
      causalOrigin: { kind: "AGENT_RELAY", consultedStrandIds: [witnessId] },
    });
    const relay = get(store, relayId);

    // (a) QUARANTINED: the SPEAKER's trust gates belief — relaying a high-trust
    // strand borrows the witness's independence CLASS, never its AUTHORITY.
    expect(relay.fact_state).toBe(FactState.PROVISIONAL);

    // (b) CLASS COLLAPSED: the relay carries the owner's class (marked
    // inherited, filed by the relayer) — never a fresh class of its own...
    expect(relay.provenance).toHaveLength(1);
    expect(String(relay.provenance[0]!.independenceClass)).toBe(`class:${String(owner)}`);
    expect(relay.provenance[0]!.inheritedClass).toBe(true);
    expect(relay.provenance[0]!.sourceId).toBe(relayer);

    // ... with the DERIVATION citation minted (derived → witness) and the MIS
    // over both strands' roots reading ONE witness, not two.
    const cites = store
      .outEdges(relayId)
      .filter((e) => e.edgeType === EdgeType.DERIVATION);
    expect(cites).toHaveLength(1);
    expect(cites[0]!.to).toBe(witnessId);
    const union: ProvenanceRoot[] = [
      ...get(store, witnessId).provenance,
      ...relay.provenance,
    ];
    expect(identity.independentRootCount(union)).toBe(1);
  });
});

// ============================================================================
// 9. BATCH PARITY — writeFactsBatch applies the identical per-fact gate
// ============================================================================

describe.each(backends)("9. BATCH PARITY over %s store — batch is never a quarantine bypass", (_name, makeStore) => {
  it("a mixed-trust batch gates each fact exactly as N writeFact calls would", () => {
    // Two independent rigs with IDENTICAL registrations (producer source ids are
    // deterministic, so the same registrations yield the same sources).
    const mk = () => {
      const h = makeHarness({
        store: makeStore(), // a FRESH store per rig (both backends' factories mint one)
        config: { trackedPublishers: ["reuters.example"] },
      });
      const owner = h.trust.registerOwner("batch-owner").sourceId;
      const sketchy = h.trust.registerPublisher("https://sketchy-blog.example/b").sourceId;
      const sso = h.trust.registerSsoMember({
        issuer: "https://idp.acme.example",
        subject: "batch-agent",
        tenantId: "tenant:acme",
      }).sourceId;
      return { ...h, owner, sketchy, sso };
    };
    const viaBatch = mk();
    const viaOne = mk();

    const inputsFor = (r: ReturnType<typeof mk>): WriteFactInput[] => [
      fact(r.owner, { v: "owner-claim" }, "berlin#b0" as AttributeKey), // 0.90 ⇒ LIVE
      fact("src:bare-batch" as SourceId, { v: "bare-claim" }, "berlin#b1" as AttributeKey), // 0.00 ⇒ PROVISIONAL
      fact(r.sketchy, { v: "sketchy-claim" }, "berlin#b2" as AttributeKey), // 0.04 ⇒ PROVISIONAL
      fact(r.sso, { v: "sso-claim" }, "berlin#b3" as AttributeKey), // 0.12 ⇒ LIVE
    ];
    const expected = [
      FactState.LIVE,
      FactState.PROVISIONAL,
      FactState.PROVISIONAL,
      FactState.LIVE,
    ];

    const batchIds = viaBatch.engine.writeFactsBatch(inputsFor(viaBatch));
    const oneIds = inputsFor(viaOne).map((i) => viaOne.engine.writeFact(i));
    expect(batchIds).toHaveLength(4);

    for (let i = 0; i < 4; i++) {
      const b = get(viaBatch.store, batchIds[i]!);
      const o = get(viaOne.store, oneIds[i]!);
      // Index-for-index: the batch fact carries the SAME gated state as the
      // single-write fact, and both match the tier table.
      expect(b.fact_state, `batch[${i}]`).toBe(expected[i]);
      expect(o.fact_state, `single[${i}]`).toBe(expected[i]);
      expect(b.tier).toBe(Tier.WARM);
      expect(o.tier).toBe(Tier.WARM);
    }
  });
});

// ============================================================================
// 10. DISOWN INTERACTION — the sweep demotes PROVISIONAL strands, never deletes
// ============================================================================

describe("10. DISOWN INTERACTION — a quarantined derivative is DEMOTED (never deleted); the seed gets the crater", () => {
  it("disowning the low-trust filer demotes the PROVISIONAL relay downstream of its strand, PROVISIONAL -> DEMOTED, archive intact", () => {
    const { store, trust, reputation, engine } = makeHarness();

    // Two low-trust unverified publishers: the fraudster and an equally-cheap
    // relayer that rooted its copy in the fraudster's class.
    const fraud = trust.registerPublisher("https://fraud-mill.example/original").sourceId;
    const relayer = trust.registerPublisher("https://copy-farm.example/mirror").sourceId;
    const PAYLOAD = { v: "fabricated-claim" };

    // The fraudster's own strand (the future SEED) — quarantined at the door.
    const seedId = engine.writeFact(fact(fraud, PAYLOAD));
    expect(get(store, seedId).fact_state).toBe(FactState.PROVISIONAL);

    // The relayer's copy: DERIVATION-downstream of the seed, itself quarantined
    // (low-trust filer) and rooted in the fraudster's OWN (non-inherited-at-the-
    // seed) class — the shape the taint BFS demotes.
    const relayId = engine.writeFact({
      entity: ENTITY,
      attribute: ATTR,
      payload: PAYLOAD,
      stamp: bareStamp(relayer),
      causalOrigin: { kind: "AGENT_RELAY", consultedStrandIds: [seedId] },
    });
    const relayBefore = get(store, relayId);
    expect(relayBefore.fact_state).toBe(FactState.PROVISIONAL);
    const hashBefore = relayBefore.content_hash;

    const result = engine.disown(fraud, { at: NOW });

    // The seed was the DIRECT clawback: the fraudster's credit craters to the
    // prior (LCB 0)...
    expect(result.seedClawedBack).toContain(seedId);
    expect(reputation.scoreOf(fraud)).toBe(0);

    // ... and the DOWNSTREAM quarantined relay is DEMOTED: the sweep's demote
    // path handles PROVISIONAL exactly like LIVE (PROVISIONAL -> DEMOTED, an
    // OUTRANKS sentinel explains it, and the strand is NEVER deleted — the
    // archive stub's content_hash + provenance survive).
    expect(result.demotedDownstream).toContain(relayId);
    const relayAfter = get(store, relayId); // still resolvable: never deleted
    expect(relayAfter.fact_state).toBe(FactState.DEMOTED);
    expect(relayAfter.outranked_by).not.toBeNull();
    expect(relayAfter.content_hash).toBe(hashBefore);
    expect(relayAfter.provenance.length).toBeGreaterThan(0);

    // The relayer rooted its copy in the fraudster's own class ⇒ its credit for
    // propagating the fraud is clawed back (class-bounded, per the relay fix).
    expect(result.contradictedSources).toContain(relayer);

    // ESTABLISHED SEED CONTRACT (pinned so a future change is a conscious one):
    // the disowned filer's OWN strand is the direct-clawback target, NOT a
    // downstream demotion — its fact_state is untouched by the sweep (see
    // ratification/disown.test.ts: "The seed itself is the direct clawback,
    // not a downstream demotion"). A quarantined seed therefore REMAINS a
    // visible PROVISIONAL superposition backed by a cratered (LCB-0) source,
    // and its quarantine exit still requires an INDEPENDENT ratifier.
    expect(result.demotedDownstream).not.toContain(seedId);
    expect(get(store, seedId).fact_state).toBe(FactState.PROVISIONAL);

    // Idempotency at the engine seam: a second disown is a clean no-op.
    const again = engine.disown(fraud, { at: NOW });
    expect(again.seedClawedBack).toHaveLength(0);
    expect(again.demotedDownstream).toHaveLength(0);
  });
});
