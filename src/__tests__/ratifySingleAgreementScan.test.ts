/**
 * ratifySingleAgreementScan.test.ts — Wave-2 hardening, `ratify-double-agreement-scan`.
 *
 * THE FINDING: `api.ts`'s `ratify()` computed the IDENTICAL O(entity-strand-count)
 * agreement-set scan TWICE per call for the SAME target strand — once internally
 * inside `#R(strand)` (which derives `#deriveAgreementSet(target)` to union
 * agreeing strands' provenance roots before counting independent roots), and once
 * again explicitly as `const corroborating = this.#deriveAgreementSet(strand)` a
 * few lines later, to build the corroboration event's `corroboratingStrandIds`.
 * SUBTLER-THAN-THE-ONE-LINER: the SAME pattern (call `#R(strand)` then separately
 * `#deriveAgreementSet(strand)` again) was ALSO present in `explain()` — not named
 * by the one-liner, but the identical root cause on a second call site, fixed here
 * too.
 *
 * THE FIX: `#R` now accepts an OPTIONAL pre-computed `agreementSet`; both
 * `#ratifyImpl` and `explain()` derive the set ONCE and hand it into `#R`,
 * eliminating the redundant scan without changing `#R`'s signature for its other
 * (pre-existing, unaffected) call sites.
 *
 * THIS TEST proves BOTH halves against the REAL production verbs:
 *   1. SINGLE COMPUTATION: `#deriveAgreementSet` always calls
 *      `store.strandsByEntity(target.entity)` exactly once per invocation (the
 *      one place it does its O(entity-strand-count) work) — spying on that PUBLIC
 *      store method during a real `db.ratify()` / `db.explain()` call is a
 *      black-box proxy for "how many times was the agreement set derived".
 *      Pre-fix this fires TWICE per call; post-fix, ONCE.
 *   2. PARITY: `ratify()`'s recorded corroboration event and reputation delta,
 *      and `explain()`'s `independentRootCount` / `agreementStrandIds`, are
 *      unchanged by the fix.
 */

import { describe, it, expect, vi } from "vitest";

import { freshSource } from "../testSupport/identityFixtures.js";

import {
  createIntelligentDb,
  createMemoryStore,
  createSourceIdentityLayer,
  createReputationLedger,
  createCorroborationLedger,
  createPendingLedger,
  repCapFor,
  independenceBetween,
  AnchorClass,
  asEpochMs,
} from "../index.js";

import type {
  AnchorBinding,
  AnchorRegistryPort,
  EntityId,
  IdentityStamp,
  RatificationDeps,
  ReputationLedger,
  ReputationLedgerPort,
  SourceId,
  SourceIdentityLayer,
  SourceRef,
  SourceRegistryPort,
  StakeLedgerPort,
  Unit,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ENTITY = "entity:ratify-single-scan" as EntityId;

function domainAnchor(): AnchorBinding {
  return { anchorClass: AnchorClass.DOMAIN, realizedCost: 0.35 as Unit, independenceWeight: 0.35 as Unit };
}

function makeAnchorRegistry(): AnchorRegistryPort {
  const book = new Map<SourceId, readonly AnchorBinding[]>();
  return {
    bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void {
      book.set(sourceId, [...(book.get(sourceId) ?? []), ...anchors]);
    },
    anchorsOf(sourceId: SourceId): readonly AnchorBinding[] {
      return book.get(sourceId) ?? [];
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

function makeSourceRegistry(): SourceRegistryPort {
  const known = new Set<SourceId>();
  return {
    register(passport: SourceRef): void {
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

/** A fresh, reputation-bearing engine wired with a real corroboration ledger. */
function makeEngine(): {
  store: ReturnType<typeof createMemoryStore>;
  identity: SourceIdentityLayer;
  reputation: ReputationLedger;
  db: ReturnType<typeof createIntelligentDb>;
} {
  const store = createMemoryStore();
  const anchors = makeAnchorRegistry();
  const reputation = createReputationLedger(
    (s: SourceId) => repCapFor([...anchors.anchorsOf(s)]),
    undefined,
    () => NOW,
  );
  const repPort: ReputationLedgerPort = { scoreOf: (s) => reputation.scoreOf(s) };
  const stakePort: StakeLedgerPort = { postedFor: () => 0 };
  const identity = createSourceIdentityLayer({
    sources: makeSourceRegistry(),
    anchors,
    reputation: repPort,
    stake: stakePort,
  });
  const ledger = createPendingLedger({ reputation });
  const corroboration = createCorroborationLedger();
  const ratification: RatificationDeps = {
    ledger,
    systemSource: freshSource().sourceId,
    corroboration,
  };
  const db = createIntelligentDb(store, identity, null, reputation, ratification);
  return { store, identity, reputation, db };
}

describe("ratify()/explain() — Wave-2 ratify-double-agreement-scan", () => {
  it("ratify(): #deriveAgreementSet's O(entity-strand-count) work (store.strandsByEntity) runs exactly ONCE per call, with unchanged corroboration + reputation results", () => {
    const { store, identity, db } = makeEngine();

    // The AUTHOR: files the target claim.
    const author = freshSource();
    identity.register(author, [domainAnchor()]);
    const authorStamp: IdentityStamp = identity.stampFor(author.sourceId);
    const target = db.writeFact({ entity: ENTITY, payload: { v: "hello" }, stamp: authorStamp });

    // A SEPARATE, genuinely agreeing LIVE strand about the SAME (entity, value) —
    // the exact shape #deriveAgreementSet unions in (fp-1's under-count fix).
    const agreer = freshSource();
    identity.register(agreer, [domainAnchor()]);
    const agreerStamp: IdentityStamp = identity.stampFor(agreer.sourceId);
    const corroboratorId = db.writeFact({
      entity: ENTITY,
      payload: { v: "hello" },
      stamp: agreerStamp,
    });

    // The EXTERNAL ratifier — anchor-independent of the author (a fresh, distinct
    // source), so the ratify genuinely raises reputation (deltaAlpha > 0).
    const ratifier = freshSource();
    identity.register(ratifier, [domainAnchor()]);
    const ratifierStamp: IdentityStamp = identity.stampFor(ratifier.sourceId);

    const spy = vi.spyOn(store, "strandsByEntity");
    db.ratify({ strandId: target, externalStamp: ratifierStamp });

    // 1) SINGLE COMPUTATION: exactly one O(entity-strand-count) scan, not two.
    const calls = spy.mock.calls.filter(([e]) => e === ENTITY);
    expect(calls).toHaveLength(1);
    spy.mockRestore();

    // 2) PARITY: the recorded corroboration event still names the separate
    //    agreeing strand, with a real positive reputation delta.
    const explainReport = db.explain(target)!;
    expect(explainReport.corroborationEvents).toHaveLength(1);
    const ev = explainReport.corroborationEvents[0]!;
    expect(ev.role).toBe("RATIFIED");
    expect(ev.reputationDelta).toBeGreaterThan(0);
    expect(explainReport.agreementStrandIds).toEqual([corroboratorId]);
    expect(identity.stampFor(ratifier.sourceId).reputation).toBeGreaterThan(0);
  });

  it("explain(): store.strandsByEntity runs exactly ONCE per call (independentRootCount + agreementStrandIds share one scan)", () => {
    const { store, identity, db } = makeEngine();

    const author = freshSource();
    identity.register(author, [domainAnchor()]);
    const authorStamp: IdentityStamp = identity.stampFor(author.sourceId);
    const target = db.writeFact({ entity: ENTITY, payload: { v: "hello" }, stamp: authorStamp });

    const agreer = freshSource();
    identity.register(agreer, [domainAnchor()]);
    const agreerStamp: IdentityStamp = identity.stampFor(agreer.sourceId);
    const corroboratorId = db.writeFact({
      entity: ENTITY,
      payload: { v: "hello" },
      stamp: agreerStamp,
    });

    const spy = vi.spyOn(store, "strandsByEntity");
    const report = db.explain(target)!;
    const calls = spy.mock.calls.filter(([e]) => e === ENTITY);
    expect(calls).toHaveLength(1);
    spy.mockRestore();

    expect(report.agreementStrandIds).toEqual([corroboratorId]);
    expect(report.independentRootCount).toBeGreaterThanOrEqual(1);
  });
});
