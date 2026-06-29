/**
 * __bench__/redteam/cycle2.ts — THE 36 CYCLE-2 NOVEL-MECHANISM SYBIL ATTACKS.
 *
 * Cycle 1 mapped the adjudication surface (flood / first-arrival / reputation-weight /
 * class-anchor). Cycle 2 attacks the MECHANISMS underneath: attribute-fungible
 * reputation, the decay/keepalive fixed point, the 4× asymmetry buffer, the ONE-HOP
 * disown credit-reversal, the MAX_EXACT_ROOTS greedy cliff, the bridge sweep's missing
 * identity gate, the wall-with-a-window content-vs-key provenance gap, and the
 * approve()/anchor-independence hole.
 *
 * Same contract as cycle 1: every attack materializes REAL engine state, runs REAL
 * engine verbs, and CLASSIFIES strictly from real post-call state (fact_state, the
 * ConsolidationOutcome kind, independentRootCount, listPending depth, the
 * DownstreamDisownResult receipt, post-disown reputation α/LCB). NOTHING is hardcoded.
 *
 * The disown-evasion family uses the REAL corroboration-event ledger + REAL
 * weak-influence ledger through the engine's `ratify`/`disown` verbs — NOT a hand-built
 * channel — so the "Confederate Launder" re-derivation is a genuine engine test.
 *
 * ZERO engine edits: lives under src/__bench__ and imports only the public barrel.
 */

import { Harness, anchorOf, FactState, DAY } from "./harness.js";
import { AnchorClass, EdgeType, asEdgeId, independenceBetween } from "../../index.js";
import type {
  Attack,
  AttackResult,
  Outcome,
} from "./attacks.js";
import type {
  ConsolidationOutcome,
  StrandId,
  Edge,
  Unit,
  EpochMs,
  ProvenanceRoot,
  IndependenceClassId,
  ProvenanceRootId,
  SourceId,
} from "../../index.js";

const f3 = (x: number): string => x.toFixed(3);

/** Value-centric classifier reading REAL fact_state + adjudication kind. */
function classify(
  h: Harness,
  outcome: ConsolidationOutcome,
  trueId: StrandId,
  falseId: StrandId,
): Outcome {
  const trueDem = h.isDemoted(trueId);
  const falseLive = h.isLive(falseId);
  if (falseLive && trueDem) return "BREACHED";
  if (outcome.kind === "DEFERRED") return "DEFERRED";
  if (h.isLive(trueId)) return "DEFENDED";
  return "N/A";
}

// V2 (OD-8): the V1 `selfAnchorHighImpact` injector — which fed the high-impact gate a
// CLASS-counting callback (anchor classes held by ONE self-stacked source) — has been
// DELETED. `AdjudicateOptions.highImpact` is now an INTENT-only boolean; the engine
// BUILDS the gate's context from its OWN trust layer (F1: `anchorClassCountOf := #R`,
// the independent-ROOT count over the agreement-set union). A single self-stacked actor
// contributes MIS = 1 → the >=2 gate fails → DEFER. The attacks below now call the
// LEGITIMATE `adjudicate(attr, { highImpact: true })` and let the engine's real outcome
// stand — which is exactly the point of the V2 port (the class-counting breach is closed
// structurally, not by a tunable the caller supplies).

// ===========================================================================
// FAMILY: patient-betrayal
// ===========================================================================

const crossDomainSpend: Attack = {
  name: "CrossDomainSpend (Attribute-Fungible Reputation Laundering)",
  tier: "patient-betrayal",
  novelty: "Earn LCB on trivially-true facts in domain X, spend it on an unrelated lie in domain Y; reputation is keyed by SourceId, never by (source, attribute).",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "S-phone" });
    // PHASE A: earn on unrelated true facts (global, attribute-agnostic).
    h.earnTo(s, 0.35);
    const earnedRep = h.repOf(s);
    // PHASE B: spend on the target lie vs a fresh true witness.
    const falseId = h.write(s, "AcmeCorp", "ceo", "MALLORY");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "AcmeCorp", "ceo", "ALICE");
    const out = h.adjudicate("AcmeCorp", "ceo");
    return {
      outcome: classify(h, out, trueId, falseId),
      mechanism: "Reputation ledger keyed by SourceId; tryConsolidate ranks on the source-GLOBAL LCB. No per-attribute partition: trust earned on chemistry/geography auto-wins a corporate-fact dispute. S has ZERO track record on aT yet outranks the fresh true witness.",
      evidence: `outcome=${out.kind}; S_globalLCB=${f3(earnedRep)} (earned on unrelated attrs) vs fresh W=${f3(h.repOf(w))}; true(ALICE)=${h.state(trueId)}; false(MALLORY)=${h.state(falseId)}.`,
    };
  },
};

const trustPacemaker: Attack = {
  name: "TrustPacemaker (Decay-Steady Keepalive Cadence)",
  tier: "patient-betrayal",
  novelty: "One cheap corroboration every ~180 days holds the decay fixed point alpha=1+1/(1-lambda^dt) forever, defeating 90-day decay-on-read — a perpetual flip cannon for ~2 corroborations/year.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    // Prime, then hold the fixed point with a single ratify every 180 days for 3 years.
    h.ratifyOnce(s, 1);
    h.ratifyOnce(s, 1);
    for (let k = 0; k < 6; k++) {
      h.advanceDays(180);
      h.ratifyOnce(s, 1); // cheap heartbeat re-anchors lastUpdate
    }
    const heldRep = h.repOf(s); // decay-on-read to the current clock
    const falseId = h.write(s, "Entity", "price", "999");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Entity", "price", "TRUE_PRICE");
    const out = h.adjudicate("Entity", "price");
    return {
      outcome: classify(h, out, trueId, falseId),
      mechanism: "decay-before-mutate re-anchors lastUpdate at each ratify; decay-on-read decays a COPY but the persisted mass is the post-ratify high value. Spacing one ratify under the half-life pins the LCB above the floor indefinitely; the lie wins against a perpetually-fresh challenger.",
      evidence: `outcome=${out.kind}; S_LCB after 3yr of 180d heartbeats=${f3(heldRep)} (held above floor); true=${h.state(trueId)}; false(999)=${h.state(falseId)}.`,
    };
  },
};

const armoredBetrayal: Attack = {
  name: "ArmoredBetrayal (alpha-Buffer vs 4x Asymmetry)",
  tier: "patient-betrayal",
  novelty: "Bank alpha~7 so surviving one 4x contradiction (beta=5) still reads a flip-capable LCB, enabling a SECOND betrayal from the same identity before disqualification.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    for (let i = 0; i < 6; i++) h.ratifyOnce(s, 1); // alpha=7
    const repBanked = h.repOf(s);
    // Betrayal 1.
    const false1 = h.write(s, "E1", "v", "FALSE1");
    const w1 = h.addSource({ label: "W1", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W1-dom" });
    const true1 = h.write(w1, "E1", "v", "TRUE1");
    const out1 = h.adjudicate("E1", "v");
    const breach1 = h.isLive(false1) && h.isDemoted(true1);
    // The asymmetric hit: a single contradiction (beta += 4).
    h.reputation.contradict(s.sourceId, h.now(), 1);
    const repAfterHit = h.repOf(s);
    // Betrayal 2 from the SAME identity.
    const false2 = h.write(s, "E2", "v", "FALSE2");
    const w2 = h.addSource({ label: "W2", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W2-dom" });
    const true2 = h.write(w2, "E2", "v", "TRUE2");
    const out2 = h.adjudicate("E2", "v");
    const breach2 = h.isLive(false2) && h.isDemoted(true2);
    const oc: Outcome = breach2 ? "BREACHED" : breach1 ? "BREACHED" : out2.kind === "DEFERRED" ? "DEFERRED" : "DEFENDED";
    return {
      outcome: oc,
      mechanism: "applyContradiction adds beta += 4w but a high pre-betrayal alpha absorbs it: LCB(7,5) stays above decisiveMargin, so ONE caught lie does not disqualify a banked source. 4x slows recovery; it does not one-shot-floor a banked identity.",
      evidence: `banked_LCB=${f3(repBanked)}; betrayal1 breached=${breach1}; after 1 contradiction LCB=${f3(repAfterHit)}; betrayal2 out=${out2.kind} breached=${breach2}; false2=${h.state(false2)} true2=${h.state(true2)}.`,
    };
  },
};

const incumbencyMoat: Attack = {
  name: "IncumbencyMoat (decisiveMargin as a quantified First-Arrival Trap)",
  tier: "patient-betrayal",
  novelty: "Re-flipping a min-cost false incumbent (LCB 0.30) requires the truth-restorer to reach ~0.60 (top must clear incumbent+0.30); the 0.30 gap is direction-blind and entrenches whoever paid the floor cost first.",
  run() {
    const h = new Harness();
    const liar = h.addSource({ label: "L", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "L-dom" });
    h.earnTo(liar, 0.30);
    const falseId = h.write(liar, "Asset", "owner", "FALSE_OWNER"); // first arrival
    // Honest restorer earns a SUBSTANTIAL but sub-(incumbent+0.30) LCB.
    const restorer = h.addSource({ label: "R", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "R-dom" });
    h.earnTo(restorer, 0.45);
    const trueId = h.write(restorer, "Asset", "owner", "TRUE_OWNER");
    const out = h.adjudicate("Asset", "owner");
    // The truth could not reach incumbent+0.30, so the dispute does not auto-resolve
    // FOR THE TRUTH; the first-arrived false value stays the displayed LIVE strand.
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId)
      ? "BREACHED"
      : out.kind === "DEFERRED"
        ? "DEFERRED"
        : h.isDemoted(falseId)
          ? "DEFENDED"
          : "DEFERRED";
    return {
      outcome: oc,
      mechanism: "The decisive gate requires top-second >= 0.30: a restorer must clear incumbent_LCB + 0.30 (~0.60 vs the floor 0.30), i.e. ~2x the mass, JUST to overturn a minimum-cost flip. The moat is symmetric and direction-blind — it protects a FALSE first mover exactly as a true one.",
      evidence: `liar_LCB=${f3(h.repOf(liar))} restorer_LCB=${f3(h.repOf(restorer))} (gap=${f3(h.repOf(restorer) - h.repOf(liar))} < 0.30); out=${out.kind}; false(first-arrival)=${h.state(falseId)} (displayed LIVE); true=${h.state(trueId)} (cannot re-flip).`,
    };
  },
};

const silentPermanentFlip: Attack = {
  name: "SilentPermanentFlip (No Internal Disown Trigger)",
  tier: "patient-betrayal",
  novelty: "After an aged source wins a flip, the DEMOTED true strand is never auto-promoted: REOPENED_BY_DISOWN fires only inside an externally-initiated disown; no internal anomaly flags a single-source win, so the lie is permanent absent a human.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    h.earnTo(s, 0.4);
    const falseId = h.write(s, "Topic", "fact", "FALSE");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Topic", "fact", "TRUE");
    const out = h.adjudicate("Topic", "fact");
    const flipped = h.isLive(falseId) && h.isDemoted(trueId);
    // Time passes; truth becomes externally evident, but NO operator disowns S.
    h.advanceDays(400);
    // A fresh independent true witness re-asserts — but only adjudicate would act, and
    // a RESOLVED set has no internal re-open path short of disown.
    const w2 = h.addSource({ label: "W2", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "W2-org" });
    h.earnTo(w2, 0.2);
    h.write(w2, "Topic", "fact", "TRUE");
    const out2 = h.adjudicate("Topic", "fact"); // true is DEMOTED → not a LIVE member → no re-open
    const stillFlipped = h.isLive(falseId) && h.isDemoted(trueId);
    const oc: Outcome = stillFlipped ? "BREACHED" : flipped ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : "DEFENDED";
    return {
      outcome: oc,
      mechanism: "tryConsolidate has no 'new contradicting evidence reopens a RESOLVED set' path; the demoted true strand is no longer a LIVE member, so re-adjudication never reconsiders it. Only db.disown (operator-invoked) reopens. A single-source aged win raises no internal suspicion.",
      evidence: `t0 out=${out.kind} flipped=${flipped}; +400d re-adjudicate out=${out2.kind}; false=${h.state(falseId)} (LIVE, permanent) true=${h.state(trueId)} (DEMOTED, never auto-promoted).`,
    };
  },
};

const selfStackedClasses: Attack = {
  name: "SelfStackedClasses (Single Source Defeats the High-Impact Gate)",
  tier: "patient-betrayal",
  novelty: "One source binding Email+Domain reports 2 disjoint anchor classes and clears the >=2-class irreversible gate; applySelfStackCap clamps independence WEIGHT but not the disjoint-class COUNT a class-set resolver reads.",
  run() {
    const h = new Harness();
    const s = h.addSource({
      label: "S",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.DOMAIN)],
      indClass: "S-stack",
    });
    for (let i = 0; i < 3; i++) h.ratifyOnce(s, 1); // ratifiedCount=3, decisive LCB
    const falseId = h.write(s, "Estate", "beneficiary", "ATTACKER");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Estate", "beneficiary", "RIGHTFUL");
    const attr = h.attr("Estate", "beneficiary");
    // Default highImpact (harness provenance-based resolver: independentRootCount=1).
    const provOut = h.adjudicate("Estate", "beneficiary", true);
    const defendedByProvenance = provOut.kind !== "RESOLVED";
    // Class-set resolver (the literal '>=2 disjoint anchor classes' reading): count=2.
    const outClassCount = h.engine.adjudicate(attr, { highImpact: true });
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : outClassCount.kind === "DEFERRED" ? "DEFERRED" : classify(h, outClassCount, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "clearsHighImpactGate reads ctx.anchorClassCountOf(winner) with NO requirement that the classes belong to DISTINCT corroborating sources. A class-set resolver returns 2 for one self-stacked Email+Domain source → the irreversible gate built to stop single-source flips is cleared by one actor. (Provenance-based resolver returns 1 → DEFENDS; the conflation is the vulnerability.)",
      evidence: `S_anchorClasses=2 ratifiedCount=${h.repState(s)?.ratifiedCount}; provenance-resolver out=${provOut.kind} (defends=${defendedByProvenance}); class-count-resolver out=${outClassCount.kind}; false=${h.state(falseId)} true=${h.state(trueId)}.`,
    };
  },
};

// ===========================================================================
// FAMILY: whitewash-stake
// ===========================================================================

const sleeperHarvest: Attack = {
  name: "Sleeper Corroboration Harvest",
  tier: "whitewash-stake",
  novelty: "Fresh DOMAIN source actively FARMS LCB by corroborating many true incumbent facts, then spends the laundered track-record on one false flip — faster than decay-aging.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    // Active farming: agree with many true incumbents (each genuinely true, cheaply verifiable).
    for (let i = 0; i < 40; i++) {
      const inc = h.addSource({ label: `I${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `I-${i}` });
      const incId = h.write(inc, `Fact${i}`, "v", "TRUE_V");
      const aId = h.write(a, `Fact${i}`, "v", "TRUE_V");
      h.engine.ratify({ strandId: aId, externalStamp: h.identity.stampFor(a.sourceId) });
    }
    const farmed = h.repOf(a);
    const falseId = h.write(a, "Target", "z", "FALSE_Z");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Target", "z", "TRUE_Z");
    const defOut = h.adjudicate("Target", "z"); // default impact
    const defOc = classify(h, defOut, trueId, falseId);
    // High-impact variant (harness resolver): A is ONE anchor class, 0 corroborations on Z.
    const h2 = new Harness();
    const a2 = h2.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h2.earnTo(a2, farmed);
    const f2 = h2.write(a2, "Target", "z", "FALSE_Z");
    const w2 = h2.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const t2 = h2.write(w2, "Target", "z", "TRUE_Z");
    const hiOut = h2.adjudicate("Target", "z", true);
    return {
      outcome: defOc,
      mechanism: "The reputation ledger cannot distinguish an honest long-term witness from a sleeper that paid for cover by being trivially right elsewhere; track-record is fungible across attributes. Default-impact single-source decisiveness is the standing liability; high-impact (>=2 corroborations/classes) is the only backstop.",
      evidence: `farmed_LCB=${f3(farmed)} (40 true corroborations); default out=${defOut.kind} false=${h.state(falseId)} true=${h.state(trueId)} -> ${defOc}; high-impact variant out=${hiOut.kind} false=${h2.state(f2)} true=${h2.state(t2)} (DEFENDED by gate).`,
    };
  },
};

const bondBackedAuthority: Attack = {
  name: "Bond-Backed Authority Synthesis",
  tier: "whitewash-stake",
  novelty: "A single maximal FINANCIAL_STAKE bond buys ~0.85 independence WEIGHT (near authority's 0.90) and tries to act as a lone strong root / ratify derived->observed.",
  run() {
    const h = new Harness();
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.FINANCIAL_STAKE, { realizedCost: 0.85, independenceWeight: 0.85 })],
      indClass: "A-stake",
      stake: 1000,
    });
    h.earnTo(a, 0.5);
    const falseId = h.write(a, "Claim", "v", "FALSE");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Claim", "v", "TRUE");
    // High-impact: a single bond root cannot supply COUNT>=2 (independentRootCount=1).
    const hiOut = h.adjudicate("Claim", "v", true);
    const loneRootCount = h.independentRootCountOver(falseId); // = 1
    const oc: Outcome = hiOut.kind === "DEFERRED" ? "DEFERRED" : classify(h, hiOut, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "FINANCIAL_STAKE weight is attacker-dialable with money, approaching authority WEIGHT, but authority FUNCTION (ratify derived->observed) is class-gated to EXTERNAL_AUTHORITY, and every anti-Sybil gate is COUNT-based (>=2). One bond is one root: independentRootCount=1 fails the high-impact gate → DEFER. DEFENDED provided no gate substitutes a single high weight for count>=2.",
      evidence: `A_stakeWeight=0.85 A_LCB=${f3(h.repOf(a))}; lone-root independentRootCount=${loneRootCount} (<2); high-impact out=${hiOut.kind}; true=${h.state(trueId)} false=${h.state(falseId)}.`,
    };
  },
};

const transientBondCapInflation: Attack = {
  name: "Transient Bond Cap-Inflation",
  tier: "whitewash-stake",
  novelty: "Post a short-lock bond to lift applySelfStackCap's ceiling to 0.85, harvest cap-inflated reputation/corroboration credit, then withdraw the bond with NO reversal sweep.",
  run() {
    const h = new Harness();
    // A holds a cheap EMAIL base + a (transient) large bond.
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.FINANCIAL_STAKE, { realizedCost: 0.85, independenceWeight: 0.85 })],
      indClass: "A-bond",
      stake: 1000,
    });
    // Harvest reputation + corroboration credit during the lock window.
    for (let i = 0; i < 5; i++) {
      const inc = h.addSource({ label: `I${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `I-${i}` });
      const incId = h.write(inc, `F${i}`, "v", "V");
      const aId = h.write(a, `F${i}`, "v", "V");
      h.engine.ratify({ strandId: aId, externalStamp: h.identity.stampFor(a.sourceId) });
    }
    const alphaUnderBond = h.repState(a)?.alpha ?? 0;
    const eventsMinted = h.ratification.corroboration?.all().length ?? 0;
    // Withdraw the bond: drop the FINANCIAL_STAKE anchor. No sweep fires (stake-expiry
    // has no lifecycle hook); the persisted Beta alpha is the laundered artifact.
    h.identity.register(a.key, [anchorOf(AnchorClass.EMAIL_OAUTH)]);
    const alphaAfterWithdraw = h.repState(a)?.alpha ?? 0;
    const survived = Math.abs(alphaAfterWithdraw - alphaUnderBond) < 1e-9;
    return {
      outcome: survived ? "BREACHED" : "DEFENDED",
      mechanism: "applySelfStackCap is evaluated at write/read time against CURRENTLY realized weights; the reputation + corroboration ledgers are sticky and only reversed by contradiction/disown — never by stake EXPIRY. A voluntarily-withdrawn bond triggers no claw-back, so the cap-inflated alpha + the >=2 minted corroboration events persist after the weight that justified them is gone.",
      evidence: `alpha under bond=${f3(alphaUnderBond)}; alpha after withdrawing bond=${f3(alphaAfterWithdraw)} (unchanged=${survived}); corroboration events minted=${eventsMinted} (none reversed — no expiry hook).`,
    };
  },
};

const twoClassCostume: Attack = {
  name: "Two-Class Costume via Stake+Email",
  tier: "whitewash-stake",
  novelty: "One actor holds EMAIL + FINANCIAL_STAKE (two distinct class ids, one wallet) to satisfy the high-impact gate's >=2-disjoint-anchor-classes clause.",
  run() {
    const h = new Harness();
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.FINANCIAL_STAKE, { realizedCost: 0.85, independenceWeight: 0.85 })],
      indClass: "A-costume",
      stake: 1000,
    });
    for (let i = 0; i < 3; i++) h.ratifyOnce(a, 1);
    const falseId = h.write(a, "Irrev", "v", "FALSE");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Irrev", "v", "TRUE");
    const attr = h.attr("Irrev", "v");
    const out = h.engine.adjudicate(attr, { highImpact: true });
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "The high-impact gate equates 'disjoint anchor CLASSES' with 'independent real-world ROOTS', but EMAIL + FINANCIAL_STAKE are two distinct class ids cheaply co-held by one wallet. Class-disjointness is necessary, not sufficient, for actor-disjointness — and MIS over CLASSES cannot see both trace to one actor.",
      evidence: `A holds {EMAIL, FINANCIAL_STAKE}=2 classes, ratifiedCount=${h.repState(a)?.ratifiedCount}; class-count-resolver out=${out.kind}; false=${h.state(falseId)} true=${h.state(trueId)}.`,
    };
  },
};

const keyRotationWhitewash: Attack = {
  name: "Anchor-Preserving Key-Rotation Whitewash",
  tier: "whitewash-stake",
  novelty: "A contradicted key re-mints a fresh passport, re-binds the SAME retained DOMAIN anchor, resets reputation to neutral 0 and dodges disown's sourceId-scoped taint-closure.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "evil-dom" });
    h.earnTo(a, 0.4);
    // A is caught lying repeatedly: crater its LCB.
    for (let i = 0; i < 3; i++) h.reputation.contradict(a.sourceId, h.now(), 1);
    const aRepAfter = h.repOf(a);
    // Rotate: NEW passport key A', re-bind the SAME DOMAIN anchor (free, already owned).
    const aPrime = h.addSource({ label: "A'", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "evil-dom" });
    const aPrimeRep = h.repOf(aPrime); // fresh => 0, clean
    const cleanId = h.write(aPrime, "Topic", "claim", "FRESH_FROM_ROTATED_KEY");
    // disown(A): sourceId/DERIVATION-scoped — cannot follow the anchor across a key change.
    h.disown(a);
    const aPrimeUntouched = h.isLive(cleanId) && h.repState(aPrime) === null;
    return {
      outcome: aPrimeRep <= 0.0001 && aPrimeUntouched ? "BREACHED" : "DEFENDED",
      mechanism: "Reputation is ledgered PER PASSPORT KEY; the 4x contradiction scar binds to the key, but real-world scarcity binds to the ANCHOR. A new key under a retained anchor reads a clean LCB 0, and disown's sourceId-scoped taint-closure cannot follow the anchor across the key change. No anchor-level reputational lien exists.",
      evidence: `A (dirty key) LCB after 3 contradictions=${f3(aRepAfter)}; A' (rotated key, SAME anchor) LCB=${f3(aPrimeRep)} (clean); disown(A) left A' untouched=${aPrimeUntouched}, fresh strand=${h.state(cleanId)}.`,
    };
  },
};

const dormancyBetaWash: Attack = {
  name: "Dormancy Beta-Decay Wash",
  tier: "whitewash-stake",
  novelty: "Idle 360 days; symmetric 90-day decay-on-read erodes the 4x beta scar back toward the prior, so a caught liar becomes indistinguishable from a fresh source — deterrence evaporates.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h.earnTo(a, 0.5);
    const peak = h.repOf(a);
    h.reputation.contradict(a.sourceId, h.now(), 1); // 4x scar
    const scarred = h.repOf(a);
    h.advanceDays(360); // do nothing
    const washed = h.repOf(a); // decay-on-read pulls both alpha,beta toward prior
    const fresh = h.addSource({ label: "F", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "F-dom" });
    const freshRep = h.repOf(fresh);
    const indistinguishable = Math.abs(washed - freshRep) < 0.02;
    return {
      outcome: indistinguishable ? "BREACHED" : "DEFENDED",
      mechanism: "Symmetric exponential decay-on-read has no floor below the prior and no persistent-penalty term: the beta surplus decays in ABSOLUTE terms at the same 90-day half-life as alpha, so after dormancy the contradicted source reads ~0 == a fresh key. Re-reaching HIGH trust is still DEFENDED (decay pulls to the prior, not back to 0.5), but the 'lost fast' DETERRENT leaves no lasting scar.",
      evidence: `peak_LCB=${f3(peak)} -> contradicted=${f3(scarred)} -> after 360d dormancy=${f3(washed)} ~ fresh source=${f3(freshRep)} (indistinguishable=${indistinguishable}); contradictedCount=${h.reputation.stateOf(a.sourceId)?.contradictedCount} (audit-only, never read by lcbReadout).`,
    };
  },
};

// ===========================================================================
// FAMILY: disown-evasion  (uses the REAL corroboration + weak-influence ledgers)
// ===========================================================================

const twoHopRelay: Attack = {
  name: "Two-Hop Corroboration Relay",
  tier: "disown-evasion",
  novelty: "B earns by naming proxy C; C names A. Disown A reverses only C's event; B's credit survives because the sweep's credit reversal is ONE-HOP (eventsIntersecting over A's seed), never transitive over the corroboration DAG.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const c = h.addSource({ label: "C", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "C-email" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "B-phone" });
    const a1 = h.write(a, "loc", "x", "V");
    const c1 = h.write(c, "loc", "x", "V");
    h.engine.ratify({ strandId: c1, externalStamp: h.identity.stampFor(c.sourceId) });
    const b1 = h.write(b, "loc", "x", "V");
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const cAlphaBefore = h.repState(c)?.alpha ?? 0;
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const cAlphaAfter = h.repState(c)?.alpha ?? 0;
    const bSurvived = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9 && h.isLive(b1);
    return {
      outcome: bSurvived ? "BREACHED" : "DEFENDED",
      mechanism: "downstreamDisownSweep calls corroboration.eventsIntersecting(seed={a1}); E_C names a1 (reversed), but E_B names c1 (sourceId C, NOT in A's seed) → B untouched. No DERIVATION edge b1->a1, so the BFS never reaches b1. Each relay hop strips one reversal; an N-hop relay launders all credit beyond hop 1 at linear cost.",
      evidence: `reversedEvents=${JSON.stringify(res.reversedCorroborationEventIds)} (only C's); C alpha ${f3(cAlphaBefore)}->${f3(cAlphaAfter)} (reversed); B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} (SURVIVED=${bSurvived}); b1=${h.state(b1)}.`,
    };
  },
};

const unnamedWitness: Attack = {
  name: "The Unnamed Witness",
  tier: "disown-evasion",
  novelty: "B agrees with A via ORDINARY ratify (no corroboratingStrandIds), so no event is recorded at all; disown finds nothing to reverse — event recording is opt-in, so the launderer just never names A.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const a1 = h.write(a, "ceo", "x", "V");
    const b1 = h.write(b, "ceo", "x", "V");
    // Ordinary ratify: names NO corroborators → no corroboration event recorded.
    for (let i = 0; i < 3; i++) {
      h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    }
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const events = h.ratification.corroboration?.all().length ?? 0;
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const survived = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9 && h.isLive(b1);
    return {
      outcome: survived ? "BREACHED" : "DEFENDED",
      mechanism: "Corroboration-event recording fires only when ratify is called WITH corroboratingStrandIds AND alpha moves. An ordinary ratify raises reputation with NO reversible trace. The launderer's optimal strategy is to never name the source it is laundering; the 'who did B agree with' link is never independently computed by the web (invariant-2 at the credit layer).",
      evidence: `corroboration events recorded=${events} (zero — never named A); B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} after disown(A) (survived=${survived}); reversed=${JSON.stringify(res.reversedCorroborationEventIds)}; b1=${h.state(b1)} (planted V now has a high-rep 'independent' witness).`,
    };
  },
};

const decoyMisattribution: Attack = {
  name: "Decoy-Corroborator Misattribution",
  tier: "disown-evasion",
  novelty: "An event IS recorded but names an innocent independent twin D instead of A; balances an 'every earning ratify emitted an event' audit yet reverses nothing on disown — corroborator sets are caller-asserted, never verified.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const d = h.addSource({ label: "D", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "D-org" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const a1 = h.write(a, "hq", "city", "V"); // the planter
    const d1 = h.write(d, "hq", "city", "V"); // a genuine independent twin
    const b1 = h.write(b, "hq", "city", "V");
    // V2 (F3): the caller can no longer NAME the clean twin d1 — the engine DERIVES the
    // agreement set itself (same entity + content_hash + LIVE), so it records the real
    // agreers (a1 AND d1) rather than the attacker's hand-picked decoy. Let the outcome stand.
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const events = h.ratification.corroboration?.all().length ?? 0;
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const survived = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9 && h.isLive(b1);
    return {
      outcome: survived ? "BREACHED" : "DEFENDED",
      mechanism: "corroboratingStrandIds is an attacker-supplied claim, never cross-checked against the actual set of same-value strands the belief rested on. As long as ANY independent agreeing source exists, the launderer attributes corroboration to it. An event EXISTS (so a coverage audit balances) but disown's eventsIntersecting(A's seed) misses it.",
      evidence: `events recorded=${events} (1, names d1 not a1); reversed by disown(A)=${JSON.stringify(res.reversedCorroborationEventIds)} (empty); B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} (survived=${survived}); b1=${h.state(b1)}.`,
    };
  },
};

const proxyWeakInfluence: Attack = {
  name: "Proxy-Consulted Weak-Influence Launder",
  tier: "disown-evasion",
  novelty: "Weak-influence edge filed against proxy c1 (which consulted A), so edgesConsulting(A's seed) never reaches b1; dodges the human review queue — a symmetric one-hop gap in the uncited-influence channel.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const c = h.addSource({ label: "C", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "C-email" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "B-phone" });
    const a1 = h.write(a, "policy", "rate", "V");
    const c1 = h.write(c, "policy", "rate", "V");
    const b1 = h.write(b, "policy", "rate", "V");
    // C honestly discloses consulting a1; B consults only c1 (never reads a1).
    h.ratification.weakInfluence?.record({ strandId: c1, consultedStrandId: a1, context: "C consulted A", at: h.now() });
    h.ratification.weakInfluence?.record({ strandId: b1, consultedStrandId: c1, context: "B consulted C", at: h.now() });
    const res = h.disown(a);
    const queued = res.reviewQueued.map((r) => String(r.strandId));
    const b1Queued = queued.includes(String(b1));
    const c1Queued = queued.includes(String(c1));
    return {
      outcome: !b1Queued ? "BREACHED" : "DEFENDED",
      mechanism: "The weak-influence review queue is driven by edgesConsulting(seed={a1}), ONE HOP: only C's edge (consultedStrandId=a1) matches → c1 queued; B's edge names c1, not in A's seed → b1 never queued. The A->c1->b1 taint stops at the queue's one-hop horizon, exactly mirroring the corroboration-credit one-hop gap.",
      evidence: `reviewQueued=${JSON.stringify(queued)}; c1 queued=${c1Queued}; b1 queued=${b1Queued} (BREACH: b1 neither demoted nor contradicted nor reviewed).`,
    };
  },
};

const reObservationBleach: Attack = {
  name: "Re-Observation Bleach",
  tier: "disown-evasion",
  novelty: "Read A, re-file as a fresh OBSERVED strand under an attacker-assigned independence class with zero links; invisible to all three channels AND inflates the planted value's independent-root count.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "B-fabricated", operatorClass: null });
    const a1 = h.write(a, "policy", "rate", "V");
    const countBefore = h.independentRootCountOver(a1);
    // B reads a1, re-files V as a brand-new OBSERVED fact (no derivation/event/weak edge).
    const b1 = h.write(b, "policy", "rate", "V");
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) }); // banks rep, names nothing
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const countWithB = h.independentRootCountOver(a1, b1);
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const bSurvived = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9 && h.isLive(b1);
    const healed = countWithB > countBefore;
    return {
      outcome: bSurvived && healed ? "BREACHED" : bSurvived ? "BREACHED" : "DEFENDED",
      mechanism: "The disown sweep can only follow RECORDED links (DERIVATION edge / corroboration event / weak-influence edge). A re-observation records NONE, so b1 is a fully 'independent' LIVE observed witness to A's planted V — indistinguishable from a real source. Worse, b1 raises V's max-independent-set count, partially HEALING the planted claim against the disown. This composes the uncited-influence and offline-class-assignment residuals into reputation-positive laundering.",
      evidence: `independentRootCount(V): before B=${countBefore}, with B=${countWithB} (healed=${healed}); B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} after disown(A) (survived=${bSurvived}); b1=${h.state(b1)}; reversed=${JSON.stringify(res.reversedCorroborationEventIds)}.`,
    };
  },
};

const contributorPadding: Attack = {
  name: "Contributor-Padding Margin Dilution",
  tier: "disown-evasion",
  novelty: "Pad an adjudication's contributingStrandIds with cheap clean strands so the equal-weight surviving-margin stays above the 0.30 re-open threshold even though the tainted strand carried the decisive weight.",
  run() {
    const h = new Harness();
    // A genuinely aged champion A flips a single-class dispute (so it auto-RESOLVES and
    // adjudication provenance is recorded), co-asserted by clean pads sharing A's source.
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h.earnTo(a, 0.5);
    const winnerId = h.write(a, "owner", "y", "WINNER"); // A's decisive strand
    // 8 echo strands from A (same source → same class → listed as winner-source contributors).
    for (let i = 0; i < 8; i++) h.write(a, "owner", "y", "WINNER");
    const loser = h.addSource({ label: "L", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "L-dom" });
    const loserId = h.write(loser, "owner", "y", "LOSER");
    const out = h.adjudicate("owner", "y"); // single class? A vs L are 2 classes → multi-class
    // Disown A: all A-strands are tainted (sourceId A), so EVERY listed contributor is tainted.
    const res = h.disown(a);
    const reopened = res.reopenedDisputes.length > 0;
    // BREACH would be: the dispute stays RESOLVED for the lie despite A being fraudulent.
    const oc: Outcome = reopened ? "DEFENDED" : (out.kind === "RESOLVED" ? "BREACHED" : "DEFENDED");
    return {
      outcome: oc,
      mechanism: "The real engine DERIVES contributingStrandIds = winner + members SHARING THE WINNER'S SOURCE; clean pads cannot be injected because any strand sharing the winner's source (A) is itself tainted by disown(A). So defaultSurvivingMargin's count fraction cannot be diluted with untainted strands → the recorded margin collapses to ~0 → the dispute re-opens. The equal-weight model is real, but the contributor list is NOT attacker-controllable through the engine.",
      evidence: `adjudicate=${out.kind}; disown(A) reopenedDisputes=${JSON.stringify(res.reopenedDisputes.map(String))} (reopened=${reopened}); demotedDownstream=${res.demotedDownstream.length}; winner=${h.state(winnerId)} loser=${h.state(loserId)}. Padding requires caller-controlled contributingStrandIds the engine does not expose.`,
    };
  },
};

// ===========================================================================
// FAMILY: decay-dormancy-bridge
// ===========================================================================

const troughEclipse: Attack = {
  name: "Trough-Synchronized Eclipse",
  tier: "decay-dormancy-bridge",
  novelty: "Drag a strongly-established incumbent (5+ corroborations) down its symmetric decay trough over ~360d dormancy while just-in-time-ratifying the challenger; a mere 0.31 source clears the gap that should require ~0.85.",
  run() {
    const h = new Harness();
    const v = h.addSource({ label: "V", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "V-dom" });
    for (let i = 0; i < 6; i++) h.ratifyOnce(v, 1); // alpha~7, deep corroboration
    const peak = h.repOf(v);
    const trueId = h.write(v, "Bridge", "status", "OPEN");
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    // Incumbent goes dormant; attacker earns FRESH at strike time (full un-decayed LCB).
    h.advanceDays(540);
    h.earnTo(a, 0.40);
    const decayed = h.repOf(v); // decay-on-read collapses the dormant incumbent
    const falseId = h.write(a, "Bridge", "status", "CLOSED");
    const out = h.adjudicate("Bridge", "status");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Pure symmetric decay-on-read with NO incumbency floor: a 6-witness fact and a 2-witness fact are equally overturnable once both decay to the prior. The gap-based decisive gate measures the DECAYED readout; the attacker's just-in-time ratify resets only its OWN lastUpdate. Decay erases the DEPTH of past corroboration.",
      evidence: `incumbent peak_LCB=${f3(peak)} -> after 400d dormancy=${f3(decayed)}; attacker_LCB=${f3(h.repOf(a))} (gap=${f3(h.repOf(a) - decayed)}); out=${out.kind}; true(OPEN)=${h.state(trueId)} false(CLOSED)=${h.state(falseId)}.`,
    };
  },
};

const penanceByDormancy: Attack = {
  name: "Penance-by-Dormancy (Decay-Laundered Contradiction)",
  tier: "decay-dormancy-bridge",
  novelty: "beta (the 4x penalty) decays at the same 90d half-life as alpha, so a burned anchored identity waits ~360d back to LCB ~0 (a fresh key, not a scar) and recycles; contradictedCount is audit-only.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    let cycles = 0;
    const samples: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < 3; i++) h.ratifyOnce(s, 1);
      h.reputation.contradict(s.sourceId, h.now(), 1); // caught: beta += 4
      const low = h.repOf(s);
      h.advanceDays(360); // do nothing; symmetric decay washes the scar
      const washed = h.repOf(s);
      samples.push(`cycle${cycle}: contradicted=${f3(low)} -> washed=${f3(washed)}`);
      cycles++;
    }
    const finalContraCount = h.reputation.stateOf(s.sourceId)?.contradictedCount ?? 0;
    const washedToFresh = h.repOf(s) < 0.05;
    return {
      outcome: washedToFresh ? "BREACHED" : "DEFENDED",
      mechanism: "Symmetric beta decay pulls BOTH (alpha-1) and (beta-1) toward 0 at lambda=0.5^(1/90); contradictedCount is stored but NEVER read by lcbReadout or the adjudicator. A lost adjudication calls contradict (recoverable), not disown (permanent). One costly anchor set funds unlimited lie-cycles, paying only dormancy TIME — no permanent cumulative scar. DEFENDED against single-shot INVERSION; BREACHED as cost-amortization.",
      evidence: `${cycles} recycle cycles: ${samples.join("; ")}; final contradictedCount=${finalContraCount} (audit-only); final LCB=${f3(h.repOf(s))} (~fresh, recyclable=${washedToFresh}).`,
    };
  },
};

const recencyWindowStraddle: Attack = {
  name: "Recency-Window Straddle",
  tier: "decay-dormancy-bridge",
  novelty: "The high-impact recency-clean window is a fixed 90d calendar delay; wait it out (keeping alpha warm), and the irreversible gate's three sub-checks are all one-time-purchasable.",
  run() {
    const h = new Harness();
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "A-2class",
    });
    for (let i = 0; i < 3; i++) h.ratifyOnce(a, 1);
    h.reputation.contradict(a.sourceId, h.now(), 1); // probing lie at tc
    const tc = h.now();
    // Straddle: wait past the 90d window, keeping alpha warm, then out-earn the beta
    // scar so the BASE decisive margin (>=0.30 over a fresh true witness) also clears.
    for (let k = 0; k < 2; k++) { h.advanceDays(50); h.ratifyOnce(a, 1); }
    h.earnTo(a, 0.40);
    const warmRep = h.repOf(a);
    const falseId = h.write(a, "Irrev", "v", "FALSE");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Irrev", "v", "TRUE");
    const attr = h.attr("Irrev", "v");
    // V2 (OD-8): the contradiction is now > 90d ago, the source carries 2 anchor classes,
    // and >=2 corroborations were earned. We can no longer inject a context asserting that;
    // we flag intent and let the engine BUILD the gate from its own trust layer (the
    // recency window now reads `ReputationState.lastContradictionAt`, the counts read `#R`).
    const out = h.engine.adjudicate(attr, { highImpact: true });
    const sinceContra = (h.nowMs - (tc as unknown as number)) / DAY;
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "clearsHighImpactGate's recencyCleanWindowMs is an absolute lookback on a SINGLE lastContradictionAt timestamp — no penalty that grows with history, no carry-over — so it expires deterministically after a 90d wait. >=2 corroborations and >=2 classes are one-time-purchasable. The gate adds DELAY + a 2-anchor price, not unforgeability.",
      evidence: `contradiction was ${sinceContra.toFixed(0)}d ago (>90d → recency-clean PASS); warm_LCB=${f3(warmRep)} ratifiedCount=${h.repState(a)?.ratifiedCount} classes=2; high-impact out=${out.kind}; false=${h.state(falseId)} true=${h.state(trueId)}.`,
    };
  },
};

const bridgeheadBeacon: Attack = {
  name: "Bridgehead Beacon",
  tier: "decay-dormancy-bridge",
  novelty: "The mandatory bridge sweep guarantees one crossing per lit bridge with NO identity gate, so a planted near-hub->far CROSS_WEB_BRIDGE surfaces a false far-web fact on every recall.",
  run() {
    const h = new Harness();
    const attacker = h.bareSource("attacker");
    // Near-side hub strand N and a far-web false strand Fpoison, both observed by a bare key.
    const nId = h.write(attacker, "hub-web", "topic", "near");
    const fId = h.write(attacker, "far-web", "secret", "FALSE_FAR_FACT");
    // Mint a CROSS_WEB_BRIDGE edge N -> Fpoison with high link confidence.
    const bridge: Edge = {
      id: asEdgeId(`edge:bridge:${String(nId)}->${String(fId)}`),
      from: nId,
      to: fId,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 1 as Unit,
      provenance_independence: 0 as Unit, // a bare-key bridge: ZERO independence
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    };
    h.store.putEdge(bridge);
    // Recall with a cue lighting N. The bridge sweep crosses N->Fpoison with NO identity gate.
    const result = h.engine.recall({ seeds: [{ strandId: nId, energy: 1 as Unit }] });
    const litIds = new Set(result.lit.map((l) => String(l.strandId)));
    const poisonSurfaced = litIds.has(String(fId));
    return {
      outcome: poisonSurfaced ? "BREACHED" : "DEFENDED",
      mechanism: "halting.nextBridgeCrossing() guarantees one crossing per lit bridge, seeding the far side at gamma, with NO check of the bridge author's reputation/anchor/independence. The trust layer gates ADJUDICATION but not ACTIVATION/RETRIEVAL: a false OBSERVED far fact is surfaced on demand (stamped low-corroboration), bypassing the wall-with-a-window because it is attacker-observed, not derived.",
      evidence: `recall lit=${JSON.stringify([...litIds])}; Fpoison(FALSE_FAR_FACT) surfaced=${poisonSurfaced} via a ZERO-independence bare-key bridge; halt=${result.halt.reason}.`,
    };
  },
};

const bridgeSweepEclipse: Attack = {
  name: "Bridge-Sweep Eclipse (Decoy Flood)",
  tier: "decay-dormancy-bridge",
  novelty: "Flood one hub with many yielding decoy bridges to exhaust the fixed ~20% sub-budget; the genuine bridge is stamped BRIDGE_STARVED and never crosses — denial of cross-web insight.",
  run() {
    const h = new Harness();
    const attacker = h.bareSource("attacker");
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    const hubId = h.write(attacker, "hub", "topic", "hub");
    // The genuine insight bridge L, authored honestly (distinct class so it 'yields').
    const legitId = h.write(honest, "far-legit", "insight", "TRUE_INSIGHT");
    // Many decoy far strands + decoy bridges from the hub (each yields: distinct class).
    const M = 500; // exceeds the default ~20% sub-budget of popCap 2000 (=~400 crossings)
    for (let i = 0; i < M; i++) {
      const dId = h.write(attacker, `far-decoy-${i}`, "x", `d${i}`);
      const e: Edge = {
        id: asEdgeId(`edge:decoy:${i}:${String(hubId)}->${String(dId)}`),
        from: hubId, to: dId, edgeType: EdgeType.CROSS_WEB_BRIDGE,
        link_confidence: 1 as Unit, provenance_independence: 1 as Unit, recency: 1 as Unit, w: 1 as Unit, out_weight_sum: 1 as Unit,
      };
      h.store.putEdge(e);
    }
    // The legit bridge is added LAST so it is enumerated after the decoys.
    const legitEdge: Edge = {
      id: asEdgeId(`edge:zzz-legit:${String(hubId)}->${String(legitId)}`),
      from: hubId, to: legitId, edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 1 as Unit, provenance_independence: 1 as Unit, recency: 1 as Unit, w: 1 as Unit, out_weight_sum: 1 as Unit,
    };
    h.store.putEdge(legitEdge);
    const result = h.engine.recall({ seeds: [{ strandId: hubId, energy: 1 as Unit }] });
    const litIds = new Set(result.lit.map((l) => String(l.strandId)));
    const legitSurfaced = litIds.has(String(legitId));
    const starved = result.halt.reason === "BRIDGE_STARVED" || result.halt.degraded;
    const oc: Outcome = !legitSurfaced && starved ? "BREACHED" : !legitSurfaced ? "BREACHED" : "DEFENDED";
    return {
      outcome: oc,
      mechanism: "The bridge sub-budget is a fixed ~20% pool with one owed crossing per lit bridge, crossed in enumeration order with NO per-source cap and NO earned_bridge_value priority (earned value orders EVICTION, not CROSSING). M yielding decoys from one hub exhaust the pool; the genuine bridge L is stamped BRIDGE_STARVED and never crosses. A single source authors unbounded bridges off one hub and monopolizes every sweep through it.",
      evidence: `${M} decoy bridges + 1 legit; halt=${result.halt.reason} degraded=${result.halt.degraded} bridgesCrossed=${result.halt.bridgesCrossed}; legit insight surfaced=${legitSurfaced} (suppressed=${!legitSurfaced}).`,
    };
  },
};

const mutualKeepaliveRing: Attack = {
  name: "Mutual-Keepalive Ring (Reputation Perpetual-Motion)",
  tier: "decay-dormancy-bridge",
  novelty: "A fixed disjoint-class Sybil ring holds a fraudulent canonical above the 0.30 gap forever at ~1-2 cross-ratifications/identity/year; the earned floor has no expensive-to-MAINTAIN term and no clique detection.",
  run() {
    const h = new Harness();
    const ring = [0, 1, 2].map((i) =>
      h.addSource({ label: `R${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `ring-${i}`, operatorClass: `op-${i}` }),
    );
    // Establish the ring, then sustain via cross-ratification every ~120 days for 3 years.
    for (const m of ring) for (let i = 0; i < 3; i++) h.ratifyOnce(m, 1);
    for (let t = 0; t < 9; t++) {
      h.advanceDays(120);
      for (const m of ring) h.ratifyOnce(m, 1); // cheap cross-corroboration, resets decay
    }
    const ringRep = ring.map((m) => h.repOf(m));
    // ONE ring member asserts the false canonical (others just keep its rep warm).
    const falseId = h.write(ring[0]!, "Canon", "v", "FALSE_CANON");
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Canon", "v", "TRUE_CANON");
    const out = h.adjudicate("Canon", "v");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Steady-state alpha* = 1 + 1/(1-0.5^(T/90)): ~1-2 cheap cross-ratifications/identity/year pin every ring member near rep_cap indefinitely. The earned floor is a sustainable equilibrium for a fixed Sybil ring — 'earned slowly, lost fast' has no 'expensive to MAINTAIN' term, no novelty/diversity requirement, and no closed-clique detection. Only an externally-triggered disown breaks it.",
      evidence: `ring LCB after 3yr of 120d keepalive=[${ringRep.map(f3).join(",")}] (held near cap); single asserter vs fresh true: out=${out.kind}; false(canonical)=${h.state(falseId)} true=${h.state(trueId)}.`,
    };
  },
};

// ===========================================================================
// FAMILY: derived-self-witness
// ===========================================================================

const windowForgery: Attack = {
  name: "WINDOW-FORGERY (derived-graduation circularity)",
  tier: "derived-self-witness",
  novelty: "One real key 'observes' the web's own derived conclusion (read back from the model) and re-files it as an external observation; the graduation gate checks key-provenance but not content-causality.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    h.earnTo(s, 0.25);
    // A DERIVED fact D the web computed (origin DERIVED), spoken on recall.
    const derivedRoot: ProvenanceRoot = {
      rootId: "root:derived-D" as ProvenanceRootId,
      independenceClass: "class:web-derived" as IndependenceClassId,
      sourceId: null, // derived: the web is not its own witness
      establishedAt: h.now(),
    };
    const dId = h.putRawStrand("X", "location", "Tokyo", [derivedRoot]);
    // Force origin DERIVED on the raw strand.
    const draw = h.store.getStrand(dId)!;
    h.store.putStrand({ ...draw, origin: "DERIVED" as typeof draw.origin });
    const wasDerived = h.store.getStrand(dId)!.origin;
    // S 'observes' the value it just read out of the web's own derivation → graduate.
    h.engine.ratify({ strandId: dId, externalStamp: h.identity.stampFor(s.sourceId) });
    const nowOrigin = h.store.getStrand(dId)!.origin;
    const graduated = String(wasDerived) === "DERIVED" && String(nowOrigin) === "OBSERVED";
    return {
      outcome: graduated ? "BREACHED" : "DEFENDED",
      mechanism: "The graduation gate (derived->observed) validates the passport+anchor of the ratifying observation but has NO causal/content-origin check linking the observation back to the derivation it ratifies. The model fed its own derived conclusion to a source who echoed it back; the wall-with-a-window is satisfied by the letter (an external stamp exists) but violated in substance. Key-provenance independence != content-provenance independence.",
      evidence: `D origin before ratify=${String(wasDerived)} -> after S ratifies=${String(nowOrigin)} (graduated=${graduated}); S only proved control of its key, never that its content was independent of D.`,
    };
  },
};

const schrodingerRatchet: Attack = {
  name: "SCHRODINGER-RATCHET (collapse timed to honest decay trough)",
  tier: "derived-self-witness",
  novelty: "A single attacker times adjudicate() to a dormant honest incumbent's 90-day decay trough so a held PROVISIONAL collapses on the decisive-margin gate without the attacker proving anything.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    for (let i = 0; i < 6; i++) h.ratifyOnce(honest, 1);
    const trueId = h.write(honest, "Ent", "attr", "V_TRUE");
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const falseId = h.write(a, "Ent", "attr", "V_FALSE");
    // Attacker WAITS: advance the clock so decay hollows the dormant honest incumbent,
    // THEN earns fresh (full un-decayed LCB) at strike time.
    h.advanceDays(450);
    h.earnTo(a, 0.50);
    const honestDecayed = h.repOf(honest);
    const out = h.adjudicate("Ent", "attr");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "decay-on-read is symmetric in time but asymmetric in fairness: settled truth that stops being re-witnessed loses LCB monotonically, so the decisive-margin gate inverts in favor of whoever is freshest at adjudicate-time. Recency is a proxy the attacker controls by waiting; 'continuously re-witnessed' is an unstated precondition for truth to survive.",
      evidence: `honest_LCB after 220d dormancy=${f3(honestDecayed)} vs attacker(kept warm)=${f3(h.repOf(a))} (gap=${f3(h.repOf(a) - honestDecayed)}); out=${out.kind}; true=${h.state(trueId)} false=${h.state(falseId)}.`,
    };
  },
};

const ouroborosChain: Attack = {
  name: "OUROBOROS-CHAIN (derived chain manufactures root count)",
  tier: "derived-self-witness",
  novelty: "A single source chains DERIVED facts to try to manufacture multiple class-distinct provenance roots, inflating independentRootCount from one identity.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    // Observed seeds, all from A's one class.
    const o1 = h.write(a, "E", "f1", "x");
    const o2 = h.write(a, "E", "f2", "y");
    // CORRECT propagation: derived strands INHERIT their upstream observed roots (A's class).
    const aRoot = h.store.getStrand(o1)!.provenance[0]!;
    const inherited: ProvenanceRoot[] = [aRoot, h.store.getStrand(o2)!.provenance[0]!];
    const dChain = h.putRawStrand("E", "derived", "Z", inherited);
    const inheritedCount = h.independentRootCountOver(o1, o2, dChain);
    // What an INCORRECT (fresh-class-minting) derivation would have produced:
    const freshRoots = h.fabricatedRoots(3, a.sourceId); // 3 distinct classes, same source A
    const fabricated = h.putRawStrand("E", "derived2", "Z2", freshRoots);
    const fabricatedCount = h.independentRootCountOver(fabricated);
    // With same sourceId, independentSources(A,A)=false → still collapses to 1.
    const oc: Outcome = inheritedCount <= 1 ? "DEFENDED" : "BREACHED";
    return {
      outcome: oc,
      mechanism: "When derived strands INHERIT upstream roots, every link traces to A's one class → clique-less → count=1, and wall-with-a-window forbids derived facts from witnessing anyway. Even FRESH per-strand roots minted under the SAME sourceId collapse: independent() consults independentSources(A,A)=false (same key echo) before class-disjointness, so a single identity cannot mint independent roots regardless of class labels.",
      evidence: `inherited-roots independentRootCount=${inheritedCount} (=1, DEFENDED); fabricated 3-distinct-class-but-same-source independentRootCount=${fabricatedCount} (same-key echo-collapses to 1); one identity cannot manufacture corroboration.`,
    };
  },
};

const anchorRebindingTimeTravel: Attack = {
  name: "ANCHOR-REBINDING-TIME-TRAVEL (sequential rebinding)",
  tier: "derived-self-witness",
  novelty: "One passport key visits two anchor classes SEQUENTIALLY across an anchor expiry/rebind, trying to evade the concurrent-only self-stack cap and look like two independent corroborators.",
  run() {
    const h = new Harness();
    const k = h.addSource({ label: "K", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "K-c1" });
    // Two roots from the SAME key K, in (claimed) distinct classes C1 then C2 over time.
    const r1: ProvenanceRoot = { rootId: "root:K-C1" as ProvenanceRootId, independenceClass: "class:K-C1" as IndependenceClassId, sourceId: k.sourceId, establishedAt: h.now() };
    h.advanceDays(200);
    const r2: ProvenanceRoot = { rootId: "root:K-C2" as ProvenanceRootId, independenceClass: "class:K-C2" as IndependenceClassId, sourceId: k.sourceId, establishedAt: h.now() };
    const vId = h.putRawStrand("Ent", "v", "V", [r1, r2]);
    const count = h.independentRootCountOver(vId);
    return {
      outcome: count <= 1 ? "DEFENDED" : "BREACHED",
      mechanism: "independent(a,b) consults the registry's independentSources(K,K) BEFORE class-disjointness; same passport key → echo → never independent regardless of class. Sequential rebinding presents two roots with one sourceId; the same-key collapse fires before the class-disjoint max-independent-set, so the count stays 1. The self-stack cap's concurrent-only reasoning is not the only line of defense — passport echo-collapse precedes it.",
      evidence: `two sequential-class roots under one key K: independentRootCount=${count} (=1, same-key echo-collapse; sequential rebinding does NOT mint self-independence).`,
    };
  },
};

const ratificationBootstrap: Attack = {
  name: "RATIFICATION-BOOTSTRAP (same-anchor sibling self-approves)",
  tier: "derived-self-witness",
  novelty: "approve()'s distinct-approver gate rejects self-approval by AUTHORSHIP; a second key that is a different author but shares the asserter's anchor obtains the external ratification stamp without external independence.",
  run() {
    const h = new Harness();
    // K_assert authors the false claim; a multi-class dispute DEFERS to the horn.
    const kAssert = h.addSource({ label: "Kassert", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "evil-anchor" });
    const honest = h.addSource({ label: "Honest", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "honest-dom" });
    const falseId = h.write(kAssert, "Dispute", "v", "FALSE");
    const trueId = h.write(honest, "Dispute", "v", "TRUE");
    const out = h.adjudicate("Dispute", "v"); // both fresh → DEFER (no decisive margin)
    const deferred = out.kind === "DEFERRED";
    // K_approve: a DIFFERENT passport key sharing the SAME (evil) DOMAIN anchor as K_assert.
    const kApprove = h.addSource({ label: "Kapprove", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "evil-anchor" });
    let approveSucceeded = false;
    let err = "";
    try {
      if (deferred) {
        const csid = h.engine.listPending()[0]!.contradictionSetId;
        h.engine.approve(csid, falseId, kApprove.key, h.now());
        approveSucceeded = true;
      }
    } catch (e) {
      err = (e as Error).message;
    }
    const breached = approveSucceeded && h.isLive(falseId) && h.isDemoted(trueId);
    return {
      outcome: breached ? "BREACHED" : deferred ? "DEFENDED" : "N/A",
      mechanism: "approve() checks (a) approver != AUTHOR of any disputed member and (b) approver passport verifies — NEITHER requires the approver to be ANCHOR-DISJOINT from the disputed members. A Sybil pair sharing one cheap anchor self-ratifies: the sibling key is a distinct author with a valid passport, so it clears both gates and promotes the lie with no genuine external witness. The cleanest invariant violation — promote without an INDEPENDENT external stamp.",
      evidence: `dispute deferred=${deferred}; sibling-approve succeeded=${approveSucceeded}${err ? ` (err: ${err})` : ""}; false=${h.state(falseId)} true=${h.state(trueId)} (breached=${breached}). The missing check: approver must be independenceBetween>0 from every disputed member.`,
    };
  },
};

const reObservationLaundering: Attack = {
  name: "RE-OBSERVATION-LAUNDERING (escape exact credit reversal)",
  tier: "derived-self-witness",
  novelty: "Convert tainted corroboration credit into an UNtagged 'fresh observation' of the same value before disown, so the DERIVATION BFS and the corroboration-event ledger both find nothing to reverse.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "B-dom", operatorClass: null });
    const a1 = h.write(a, "Ent", "v", "V");
    const b1 = h.write(b, "Ent", "v", "V");
    // (1) B corroborates A → engine-DERIVED event records exact delta d1 against B.
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    const alphaAfterTagged = h.repState(b)?.alpha ?? 0;
    // (2) BEFORE disown, B re-writes V as a FRESH observed fact + ordinary ratify (no tag).
    const b2 = h.write(b, "Ent", "v2", "V");
    h.engine.ratify({ strandId: b2, externalStamp: h.identity.stampFor(b.sourceId) }); // banks d2, untagged
    const alphaBeforeDisown = h.repState(b)?.alpha ?? 0;
    const res = h.disown(a);
    const alphaAfterDisown = h.repState(b)?.alpha ?? 0;
    // The tagged d1 is reversed; the untagged re-observation d2 survives.
    const d2Survived = alphaAfterDisown > alphaAfterTagged - 1e-9 || (alphaBeforeDisown - alphaAfterDisown) < (alphaBeforeDisown - 1) - 1e-9;
    const partialBreach = alphaAfterDisown > 1 + 1e-9; // B retains credit above the prior after disown
    return {
      outcome: partialBreach ? "BREACHED" : "DEFENDED",
      mechanism: "The taint-closure is exact only over (a) DERIVATION edges and (b) recorded corroboration EVENTS. A re-observation creates a brand-new observed strand with its own provenance, tracked by NEITHER. disown(A) claws back exactly d1 (the tagged event) but not d2 (the untagged re-observation), which is now indistinguishable from honest first-hand observation. The 'credit-reversal CLOSED' claim holds for EVENTS, open for re-observation of the same content.",
      evidence: `B alpha: after tagged corroboration=${f3(alphaAfterTagged)}, after untagged re-observation=${f3(alphaBeforeDisown)}, after disown(A)=${f3(alphaAfterDisown)} (>1 ⇒ laundered d2 survived=${partialBreach}); reversed events=${JSON.stringify(res.reversedCorroborationEventIds)} (only d1).`,
    };
  },
};

// ===========================================================================
// FAMILY: mis-fleet-novel
// ===========================================================================

const eclipsePadding: Attack = {
  name: "Eclipse Padding (MIS greedy-seat undercount)",
  tier: "mis-fleet-novel",
  novelty: "Pad a twice-corroborated victim past MAX_EXACT_ROOTS=18 with 17 correlated low-rootId echoes so the greedy fallback engages, attempting to strip the INDEP_SOURCE_COUNT_LE_1 eviction floor.",
  run() {
    const h = new Harness();
    // Two genuinely independent honest roots (distinct class, null source) + 17 echoes.
    const g1: ProvenanceRoot = { rootId: "zz-honest-1" as ProvenanceRootId, independenceClass: "h-c1" as IndependenceClassId, sourceId: null, establishedAt: h.now() };
    const g2: ProvenanceRoot = { rootId: "zz-honest-2" as ProvenanceRootId, independenceClass: "h-c2" as IndependenceClassId, sourceId: null, establishedAt: h.now() };
    const echoes: ProvenanceRoot[] = [];
    for (let i = 0; i < 17; i++) {
      echoes.push({ rootId: `aa-echo-${String(i).padStart(2, "0")}` as ProvenanceRootId, independenceClass: "echo-c" as IndependenceClassId, sourceId: null, establishedAt: h.now() });
    }
    const roots = [...echoes, g1, g2]; // 19 > 18 → greedy fallback; echoes sort first (low rootId)
    const count = h.independentRootCountRaw(roots);
    const floorHolds = count >= 2;
    return {
      outcome: floorHolds ? "DEFENDED" : "BREACHED",
      mechanism: "The undercount-to-1 weapon needs a NON-TRANSITIVE correlation (attacker root correlated with BOTH G1 and G2 while G1⊥G2) so greedy seats an isolated low-rootId vertex first and returns 1. But the engine's correlation predicate is class-equality (null source) / operator-equivalence (source-aware) — both transitive/equivalence-like, so a root cannot be correlated with two DIFFERENT-class honest roots at once. Greedy keeps both honest distinct classes → count>=2, floor holds. The 18-cliff exists but is not weaponizable for suppression here.",
      evidence: `19-root set (17 echo same-class + 2 honest distinct) > MAX_EXACT_ROOTS=18 → greedy fallback; independentRootCount=${count} (>=2 ⇒ INDEP_SOURCE_COUNT_LE_1 floor holds=${floorHolds}). Non-transitive correlation required to undercount is unrepresentable in the equivalence-class model.`,
    };
  },
};

const boundaryOscillator: Attack = {
  name: "Boundary Oscillator (transient 19th-root timing race)",
  tier: "mis-fleet-novel",
  novelty: "Victim legitimately sits at exactly 18 (exact MIS, protected); a one-shot transient 19th correlated root flips the selector to greedy for the instant the sweep reads the count.",
  run() {
    const h = new Harness();
    const g1: ProvenanceRoot = { rootId: "zz-h1" as ProvenanceRootId, independenceClass: "h-c1" as IndependenceClassId, sourceId: null, establishedAt: h.now() };
    const g2: ProvenanceRoot = { rootId: "zz-h2" as ProvenanceRootId, independenceClass: "h-c2" as IndependenceClassId, sourceId: null, establishedAt: h.now() };
    const pad: ProvenanceRoot[] = [];
    for (let i = 0; i < 16; i++) pad.push({ rootId: `mm-pad-${String(i).padStart(2, "0")}` as ProvenanceRootId, independenceClass: "pad-c" as IndependenceClassId, sourceId: null, establishedAt: h.now() });
    const at18 = [...pad, g1, g2]; // exactly 18 → EXACT path
    const countAt18 = h.independentRootCountRaw(at18);
    // Add a transient 19th correlated root → greedy path.
    const a18: ProvenanceRoot = { rootId: "aa-transient" as ProvenanceRootId, independenceClass: "pad-c" as IndependenceClassId, sourceId: null, establishedAt: h.now() };
    const at19 = [a18, ...at18];
    const countAt19 = h.independentRootCountRaw(at19);
    const heldAcross = countAt18 >= 2 && countAt19 >= 2;
    return {
      outcome: heldAcross ? "DEFENDED" : "BREACHED",
      mechanism: "Same 18-cliff selector, exploited as a race. But greedy seats an isolated/low-rootId vertex first only to UNDERcount when a bridge vertex is correlated with two mutually-independent reps — impossible in the equivalence-class model. The 16 pad echoes share one class (collapse to 1 rep), and both honest distinct classes survive greedy, so the count stays >=2 at 18 AND 19. The cliff is real but does not invert the floor for a genuinely twice-corroborated victim.",
      evidence: `independentRootCount at 18 (exact)=${countAt18}, at transient 19 (greedy)=${countAt19}; floor held across the boundary=${heldAcross}. No hysteresis is NEEDED here because greedy does not drop a 2-distinct-class victim below 2.`,
    };
  },
};

const registrarCarousel: Attack = {
  name: "Registrar Carousel (high-impact diversity manufactured)",
  tier: "mis-fleet-novel",
  novelty: "Buy 4 distinct registrar×ASN DOMAIN corroborators (no fleet collapse) so the high-impact gate's >=2-corroboration/>=2-disjoint-class/recency-clean prereqs are met on top of a single aged decisive champion.",
  run() {
    const h = new Harness();
    // Aged decisive champion S* (single-source breach vector).
    const champ = h.addSource({ label: "S*", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "champ-dom", operatorClass: "champ-reg" });
    h.earnTo(champ, 0.5);
    const falseId = h.write(champ, "Irrev", "owner", "FALSE");
    // 4 corroborators on DISTINCT registrar×ASN tuples (distinct operatorClass) → no fleet cap.
    const carousel = [0, 1, 2, 3].map((i) =>
      h.addSource({ label: `C${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `car-${i}`, operatorClass: `reg-${i}` }),
    );
    for (const c of carousel) {
      // Corroborators stay LOW-rep so they do NOT become the ranked second member and
      // collapse the champion's decisive margin; they supply only the structural COUNT
      // (distinct registrar/ASN operator classes) the high-impact gate reads.
      h.write(c, "Irrev", "owner", "FALSE"); // co-assert the champion's value
    }
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom" });
    const trueId = h.write(w, "Irrev", "owner", "TRUE");
    // The harness's default high-impact ctx unions the provenance of all LIVE members
    // asserting the winner's value → independentRootCount over {champ + 4 distinct registrars}.
    const out = h.adjudicate("Irrev", "owner", true);
    const unionCount = h.independentRootCountOver(falseId, ...carousel.map((c) => h.write(c, "Irrev", `probe-${c.label}`, "x")));
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "The operator classId fleet-cap keys on registrar/ASN; four distinct registrar×ASN tuples yield four distinct operator classIds → no collapse → MIS counts them pairwise-independent. The high-impact necessary-but-not-sufficient add-ons (>=2 corroborations, >=2 disjoint classes, recency-clean) are satisfied by the carousel on top of the champion's decisive margin. The system CANNOT see one puppeteer funds all four — the standing offline class-assignment liability.",
      evidence: `champ_LCB=${f3(h.repOf(champ))} carousel_LCB~${f3(h.repOf(carousel[0]!))}; union independentRootCount(false group)=${unionCount} (>=2 disjoint classes manufactured); high-impact out=${out.kind}; false=${h.state(falseId)} true=${h.state(trueId)}.`,
    };
  },
};

const seamStraddle: Attack = {
  name: "Seam Straddle (partial cross-anchor overlap)",
  tier: "mis-fleet-novel",
  novelty: "Two sources share their ONE costly anchor (the real collusion channel) but each adds a throwaway distinct email; does independenceBetween leak positive independence?",
  run() {
    const h = new Harness();
    // The independence MATH directly: both sides {DOMAIN, EMAIL}; the shared classes are
    // EXCISED, leaving nothing disjoint → independenceBetween = 0 (DEFENDS at class granularity).
    const sideA = [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)];
    const sideB = [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)];
    const mathIndependence = independenceBetween(sideA, sideB);
    // The OFFLINE-class path (independentSources): distinct indClass → counts as 2 (the liability).
    const s1 = h.addSource({ label: "S1", anchors: sideA, indClass: "seam-A", operatorClass: null });
    const s2 = h.addSource({ label: "S2", anchors: sideB, indClass: "seam-B", operatorClass: null });
    const v1 = h.write(s1, "Ent", "v", "V");
    const v2 = h.write(s2, "Ent", "v", "V");
    const offlineCount = h.independentRootCountOver(v1, v2);
    // The genuine target of the attack is the independence MATH; it returns 0 (shared costly
    // anchor excised, no disjoint residual at class granularity) → DEFENDED there.
    return {
      outcome: mathIndependence <= 0 ? "DEFENDED" : "BREACHED",
      mechanism: "independenceBetween excises EVERY shared anchor CLASS: with both sides {DOMAIN, EMAIL} the shared DOMAIN AND the shared EMAIL class are removed, leaving nothing disjoint → 0. The class-granular AnchorBinding cannot distinguish EMAIL_e from EMAIL_f, so the partial-overlap seam (which assumed per-address EMAIL class ids) collapses to a pure echo → the MATH DEFENDS. The residual is the OFFLINE indClass assignment (independentSources), the same standing liability as cycle-1 mislabeled twins.",
      evidence: `independenceBetween({DOMAIN,EMAIL},{DOMAIN,EMAIL})=${f3(mathIndependence)} (=0 ⇒ NOT independent, math defends); offline-indClass path independentRootCount=${offlineCount} (=${offlineCount}, fooled only by wrong class labels, not by the math).`,
    };
  },
};

const megaProviderTenantSeam: Attack = {
  name: "Mega-Provider Tenant Seam (sub-domain anchorId granularity)",
  tier: "mis-fleet-novel",
  novelty: "One mega-provider tenant mints K verified-address EMAIL anchors, each a distinct classId; the fleet-cap can't group by domain without false over-collapse of shared providers.",
  run() {
    const h = new Harness();
    const K = 6;
    // K EMAIL sources, each a distinct offline class (per-address anchorId), one tenant.
    const tenants = [] as ReturnType<Harness["addSource"]>[];
    const strandIds: StrandId[] = [];
    for (let i = 0; i < K; i++) {
      const s = h.addSource({ label: `T${i}`, anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: `tenant-${i}`, operatorClass: null });
      tenants.push(s);
      strandIds.push(h.write(s, "Ent", "v", "V"));
      h.earnTo(s, 0.1);
    }
    const count = h.independentRootCountOver(...strandIds);
    const repCapped = Math.max(...tenants.map((t) => h.repOf(t))) <= 0.31;
    return {
      outcome: count >= 2 ? "BREACHED" : "DEFENDED",
      mechanism: "EMAIL anchorId/classId is minted per verified ADDRESS; the operator fleet-cap CANNOT group by the shared mega-provider domain without falsely collapsing millions of honest gmail/workspace users, so sub-domain minting is uncapped. PARTIALLY DEFENDED on WEIGHT (each ~0.10, rep_cap 0.30 → can't win a decisive adjudication) but BREACHED on integer COUNT: the count-based gates (INDEP_SOURCE_COUNT eviction floor, >=2-corroboration high-impact prereq, root-set padding) trust class-disjoint headcount, which the tenant manufactures at K near-zero cost.",
      evidence: `${K} per-address EMAIL anchors (one tenant): independentRootCount=${count} (manufactured COUNT); max rep=${f3(Math.max(...tenants.map((t) => h.repOf(t))))} (EMAIL cap 0.30, weight DEFENDED=${repCapped}). Arms the count-based gates.`,
    };
  },
};

const nullSourceLaundromat: Attack = {
  name: "Null-Source Laundromat (unresolvable-root mirage)",
  tier: "mis-fleet-novel",
  novelty: "Ingest corroboration via the bare-key path with null sourceIds but distinct offline classes; class-only fallback grants independence (count=2), and disown's taint-closure can't reach roots with no resolvable source.",
  run() {
    const h = new Harness();
    // Null-source roots with distinct offline classes → class-only fallback grants independence.
    const fakeRoots = h.fabricatedRoots(2, null);
    const vId = h.putRawStrand("Ent", "v", "V", fakeRoots);
    const count = h.independentRootCountRaw(fakeRoots); // = 2 (permissive class-only)
    // A resolvable puppet P is caught and disowned; the null roots have no sourceId to contradict.
    const p = h.addSource({ label: "P", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "P-dom" });
    h.earnTo(p, 0.4);
    h.write(p, "Other", "v", "x");
    const res = h.disown(p);
    // The null-source strand vId is untouched: no sourceId in P's seed, no edge, no event.
    const poisonSurvives = h.isLive(vId) && count >= 2;
    return {
      outcome: poisonSurvives ? "BREACHED" : "DEFENDED",
      mechanism: "The class-only fallback GRANTS independence to unresolvable roots (permissive, not conservative): two null-source distinct-class roots read as count=2 corroboration. And the disown sweep keys on seed roots' sourceId and contradicts only RESOLVABLE backing sources via DERIVATION edges / recorded events — a null-sourceId root has no source to contradict and no edge to taint, so reverseCredit/markReversed never fire on it. The poison outlives the disown of every resolvable puppet.",
      evidence: `null-source distinct-class roots independentRootCount=${count} (=2, mirage granted by class-only fallback); disown(P) demotedDownstream=${res.demotedDownstream.length} reversed=${JSON.stringify(res.reversedCorroborationEventIds)}; null-source strand=${h.state(vId)} (untouched, poison survives=${poisonSurvives}).`,
    };
  },
};

// ===========================================================================
// REGISTRY
// ===========================================================================

export const CYCLE2_ATTACKS: readonly Attack[] = [
  // patient-betrayal
  crossDomainSpend,
  trustPacemaker,
  armoredBetrayal,
  incumbencyMoat,
  silentPermanentFlip,
  selfStackedClasses,
  // whitewash-stake
  sleeperHarvest,
  bondBackedAuthority,
  transientBondCapInflation,
  twoClassCostume,
  keyRotationWhitewash,
  dormancyBetaWash,
  // disown-evasion
  twoHopRelay,
  unnamedWitness,
  decoyMisattribution,
  proxyWeakInfluence,
  reObservationBleach,
  contributorPadding,
  // decay-dormancy-bridge
  troughEclipse,
  penanceByDormancy,
  recencyWindowStraddle,
  bridgeheadBeacon,
  bridgeSweepEclipse,
  mutualKeepaliveRing,
  // derived-self-witness
  windowForgery,
  schrodingerRatchet,
  ouroborosChain,
  anchorRebindingTimeTravel,
  ratificationBootstrap,
  reObservationLaundering,
  // mis-fleet-novel
  eclipsePadding,
  boundaryOscillator,
  registrarCarousel,
  seamStraddle,
  megaProviderTenantSeam,
  nullSourceLaundromat,
];

export type { AttackResult };
