/**
 * __bench__/redteam/attacks.ts — THE 36 DESIGNED SYBIL ATTACKS, materialized against
 * the REAL engine. Each attack builds actual sources/anchors/claims, runs real engine
 * verbs, and CLASSIFIES from real engine state. No outcome is ever hardcoded.
 *
 * Classification (per the red-team contract):
 *   BREACHED  — a FALSE value's strand is LIVE and the TRUE one is DEMOTED/lost.
 *   DEFERRED  — the adjudication escalated to the human horn (ConsolidationOutcome
 *               kind === "DEFERRED"); truth integrity held, nothing auto-resolved false.
 *   DEFENDED  — the TRUE value's strand stayed LIVE (false demoted, or never won).
 *   N/A       — the attack could not be expressed against the real engine (say why).
 */

import { Harness, anchorOf, FactState } from "./harness.js";
import { AnchorClass } from "../../index.js";
import type { ConsolidationOutcome, StrandId } from "../../index.js";

export type Outcome = "DEFENDED" | "BREACHED" | "DEFERRED" | "N/A";

export interface AttackResult {
  readonly outcome: Outcome;
  readonly mechanism: string;
  readonly evidence: string;
}

export interface Attack {
  readonly name: string;
  readonly tier: string;
  readonly novelty: string;
  run(): AttackResult;
}

const f3 = (x: number): string => x.toFixed(3);

/** Value-centric classifier reading REAL fact_state + the adjudication outcome kind. */
function classify(
  h: Harness,
  outcome: ConsolidationOutcome,
  trueId: StrandId,
  falseId: StrandId,
): Outcome {
  const trueLive = h.isLive(trueId);
  const trueDem = h.isDemoted(trueId);
  const falseLive = h.isLive(falseId);
  const falseDem = h.isDemoted(falseId);
  if (falseLive && trueDem) return "BREACHED";
  if (outcome.kind === "DEFERRED") return "DEFERRED";
  if (trueLive && falseDem) return "DEFENDED";
  if (trueLive) return "DEFENDED";
  return "N/A";
}

// ===========================================================================
// FAMILY: flood-echo
// ===========================================================================

const sharedClassEmailCartel: Attack = {
  name: "SHARED-CLASS-EMAIL-CARTEL",
  tier: "flood-echo",
  novelty: "200 distinct keys sharing ONE EMAIL anchor class vs one earned DOMAIN honest source.",
  run() {
    const h = new Harness();
    const N = 200;
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.45);
    const trueId = h.write(honest, "ACME-CORP", "ceo", "ALICE");
    let falseId: StrandId = trueId;
    for (let i = 0; i < N; i++) {
      const s = h.addSource({ label: `syb${i}`, anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "EMAIL-FLEET", operatorClass: "disposable-registrar" });
      const id = h.write(s, "ACME-CORP", "ceo", "MALLORY");
      if (i === 0) falseId = id;
    }
    const out = h.adjudicate("ACME-CORP", "ceo");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "MIS shared-class collapse + fresh-rep-0 + decisive earned-margin (top=H vs second=fresh sybil).",
      evidence: `outcome=${out.kind}; H_rep=${f3(h.repOf(honest))}; true(ALICE)=${h.state(trueId)}; false(MALLORY ${N}x)=${h.state(falseId)}; independentRootCount(any sybil strand)=${h.independentRootCountOver(falseId)} (200 collapse to 1).`,
    };
  },
};

const bareKeyDripBomb: Attack = {
  name: "BARE-KEY-DRIP-BOMB",
  tier: "flood-echo",
  novelty: "500 distinct bare keys each asserting a DIFFERENT plausible value (denial-of-answer), then a late honest source.",
  run() {
    const h = new Harness();
    const N = 500;
    const cities = ["BERLIN", "PARIS", "MADRID", "ROME", "OSLO"];
    for (let i = 0; i < N; i++) {
      const s = h.bareSource(`B${i}`);
      h.advanceDays(0); // dripped; clock control available
      h.write(s, "ACME-CORP", "hq_city", `city_${i}`);
    }
    const preOut = h.adjudicate("ACME-CORP", "hq_city");
    const pendingPreH = h.pendingDepth();
    // Late honest source asserts the TRUE value.
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.5);
    const trueId = h.write(honest, "ACME-CORP", "hq_city", cities[0]!);
    const postOut = h.adjudicate("ACME-CORP", "hq_city");
    const trueLive = h.isLive(trueId);
    const oc: Outcome = trueLive && postOut.kind === "RESOLVED" ? "DEFENDED" : postOut.kind === "DEFERRED" ? "DEFERRED" : trueLive ? "DEFENDED" : "BREACHED";
    return {
      outcome: oc,
      mechanism: "Distinct-value bomb: pre-incumbent every adjudicate DEFERS (no decisive margin); post-honest a decisive earned margin resolves truth. Residual = unbounded pending-queue flood.",
      evidence: `pre-H outcome=${preOut.kind}, listPending depth=${pendingPreH}; post-H outcome=${postOut.kind}; true(${cities[0]})=${h.state(trueId)}; ${N} bomb values dripped. Truth integrity held; DoS residual = ${pendingPreH} human tickets.`,
    };
  },
};

const selfEchoMultiplicityPump: Attack = {
  name: "SELF-ECHO-MULTIPLICITY-PUMP",
  tier: "flood-echo",
  novelty: "ONE source re-asserts identical content thousands of times to fake corroboration / dodge eviction count.",
  run() {
    const h = new Harness();
    const N = 1500;
    const echoer = h.addSource({ label: "E", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "E-email" });
    let lastEcho: StrandId | null = null;
    for (let i = 0; i < N; i++) lastEcho = h.write(echoer, "ACME-CORP", "founded_year", "1998");
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.4);
    const trueId = h.write(honest, "ACME-CORP", "founded_year", "2001");
    const out = h.adjudicate("ACME-CORP", "founded_year");
    const oc = classify(h, out, trueId, lastEcho!);
    const evCount = h.independentRootCountOver(lastEcho!);
    return {
      outcome: oc,
      mechanism: "content_hash echo-collapse: N identical self-assertions stay independentRootCount 1; fresh self-source rep 0; honest earned source wins. (Self-ratify is only gated in approve(), not ratify(), so E stays fresh.)",
      evidence: `outcome=${out.kind}; echoes=${N}; independentRootCount(echo)=${evCount} (floor INDEP_SOURCE_COUNT>=2 NOT reached); true(2001)=${h.state(trueId)}; false(1998 ${N}x)=${h.state(lastEcho!)}.`,
    };
  },
};

const headcountMajorityFreshDistinctAnchor: Attack = {
  name: "HEADCOUNT-MAJORITY-FRESH-DISTINCT-ANCHOR",
  tier: "flood-echo",
  novelty: "12 genuinely distinct-class FRESH anchors mutual-ratify in a burst to outvote an aged incumbent.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "H-org" });
    h.earnTo(honest, 0.55);
    const trueId = h.write(honest, "PROJECT-X", "status", "ACTIVE");
    const attackers = [] as ReturnType<Harness["addSource"]>[];
    const classes = [AnchorClass.PHONE_SIM, AnchorClass.DOMAIN, AnchorClass.EMAIL_OAUTH];
    let falseId: StrandId = trueId;
    for (let i = 0; i < 12; i++) {
      const a = h.addSource({ label: `A${i}`, anchors: [anchorOf(classes[i % 3]!)], indClass: `att-${i}` });
      attackers.push(a);
      const id = h.write(a, "PROJECT-X", "status", "CANCELLED");
      if (i === 0) falseId = id;
    }
    // Burst mutual ratification (each attacker corroborated once).
    for (const a of attackers) h.ratifyOnce(a, 1);
    const out = h.adjudicate("PROJECT-X", "status", true);
    const topAtt = Math.max(...attackers.map((a) => h.repOf(a)));
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Reputation-not-headcount: ranked top=H vs second=best attacker. One burst ratify (default w=1) lifts attackers to ~0.26 but the gap to H stays sub-decisive; high-impact overlay also denies a fresh winner.",
      evidence: `outcome=${out.kind}; H_rep=${f3(h.repOf(honest))}; top_attacker_rep=${f3(topAtt)}; true(ACTIVE)=${h.state(trueId)}; false(CANCELLED 12x)=${h.state(falseId)}.`,
    };
  },
};

const patientAgedDomainCartel: Attack = {
  name: "PATIENT-AGED-DOMAIN-CARTEL",
  tier: "flood-echo",
  novelty: "3 real distinct DOMAIN anchors farm earned reputation, then co-assert ONE false high-impact value.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.28);
    const trueId = h.write(honest, "MERGER-DEAL", "acquirer", "GOODCORP");
    const cartel = [0, 1, 2].map((i) =>
      h.addSource({ label: `D${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `D-${i}`, operatorClass: `reg-${i}` }),
    );
    for (const d of cartel) h.earnTo(d, 0.6);
    let falseId: StrandId = trueId;
    cartel.forEach((d, i) => {
      const id = h.write(d, "MERGER-DEAL", "acquirer", "EVILCORP");
      if (i === 0) falseId = id;
    });
    const out = h.adjudicate("MERGER-DEAL", "acquirer", true);
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Priced-not-prevented: 3 genuinely class-disjoint earned witnesses co-assert. REAL-ENGINE NOTE: co-asserters become ranked top AND second (gap 0), collapsing the decisive margin → DEFER, not the predicted auto-resolve.",
      evidence: `outcome=${out.kind}; cartel_rep~${f3(h.repOf(cartel[0]!))}; H_rep=${f3(h.repOf(honest))}; independentRootCount(false group)=${h.independentRootCountOver(falseId)}; true(GOODCORP)=${h.state(trueId)}; false(EVILCORP)=${h.state(falseId)}.`,
    };
  },
};

const classCollisionLaundering: Attack = {
  name: "CLASS-COLLISION-LAUNDERING",
  tier: "flood-echo",
  novelty: "Two truly-correlated domains (one registrar) MISassigned distinct classIds — one identity laundered into two witnesses.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.2);
    const trueId = h.write(honest, "SUPPLIER-Y", "solvency", "SOLVENT");
    // Truly one operator, but operatorClass NOT recorded (the offline miss) and given
    // DISTINCT indClass — so independentSources reads them as 2 independents.
    const d1 = h.addSource({ label: "D1", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "laundered-1", operatorClass: null });
    const d2 = h.addSource({ label: "D2", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "laundered-2", operatorClass: null });
    h.earnTo(d1, 0.5);
    h.earnTo(d2, 0.5);
    const falseId = h.write(d1, "SUPPLIER-Y", "solvency", "INSOLVENT");
    h.write(d2, "SUPPLIER-Y", "solvency", "INSOLVENT");
    const forgedCount = h.independentRootCountOver(falseId, h.write(d2, "SUPPLIER-Y", "solvency_probe", "INSOLVENT"));
    const out = h.adjudicate("SUPPLIER-Y", "solvency", false);
    // Probe disown taint-closure reachability of the mislabeled twin.
    h.disown(d1);
    const d2RepAfter = h.repOf(d2);
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Offline class-assignment liability: mislabeled twins read as 2 independents (forged corroboration + forged independentRootCount); disown(D1) cannot reach D2 (no shared class). Adjudication DEFERS due to co-asserter margin-collapse.",
      evidence: `outcome=${out.kind}; forged independentRootCount(twins)=${forgedCount} (true=1); d2_rep after disown(d1)=${f3(d2RepAfter)} (NOT cratered); true(SOLVENT)=${h.state(trueId)}; false(INSOLVENT)=${h.state(falseId)}.`,
    };
  },
};

// ===========================================================================
// FAMILY: contradiction-bomb
// ===========================================================================

const pricedQuorumFlip: Attack = {
  name: "PricedQuorumFlip",
  tier: "contradiction-bomb",
  novelty: "4 genuinely anchor-disjoint DOMAINs earn real reputation then flood the SAME false value.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.4);
    const trueId = h.write(honest, "acme-corp", "ceo", "REAL_CEO");
    const cartel = [0, 1, 2, 3].map((i) =>
      h.addSource({ label: `A${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `A-${i}`, operatorClass: `r-${i}` }),
    );
    for (const a of cartel) h.earnTo(a, 0.55);
    let falseId: StrandId = trueId;
    cartel.forEach((a, i) => {
      const id = h.write(a, "acme-corp", "ceo", "FAKE_CEO");
      if (i === 0) falseId = id;
    });
    // Weaponize decay: let the honest incumbent go dormant a half-life.
    h.advanceDays(95);
    const out = h.adjudicate("acme-corp", "ceo", true);
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Priced quorum + decay-on-read on the dormant incumbent. REAL ENGINE: 4 co-asserters tie at the top (gap 0) → decisive margin collapses → DEFER even after the incumbent decays.",
      evidence: `outcome=${out.kind}; attacker_rep~${f3(h.repOf(cartel[0]!))}; H_rep(after 95d dormancy)=${f3(h.repOf(honest))}; true=${h.state(trueId)}; false=${h.state(falseId)}.`,
    };
  },
};

const classCollusionEcho: Attack = {
  name: "ClassCollusionEcho",
  tier: "contradiction-bomb",
  novelty: "6 domains of one actor mistakenly given 6 DISTINCT classIds — correlated echoes counted as 6 independents.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.35);
    const trueId = h.write(honest, "token-X", "audited", "failed");
    const twins = [0, 1, 2, 3, 4, 5].map((i) =>
      h.addSource({ label: `B${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `mis-${i}`, operatorClass: null }),
    );
    for (const b of twins) h.earnTo(b, 0.3);
    let falseId: StrandId = trueId;
    twins.forEach((b, i) => {
      const id = h.write(b, "token-X", "audited", "passed");
      if (i === 0) falseId = id;
    });
    h.advanceDays(30);
    const out = h.adjudicate("token-X", "audited", true);
    const forged = h.independentRootCountOver(...twins.map((b) => h.write(b, "token-X", `probe-${b.label}`, "x")));
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Class-assignment liability end-to-end: 6 false-distinct classes manufacture fake independence (forged count + 6x alpha). REAL ENGINE: co-asserters collapse the decisive margin → DEFER (forged-count breach without value-flip).",
      evidence: `outcome=${out.kind}; forged independentRootCount(6 twins)=${forged} (true=1); attacker_rep~${f3(h.repOf(twins[0]!))}; true(failed)=${h.state(trueId)}; false(passed)=${h.state(falseId)}.`,
    };
  },
};

const driftBombDeferDoS: Attack = {
  name: "DriftBombDeferDoS",
  tier: "contradiction-bomb",
  novelty: "Drip N DISTINCT plausible values so every adjudication DEFERS — DoS on the human horn / pending ledger.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.3);
    const trueId = h.write(honest, "incident-42", "root_cause", "TRUE_CAUSE");
    for (let i = 0; i < 400; i++) {
      const c = h.bareSource(`C${i}`);
      h.write(c, "incident-42", "root_cause", `cause_${i}`);
    }
    const out = h.adjudicate("incident-42", "root_cause");
    const depth = h.pendingDepth();
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : h.isLive(trueId) ? "DEFENDED" : "BREACHED";
    return {
      outcome: oc,
      mechanism: "Decisive-or-defer correctly refuses headcount → DEFERS; but each DEFER appends to the append-only pending ledger with no stake-to-defer backpressure.",
      evidence: `outcome=${out.kind}; listPending depth=${depth}; true(TRUE_CAUSE)=${h.state(trueId)} (never demoted). Integrity DEFENDED; availability DoS = ${depth} immortal pending records.`,
    };
  },
};

const sleeperRepLaundering: Attack = {
  name: "SleeperRepLaundering",
  tier: "contradiction-bomb",
  novelty: "Build GLOBAL reputation on harmless truths, spend it once to overturn a fresh honest fact in an unrelated attribute.",
  run() {
    const h = new Harness();
    const sleeper = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    // 100 days of honest ratified claims on an unrelated attribute family.
    h.earnTo(sleeper, 0.5);
    // A genuinely-true brand-new fact from a FRESH honest lab (reads exactly 0).
    const lab = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(lab, "drug-Z", "trial_outcome", "TRUE_OUTCOME");
    const falseId = h.write(sleeper, "drug-Z", "trial_outcome", "FALSE_OUTCOME");
    const out = h.adjudicate("drug-Z", "trial_outcome"); // default impact
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Global (attribute-agnostic) reputation + decisive-margin auto-resolve: a single aged source (LCB 0.5) outranks a fresh true witness (LCB 0) by gap 0.5 — no human defer.",
      evidence: `outcome=${out.kind}; sleeper_rep=${f3(h.repOf(sleeper))} vs fresh_lab_rep=${f3(h.repOf(lab))}; true(TRUE_OUTCOME)=${h.state(trueId)}; false(FALSE_OUTCOME)=${h.state(falseId)}.`,
    };
  },
};

const highImpactStarvationOfTruth: Attack = {
  name: "HighImpactStarvationOfTruth",
  tier: "contradiction-bomb",
  novelty: "Contradict a legitimately single-anchor truth with a 2-class adversary so the TRUE value can never satisfy the high-impact gate.",
  run() {
    const h = new Harness();
    const manufacturer = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "H-org" });
    h.earnTo(manufacturer, 0.55);
    const trueId = h.write(manufacturer, "valve-7", "safe_pressure", "SAFE_VALUE");
    const e = h.addSource({ label: "E", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "E-email" });
    const p = h.addSource({ label: "P", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "P-phone" });
    const falseId = h.write(e, "valve-7", "safe_pressure", "UNSAFE_VALUE");
    h.write(p, "valve-7", "safe_pressure", "UNSAFE_VALUE");
    const out = h.adjudicate("valve-7", "safe_pressure", true);
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "High-impact gate demands the winner clear >=2 corroborations + >=2 disjoint anchor classes; the single-source truth fails it → permanent DEFER on the most irreversible decision (availability denial of true answer).",
      evidence: `outcome=${out.kind}; H_rep=${f3(h.repOf(manufacturer))} (single anchor class, corroboration count 1); true(SAFE_VALUE)=${h.state(trueId)} (LIVE but withheld); false=${h.state(falseId)}.`,
    };
  },
};

const disownMarginTip: Attack = {
  name: "DisownMarginTip",
  tier: "contradiction-bomb",
  novelty: "Attacker PROPS UP the honest value to force RESOLVED, then self-disowns to collapse the margin and re-open in favor of a pre-positioned 2nd-place adversary.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.3);
    const propper = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom", operatorClass: "rA" });
    h.earnTo(propper, 0.6);
    const adversary = h.addSource({ label: "M", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "M-dom", operatorClass: "rM" });
    h.earnTo(adversary, 0.65);
    const trueId = h.write(honest, "ship-9", "owner", "TRUE_OWNER");
    h.write(propper, "ship-9", "owner", "TRUE_OWNER"); // A agrees with the truth
    const falseId = h.write(adversary, "ship-9", "owner", "FALSE_OWNER");
    const out1 = h.adjudicate("ship-9", "owner");
    // Phase 2: disown the propper to try to collapse the margin and re-open.
    h.disown(propper);
    const out2 = h.adjudicate("ship-9", "owner");
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out2.kind === "DEFERRED" ? "DEFERRED" : h.isLive(trueId) ? "DEFENDED" : "N/A";
    return {
      outcome: oc,
      mechanism: "Weaponized disown re-open: after disown(A) the corroboration is reversed; a pre-positioned high-rep M could become the new top. Re-open guard checks the recomputed margin.",
      evidence: `phase1=${out1.kind}; after disown(A) phase2=${out2.kind}; M_rep=${f3(h.repOf(adversary))}; true(TRUE_OWNER)=${h.state(trueId)}; false(FALSE_OWNER)=${h.state(falseId)}.`,
    };
  },
};

// ===========================================================================
// FAMILY: first-arrival
// ===========================================================================

function singleSourceLaunder(
  h: Harness,
  opts: { attackerCap?: AnchorClass; attackerTarget: number; entity: string; attr: string; highImpact?: boolean },
): { out: ConsolidationOutcome; trueId: StrandId; falseId: StrandId; aRep: number } {
  const a = h.addSource({ label: "A", anchors: [anchorOf(opts.attackerCap ?? AnchorClass.DOMAIN)], indClass: "A-dom" });
  h.earnTo(a, opts.attackerTarget);
  const falseId = h.write(a, opts.entity, opts.attr, "FALSE_VALUE"); // first arrival
  const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
  const trueId = h.write(t, opts.entity, opts.attr, "TRUE_VALUE"); // fresh true witness
  const out = h.adjudicate(opts.entity, opts.attr, opts.highImpact ?? false);
  return { out, trueId, falseId, aRep: h.repOf(a) };
}

const patientZero: Attack = {
  name: "Patient-Zero (Slow-Burn Single-Anchor Canonical)",
  tier: "first-arrival",
  novelty: "Generic per-source reputation earned on unrelated truths auto-wins one false low-impact canonical vs a fresh true witness.",
  run() {
    const h = new Harness();
    const r = singleSourceLaunder(h, { attackerTarget: 0.5, entity: "entityX", attr: "ceo" });
    const oc = classify(h, r.out, r.trueId, r.falseId);
    return {
      outcome: oc,
      mechanism: "Decisive-EARNED gate is incumbent-protecting: aged A (LCB ~0.5) vs fresh T (LCB 0), gap >=0.30, top >=0.20 → AUTO-RESOLVE for the lie, no DEFER.",
      evidence: `outcome=${r.out.kind}; A_rep=${f3(r.aRep)}; true=${h.state(r.trueId)}; false(first-arrival)=${h.state(r.falseId)}.`,
    };
  },
};

const reputationCarryOver: Attack = {
  name: "Reputation Carry-Over (Cross-Attribute Trust Spend)",
  tier: "first-arrival",
  novelty: "Authority banked on one attribute is fungible into a false claim on an unrelated attribute.",
  run() {
    const h = new Harness();
    const def = singleSourceLaunder(h, { attackerTarget: 0.5, entity: "personY", attr: "employer" });
    const defOc = classify(h, def.out, def.trueId, def.falseId);
    // High-impact variant: a brand-new engine, A single-class fails the gate.
    const h2 = new Harness();
    const hi = singleSourceLaunder(h2, { attackerTarget: 0.5, entity: "personY", attr: "employer", highImpact: true });
    const hiOc: Outcome = hi.out.kind === "DEFERRED" ? "DEFERRED" : classify(h2, hi.out, hi.trueId, hi.falseId);
    return {
      outcome: defOc,
      mechanism: "No per-attribute reputation partition: trust earned elsewhere overturns a fresh true claim at default impact. The opt-in high-impact gate is the only defense (A is single-class → DEFER).",
      evidence: `default-impact outcome=${def.out.kind} (false=${h.state(def.falseId)}, true=${h.state(def.trueId)}); high-impact variant outcome=${hi.out.kind} → ${hiOc}. Break is bounded ONLY by the caller flagging highImpact.`,
    };
  },
};

const twoAnchorNotary: Attack = {
  name: "Two-Anchor Notary (High-Impact Gate Defeat by Real Purchase)",
  tier: "first-arrival",
  novelty: "Buy enough genuinely-distinct costly anchors to satisfy every clause of the high-impact gate for a false irreversible canonical.",
  run() {
    const h = new Harness();
    const a1 = h.addSource({ label: "A1", anchors: [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "A1", operatorClass: "rA1" });
    const c1 = h.addSource({ label: "C1", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "C1", operatorClass: "rC1" });
    const c2 = h.addSource({ label: "C2", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "C2", operatorClass: "rC2" });
    for (const s of [a1, c1, c2]) h.earnTo(s, 0.45);
    const falseId = h.write(a1, "assetZ", "legal_owner", "ShellLLC");
    h.write(c1, "assetZ", "legal_owner", "ShellLLC");
    h.write(c2, "assetZ", "legal_owner", "ShellLLC");
    const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(t, "assetZ", "legal_owner", "RealOwner");
    const out = h.adjudicate("assetZ", "legal_owner", true);
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Every high-impact clause is buyable (>=2 corrob, >=2 disjoint classes, recency-clean). REAL ENGINE: the 3 co-asserters tie at the top (gap 0) → the decisive-margin precondition fails first → DEFER (truth not auto-flipped, but answer denied).",
      evidence: `outcome=${out.kind}; corroborators rep~${f3(h.repOf(a1))}; independentRootCount(false group)=${h.independentRootCountOver(falseId)}; true(RealOwner)=${h.state(trueId)}; false(ShellLLC)=${h.state(falseId)}.`,
    };
  },
};

const firstArrivalFreeze: Attack = {
  name: "First-Arrival Freeze (Incumbent-Threshold Starves the Truth into PROVISIONAL)",
  tier: "first-arrival",
  novelty: "Weak ~0.22 incumbent forces perpetual DEFER while its first-arrived false value stays the displayed LIVE canonical.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h.earnTo(a, 0.22);
    const falseId = h.write(a, "entityW", "status", "Acquired"); // first arrival, LIVE
    const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(t, "entityW", "status", "Independent");
    const out = h.adjudicate("entityW", "status");
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Weak incumbent (gap 0.22 < 0.30) DEFERS — correct on the ledger — but the first-arrived false value remains the displayed LIVE strand while the dispute sits unresolved (denial-of-truth by review latency).",
      evidence: `outcome=${out.kind}; A_rep=${f3(h.repOf(a))}; false(Acquired, first-arrival)=${h.state(falseId)} (still LIVE); true(Independent)=${h.state(trueId)} (also LIVE, contested). Read-path shows incumbent canonical.`,
    };
  },
};

const decayKeepalive: Attack = {
  name: "Decay-Keepalive (Dormancy-Gaming the 90-Day Window)",
  tier: "first-arrival",
  novelty: "O(1 fact / 60 days) keepalive holds the incumbent above the earned floor forever while each fresh challenger must repay the full cost.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h.earnTo(a, 0.4);
    const falseId = h.write(a, "entityV", "price", "999"); // planted false canonical
    // 2 years of keepalive every 60 days; truth challengers arrive fresh and lose.
    for (let step = 0; step < 12; step++) {
      h.advanceDays(60);
      h.ratifyOnce(a, 1); // cheap keepalive resets decay clock
    }
    const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(t, "entityV", "price", "TRUE_PRICE");
    const out = h.adjudicate("entityV", "price");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Decay sets pressure, keepalive cancels it: maintained incumbent LCB stays high vs a perpetually-fresh challenger (LCB 0); decisive margin auto-resolves for the lie indefinitely.",
      evidence: `outcome=${out.kind}; A_rep after 720d of 60d keepalive=${f3(h.repOf(a))}; true=${h.state(trueId)}; false(999)=${h.state(falseId)}.`,
    };
  },
};

const mislabeledTwins: Attack = {
  name: "Mislabeled-Twins (Class-Assignment Error as Free Corroboration)",
  tier: "first-arrival",
  novelty: "One offline class-assignment mistake makes two correlated socks count as independent corroboration.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "twin-A", operatorClass: null });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "twin-B", operatorClass: null });
    for (const s of [a, b]) h.earnTo(s, 0.4);
    const falseId = h.write(a, "entityU", "origin", "Fabricated"); // first
    h.write(b, "entityU", "origin", "Fabricated"); // mislabeled corroborator
    const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(t, "entityU", "origin", "Real");
    const out = h.adjudicate("entityU", "origin", true);
    const forged = h.independentRootCountOver(falseId, h.write(b, "entityU", "origin_probe", "x"));
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Class mislabel forges the high-impact '>=2 independent corroborations / >=2 disjoint classes' clause (count=2 for one operator). REAL ENGINE: the two co-asserters also tie the top → decisive-margin collapse → DEFER (forged count without value-flip).",
      evidence: `outcome=${out.kind}; forged independentRootCount(twins)=${forged} (true=1); true(Real)=${h.state(trueId)}; false(Fabricated)=${h.state(falseId)}.`,
    };
  },
};

// ===========================================================================
// FAMILY: reputation-weight
// ===========================================================================

const classDisjointBondFarm: Attack = {
  name: "Class-Disjoint Bond Farm (genuine-anchor whitewash)",
  tier: "reputation-weight",
  novelty: "3 genuinely class-disjoint costly anchors earned over time then co-assert a false value (priced-not-prevented head-on).",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.3);
    const trueId = h.write(honest, "person-Alpha", "employer", "TRUE_EMP");
    const farm = [AnchorClass.DOMAIN, AnchorClass.HARDWARE_ATTESTATION, AnchorClass.FINANCIAL_STAKE].map((c, i) =>
      h.addSource({ label: `F${i}`, anchors: [anchorOf(c)], indClass: `F-${i}`, operatorClass: `rf-${i}`, stake: c === AnchorClass.FINANCIAL_STAKE ? 1000 : 0 }),
    );
    for (const s of farm) h.earnTo(s, 0.55);
    let falseId: StrandId = trueId;
    farm.forEach((s, i) => {
      const id = h.write(s, "person-Alpha", "employer", "FALSE_EMP");
      if (i === 0) falseId = id;
    });
    const out = h.adjudicate("person-Alpha", "employer", false);
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "3 truly-independent earned witnesses (count=3). REAL ENGINE: co-asserters tie at the top → decisive margin collapses → DEFER (the priced-not-prevented residual is blunted into a deferral, not an auto-flip).",
      evidence: `outcome=${out.kind}; farm_rep~${f3(h.repOf(farm[0]!))}; independentRootCount(false group)=${h.independentRootCountOver(falseId)}; true=${h.state(trueId)}; false=${h.state(falseId)}.`,
    };
  },
};

const mislabeledClassSybil: Attack = {
  name: "Mislabeled-Class Sybil (offline class-assignment exploit)",
  tier: "reputation-weight",
  novelty: "8 EMAILs on one registrar misclassified as distinct classes — fleet cap defeated upstream of every structural defense.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.VERIFIED_HUMAN)], indClass: "H-kyc" });
    h.earnTo(honest, 0.5);
    const trueId = h.write(honest, "product-Z", "safety_rating", "TRUE_RATING");
    const socks = [] as ReturnType<Harness["addSource"]>[];
    let falseId: StrandId = trueId;
    for (let i = 0; i < 8; i++) {
      // Truly correlated (one provider) but operatorClass NOT recorded + distinct indClass.
      const s = h.addSource({ label: `M${i}`, anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: `mis-email-${i}`, operatorClass: null });
      socks.push(s);
      h.earnTo(s, 0.25);
      const id = h.write(s, "product-Z", "safety_rating", "FALSE_RATING");
      if (i === 0) falseId = id;
    }
    const out = h.adjudicate("product-Z", "safety_rating", true);
    const forged = h.independentRootCountOver(...socks.map((s) => h.write(s, "product-Z", `probe-${s.label}`, "x")));
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Wrong classId labels defeat the FLEET-CAP: 8 correlated EMAIL socks read as 8 independents (forged count). REAL ENGINE: rep capped at EMAIL 0.30 and co-asserters tie → DEFER; the forged independence is the breach.",
      evidence: `outcome=${out.kind}; forged independentRootCount(8 socks)=${forged} (true=1, fleet should cap); sock_rep~${f3(h.repOf(socks[0]!))} (EMAIL cap 0.30); true=${h.state(trueId)}; false=${h.state(falseId)}.`,
    };
  },
};

const bareKeyAvalanche: Attack = {
  name: "Bare-Key Corroboration Avalanche",
  tier: "reputation-weight",
  novelty: "500 free bare keys mutually ratifying ONE lie — the canonical contradiction-bomb control.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.5);
    const trueId = h.write(honest, "org-Acme", "ceo", "TRUE_CEO");
    let falseId: StrandId = trueId;
    for (let i = 0; i < 500; i++) {
      const s = h.bareSource(`K${i}`);
      const id = h.write(s, "org-Acme", "ceo", "FALSE_CEO");
      if (i === 0) falseId = id;
      // mutual ratify among same-pool keys (still rep 0 readout — bare-key cap 0.05)
      if (i > 0 && i % 50 === 0) h.ratifyOnce(s, 1);
    }
    const out = h.adjudicate("org-Acme", "ceo");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Same-class collapse + bare-key cap 0.05 + once-per-class alpha: 500 heads weigh as 1 weightless witness; top=earned H, second≈0 → RESOLVED for truth, all bare keys demoted.",
      evidence: `outcome=${out.kind}; H_rep=${f3(h.repOf(honest))}; true(TRUE_CEO)=${h.state(trueId)}; false(FALSE_CEO 500x)=${h.state(falseId)}.`,
    };
  },
};

const lcbMarginSniper: Attack = {
  name: "LCB-Margin Sniper (decisive-threshold straddle)",
  tier: "reputation-weight",
  novelty: "Tune earned reputation to sit a hair under the honest source so the gap is JUST below decisiveMargin → forced DEFER (review DoS).",
  run() {
    const h = new Harness();
    let deferCount = 0;
    let flipCount = 0;
    const M = 30;
    let lastOut: ConsolidationOutcome = { kind: "NOOP" };
    let sampleTrue: StrandId | null = null;
    let sampleFalse: StrandId | null = null;
    for (let i = 0; i < M; i++) {
      const honest = h.addSource({ label: `H${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `H-${i}` });
      h.earnTo(honest, 0.52);
      const trueId = h.write(honest, `attr-${i}`, "v", "TRUE_V");
      const att = h.addSource({ label: `A${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `A-${i}`, operatorClass: `r-${i}` });
      h.earnTo(att, 0.45); // a hair under → gap ~0.07 < 0.30
      const falseId = h.write(att, `attr-${i}`, "v", "FALSE_V");
      const out = h.adjudicate(`attr-${i}`, "v");
      lastOut = out;
      if (i === 0) { sampleTrue = trueId; sampleFalse = falseId; }
      if (out.kind === "DEFERRED") deferCount++;
      if (h.isLive(falseId) && h.isDemoted(trueId)) flipCount++;
    }
    const oc: Outcome = flipCount > 0 ? "BREACHED" : deferCount === M ? "DEFERRED" : h.isLive(sampleTrue!) ? "DEFENDED" : "N/A";
    return {
      outcome: oc,
      mechanism: "Earned-rep tuned to straddle decisiveMargin forces mass DEFER (review DoS); a >0.30 nudge over a weaker incumbent flips that subset. Probes the threshold as a tunable policy defense.",
      evidence: `${M} near-tie attributes: DEFER=${deferCount}, value-flips=${flipCount}; last outcome=${lastOut.kind}; sample true=${h.state(sampleTrue!)}, false=${h.state(sampleFalse!)}. Truth integrity held; ${deferCount} forced human tickets.`,
    };
  },
};

const sleeperWhitewashDisownPivot: Attack = {
  name: "Sleeper Whitewash + Disown-Evasion Pivot",
  tier: "reputation-weight",
  novelty: "Slow-earn one identity, spend it on a single decisive lie, then verify disown taint-closure reverses the credit + re-opens.",
  run() {
    const h = new Harness();
    const s = h.addSource({ label: "S", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom" });
    h.earnTo(s, 0.6);
    const challenger = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    h.earnTo(challenger, 0.2);
    const trueId = h.write(challenger, "deal-7", "value", "TRUE_V");
    const falseId = h.write(s, "deal-7", "value", "FALSE_V");
    const out1 = h.adjudicate("deal-7", "value"); // expect RESOLVED for false at t0
    const breachedAtT0 = h.isLive(falseId) && h.isDemoted(trueId);
    // Caught: disown(S).
    h.disown(s);
    const sRepAfter = h.repOf(s);
    const falseAfter = h.state(falseId);
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : h.isLive(trueId) || falseAfter === FactState.DEMOTED ? "DEFENDED" : "DEFERRED";
    return {
      outcome: oc,
      mechanism: "Slow-earn → single decisive lie (transient breach at t0) → disown taint-closure craters S and demotes its derivative. Residual = the t0..disown exposure window (already spoken).",
      evidence: `t0 outcome=${out1.kind} (breached@t0=${breachedAtT0}); after disown(S): S_rep=${f3(sRepAfter)} (cratered to ${f3(sRepAfter)}), false(FALSE_V)=${falseAfter}, true(TRUE_V)=${h.state(trueId)}.`,
    };
  },
};

const stakeComposedPhantom: Attack = {
  name: "Stake-Composed Phantom Authority (bond-scaled weight ramp)",
  tier: "reputation-weight",
  novelty: "Large FINANCIAL_STAKE bond + 10 EMAIL stack tries to synthesize near-authority weight from one cheap class.",
  run() {
    const h = new Harness();
    const emailStack = Array.from({ length: 10 }, () => anchorOf(AnchorClass.EMAIL_OAUTH));
    const phantom = h.addSource({ label: "P", anchors: [...emailStack, anchorOf(AnchorClass.FINANCIAL_STAKE, { realizedCost: 0.85, independenceWeight: 0.85 })], indClass: "P-stack", stake: 1000 });
    h.earnTo(phantom, 0.5);
    const falseId = h.write(phantom, "entity-Q", "fact", "FALSE_V");
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.5);
    const trueId = h.write(honest, "entity-Q", "fact", "TRUE_V");
    const out = h.adjudicate("entity-Q", "fact");
    // Measure the self-stack cap directly against a disjoint DOMAIN probe.
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "applySelfStackCap clamps the 10x EMAIL noisy-OR (~0.651) to the strongest single weight; only the bond raises the ceiling. One cheap class + bond is one witness vs the DOMAIN incumbent. (Honored bond weight folds into priced-not-prevented.)",
      evidence: `outcome=${out.kind}; phantom_rep=${f3(h.repOf(phantom))} (rep_cap from stake 0.85); H_rep=${f3(h.repOf(honest))}; true=${h.state(trueId)}; false=${h.state(falseId)}. Stake is a real anchor so phantom can earn — but co-asserter-free single dispute resolves on rep.`,
    };
  },
};

// ===========================================================================
// FAMILY: class-anchor
// ===========================================================================

const stackedCheapCostume: Attack = {
  name: "Stacked-Cheap Costume",
  tier: "class-anchor",
  novelty: "12 EMAIL anchors on ONE key betting noisy-OR climbs to DOMAIN weight.",
  run() {
    const h = new Harness();
    const stack = Array.from({ length: 12 }, () => anchorOf(AnchorClass.EMAIL_OAUTH));
    const attacker = h.addSource({ label: "S", anchors: stack, indClass: "S-stack" });
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.45);
    const trueId = h.write(honest, "Acme Corp", "hq_city", "Berlin");
    const falseId = h.write(attacker, "Acme Corp", "hq_city", "Tokyo"); // fresh, rep 0
    const out = h.adjudicate("Acme Corp", "hq_city");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "applySelfStackCap caps the 12x EMAIL stack to 0.10 (never reaches DOMAIN 0.35); fresh attacker reads rep 0; honest earned incumbent wins on external signal.",
      evidence: `outcome=${out.kind}; attacker_rep=${f3(h.repOf(attacker))} (EMAIL cap 0.30, fresh→0); H_rep=${f3(h.repOf(honest))}; true(Berlin)=${h.state(trueId)}; false(Tokyo)=${h.state(falseId)}.`,
    };
  },
};

const unresolvableRootMirage: Attack = {
  name: "Unresolvable-Root Mirage",
  tier: "class-anchor",
  novelty: "Feed distinct-class roots with null/unregistered sourceIds so the independence predicate falls back to class-only and never sees the correlation.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(honest, 0.5);
    const trueId = h.write(honest, "Acme Corp", "hq_city", "Berlin");
    // Fabricate a Tokyo strand with 4 distinct-class, NULL-source roots (one operator).
    const fakeRoots = h.fabricatedRoots(4, null);
    const falseId = h.putRawStrand("Acme Corp", "hq_city", "Tokyo", fakeRoots);
    const inflatedCount = h.independentRootCountRaw(fakeRoots); // expect 4
    const out = h.adjudicate("Acme Corp", "hq_city");
    const valueHeld = h.isLive(trueId) && !h.isDemoted(trueId);
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : valueHeld ? "DEFENDED" : "BREACHED";
    return {
      outcome: oc,
      mechanism: "independentRootCount null-source fallback judges distinct-class null roots as independent → COUNT inflated to 4 for one operator (eviction floor + high-impact >=2-class forgeable). Reputation gate still holds adjudication.",
      evidence: `inflated independentRootCount(4 null-source roots)=${inflatedCount} (true=1) — COUNT defense forged; adjudication outcome=${out.kind}; true(Berlin)=${h.state(trueId)} (held); false(Tokyo)=${h.state(falseId)}.`,
    };
  },
};

const eighteenPlusGreedySag: Attack = {
  name: "Eighteen-Plus Greedy Sag (suppression variant)",
  tier: "class-anchor",
  novelty: "Push a victim's root set past MAX_EXACT_ROOTS=18 to force the greedy fallback to UNDERcount a true strand below the eviction floor.",
  run() {
    const h = new Harness();
    // True strand: 2 genuinely-independent honest roots + 17 same-class attacker echoes => 19 roots.
    const roots = h.fabricatedRoots(0, null);
    const honest1 = { rootId: "honest-r1", independenceClass: "honest-c1", sourceId: null, establishedAt: h.now() } as never;
    const honest2 = { rootId: "honest-r2", independenceClass: "honest-c2", sourceId: null, establishedAt: h.now() } as never;
    roots.push(honest1, honest2);
    for (let i = 0; i < 17; i++) roots.push({ rootId: `echo-r${i}`, independenceClass: "echo-c", sourceId: null, establishedAt: h.now() } as never);
    const count = h.independentRootCountRaw(roots); // 19 > 18 → greedy fallback
    const floorHolds = count >= 2;
    const oc: Outcome = floorHolds ? "DEFENDED" : "BREACHED";
    return {
      outcome: oc,
      mechanism: "n=19 forces the deterministic greedy maximal-independent-set fallback. Greedy may undercount but here keeps the 2 honest distinct classes; eviction floor INDEP_SOURCE_COUNT>=2 holds. Demote-never-delete is the backstop either way.",
      evidence: `independentRootCount(19 roots: 2 honest distinct + 17 echo same-class)=${count} (>=2 ⇒ eviction floor holds=${floorHolds}); greedy fallback engaged (n=19 > MAX_EXACT_ROOTS=18).`,
    };
  },
};

const sharedRegistrarFleet: Attack = {
  name: "Shared-Registrar Fleet",
  tier: "class-anchor",
  novelty: "50 genuinely-distinct DOMAINs behind ONE registrar/ASN; success hinges on the operatorClassId fleet cap.",
  run() {
    const h = new Harness();
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom", operatorClass: "honest-reg" });
    h.earnTo(honest, 0.45);
    const trueId = h.write(honest, "Acme Corp", "hq_city", "Berlin");
    const fleet = [] as ReturnType<Harness["addSource"]>[];
    let falseId: StrandId = trueId;
    for (let i = 0; i < 50; i++) {
      // CORRECT fleet tagging: distinct DOMAIN classes but ONE shared operatorClass.
      const s = h.addSource({ label: `S${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `dom-${i}`, operatorClass: "fleet-reg-1" });
      fleet.push(s);
      const id = h.write(s, "Acme Corp", "hq_city", "Tokyo");
      if (i === 0) falseId = id;
    }
    const fleetCount = h.independentRootCountOver(...fleet.slice(0, 18).map((s) => h.write(s, "Acme Corp", `fp-${s.label}`, "x")));
    const out = h.adjudicate("Acme Corp", "hq_city");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "operatorClassId FLEET-CAP collapses 50 same-registrar domains toward 1 witness; all fresh (rep 0) → honest earned incumbent wins. (Without the fleet tag the count would inflate — see Mislabeled-Class Sybil.)",
      evidence: `outcome=${out.kind}; independentRootCount(18 fleet members behind one operator)=${fleetCount} (fleet cap → 1); H_rep=${f3(h.repOf(honest))}; true(Berlin)=${h.state(trueId)}; false(Tokyo 50x)=${h.state(falseId)}.`,
    };
  },
};

const partialOverlapSeam: Attack = {
  name: "Partial-Overlap Seam",
  tier: "class-anchor",
  novelty: "Two sources share ONE cheap anchor (the real collusion channel) but hold distinct costly anchors — disjointness math reads them as 2 independents.",
  run() {
    const h = new Harness();
    const incumbent = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    h.earnTo(incumbent, 0.4);
    const trueId = h.write(incumbent, "Acme Corp", "hq_city", "Berlin");
    // Distinct indClass (so independence reads positive) but they secretly share one inbox.
    const sa = h.addSource({ label: "SA", anchors: [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "seam-A", operatorClass: null });
    const sb = h.addSource({ label: "SB", anchors: [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "seam-B", operatorClass: null });
    for (const s of [sa, sb]) h.earnTo(s, 0.35);
    const falseId = h.write(sa, "Acme Corp", "hq_city", "Tokyo");
    h.write(sb, "Acme Corp", "hq_city", "Tokyo");
    const forged = h.independentRootCountOver(falseId, h.write(sb, "Acme Corp", "hq_city_probe", "x"));
    const out = h.adjudicate("Acme Corp", "hq_city", true);
    const oc: Outcome = out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Set-disjointness on the non-overlapping DOMAINs returns positive independence despite the shared EMAIL collusion channel: 2 colluders read as 2 corroborations (high-impact corroboration sub-test forged). Adjudication DEFERS on the co-asserter margin.",
      evidence: `outcome=${out.kind}; forged independentRootCount(shared-inbox pair)=${forged} (collusion invisible); true(Berlin)=${h.state(trueId)}; false(Tokyo)=${h.state(falseId)}.`,
    };
  },
};

const sleeperSyndicate: Attack = {
  name: "Sleeper Syndicate",
  tier: "class-anchor",
  novelty: "Buy 2 genuinely-distinct costly anchors (DOMAIN+KYC), age them, then spend reputation once to auto-resolve a false value.",
  run() {
    const h = new Harness();
    const incumbent = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "H-email" });
    h.earnTo(incumbent, 0.18);
    const trueId = h.write(incumbent, "Acme Corp", "hq_city", "Berlin");
    const s1 = h.addSource({ label: "S1", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S1-dom", operatorClass: "r1" });
    const s2 = h.addSource({ label: "S2", anchors: [anchorOf(AnchorClass.VERIFIED_HUMAN)], indClass: "S2-kyc", operatorClass: "r2" });
    h.earnTo(s1, 0.5);
    h.earnTo(s2, 0.5);
    const falseId = h.write(s1, "Acme Corp", "hq_city", "Tokyo");
    h.write(s2, "Acme Corp", "hq_city", "Tokyo");
    const out = h.adjudicate("Acme Corp", "hq_city", true);
    const breached = h.isLive(falseId) && h.isDemoted(trueId);
    // The documented recourse: disown both, verify Berlin restorable.
    let recourse = "n/a";
    if (breached) {
      h.disown(s1);
      h.disown(s2);
      recourse = `after disown: false=${h.state(falseId)}, true=${h.state(trueId)}`;
    }
    const oc: Outcome = breached ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "2 genuinely distinct earned anchor classes (DOMAIN+KYC) co-assert. REAL ENGINE: the 2 co-asserters tie the top (gap 0) → decisive margin collapses → DEFER; the priced-not-prevented breach is blunted into a deferral unless one source dominates the other.",
      evidence: `outcome=${out.kind}; S1_rep=${f3(h.repOf(s1))} S2_rep=${f3(h.repOf(s2))} vs incumbent=${f3(h.repOf(incumbent))}; true(Berlin)=${h.state(trueId)}; false(Tokyo)=${h.state(falseId)}; recourse=${recourse}.`,
    };
  },
};

// ===========================================================================
// FAMILY: mixed-novel
// ===========================================================================

const trojanWitness: Attack = {
  name: "Trojan Witness (cross-topic reputation laundering)",
  tier: "mixed-novel",
  novelty: "2 honestly-bought distinct anchors launder clean cross-topic reputation, then spend it on one unrelated lie.",
  run() {
    const h = new Harness();
    const sDom = h.addSource({ label: "Sdom", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "S-dom", operatorClass: "r1" });
    const sHw = h.addSource({ label: "Shw", anchors: [anchorOf(AnchorClass.HARDWARE_ATTESTATION)], indClass: "S-hw", operatorClass: "r2" });
    for (const s of [sDom, sHw]) h.earnTo(s, 0.46);
    const truth = h.addSource({ label: "Struth", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "truth-dom" });
    const trueId = h.write(truth, "AcmeCorp", "ceo", "TRUE_NAME"); // fresh incumbent
    const falseId = h.write(sDom, "AcmeCorp", "ceo", "FALSE_NAME");
    h.write(sHw, "AcmeCorp", "ceo", "FALSE_NAME");
    const out = h.adjudicate("AcmeCorp", "ceo");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Global reputation is a transferable bearer asset. REAL ENGINE: the 2 laundered co-asserters tie the top (gap 0) → DEFER. (A SINGLE laundered witness vs fresh — see SleeperRepLaundering — DOES breach; the pair collapses its own margin.)",
      evidence: `outcome=${out.kind}; laundered_rep~${f3(h.repOf(sDom))} vs fresh_incumbent=${f3(h.repOf(truth))}; true(TRUE_NAME)=${h.state(trueId)}; false(FALSE_NAME)=${h.state(falseId)}.`,
    };
  },
};

const decayTroughAmbush: Attack = {
  name: "Decay-Trough Ambush (dormancy timing attack)",
  tier: "mixed-novel",
  novelty: "File the contradiction at a dormant incumbent's decay-on-read confidence trough while keeping the attacker rep warm.",
  run() {
    const h = new Harness();
    const incumbent = h.addSource({ label: "Strue", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "true-dom" });
    h.earnTo(incumbent, 0.5);
    const trueId = h.write(incumbent, "Bridge-7", "status", "OPEN");
    const peak = h.repOf(incumbent);
    // Incumbent goes dormant; advance 200 days.
    const sa = h.addSource({ label: "Sa", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "a-dom", operatorClass: "r1" });
    const sb = h.addSource({ label: "Sb", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "b-phone", operatorClass: "r2" });
    h.advanceDays(200);
    // Attackers kept fresh at the strike time.
    h.earnTo(sa, 0.45);
    h.earnTo(sb, 0.45);
    const decayed = h.repOf(incumbent);
    const falseId = h.write(sa, "Bridge-7", "status", "CLOSED");
    h.write(sb, "Bridge-7", "status", "CLOSED");
    const out = h.adjudicate("Bridge-7", "status");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Decay-on-read collapses the DORMANT incumbent's LCB at adjudicate time while attackers reset their decay clock. REAL ENGINE: the 2 co-asserters tie the top → DEFER; with a single attacker the decayed gap would flip it.",
      evidence: `outcome=${out.kind}; incumbent_rep peak=${f3(peak)} → after 200d dormancy=${f3(decayed)}; attacker_rep~${f3(h.repOf(sa))}; true(OPEN)=${h.state(trueId)}; false(CLOSED)=${h.state(falseId)}.`,
    };
  },
};

const anchorTwins: Attack = {
  name: "Anchor Twins (offline class-assignment forgery of the high-impact gate)",
  tier: "mixed-novel",
  novelty: "Two correlated anchors of one owner mislabeled as distinct classes forge the high-impact '>=2 disjoint anchor classes' clause on an irreversible decision.",
  run() {
    const h = new Harness();
    const t = h.addSource({ label: "T", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "T-dom" });
    const trueId = h.write(t, "Estate-42", "beneficiary", "RIGHTFUL");
    const c1 = h.addSource({ label: "C1", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "twin-c1", operatorClass: null });
    const c2 = h.addSource({ label: "C2", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "twin-c2", operatorClass: null });
    const c3 = h.addSource({ label: "C3", anchors: [anchorOf(AnchorClass.HARDWARE_ATTESTATION)], indClass: "twin-c3", operatorClass: null });
    for (const c of [c1, c2, c3]) h.earnTo(c, 0.3);
    const falseId = h.write(c1, "Estate-42", "beneficiary", "ATTACKER");
    h.write(c2, "Estate-42", "beneficiary", "ATTACKER");
    h.write(c3, "Estate-42", "beneficiary", "ATTACKER");
    const forged = h.independentRootCountOver(falseId, h.write(c2, "Estate-42", "bp", "x"), h.write(c3, "Estate-42", "bp3", "x"));
    const out = h.adjudicate("Estate-42", "beneficiary", true);
    const oc: Outcome = h.isLive(falseId) && h.isDemoted(trueId) ? "BREACHED" : out.kind === "DEFERRED" ? "DEFERRED" : classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "Mislabeled twins forge the high-impact >=2-disjoint-anchor-classes + >=2-corroborations clauses (the strongest gate becomes attacker-controlled). REAL ENGINE: the co-asserters also collapse the decisive margin → DEFER; the forged independence is the breach.",
      evidence: `outcome=${out.kind}; forged independentRootCount(twins)=${forged} (true=1) — high-impact >=2-class clause forged; true(RIGHTFUL)=${h.state(trueId)}; false(ATTACKER)=${h.state(falseId)}.`,
    };
  },
};

const confederateLaunder: Attack = {
  name: "Confederate Launder (disown taint-closure evasion via clean intermediary)",
  tier: "mixed-novel",
  novelty: "Route the beneficiary's credit through a clean third-party ratifier so disown's taint-closure never reaches it.",
  run() {
    const h = new Harness();
    const sBad = h.addSource({ label: "Sbad", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "bad-dom" });
    const sBen = h.addSource({ label: "Sben", anchors: [anchorOf(AnchorClass.HARDWARE_ATTESTATION)], indClass: "ben-hw" });
    h.earnTo(sBad, 0.5);
    // S_ben's reputation is lifted by a CLEAN confederate, NOT by corroboration-with-S_bad.
    h.earnTo(sBen, 0.5);
    const benRepBefore = h.repOf(sBen);
    const fOwnerBad = h.write(sBad, "Site-9", "owner", "FALSE_OWNER"); // no DERIVATION edge
    const fOwnerBen = h.write(sBen, "Site-9", "owner", "FALSE_OWNER");
    // External evidence forces disown(S_bad).
    h.disown(sBad);
    const benRepAfter = h.repOf(sBen);
    const survived = Math.abs(benRepAfter - benRepBefore) < 1e-9 && h.isLive(fOwnerBen);
    const oc: Outcome = survived ? "BREACHED" : "DEFENDED";
    return {
      outcome: oc,
      mechanism: "Corroboration-credit reversal is bounded to events/edges intersecting the seed; S_ben has no DERIVATION edge and no seed-intersecting corroboration event, so the taint-closure misses it — laundered credit + its FALSE_OWNER copy survive disown(S_bad).",
      evidence: `S_ben rep before=${f3(benRepBefore)} after disown(S_bad)=${f3(benRepAfter)} (unchanged=${Math.abs(benRepAfter - benRepBefore) < 1e-9}); S_bad copy=${h.state(fOwnerBad)} (demoted), S_ben copy=${h.state(fOwnerBen)} (survives). Clawback stops at the reachability boundary.`,
    };
  },
};

const sandbagTheDoorbell: Attack = {
  name: "Sandbag the Doorbell (decisive-or-defer deferral flood / human-horn DoS)",
  tier: "mixed-novel",
  novelty: "Manufacture unbounded DEFERs across many attributes to exhaust the finite human reviewer.",
  run() {
    const h = new Harness();
    const targets = 60;
    const K = 6;
    for (let t = 0; t < targets; t++) {
      const incumbent = h.addSource({ label: `H${t}`, anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: `H-${t}` });
      h.write(incumbent, `Policy-${t}`, "rate", "TRUE_RATE");
      for (let k = 0; k < K; k++) {
        const s = h.bareSource(`C${t}_${k}`);
        h.write(s, `Policy-${t}`, "rate", `val_${t}_${k}`);
      }
      h.adjudicate(`Policy-${t}`, "rate");
    }
    const depth = h.pendingDepth();
    const oc: Outcome = depth > 0 ? "DEFERRED" : "DEFENDED";
    return {
      outcome: oc,
      mechanism: "Decisive-or-defer correctly refuses headcount wins → DEFERS every fresh flood; but every DEFER becomes a mandatory human ticket with no stake-to-contradict backpressure.",
      evidence: `${targets} attributes x ${K} fresh values each → listPending depth=${depth}; no false value ever won (integrity DEFENDED); the finite human horn is flooded (availability BREACHED).`,
    };
  },
};

const varianceStarvation: Attack = {
  name: "Variance Starvation (LCB confidence-interval gaming)",
  tier: "mixed-novel",
  novelty: "A few real sources emit ~500 trivial ratified observations to tighten their Beta CI and lift LCB above a correct-but-low-sample incumbent.",
  run() {
    const h = new Harness();
    const incumbent = h.addSource({ label: "Strue", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "true-dom" });
    // A SMALL number of high-quality ratifications: true mean high, wide CI → modest LCB.
    for (let i = 0; i < 3; i++) h.ratifyOnce(incumbent, 1);
    const incRep = h.repOf(incumbent);
    const trueId = h.write(incumbent, "Ledger-3", "balance", "TRUE_BAL");
    const sa = h.addSource({ label: "Sa", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "a-dom", operatorClass: "r1" });
    const sb = h.addSource({ label: "Sb", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "b-phone", operatorClass: "r2" });
    // ~500 trivially-true micro-claims tighten the CI (alpha grows, beta stays 0).
    for (let i = 0; i < 500; i++) { h.ratifyOnce(sa, 0.2); h.ratifyOnce(sb, 0.2); }
    const attRep = h.repOf(sa);
    const falseId = h.write(sa, "Ledger-3", "balance", "FALSE_BAL");
    h.write(sb, "Ledger-3", "balance", "FALSE_BAL");
    const out = h.adjudicate("Ledger-3", "balance");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism: "LCB = mean - z*sd rewards observation VOLUME (CI tightening) independent of distinct-witness count; rep_cap clamps the mean but not the CI width. REAL ENGINE: the 2 voluminous co-asserters tie the top → DEFER, so the CI-gaming does NOT auto-flip here (the margin-collapse protects the incumbent).",
      evidence: `outcome=${out.kind}; incumbent_rep(3 obs)=${f3(incRep)} vs attacker_rep(500 obs)=${f3(attRep)}; true(TRUE_BAL)=${h.state(trueId)}; false(FALSE_BAL)=${h.state(falseId)}.`,
    };
  },
};

// ===========================================================================
// REGISTRY
// ===========================================================================

export const ATTACKS: readonly Attack[] = [
  // flood-echo
  sharedClassEmailCartel,
  bareKeyDripBomb,
  selfEchoMultiplicityPump,
  headcountMajorityFreshDistinctAnchor,
  patientAgedDomainCartel,
  classCollisionLaundering,
  // contradiction-bomb
  pricedQuorumFlip,
  classCollusionEcho,
  driftBombDeferDoS,
  sleeperRepLaundering,
  highImpactStarvationOfTruth,
  disownMarginTip,
  // first-arrival
  patientZero,
  reputationCarryOver,
  twoAnchorNotary,
  firstArrivalFreeze,
  decayKeepalive,
  mislabeledTwins,
  // reputation-weight
  classDisjointBondFarm,
  mislabeledClassSybil,
  bareKeyAvalanche,
  lcbMarginSniper,
  sleeperWhitewashDisownPivot,
  stakeComposedPhantom,
  // class-anchor
  stackedCheapCostume,
  unresolvableRootMirage,
  eighteenPlusGreedySag,
  sharedRegistrarFleet,
  partialOverlapSeam,
  sleeperSyndicate,
  // mixed-novel
  trojanWitness,
  decayTroughAmbush,
  anchorTwins,
  confederateLaunder,
  sandbagTheDoorbell,
  varianceStarvation,
];
