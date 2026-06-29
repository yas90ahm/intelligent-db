/**
 * reputation.rt1.test.ts — BATCH 4 (RC-1) §5.3 RT-1 NUMERIC acceptance, driven
 * END-TO-END through the PUBLIC ledger API (`createReputationLedger` /
 * `ratify` / `contradict` / `scoreOf`), not raw state literals. This is the
 * "armored-betrayal" acceptance the SPEC blocks on:
 *
 *   1. POST-BETRAYAL revocation — a depth-6 incumbent (real independent anchors)
 *      that suffers ONE w=1 adjudicated contradiction reads LCB ≈ 0.09549 ≪ 0.30,
 *      so its decisive-margin auto-win is revoked.
 *   2. WAIT-OUT immunity — the non-decaying scar means 360 days of dormancy buys
 *      ZERO recovery (the readout is flat), and a shallow betrayer (depth ≤ c·w)
 *      stays at exactly a fresh key's prior (0).
 *   3. RECOVERY IS PRICED IN DEPTH, NOT TIME — it takes ≥4 NEW independent-class
 *      corroborations (depth 6→10) to lift the LCB back above 0.30; +3 still defers.
 *   4. ANTI-GRIEF — a single independence-weighted-≈0 (depth-1 Sybil) contradiction
 *      does NOT scar an honest incumbent (the scar keys on c·w, never headcount).
 *   5. PRICED-NOT-PREVENTED — a depth-1 Sybil FLOOD (N same-class corroborations)
 *      buys NO permanent floor (`floorMass(1) = 0`), no matter how large N.
 *
 * EVERY clock is FIXED and injected; every Δt is controlled EXPLICITLY by moving a
 * mutable `nowMs` the ledger's decay-on-read closure reads — so the numbers are
 * deterministic. The z = √3 calibration pins the prior Beta(1,1) to read EXACTLY 0
 * and the post-betrayal Beta(3,5) to read EXACTLY 0.09549.
 */

import { describe, it, expect } from "vitest";

import { createReputationLedger, DEFAULT_REPUTATION_PARAMS, floorMass, asEpochMs } from "../index.js";

import type { SourceId, Unit, EpochMs } from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const DAY_MS = 86_400_000;
/** A real DOMAIN anchor's rep_cap (0.60). None of the RT-1 numbers bind against it. */
const DOMAIN_CAP = 0.6 as Unit;
const z = Math.sqrt(3);
const c = DEFAULT_REPUTATION_PARAMS.contradictionMultiplier; // 4

/** Closed-form Beta LCB (mean − z·sd) for cross-checking the measured readouts. */
function betaLcb(a: number, b: number): number {
  const sum = a + b;
  const mean = a / sum;
  const variance = (a * b) / (sum * sum * (sum + 1));
  return mean - z * Math.sqrt(variance);
}

/**
 * A ledger over a MUTABLE clock (so Δt is controlled explicitly) whose repCap is a
 * real DOMAIN anchor (0.60). Returns the ledger plus a setter to advance the clock.
 */
function domainLedger() {
  let nowMs = NOW as number;
  const ledger = createReputationLedger(
    () => DOMAIN_CAP,
    DEFAULT_REPUTATION_PARAMS,
    () => asEpochMs(nowMs),
  );
  return {
    ledger,
    at: (days: number) => {
      nowMs = (NOW as number) + days * DAY_MS;
    },
  };
}

/**
 * Build a depth-6 incumbent backed by SIX distinct independent anchor classes
 * (the engine supplies the cumulative `independentRootCount` as `depth`), then let
 * its earned α-evidence settle (decay) so the NON-DECAYING structural depth-floor —
 * not the transient α — is what holds the reputation up at betrayal time. This is
 * the faithful "long-trusted, now-stale, deeply-corroborated incumbent" shape.
 */
function buildDepth6Incumbent(ledger: ReturnType<typeof domainLedger>["ledger"]) {
  // SIX genuinely independent corroborating classes (cumulative depth 1..6), w=1.
  for (let d = 1; d <= 6; d++) ledger.ratify("src:incumbent" as SourceId, NOW, 1, d);
}

// ===========================================================================
// 1. POST-BETRAYAL REVOCATION
// ===========================================================================

describe("RT-1 §5.3 — (1) post-betrayal LCB revocation (through the ledger)", () => {
  it("depth-6 incumbent + ONE w=1 adjudicated contradiction ⇒ LCB ≈ 0.09549 ≪ 0.30", () => {
    const { ledger, at } = domainLedger();
    const src = "src:incumbent" as SourceId;
    buildDepth6Incumbent(ledger);

    // Let the earned α-evidence go stale (≈10 half-lives) so the structural depth-6
    // FLOOR governs the readout, not the transient earned α. (The depth-floor is
    // non-decaying; the α-evidence is not.)
    at(900);
    // ONE high-value (w=1) ADJUDICATED contradiction — the betrayal. scarring=true
    // routes c·w = 4 into the non-decaying scar (β_eff = 1 + 4 = 5; d_eff = 6 − 4 = 2
    // ⇒ alphaFloor = 1 + floorMass(2) = 3).
    ledger.contradict(src, asEpochMs((NOW as number) + 900 * DAY_MS), 1, /* scarring */ true);

    const lcb = ledger.scoreOf(src) as number;
    expect(lcb).toBeCloseTo(0.09549, 4);
    expect(lcb).toBeLessThan(0.3); // the decisive-margin (≥0.30) auto-win is REVOKED
    // Cross-check: the floor pins α_eff = 3, the scar makes β_eff = 5.
    expect(lcb).toBeCloseTo(betaLcb(3, 5), 10);

    const st = ledger.stateOf(src)!;
    expect(st.scarBeta).toBeCloseTo(c * 1, 12); // scar mass = c·w = 4
    expect(st.corroborationDepth).toBe(6); // depth survives the betrayal (structural)
  });

  it("the headline number is EXACTLY 0.09549150281252633 (z = √3, α_eff=3, β_eff=5)", () => {
    const { ledger, at } = domainLedger();
    const src = "src:incumbent" as SourceId;
    buildDepth6Incumbent(ledger);
    at(900);
    ledger.contradict(src, asEpochMs((NOW as number) + 900 * DAY_MS), 1, true);
    // Float-exact against the closed form (no tolerance) — both go through the same
    // Beta(3,5) arithmetic the readout uses.
    expect(ledger.scoreOf(src)).toBe(betaLcb(3, 5) as unknown as Unit);
    expect(betaLcb(3, 5)).toBe(0.09549150281252633);
  });
});

// ===========================================================================
// 2. WAIT-OUT IMMUNITY (the non-decaying scar)
// ===========================================================================

describe("RT-1 §5.3 — (2) wait-out: dormancy buys ZERO recovery", () => {
  it("armored depth-6 betrayer: LCB is FLAT across 360 days and never approaches 0.30", () => {
    const { ledger, at } = domainLedger();
    const src = "src:incumbent" as SourceId;
    buildDepth6Incumbent(ledger);
    at(900);
    ledger.contradict(src, asEpochMs((NOW as number) + 900 * DAY_MS), 1, true);
    const atBetrayal = ledger.scoreOf(src) as number;

    // Probe across a year of further dormancy: the floor + scar are non-decaying, so
    // the betrayer cannot find a decay trough to slip an auto-win through.
    for (const extra of [0, 30, 90, 180, 270, 360]) {
      at(900 + extra);
      const s = ledger.scoreOf(src) as number;
      expect(s).toBeCloseTo(atBetrayal, 10); // identical — zero recovery from waiting
      expect(s).toBeLessThan(0.3);
    }
    // The non-decaying structural fields rode through a year of reads untouched.
    const st = ledger.stateOf(src)!;
    expect(st.scarBeta).toBeCloseTo(4, 12);
    expect(st.corroborationDepth).toBe(6);
  });

  it("a SHALLOW betrayer (depth ≤ c·w) craters to a fresh key's prior (0) and stays ≤ fresh across 360d", () => {
    // A depth-4 incumbent betraying once: d_eff = max(0, 4 − 4) = 0 ⇒ NO floor; the
    // scar makes β_eff = 5 ⇒ LCB(1,5) < 0 ⇒ clamps to EXACTLY 0 = the fresh prior.
    // This is the literal "lying costs at least as much as starting fresh" for a
    // source whose earned depth did not exceed the betrayal's scar mass.
    const { ledger, at } = domainLedger();
    const src = "src:shallow" as SourceId;
    for (let d = 1; d <= 4; d++) ledger.ratify(src, NOW, 1, d); // depth-4
    at(900);
    ledger.contradict(src, asEpochMs((NOW as number) + 900 * DAY_MS), 1, true);

    // A brand-new, never-touched key reads exactly its prior (0) — the comparison bar.
    const fresh = ledger.scoreOf("src:never-seen" as SourceId) as number;
    expect(fresh).toBe(0);

    for (const extra of [0, 90, 180, 360]) {
      at(900 + extra);
      const s = ledger.scoreOf(src) as number;
      expect(s).toBe(0); // pinned at the fresh prior — NOT above it, and never recovers
      expect(s).toBeLessThanOrEqual(fresh);
    }
  });
});

// ===========================================================================
// 3. RECOVERY IS PRICED IN DEPTH, NOT TIME
// ===========================================================================

describe("RT-1 §5.3 — (3) honest recovery needs ≥4 NEW independent classes", () => {
  it("from the depth-6 betrayer: +1,+2,+3 NEW classes stay < 0.30; +4 NEW (depth 10) crosses 0.30", () => {
    const { ledger, at } = domainLedger();
    const src = "src:incumbent" as SourceId;
    buildDepth6Incumbent(ledger);
    at(900);
    ledger.contradict(src, asEpochMs((NOW as number) + 900 * DAY_MS), 1, true);
    expect(ledger.scoreOf(src)).toBeLessThan(0.3); // cratered to 0.09549

    // Re-earn at the SAME (post-betrayal) instant — recovery is bought with NEW
    // independent DEPTH (d_eff = max(0, depth − scarBeta=4)), never with time.
    const tRecover = asEpochMs((NOW as number) + 900 * DAY_MS);
    const lcbAtDepth = (depth: number): number => {
      ledger.ratify(src, tRecover, 1, depth); // a NEW independent class lifts depth
      return ledger.scoreOf(src) as number;
    };

    const d7 = lcbAtDepth(7); // +1 new class, d_eff 3
    const d8 = lcbAtDepth(8); // +2 new classes, d_eff 4
    const d9 = lcbAtDepth(9); // +3 new classes, d_eff 5
    expect(d7).toBeLessThan(0.3);
    expect(d8).toBeLessThan(0.3);
    expect(d9).toBeLessThan(0.3);
    expect(d9).toBeCloseTo(0.29649, 4); // STILL deferred after +3 (just under)
    expect(d9).toBeCloseTo(betaLcb(6, 5), 10);

    const d10 = lcbAtDepth(10); // +4 new classes, d_eff 6 ⇒ alphaFloor 7
    expect(d10).toBeGreaterThan(0.3); // RECOVERED — and only at the 4th new class
    expect(d10).toBeCloseTo(0.3465, 3);
    expect(d10).toBeCloseTo(betaLcb(7, 5), 10);

    // Monotone: each new independent class strictly helped (depth-keyed, not time).
    expect(d8).toBeGreaterThan(d7);
    expect(d9).toBeGreaterThan(d8);
    expect(d10).toBeGreaterThan(d9);
    // The scar itself never healed — recovery was paid entirely in NEW depth.
    expect(ledger.stateOf(src)!.scarBeta).toBeCloseTo(4, 12);
  });
});

// ===========================================================================
// 4. ANTI-GRIEF — a w≈0 (depth-1 Sybil) contradiction cannot scar an honest source
// ===========================================================================

describe("RT-1 §5.3 — (4) anti-grief: a depth-1 Sybil contradiction does NOT scar", () => {
  it("ONE independence-weighted-≈0 contradiction leaves an honest depth-6 incumbent's scar/depth/LCB unchanged", () => {
    const { ledger } = domainLedger();
    const src = "src:honest" as SourceId;
    for (let d = 1; d <= 6; d++) ledger.ratify(src, NOW, 1, d); // honest depth-6
    const before = ledger.scoreOf(src) as number;
    const depthBefore = ledger.stateOf(src)!.corroborationDepth;

    // A griefer mints a depth-1 Sybil whose anchor is correlated with the incumbent's
    // (or with itself) ⇒ the MIS independence weight handed to `contradict` is ≈ 0.
    // The scar charge is c·w ≈ 0, so an honest incumbent is untouched.
    ledger.contradict(src, NOW, 0, /* scarring */ true);

    const st = ledger.stateOf(src)!;
    expect(st.scarBeta).toBeCloseTo(0, 12); // c·0 = 0 — the grief bought no scar
    expect(st.corroborationDepth).toBe(depthBefore); // depth untouched
    expect(ledger.scoreOf(src)).toBeCloseTo(before, 12); // LCB unchanged

    // A FLOOD of such depth-1 Sybil contradictions (the caller is obliged to collapse
    // a same-class flood to one w-weighted call) still moves nothing.
    for (let i = 0; i < 200; i++) ledger.contradict(src, NOW, 0, true);
    expect(ledger.stateOf(src)!.scarBeta).toBeCloseTo(0, 12);
    expect(ledger.scoreOf(src)).toBeCloseTo(before, 12);

    // GUARD (anti-over-fix): a REAL w=1 betrayal of the SAME source DOES scar — the
    // anti-grief gate keys on the independence weight, it is not a blanket immunity.
    ledger.contradict(src, NOW, 1, true);
    expect(ledger.stateOf(src)!.scarBeta).toBeCloseTo(c * 1, 12);
    expect(ledger.scoreOf(src)).toBeLessThan(before);
  });
});

// ===========================================================================
// 5. PRICED-NOT-PREVENTED — a depth-1 Sybil flood buys no floor
// ===========================================================================

describe("RT-1 §5.3 — (5) a depth-1 Sybil flood buys NO permanent floor", () => {
  it("N same-class corroborations leave corroborationDepth = 1 ⇒ floorMass(1) = 0 (no floor)", () => {
    const { ledger } = domainLedger();
    const src = "src:flood" as SourceId;
    // 1000 same-class corroborations: the engine's independentRootCount collapses a
    // same-class flood to ONE independent root (depth 1). Monotone-max keeps it at 1.
    for (let i = 0; i < 1000; i++) ledger.ratify(src, NOW, 0.0001, 1);
    const st = ledger.stateOf(src)!;
    expect(st.corroborationDepth).toBe(1);
    expect(floorMass(st.corroborationDepth)).toBe(0); // no permanent floor switches on

    // The readout is governed ONLY by the (tiny) earned α — there is no floor lifting
    // it. 1000 fresh same-class echoes are loud but weightless.
    const flood = ledger.scoreOf(src) as number;
    expect(flood).toBeLessThan(0.05); // bare-key territory, not a real floor

    // GUARD (priced-not-prevented): a GENUINELY paid ≥2-disjoint-anchor source (the
    // engine supplies depth 2) DOES earn floorMass(2) = 2 and reads strictly higher —
    // so the floor is bought with real independent anchors, never with headcount.
    const honest = "src:paid" as SourceId;
    ledger.ratify(honest, NOW, 1, 2);
    expect(floorMass(ledger.stateOf(honest)!.corroborationDepth)).toBe(2);
    expect(ledger.scoreOf(honest)).toBeGreaterThan(flood);
    expect(ledger.scoreOf(honest)).toBeGreaterThan(0); // a real earned floor (depth-2)
  });
});
