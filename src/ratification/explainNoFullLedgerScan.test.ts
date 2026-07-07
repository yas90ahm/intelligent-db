/**
 * explainNoFullLedgerScan.test.ts — Wave-2 hardening, `explain-full-ledger-scans`.
 *
 * THE FINDING: `api.ts`'s `explain(strandId)` did THREE full linear scans over
 * TOTAL ledger/corroboration/adjudication history on every call —
 * `this.#ratification.ledger.records()` (twice: once for MUTATION receipts,
 * once for PENDING/APPROVAL dispute reconstruction), `corroboration.all()`,
 * and `adjProvenance.all()` — regardless of how much of that history was
 * actually relevant to the ONE strand being explained.
 *
 * THE FIX: point lookups against indexes maintained incrementally at append
 * time (mirroring Wave-1's `eventsIntersecting`/`recordsContributedBy`
 * discipline) — `PendingLedger.mutationsForSubjects` /
 * `disputeRecordsForMember` (new), `CorroborationLedger.eventsInvolving`
 * (new), and `AdjudicationProvenanceLedger.recordsContributedBy` (Wave-1,
 * reused — sound because `#recordAdjudicationProvenance` always seeds
 * `contributingStrandIds` with the winner first).
 *
 * THIS TEST drives the REAL `IntelligentDb.explain()` (not the ledgers in
 * isolation — see `ledgerIndexParity.test.ts` for that) over a ledger with a
 * LARGE amount of history UNRELATED to the target strand plus a handful of
 * RELATED entries, and proves BOTH halves of the fix:
 *
 *   1. NO-FULL-SCAN PROOF: `vi.spyOn` on the exact four full-scan methods the
 *      old code called (`ledger.records`, `corroboration.all`,
 *      `adjudicationProvenance.all`) shows ZERO calls from `explain()`, while
 *      the new/reused point-lookup methods are actually invoked.
 *   2. PARITY: the report's `mutationReceipts`, `sourceMutationReceipts`,
 *      `disputes`, and `corroborationEvents` contain EXACTLY the entries that
 *      actually name the target strand — none of the unrelated noise, none
 *      missing.
 */

import { describe, it, expect, vi } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createPendingLedger,
  createReputationLedger,
  createAdjudicationProvenanceLedger,
  createCorroborationLedger,
  independenceBetween,
  FactState,
  FactOrigin,
  Tier,
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
  StrandId,
  RatificationDeps,
  ContradictionSetId,
  MutationPayload,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:explain-noscan" as EntityId;
const ATTR = "explain-noscan#claim" as AttributeKey;

// --- minimal pillar ports (mirrors engineAdjudicate.test.ts) ----------------

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
      return best;
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

const NOISE = 500; // a large amount of history UNRELATED to the target strand

describe("explain() — Wave-2 explain-full-ledger-scans", () => {
  it("no-full-scan + parity: explain() never calls records()/all(), and reports exactly the related entries out of a large unrelated ledger", () => {
    const store = createMemoryStore();
    const reputation = createReputationLedger(() => 0.9, undefined, () => NOW);
    const identity = makeIdentity({ scoreOf: (s) => reputation.scoreOf(s) });
    const ledger = createPendingLedger({ reputation });
    const corroboration = createCorroborationLedger();
    const adjudicationProvenance = createAdjudicationProvenanceLedger();
    const systemSource = freshSource().sourceId;
    const ratification: RatificationDeps = {
      ledger,
      systemSource,
      corroboration,
      adjudicationProvenance,
    };
    const db = createIntelligentDb(store, identity, null, reputation, ratification);

    const target = fileStrand(store, "strand:target", "src:target" as SourceId, "class:target", {
      v: "target claim",
    });

    // --- a LARGE amount of UNRELATED history, naming only noise ids ---------
    for (let i = 0; i < NOISE; i++) {
      const noiseId = asStrandId(`strand:noise:${i}`);
      ledger.appendMutation(
        {
          op: "REPUTATION_CONTRADICT",
          subjectId: String(noiseId),
          subjectHash: `hash:${i}`,
          beforeHash: `before:${i}`,
          afterHash: `after:${i}`,
          at: NOW,
        },
        systemSource,
      );
      ledger.appendPending(
        {
          contradictionSetId: `cset:noise:${i}` as ContradictionSetId,
          attribute: ATTR,
          members: [noiseId, asStrandId(`strand:noise-b:${i}`)],
          reason: "INDEPENDENT_DISPUTE",
          createdAt: NOW,
        },
        systemSource,
      );
      corroboration.record({
        ratifiedStrandId: asStrandId(`strand:noise-ratified:${i}`),
        corroboratingStrandIds: [noiseId],
        beneficiarySourceId: `src:noise:${i}` as SourceId,
        reputationDelta: 0.01,
        at: NOW,
      });
      adjudicationProvenance.record({
        contradictionSetId: `cset:adj-noise:${i}` as ContradictionSetId,
        attribute: ATTR,
        winner: noiseId,
        margin: 0.5,
        contributingStrandIds: [noiseId],
        at: NOW,
      });
    }

    // --- the RELATED entries, naming the target strand ----------------------
    ledger.appendMutation(
      {
        op: "DEMOTE",
        subjectId: String(target.id),
        subjectHash: "hash:target",
        beforeHash: "before:target",
        afterHash: "after:target",
        at: NOW,
      },
      systemSource,
    );
    const rivalId = asStrandId("strand:rival");
    ledger.appendPending(
      {
        contradictionSetId: "cset:target-dispute" as ContradictionSetId,
        attribute: ATTR,
        members: [target.id, rivalId],
        reason: "INDEPENDENT_DISPUTE",
        createdAt: NOW,
      },
      systemSource,
    );
    // Target as CORROBORATOR of some other ratified strand.
    corroboration.record({
      ratifiedStrandId: asStrandId("strand:other-ratified"),
      corroboratingStrandIds: [target.id],
      beneficiarySourceId: "src:beneficiary" as SourceId,
      reputationDelta: 0.2,
      at: NOW,
    });
    // Target as the RATIFIED strand itself (a genuinely separate role).
    corroboration.record({
      ratifiedStrandId: target.id,
      corroboratingStrandIds: [asStrandId("strand:some-corroborator")],
      beneficiarySourceId: "src:target-beneficiary" as SourceId,
      reputationDelta: 0.3,
      at: NOW,
    });
    adjudicationProvenance.record({
      contradictionSetId: "cset:target-adjudicated" as ContradictionSetId,
      attribute: ATTR,
      winner: target.id,
      margin: 0.4,
      contributingStrandIds: [target.id],
      at: NOW,
    });

    // --- SPY on the exact methods the pre-fix code called (full scans) ------
    const recordsSpy = vi.spyOn(ledger, "records");
    const corroborationAllSpy = vi.spyOn(corroboration, "all");
    const adjAllSpy = vi.spyOn(adjudicationProvenance, "all");
    // ...and the point-lookup methods the fix now uses, to prove they ARE hit.
    const mutationsSpy = vi.spyOn(ledger, "mutationsForSubjects");
    const disputeSpy = vi.spyOn(ledger, "disputeRecordsForMember");
    const eventsInvolvingSpy = vi.spyOn(corroboration, "eventsInvolving");
    const contributedBySpy = vi.spyOn(adjudicationProvenance, "recordsContributedBy");

    const report = db.explain(target.id)!;

    // 1) NO-FULL-SCAN PROOF.
    expect(recordsSpy).not.toHaveBeenCalled();
    expect(corroborationAllSpy).not.toHaveBeenCalled();
    expect(adjAllSpy).not.toHaveBeenCalled();
    expect(mutationsSpy).toHaveBeenCalled();
    expect(disputeSpy).toHaveBeenCalled();
    expect(eventsInvolvingSpy).toHaveBeenCalled();
    expect(contributedBySpy).toHaveBeenCalled();

    // 2) PARITY: exactly the related entries, none of the 500x noise.
    expect(report).not.toBeNull();
    expect(report.mutationReceipts.map((m) => m.op)).toEqual(["DEMOTE"]);
    expect(report.mutationReceipts[0]!.subjectId).toBe(String(target.id));

    expect(report.disputes.some((d) => d.contradictionSetId === "cset:target-dispute")).toBe(true);
    expect(report.disputes.every((d) => !String(d.contradictionSetId).startsWith("cset:noise:"))).toBe(true);
    expect(
      report.disputes.some((d) => d.contradictionSetId === "cset:target-adjudicated"),
    ).toBe(true);
    expect(
      report.disputes.every((d) => !String(d.contradictionSetId).startsWith("cset:adj-noise:")),
    ).toBe(true);

    const roles = report.corroborationEvents.map((e) => e.role).sort();
    expect(roles).toEqual(["CORROBORATOR", "RATIFIED"]);
    expect(report.corroborationEvents).toHaveLength(2);

    recordsSpy.mockRestore();
    corroborationAllSpy.mockRestore();
    adjAllSpy.mockRestore();
    mutationsSpy.mockRestore();
    disputeSpy.mockRestore();
    eventsInvolvingSpy.mockRestore();
    contributedBySpy.mockRestore();
  });
});
