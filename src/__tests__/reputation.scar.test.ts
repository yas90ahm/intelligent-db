/**
 * reputation.scar.test.ts — BATCH 4 (RC-1) acceptance: the M2 non-decaying
 * DEPTH-FLOOR, the M3 non-decaying independence-WEIGHTED SCAR (the RT-1 resolution),
 * and their composition (the §5.3 numeric gate). Every quantity is keyed on MIS
 * DEPTH or independence-weighted MASS (`c·w`) — NEVER headcount / α-magnitude /
 * age / arrival (the OD-3 spine).
 *
 * All clocks are FIXED (injected `() => NOW`) so decay-on-read is deterministic.
 *
 * The §5.3 numeric gate (z = √3): with the PRIMARY lever = depth-suppression
 * (`d_eff = max(0, corroborationDepth − scarBeta)`) and the M2 floor `alphaFloor =
 * 1 + floorMass(d_eff)`, a depth-6 incumbent suffering ONE high-value (w=1)
 * adjudicated betrayal (scarBeta = c·w = 4) reads `α_eff=3, β_eff=5 ⇒ LCB ≈ 0.09549
 * ≪ 0.30` — the auto-win is revoked and cannot be waited out.
 */

import { describe, it, expect } from "vitest";

import {
  createReputationLedger,
  lcbReadout,
  floorMass,
  scarCapReduction,
  decay,
  newReputationState,
  DEFAULT_REPUTATION_PARAMS,
  asEpochMs,
} from "../index.js";

import type { ReputationState, SourceId, Unit, EpochMs } from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const DAY_MS = 86_400_000;
const DOMAIN_CAP = 0.6 as Unit;
const z = Math.sqrt(3);

/** Closed-form Beta LCB (mean − z·sd) for cross-checking the readout numbers. */
function betaLcb(a: number, b: number): number {
  const sum = a + b;
  const mean = a / sum;
  const variance = (a * b) / (sum * sum * (sum + 1));
  return mean - z * Math.sqrt(variance);
}

/** Build a ReputationState literal with the M2/M3 fields, defaulting the rest. */
function state(partial: Partial<ReputationState>): ReputationState {
  return {
    sourceId: "src:s" as SourceId,
    alpha: 1,
    beta: 1,
    score: 0 as Unit,
    ratifiedCount: 0,
    contradictedCount: 0,
    lastContradictionAt: null,
    lastUpdate: NOW,
    corroborationDepth: 0,
    scarBeta: 0,
    ...partial,
  };
}

// ===========================================================================
// §5.3 — THE BLOCKING NUMERIC GATE
// ===========================================================================

describe("BATCH 4 §5.3 — the numeric gate (z = √3)", () => {
  it("1. POST-BETRAYAL REVOCATION: depth-6 + one w=1 adjudicated betrayal ⇒ LCB ≈ 0.09549 ≪ 0.30", () => {
    // scarBeta = c·w = 4 ⇒ d_eff = 6 − 4 = 2 ⇒ alphaFloor = 1 + floorMass(2) = 3;
    // beta_eff = 1 + 4 = 5. The auto-win (>= 0.30 decisive margin) is REVOKED.
    const post = state({ corroborationDepth: 6, scarBeta: 4 });
    const lcb = lcbReadout(post, DOMAIN_CAP) as number;
    expect(lcb).toBeCloseTo(0.09549, 4);
    expect(lcb).toBeLessThan(0.3);
    // Cross-check against the closed-form α_eff=3, β_eff=5.
    expect(lcb).toBeCloseTo(betaLcb(3, 5), 10);
  });

  it("2. CAP-ONLY INSUFFICIENCY (negative control): α=7,β=5 ⇒ 0.3465 > 0.30 (why the primary lever is depth-suppression)", () => {
    // With NO depth-suppression a depth-6 floor pins α=7; β carries the betrayal mass=5.
    // The mean branch reads 0.3465 > 0.30 — a cap-ONLY M3 fails to revoke the auto-win.
    // Modelled as d_eff = 6 (scar does NOT suppress depth): corroborationDepth=6, scarBeta=0,
    // and β manually carrying the betrayal's 4.
    const capOnly = state({ corroborationDepth: 6, scarBeta: 0, beta: 5 });
    const lcb = lcbReadout(capOnly, DOMAIN_CAP) as number;
    expect(lcb).toBeCloseTo(0.3465, 3);
    expect(lcb).toBeGreaterThan(0.3); // PROVES cap-only / no-suppression is insufficient
    expect(lcb).toBeCloseTo(betaLcb(7, 5), 10);
  });

  it("3a. WAIT-OUT: non-decaying d_eff/β_eff ⇒ LCB unchanged across 360d dormancy (zero recovery from waiting)", () => {
    // An armored betrayer whose earned α has residual mass; after long dormancy α decays
    // toward the prior but the NON-DECAYING floor pins α_eff and β_eff, so the readout is
    // IDENTICAL — waiting buys nothing.
    const armored = state({ alpha: 3, beta: 1, corroborationDepth: 6, scarBeta: 4, lastUpdate: NOW });
    const before = lcbReadout(armored, DOMAIN_CAP) as number;
    const waited = decay(armored, DOMAIN_CAP, asEpochMs((NOW as number) + 360 * DAY_MS));
    const after = lcbReadout(waited, DOMAIN_CAP) as number;
    expect(after).toBeCloseTo(before, 10); // within float ε
    expect(after).toBeCloseTo(0.09549, 4);
    expect(after).toBeLessThan(0.3);
    // The non-decaying fields rode through decay untouched.
    expect(waited.scarBeta).toBe(4);
    expect(waited.corroborationDepth).toBe(6);
  });

  it("3b. WAIT-OUT (fully suppressed): a depth ≤ c·w betrayer craters to the fresh prior 0 and stays there", () => {
    // depth-4 betrayer, scarBeta = 4 ⇒ d_eff = 0 ⇒ alphaFloor = 1; β_eff = 5 ⇒ LCB(1,5)
    // = −0.077 → clamps to EXACTLY 0 (the fresh prior). 360d later: still 0.
    const crushed = state({ alpha: 1, beta: 1, corroborationDepth: 4, scarBeta: 4 });
    expect(lcbReadout(crushed, DOMAIN_CAP)).toBe(0);
    const waited = decay(crushed, DOMAIN_CAP, asEpochMs((NOW as number) + 360 * DAY_MS));
    expect(lcbReadout(waited, DOMAIN_CAP)).toBe(0);
    expect(betaLcb(1, 5)).toBeLessThan(0); // documents the sub-zero (clamped to the prior)
  });

  it("4. RECOVERY IS PRICED IN DEPTH, NOT TIME: +3 NEW classes still < 0.30; +4 NEW ≥ 0.30", () => {
    // scarBeta stays 4 (non-decaying); only NEW independent DEPTH raises d_eff.
    const plus3 = state({ corroborationDepth: 9, scarBeta: 4 }); // d_eff = 5 ⇒ alphaFloor 6
    const plus4 = state({ corroborationDepth: 10, scarBeta: 4 }); // d_eff = 6 ⇒ alphaFloor 7
    const l3 = lcbReadout(plus3, DOMAIN_CAP) as number;
    const l4 = lcbReadout(plus4, DOMAIN_CAP) as number;
    expect(l3).toBeCloseTo(0.29649, 4);
    expect(l3).toBeLessThan(0.3); // +3 new classes: STILL deferred
    expect(l4).toBeCloseTo(0.3465, 3);
    expect(l4).toBeGreaterThan(0.3); // +4 new classes: recovered — needs >= 4 NEW classes
  });

  it("5. ANTI-GRIEF: one independence-weighted-≈0 (w≈0) Sybil contradiction leaves scarBeta/d_eff/LCB unchanged", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
    const src = "src:honest" as SourceId;
    // Earn a depth-6 floor honestly.
    ledger.ratify(src, NOW, 1, 6);
    const before = ledger.scoreOf(src);
    const depthBefore = ledger.stateOf(src)!.corroborationDepth;

    // A Sybil / anchor-correlated contradiction carries w ≈ 0 ⇒ c·w ≈ 0 ⇒ no scar.
    ledger.contradict(src, NOW, 0, /* scarring */ true);
    const st = ledger.stateOf(src)!;
    expect(st.scarBeta).toBeCloseTo(0, 12); // c·0 = 0: the scar did not move
    expect(st.corroborationDepth).toBe(depthBefore);
    expect(ledger.scoreOf(src)).toBeCloseTo(before, 12); // LCB unchanged
  });

  it("6. PURITY: scoreOf is side-effect-free — two reads return the identical value and mutate nothing", () => {
    let nowMs = NOW as number;
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => asEpochMs(nowMs));
    const src = "src:pure" as SourceId;
    ledger.ratify(src, NOW, 1, 6);
    ledger.contradict(src, NOW, 1, true); // scar
    const snapshot = ledger.stateOf(src)!;
    nowMs = (NOW as number) + 180 * DAY_MS; // advance the read clock (decay-on-read)

    const r1 = ledger.scoreOf(src);
    const r2 = ledger.scoreOf(src);
    expect(r2).toBe(r1); // deterministic, identical
    // The persisted state (incl. the non-decaying fields) is UNTOUCHED by the reads.
    const after = ledger.stateOf(src)!;
    expect(after.alpha).toBe(snapshot.alpha);
    expect(after.beta).toBe(snapshot.beta);
    expect(after.scarBeta).toBe(snapshot.scarBeta);
    expect(after.corroborationDepth).toBe(snapshot.corroborationDepth);
    expect(after.lastUpdate).toBe(snapshot.lastUpdate);
  });
});

// ===========================================================================
// PRESERVATION — priced-not-prevented + first-arrival-safe + honesty control
// ===========================================================================

describe("BATCH 4 — preservation invariants", () => {
  it("7. DEPTH-1 SYBIL FLOOD buys NO floor: N same-class corroborations leave corroborationDepth=1 ⇒ floorMass(1)=0", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
    const src = "src:sybil" as SourceId;
    // 500 same-class corroborations: the engine collapses them to ONE independent root
    // (depth 1). We model that as repeated ratify(depth=1) — monotone-max keeps it at 1.
    for (let i = 0; i < 500; i++) ledger.ratify(src, NOW, 0.0001, 1);
    expect(ledger.stateOf(src)!.corroborationDepth).toBe(1);
    // floorMass(1) = 0: no permanent floor. The readout is whatever the (tiny) earned α
    // gives — NOT boosted by any floor (alphaFloor = 1).
    const st = ledger.stateOf(src)!;
    expect(floorMass(st.corroborationDepth)).toBe(0);
    // A depth-1 state reads IDENTICALLY to a depth-0 state at the same α/β (no floor).
    const d0 = lcbReadout(state({ alpha: st.alpha, beta: st.beta, corroborationDepth: 0 }), 0.9 as Unit);
    const d1 = lcbReadout(state({ alpha: st.alpha, beta: st.beta, corroborationDepth: 1 }), 0.9 as Unit);
    expect(d1).toBe(d0);
  });

  it("8. FIRST-ARRIVAL-SAFE: a fresh-true depth-6 and a 5-yr-incumbent depth-6 get the SAME floor; a depth-1 planted-false gets NONE", () => {
    // Both armored states have α decayed to the prior; the floor depends ONLY on depth,
    // never on lastUpdate / arrival.
    const fresh = state({ alpha: 1, beta: 1, corroborationDepth: 6, lastUpdate: NOW });
    const aged = state({ alpha: 1, beta: 1, corroborationDepth: 6, lastUpdate: asEpochMs((NOW as number) - 1825 * DAY_MS) });
    const lFresh = lcbReadout(fresh, DOMAIN_CAP) as number;
    const lAged = lcbReadout(aged, DOMAIN_CAP) as number;
    expect(lFresh).toBeCloseTo(lAged, 12); // identical — depth-keyed, not age/arrival-keyed
    expect(lFresh).toBeGreaterThan(0.3); // a genuine depth-6 floor (alphaFloor = 7)
    // A first-arriving planted-false with depth 1 gets NO floor.
    const planted = state({ alpha: 1, beta: 1, corroborationDepth: 1 });
    expect(lcbReadout(planted, DOMAIN_CAP)).toBe(0);
  });

  it("9. HONESTY CONTROL: a genuinely paid >= 2-disjoint-anchor (depth-2) source DOES earn floorMass(2)=2", () => {
    expect(floorMass(2)).toBe(2);
    const paid = state({ alpha: 1, beta: 1, corroborationDepth: 2 }); // alphaFloor = 3
    const lcb = lcbReadout(paid, 0.9 as Unit) as number;
    expect(lcb).toBeCloseTo(betaLcb(3, 1), 10);
    expect(lcb).toBeGreaterThan(0); // a real earned floor (depth-2 switches the floor on)
    // Strictly above a depth-1 source at the same α/β (which earns NO floor).
    const depth1 = lcbReadout(state({ alpha: 1, beta: 1, corroborationDepth: 1 }), 0.9 as Unit) as number;
    expect(lcb).toBeGreaterThan(depth1);
  });
});

// ===========================================================================
// OD-3 — code-level asserts (keyed on depth / c·w ONLY; forbidden inputs absent)
// ===========================================================================

describe("BATCH 4 OD-3 — every quantity keyed on depth / independence-weight ONLY", () => {
  it("10. M2 floorMass is a pure function of DEPTH only (same-class flood ≡ floorMass(1) = 0; not headcount/α/age)", () => {
    // floorMass reads ONLY its depth argument — independent of any α-magnitude / count / age.
    expect(floorMass(0)).toBe(0);
    expect(floorMass(1)).toBe(0); // deadband
    expect(floorMass(2)).toBe(2);
    expect(floorMass(6)).toBe(6);
    expect(floorMass(12)).toBe(12);
    expect(floorMass(13)).toBe(12); // saturates at the cap
    expect(floorMass(100)).toBe(12);
    // depthFrom(N same-class roots) === 1 (the engine collapses a same-class flood to one
    // independent root) ⇒ floorMass === floorMass(1) === 0, no matter how large N is.
    expect(floorMass(1)).toBe(floorMass(1));
    expect(floorMass(1)).toBe(0);
  });

  it("11. M3 scarBeta += c·w keys on independence weight ONLY; 500 same-class contradictions apply w ONCE; arrival/clock-independent", () => {
    const params = DEFAULT_REPUTATION_PARAMS;
    const c = params.contradictionMultiplier;
    // A high-value (w=1) betrayal charges exactly c·1 = 4.
    const ledA = createReputationLedger(() => 0.9 as Unit, params, () => NOW);
    ledA.contradict("src:a" as SourceId, NOW, 1, true);
    expect(ledA.stateOf("src:a" as SourceId)!.scarBeta).toBeCloseTo(c * 1, 12);
    // A w≈0 Sybil charges ≈0 (independence-weighted — NOT headcount).
    const ledB = createReputationLedger(() => 0.9 as Unit, params, () => NOW);
    ledB.contradict("src:b" as SourceId, NOW, 0, true);
    expect(ledB.stateOf("src:b" as SourceId)!.scarBeta).toBeCloseTo(0, 12);
    // 500 same-class contradictions = the CALLER's job to collapse to ONE w-weighted call
    // (headcount denial at the caller). The ledger only ever adds the w it is handed: a
    // SINGLE w=1 call ⇒ scar 4, regardless of arrival index or wall-clock.
    const ledC = createReputationLedger(() => 0.9 as Unit, params, () => NOW);
    const future = asEpochMs((NOW as number) + 99 * DAY_MS);
    ledC.contradict("src:c" as SourceId, future, 1, true); // arrival/time varied — same charge
    expect(ledC.stateOf("src:c" as SourceId)!.scarBeta).toBeCloseTo(c, 12);
    // Bounded by scarCap: many genuine betrayals saturate, never run away.
    const ledD = createReputationLedger(() => 0.9 as Unit, params, () => NOW);
    for (let i = 0; i < 20; i++) ledD.contradict("src:d" as SourceId, NOW, 1, true);
    expect(ledD.stateOf("src:d" as SourceId)!.scarBeta).toBe(params.scarCap);
  });

  it("12. scarCapReduction (secondary g) is a pure function of scarBeta only and saturates at gMax", () => {
    const p = DEFAULT_REPUTATION_PARAMS;
    expect(scarCapReduction(0, p)).toBe(0);
    expect(scarCapReduction(4, p)).toBeCloseTo(0.41873, 4);
    expect(scarCapReduction(1e6, p)).toBeCloseTo(p.gMax, 6); // saturates at gMax
  });
});

// ===========================================================================
// TARGETED NAMED ATTACKS — each with an anti-over-fix guard
// ===========================================================================

describe("BATCH 4 — targeted attacks (each with an anti-over-fix guard)", () => {
  it("ArmoredBetrayal: bank depth-6, defect ⇒ LCB 0.0955; GUARD: an honest never-contradicted depth-6 keeps LCB 0.3465", () => {
    const betrayed = lcbReadout(state({ corroborationDepth: 6, scarBeta: 4 }), DOMAIN_CAP) as number;
    expect(betrayed).toBeCloseTo(0.09549, 4);
    // GUARD (anti-over-fix): an HONEST never-contradicted depth-6 incumbent (no scar,
    // β_eff = 1) keeps the FULL floor — α_eff=7, β_eff=1 reads above the DOMAIN cap, so
    // it clamps to the cap 0.60. Decisively above the betrayed 0.0955 and above 0.30.
    const honest = lcbReadout(state({ corroborationDepth: 6, scarBeta: 0 }), DOMAIN_CAP) as number;
    expect(honest).toBeCloseTo(0.6, 6); // pinned at the DOMAIN cap
    expect(honest).toBeGreaterThan(0.3);
    expect(honest).toBeGreaterThan(betrayed + 0.4);
  });

  it("CrossDomainSpend: the scar (distrust) is GLOBAL ⇒ a betrayal taints the readout everywhere; GUARD: a fresh w=0 Sybil cannot scar", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
    const src = "src:cross" as SourceId;
    ledger.ratify(src, NOW, 1, 6);
    const before = ledger.scoreOf(src);
    ledger.contradict(src, NOW, 1, true); // ONE global adjudicated betrayal
    expect(ledger.scoreOf(src)).toBeLessThan(before); // the global Beta is tainted
    expect(ledger.stateOf(src)!.scarBeta).toBeGreaterThan(0);
    // GUARD: a w≈0 contradiction (the F4b residual — a foreign-attribute Sybil) cannot
    // move the scar; structural per-domain closure is M1 (a follow-on, not over-claimed).
    const honest = "src:cross2" as SourceId;
    ledger.ratify(honest, NOW, 1, 6);
    const h0 = ledger.scoreOf(honest);
    ledger.contradict(honest, NOW, 0, true);
    expect(ledger.scoreOf(honest)).toBeCloseTo(h0, 12);
  });

  it("TrustPacemaker / Decay-Keepalive: same-class re-ratify dodges decay but adds NO floor; GUARD: a NEW class DOES raise it", () => {
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
    const src = "src:pace" as SourceId;
    ledger.ratify(src, NOW, 1, 1); // depth 1
    // Periodic SAME-class keepalive (depth stays 1 by monotone-max) — buys no floor.
    for (let i = 0; i < 50; i++) ledger.ratify(src, NOW, 1, 1);
    expect(ledger.stateOf(src)!.corroborationDepth).toBe(1);
    expect(floorMass(1)).toBe(0);
    // GUARD: a genuine NEW independent class (depth 2) DOES raise the floor.
    ledger.ratify(src, NOW, 1, 2);
    expect(ledger.stateOf(src)!.corroborationDepth).toBe(2);
    expect(floorMass(2)).toBe(2);
  });

  it("Trough-Synchronized-Eclipse: the non-decaying floor+scar remove the time-varying window; GUARD: an honest source is clock-stable", () => {
    let nowMs = NOW as number;
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => asEpochMs(nowMs));
    const src = "src:eclipse" as SourceId;
    ledger.ratify(src, NOW, 1, 6);
    ledger.contradict(src, NOW, 1, true);
    // Probe the readout across many points on the clock — the betrayer cannot find a
    // decay trough to slip the auto-win through: the floor/scar are non-decaying.
    const samples: number[] = [];
    for (const days of [0, 30, 45, 60, 90, 180, 270, 360]) {
      nowMs = (NOW as number) + days * DAY_MS;
      samples.push(ledger.scoreOf(src) as number);
    }
    for (const s of samples) {
      expect(s).toBeCloseTo(samples[0]!, 6); // flat across the whole clock
      expect(s).toBeLessThan(0.3);
    }
    // GUARD: an honest depth-6 source (no scar) is ALSO stable across the clock (its
    // earned α has decayed to the floor, which is non-decaying) — and sits above 0.30.
    const honest = "src:eclipse-h" as SourceId;
    ledger.ratify(honest, NOW, 1, 6);
    nowMs = (NOW as number) + 720 * DAY_MS; // deep dormancy
    expect(ledger.scoreOf(honest)).toBeGreaterThan(0.3); // the floor holds it up
  });

  it("Penance-by-Dormancy: idling does NOT recover a betrayer; GUARD: earning NEW independent depth DOES", () => {
    let nowMs = NOW as number;
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => asEpochMs(nowMs));
    const src = "src:penance" as SourceId;
    ledger.ratify(src, NOW, 1, 6);
    ledger.contradict(src, NOW, 1, true); // scarBeta = 4
    const cratered = ledger.scoreOf(src);
    expect(cratered).toBeLessThan(0.3);
    nowMs = (NOW as number) + 720 * DAY_MS; // wait it out — 8 half-lives
    expect(ledger.scoreOf(src)).toBeCloseTo(cratered, 6); // zero recovery from waiting
    // GUARD: earning >= 4 NEW independent classes (depth 6 → 10) recovers d_eff to 6.
    nowMs = NOW as number;
    ledger.ratify(src, NOW, 1, 10);
    expect(ledger.stateOf(src)!.corroborationDepth).toBe(10);
    expect(ledger.scoreOf(src)).toBeGreaterThan(0.3); // recovered — by DEPTH, not time
  });

  it("Mutual-Keepalive-Ring: colluders' correlated classes collapse to depth 1 ⇒ no floor; GUARD: a disjoint ring earns depth", () => {
    // A ring of colluders ratifying each other shares/correlates anchor classes ⇒ the
    // engine's independentRootCount collapses them to depth 1 ⇒ floorMass(1) = 0.
    const ledger = createReputationLedger(() => 0.9 as Unit, DEFAULT_REPUTATION_PARAMS, () => NOW);
    const ring = "src:ring" as SourceId;
    for (let i = 0; i < 20; i++) ledger.ratify(ring, NOW, 1, 1); // all same collapsed root
    expect(ledger.stateOf(ring)!.corroborationDepth).toBe(1);
    expect(floorMass(ledger.stateOf(ring)!.corroborationDepth)).toBe(0);
    // GUARD: a genuinely anchor-DISJOINT ring (the engine supplies depth 5) earns a floor.
    const disjoint = "src:disjoint" as SourceId;
    ledger.ratify(disjoint, NOW, 1, 5);
    expect(floorMass(ledger.stateOf(disjoint)!.corroborationDepth)).toBe(5);
    expect(ledger.scoreOf(disjoint)).toBeGreaterThan(0.3);
  });

  it("Patient-Zero: a first-arriving planted-false depth-1 gets NO floor + a betrayal scars lastingly; GUARD: a deep first-arriving TRUE incumbent keeps its floor", () => {
    // The positive half: depth-1 (first-arrival) earns no floor — M2 is depth-keyed.
    expect(lcbReadout(state({ corroborationDepth: 1 }), DOMAIN_CAP)).toBe(0);
    // The negative half: once it betrays, the scar suppresses any future contribution.
    const scarred = lcbReadout(state({ corroborationDepth: 1, scarBeta: 4 }), DOMAIN_CAP);
    expect(scarred).toBe(0);
    // GUARD: a deep first-arriving TRUE incumbent (depth-6, never contradicted) keeps its
    // floor — arrival order confers nothing, depth does.
    const trueIncumbent = lcbReadout(state({ corroborationDepth: 6, scarBeta: 0 }), DOMAIN_CAP) as number;
    expect(trueIncumbent).toBeGreaterThan(0.3);
  });
});

// ===========================================================================
// DECAY PASS-THROUGH + legacy/back-compat
// ===========================================================================

describe("BATCH 4 — non-decaying fields + back-compat", () => {
  it("decay() passes corroborationDepth and scarBeta through UNCHANGED (they are structural, not evidence mass)", () => {
    const s = state({ alpha: 5, beta: 5, corroborationDepth: 7, scarBeta: 3, lastUpdate: NOW });
    const decayed = decay(s, DOMAIN_CAP, asEpochMs((NOW as number) + 9000 * DAY_MS));
    expect(decayed.corroborationDepth).toBe(7); // untouched across ~100 half-lives
    expect(decayed.scarBeta).toBe(3);
    // The Beta mass DID decay toward the prior (the contrast — proves they are separate).
    expect(decayed.alpha).toBeCloseTo(1, 6);
    expect(decayed.beta).toBeCloseTo(1, 6);
  });

  it("a fresh prior (depth 0, scar 0) still reads EXACTLY 0; the M2/M3 wiring is integrity-additive", () => {
    const prior = newReputationState("src:fresh" as SourceId, NOW);
    expect(prior.corroborationDepth).toBe(0);
    expect(prior.scarBeta).toBe(0);
    expect(lcbReadout(prior, DOMAIN_CAP)).toBe(0);
    expect(lcbReadout(prior, 1 as Unit)).toBe(0);
  });
});
