/**
 * reconcileDriftApproveRegression.test.ts — Wave-2 hardening,
 * `reconcile-drift-no-default-regression`.
 *
 * THE DOCUMENTED, KNOWN, NON-CRASH DEFECT (CLAUDE.md KNOWN LIMITATIONS,
 * "RECONCILE_DRIFT"; `src/__torture__/invariantChecker.ts`'s
 * `KNOWN_NONCRASH_VIOLATION_KINDS`): every `approve()`-resolved dispute
 * permanently trips `reconcileLedger`'s off-ledger-drift audit for the
 * winner's author. `ratification/pendingLedger.ts`'s `approve()` credits the
 * winning strand's author(s) via `reputation.ratify(author, now)` directly —
 * unlike `api.ts`'s `#ratifyImpl`, which conditionally records a
 * corroboration event carrying the exact applied α-mass — so the credited
 * α-mass has NO recorded corroboration event explaining it. `reconcileLedger`
 * can only see EXPLAINED (recorded) mass; an `approve()` winner's earned mass
 * therefore reads as permanent, unreversible-by-disown off-ledger drift.
 *
 * This defect was previously named ONLY inside the env-gated (`TORTURE=1`)
 * crash-torture suite's `KNOWN_NONCRASH_VIOLATION_KINDS` exclusion list and
 * doc comments ("reproduces in a clean, zero-crash, two-write-one-adjudicate-
 * one-approve repro... verified separately, no SIGKILL involved") — but no
 * committed, NON-GATED regression test ever ran that "verified separately"
 * repro as part of the default suite. This test is that regression: it drives
 * the REAL `db.adjudicate` / `db.approve` engine verbs (never a hand-derived
 * reputation/reconcile computation) through the exact "two write, one
 * adjudicate, one approve" recipe, over a plain in-memory store, with NO
 * SIGKILL / torture harness involved, and asserts the drift is REAL and
 * PRESENT — not "asserted away," and not silently fixed underneath this test
 * without updating it (if `approve()` is ever made to record a corroboration
 * event, this test's `report.ok` assertion will correctly start failing,
 * which is the point: the defect stays NAMED and OBSERVABLE by the default
 * suite instead of living only behind an opt-in env var).
 *
 * NOT FIXED HERE (out of Wave-2 `reconcile-drift-no-default-regression`'s
 * scope, which asks only for the regression test, not a fix): closing this
 * gap for real means giving `PendingLedger.approve()` the same corroboration-
 * event-recording discipline `api.ts`'s `#ratifyImpl` already has, which is a
 * separate, larger behavioral change with its own atomicity/backend
 * considerations.
 */

import { describe, expect, it } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  createCorroborationLedger,
  reconcileLedger,
  independenceBetween,
  FactOrigin,
  FactState,
  Tier,
  AnchorClass,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  AttributeKey,
  EntityId,
  SourceId,
  Unit,
  AnchorBinding,
  ProvenanceRoot,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  SourceRef,
  Strand,
  ContradictionSetId,
  RatificationDeps,
} from "../index.js";

// Import the torture suite's own named exclusion set (NOT to gate this test —
// this test is deliberately NON-gated — but to tie the exact string this
// regression pins to the ONE shared, documented place that vocabulary lives,
// so the two never silently drift apart.
import { KNOWN_NONCRASH_VIOLATION_KINDS } from "../__torture__/invariantChecker.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:reconcile-drift-approve" as EntityId;
const ATTR = "reconcile-drift-approve#claim" as AttributeKey;

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(p: SourceRef): void {
      known.add(p.sourceId);
    },
    sourceIdOf(s: SourceId): SourceId | null {
      return known.has(s) ? s : null;
    },
    has(s: SourceId): boolean {
      return known.has(s);
    },
  };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(s: SourceId, anchors: readonly AnchorBinding[]): void {
      book.set(s, [...(book.get(s) ?? []), ...anchors]);
    },
    anchorsOf(s: SourceId): readonly AnchorBinding[] {
      return book.get(s) ?? [];
    },
    aggregateCost(anchors: readonly AnchorBinding[]): Unit {
      let best = 0;
      for (const a of anchors) if (a.realizedCost > best) best = a.realizedCost;
      return best as Unit;
    },
    independenceBetween(a: readonly AnchorBinding[], b: readonly AnchorBinding[]): Unit {
      return independenceBetween([...a], [...b]);
    },
  };
}

function makeIdentity(reputation: ReputationLedgerPort): SourceIdentityLayer {
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  return createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors: makeAnchorRegistry(),
    reputation,
    stake: stakePort,
  });
}

function fileStrand(
  store: ReturnType<typeof createMemoryStore>,
  idRaw: string,
  sourceId: SourceId,
  cls: string,
  payload: unknown,
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
    attribute: ATTR,
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

describe("RECONCILE_DRIFT (documented, non-crash, known defect) — default-suite regression", () => {
  it("names it explicitly in the shared torture vocabulary", () => {
    // Sanity: the string this test pins is the SAME one the torture suite
    // already excludes as a known, pre-existing, non-crash violation kind —
    // one shared vocabulary, never two independently-typed strings.
    expect(KNOWN_NONCRASH_VIOLATION_KINDS.has("RECONCILE_DRIFT")).toBe(true);
  });

  it("a clean, zero-crash, two-write-one-adjudicate-one-approve run through the REAL engine trips reconcileLedger's RECONCILE_DRIFT for the winner's author", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9, undefined, () => NOW);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const corroboration = createCorroborationLedger();
    const systemSource = freshSource().sourceId;
    const ratification: RatificationDeps = {
      ledger,
      systemSource,
      corroboration,
    };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    // TWO WRITES: a genuine multi-class dispute (distinct independence classes,
    // so the hard theorem forbids an in-graph winner and adjudicate() DEFERS).
    const winnerSourceId = "src:winner" as SourceId;
    const loserSourceId = "src:loser" as SourceId;
    const winnerStrand = fileStrand(store, "strand:winner", winnerSourceId, "class:winner", {
      v: "Germany",
    });
    fileStrand(store, "strand:loser", loserSourceId, "class:loser", { v: "Atlantis" });
    identity.register({ ...freshSource(), sourceId: winnerSourceId } as SourceRef, [
      { anchorClass: AnchorClass.VERIFIED_HUMAN, realizedCost: 0.7 as Unit, independenceWeight: 0.7 as Unit },
    ]);
    identity.register({ ...freshSource(), sourceId: loserSourceId } as SourceRef, [
      { anchorClass: AnchorClass.HARDWARE_ATTESTATION, realizedCost: 0.45 as Unit, independenceWeight: 0.45 as Unit },
    ]);

    // ONE ADJUDICATE: deferred to the human horn (the only theorem-honest outcome).
    expect(db.adjudicate(ATTR).kind).toBe("DEFERRED");

    // ONE APPROVE: a distinct, anchor-independent external approver resolves it.
    const approver = freshSource();
    identity.register(approver, [
      { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit },
    ]);
    const csid = ledger.listPending()[0]!.contradictionSetId as ContradictionSetId;
    const resolved = db.approve(csid, winnerStrand.id, approver.sourceId, NOW);
    expect(resolved.winner).toBe(winnerStrand.id);

    // The winner's author DID earn real, live reputation from this approve —
    // the credit is genuine, not a no-op.
    const winnerAlpha = reputation.stateOf(winnerSourceId)?.alpha ?? 1;
    expect(winnerAlpha).toBeGreaterThan(1);
    expect(reputation.scoreOf(winnerSourceId)).toBeGreaterThan(0);

    // ...but NO corroboration event was recorded for it — approve()'s credit
    // path is silent to the corroboration ledger entirely (zero events total).
    expect(corroboration.all()).toHaveLength(0);

    // THE DEFECT, PROVEN LIVE: reconcileLedger sees earned mass with NOTHING
    // recorded to explain it, and flags RECONCILE_DRIFT for the winner's
    // author. This is exactly `KNOWN_NONCRASH_VIOLATION_KINDS`'s documented
    // "RECONCILE_DRIFT" — reproduced here with a REAL db.adjudicate/db.approve
    // call, zero SIGKILL, zero torture harness, as part of the DEFAULT suite.
    const report = reconcileLedger(
      [{ sourceId: winnerSourceId, alpha: winnerAlpha }],
      corroboration,
    );
    expect(report.ok).toBe(false);
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0]!.sourceId).toBe(winnerSourceId);
    expect(report.drifted[0]!.explained).toBe(0); // nothing recorded at all
    expect(report.drifted[0]!.gap).toBeGreaterThan(0); // earned > explained, unreversible
  });
});
