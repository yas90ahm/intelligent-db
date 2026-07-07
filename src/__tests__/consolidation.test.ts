/**
 * consolidation.test.ts — CONTRADICTION ADJUDICATION (tryConsolidate), the
 * theorem-honest core.
 *
 * The hard theorem (CLAUDE.md): under "identity is priced, not prevented", no
 * purely internal rule can adjudicate an INDEPENDENT dispute. The resolution is an
 * external signal + defer-to-human. These tests pin every theorem invariant the
 * verifier checks:
 *
 *  - A SINGLE-independence-class dispute (a same-root echo artifact) is the SAFE
 *    case: it RESOLVES, choosing the winner by EXTERNAL SIGNAL ONLY (reputation ->
 *    anchor_cost -> stake -> deterministic id tiebreak), NEVER by headcount.
 *  - A MULTI-independence-class dispute is GENUINELY independent: it always DEFERS
 *    with a PendingRatification and demotes NOTHING — the inviolable safety gate.
 *  - A true higher-reputation source beats a planted lower-reputation one; a flood
 *    of weightless fresh echoes never overturns an established incumbent and never
 *    wins by being numerous.
 *  - demote DEMOTES, never deletes (sets DEMOTED + outranked_by).
 *
 * Everything is exercised through the public barrel (`../index.js`).
 */

import { describe, it, expect } from "vitest";

import {
  buildContradictionSet,
  demote,
  tryConsolidate,
  EdgeType,
  FactState,
  FactOrigin,
  Tier,
  asEpochMs,
  asStrandId,
  asEdgeId,
} from "../index.js";

import type {
  Strand,
  Edge,
  EntityId,
  AttributeKey,
  SourceId,
  ProvenanceRoot,
  ProvenanceRootId,
  IdentityStamp,
  EpochMs,
  Unit,
  ConsolidationOutcome,
  HighImpactContext,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

const ATTR = "berlin#capital_of" as AttributeKey;
const ENTITY = "entity:berlin" as EntityId;

/**
 * Build a disputed OBSERVED strand about (ENTITY, ATTR). `cls` is its sole
 * independence class; `rootId` keys its identity stamp; `payload` is the claim
 * (distinct payloads disagree). All other fields are inert defaults.
 */
function claimStrand(opts: {
  idRaw: string;
  rootIdRaw: string;
  cls: string;
  payload: unknown;
}): Strand {
  const { idRaw, rootIdRaw, cls, payload } = opts;
  const root: ProvenanceRoot = {
    rootId: rootIdRaw as ProvenanceRootId,
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId: null,
    establishedAt: NOW,
  };
  return {
    id: asStrandId(idRaw),
    entity: ENTITY,
    attribute: ATTR,
    payload,
    // Distinct content_hash per payload so payloadFingerprint separates claims and
    // never accidentally collapses two genuinely different claims.
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
}

/** An identity stamp with hand-chosen external signals (the only adjudication input). */
function stamp(opts: {
  sourceIdRaw: string;
  reputation?: number;
  anchorCost?: number;
  stakePosted?: number;
}): IdentityStamp {
  return {
    source_id: opts.sourceIdRaw as SourceId,
    anchor_set: [],
    anchor_cost: (opts.anchorCost ?? 0) as Unit,
    reputation: (opts.reputation ?? 0) as Unit,
    stake_posted: opts.stakePosted ?? 0,
  };
}

describe("tryConsolidate — single independence class (the SAFE case)", () => {
  it("a true higher-reputation source wins and the lower-rep loser is demoted", () => {
    // Same independence class => same-root echo dispute => SAFE to resolve. Two
    // DISAGREEING claims; the winner is chosen by reputation alone (an EXTERNAL
    // signal), never by who is numerous.
    const incumbent = claimStrand({
      idRaw: "strand:incumbent",
      rootIdRaw: "root:incumbent",
      cls: "class:X",
      payload: { capitalOf: "Germany" },
    });
    const challenger = claimStrand({
      idRaw: "strand:challenger",
      rootIdRaw: "root:challenger",
      cls: "class:X", // SAME class as incumbent
      payload: { capitalOf: "Atlantis" },
    });

    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      [
        "root:incumbent" as ProvenanceRootId,
        stamp({ sourceIdRaw: "src:inc", reputation: 0.6 }),
      ],
      [
        "root:challenger" as ProvenanceRootId,
        stamp({ sourceIdRaw: "src:chal", reputation: 0.0 }),
      ],
    ]);

    const set = buildContradictionSet([incumbent, challenger]);
    const out: ConsolidationOutcome = tryConsolidate(
      set,
      [incumbent, challenger],
      stampsByRoot,
      NOW,
    );

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");

    // Exactly the challenger is demoted; the incumbent is untouched and LIVE.
    expect(out.demotions.map((d) => d.demoted)).toEqual([challenger.id]);
    expect(challenger.fact_state).toBe(FactState.DEMOTED);
    expect(challenger.outranked_by).not.toBeNull();
    expect(incumbent.fact_state).toBe(FactState.LIVE);

    // The demotion is authorized by an OUTRANKS edge winner->loser.
    const d = out.demotions[0]!;
    expect(d.newState).toBe(FactState.DEMOTED);
    expect(d.outranks).toBe(challenger.outranked_by);
  });

  it("anchor_cost breaks a reputation tie (priced identity beats free)", () => {
    // Both fresh (reputation 0); the winner is the one whose source paid more for
    // its identity. Still an EXTERNAL signal, still no headcount.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:X",
      payload: { v: "A" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:X",
      payload: { v: "B" },
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", anchorCost: 0.7 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", anchorCost: 0.1 })],
    ]);

    const out = tryConsolidate(buildContradictionSet([a, b]), [a, b], stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");
    expect(out.demotions.map((d) => d.demoted)).toEqual([b.id]);
    expect(b.fact_state).toBe(FactState.DEMOTED);
    expect(a.fact_state).toBe(FactState.LIVE);
  });

  it("a fresh-echo flood resolves DETERMINISTICALLY without majority (id tiebreak)", () => {
    // THE BOMB, defused. Many same-class fresh echoes: every stamp is reputation 0,
    // anchor_cost 0, stake 0. There is NO signal winner, so selection falls through
    // to the deterministic id tiebreak (id-min wins) — NOT to the most-numerous
    // claim. We make the LOSING claim the MAJORITY to prove headcount is ignored.
    const N = 50;
    const members: Strand[] = [];
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>();

    // The id-min strand carries the MINORITY claim "alpha".
    const winner = claimStrand({
      idRaw: "strand:000-winner",
      rootIdRaw: "root:000",
      cls: "class:X",
      payload: { v: "alpha" }, // minority claim (appears once)
    });
    members.push(winner);
    stampsByRoot.set("root:000" as ProvenanceRootId, stamp({ sourceIdRaw: "src:000" }));

    // A large MAJORITY all making the OTHER claim "beta", all id-greater.
    for (let i = 1; i <= N; i++) {
      const idRaw = "strand:" + String(i).padStart(3, "0") + "-flood";
      const rootRaw = "root:" + String(i).padStart(3, "0");
      const s = claimStrand({
        idRaw,
        rootIdRaw: rootRaw,
        cls: "class:X", // SAME class for all => single-class safe case
        payload: { v: "beta" }, // MAJORITY claim
      });
      members.push(s);
      stampsByRoot.set(rootRaw as ProvenanceRootId, stamp({ sourceIdRaw: "src:" + i }));
    }

    const set = buildContradictionSet(members);
    const out = tryConsolidate(set, members, stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");

    // The id-min strand won DESPITE carrying the MINORITY claim — proving no vote.
    expect(winner.fact_state).toBe(FactState.LIVE);
    // Every other DISTINCT-claim member (the whole "beta" majority) was demoted.
    expect(out.demotions.length).toBe(N);
    for (const s of members) {
      if (s.id === winner.id) continue;
      expect(s.fact_state).toBe(FactState.DEMOTED);
      expect(s.outranked_by).not.toBeNull();
    }
  });

  it("a weightless fresh flood NEVER overturns an established incumbent", () => {
    // One genuine high-rep incumbent vs many fresh (rep 0) challengers, SAME class.
    // Reputation decides on its own key; the flood's size is irrelevant.
    const incumbent = claimStrand({
      idRaw: "strand:zzz-incumbent", // deliberately id-MAX so only reputation can save it
      rootIdRaw: "root:inc",
      cls: "class:X",
      payload: { capitalOf: "Germany" },
    });
    const members: Strand[] = [incumbent];
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:inc" as ProvenanceRootId, stamp({ sourceIdRaw: "src:inc", reputation: 0.6 })],
    ]);
    for (let i = 0; i < 20; i++) {
      const idRaw = "strand:" + String(i).padStart(3, "0") + "-fresh";
      const rootRaw = "root:fresh:" + i;
      const s = claimStrand({
        idRaw,
        rootIdRaw: rootRaw,
        cls: "class:X",
        payload: { capitalOf: "Atlantis" },
      });
      members.push(s);
      stampsByRoot.set(rootRaw as ProvenanceRootId, stamp({ sourceIdRaw: "src:" + i }));
    }

    const out = tryConsolidate(buildContradictionSet(members), members, stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");
    // The incumbent survived (won on reputation) even though it is the id-MAX and
    // outnumbered 20-to-1; every fresh challenger was demoted.
    expect(incumbent.fact_state).toBe(FactState.LIVE);
    expect(out.demotions.length).toBe(20);
  });
});

describe("tryConsolidate — multiple independence classes (the INDEPENDENT dispute)", () => {
  it("lopsided EARNED reputation auto-resolves (decisive incumbent wins, never majority)", () => {
    // Enhancement #2 (decisive-or-defer): two DISAGREEING claims from DISTINCT
    // independence classes, but with a CLEAR EARNED reputation gap. A high-rep
    // incumbent (0.9) vs a fresh challenger (0.0) clears BOTH gates of the default
    // policy (gap 0.9 >= 0.30 decisiveMargin; winner 0.9 >= 0.20 minWinnerReputation),
    // so reputation — an EXTERNAL signal, never headcount — auto-resolves it.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:A",
      payload: { capitalOf: "Germany" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:B", // DIFFERENT class => independent
      payload: { capitalOf: "Atlantis" },
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", reputation: 0.9 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", reputation: 0.0 })],
    ]);

    const set = buildContradictionSet([a, b]);
    const out = tryConsolidate(set, [a, b], stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");

    // The high-rep incumbent stays LIVE; the fresh challenger is the single loser.
    expect(out.demotions.map((d) => d.demoted)).toEqual([b.id]);
    expect(a.fact_state).toBe(FactState.LIVE);
    expect(a.outranked_by).toBeNull();
    expect(b.fact_state).toBe(FactState.DEMOTED);
    expect(b.outranked_by).not.toBeNull();
  });

  it("a high-rep incumbent auto-wins a ~40-member fresh cross-class flood (headcount ignored)", () => {
    // The council's "reputation as a pre-filter so the bomb never becomes human
    // fatigue": one EARNED incumbent (0.6) vs ~40 FRESH (rep 0) sources, each its
    // own independence class. Decisive (gap 0.6 >= 0.30, winner 0.6 >= 0.20) =>
    // auto-RESOLVED. Headcount is ignored: 40 weightless echoes cannot overturn one
    // earned witness, and all 40 are demoted.
    const incumbent = claimStrand({
      idRaw: "strand:zzz-incumbent", // id-MAX so only reputation can save it
      rootIdRaw: "root:inc",
      cls: "class:incumbent",
      payload: { capitalOf: "Germany" },
    });
    const members: Strand[] = [incumbent];
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:inc" as ProvenanceRootId, stamp({ sourceIdRaw: "src:inc", reputation: 0.6 })],
    ]);
    for (let i = 0; i < 40; i++) {
      const idRaw = "strand:" + String(i).padStart(3, "0") + "-flood";
      const rootRaw = "root:flood:" + i;
      const s = claimStrand({
        idRaw,
        rootIdRaw: rootRaw,
        cls: "class:flood:" + i, // EACH its own class => genuinely independent
        payload: { capitalOf: "Atlantis" },
      });
      members.push(s);
      stampsByRoot.set(rootRaw as ProvenanceRootId, stamp({ sourceIdRaw: "src:" + i }));
    }

    const out = tryConsolidate(buildContradictionSet(members), members, stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");
    expect(incumbent.fact_state).toBe(FactState.LIVE);
    expect(incumbent.outranked_by).toBeNull();
    expect(out.demotions.length).toBe(40);
    for (const s of members) {
      if (s.id === incumbent.id) continue;
      expect(s.fact_state).toBe(FactState.DEMOTED);
      expect(s.outranked_by).not.toBeNull();
    }
  });

  it("a lower-rep member can NEVER win (no inversion): 0.7 wins over 0.3", () => {
    // The winner must be the reputation-MAX member of the rep-desc sort — never a
    // lower-rep one. Gap 0.4 >= 0.30 and winner 0.7 >= 0.20 => decisive auto-resolve;
    // the 0.7 source wins and the 0.3 source is demoted, never the inverse.
    const high = claimStrand({
      idRaw: "strand:zzz-high", // id-MAX: only reputation can make it the winner
      rootIdRaw: "root:high",
      cls: "class:H",
      payload: { v: "high-claim" },
    });
    const low = claimStrand({
      idRaw: "strand:aaa-low", // id-MIN: would win a tiebreak, but must NOT here
      rootIdRaw: "root:low",
      cls: "class:L",
      payload: { v: "low-claim" },
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:high" as ProvenanceRootId, stamp({ sourceIdRaw: "src:h", reputation: 0.7 })],
      ["root:low" as ProvenanceRootId, stamp({ sourceIdRaw: "src:l", reputation: 0.3 })],
    ]);

    const out = tryConsolidate(buildContradictionSet([high, low]), [high, low], stampsByRoot, NOW);

    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");
    // The lower-rep member is the loser; the higher-rep member is never demoted.
    expect(out.demotions.map((d) => d.demoted)).toEqual([low.id]);
    expect(high.fact_state).toBe(FactState.LIVE);
    expect(low.fact_state).toBe(FactState.DEMOTED);
  });

  it("two comparably-high-rep independents DEFER (genuine tie, gap < margin)", () => {
    // Both are genuinely-earned (0.85 and 0.80, each >= minWinnerReputation), but the
    // gap (0.05) is below decisiveMargin (0.30) => NOT decisive => a genuine tie that
    // reaches a human. Nothing is demoted.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:A",
      payload: { v: "A" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:B",
      payload: { v: "B" },
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", reputation: 0.85 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", reputation: 0.8 })],
    ]);

    const out = tryConsolidate(buildContradictionSet([a, b]), [a, b], stampsByRoot, NOW);

    expect(out.kind).toBe("DEFERRED");
    if (out.kind !== "DEFERRED") throw new Error("unreachable");
    expect(a.fact_state).toBe(FactState.LIVE);
    expect(b.fact_state).toBe(FactState.LIVE);
    expect(a.outranked_by).toBeNull();
    expect(b.outranked_by).toBeNull();
    // Ranked strongest-first FOR THE HUMAN (decides nothing): higher-rep a leads.
    expect([...out.pending.members]).toEqual([a.id, b.id]);
  });

  it("bug fix (decisive-margin-may-rank-corroborator-as-runner-up): an AGREEING corroborator ranked #2 overall must never stand in for the true competing claim", () => {
    // THREE members, genuinely multi-class (classes A/A2/B):
    //  - `top`      claims "A", reputation 0.6 (the winner).
    //  - `corrob`   AGREES with `top` (SAME payload "A"), independent class A2,
    //               reputation 0.5 — ranked #2 OVERALL by raw strength, but it is a
    //               CO-ASSERTER of the winning claim, not a competitor.
    //  - `rival`    the TRUE competing claim ("B"), independence class B,
    //               reputation 0.2.
    //
    // Pre-fix, `second = ranked[1]` landed on `corrob` (0.5): gap = 0.6-0.5 = 0.1,
    // below decisiveMargin (0.30) => the gate would spuriously DEFER even though the
    // winner clears the REAL competing claim by a wide, decisive margin.
    // Post-fix, `runnerUp` is found by filtering to a DIFFERING payload fingerprint
    // (M4's own runner-up logic, reused here) => runnerUp = `rival` (0.2): gap =
    // 0.6-0.2 = 0.4 >= 0.30 => decisive, and 0.6 >= 0.20 (minWinnerReputation) =>
    // RESOLVED. The agreeing corroborator is never demoted (same claim as the
    // winner); the true rival is the sole loser.
    const top = claimStrand({
      idRaw: "strand:top",
      rootIdRaw: "root:top",
      cls: "class:A",
      payload: { v: "A" },
    });
    const corrob = claimStrand({
      idRaw: "strand:corrob",
      rootIdRaw: "root:corrob",
      cls: "class:A2",
      payload: { v: "A" }, // AGREES with top — an independent corroborator, not a rival
    });
    const rival = claimStrand({
      idRaw: "strand:rival",
      rootIdRaw: "root:rival",
      cls: "class:B",
      payload: { v: "B" }, // the TRUE competing claim
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:top" as ProvenanceRootId, stamp({ sourceIdRaw: "src:top", reputation: 0.6 })],
      ["root:corrob" as ProvenanceRootId, stamp({ sourceIdRaw: "src:corrob", reputation: 0.5 })],
      ["root:rival" as ProvenanceRootId, stamp({ sourceIdRaw: "src:rival", reputation: 0.2 })],
    ]);

    const out = tryConsolidate(
      buildContradictionSet([top, corrob, rival]),
      [top, corrob, rival],
      stampsByRoot,
      NOW,
    );

    // THE GATE USES THE REAL COMPETITOR: resolves decisively instead of spuriously
    // deferring against the agreeing corroborator's reputation.
    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");

    expect(out.demotions.map((d) => d.demoted)).toEqual([rival.id]);
    expect(top.fact_state).toBe(FactState.LIVE);
    expect(top.outranked_by).toBeNull();
    // The agreeing corroborator shares the winner's claim — never demoted.
    expect(corrob.fact_state).toBe(FactState.LIVE);
    expect(corrob.outranked_by).toBeNull();
    expect(rival.fact_state).toBe(FactState.DEMOTED);
    expect(rival.outranked_by).not.toBeNull();
  });

  it("a decisive gap whose winner is below the floor DEFERS (fails minWinnerReputation)", () => {
    // The gap (0.18) is decisive on its own, but the winner's reputation (0.18) is
    // BELOW minWinnerReputation (0.20) — a weightless near-fresh source. Gate (b)
    // fails => DEFER. No fresh/low-rep source ever auto-wins.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:A",
      payload: { v: "A" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:B",
      payload: { v: "B" },
    });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", reputation: 0.18 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", reputation: 0.0 })],
    ]);

    const out = tryConsolidate(buildContradictionSet([a, b]), [a, b], stampsByRoot, NOW);

    expect(out.kind).toBe("DEFERRED");
    if (out.kind !== "DEFERRED") throw new Error("unreachable");
    expect(a.fact_state).toBe(FactState.LIVE);
    expect(b.fact_state).toBe(FactState.LIVE);
  });

  it("a multi-class all-weightless FRESH-FLOOD DEFERS (fails minWinnerReputation)", () => {
    // A cross-class flood of fresh sources is exactly the independent dispute the
    // theorem forbids resolving in-graph — even with no reputation anywhere.
    const members: Strand[] = [];
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>();
    for (let i = 0; i < 40; i++) {
      const idRaw = "strand:flood:" + i;
      const rootRaw = "root:flood:" + i;
      const s = claimStrand({
        idRaw,
        rootIdRaw: rootRaw,
        cls: "class:" + i, // EACH its own independence class => all independent
        payload: { v: "claim-" + (i % 2) }, // two competing claims
      });
      members.push(s);
      stampsByRoot.set(rootRaw as ProvenanceRootId, stamp({ sourceIdRaw: "src:" + i }));
    }

    const out = tryConsolidate(buildContradictionSet(members), members, stampsByRoot, NOW);

    expect(out.kind).toBe("DEFERRED");
    if (out.kind !== "DEFERRED") throw new Error("unreachable");
    // Absolutely nothing demoted on the independent path.
    for (const s of members) {
      expect(s.fact_state).toBe(FactState.LIVE);
      expect(s.outranked_by).toBeNull();
    }
    expect(out.pending.members.length).toBe(members.length);
  });
});

describe("tryConsolidate — HIGH-IMPACT GATE (irreversible decisions need more than LCB)", () => {
  // A decisive multi-class dispute: a high-rep incumbent (0.9) vs a fresh challenger.
  // WITHOUT a HighImpactContext this auto-RESOLVES (the ordinary path). WITH one, the
  // decisive LCB margin is necessary but NOT sufficient — the winner must also clear
  // count + recency + >= 2 disjoint anchor classes, else DEFER.
  function decisiveDispute(): {
    set: ReturnType<typeof buildContradictionSet>;
    members: Strand[];
    stampsByRoot: Map<ProvenanceRootId, IdentityStamp>;
    winner: Strand;
  } {
    const a = claimStrand({ idRaw: "strand:a", rootIdRaw: "root:a", cls: "class:A", payload: { v: "Germany" } });
    const b = claimStrand({ idRaw: "strand:b", rootIdRaw: "root:b", cls: "class:B", payload: { v: "Atlantis" } });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", reputation: 0.9 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", reputation: 0.0 })],
    ]);
    return { set: buildContradictionSet([a, b]), members: [a, b], stampsByRoot, winner: a };
  }

  /** A clean high-impact context: winner has 5 corroborations, clean, 3 anchor classes. */
  function cleanCtx(winner: Strand): HighImpactContext {
    return {
      corroborationCountOf: (id) => (id === winner.id ? 5 : 0),
      lastContradictionAtOf: () => null, // never contradicted => recency-clean
      anchorClassCountOf: (id) => (id === winner.id ? 3 : 0),
    };
  }

  it("CLEARS: a high-impact winner with count + recency-clean + >= 2 anchor classes resolves", () => {
    const { set, members, stampsByRoot, winner } = decisiveDispute();
    const out = tryConsolidate(set, members, stampsByRoot, NOW, undefined, undefined, cleanCtx(winner));
    expect(out.kind).toBe("RESOLVED");
    if (out.kind !== "RESOLVED") throw new Error("unreachable");
    expect(out.demotions.map((d) => d.demoted)).toEqual([members[1]!.id]);
    expect(winner.fact_state).toBe(FactState.LIVE);
  });

  it("DEFERS when corroboration count is below the minimum (LCB margin alone is not enough)", () => {
    const { set, members, stampsByRoot, winner } = decisiveDispute();
    const ctx: HighImpactContext = {
      ...cleanCtx(winner),
      corroborationCountOf: () => 1, // below default minCorroborationCount = 2
    };
    const out = tryConsolidate(set, members, stampsByRoot, NOW, undefined, undefined, ctx);
    expect(out.kind).toBe("DEFERRED");
    // Nothing demoted on the deferred high-impact path.
    for (const m of members) expect(m.fact_state).toBe(FactState.LIVE);
  });

  it("DEFERS when the winner was contradicted within the recency window", () => {
    const { set, members, stampsByRoot, winner } = decisiveDispute();
    const recent = asEpochMs((NOW as number) - 1 * 86_400_000); // 1 day ago, within 90d window
    const ctx: HighImpactContext = {
      ...cleanCtx(winner),
      lastContradictionAtOf: (id) => (id === winner.id ? recent : null),
    };
    const out = tryConsolidate(set, members, stampsByRoot, NOW, undefined, undefined, ctx);
    expect(out.kind).toBe("DEFERRED");
    for (const m of members) expect(m.fact_state).toBe(FactState.LIVE);
  });

  it("CLEARS when the winner's last contradiction is OLDER than the recency window", () => {
    const { set, members, stampsByRoot, winner } = decisiveDispute();
    const old = asEpochMs((NOW as number) - 200 * 86_400_000); // 200 days ago, outside 90d
    const ctx: HighImpactContext = {
      ...cleanCtx(winner),
      lastContradictionAtOf: (id) => (id === winner.id ? old : null),
    };
    const out = tryConsolidate(set, members, stampsByRoot, NOW, undefined, undefined, ctx);
    expect(out.kind).toBe("RESOLVED");
  });

  it("DEFERS when the winner's independence derives from fewer than 2 anchor classes", () => {
    const { set, members, stampsByRoot, winner } = decisiveDispute();
    const ctx: HighImpactContext = {
      ...cleanCtx(winner),
      anchorClassCountOf: () => 1, // single anchor class => single Sybil point
    };
    const out = tryConsolidate(set, members, stampsByRoot, NOW, undefined, undefined, ctx);
    expect(out.kind).toBe("DEFERRED");
    for (const m of members) expect(m.fact_state).toBe(FactState.LIVE);
  });

  it("ORDINARY (non-high-impact) adjudication is UNCHANGED: the same dispute auto-resolves on LCB", () => {
    const { set, members, stampsByRoot } = decisiveDispute();
    // No HighImpactContext => the gate is never consulted; resolves exactly as before.
    const out = tryConsolidate(set, members, stampsByRoot, NOW);
    expect(out.kind).toBe("RESOLVED");
  });

  it("the gate also applies to a SINGLE-class (safe-case) irreversible decision", () => {
    // Same independence class => the safe in-graph case. A high-impact flag still
    // demands the winner clear the gate; a winner failing it DEFERS instead of
    // resolving in-graph.
    const a = claimStrand({ idRaw: "strand:a", rootIdRaw: "root:a", cls: "class:X", payload: { v: "Germany" } });
    const b = claimStrand({ idRaw: "strand:b", rootIdRaw: "root:b", cls: "class:X", payload: { v: "Atlantis" } });
    const stampsByRoot = new Map<ProvenanceRootId, IdentityStamp>([
      ["root:a" as ProvenanceRootId, stamp({ sourceIdRaw: "src:a", reputation: 0.6 })],
      ["root:b" as ProvenanceRootId, stamp({ sourceIdRaw: "src:b", reputation: 0.0 })],
    ]);
    const failGate: HighImpactContext = {
      corroborationCountOf: () => 0, // fails the gate
      lastContradictionAtOf: () => null,
      anchorClassCountOf: () => 3,
    };
    const out = tryConsolidate(buildContradictionSet([a, b]), [a, b], stampsByRoot, NOW, undefined, undefined, failGate);
    expect(out.kind).toBe("DEFERRED");
    expect(a.fact_state).toBe(FactState.LIVE);
    expect(b.fact_state).toBe(FactState.LIVE);
  });
});

describe("tryConsolidate — NOOP (nothing to adjudicate)", () => {
  it("a single member is a NOOP", () => {
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:X",
      payload: { v: "A" },
    });
    const set = buildContradictionSet([a]);
    const out = tryConsolidate(set, [a], new Map(), NOW);
    expect(out.kind).toBe("NOOP");
  });

  it("multiple members that all make the SAME claim is a NOOP (no dispute)", () => {
    // Same payload => one distinct claim => nothing disagrees => NOOP, not a vacuous
    // RESOLVED, and certainly no demotion.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:X",
      payload: { v: "same" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:X",
      payload: { v: "same" },
    });
    const out = tryConsolidate(buildContradictionSet([a, b]), [a, b], new Map(), NOW);
    expect(out.kind).toBe("NOOP");
    expect(a.fact_state).toBe(FactState.LIVE);
    expect(b.fact_state).toBe(FactState.LIVE);
  });
});

describe("tryConsolidate — DEFENSE-IN-DEPTH: zero-provenance dispute (Wave-3 consolidation-zero-provenance-fallback)", () => {
  it("a synthetic dispute whose members carry NO provenance roots at all DEFERS — it never falls through the single-class safe path and resolves on an empty basis", () => {
    // A hand-built, malformed dispute: two DISTINCT claims (so it is a genuine
    // dispute, not the NOOP case above), but neither member carries so much as
    // ONE provenance root. `independenceClassesOf` therefore returns a set of
    // size 0 — NOT > 1 (so it would previously fall through to the "SAFE CASE",
    // which ranks by `stampsByRoot`-derived strength off of a nonexistent root
    // and would resolve/demote on zero external signal). This shape is
    // UNREACHABLE via the live write path (every real strand mints at least one
    // provenance root at write time) — this is a defense-in-depth floor against
    // a malformed/synthetic caller, not a live-path regression.
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:X",
      payload: { v: "A" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:Y",
      payload: { v: "B" },
    });
    // Strip provenance AFTER construction — claimStrand always mints a root, so
    // this is the only way to reach the zero-provenance shape at all.
    const zeroProvA: Strand = { ...a, provenance: [] };
    const zeroProvB: Strand = { ...b, provenance: [] };

    const set = buildContradictionSet([zeroProvA, zeroProvB]);
    const out = tryConsolidate(set, [zeroProvA, zeroProvB], new Map(), NOW);

    expect(out.kind).toBe("DEFERRED");
    if (out.kind === "DEFERRED") {
      expect(out.pending.reason).toBe("INDEPENDENT_DISPUTE");
    }
    // Never resolved, never demoted — the human horn decides, exactly like a
    // genuine multi-class dispute.
    expect(zeroProvA.fact_state).toBe(FactState.LIVE);
    expect(zeroProvB.fact_state).toBe(FactState.LIVE);
  });
});

describe("tryConsolidate — wiring guards", () => {
  it("throws if a set member was not provided in 'members'", () => {
    const a = claimStrand({
      idRaw: "strand:a",
      rootIdRaw: "root:a",
      cls: "class:X",
      payload: { v: "A" },
    });
    const b = claimStrand({
      idRaw: "strand:b",
      rootIdRaw: "root:b",
      cls: "class:X",
      payload: { v: "B" },
    });
    const set = buildContradictionSet([a, b]);
    // Only provide 'a'; 'b' is in the set but missing from members.
    expect(() => tryConsolidate(set, [a], new Map(), NOW)).toThrow();
  });
});

describe("demote — DEMOTES, never deletes", () => {
  it("sets fact_state=DEMOTED and outranked_by to the OUTRANKS edge id", () => {
    const loser = claimStrand({
      idRaw: "strand:loser",
      rootIdRaw: "root:loser",
      cls: "class:X",
      payload: { v: "loser" },
    });
    const edge: Edge = {
      id: asEdgeId("edge:outranks:w->loser"),
      from: asStrandId("strand:winner"),
      to: loser.id,
      edgeType: EdgeType.OUTRANKS,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    };

    const result = demote(loser, edge);

    expect(result.newState).toBe(FactState.DEMOTED);
    expect(result.demoted).toBe(loser.id);
    expect(result.outranks).toBe(edge.id);
    // The strand is mutated in place but NOT deleted — kept as history.
    expect(loser.fact_state).toBe(FactState.DEMOTED);
    expect(loser.outranked_by).toBe(edge.id);
  });

  it("refuses a non-OUTRANKS edge", () => {
    const loser = claimStrand({
      idRaw: "strand:loser",
      rootIdRaw: "root:loser",
      cls: "class:X",
      payload: { v: "loser" },
    });
    const badEdge: Edge = {
      id: asEdgeId("edge:shared"),
      from: asStrandId("strand:winner"),
      to: loser.id,
      edgeType: EdgeType.SHARED_ENTITY,
      link_confidence: 1 as Unit,
      provenance_independence: 1 as Unit,
      recency: 1 as Unit,
      w: 1 as Unit,
      out_weight_sum: 1 as Unit,
    };
    expect(() => demote(loser, badEdge)).toThrow();
  });
});
