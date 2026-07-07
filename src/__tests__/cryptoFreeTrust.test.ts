/**
 * cryptoFreeTrust.test.ts — ATTACK-SHAPED tests for the CRYPTO-FREE TRUST REGISTRY era.
 *
 * The Phase-2 rebuild removed every piece of owned cryptographic machinery (keypairs,
 * signatures, attestations, Merkle trees, staking) and replaced the identity layer's
 * proof machinery with a CONFIGURED trust registry (identity/trustRegistry.ts — the
 * swappable trust root) plus a tamper-evident CHECKSUM chain (ratification/
 * pendingLedger.ts). This file re-runs the classic attacks against the NEW substrate
 * and pins that none of the load-bearing defenses regressed:
 *
 *   1. CHEAP-TENANT FLOOD — the contradiction bomb, crypto-free: N fresh SSO tenants
 *      are near-free to mint (design doc §4.1's calibration correction), so N fresh
 *      SSO_TENANT_MEMBER sources disputing a tenured incumbent must NEVER resolve
 *      in-graph, regardless of N. The defense is layered and PRICED-NOT-PREVENTED:
 *      fresh cross-tenant sources genuinely ARE pairwise independent (weight 0.12
 *      each) — what stops the flood is that reputation is EARNED (all-LCB-0 fails
 *      the earned gate) and the F4a structural floor + high-impact gate DEFER to a
 *      human rather than let headcount pick a winner.
 *   2. SAME-TENANT ECHO — one tenant's N agents collapse to ONE independent root on
 *      the operatorClassId FLEET axis (echo, not corroboration).
 *   3. PUBLISHER SYNDICATION COLLAPSE — N URLs under one eTLD+1 are ONE source; N
 *      domains behind one configured operator collapse to ~1 independent root; two
 *      genuinely different publishers count 2.
 *   4. GENUINE CORROBORATION POSITIVE CONTROL (anti-over-strictness) — owner +
 *      tracked publisher + system-of-record are three disjoint classes (count 3),
 *      and a decisively-out-earned multi-class winner still AUTO-RESOLVES.
 *   5. UNREGISTERED APPROVER REJECTED — the RC-5 / provenance gates survive
 *      de-crypto: an unregistered approver id fails CLOSED ("no anchor, no
 *      independent voice") and a self-approver (authored a member) is rejected.
 *   6. CHECKSUM-CHAIN INTEGRITY (SQLite, at rest) — a flipped byte in a persisted
 *      ledger row is caught NAMING the first broken seq.
 *   7. ATTRIBUTION-HONESTY EXECUTABLE DISCLOSURE (design doc §7 test 5) — the
 *      DOCUMENTED residual of removing signing: an actor with live write access can
 *      rewrite the chain from seq K forward, re-checksum every record, and
 *      verifyChain() reports ok. The mitigation is the chainHead() CHECKPOINT
 *      exported to access-segregated storage — the rewritten head can never match
 *      the exported one. This test EXECUTES both halves of that disclosure.
 *   8. OWNER TIER SANITY — the mom-and-pop PERSONAL preset: zero config, remember +
 *      recall round-trips, the auto-provisioned owner carries the OWNER anchor, and
 *      a PUBLISHER_UNVERIFIED-stamped contradiction cannot demote the owner's fact
 *      in-graph.
 *
 * Everything runs through the public barrel (`../index.js`); time is pinned to a
 * logical clock so no assertion is wall-clock-dependent. Mirrors the house style of
 * systemCoherence.test.ts / engineAdjudicate.test.ts.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  AnchorClass,
  FactOrigin,
  FactState,
  Tier,
  asEpochMs,
  asStrandId,
  createAgentMemory,
  createIntelligentDb,
  createMemoryStore,
  createPendingLedger,
  createReputationLedger,
  createSourceIdentityLayer,
  createSqlitePendingLedger,
  createTrustRegistry,
  recordPreimage,
  repCapFor,
} from "../index.js";

import type {
  AttributeKey,
  ContradictionSetId,
  EntityId,
  IndependenceClassId,
  LedgerRecord,
  PendingRatification,
  ProvenanceRoot,
  SourceId,
  Strand,
  StrandId,
  TrustRegistryConfig,
  Unit,
} from "../index.js";

// A controllable logical clock (reputation decay-on-read is pinned to this).
const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:berlin" as EntityId;
const ATTR = "berlin#capital_of" as AttributeKey;

// --- temp db lifecycle (SQLite tests only) -----------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshPath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-cryptofree-${unique}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* handle not yet released */
      }
    }
  });
  return p;
}

function openDb(path: string): DatabaseSyncType {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => DatabaseSyncType;
  };
  const db = new DatabaseSync(path);
  // The OWNER of this fresh shared handle sets WAL before any shared-handle
  // ledger constructor borrows it — `createSqlitePendingLedger`'s `{ db }`
  // overload now VERIFIES journal_mode=WAL and throws `SharedHandleNotWalError`
  // otherwise (Wave-2 wal-verification fix).
  db.exec("PRAGMA journal_mode=WAL");
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
  return db;
}

// --- harness -------------------------------------------------------------------

/**
 * One in-memory pipeline over ONE trust registry: the registry serves BOTH facade
 * ports (sameness + independence read from the same book), reputation is a real
 * Beta ledger repCap'd by the registry's anchors, and the engine gets the full
 * ratification wiring (so a DEFER lands in the human horn instead of throwing).
 */
function makeHarness(config?: TrustRegistryConfig) {
  const store = createMemoryStore();
  const trust = createTrustRegistry(config);
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
  const engine = createIntelligentDb(store, identity, null, reputation, {
    ledger,
    systemSource,
  });
  return { store, trust, reputation, identity, ledger, engine };
}

/**
 * Hand-file an OBSERVED strand about (ENTITY, attribute) authored by `sourceId` in a
 * chosen independence class (writeFact derives one class per source; hand-filing keeps
 * multi-class disputes explicit). Mirrors engineAdjudicate.test.ts's fileStrand.
 */
function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  sourceId: SourceId,
  cls: string,
  payload: unknown,
  attribute: AttributeKey = ATTR,
): Strand {
  const root: ProvenanceRoot = {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: NOW,
  };
  const s: Strand = {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute,
    payload,
    content_hash: ("hash:" + JSON.stringify(payload)) as Strand["content_hash"],
    origin: FactOrigin.OBSERVED,
    fact_state: FactState.LIVE,
    tier: Tier.WARM,
    provenance: [root],
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
  store.putStrand(s);
  return s;
}

/** A provenance root in a chosen class, mimicking writeFact's one-class-per-source. */
function rootFor(idRaw: string, sourceId: SourceId, cls: string): ProvenanceRoot {
  return {
    rootId: ("root:" + idRaw) as ProvenanceRoot["rootId"],
    independenceClass: cls as IndependenceClassId,
    sourceId,
    establishedAt: NOW,
  };
}

/** A minimal hand-built pending (for driving the raw ledger in the chain tests). */
function pendingFor(i: number): PendingRatification {
  return {
    contradictionSetId: (`csid:${i}`) as ContradictionSetId,
    attribute: ATTR,
    members: [asStrandId(`strand:m${i}a`), asStrandId(`strand:m${i}b`)],
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

// ============================================================================
// 1. CHEAP-TENANT FLOOD — the contradiction bomb, crypto-free
// ============================================================================

describe("1. CHEAP-TENANT FLOOD — N near-free SSO tenants never overturn a tenured incumbent", () => {
  it("DEFERS (never resolves in-graph) regardless of N; the incumbent stays ranked first", () => {
    for (const n of [3, 25]) {
      const { store, trust, reputation, engine } = makeHarness({
        // The incumbent's tenant holds a registry-CONFIGURED verified custom domain,
        // so the incumbent is DOMAIN-or-better (SSO_TENANT_MEMBER + DOMAIN claims).
        verifiedTenantDomains: { "tenant:incumbent": "incumbent.example" },
      });

      const incumbent = trust.registerSsoMember({
        issuer: "https://idp.incumbent.example",
        subject: "editor",
        tenantId: "tenant:incumbent",
        verifiedCustomDomain: "incumbent.example",
        label: "incumbent",
      }).sourceId;
      // Ratify warm-up: the incumbent EARNS a decisive LCB (>> the 0.20 earned floor
      // and 0.30 decisive margin). Reputation is track record, never headcount.
      for (let i = 0; i < 6; i++) reputation.ratify(incumbent, NOW, 1);
      expect(reputation.scoreOf(incumbent)).toBeGreaterThan(0.5);

      const incumbentStrand = fileStrand(
        store,
        "strand:incumbent",
        incumbent,
        "class:INCUMBENT",
        { v: "Berlin" },
      );

      // THE FLOOD: n fresh SSO_TENANT_MEMBER sources from n FRESH tenants, each a
      // five-minute self-service mint, all asserting the same wrong value.
      const floodStrands: Strand[] = [];
      const floodSources: SourceId[] = [];
      for (let i = 0; i < n; i++) {
        const src = trust.registerSsoMember({
          issuer: `https://idp.mint${i}.example`,
          subject: `bot${i}`,
          tenantId: `tenant:mint${i}`,
        }).sourceId;
        floodSources.push(src);
        floodStrands.push(
          fileStrand(store, `strand:chal${i}`, src, `class:CHAL${i}`, { v: "Atlantis" }),
        );
      }

      // HONEST PREMISE (priced, not prevented): two fresh CROSS-tenant members really
      // ARE pairwise independent — each holds a disjoint 0.12-weight claim. The flood
      // is not defeated by pretending it is correlated; it is defeated by the EARNED
      // gates below. This is the crypto-free restatement of "identity is priced".
      expect(trust.independentSources(floodSources[0]!, floodSources[1]!)).toBe(true);

      // HIGH-IMPACT adjudication: DEFERRED, regardless of n. The web never picks an
      // in-graph winner among disagreeing independents (the hard theorem); a
      // weightless flood (all LCB exactly 0) can never clear the earned gate, and
      // the lone incumbent cannot clear the F4a >= 2-independent-roots floor either
      // — so the ONLY sound outcome is the human horn.
      const outcome = engine.adjudicate(ATTR, { highImpact: true });
      expect(outcome.kind).toBe("DEFERRED");

      // The web decided NOTHING: every member (incumbent AND flood) stays LIVE.
      expect(store.getStrand(incumbentStrand.id)!.fact_state).toBe(FactState.LIVE);
      for (const s of floodStrands) {
        expect(store.getStrand(s.id)!.fact_state).toBe(FactState.LIVE);
      }

      // The human queue ranks by EARNED reputation, never headcount: the incumbent
      // surfaces first no matter how many weightless disputants pile on.
      if (outcome.kind === "DEFERRED") {
        expect(outcome.pending.members[0]).toBe(incumbentStrand.id);
        expect(engine.listPending().map((p) => p.contradictionSetId)).toContain(
          outcome.pending.contradictionSetId,
        );
      }

      // Ordinary (non-high-impact) adjudication ALSO defers — the F4a structural
      // floor is unconditional on the multi-class path, so the flood's failure is
      // structural, not a policy knob. OD-2 coalesces the repeat enqueue (1 pending).
      expect(engine.adjudicate(ATTR).kind).toBe("DEFERRED");
      expect(engine.listPending().length).toBe(1);
    }
  });
});

// ============================================================================
// 2. SAME-TENANT ECHO — the fleet axis collapses one tenant's agents to 1
// ============================================================================

describe("2. SAME-TENANT ECHO — N agents inside ONE tenant are one independent root", () => {
  it("independentRootCount collapses a same-tenant crowd to 1 on the operator axis", () => {
    const { trust, identity } = makeHarness();

    // N agents of ONE tenant (distinct subjects => distinct sourceIds, distinct
    // per-member classIds — exactly what writeFact's one-class-per-source derives).
    const N = 6;
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < N; i++) {
      const src = trust.registerSsoMember({
        issuer: "https://idp.acme.example",
        subject: `agent${i}`,
        tenantId: "tenant:acme",
      }).sourceId;
      roots.push(rootFor(`acme${i}`, src, `class:ACME${i}`));
    }

    // Stage 1 sees N distinct classes; Stage 2's source-aware predicate sees the
    // SHARED operatorClassId (sso-tenant:tenant:acme) => pairwise NOT independent
    // => the exact max-independent-set is 1. Echo, not corroboration.
    expect(identity.independentRootCount(roots)).toBe(1);

    // Contrast (anti-over-strictness): two members of two DIFFERENT tenants are
    // genuinely disjoint (different fleets) and count 2.
    const other = trust.registerSsoMember({
      issuer: "https://idp.globex.example",
      subject: "carol",
      tenantId: "tenant:globex",
    }).sourceId;
    expect(
      identity.independentRootCount([roots[0]!, rootFor("globex", other, "class:GLOBEX")]),
    ).toBe(2);
  });
});

// ============================================================================
// 3. PUBLISHER SYNDICATION COLLAPSE
// ============================================================================

describe("3. PUBLISHER SYNDICATION COLLAPSE — one eTLD+1 / one operator is one witness", () => {
  it("N urls under one eTLD+1 are ONE source; one operator's N domains count ~1; two real publishers count 2", () => {
    const { trust, identity } = makeHarness({
      // The FLEET axis for publishers: three syndication domains behind one operator.
      operatorOf: (etld1) =>
        ["mirror-a.example", "mirror-b.example", "mirror-c.example"].includes(etld1)
          ? "op:syndicate"
          : etld1,
    });

    // (a) N URLs under ONE eTLD+1 collapse to ONE source (sameness, not N witnesses).
    const p1 = trust.registerPublisher("https://mirror-a.example/story/1");
    const p2 = trust.registerPublisher("https://mirror-a.example/archive/2?utm=x");
    const p3 = trust.registerPublisher("mirror-a.example");
    expect(p2.sourceId).toBe(p1.sourceId);
    expect(p3.sourceId).toBe(p1.sourceId);
    // Claim insertion dedupes: no anchor-stacking from re-registration.
    expect(trust.anchorsOf(p1.sourceId)).toHaveLength(1);

    // (b) N DIFFERENT domains behind ONE configured operator collapse to ~1 root.
    const b = trust.registerPublisher("https://mirror-b.example/feed").sourceId;
    const c = trust.registerPublisher("https://mirror-c.example/feed").sourceId;
    expect(trust.independentSources(p1.sourceId, b)).toBe(false);
    expect(trust.independentSources(b, c)).toBe(false);
    expect(
      identity.independentRootCount([
        rootFor("syn-a", p1.sourceId, "class:SYN-A"),
        rootFor("syn-b", b, "class:SYN-B"),
        rootFor("syn-c", c, "class:SYN-C"),
      ]),
    ).toBe(1);

    // (c) Positive control: two GENUINELY different publishers (identity operator,
    // distinct eTLD+1s) are independent and count 2.
    const reuters = trust.registerPublisher("https://reuters.example/world").sourceId;
    const ap = trust.registerPublisher("https://apnews.example/world").sourceId;
    expect(trust.independentSources(reuters, ap)).toBe(true);
    expect(
      identity.independentRootCount([
        rootFor("reuters", reuters, "class:REUTERS"),
        rootFor("ap", ap, "class:AP"),
      ]),
    ).toBe(2);
  });
});

// ============================================================================
// 4. GENUINE CORROBORATION POSITIVE CONTROL (anti-over-strictness)
// ============================================================================

describe("4. GENUINE CORROBORATION — three disjoint classes count 3; a decisive winner auto-resolves", () => {
  it("owner + tracked publisher + system-of-record corroborate to 3, and the earned margin resolves a dispute", () => {
    const { store, trust, reputation, identity, engine } = makeHarness({
      trackedPublishers: ["reuters.example"],
    });

    const owner = trust.registerOwner("deployment-owner").sourceId;
    const pub = trust.registerPublisher("https://reuters.example/world/story").sourceId;
    const sor = trust.registerSystemOfRecord({ name: "workday-hr" }).sourceId;

    // Three disjoint classes AND three disjoint fleets => the exact MIS is 3.
    expect(
      identity.independentRootCount([
        rootFor("own", owner, "class:OWN"),
        rootFor("pub", pub, "class:PUB"),
        rootFor("sor", sor, "class:SOR"),
      ]),
    ).toBe(3);

    // A decisive multi-class dispute CAN auto-resolve (the gate is calibrated, not
    // shut): the owner EARNS a decisive LCB, and a tracked publisher independently
    // co-asserts the same value, so the winner clears every layer — F4a (>= 2
    // mutually independent roots behind the winning VALUE), F4b (>= 1 in-domain
    // co-asserter), M4 (depth margin over the shallow challenger), and the
    // decisive/earned LCB gate.
    for (let i = 0; i < 6; i++) reputation.ratify(owner, NOW, 1);
    expect(reputation.scoreOf(owner)).toBeGreaterThan(0.5);

    const win = fileStrand(store, "strand:win", owner, "class:OWN", { v: "Berlin" });
    const corrob = fileStrand(store, "strand:corrob", pub, "class:PUB", { v: "Berlin" });
    const chal = fileStrand(store, "strand:chal", "src:fresh" as SourceId, "class:CHAL", {
      v: "Tokyo",
    });

    const outcome = engine.adjudicate(ATTR);
    expect(outcome.kind).toBe("RESOLVED");

    // Winner + its agreeing corroborator stay LIVE; only the disagreeing fresh
    // challenger is demoted (DEMOTED + outranked_by — never deleted).
    expect(store.getStrand(win.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(corrob.id)!.fact_state).toBe(FactState.LIVE);
    const demoted = store.getStrand(chal.id)!;
    expect(demoted.fact_state).toBe(FactState.DEMOTED);
    expect(demoted.outranked_by).not.toBeNull();
  });
});

// ============================================================================
// 5. UNREGISTERED APPROVER REJECTED (fail-closed gates survive de-crypto)
// ============================================================================

describe("5. APPROVER GATES — unregistered ids and self-approvers are rejected, fail-closed", () => {
  it("approve() by a never-registered sourceId throws; a member author cannot self-approve", () => {
    const { store, trust, engine, ledger } = makeHarness();

    // A genuine multi-class dispute between two registered cross-tenant members.
    const alice = trust.registerSsoMember({
      issuer: "https://idp.a.example",
      subject: "alice",
      tenantId: "tenant:a",
    });
    const bob = trust.registerSsoMember({
      issuer: "https://idp.b.example",
      subject: "bob",
      tenantId: "tenant:b",
    });
    const a = fileStrand(store, "strand:a", alice.sourceId, "class:A", { v: "Germany" });
    const b = fileStrand(store, "strand:b", bob.sourceId, "class:B", { v: "Atlantis" });

    expect(engine.adjudicate(ATTR).kind).toBe("DEFERRED");
    const csid = engine.listPending()[0]!.contradictionSetId as ContradictionSetId;

    // (i) UNREGISTERED APPROVER: a raw SourceId that never showed ID at the door has
    // no anchors — a BARE-equivalent witness. The provenance gate fails CLOSED
    // ("no anchor, no independent voice"): mere possession of a distinct id string
    // is free and must never be the external second lock.
    expect(() =>
      engine.approve(csid, a.id, "src:ghost" as SourceId, NOW),
    ).toThrow(/no priced anchor/i);

    // (ii) SELF-APPROVAL: alice authored disputed member `a` — the distinct-approver
    // (second-admin) gate rejects her even though she IS registered with an anchor.
    expect(() => engine.approve(csid, b.id, alice.sourceId, NOW)).toThrow(/self-approval/i);

    // Nothing was demoted by either rejected attempt; the dispute is still open.
    expect(store.getStrand(a.id)!.fact_state).toBe(FactState.LIVE);
    expect(store.getStrand(b.id)!.fact_state).toBe(FactState.LIVE);
    expect(engine.listPending().length).toBe(1);

    // (iii) Positive control (anti-over-strictness): a DISTINCT, registered,
    // fleet-disjoint third party clears every gate and resolves the dispute.
    const carol = trust.registerSsoMember({
      issuer: "https://idp.c.example",
      subject: "carol",
      tenantId: "tenant:c",
    });
    const resolved = engine.approve(csid, a.id, carol.sourceId, NOW);
    expect(resolved.winner).toBe(a.id);
    expect(store.getStrand(b.id)!.fact_state).toBe(FactState.DEMOTED);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });
});

// ============================================================================
// 6. CHECKSUM-CHAIN INTEGRITY — a flipped byte at rest is NAMED (SQLite)
// ============================================================================

describe("6. CHECKSUM CHAIN — tampering a persisted row is caught at its exact seq", () => {
  it("verifyChain() names the first broken seq after a raw-SQL byte flip, and re-verifies after restore", () => {
    const db = openDb(freshPath());
    const ledger = createSqlitePendingLedger({ db });
    const systemSource = freshSource().sourceId;

    for (let i = 0; i < 3; i++) ledger.appendPending(pendingFor(i), systemSource);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // TAMPER AT REST: rewrite one field of the persisted seq-1 record behind the
    // ledger's back (raw SQL). The record's own checksum no longer matches its
    // canonical preimage, so the walk breaks EXACTLY there.
    const row = db
      .prepare("SELECT seq, json FROM ratification_records WHERE seq = 1")
      .get() as { seq: number; json: string };
    const rec = JSON.parse(row.json) as LedgerRecord & {
      payload: { attribute: string };
    };
    rec.payload.attribute = "berlin#tampered_attribute";
    db.prepare("UPDATE ratification_records SET json = ? WHERE seq = ?").run(
      JSON.stringify(rec),
      row.seq,
    );
    expect(ledger.verifyChain()).toEqual({ ok: false, firstBrokenSeq: 1 });

    // Side-effect-free check: restoring the original bytes re-verifies green.
    db.prepare("UPDATE ratification_records SET json = ? WHERE seq = ?").run(
      row.json,
      row.seq,
    );
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
  });
});

// ============================================================================
// 7. ATTRIBUTION-HONESTY EXECUTABLE DISCLOSURE (design doc §7 test 5)
// ============================================================================

describe("7. HONEST DISCLOSURE — a write-access rewrite verifies ok; the exported checkpoint catches it", () => {
  it("rewriting the chain from seq K forward (recomputing every checksum) passes verifyChain, but chainHead diverges from the pre-rewrite checkpoint", () => {
    // ── THE ACCEPTED TRADE-OFF, EXECUTED — NOT A FAILURE ──────────────────────
    // Removing signing means `signerSourceId` is ASSERTED attribution and the
    // checksum chain proves only internal consistency AS STORED. An actor with
    // LIVE WRITE ACCESS to the storage can therefore rewrite history from any seq
    // K forward, recompute every sha-256 checksum, and hand `verifyChain()` a
    // green result. That is the pendingLedger module's documented disclosure
    // ("the checksum chain does not, by itself, detect an insider with the pen")
    // and exactly the trade-off the crypto-free design accepted. THE MITIGATION
    // is operational: `chainHead()` checkpoints (`{seq, headHash}` — plain data)
    // exported on a schedule to ACCESS-SEGREGATED external storage the writing
    // process cannot reach. A rewritten chain can never reproduce an exported
    // head, so the comparison below is what actually pins history.
    const db = openDb(freshPath());
    const ledger = createSqlitePendingLedger({ db });
    const systemSource = freshSource().sourceId;

    for (let i = 0; i < 3; i++) ledger.appendPending(pendingFor(i), systemSource);
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // The operator EXPORTS the checkpoint to segregated storage (here: a local
    // copy standing in for the external store the attacker cannot write).
    const exportedCheckpoint = ledger.chainHead();
    const records = ledger.records();
    expect(exportedCheckpoint.seq).toBe(records.length - 1);
    expect(exportedCheckpoint.headHash).toBe(records[records.length - 1]!.thisHash);

    // THE INSIDER REWRITE, from seq K = 1 forward: re-attribute every record to
    // the attacker and recompute each checksum + chain link over the SAME
    // canonical preimage the verifier uses (recordPreimage — one source of truth
    // for "what a record IS").
    const sha256Hex = (s: string): string =>
      createHash("sha256").update(s, "utf8").digest("hex");
    const attacker = "src:insider" as SourceId;
    const update = db.prepare("UPDATE ratification_records SET json = ? WHERE seq = ?");
    let prevHash = records[0]!.thisHash; // seq 0 kept; everything after is rewritten
    for (let seq = 1; seq < records.length; seq++) {
      const relinked: LedgerRecord = {
        ...records[seq]!,
        prevHash,
        signerSourceId: attacker, // history now says the insider authored it
      };
      const thisHash = sha256Hex(recordPreimage(relinked));
      update.run(JSON.stringify({ ...relinked, thisHash }), seq);
      prevHash = thisHash;
    }

    // (a) THE DISCLOSED RESIDUAL: the rewritten chain is internally consistent —
    // verifyChain reports ok. This assertion DOCUMENTS the limit; it is the
    // executable form of the design doc's honesty clause, not a bug.
    expect(ledger.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    expect(
      ledger.records().every((r, i) => i === 0 || r.signerSourceId === attacker),
    ).toBe(true);

    // (b) THE MITIGATION WORKS: the live head can no longer reproduce the
    // exported checkpoint — same seq, DIFFERENT head hash. An operator comparing
    // the segregated copy against the live chain catches the rewrite.
    const headAfterRewrite = ledger.chainHead();
    expect(headAfterRewrite.seq).toBe(exportedCheckpoint.seq);
    expect(headAfterRewrite.headHash).not.toBe(exportedCheckpoint.headHash);
  });
});

// ============================================================================
// 8. OWNER TIER SANITY — the mom-and-pop PERSONAL preset
// ============================================================================

describe("8. OWNER TIER — zero-config personal preset: round-trip, OWNER anchor, and no in-graph demotion of the owner", () => {
  it("remember/recall round-trips, the auto-provisioned owner carries the OWNER anchor, and an unverified publisher cannot demote the owner's fact in-graph", () => {
    // ZERO config: no accounts, no IdP, nothing to configure. The OWNER is the
    // trust root, auto-provisioned by the facade.
    const mem = createAgentMemory();

    // (a) Round-trip: remember, then recall by cue.
    const ROUTER_ATTR = "router#wifi_password" as AttributeKey;
    mem.remember({
      text: "the wifi password is hunter2",
      entity: "entity:router",
      attribute: "router#wifi_password",
    });
    const recalled = mem.recall("wifi password");
    expect(recalled.facts.length).toBeGreaterThan(0);
    expect(recalled.facts.some((f) => f.text.includes("hunter2"))).toBe(true);
    expect(recalled.facts[0]!.source).toBe(mem.defaultSourceId);

    // (b) The auto-provisioned default source IS the deployment OWNER: its stamp
    // carries the OWNER anchor at external-authority grade (0.90 weight).
    const ownerStamp = mem.stampFor(mem.defaultSourceId);
    expect(ownerStamp.anchor_set.some((a) => a.anchorClass === AnchorClass.OWNER)).toBe(true);
    expect(ownerStamp.anchor_cost).toBe(0.9);

    // (c) A PUBLISHER_UNVERIFIED-stamped contradiction (fetched web content, no
    // track record — weight 0.04) contradicts the owner's fact...
    const sketchy = mem.trust.registerPublisher("https://sketchy-blog.example/post/1");
    const sketchyStamp = mem.stampFor(sketchy.sourceId);
    expect(
      sketchyStamp.anchor_set.some((a) => a.anchorClass === AnchorClass.PUBLISHER_UNVERIFIED),
    ).toBe(true);
    expect(sketchyStamp.anchor_cost).toBe(0.04);
    const { id: sketchyFactId } = mem.remember({
      text: "the wifi password is pwned123",
      entity: "entity:router",
      attribute: "router#wifi_password",
      source: { sourceId: sketchy.sourceId },
    });

    // ...and is QUARANTINED at the door (Phase-3 trust-tiered ingest): the
    // publisher's strongest anchor weight (PUBLISHER_UNVERIFIED, 0.04) is below
    // the default 0.10 quarantine threshold, so its claim lands PROVISIONAL —
    // a visible superposition that cannot even ENTER a contradiction set against
    // the owner's LIVE fact. adjudicate sees ONE live member and NOOPs; nothing
    // is demoted, nothing is deferred.
    expect(mem.adjudicate(ROUTER_ATTR)).toEqual({ kind: "NOOP" });

    // Quarantine exits ONLY through the existing promotion paths. The OWNER (an
    // anchor-INDEPENDENT external source — different producer claim, different
    // class/fleet than the publisher) ratifies the held claim PROVISIONAL → LIVE
    // (mem.ratify defaults to the owner source). Now BOTH claims are LIVE...
    mem.ratify(sketchyFactId);

    // ...and the publisher STILL cannot demote the owner's fact in-graph. The two
    // claims sit in different independence classes (one class per source), so this
    // is a genuine independent dispute: the web NEVER picks an in-graph winner —
    // it DEFERS to the human horn, which the facade now WIRES (PHASE 4: the
    // zero-config preset carries a pending ledger, so a deferral is recorded as
    // an open question for the OWNER instead of throwing). Nothing is demoted.
    const outcome = mem.adjudicate(ROUTER_ATTR);
    expect(outcome.kind).toBe("DEFERRED");
    const questions = mem.pendingQuestions();
    expect(questions.length).toBe(1);
    expect(questions[0]!.options.length).toBe(2);

    // The owner's fact is untouched and still spoken, grounded in the owner source.
    const after = mem.recall("wifi password");
    expect(
      after.facts.some(
        (f) => f.text.includes("hunter2") && f.source === mem.defaultSourceId,
      ),
    ).toBe(true);

    mem.close();
  });
});
