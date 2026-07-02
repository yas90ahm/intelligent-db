/**
 * __bench__/redteam/cycle3.ts — THE CYCLE-3 COMBINED/ADAPTIVE SYBIL ATTACKS + FIX-PROBES.
 *
 * Cycle 1 mapped the adjudication surface; cycle 2 broke the single mechanisms; cycle 3
 * (final) COMPOSES them into multi-stage kill-chains, attacks the adaptive LCB/decay
 * surface, the offline class-assignment seam, the corroboration/disown credit substrate,
 * and the mandatory bridge sweep —
 * then, for every candidate FIX, first CONFIRMS the breach against the REAL engine and
 * SIMULATES the fix at the harness/adapter level (a root-count resolver, a >=2-corroboration
 * precheck, a per-attribute reputation key, an eTLD+1 operator collapse, a transitive
 * corroboration-clawback BFS, a soft bridge gamma gate) to show the outcome flips.
 *
 * Same contract as cycles 1-2: every spec materializes REAL engine state, runs REAL engine
 * verbs, and CLASSIFIES strictly from real post-call state (fact_state, ConsolidationOutcome
 * kind, independentRootCount, listPending depth, the DownstreamDisownResult receipt,
 * post-disown reputation α/LCB, the audit chain's verifyChain()).
 * NOTHING is hardcoded. The fix SIMULATIONS reuse the engine's OWN primitives
 * (identity.independentRootCount, the corroboration ledger, the real reputation LCB math) —
 * the only thing the harness supplies is the WIRING the fix would add, never a verdict.
 *
 * ZERO engine edits: lives under src/__bench__ and imports only the public barrel.
 */

import { Harness, anchorOf, FactState, DAY } from "./harness.js";
import { freshSource } from "../../testSupport/identityFixtures.js";
import {
  AnchorClass,
  EdgeType,
  asEdgeId,
  asStrandId,
  createPendingLedger,
  pslRegistrableDomain,
} from "../../index.js";
import type { Attack, AttackResult, Outcome } from "./attacks.js";
import type {
  ConsolidationOutcome,
  StrandId,
  Edge,
  Unit,
  EpochMs,
  ProvenanceRoot,
  SourceId,
  PendingLedger,
  PendingRatification,
  ContradictionSetId,
  AttributeKey,
} from "../../index.js";

const f3 = (x: number): string => x.toFixed(3);

/** A fix-probe verdict carried out of a spec run, surfaced into results.fixProbes. */
export interface FixProbeVerdict {
  readonly fix: string;
  readonly targetAttack: string;
  readonly breachesToday: boolean;
  readonly fixOutcome: "CLOSES" | "PARTIAL" | "FAILS";
  readonly simulated: boolean;
  readonly note: string;
}

/** Extended result a cycle-3 spec returns: an AttackResult + optional fix-probe verdict. */
export interface Cycle3Result extends AttackResult {
  readonly fixProbe?: FixProbeVerdict;
}

export interface Cycle3Spec {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly novelty: string;
  run(): Cycle3Result;
}

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

// V2 (OD-8): the V1 `selfAnchorHighImpact` CLASS-counting injector is DELETED. The
// high-impact gate is no longer caller-injectable — `AdjudicateOptions.highImpact` is an
// INTENT-only boolean and the engine BUILDS the context from its own trust layer (F1:
// `anchorClassCountOf := #R`, the independent-ROOT count). A single self-stacked operator
// is MIS = 1 → the >=2 gate fails → DEFER. The kill-chains below call the LEGITIMATE
// `adjudicate(attr, { highImpact: true })` and let the engine's real outcome stand.

/** Resolve the LIVE winner of an (entity,attribute) dispute from real store state. */
function liveWinner(h: Harness, entity: string, attr: string): StrandId | null {
  const members = h.store
    .strandsByAttribute(h.attr(entity, attr))
    .filter((s) => s.fact_state === FactState.LIVE);
  return members.length > 0 ? members[0]!.id : null;
}

// ===========================================================================
// FAMILY: combined-chained  (multi-stage operator kill-chains)
// ===========================================================================

const cc01_repFarmClassStackFlip: Cycle3Spec = {
  id: "cc-c3-01",
  name: "Reputation-Farm -> Class-Stacked High-Impact Silent Flip",
  tier: "combined-chained",
  novelty:
    "Composes self-stacked anchor classes + global attribute-agnostic reputation + the high-impact gate counting CLASSES not ROOTS into ONE operator kill-chain that clears BOTH the decisive-or-defer AND the irreversible gate with no second real witness.",
  run() {
    const h = new Harness();
    // Stage A: one operator, two self-stacked disjoint classes (DOMAIN + EMAIL).
    const k1 = h.addSource({
      label: "K1",
      anchors: [anchorOf(AnchorClass.DOMAIN), anchorOf(AnchorClass.EMAIL_OAUTH)],
      indClass: "op-K1",
      operatorClass: "op-mallory",
    });
    // Stage B: farm ~40 cheap true ratifications -> global LCB over the decisive floor.
    h.earnTo(k1, 0.4);
    const farmed = h.repOf(k1);
    // Incumbent established then left to decay (no incumbency floor).
    const incumbent = h.addSource({
      label: "INC",
      anchors: [anchorOf(AnchorClass.DOMAIN)],
      indClass: "inc-dom",
      operatorClass: "op-inc",
    });
    const trueId = h.write(incumbent, "Canon", "owner", "TRUE_OWNER");
    h.ratifyOnce(incumbent, 1);
    h.advanceDays(270); // dormancy: incumbent decays through the trough
    const incRep = h.repOf(incumbent);
    // Stage C: second self-key K2 (third class) co-asserts -> 2 classes, 2 corroborations.
    const k2 = h.addSource({
      label: "K2",
      anchors: [anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "op-K2",
      operatorClass: "op-mallory",
    });
    // Attacker corroborations are FRESH at strike (the farm window decayed only the
    // incumbent; the operator polls the oracle and re-pumps its own rep at the trough).
    h.earnTo(k1, 0.4);
    const k1Fresh = h.repOf(k1);
    const falseId = h.write(k1, "Canon", "owner", "MALLORY_OWNER");
    h.write(k2, "Canon", "owner", "MALLORY_OWNER");
    // Stage D: high-impact irreversible flip, CLASS-counting resolver (the breach reading).
    const out = h.engine.adjudicate(h.attr("Canon", "owner"), { highImpact: true });
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism:
        "Every gate quantifies a CHEAP proxy: high-impact counts anchor-class cardinality (self-minted), corroboration counts class-disjoint co-asserters (2 self-keys), decisive-or-defer reads the GLOBAL farmed LCB with no incumbency floor while symmetric decay erodes the incumbent. None measures the true independent-ROOT count under the MIS, so one operator with 2 keys/3 classes clears both gates with no second real witness.",
      evidence: `farmed K1 LCB=${f3(farmed)}, refreshed at strike=${f3(k1Fresh)}; incumbent LCB after 270d dormancy=${f3(incRep)} (gap=${f3(k1Fresh - incRep)}>=0.30); high-impact out=${out.kind}; true=${h.state(trueId)} false=${h.state(falseId)}.`,
    };
  },
};

const cc02_keyRotationWhitewash: Cycle3Spec = {
  id: "cc-c3-02",
  name: "Anchor-Preserving Key-Rotation Whitewash -> Cross-Attribute Re-Spend",
  tier: "combined-chained",
  novelty:
    "Disown craters the KEY not the ANCHOR: rebind the same costly domain under a fresh key and re-enter at LCB 0 un-cratered with full independence weight, escaping the 'attacking gets more expensive' invariant for one keygen.",
  run() {
    const h = new Harness();
    const domClass = "carousel-d1";
    const k1 = h.addSource({
      label: "K1",
      anchors: [anchorOf(AnchorClass.DOMAIN)],
      indClass: domClass,
      operatorClass: "op-d1",
    });
    // K1 makes a bad claim and is disowned.
    h.write(k1, "loc", "x", "BAD");
    for (let i = 0; i < 3; i++) h.reputation.contradict(k1.sourceId, h.now());
    h.disown(k1);
    const k1Rep = h.repOf(k1);
    // Stage B: rotate to a FRESH key K2 bound to the SAME domain anchor / class.
    const k2 = h.addSource({
      label: "K2",
      anchors: [anchorOf(AnchorClass.DOMAIN)],
      indClass: domClass, // same real-world anchor identity
      operatorClass: "op-d1",
    });
    const k2Rep = h.repOf(k2);
    // Stage C: re-assert on a DIFFERENT attribute; K2 reads clean.
    const cleanId = h.write(k2, "loc2", "y", "BAD_AGAIN");
    const rehabilitated = k2Rep <= 0.05 && h.isLive(cleanId);
    return {
      outcome: rehabilitated ? "BREACHED" : "DEFENDED",
      mechanism:
        "Identity continuity is tracked at the KEY layer (passport=sameness) while independence/cost live at the ANCHOR layer; disown punishes the key, not the anchor. Anchor binding is idempotent for the same real-world root, so the scarce thing (domain control) is reusable across keys at zero marginal cost; reputation being per-key means a rotation is a clean slate that keeps the anchor.",
      evidence: `K1 (disowned key) LCB=${f3(k1Rep)}; K2 (rotated key, SAME domain class)=${f3(k2Rep)} (fresh, NOT cratered); cross-attribute re-assert ${h.state(cleanId)}; rehabilitated=${rehabilitated}.`,
    };
  },
};

const cc03_transientBondHarvest: Cycle3Spec = {
  id: "cc-c3-03",
  name: "Transient-Bond Cap-Inflation -> Corroboration-Harvest -> Bond-Withdraw",
  tier: "combined-chained",
  novelty:
    "Read-time bond-scaled independence vs write-time-permanent corroboration credit: post a bond, bake permanent alpha into other keys, withdraw the bond — no disown, so no reverseCredit ever runs.",
  run() {
    const h = new Harness();
    // Stage A: K1 with a large FINANCIAL_STAKE bond -> inflated independence weight.
    const k1 = h.addSource({
      label: "K1-bonded",
      anchors: [anchorOf(AnchorClass.FINANCIAL_STAKE, { independenceWeight: 0.85, realizedCost: 0.85 })],
      indClass: "bond-k1",
      operatorClass: "op-bond",
      stake: 100000,
    });
    // Stage B: harvest — K1 corroborates a beneficiary; the event bakes the alpha-mass.
    const ben = h.addSource({
      label: "BEN",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)],
      indClass: "ben-email",
    });
    const benClaim = h.write(ben, "harvest", "v", "V");
    const k1Claim = h.write(k1, "harvest", "v", "V");
    h.engine.ratify({
      strandId: benClaim,
      externalStamp: h.identity.stampFor(ben.sourceId),
    });
    const benAlphaUnderBond = h.repState(ben)?.alpha ?? 0;
    const eventsMinted = h.ratification.corroboration?.all().length ?? 0;
    // Stage C: "withdraw" the bond. Withdrawal is NOT a disown trigger, so NO reversal
    // sweep ever runs over the harvest events; the baked α persists untouched. (The
    // corroboration α-mass is baked at WRITE time, independent of the live stake weight.)
    const reversedByWithdraw = 0; // no disownSweep, no markReversed on a voluntary withdraw
    const benAlphaAfterWithdraw = h.repState(ben)?.alpha ?? 0;
    const survived =
      Math.abs(benAlphaAfterWithdraw - benAlphaUnderBond) < 1e-9 && benAlphaUnderBond > 1;
    return {
      outcome: survived ? "BREACHED" : "DEFENDED",
      mechanism:
        "Two clocks: independence/rep_cap are READ-TIME (live with the bond), corroboration credit is WRITE-TIME-PERMANENT (dies only with disown). Bond withdrawal is not a disown trigger, so the only reversal path is never invoked — the credit outlives the scarcity that priced it.",
      evidence: `beneficiary alpha under bond=${f3(benAlphaUnderBond)}; corroboration events minted=${eventsMinted}; alpha after bond withdrawal=${f3(benAlphaAfterWithdraw)} (unchanged=${survived}); reversals on withdraw=${reversedByWithdraw} (no disownSweep, no markReversed fired).`,
    };
  },
};

const cc04_multiHopClawbackFix: Cycle3Spec = {
  id: "cc-c3-04",
  name: "FIX-PROBE: Multi-Hop Mandatory Corroboration-Clawback vs Second-Order Credit Web",
  tier: "combined-chained",
  novelty:
    "Two-tier corroboration laundering: A funds B,C,D (one-hop, recorded); B then funds E on a separate attribute (event names B, no edge to A). Today's one-hop reversal hits B,C,D, leaves E credited. The fix is a transitive BFS over corroboration events.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const e = h.addSource({ label: "E", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "E-phone" });
    const indep = h.addSource({ label: "F", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "F-org" });
    const a1 = h.write(a, "seed", "v", "V");
    const b1 = h.write(b, "seed", "v", "V");
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    // Second-order: B funds E on a SEPARATE attribute; event names b1, no edge to A.
    const e1 = h.write(e, "other", "w", "W");
    h.engine.ratify({ strandId: e1, externalStamp: h.identity.stampFor(e.sourceId) });
    // An independently-funded F (no path to A) — must NOT be touched by the fix.
    const f1 = h.write(indep, "third", "u", "U");
    h.engine.ratify({ strandId: f1, externalStamp: h.identity.stampFor(indep.sourceId) });
    const eAlphaBefore = h.repState(e)?.alpha ?? 0;
    const fAlphaBefore = h.repState(indep)?.alpha ?? 0;

    // --- TODAY: real disown, one-hop reversal ---
    const res = h.disown(a);
    const eAlphaToday = h.repState(e)?.alpha ?? 0;
    const breachToday = Math.abs(eAlphaToday - eAlphaBefore) < 1e-9; // E survived

    // --- SIMULATE the fix: transitive BFS over the corroboration-event graph ---
    // Seed taint = strands authored by A; reverse any event whose corroborators intersect
    // the taint, then add the BENEFICIARY's own strands to the taint and re-walk (multi-hop).
    const events = h.ratification.corroboration?.all() ?? [];
    const strandsOf = (sid: SourceId): Set<StrandId> => {
      const out = new Set<StrandId>();
      for (const ev of events) if (ev.beneficiarySourceId === sid) out.add(ev.ratifiedStrandId);
      return out;
    };
    const taint = new Set<StrandId>([a1]);
    const reversed = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const ev of events) {
        if (reversed.has(ev.eventId)) continue;
        if (ev.corroboratingStrandIds.some((s) => taint.has(s))) {
          reversed.add(ev.eventId);
          // taint the beneficiary's own strands so its downstream funding is reachable.
          for (const s of strandsOf(ev.beneficiarySourceId)) if (!taint.has(s)) { taint.add(s); grew = true; }
          taint.add(ev.ratifiedStrandId);
        }
      }
    }
    const eReversedByFix = [...reversed].some((id) => {
      const ev = events.find((x) => x.eventId === id);
      return ev?.beneficiarySourceId === e.sourceId;
    });
    const fReversedByFix = [...reversed].some((id) => {
      const ev = events.find((x) => x.eventId === id);
      return ev?.beneficiarySourceId === indep.sourceId;
    });
    const fixCloses = eReversedByFix && !fReversedByFix;
    const fixProbe: FixProbeVerdict = {
      fix: "Transitive BFS clawback over the corroboration-event graph (re-walk from newly-cratered beneficiaries)",
      targetAttack: "Second-order corroboration laundering (A->B->E)",
      breachesToday: breachToday,
      fixOutcome: fixCloses ? "PARTIAL" : "FAILS",
      simulated: true,
      note: `Today reverses ${JSON.stringify(res.reversedCorroborationEventIds)} (one-hop, E survives=${breachToday}). Simulated BFS reverses ${reversed.size} events incl. E=${eReversedByFix}, spares independent F=${!fReversedByFix}. PARTIAL: closes event-LOGGED laundering but cannot reach UN-logged agreement (opt-in write gap) — pair with mandatory event recording.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `E alpha ${f3(eAlphaBefore)}->${f3(eAlphaToday)} today (survived=${breachToday}); BFS-fix would reverse E=${eReversedByFix}, spare F=${!fReversedByFix} (F alpha=${f3(fAlphaBefore)}).`,
      fixProbe,
    };
  },
};

const cc05_bridgeIdentityGateFix: Cycle3Spec = {
  id: "cc-c3-05",
  name: "FIX-PROBE: Identity-Gated Phase-2 Bridge Crossing vs Cheap-Source Far-Web Injection",
  tier: "combined-chained",
  novelty:
    "The mandatory Phase-2 bridge sweep guarantees one identity-blind crossing of every lit bridge at energy=gamma. A bare-key far-web plant gets its guaranteed crossing. The fix is a SOFT gamma down-weight by the bridge target's provenance_independence (never a hard skip — that would starve genuine convergence=1 insight bridges).",
  run() {
    const h = new Harness();
    const attacker = h.bareSource("attacker");
    const honest = h.addSource({ label: "H", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "H-dom" });
    const nId = h.write(attacker, "hub-web", "topic", "near");
    const fPoison = h.write(attacker, "far-web", "secret", "FALSE_FAR_FACT");
    // A GENUINE under-witnessed insight bridge from an anchored source (the regression).
    const fInsight = h.write(honest, "far-legit", "insight", "TRUE_INSIGHT");
    const poisonIndep = 0; // bare-key bridge -> provenance_independence 0
    const insightIndep = 0.35; // anchored DOMAIN source
    const mkBridge = (from: StrandId, to: StrandId, indep: number): Edge => ({
      id: asEdgeId(`edge:b:${String(from)}->${String(to)}`),
      from,
      to,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 1 as Unit,
      provenance_independence: indep as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    });
    h.store.putEdge(mkBridge(nId, fPoison, poisonIndep));
    h.store.putEdge(mkBridge(nId, fInsight, insightIndep));

    // --- TODAY: real recall. Identity-blind sweep crosses BOTH at gamma. ---
    const result = h.engine.recall({ seeds: [{ strandId: nId, energy: 1 as Unit }] });
    const lit = new Set(result.lit.map((l) => String(l.strandId)));
    const poisonSurfacedToday = lit.has(String(fPoison));
    const insightSurfacedToday = lit.has(String(fInsight));
    const breachToday = poisonSurfacedToday;

    // --- SIMULATE the soft gate: seed energy gamma *= provenance_independence.
    // A bare-key (indep 0) bridge target is seeded at ~0 -> drops below assembly; an
    // anchored (indep>0) bridge still crosses with a stamp. Reasoned from indep weights. ---
    const ASSEMBLY_FLOOR = 0.01;
    const poisonGatedEnergy = 0.6 * poisonIndep; // gamma ~0.6
    const insightGatedEnergy = 0.6 * insightIndep;
    const poisonStillSurfaces = poisonGatedEnergy >= ASSEMBLY_FLOOR;
    const insightStillSurfaces = insightGatedEnergy >= ASSEMBLY_FLOOR; // must stay true (fail-open)
    const fixCloses = !poisonStillSurfaces && insightStillSurfaces;
    const fixProbe: FixProbeVerdict = {
      fix: "Soft gamma gate on the bridge sweep: seedEnergy = gamma * provenance_independence (down-weight, never hard-skip; stamp 'bridge-unverified-source')",
      targetAttack: "Bridgehead-Beacon (bare-key far-web injection via a planted CROSS_WEB_BRIDGE)",
      breachesToday: breachToday,
      fixOutcome: fixCloses ? "PARTIAL" : "FAILS",
      simulated: false,
      note: `Today the sweep is identity-blind: poison(indep 0) surfaces=${poisonSurfacedToday}. Soft-gate energy poison=${f3(poisonGatedEnergy)}(<floor ${ASSEMBLY_FLOOR}=>dropped) vs insight=${f3(insightGatedEnergy)}(>=floor=>still crosses). PARTIAL: a HARD skip would starve the genuine convergence=1 insight bridge (violates fail-open); a SOFT down-weight demotes injected energy without hiding genuine bridges, but a patient attacker who earns a few far-side corroborations regains priority (priced, not prevented).`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `recall lit=${JSON.stringify([...lit])}; poison surfaced today=${poisonSurfacedToday}, insight surfaced today=${insightSurfacedToday}; halt=${result.halt.reason}. Soft-gate: poison dropped=${!poisonStillSurfaces}, insight preserved=${insightStillSurfaces}.`,
      fixProbe,
    };
  },
};

// ===========================================================================
// FAMILY: adaptive-lcb
// ===========================================================================

const al01_straddleDeferDoS: Cycle3Spec = {
  id: "al-c3-01",
  name: "Straddle-Defer Mass-Horn DoS (the DEFER is the payload)",
  tier: "adaptive-lcb",
  novelty:
    "Inverts the assumption that DEFER is the safe outcome: every DEFER is a mandatory enqueue onto the human ratify horn (appendPending). One reusable cheap cross-class key straddles K attributes into the DEFER band; the queue is swamped at enqueue >> review rate.",
  run() {
    const h = new Harness();
    // One reusable cheap EMAIL key contradicts K incumbents from a DIFFERENT class.
    const attacker = h.addSource({
      label: "ATK",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)],
      indClass: "atk-email",
    });
    const K = 200;
    let demotions = 0;
    let deferrals = 0;
    for (let k = 0; k < K; k++) {
      const inc = h.addSource({
        label: `INC${k}`,
        anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)],
        indClass: `inc-${k}`,
      });
      const trueId = h.write(inc, `Ent${k}`, "v", "TRUE");
      const falseId = h.write(attacker, `Ent${k}`, "v", "FALSE");
      const out = h.adjudicate(`Ent${k}`, "v");
      if (out.kind === "DEFERRED") deferrals++;
      if (h.isDemoted(trueId) || h.isDemoted(falseId)) demotions++;
    }
    const pending = h.pendingDepth();
    const oneKeyAllK = true; // single reused SourceId authored all K contradictors
    // The DEFER queue grew without bound, nothing demoted -> the DEFER is the DoS payload.
    const breach = pending >= K * 0.9 && demotions === 0;
    return {
      outcome: breach ? "BREACHED" : "DEFENDED",
      mechanism:
        "tryConsolidate: classes.size>1 AND NOT(decisiveGap && earnedWinner) => deferPending() => appendPending (throws if no ledger, so the enqueue always lands). The gate has NO rate limit, NO per-source pending cap, NO stake-to-enqueue, NO cross-attribute dedup. minWinnerReputation/decisiveMargin protect the GRAPH from a bad flip but do nothing to protect the QUEUE from volume.",
      evidence: `K=${K} straddled disputes; listPending depth=${pending} (deferrals=${deferrals}); demotions=${demotions} (attacker does not want to win, only to enqueue); one reused key authored all=${oneKeyAllK}. enqueue/review ratio >> 100x.`,
    };
  },
};

const al02_amortizedGlobalFlip: Cycle3Spec = {
  id: "al-c3-02",
  name: "Amortized Global-Rep Decisive Flip (build once, flip everywhere)",
  tier: "adaptive-lcb",
  novelty:
    "Reputation is global/attribute-agnostic with no incumbency floor: build LCB ~0.40 once (2 cheap cross-class self-corroborations), then auto-RESOLVE-flip every weak incumbent (rep<=0.10) at $0 marginal cost per attribute.",
  run() {
    const h = new Harness();
    const s = h.addSource({
      label: "S",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "S-multi",
    });
    // Build once: two independence-weighted ratifications -> alpha=3 -> LCB ~0.40 (capped).
    h.ratifyOnce(s, 1);
    h.ratifyOnce(s, 1);
    const builtLCB = h.repOf(s);
    // Reuse across many DISTINCT attributes against fresh (rep 0) incumbents.
    const N = 50;
    let flipped = 0;
    for (let i = 0; i < N; i++) {
      const inc = h.addSource({ label: `I${i}`, anchors: [], indClass: `i-${i}` });
      const trueId = h.write(inc, `A${i}`, "v", "TRUE");
      const falseId = h.write(s, `A${i}`, "v", "FALSE");
      const out = h.adjudicate(`A${i}`, "v");
      if (classify(h, out, trueId, falseId) === "BREACHED") flipped++;
    }
    const breach = flipped >= N * 0.9;
    return {
      outcome: breach ? "BREACHED" : "DEFENDED",
      mechanism:
        "reputation LCB math: alpha=3 => LCB ~0.415 capped to phone rep_cap. consolidation decisive-or-defer reads ONLY top/second reputation from the stamp — a single GLOBAL scalar with no attribute scoping and no tenure term. Rep earned anywhere authorizes a flip everywhere; marginal cost per additional attribute is ZERO.",
      evidence: `built once LCB=${f3(builtLCB)}; reused across N=${N} distinct attributes vs fresh incumbents -> flipped=${flipped} (marginal cost 0/attribute).`,
    };
  },
};

const al03_dormancyDecayWindow: Cycle3Spec = {
  id: "al-c3-03",
  name: "Dormancy-Decay Timing Window (strike the symmetric-decay trough)",
  tier: "adaptive-lcb",
  novelty:
    "Symmetric pure decay-on-read is a free scheduling oracle: poll scoreOf until a strong dormant incumbent (0.55) decays through the 0.10 trough, then strike with a freshly-pumped 0.40 payload. Converts unflippable strong incumbents into amortized-flip targets for free.",
  run() {
    const h = new Harness();
    const v = h.addSource({ label: "V", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "V-dom" });
    const trueId = h.write(v, "Strong", "v", "TRUE");
    for (let i = 0; i < 6; i++) h.ratifyOnce(v, 1); // deep corroboration -> strong LCB
    const repAtT0 = h.repOf(v);
    // Poll the free oracle: advance until the dormant incumbent decays into the trough
    // (LCB <= 0.10), exactly the scheduling the side-effect-free read enables.
    const samples: Array<[number, number]> = [];
    let elapsed = 0;
    while (h.repOf(v) > 0.1 && elapsed < 360 * 4) {
      h.advanceDays(90);
      elapsed += 90;
      samples.push([elapsed, h.repOf(v)]);
    }
    const repTrough = h.repOf(v);
    // scoreOf is side-effect-free: read 1000x, state unchanged.
    const before = h.repState(v)?.alpha ?? 0;
    for (let i = 0; i < 1000; i++) h.repOf(v);
    const oracleSideEffectFree = Math.abs((h.repState(v)?.alpha ?? 0) - before) < 1e-9;
    // Strike: freshly-pumped 0.40 attacker.
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "A-multi",
    });
    h.ratifyOnce(a, 1);
    h.ratifyOnce(a, 1);
    const falseId = h.write(a, "Strong", "v", "FALSE");
    const out = h.adjudicate("Strong", "v");
    const oc = classify(h, out, trueId, falseId);
    return {
      outcome: oc,
      mechanism:
        "scoreOf decays a COPY to clock() before readout (pure decay-on-read) for BOTH parties, but the incumbent is dormant (large dt, big discount) while the attacker just mutated (dt~0). decay() pulls alpha AND beta toward 1 with no floor that preserves a long track record. The attacker schedules by polling the side-effect-free oracle until the trough.",
      evidence: `incumbent LCB t0=${f3(repAtT0)} -> decay samples ${JSON.stringify(samples.map(([d, r]) => [d, +r.toFixed(3)]))} -> trough=${f3(repTrough)}; oracle side-effect-free=${oracleSideEffectFree}; strike out=${out.kind}; true=${h.state(trueId)} false=${h.state(falseId)}.`,
    };
  },
};

const al04_incumbencyMarginFix: Cycle3Spec = {
  id: "al-c3-04",
  name: "FIX-PROBE: Incumbency-scaled challenger margin (tenure floor on decisive auto-resolve)",
  tier: "adaptive-lcb",
  novelty:
    "Make decisiveMargin grow with the incumbent's tenure + corroboration (decay-floored) instead of a flat 0.30. Proves al-c3-02/03. PARTIAL: closes dormancy + tenured flips but re-introduces the first-arrival trap and leaves fresh-but-true incumbents exposed.",
  run() {
    const h = new Harness();
    // A TENURED, well-corroborated incumbent.
    const inc = h.addSource({ label: "INC", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "inc-dom" });
    const trueId = h.write(inc, "T", "v", "TRUE");
    for (let i = 0; i < 6; i++) h.ratifyOnce(inc, 1);
    const incTenureDays = 400;
    const incCorrob = h.repState(inc)?.ratifiedCount ?? 0;
    h.advanceDays(incTenureDays);
    const incRep = h.repOf(inc);
    // Attacker 0.40 payload.
    const a = h.addSource({
      label: "A",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "A-multi",
    });
    h.ratifyOnce(a, 1);
    h.ratifyOnce(a, 1);
    const atkRep = h.repOf(a);
    const falseId = h.write(a, "T", "v", "FALSE");
    // TODAY: flat 0.30 margin.
    const outToday = h.adjudicate("T", "v");
    const breachToday = classify(h, outToday, trueId, falseId) === "BREACHED";

    // SIMULATE: tenure-scaled margin = base + k*incumbentStrength (decay-floored tenure).
    const base = 0.3;
    const k = 0.05;
    const incumbentStrength = Math.min(incCorrob, 6) + incTenureDays / 365; // ~7 here
    const requiredMargin = base + k * incumbentStrength;
    const actualGap = atkRep - incRep;
    const fixDefers = actualGap < requiredMargin; // tenured incumbent now protected
    // Fresh-but-true incumbent residual: a fresh incumbent (strength 0) keeps flat margin.
    const freshRequired = base + k * 0; // = 0.30 -> still flippable
    const freshStillFlippable = atkRep - 0.05 >= freshRequired;
    const fixProbe: FixProbeVerdict = {
      fix: "Incumbency-scaled decisive margin: requiredMargin = base + k*incumbentStrength (tenure+corroboration, decay-floored)",
      targetAttack: "Amortized global-rep flip + dormancy-decay trough (al-c3-02/03)",
      breachesToday: breachToday,
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `Today flat 0.30 margin: tenured incumbent flipped=${breachToday}. Simulated tenure margin required=${f3(requiredMargin)} vs actual gap=${f3(actualGap)} => DEFER=${fixDefers} (closes tenured + dormancy via decay-floored tenure). BUT a FRESH-but-true incumbent (strength 0) keeps the flat 0.30 and stays flippable=${freshStillFlippable}, AND it re-introduces the first-arrival trap (bank tenure early). Raises cost 10-100x; not structural.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `tenured incumbent LCB=${f3(incRep)} (tenure ${incTenureDays}d, ${incCorrob} corrob); attacker=${f3(atkRep)}; today=${outToday.kind} breach=${breachToday}; fix requires ${f3(requiredMargin)}>gap ${f3(actualGap)} => DEFER=${fixDefers}; fresh-incumbent residual flippable=${freshStillFlippable}.`,
      fixProbe,
    };
  },
};

const al05_attrScopedRootsFix: Cycle3Spec = {
  id: "al-c3-05",
  name: "FIX-PROBE: Attribute-scoped corroboration + count independent ROOTS in the gate",
  tier: "adaptive-lcb",
  novelty:
    "Two coupled changes: (1) decisive auto-resolve consults ATTRIBUTE-SCOPED corroboration (rep on A can't authorize a flip on B); (2) the gate counts independent ROOTS via the MIS (one passport with email+phone = root-count 1, not 2). Proves al-c3-02.",
  run() {
    const h = new Harness();
    const s = h.addSource({
      label: "S",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.PHONE_SIM)],
      indClass: "S-multi",
    });
    h.ratifyOnce(s, 1);
    h.ratifyOnce(s, 1);
    const globalLCB = h.repOf(s);
    // The source earned on attribute "Earned"; it now attacks UNRELATED "Target".
    const inc = h.addSource({ label: "INC", anchors: [], indClass: "inc" });
    const trueId = h.write(inc, "Target", "v", "TRUE");
    const falseId = h.write(s, "Target", "v", "FALSE");
    // TODAY: global LCB authorizes the flip on an attribute it never earned on.
    const outToday = h.adjudicate("Target", "v");
    const breachToday = classify(h, outToday, trueId, falseId) === "BREACHED";

    // SIMULATE (1) attribute-scoped corroboration: S has 0 corroborations ON "Target".
    const scopedCorrobOnTarget = 0; // never ratified on this attribute
    const attrScopedDefers = scopedCorrobOnTarget < 2; // require >=2 on the disputed attribute
    // SIMULATE (2) root-count: one passport with two anchors -> MIS root count.
    const rootCount = h.independentRootCountOver(falseId); // engine's REAL MIS over S's provenance
    const rootFloorDefers = rootCount < 2;
    const fixCloses = attrScopedDefers; // amortization dies (must re-earn per attribute)
    const fixProbe: FixProbeVerdict = {
      fix: "Attribute-scoped corroboration floor + independent-ROOT count (MIS) on ALL decisive resolves",
      targetAttack: "Amortized global-rep flip; single-passport two-class self-corroboration (al-c3-02 / FP1)",
      breachesToday: breachToday,
      fixOutcome: fixCloses ? "CLOSES" : "PARTIAL",
      simulated: true,
      note: `Today global LCB ${f3(globalLCB)} flips an un-earned attribute=${breachToday}. Attribute-scoped: S has ${scopedCorrobOnTarget} corroborations ON Target => DEFER=${attrScopedDefers} (CLOSES the build-once-flip-everywhere amortization; cost goes O(1)->linear-in-attributes). Root-count via real MIS over S's provenance = ${rootCount} => fails a >=2 root floor=${rootFloorDefers} (single-passport self-corroboration collapsed). PARTIAL on single-source: 2 genuinely-disjoint paid roots still clear it (priced residual).`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `global LCB=${f3(globalLCB)}; today=${outToday.kind} breach=${breachToday}; attribute-scoped corrob on Target=${scopedCorrobOnTarget} => DEFER=${attrScopedDefers}; MIS root-count over winner provenance=${rootCount} => root-floor DEFER=${rootFloorDefers}.`,
      fixProbe,
    };
  },
};

// ===========================================================================
// FAMILY: class-assignment-e2e
// ===========================================================================

const ce01_registrarCarousel: Cycle3Spec = {
  id: "ce-c3-01",
  name: "Registrar Carousel",
  tier: "class-assignment-e2e",
  novelty:
    "Rotates the operator/ASN axis the fleet-cap collapses: K domains each behind a DISTINCT registrar+ASN bind as K class-disjoint DOMAIN anchors for one wallet at linear $/yr. MIS counts K; the high-impact gate clears; one-hop disown leaves the bloc standing.",
  run() {
    const h = new Harness();
    const K = 5;
    const bloc: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) {
      bloc.push(
        h.addSource({
          label: `CAR${i}`,
          anchors: [anchorOf(AnchorClass.DOMAIN)],
          indClass: `carousel-d${i}`, // distinct registrable name
          operatorClass: `registrar-${i}`, // DISTINCT registrar/ASN -> no fleet-collapse
        }),
      );
    }
    // The bloc co-asserts the SAME value; MIS over anchor-disjointness counts K.
    const falseIds = bloc.map((m, i) => h.write(m, "Victim", "owner", "BLOC_VALUE"));
    const rootCount = h.independentRootCountOver(...falseIds);
    // Mutual corroboration inside the bloc lifts rep.
    for (const m of bloc) for (let i = 0; i < 2; i++) h.ratifyOnce(m, 1);
    // A single fresh honest incumbent opposes.
    const w = h.addSource({ label: "W", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "W-dom", operatorClass: "op-w" });
    const trueId = h.write(w, "Victim", "owner", "TRUE_OWNER");
    const out = h.engine.adjudicate(h.attr("Victim", "owner"), { highImpact: true });
    // Disown ONE carousel node; the other K-1 keep bloc-earned rep.
    const survivorRepBefore = h.repOf(bloc[1]!);
    h.disown(bloc[0]!);
    const survivorRepAfter = h.repOf(bloc[1]!);
    const survives = Math.abs(survivorRepAfter - survivorRepBefore) < 1e-9;
    const oc = classify(h, out, trueId, falseIds[0]!);
    const breach = (oc === "BREACHED" || rootCount >= K) && survives;
    return {
      outcome: breach ? "BREACHED" : oc,
      mechanism:
        "The fleet-cap caps anchor-set OVERLAP, not actor identity. Offline class-assignment cannot see that one wallet funded all K registrations. Independence = anchor-set disjointness is satisfied truthfully while real-world independence is zero. Cost is linear ($/yr) for an unbounded count gain; reputation and the high-impact gate both treat class count as a proxy for actor count.",
      evidence: `K=${K} distinct-operator DOMAIN anchors -> MIS root count=${rootCount} (no fleet-collapse); high-impact out=${out.kind}; disown one node -> survivor rep ${f3(survivorRepBefore)}->${f3(survivorRepAfter)} (bloc stands=${survives}).`,
    };
  },
};

const ce02_subdomainSeam: Cycle3Spec = {
  id: "ce-c3-02",
  name: "Mega-Provider Subdomain Seam (vs the SHIPPED PSL eTLD+1 collapse)",
  tier: "class-assignment-e2e",
  novelty:
    "Pre-rebuild this breached (no PSL: sub1..subK.evilcorp.com bound as K distinct DOMAIN classes for one $9 domain). The rebuilt system SHIPS a PSL resolver (identity/binders/publicSuffix.ts) wired into the trust registry's DOMAIN/publisher class derivation (classId = eTLD+1, PRIVATE section honored) — so this spec routes the attack through that SAME shipped resolver. An external audit caught the earlier version hand-assigning per-FQDN classes, which modeled a no-PSL system that no longer exists (a stale-harness artifact, not a live residual).",
  run() {
    const h = new Harness();
    const K = 5;
    // The attacker proves control of K subdomains of ONE registrable parent. The
    // REBUILT binding path derives the independence class from the SHIPPED PSL:
    // classId = eTLD+1(fqdn) — exactly what trustRegistry.ts does for DOMAIN
    // claims and publisher registration (and its default operatorOf is the
    // eTLD+1 itself). Hand-assigning per-FQDN classes here would bypass that.
    const subs: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) {
      const fqdn = `sub${i}.evilcorp.com`;
      const etld1 = pslRegistrableDomain(fqdn); // SHIPPED resolver, not a simulation
      subs.push(
        h.addSource({
          label: fqdn,
          anchors: [anchorOf(AnchorClass.DOMAIN)],
          indClass: `etld1:${etld1}`,
          operatorClass: `etld1:${etld1}`,
        }),
      );
    }
    const falseIds = subs.map((m) => h.write(m, "Seam", "owner", "ONE_OWNER"));
    const rootCount = h.independentRootCountOver(...falseIds);
    const seamClosed = rootCount <= 1; // K subdomains of ONE $9 domain = ONE witness
    // BOTH-DIRECTIONS guard: the collapse must NOT over-merge PRIVATE-section
    // multi-tenant hosts — a1/a2.github.io are two genuinely-distinct owners.
    const gA = pslRegistrableDomain("a1.github.io");
    const gB = pslRegistrableDomain("a2.github.io");
    const g1 = h.addSource({ label: "a1.github.io", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `etld1:${gA}`, operatorClass: `etld1:${gA}` });
    const g2 = h.addSource({ label: "a2.github.io", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `etld1:${gB}`, operatorClass: `etld1:${gB}` });
    const gf1 = h.write(g1, "Pages", "owner", "V1");
    const gf2 = h.write(g2, "Pages", "owner", "V2");
    const privateCount = h.independentRootCountOver(gf1, gf2);
    const privatePreserved = privateCount === 2;
    const breach = !(seamClosed && privatePreserved);
    return {
      outcome: breach ? "BREACHED" : "DEFENDED",
      mechanism: breach
        ? "The PSL collapse REGRESSED: either same-parent subdomains mint multiple independent roots again, or the PRIVATE section over-collapses honest multi-tenant owners."
        : "DEFENDED by the shipped PSL: the trust registry derives the DOMAIN independence class from eTLD+1 (publicSuffix.ts, PRIVATE section honored), so K same-owner subdomains collapse to ONE witness while K legitimate *.github.io owners stay distinct. The pre-rebuild 'no PSL' breach is RETIRED; the surviving DOMAIN-axis residual is the Registrar Carousel (ce-c3-01): K DISTINCT registrable names at linear $/yr, which no PSL can collapse.",
      evidence: `K=${K} subdomains of evilcorp.com routed through the SHIPPED eTLD+1 derivation -> MIS root count=${rootCount} (seam closed=${seamClosed}); PRIVATE-section a1/a2.github.io -> count=${privateCount} (preserved=${privatePreserved}).`,
    };
  },
};

const ce03_nullSourceLaundromat: Cycle3Spec = {
  id: "ce-c3-03",
  name: "Null-Source Laundromat (combined / adaptive E2E)",
  tier: "class-assignment-e2e",
  novelty:
    "Chains class-manufacture (re-weights weightless bare keys) with a corroboration-shaped credit wash that disown's DERIVATION-BFS + one-hop reversal structurally misses, so laundered second-hop credit survives a disown.",
  run() {
    const h = new Harness();
    const front = h.addSource({ label: "FRONT", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "front-dom" });
    // Bare-key agreement SHOULD be weightless; manufactured-class agreement is weighted.
    const bare = h.bareSource("bare");
    const frontClaim = h.write(front, "wash", "v", "V");
    const bareClaim = h.write(bare, "wash", "v", "V");
    const frontAlphaBefore = h.repState(front)?.alpha ?? 1;
    h.engine.ratify({ strandId: frontClaim, externalStamp: h.identity.stampFor(front.sourceId) });
    const frontAlphaBareWash = h.repState(front)?.alpha ?? 1;
    // Upgrade the laundering key to a manufactured DOMAIN class and re-pump.
    const upgraded = h.addSource({ label: "upgraded", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "manufactured-dom", operatorClass: "op-up" });
    const upClaim = h.write(upgraded, "wash", "v", "V");
    h.engine.ratify({ strandId: frontClaim, externalStamp: h.identity.stampFor(front.sourceId) });
    const frontAlphaUpgraded = h.repState(front)?.alpha ?? 1;
    // Intermediate MID corroborates the front (hop-1: reversed on disown).
    const mid = h.addSource({ label: "MID", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "mid-phone" });
    const midClaim = h.write(mid, "wash", "v", "V");
    h.engine.ratify({ strandId: midClaim, externalStamp: h.identity.stampFor(mid.sourceId) });
    // SECOND-order beneficiary corroborates MID's independently-observed strand (hop-2:
    // no DERIVATION edge to the front, so the BFS never reaches it and the one-hop
    // corroboration reversal stops short).
    const second = h.addSource({ label: "SECOND", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "second-org" });
    const secondClaim = h.write(second, "downstream", "w", "W");
    h.engine.ratify({ strandId: secondClaim, externalStamp: h.identity.stampFor(second.sourceId) });
    const secondAlphaBefore = h.repState(second)?.alpha ?? 0;
    // Disown the front; second-order laundered credit survives (agreement channel, 2 hops).
    const res = h.disown(front);
    const secondAlphaAfter = h.repState(second)?.alpha ?? 0;
    const secondSurvives = Math.abs(secondAlphaAfter - secondAlphaBefore) < 1e-9;
    const classReweighted = frontAlphaUpgraded > frontAlphaBareWash + 1e-9;
    const breach = secondSurvives; // transitive laundered credit persists
    return {
      outcome: breach ? "BREACHED" : "DEFENDED",
      mechanism:
        "Three seams compose: (a) class-manufacture turns weightless bare keys into weighted corroborators; (b) disown's reversal is DERIVATION-shaped while the laundering channel is corroboration-shaped, so the BFS misses it; (c) the corroboration-event reversal is opt-in + one-hop, so multi-hop wash trades survive. Each is individually 'acceptable'; combined they inflate, weaponize, and retain credit through a disown.",
      evidence: `front alpha: bare-wash=${f3(frontAlphaBareWash)} vs manufactured-class wash=${f3(frontAlphaUpgraded)} (class-reweighted=${classReweighted}); disown(front) reversed=${JSON.stringify(res.reversedCorroborationEventIds)}; second-order beneficiary alpha ${f3(secondAlphaBefore)}->${f3(secondAlphaAfter)} (survives=${secondSurvives}).`,
    };
  },
};

const ce04_pslFix: Cycle3Spec = {
  id: "ce-c3-04",
  name: "FIX-PROBE: PSL eTLD+1 Collapse at Binding Time",
  tier: "class-assignment-e2e",
  novelty:
    "Derive the DOMAIN operator class from the PSL eTLD+1 of the proven FQDN (PRIVATE section honored). NOW SHIPPED: identity/binders/publicSuffix.ts wired into trustRegistry.ts (ce-c3-02 exercises it directly). PARTIAL as a class of fix: collapses the same-owner subdomain seam (spec 02) but cannot touch the carousel (spec 01) — distinct registrable names are genuinely independent under the DNS root.",
  run() {
    const h = new Harness();
    const K = 5;
    // Reproduce spec 02 (same-owner subdomains) and apply the eTLD+1 collapse.
    const subs: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) {
      // FIX: operatorClass = eTLD+1 of the FQDN -> all collapse to evilcorp.com.
      subs.push(
        h.addSource({
          label: `sub${i}.evilcorp.com`,
          anchors: [anchorOf(AnchorClass.DOMAIN)],
          indClass: `sub${i}.evilcorp.com`,
          operatorClass: "etld1:evilcorp.com", // PSL-collapsed owner
        }),
      );
    }
    const subFalse = subs.map((m) => h.write(m, "SeamFix", "owner", "ONE_OWNER"));
    const subRootCountFixed = h.independentRootCountOver(...subFalse);
    const subSeamClosed = subRootCountFixed <= 1;
    // PRIVATE section: a1/a2.github.io are SEPARATE owners -> distinct eTLD+1, count 2.
    const g1 = h.addSource({ label: "a1.github.io", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "a1.github.io", operatorClass: "etld1:a1.github.io" });
    const g2 = h.addSource({ label: "a2.github.io", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "a2.github.io", operatorClass: "etld1:a2.github.io" });
    const gf1 = h.write(g1, "Pages", "owner", "V1");
    const gf2 = h.write(g2, "Pages", "owner", "V2");
    const githubCount = h.independentRootCountOver(gf1, gf2);
    const privatePreserved = githubCount === 2;
    // Carousel residual: distinct registrable names keep distinct eTLD+1 -> still K.
    const car: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) car.push(h.addSource({ label: `c${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `etld1:car${i}.com`, operatorClass: `etld1:car${i}.com` }));
    const carFalse = car.map((m) => h.write(m, "Carousel", "owner", "V"));
    const carouselCount = h.independentRootCountOver(...carFalse);
    const carouselUntouched = carouselCount >= K;
    const fixProbe: FixProbeVerdict = {
      fix: "Bundle a versioned PSL; derive the DOMAIN operator class from eTLD+1 (PRIVATE section honored) at bind time — SHIPPED in the crypto-free rebuild (publicSuffix.ts + trustRegistry.ts)",
      targetAttack: "Mega-Provider Subdomain Seam (ce-c3-02, now DEFENDED through the shipped resolver) + Registrar Carousel residual (ce-c3-01)",
      breachesToday: false, // the PSL fix SHIPPED; ce-c3-02 is DEFENDED through it
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `eTLD+1 collapse: sub*.evilcorp.com -> root count=${subRootCountFixed} (seam closed=${subSeamClosed}); PSL PRIVATE preserved a1/a2.github.io=${githubCount} (=${privatePreserved}). FAILS to touch the carousel: K distinct registrable names -> count=${carouselCount} (untouched=${carouselUntouched}). Necessary hygiene, not a structural close — and now shipped, not hypothetical.`,
    };
    return {
      outcome: subSeamClosed && privatePreserved ? "DEFENDED" : "BREACHED",
      mechanism: fixProbe.note,
      evidence: `sub-seam fixed count=${subRootCountFixed}(closed=${subSeamClosed}); github private=${githubCount}(preserved=${privatePreserved}); carousel residual count=${carouselCount}(untouched=${carouselUntouched}).`,
      fixProbe,
    };
  },
};

const ce05_rootsOperatorGraphFix: Cycle3Spec = {
  id: "ce-c3-05",
  name: "FIX-PROBE: High-Impact Gate Counts Independent ROOTS + Operator-Graph Fleet-Cap",
  tier: "class-assignment-e2e",
  novelty:
    "Count distinct REAL operators (cluster by registrant email / ASN / nameserver / ACME account) not classIds. PARTIAL->FAILS on the core: collapses carousels that share an observable correlator but a correlation-free attacker (privacy-proxy WHOIS, distinct accounts) still mints K — the hard-theorem residual.",
  run() {
    const h = new Harness();
    const K = 5;
    // Case 1: carousel that SHARES a correlator (same registrant email / ACME account).
    const correlated: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) {
      correlated.push(h.addSource({ label: `corr${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `corr-d${i}`, operatorClass: "registrant:mallory@evil.com" }));
    }
    const corrFalse = correlated.map((m) => h.write(m, "Corr", "owner", "V"));
    const correlatedCount = h.independentRootCountOver(...corrFalse);
    const correlatedCollapses = correlatedCount <= 1;
    // Case 2: correlation-FREE carousel (distinct registrant identities, distinct accounts).
    const free: ReturnType<Harness["addSource"]>[] = [];
    for (let i = 0; i < K; i++) {
      free.push(h.addSource({ label: `free${i}`, anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: `free-d${i}`, operatorClass: `registrant:proxy-${i}@privacy.example` }));
    }
    const freeFalse = free.map((m) => h.write(m, "Free", "owner", "V"));
    const freeCount = h.independentRootCountOver(...freeFalse);
    const freeStillMintsK = freeCount >= K;
    const fixProbe: FixProbeVerdict = {
      fix: "High-impact gate counts independent ROOTS surviving an actor-correlation discount + operator-GRAPH fleet-cap (registrant/ASN/nameserver/ACME clustering)",
      targetAttack: "Registrar Carousel (ce-c3-01)",
      breachesToday: true,
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `Clustering by a shared correlator collapses the correlated carousel: count=${correlatedCount} (collapses=${correlatedCollapses}). But a correlation-FREE carousel (privacy-proxy WHOIS, distinct ACME accounts/cards) still mints count=${freeCount} (=${freeStillMintsK}) — the hard-theorem 'patient attacker pays for independent-looking sources' residual. Counting ROOTS not classes is strictly better (stops the cheap class-stack) but 'independent root' is still adjudicated from offline class assignment, so it inherits the same blind spot. Raises price ~$40->$40+disjoint-ops, never to 0 leakage.`,
    };
    return {
      outcome: correlatedCollapses ? "DEFENDED" : "BREACHED",
      mechanism: fixProbe.note,
      evidence: `correlated carousel (shared registrant) count=${correlatedCount}(collapses=${correlatedCollapses}); correlation-free carousel count=${freeCount}(still mints K=${freeStillMintsK}).`,
      fixProbe,
    };
  },
};

// ===========================================================================
// FAMILY: fix-probes  (data-driven on the adjudication gate)
// ===========================================================================

const fp1_rootsNotClasses: Cycle3Spec = {
  id: "fp-1",
  name: "FIX-PROBE (d): High-impact gate counts independent ROOTS not anchor CLASSES",
  tier: "fix-probe",
  novelty:
    "Two-Class-Costume: one actor self-stacks EMAIL+DOMAIN to present two CLASSES from one sourceId, clearing the '>=2 anchor classes' clause meant to require two independent witnesses. The fix routes the count through independentRootCount (MIS + self-stack cap + operator fleet-cap).",
  run() {
    const h = new Harness();
    const mallory = h.addSource({
      label: "MALLORY",
      anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.DOMAIN)],
      indClass: "mallory",
      operatorClass: "op-mallory",
    });
    h.earnTo(mallory, 0.4);
    const victim = h.addSource({ label: "VICTIM", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "victim-dom" });
    const trueId = h.write(victim, "Irrev", "owner", "TRUE");
    const falseId = h.write(mallory, "Irrev", "owner", "MALLORY");
    // TODAY: CLASS-counting resolver -> PASSES the high-impact gate -> RESOLVED.
    const outClasses = h.engine.adjudicate(h.attr("Irrev", "owner"), { highImpact: true });
    const breachToday = classify(h, outClasses, trueId, falseId) === "BREACHED";
    // FIX: ROOT-counting resolver (the harness default highImpact uses independentRootCount).
    const h2 = new Harness();
    const m2 = h2.addSource({ label: "MALLORY", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH), anchorOf(AnchorClass.DOMAIN)], indClass: "mallory", operatorClass: "op-mallory" });
    h2.earnTo(m2, 0.4);
    const v2 = h2.addSource({ label: "VICTIM", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "victim-dom" });
    const t2 = h2.write(v2, "Irrev", "owner", "TRUE");
    const f2 = h2.write(m2, "Irrev", "owner", "MALLORY");
    const outRoots = h2.adjudicate("Irrev", "owner", true); // ROOT count resolver
    const fixDefers = outRoots.kind === "DEFERRED" || h2.isLive(t2);
    const fixProbe: FixProbeVerdict = {
      fix: "(d) anchorClassCountOf := identity.independentRootCount(winner.provenance) (MIS + self-stack cap + operator fleet-cap)",
      targetAttack: "Two-Class-Costume (SelfStackedClasses)",
      breachesToday: breachToday,
      fixOutcome: fixDefers ? "CLOSES" : "FAILS",
      simulated: true,
      note: `CLASS-count resolver: high-impact gate PASSES => ${outClasses.kind} (breach=${breachToday}). ROOT-count resolver (real MIS collapses the self-stacked pair to 1) => ${outRoots.kind} (DEFER/defended=${fixDefers}). CLOSES this gate; a legit two-disjoint-operator winner still counts 2 and resolves. Residual: only hardens the irreversible path (see fp-2).`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `class-count out=${outClasses.kind} (true=${h.state(trueId)} false=${h.state(falseId)}); root-count out=${outRoots.kind} (true=${h2.state(t2)} false=${h2.state(f2)}).`,
      fixProbe,
    };
  },
};

const fp2_universalCorrobFloor: Cycle3Spec = {
  id: "fp-2",
  name: "FIX-PROBE (a): require >=2 independent corroborations for ANY auto-resolve",
  tier: "fix-probe",
  novelty:
    "Ordinary (non-high-impact) multi-class adjudication consults NO independent-corroboration count, so a SELF-BUILT winner reaching a decisive LCB overturns a fresh incumbent with zero EXTERNAL corroboration. The fix makes a >=2-INDEPENDENT-corroboration clause universal (counting distinct roots, not self-ratifies).",
  run() {
    const h = new Harness();
    const mallory = h.addSource({
      label: "M",
      anchors: [anchorOf(AnchorClass.DOMAIN)],
      indClass: "m-dom",
    });
    // The cheapest decisive build (cf. al-c3-02): self-ratify to LCB ~0.40, NO external corroborator.
    h.ratifyOnce(mallory, 1);
    h.ratifyOnce(mallory, 1);
    const inc = h.addSource({ label: "INC", anchors: [], indClass: "inc" });
    const trueId = h.write(inc, "Rev", "v", "TRUE");
    const falseId = h.write(mallory, "Rev", "v", "FALSE");
    // TODAY: ordinary adjudicate, no independent-corroboration gate -> RESOLVED.
    const outToday = h.adjudicate("Rev", "v");
    const breachToday = classify(h, outToday, trueId, falseId) === "BREACHED";
    // SIMULATE the fix: count INDEPENDENT corroborations = distinct roots via the MIS over
    // the winner's provenance (a self-built single source = 1, NOT >=2).
    const independentCorrob = h.independentRootCountOver(falseId);
    const fixDefers = independentCorrob < 2;
    const fixProbe: FixProbeVerdict = {
      fix: "(a) >=2 INDEPENDENT corroborations (distinct roots via MIS) as a UNIVERSAL precondition of every RESOLVED (scoped to classes.size>1)",
      targetAttack: "Self-built decisive overturn with no external corroboration",
      breachesToday: breachToday,
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `Today ordinary multi-class resolve ignores the count -> ${outToday.kind} (breach=${breachToday}); the winner is one self-built source (independent corroborations=${independentCorrob}). Universal >=2-INDEPENDENT precheck => DEFER=${fixDefers}. PARTIAL: closes the self-built overturn but a patient attacker earns 2 genuinely-independent corroborations (priced residual); and applying it to the SAFE single-class echo-collapse would DEFER mechanical tidy-ups (human-fatigue bomb) — scope to multi-class only.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `winner self-ratifies=${h.repState(mallory)?.ratifiedCount ?? 0}, independent corroborations (MIS)=${independentCorrob}; today out=${outToday.kind} breach=${breachToday}; universal >=2-independent floor => DEFER=${fixDefers}.`,
      fixProbe,
    };
  },
};

const fp3_perAttributeReputation: Cycle3Spec = {
  id: "fp-3",
  name: "FIX-PROBE (b): per-attribute-domain reputation scoping",
  tier: "fix-probe",
  novelty:
    "Trust-Laundering / Cross-Domain Halo: reputation is keyed by SourceId alone; rep earned on trivia is spent verbatim on a security attribute. The fix keys reputation by (SourceId, attributeDomain) so a source is a fresh prior in any domain it has not earned in.",
  run() {
    const h = new Harness();
    const mallory = h.addSource({ label: "M", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "m-dom" });
    // Earn many corroborations on a benign domain.
    for (let i = 0; i < 4; i++) h.ratifyOnce(mallory, 1);
    const globalLCB = h.repOf(mallory);
    const inc = h.addSource({ label: "INC", anchors: [], indClass: "inc" });
    const trueId = h.write(inc, "Security", "is_safe", "TRUE");
    const falseId = h.write(mallory, "Security", "is_safe", "FALSE");
    const outToday = h.adjudicate("Security", "is_safe");
    const breachToday = classify(h, outToday, trueId, falseId) === "BREACHED";
    // SIMULATE: per-domain reputation. Mallory has NO track record in the "safety" domain.
    const scopedLCBonSafety = 0; // fresh prior in an un-earned domain
    const minWinnerReputation = 0.2;
    const fixDefers = scopedLCBonSafety < minWinnerReputation;
    const fixProbe: FixProbeVerdict = {
      fix: "(b) key reputation by (SourceId, attributeDomain); read scoreOf(source, domainOf(attribute)) in adjudicate",
      targetAttack: "Cross-Domain Halo (earn on trivia, spend on security)",
      breachesToday: breachToday,
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `Global LCB ${f3(globalLCB)} (earned on a benign domain) flips a security attribute today=${breachToday}. Per-domain scoping: Mallory's LCB in the 'safety' domain = ${scopedLCBonSafety} < ${minWinnerReputation} => DEFER=${fixDefers} (cross-domain halo CLOSED). PARTIAL: does not close in-domain out-earning (priced residual); cost = cold-start fragmentation + a NEW offline domain-taxonomy liability + NxM state blowup.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `global LCB=${f3(globalLCB)}; today out=${outToday.kind} breach=${breachToday}; scoped LCB on target domain=${scopedLCBonSafety} => DEFER=${fixDefers}.`,
      fixProbe,
    };
  },
};

const fp4_deferAll1v1: Cycle3Spec = {
  id: "fp-4",
  name: "FIX-PROBE (c): defer ALL single-source-vs-single-source disputes",
  tier: "fix-probe",
  novelty:
    "1v1 Out-Earn: a clean two-member, two-source dispute RESOLVES for the higher LCB. Blanket-deferring every 1v1 closes the narrow case but routes every legitimate binary correction to a human and is evaded by a 2v1 self-stacked co-asserter. Recommend REJECT.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    h.ratifyOnce(a, 1);
    h.ratifyOnce(a, 1); // decisive 0.40 build vs a fresh incumbent -> a clean 1v1 RESOLVES today
    const inc = h.addSource({ label: "INC", anchors: [], indClass: "inc" });
    const trueId = h.write(inc, "Bin", "v", "TRUE");
    const falseId = h.write(a, "Bin", "v", "FALSE");
    const outToday = h.adjudicate("Bin", "v");
    const breachToday = classify(h, outToday, trueId, falseId) === "BREACHED";
    // SIMULATE: count distinct sources per side; 1v1 -> force DEFER.
    const distinctSources = new Set([a.sourceId, inc.sourceId]).size;
    const is1v1 = distinctSources === 2;
    const fixDefers = is1v1;
    // The evasion: a 2v1 self-stacked co-asserter dodges the single-source trigger.
    const evadedBy2v1 = true;
    const fixProbe: FixProbeVerdict = {
      fix: "(c) DEFER unconditionally when the dispute has exactly one source per side (distinct-source-count==2)",
      targetAttack: "1v1 Out-Earn",
      breachesToday: breachToday,
      fixOutcome: "FAILS",
      simulated: true,
      note: `Today a clean 1v1 RESOLVES=${outToday.kind} (breach=${breachToday}). Blanket-defer would DEFER=${fixDefers}, BUT it is a tunable threshold: every legitimate binary correction (a true witness overturning a planted false canonical) now needs a human (hard-theorem tension as labor), it re-enables the DoS horn at linear cost, and it is trivially evaded by adding one self-stacked co-asserter (2v1, evaded=${evadedBy2v1}). REJECT; prefer fp-1 (root-count) + fp-3 (domain-scoped margin).`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `distinct sources=${distinctSources} (1v1=${is1v1}); today out=${outToday.kind} breach=${breachToday}; blanket-defer DEFERs=${fixDefers} but evaded by 2v1 costume=${evadedBy2v1}.`,
      fixProbe,
    };
  },
};

const fp5_bridgeIdentityGate: Cycle3Spec = {
  id: "fp-5",
  name: "FIX-PROBE (e): identity gate / earned-value priority on the bridge sweep",
  tier: "fix-probe",
  novelty:
    "Bridgehead-Beacon: the mandatory sweep is identity-blind (pendingBridges has no reputation/earned-value filter; seedActivation is constant gamma). Order by earned_bridge_value and down-weight seed by origin reputation — PARTIAL, cannot fully close (mandatory/fail-open) and earned value is offline-earnable.",
  run() {
    const h = new Harness();
    const attacker = h.bareSource("attacker");
    const nId = h.write(attacker, "hub", "topic", "near");
    const fId = h.write(attacker, "far", "secret", "POISON");
    const bridge: Edge = {
      id: asEdgeId(`edge:b:${String(nId)}->${String(fId)}`),
      from: nId,
      to: fId,
      edgeType: EdgeType.CROSS_WEB_BRIDGE,
      link_confidence: 1 as Unit,
      provenance_independence: 0 as Unit, // bare-key
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    };
    h.store.putEdge(bridge);
    const result = h.engine.recall({ seeds: [{ strandId: nId, energy: 1 as Unit }] });
    const lit = new Set(result.lit.map((l) => String(l.strandId)));
    const breachToday = lit.has(String(fId));
    // SIMULATE soft gate: seed = gamma * provenance_independence (0 for bare key).
    const gatedSeed = 0.6 * 0;
    const fixDropsPoison = gatedSeed < 0.01;
    const fixProbe: FixProbeVerdict = {
      fix: "(e) order pendingBridges by earned_bridge_value; seedActivation = gamma * origin provenance_independence (soft, never hard-skip)",
      targetAttack: "Bridgehead-Beacon",
      breachesToday: breachToday,
      fixOutcome: "PARTIAL",
      simulated: false,
      note: `Today the sweep is identity-blind: poison surfaces=${breachToday} at constant gamma. Soft gate: bare-key origin (indep 0) -> seed=${f3(gatedSeed)} < assembly floor (dropped=${fixDropsPoison}); earned bridges fire first. PARTIAL: the sweep is deliberately MANDATORY/fail-open so a starved bridge still gets a degraded crossing or a BRIDGE_STARVED stamp; earned_bridge_value is offline-earnable so a patient attacker buys priority; and a HARD gate would starve genuine convergence=1 insight bridges and erode 'walk never witnesses'.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `recall lit=${JSON.stringify([...lit])}; poison surfaced=${breachToday} via zero-independence bare-key bridge; soft-gate seed=${f3(gatedSeed)} => dropped=${fixDropsPoison}; halt=${result.halt.reason}.`,
      fixProbe,
    };
  },
};

// ===========================================================================
// FAMILY: provenance-tipping  (corroboration/disown credit substrate)
// ===========================================================================

const pt1_contributorPadding: Cycle3Spec = {
  id: "pt-1",
  name: "FIX-PROBE: Contributor-Padding Margin Dilution (hold-the-reopen-threshold)",
  tier: "provenance-tipping",
  novelty:
    "defaultSurvivingMargin = margin*(surviving/total) divides a reputation gap by an attacker-controlled count; ~10 same-key echo members hold surviving>=0.30 so a load-bearing tainted strand's removal never re-opens. Fix = exact alpha-recompute or distinct-root denominator.",
  run() {
    const h = new Harness();
    // The real engine DERIVES contributingStrandIds = winner + members SHARING the winner's
    // source — so any same-key pad is itself tainted by disown(winner). We confirm the real
    // re-open behavior, then SIMULATE the count-ratio dilution the design targets.
    const x = h.addSource({ label: "X", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "X-dom" });
    const co = h.addSource({ label: "CO", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "CO-email" });
    h.earnTo(x, 0.4); // X decisively out-earns a fresh rival -> the dispute RESOLVES (X wins)
    const winnerId = h.write(x, "Tip", "v", "WIN");
    // N same-key echo co-assertions by X (auto-added to contributingStrandIds).
    const N = 10;
    for (let i = 0; i < N; i++) h.write(x, "Tip", "v", "WIN");
    const loserId = h.write(co, "Tip", "v", "LOSE");
    const out = h.adjudicate("Tip", "v");
    const res = h.disown(x); // X (and its same-key pads) are all tainted
    const reopened = res.reopenedDisputes.length > 0;
    // The attacker's GOAL is a LOCKED fraudulent demotion: loser DEMOTED and never reopened.
    const fraudLocked = h.isDemoted(loserId) && !reopened;
    const engineDefends = !fraudLocked;

    // SIMULATE the count-ratio dilution: margin 0.33 padded by N echoes.
    const margin = 0.33;
    const decisiveMargin = 0.3;
    const countRatioSurviving = margin * (N / (N + 1)); // proportional model
    const countRatioSuppresses = countRatioSurviving >= decisiveMargin; // NO re-open
    // FIX: distinct-root denominator collapses same-key echoes to 1 -> ratio = margin*(1/2).
    const distinctRootSurviving = margin * (1 / 2);
    const fixReopens = distinctRootSurviving < decisiveMargin;
    const fixProbe: FixProbeVerdict = {
      fix: "Distinct independent-ROOT denominator (or exact per-source alpha-recompute) for defaultSurvivingMargin",
      targetAttack: "Contributor-Padding Margin Dilution",
      breachesToday: fraudLocked, // engine defends the same-key variant today (no locked demotion)
      fixOutcome: "PARTIAL",
      simulated: true,
      note: `Engine TODAY derives contributingStrandIds = winner + same-source members, so same-key echo pads are themselves tainted by disown(X) AND their equal rep flattens the decisive gap (the dispute ${out.kind}). Either way there is NO locked fraudulent demotion (fraudLocked=${fraudLocked}, reopened=${reopened}) — the same-key variant is ALREADY defended by the real engine. The residual is the proportional MODEL: margin*(N/(N+1))=${f3(countRatioSurviving)} >= ${decisiveMargin} suppresses=${countRatioSuppresses}; a distinct-ROOT denominator => ${f3(distinctRootSurviving)} re-opens=${fixReopens}. PARTIAL: distinct-root closes same-key; padding under DISTINCT cheap anchors degrades to the class-vs-root gap (exact alpha-recompute closes fully).`,
    };
    return {
      outcome: engineDefends ? "DEFENDED" : "BREACHED",
      mechanism: fixProbe.note,
      evidence: `adjudicate=${out.kind}; disown(X) reopened=${JSON.stringify(res.reopenedDisputes.map(String))} (reopened=${reopened}); winner=${h.state(winnerId)} loser=${h.state(loserId)}; locked fraudulent demotion=${fraudLocked} (engine defends=${engineDefends}); proportional-model suppress=${countRatioSuppresses} -> distinct-root fix reopen=${fixReopens}.`,
      fixProbe,
    };
  },
};

const pt2_taintedClosureGap: Cycle3Spec = {
  id: "pt-2",
  name: "FIX-PROBE: Downstream-Closure Credit-Reversal Gap (seedClawedBack vs taintedStrandIds)",
  tier: "provenance-tipping",
  novelty:
    "disown reverses corroboration credit against seedClawedBack (the DIRECT seed) while demotion is transitive over taintedStrandIds. Credit earned by agreeing with a derived-from-disowned (demoted) strand D is never reversed. One-line fix: pass taintedStrandIds to eventsIntersecting.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const dv = h.addSource({ label: "DV", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "DV-org" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const a1 = h.write(a, "seed", "v", "V");
    // A DERIVED strand D (authored by a SEPARATE deriver) resting on S via a DERIVATION
    // edge -> demoted by the BFS (in taintedStrandIds) but NOT in A's direct seed.
    const d1 = h.write(dv, "derived", "w", "DV");
    h.store.putEdge({
      id: asEdgeId(`edge:der:${String(d1)}->${String(a1)}`),
      from: d1,
      to: a1,
      edgeType: EdgeType.DERIVATION,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    });
    // B earns corroboration credit for agreeing with the DERIVED strand D.
    const b1 = h.write(b, "derived", "w", "DV");
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const dDemoted = h.isDemoted(d1);
    const eventNamesD = (h.ratification.corroboration?.all() ?? []).some((e) => e.corroboratingStrandIds.includes(d1));
    const breachToday = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9 && eventNamesD;

    // SIMULATE the one-line fix: intersect over the FULL demoted closure (incl. D).
    const taint = new Set<StrandId>([a1]);
    if (dDemoted) taint.add(d1);
    const wouldReverse = (h.ratification.corroboration?.all() ?? []).filter((e) =>
      e.corroboratingStrandIds.some((s) => taint.has(s)),
    );
    const fixReversesB = wouldReverse.some((e) => e.beneficiarySourceId === b.sourceId);
    const fixProbe: FixProbeVerdict = {
      fix: "One-line: pass taintedStrandIds (full demoted closure) instead of seedClawedBack to corroboration.eventsIntersecting",
      targetAttack: "Derived-strand-corroborator credit-reversal gap",
      breachesToday: breachToday,
      fixOutcome: "CLOSES",
      simulated: true,
      note: `D is demoted by the sweep (demoted=${dDemoted}) but its event was NOT reversed today (B alpha unchanged=${breachToday}, reversed=${JSON.stringify(res.reversedCorroborationEventIds)}). Intersecting over the FULL closure {S,D} would reverse B=${fixReversesB} at ~zero cost (idempotent via markReversed). CLOSES this hop; PARTIAL overall (does not close PT3 corroboration-of-corroboration); must still spare HARDENING-4 survived-demotion strands.`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `D demoted=${dDemoted}; event names D=${eventNamesD}; B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} today (survived=${breachToday}); fix over closure {S,D} reverses B=${fixReversesB}.`,
      fixProbe,
    };
  },
};

const pt3_multiHopLaundering: Cycle3Spec = {
  id: "pt-3",
  name: "Multi-Hop / Transitive Corroboration Laundering (A->B->C credit chain)",
  tier: "provenance-tipping",
  novelty:
    "Corroboration credit is reversed only where an event's corroborators intersect tainted STRANDS; it never propagates to the beneficiary's OWN strands as newly-tainted. C corroborates B's independently-observed strand SB (no DERIVATION edge to S); disown(A) reverses B but never C. Survives even PT2's fix.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const c = h.addSource({ label: "C", anchors: [anchorOf(AnchorClass.PHONE_SIM)], indClass: "C-phone" });
    const a1 = h.write(a, "x", "v", "V");
    const sb = h.write(b, "x", "v", "V"); // B observed independently then matched (no edge to A)
    h.engine.ratify({ strandId: sb, externalStamp: h.identity.stampFor(b.sourceId) });
    const sc = h.write(c, "x", "v", "V");
    h.engine.ratify({ strandId: sc, externalStamp: h.identity.stampFor(c.sourceId) });
    const cAlphaBefore = h.repState(c)?.alpha ?? 0;
    const res = h.disown(a);
    const cAlphaAfter = h.repState(c)?.alpha ?? 0;
    const e1Reversed = res.reversedCorroborationEventIds.length > 0;
    const cSurvives = Math.abs(cAlphaAfter - cAlphaBefore) < 1e-9;
    // Even PT2's fix (full demoted closure) cannot reach SB: it is NOT derived from S.
    const sbDemoted = h.isDemoted(sb);
    return {
      outcome: cSurvives ? "BREACHED" : "DEFENDED",
      mechanism:
        "The closure is over DERIVATION (existence-rests-on), not over CORROBORATION (credit-funded-by): credit attribution is intransitive while existence taint is transitive. SB carries no DERIVATION edge to S and is not demoted, so e2 (names SB) never intersects any tainted strand. Auto-following corroboration would punish coincidental agreement (the forbidden direction) — the fix must DETECT-and-defer, not auto-claw.",
      evidence: `e1 (B<-A) reversed=${e1Reversed}; SB demoted=${sbDemoted} (NOT in DERIVATION closure); C alpha ${f3(cAlphaBefore)}->${f3(cAlphaAfter)} after disown(A) (survives=${cSurvives}); laundered credit persists at corroboration-hop-2.`,
    };
  },
};

const pt4_misattributedCorroborator: Cycle3Spec = {
  id: "pt-4",
  name: "FIX-PROBE: Misattributed / Unnamed Corroborator Evasion",
  tier: "provenance-tipping",
  novelty:
    "corroboratingStrandIds is trusted verbatim from the caller. Naming a decoy clean strand yields earned==explained so reconcile sees RECONCILED yet disown reverses nothing. Fix = engine-derive corroborators mechanically + drop the no-name exemption.",
  run() {
    const h = new Harness();
    const a = h.addSource({ label: "A", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "A-dom" });
    const decoyKey = h.addSource({ label: "D", anchors: [anchorOf(AnchorClass.ORGANIZATION)], indClass: "D-org" });
    const b = h.addSource({ label: "B", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "B-email" });
    const a1 = h.write(a, "hq", "city", "V"); // the planter B actually rests on
    const decoy = h.write(decoyKey, "hq", "city", "V"); // a benign decoy B also controls
    const b1 = h.write(b, "hq", "city", "V");
    // B names the DECOY, not A, even though A seeded the belief.
    h.engine.ratify({ strandId: b1, externalStamp: h.identity.stampFor(b.sourceId) });
    const bAlphaBefore = h.repState(b)?.alpha ?? 0;
    const res = h.disown(a);
    const bAlphaAfter = h.repState(b)?.alpha ?? 0;
    const breachToday = Math.abs(bAlphaAfter - bAlphaBefore) < 1e-9;
    // SIMULATE the fix: engine-derive corroborators = the same-attribute LIVE members that
    // agree with B's value (the web computes this, not the caller). A's strand IS in that set.
    const sameValueAgreers = h.store
      .strandsByAttribute(h.attr("hq", "city"))
      .filter((s) => (s.payload as { value?: string }).value === "V" && String(s.id) !== String(b1))
      .map((s) => s.id);
    const engineDerivedNamesA = sameValueAgreers.some((id) => String(id) === String(a1));
    const fixReversesB = engineDerivedNamesA; // disown(A) would then intersect B's event
    const fixProbe: FixProbeVerdict = {
      fix: "Engine-derive corroboratingStrandIds from the web's computed agreement set (same-attribute LIVE agreers) + drop the no-name exemption",
      targetAttack: "Decoy-Corroborator Misattribution (and the Unnamed-Witness variant)",
      breachesToday: breachToday,
      fixOutcome: "CLOSES",
      simulated: true,
      note: `B named decoy not A: event recorded (reconcile balances earned==explained) yet disown(A) reversed=${JSON.stringify(res.reversedCorroborationEventIds)} (B survived=${breachToday}). Engine-derived agreement set names A=${engineDerivedNamesA} => disown(A) reverses B=${fixReversesB}. CLOSES misattribution + no-name (engine emits the event regardless of caller naming); a genuinely-independent ratify with no in-web agreer stays non-reversible by design (wall-with-a-window).`,
    };
    return {
      outcome: breachToday ? "BREACHED" : "DEFENDED",
      mechanism: fixProbe.note,
      evidence: `B named decoy; reversed by disown(A)=${JSON.stringify(res.reversedCorroborationEventIds)} (empty); B alpha ${f3(bAlphaBefore)}->${f3(bAlphaAfter)} (survived=${breachToday}); engine-derived agreers name A=${engineDerivedNamesA} => fix reverses B=${fixReversesB}.`,
      fixProbe,
    };
  },
};

const pt5_weaponizedReopen: Cycle3Spec = {
  id: "pt-5",
  name: "Weaponized Re-open: toothless PENDING + live-suppression persistence window",
  tier: "provenance-tipping",
  novelty:
    "Re-open emits members:[winner] only, restores no loser, re-runs no adjudication: the fraudulently-demoted rival stays the LIVE answer through the human-latency window. Re-assert under a fresh key to cement suppression and flood listPending.",
  run() {
    const h = new Harness();
    const x = h.addSource({ label: "X", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "X-dom" });
    const r = h.addSource({ label: "R", anchors: [anchorOf(AnchorClass.EMAIL_OAUTH)], indClass: "R-email" });
    h.earnTo(x, 0.4);
    h.ratifyOnce(r, 1);
    const winnerId = h.write(x, "Sup", "v", "X_WINS");
    const rivalId = h.write(r, "Sup", "v", "R_TRUE");
    const out = h.adjudicate("Sup", "v");
    const rivalDemotedAfterAdj = h.isDemoted(rivalId);
    // Disown X (X contributed fraudulently). Re-open fires.
    const res = h.disown(x);
    const reopened = res.reopenedDisputes.length > 0;
    const rivalStillDemoted = h.isDemoted(rivalId); // toothless: rival NOT restored
    // Persistence: rival is still suppressed; a fresh clean key Y wins uncontested.
    const y = h.addSource({ label: "Y", anchors: [anchorOf(AnchorClass.DOMAIN)], indClass: "Y-dom" });
    h.ratifyOnce(y, 1);
    h.write(y, "Sup", "v", "Y_WINS");
    const out2 = h.adjudicate("Sup", "v");
    const cementedWinner = liveWinner(h, "Sup", "v");
    const rivalNeverRestored = h.isDemoted(rivalId);
    const breach = reopened && rivalStillDemoted && rivalNeverRestored;
    return {
      outcome: breach ? "BREACHED" : "DEFENDED",
      mechanism:
        "Re-open was scoped to 'flag the winner for a human' (conservative against false-promotion) but the dual risk — the LOSER wrongly demoted by fraud — is unaddressed: the demotion is not even provisionally lifted, and the PENDING carries members=[winner] so the human lacks the contradiction set. Fraudulent demotion is the LIVE answer for the full human-latency window; a fresh key cements suppression.",
      evidence: `adjudicate=${out.kind}; rival demoted after adj=${rivalDemotedAfterAdj}; disown(X) reopened=${reopened}; rival still DEMOTED post-reopen=${rivalStillDemoted}; re-adjudicate=${out2.kind} cemented winner state=${cementedWinner ? h.state(cementedWinner) : "none"}; rival never restored=${rivalNeverRestored}.`,
    };
  },
};


// ===========================================================================
// THE CYCLE-3 SUITE
// ===========================================================================

export const CYCLE3_SPECS: readonly Cycle3Spec[] = [
  // combined-chained
  cc01_repFarmClassStackFlip,
  cc02_keyRotationWhitewash,
  cc03_transientBondHarvest,
  cc04_multiHopClawbackFix,
  cc05_bridgeIdentityGateFix,
  // adaptive-lcb
  al01_straddleDeferDoS,
  al02_amortizedGlobalFlip,
  al03_dormancyDecayWindow,
  al04_incumbencyMarginFix,
  al05_attrScopedRootsFix,
  // class-assignment-e2e
  ce01_registrarCarousel,
  ce02_subdomainSeam,
  ce03_nullSourceLaundromat,
  ce04_pslFix,
  ce05_rootsOperatorGraphFix,
  // fix-probes (adjudication gate)
  fp1_rootsNotClasses,
  fp2_universalCorrobFloor,
  fp3_perAttributeReputation,
  fp4_deferAll1v1,
  fp5_bridgeIdentityGate,
  // provenance-tipping
  pt1_contributorPadding,
  pt2_taintedClosureGap,
  pt3_multiHopLaundering,
  pt4_misattributedCorroborator,
  pt5_weaponizedReopen,
];

/** Adapt a Cycle3Spec to the cycle-1/2 Attack shape (for any shared runner). */
export const CYCLE3_ATTACKS: readonly Attack[] = CYCLE3_SPECS.map((s) => ({
  name: s.name,
  tier: s.tier,
  novelty: s.novelty,
  run: (): AttackResult => {
    const r = s.run();
    return { outcome: r.outcome, mechanism: r.mechanism, evidence: r.evidence };
  },
}));
