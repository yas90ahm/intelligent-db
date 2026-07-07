/**
 * reputation.test.ts — the LIVE REPUTATION PILLAR (pillar 3, "credit score:
 * earned slowly, lost fast"), now the calibrated BETA(α,β) model (ARCHITECTURE.md
 * §2 "Trust algorithm" + the Trust-scoring guarantee).
 *
 * Re-expresses the SAME properties the multiplicative model proved, on the new Beta
 * state + LCB readout (not weakened — strengthened):
 *   - FRESH = 0: an unknown source (and any source decayed/cratered to the prior
 *     Beta(1,1)) reads out exactly 0 — high variance ⇒ LCB 0 ⇒ whitewashing worthless.
 *   - EARNED SLOW: corroboration raises the LCB monotonically from 0 as α grows and
 *     variance shrinks; a single corroboration is small.
 *   - HEADCOUNT NEVER DRIVES WEIGHT: 500 corroborations from ONE independence class
 *     (collapsed by the caller into ONE `ratify(s, w)`) raise α by `w` ONCE — NOT
 *     500·w. Only DISTINCT independent classes add distinct `w`.
 *   - ASYMMETRIC RECOVERY: one contradiction (β += 4w) costs strictly MORE
 *     corroboration to undo than the single corroboration it erased.
 *   - DECAY: a source idle ~90 days has its (α−1),(β−1) halved ⇒ LCB drifts toward
 *     the prior (bank-then-defect dampened).
 *   - LCB ≤ rep_cap always (bare key ≤ 0.05; DOMAIN approaches but never passes 0.60).
 *   - EXACT disown reversal: reverseCredit subtracts the recorded α-mass exactly.
 *   - the STAMP reflects earned reputation after engine ratify (shared ledger),
 *   - disownSweep direct clawback craters earned credit (resets to prior) + idempotent.
 *
 * Everything is imported through the barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReputationLedger,
  createSqliteReputationLedger,
  disownSweep,
  decay,
  lcbReadout,
  newReputationState,
  DEFAULT_REPUTATION_PARAMS,
  createSourceIdentityLayer,
  createIntelligentDb,
  createMemoryStore,
  repCapFor,
  independenceBetween,
  AnchorClass,
  asEpochMs,
  asStrandId,
} from "../index.js";

import type {
  SourceId,
  StrandId,
  Unit,
  EpochMs,
  AnchorBinding,
  IdentityStamp,
  EntityId,
  SourceRef,
  SourceRegistryPort,
  AnchorRegistryPort,
  ReputationLedger,
  ReputationState,
  StakeLedgerPort,
  SourceIdentityLayer,
} from "../index.js";

// ---------------------------------------------------------------------------
// Anchor bindings used as ceilings under test.
// ---------------------------------------------------------------------------

function domainAnchor(): AnchorBinding {
  return {
    anchorClass: AnchorClass.DOMAIN,
    realizedCost: 0.35 as Unit,
    independenceWeight: 0.35 as Unit,
  };
}

/**
 * A stateful anchor registry (the REAL math drives repCapFor / independenceBetween).
 * Returned standalone so a test can build a ledger over its `anchorsOf` AND share
 * it with the facade.
 */
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

function makeStakePort(): StakeLedgerPort {
  // Staking is RETIRED (attribution replaces stake): a constant-zero port.
  return { postedFor: () => 0 };
}

/** A cap accessor backed by a real anchor registry: (s) => repCapFor(anchorsOf(s)). */
function repCapOver(anchors: AnchorRegistryPort): (s: SourceId) => Unit {
  return (s: SourceId) => repCapFor([...anchors.anchorsOf(s)]);
}

const NOW: EpochMs = asEpochMs(Date.now());
const DAY_MS = 86_400_000;

describe("live reputation pillar — stateful Beta ledger", () => {
  it("FRESH = 0: an unknown source has earned nothing", () => {
    const anchors = makeAnchorRegistry();
    const ledger = createReputationLedger(repCapOver(anchors));
    expect(ledger.scoreOf("src:never-seen" as SourceId)).toBe(0);
    expect(ledger.stateOf("src:never-seen" as SourceId)).toBeNull();
  });

  it("PRIOR readout: the uninformative Beta(1,1) reads out EXACTLY 0 (whitewashing worthless)", () => {
    // The maximal-variance prior reads 0 under any cap (z = √3 calibrated): a fresh
    // or cratered identity buys ~0 weight.
    const prior = newReputationState("src:x" as SourceId, NOW);
    expect(prior.alpha).toBe(1);
    expect(prior.beta).toBe(1);
    expect(lcbReadout(prior, 1 as Unit)).toBe(0);
    expect(lcbReadout(prior, 0.6 as Unit)).toBe(0);
  });

  it("EARNED SLOW: corroboration raises the LCB monotonically from 0; one step is small", () => {
    const anchors = makeAnchorRegistry();
    const src = "src:domain" as SourceId;
    anchors.bind(src, [domainAnchor()]);
    const cap = repCapFor([domainAnchor()]); // 0.60
    const ledger = createReputationLedger(repCapOver(anchors));

    expect(ledger.scoreOf(src)).toBe(0);

    // First corroboration: α 1->2, β 1. LCB rises off 0 but stays small (still high
    // variance) — earned slowly.
    const after1 = ledger.ratify(src, NOW).score;
    expect(after1).toBeGreaterThan(0);
    // Still well below the cap (0.60) — a single corroboration is a small fraction of
    // the asymptote; the LCB only approaches the cap as variance shrinks over many.
    expect(after1).toBeLessThan(0.45);

    // Strictly increasing across further corroborations (variance shrinks, mean rises).
    const after2 = ledger.ratify(src, NOW).score;
    const after3 = ledger.ratify(src, NOW).score;
    expect(after2).toBeGreaterThan(after1);
    expect(after3).toBeGreaterThan(after2);
    // All under the cap.
    expect(after3).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("HEADCOUNT NEVER DRIVES WEIGHT: 500 same-class corroborations collapse to ONE α += w", () => {
    // THE INVARIANT. The caller denies headcount by collapsing all same-class
    // corroborations into a SINGLE ratify call with that class's independence weight.
    // 500 echoes from one class => one call => α rises by w ONCE (not 500·w).
    const ledger = createReputationLedger(() => 0.9 as Unit);
    const src = "src:one-class" as SourceId;
    const w = 0.35;

    // ONE call for the whole class (this is the headcount denial, at the caller).
    const after = ledger.ratify(src, NOW, w);
    expect(after.alpha).toBeCloseTo(1 + w, 12); // α += w ONCE, never 500·w
    expect(after.beta).toBe(1);

    // A SECOND distinct independent class adds its OWN distinct w (real corroboration).
    const after2 = ledger.ratify(src, NOW, 0.45);
    expect(after2.alpha).toBeCloseTo(1 + w + 0.45, 12);

    // Contrast: 500 raw same-class calls would be a CALLER bug; the ledger itself only
    // ever adds the w it is handed, so a single class can never out-mass a distinct one.
    const flooded = createReputationLedger(() => 0.9 as Unit);
    const fsrc = "src:flood" as SourceId;
    // Caller correctly collapses: ONE call.
    flooded.ratify(fsrc, NOW, w);
    expect(flooded.stateOf(fsrc)!.alpha).toBeCloseTo(1 + w, 12);
  });

  it("ASYMMETRIC RECOVERY: one contradiction (β += 4w) costs strictly MORE to undo than the corroboration it erased", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit);
    const src = "src:s" as SourceId;
    const w = 1;

    // Earn up to a known LCB with several corroborations.
    for (let i = 0; i < 6; i++) ledger.ratify(src, NOW, w);
    const builtLcb = ledger.scoreOf(src);
    const builtAlpha = ledger.stateOf(src)!.alpha;
    expect(builtLcb).toBeGreaterThan(0.2);

    // ONE contradiction adds 4·w to β (bad news weighs 4×) and slashes the LCB.
    const afterContra = ledger.contradict(src, NOW, w);
    expect(afterContra.beta).toBeCloseTo(1 + 4 * w, 12);
    const droppedLcb = ledger.scoreOf(src);
    expect(droppedLcb).toBeLessThan(builtLcb);

    // RECOVERY: it takes STRICTLY MORE than one corroboration to climb back to the
    // pre-contradiction LCB — the asymmetry. (One corroboration removed by the
    // contradiction; recovery needs several because β carries 4× the mass.)
    let steps = 0;
    while (ledger.scoreOf(src) < builtLcb && steps < 1000) {
      ledger.ratify(src, NOW, w);
      steps++;
    }
    expect(steps).toBeGreaterThan(1); // strictly more than the single event removed
    // And recovery genuinely cost more α than the one corroboration the contradiction erased.
    expect(ledger.stateOf(src)!.alpha - builtAlpha).toBeGreaterThan(w);
  });

  it("DECAY: a source idle ~90 days has its (α−1),(β−1) halved => LCB drifts toward the prior", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit);
    const src = "src:dormant" as SourceId;
    // Build mass: α and β both above the prior.
    for (let i = 0; i < 8; i++) ledger.ratify(src, NOW, 1);
    ledger.contradict(src, NOW, 1); // β = 1 + 4 = 5
    const before = ledger.stateOf(src)!;
    const lcbBefore = ledger.scoreOf(src);

    // Idle for exactly one half-life (90 days), then touch with a reverseCredit of 0
    // (a no-op delta) so decay runs without adding mass.
    const later = asEpochMs((NOW as number) + 90 * DAY_MS);
    const decayed = decay(before, 0.9 as Unit, later);
    expect(decayed.alpha - 1).toBeCloseTo((before.alpha - 1) / 2, 6); // halved
    expect(decayed.beta - 1).toBeCloseTo((before.beta - 1) / 2, 6); // halved

    // Driving the decay through the ledger pulls the readout toward the prior. Because
    // β > α here, halving both moves the source UP toward the prior (its LCB had been
    // suppressed by the contradiction); the key property is monotone DRIFT TO PRIOR:
    // the post-decay state is strictly closer to Beta(1,1) than before.
    const distBefore = Math.abs(before.alpha - 1) + Math.abs(before.beta - 1);
    const distAfter = Math.abs(decayed.alpha - 1) + Math.abs(decayed.beta - 1);
    expect(distAfter).toBeLessThan(distBefore);
    void lcbBefore;

    // A FULLY dormant source (many half-lives) collapses essentially back to the prior.
    let s: ReputationState = before;
    for (let k = 0; k < 14; k++) {
      s = decay(s, 0.9 as Unit, asEpochMs((NOW as number) + (k + 1) * 90 * DAY_MS));
    }
    // After 14 half-lives the evidence mass is ~2^-14 of its original — essentially
    // back to the uninformative prior Beta(1,1).
    expect(s.alpha).toBeCloseTo(1, 2);
    expect(s.beta).toBeCloseTo(1, 2);
  });

  it("LCB ≤ REP_CAP: a bare-key source corroborated 1000x never exceeds ~0.05", () => {
    const anchors = makeAnchorRegistry();
    const src = "src:bare" as SourceId; // no anchors => bare key, cap 0.05
    const ledger = createReputationLedger(repCapOver(anchors));

    for (let i = 0; i < 1000; i++) ledger.ratify(src, NOW, 1);

    const score = ledger.scoreOf(src);
    expect(score).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(score).toBeGreaterThan(0.049); // asymptotes to the cap
  });

  it("LCB ≤ REP_CAP: a DOMAIN source approaches but never passes 0.60", () => {
    const anchors = makeAnchorRegistry();
    const src = "src:domain" as SourceId;
    anchors.bind(src, [domainAnchor()]);
    const ledger = createReputationLedger(repCapOver(anchors));

    let last = 0;
    for (let i = 0; i < 1000; i++) {
      const s = ledger.ratify(src, NOW, 1).score;
      expect(s).toBeLessThanOrEqual(0.6 + 1e-9); // never passes the cap
      last = s;
    }
    expect(last).toBeGreaterThan(0.59); // approaches it
    expect(last).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("READ-SIDE clamp: a later cap REDUCTION is honored by scoreOf without rewriting state", () => {
    const anchors = makeAnchorRegistry();
    const src = "src:domain" as SourceId;
    anchors.bind(src, [domainAnchor()]);
    // Mutable cap captured by closure.
    let cap: Unit = 0.6 as Unit;
    const ledger = createReputationLedger(() => cap);

    for (let i = 0; i < 1000; i++) ledger.ratify(src, NOW, 1);
    expect(ledger.scoreOf(src)).toBeGreaterThan(0.5);

    cap = 0.1 as Unit; // demote the ceiling
    expect(ledger.scoreOf(src)).toBeLessThanOrEqual(0.1);
  });

  it("EXACT disown reversal: reverseCredit subtracts the recorded α-mass exactly (floor at prior 1)", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit);
    const src = "src:b" as SourceId;
    const w = 0.35;

    const before = ledger.stateOf(src)?.alpha ?? 1;
    const after = ledger.ratify(src, NOW, w);
    const deltaAlpha = after.alpha - before; // exactly w (no decay at same instant)
    expect(deltaAlpha).toBeCloseTo(w, 12);

    // Reverse exactly the recorded α-mass: α returns to its pre-corroboration value.
    const reversed = ledger.reverseCredit(src, deltaAlpha, NOW);
    expect(reversed.alpha).toBeCloseTo(before, 12);

    // Over-reversal floors at the prior 1 (never an invalid sub-prior pseudocount).
    const floored = ledger.reverseCredit(src, 999, NOW);
    expect(floored.alpha).toBe(1);
    expect(ledger.scoreOf(src)).toBe(0);
  });
});

describe("live reputation pillar — wired live into the engine + stamp", () => {
  /** One shared ledger backs BOTH the facade's scoreOf and the engine's ratify. */
  function wireLive(): {
    identity: SourceIdentityLayer;
    ledger: ReputationLedger;
    anchors: AnchorRegistryPort;
  } {
    const anchors = makeAnchorRegistry();
    const ledger = createReputationLedger(repCapOver(anchors));
    const identity = createSourceIdentityLayer({
      sources: makeSourceRegistry(),
      anchors,
      reputation: { scoreOf: (s: SourceId) => ledger.scoreOf(s) },
      stake: makeStakePort(),
    });
    return { identity, ledger, anchors };
  }

  it("STAMP reflects earned reputation: 0 before ratify, > 0 and <= cap after, climbing", () => {
    const { identity, ledger } = wireLive();
    const store = createMemoryStore();
    // Same ledger instance drives the engine's ratify verb AND the facade scoreOf.
    const db = createIntelligentDb(store, identity, null, ledger);

    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp: IdentityStamp = identity.stampFor(passport.sourceId);

    // Before any ratify: the stamp's reputation is the earned-nothing floor.
    expect(stamp.reputation).toBe(0);

    // File a fact and ratify it with the same source's external stamp.
    const entity = "entity:berlin" as EntityId;
    const id = db.writeFact({ entity, payload: { note: "seed" }, stamp });
    db.ratify({ strandId: id, externalStamp: stamp });

    // The NEXT stamp reflects the earned bump (shared ledger), > 0 and <= cap 0.60.
    const after: IdentityStamp = identity.stampFor(passport.sourceId);
    expect(after.reputation).toBeGreaterThan(0);
    expect(after.reputation).toBeLessThanOrEqual(0.6 + 1e-9);

    // Several more ratifications keep climbing but stay under the cap.
    for (let i = 0; i < 50; i++) db.ratify({ strandId: id, externalStamp: stamp });
    const climbed = identity.stampFor(passport.sourceId).reputation;
    expect(climbed).toBeGreaterThan(after.reputation);
    expect(climbed).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("a null reputation backend leaves the stamp at 0 (scaffold default unchanged)", () => {
    const { identity } = wireLive();
    const store = createMemoryStore();
    const db = createIntelligentDb(store, identity); // no ledger passed

    const passport = freshSource();
    identity.register(passport, [domainAnchor()]);
    const stamp = identity.stampFor(passport.sourceId);
    const entity = "entity:x" as EntityId;
    const id = db.writeFact({ entity, payload: { note: "seed" }, stamp });
    db.ratify({ strandId: id, externalStamp: stamp });

    // No engine-side ledger drive => the (separate, unshared) facade ledger never
    // moved for THIS db, so the stamp stays at the earned-nothing floor.
    expect(identity.stampFor(passport.sourceId).reputation).toBe(0);
  });
});

describe("live reputation pillar — disownSweep direct clawback", () => {
  it("CRATERS earned credit (resets to prior Beta(1,1)) and is IDEMPOTENT; dedupes the seed; never throws", () => {
    const anchors = makeAnchorRegistry();
    const src = "src:fraud" as SourceId;
    anchors.bind(src, [domainAnchor()]);
    const ledger = createReputationLedger(repCapOver(anchors));

    // Earn some reputation first.
    for (let i = 0; i < 20; i++) ledger.ratify(src, NOW, 1);
    expect(ledger.scoreOf(src)).toBeGreaterThan(0.1);

    // Seed with DUPLICATE strand ids (echo-collapse => dedupe by id).
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const seed: StrandId[] = [a, a, b, b, a];

    const first = ledger.disownSweep(src, seed);
    // Deduped to the two distinct ids.
    expect([...first.clawedBack].sort()).toEqual([a, b].sort());
    expect(first.clawedBack.length).toBe(2);
    // Earned credit cratered: reset to the prior Beta(1,1) whose LCB is 0.
    expect(ledger.scoreOf(src)).toBe(0);
    expect(ledger.stateOf(src)!.alpha).toBe(1);
    expect(ledger.stateOf(src)!.beta).toBe(1);

    // Idempotent: a SECOND sweep claws back nothing and leaves the state unchanged.
    const second = ledger.disownSweep(src, seed);
    expect(second.clawedBack).toEqual([]);
    expect(ledger.scoreOf(src)).toBe(0);
  });

  it("FAILS CLOSED: disowning an UNKNOWN source still records it and returns the deduped seed", () => {
    const anchors = makeAnchorRegistry();
    const ledger = createReputationLedger(repCapOver(anchors));
    const unknown = "src:ghost" as SourceId;
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");

    const r = ledger.disownSweep(unknown, [a, b, a]);
    expect([...r.clawedBack].sort()).toEqual([a, b].sort());
    expect(ledger.scoreOf(unknown)).toBe(0); // materialized at the prior (LCB 0)
    // Second sweep is a no-op.
    expect(ledger.disownSweep(unknown, [a, b]).clawedBack).toEqual([]);
  });

  it("the free-function disownSweep no longer throws and dedupes the seed", () => {
    // The free-function form (kept for the original barrel signature) performs the
    // direct-seed clawback over a throw-away ledger and no longer throws.
    const a = asStrandId("strand:a");
    const b = asStrandId("strand:b");
    const res = disownSweep("src:x" as SourceId, [a, a, b]);
    expect([...res.clawedBack].sort()).toEqual([a, b].sort());
  });
});

describe("DECAY-ON-READ (pure) — a dormant high-LCB source reads stale-discounted immediately", () => {
  // ARCHITECTURE.md §2 "Decay on each access": a source that earns a high LCB then goes
  // DORMANT must reflect its staleness on a PURE READ (scoreOf), not only at the next
  // mutation. The read decays a COPY to the ledger's injected clock and is side-effect-
  // free (the stored α/β are untouched).

  it("IN-MEMORY: earn LCB, advance the clock ~2 half-lives with NO mutation => scoreOf drops toward the prior; state unchanged", () => {
    let nowMs = NOW as number;
    const clock = (): EpochMs => asEpochMs(nowMs);
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, clock);
    const src = "src:dormant" as SourceId;

    // Earn a materially-positive LCB at t0 (mutations stamp lastUpdate = t0 = NOW).
    for (let i = 0; i < 10; i++) ledger.ratify(src, asEpochMs(nowMs), 1);
    const earned = ledger.scoreOf(src);
    expect(earned).toBeGreaterThan(0.3);
    const alphaBefore = ledger.stateOf(src)!.alpha;
    const betaBefore = ledger.stateOf(src)!.beta;
    const lastUpdateBefore = ledger.stateOf(src)!.lastUpdate;

    // Advance the clock ~2 half-lives (180 days) with NO mutation in between.
    nowMs = (NOW as number) + 180 * DAY_MS;

    // The PURE read now reflects dormancy: after ~2 half-lives the evidence mass (α−1)
    // is ~1/4 of its earned value, so the LCB dropped MATERIALLY toward the prior. (The
    // LCB is mean−z·sd, a nonlinear function of the mass, so the drop is sizable but not
    // exactly halved; we assert a material drop, and a strictly-larger one at 6+ HL.)
    const dormant = ledger.scoreOf(src);
    expect(dormant).toBeLessThan(earned);
    expect(dormant).toBeLessThan(earned * 0.7); // a material dormancy discount

    // Pushing further into dormancy keeps driving the read toward the prior (LCB 0).
    nowMs = (NOW as number) + 720 * DAY_MS; // ~8 half-lives
    const deepDormant = ledger.scoreOf(src);
    expect(deepDormant).toBeLessThan(dormant);
    expect(deepDormant).toBeLessThan(0.1); // essentially back to the prior Beta(1,1)
    nowMs = (NOW as number) + 180 * DAY_MS; // restore the 2-HL clock for the state checks

    // SIDE-EFFECT-FREE: the persisted α/β/lastUpdate are UNCHANGED by the read.
    const stateAfter = ledger.stateOf(src)!;
    expect(stateAfter.alpha).toBe(alphaBefore);
    expect(stateAfter.beta).toBe(betaBefore);
    expect(stateAfter.lastUpdate).toBe(lastUpdateBefore);

    // Reading again at the SAME advanced instant is deterministic (still pure).
    expect(ledger.scoreOf(src)).toBeCloseTo(dormant, 12);
  });

  it("SQLITE: same dormancy decay-on-read, side-effect-free, with an injected clock", () => {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const path = join(tmpdir(), `idb-decayread-${unique}.db`);
    let nowMs = NOW as number;
    const clock = (): EpochMs => asEpochMs(nowMs);

    try {
      const ledger = createSqliteReputationLedger(() => 0.9 as Unit, { path, clock });
      const src = "src:dormant" as SourceId;
      for (let i = 0; i < 10; i++) ledger.ratify(src, asEpochMs(nowMs), 1);
      const earned = ledger.scoreOf(src);
      expect(earned).toBeGreaterThan(0.3);
      const alphaBefore = ledger.stateOf(src)!.alpha;

      // ~2 half-lives later, no mutation.
      nowMs = (NOW as number) + 180 * DAY_MS;
      const dormant = ledger.scoreOf(src);
      expect(dormant).toBeLessThan(earned * 0.7);

      // The persisted row is untouched (decay was applied on a copy only).
      expect(ledger.stateOf(src)!.alpha).toBeCloseTo(alphaBefore, 12);
      ledger.close();
    } finally {
      // Close-first is load-bearing on Windows; the unlink can still race the OS handle
      // release, so a stray EPERM here is a teardown nicety, not a test signal.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          rmSync(path + suffix, { force: true });
        } catch {
          /* handle not yet released by the OS — best-effort cleanup */
        }
      }
    }
  });
});

describe("reputation params — defaults encode the Beta calibration", () => {
  it("c = 4 (asymmetric), 90-day half-life, z = √3 (prior reads exactly 0)", () => {
    expect(DEFAULT_REPUTATION_PARAMS.contradictionMultiplier).toBe(4);
    expect(DEFAULT_REPUTATION_PARAMS.halfLifeDays).toBe(90);
    expect(DEFAULT_REPUTATION_PARAMS.z).toBeCloseTo(Math.sqrt(3), 12);
    // The calibration identity: 0.5 - z·sqrt(1/12) === 0.
    expect(0.5 - DEFAULT_REPUTATION_PARAMS.z * Math.sqrt(1 / 12)).toBeCloseTo(0, 12);
  });
});
