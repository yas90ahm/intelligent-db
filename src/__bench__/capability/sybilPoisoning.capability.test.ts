/**
 * sybilPoisoning.capability.test.ts — PHASE-2 CAPABILITY BENCHMARK (not a perf bench).
 *
 * Thesis under test (ARCHITECTURE.md): the two quantities a memory cannot honestly
 * compute about ITSELF — source independence and corroboration count — must be read
 * from an EXTERNAL priced-identity layer, not from model self-verification and not from
 * in-graph headcount/voting. A patient attacker who can MINT independent-LOOKING
 * sources (cheap keys) defeats any purely-internal rule (the hard theorem).
 *
 * We stage a memory-poisoning / Sybil-corroboration attack on ONE attribute and run
 * THREE adjudication arms over a sweep of attacker fleet size A at fixed honest count H:
 *
 *   Arm 1  VANILLA RAG          — raw strand-count majority, NO trust (vector-DB-style:
 *                                 more retrieved copies dominate top-k). Poisoned once
 *                                 the attacker out-copies the honest sources.
 *   Arm 2  PASSPORT-ONLY        — dedup by cryptographic key (invariant 1 collapses
 *                                 literal same-key echoes) then count DISTINCT keys.
 *                                 Necessary but NOT sufficient: a distinct-key Sybil
 *                                 fleet still out-votes the truth.
 *   Arm 3  INTELLIGENT DB       — independence via the REAL SourceIdentityLayer
 *                                 `independentRootCount` (maximum-independent-set over
 *                                 anchor-class disjointness). A cheap fleet behind ONE
 *                                 anchor class collapses to 1; truth (H disjoint
 *                                 classes) survives. Decisive-or-defer: a tie DEFERS to
 *                                 the human horn rather than auto-flipping.
 *
 * HONESTY CONTROL (not rigged): an EXPENSIVE Sybil — attacker buys A genuinely-distinct
 * PAID anchor classes — MUST also flip Arm 3 ("identity is priced, not prevented", the
 * stated residual). We assert that it does. If Arm 3 resisted the expensive attack the
 * benchmark would be lying about the threat model.
 *
 * Modeling note (load-bearing, stated honestly): the attacker controls KEYS (source
 * ids) freely, but NOT independence-CLASS assignment — that is the external anchor
 * layer's output (a cheap fleet behind one registrar/ASN/anchor ⇒ one class). So we
 * model the cheap fleet as distinct keys sharing ONE class, and the honest sources as
 * distinct classes. Arm 3 consults ONLY the class structure (the real MIS recursion);
 * Arms 1/2 cannot see it. Sources are left unresolvable (null) so the layer's
 * documented fallback is class-disjointness — exactly the signal under test.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { makeIdentity } from "../fixtures.js";

import type {
  EpochMs,
  IndependenceClassId,
  ProvenanceRoot,
  ProvenanceRootId,
} from "../../index.js";

const NOW = 1_700_000_000_000 as EpochMs;
type Verdict = "TRUE" | "FALSE" | "DEFER";

/** Honest witness i: a DISTINCT independence class (a real, disjoint anchor). */
function honestRoot(i: number): ProvenanceRoot {
  return {
    rootId: `root:honest:${i}` as ProvenanceRootId,
    independenceClass: `cls:honest:${i}` as IndependenceClassId,
    sourceId: null,
    establishedAt: NOW,
  };
}

/** Cheap Sybil i: a distinct KEY but ONE SHARED class (fleet behind one anchor). */
function cheapSybilRoot(i: number): ProvenanceRoot {
  return {
    rootId: `root:cheap:${i}` as ProvenanceRootId,
    independenceClass: `cls:cheap:SHARED` as IndependenceClassId,
    sourceId: null,
    establishedAt: NOW,
  };
}

/** Expensive Sybil i: a distinct PAID class each (priced, not prevented). */
function expensiveSybilRoot(i: number): ProvenanceRoot {
  return {
    rootId: `root:exp:${i}` as ProvenanceRootId,
    independenceClass: `cls:exp:${i}` as IndependenceClassId,
    sourceId: null,
    establishedAt: NOW,
  };
}

// --- The three adjudication arms (each returns the value it would SPEAK) ---------

/** Arm 1: raw strand count, no trust. Tie → FALSE (attacker writes last / recency). */
function arm1_vanillaRag(trueCount: number, falseCount: number): Verdict {
  return falseCount >= trueCount ? "FALSE" : "TRUE";
}

/** Arm 2: distinct-key headcount (literal echoes already collapsed). Tie → FALSE. */
function arm2_passportOnly(trueKeys: number, falseKeys: number): Verdict {
  return falseKeys >= trueKeys ? "FALSE" : "TRUE";
}

/**
 * Arm 3: decisive-or-defer over EXTERNAL independent counts. Strictly greater
 * independent corroboration wins; an exact tie DEFERS to the human horn (never
 * auto-flips to the challenger).
 */
function arm3_intelligentDb(trueIndep: number, falseIndep: number): Verdict {
  if (trueIndep > falseIndep) return "TRUE";
  if (falseIndep > trueIndep) return "FALSE";
  return "DEFER";
}

const H = 3; // honest witnesses asserting the TRUE value
const SWEEP = [1, 2, 3, 5, 10, 50, 200, 500]; // attacker fleet sizes A

describe("Phase-2 capability: Sybil-corroboration poisoning across three arms", () => {
  const { identity } = makeIdentity();

  // Independent-count of the honest side is fixed (H disjoint classes).
  const honestRoots = Array.from({ length: H }, (_, i) => honestRoot(i));
  const honestIndep = identity.independentRootCount(honestRoots);

  interface Row {
    A: number;
    cheap: { arm1: Verdict; arm2: Verdict; arm3: Verdict; falseIndep: number };
    expensive: { arm3: Verdict; falseIndep: number };
  }
  const rows: Row[] = [];

  for (const A of SWEEP) {
    const cheapFalseRoots = Array.from({ length: A }, (_, i) => cheapSybilRoot(i));
    const expFalseRoots = Array.from({ length: A }, (_, i) => expensiveSybilRoot(i));

    const cheapFalseIndep = identity.independentRootCount(cheapFalseRoots); // collapses to 1
    const expFalseIndep = identity.independentRootCount(expFalseRoots); // = A (real, paid)

    rows.push({
      A,
      cheap: {
        arm1: arm1_vanillaRag(H, A), // raw strands: H true vs A false copies
        arm2: arm2_passportOnly(H, A), // distinct keys: H vs A
        arm3: arm3_intelligentDb(honestIndep, cheapFalseIndep),
        falseIndep: cheapFalseIndep,
      },
      expensive: {
        arm3: arm3_intelligentDb(honestIndep, expFalseIndep),
        falseIndep: expFalseIndep,
      },
    });
  }

  it("honest side reads as H independent witnesses", () => {
    expect(honestIndep).toBe(H);
  });

  it("Arm 3 collapses a CHEAP Sybil fleet (any size) to ONE independent witness", () => {
    for (const r of rows) expect(r.cheap.falseIndep).toBe(1);
  });

  it("Arms 1 & 2 (no external identity) ARE poisoned once A > H", () => {
    for (const r of rows.filter((x) => x.A > H)) {
      expect(r.cheap.arm1).toBe("FALSE");
      expect(r.cheap.arm2).toBe("FALSE");
    }
  });

  it("Arm 3 (Intelligent DB) is NEVER poisoned by a cheap Sybil fleet", () => {
    for (const r of rows) expect(r.cheap.arm3).toBe("TRUE");
  });

  it("HONESTY CONTROL: Arm 3 DOES flip to an EXPENSIVE Sybil (priced, not prevented)", () => {
    for (const r of rows.filter((x) => x.A > H)) {
      expect(r.expensive.falseIndep).toBe(r.A);
      expect(r.expensive.arm3).toBe("FALSE");
    }
    // ...and is correctly NOT flipped while the paid fleet is still <= H.
    for (const r of rows.filter((x) => x.A < H)) {
      expect(r.expensive.arm3).toBe("TRUE");
    }
  });

  it("emits a results table to the Arbor session dir", () => {
    const lines: string[] = [];
    lines.push("# Phase-2 Capability Benchmark — Sybil-corroboration poisoning");
    lines.push("");
    lines.push(`Honest witnesses H = ${H} (independent count read by Arm 3 = ${honestIndep}).`);
    lines.push("Decision = the value each arm would SPEAK. Poisoned = it speaks FALSE.");
    lines.push("");
    lines.push("## Cheap Sybil fleet (distinct keys, ONE shared anchor class)");
    lines.push("");
    lines.push("| Attacker A | Arm1 vanilla-RAG | Arm2 passport-only | Arm3 IntelligentDB | Arm3 indep-count(false) |");
    lines.push("|---:|:--:|:--:|:--:|---:|");
    for (const r of rows) {
      lines.push(
        `| ${r.A} | ${r.cheap.arm1} | ${r.cheap.arm2} | ${r.cheap.arm3} | ${r.cheap.falseIndep} |`,
      );
    }
    lines.push("");
    lines.push("## Honesty control — Expensive Sybil (A distinct PAID anchor classes)");
    lines.push("");
    lines.push("| Attacker A | Arm3 IntelligentDB | Arm3 indep-count(false) |");
    lines.push("|---:|:--:|---:|");
    for (const r of rows) {
      lines.push(`| ${r.A} | ${r.expensive.arm3} | ${r.expensive.falseIndep} |`);
    }
    lines.push("");
    lines.push("Reading: Arms 1 & 2 flip to FALSE as soon as the cheap fleet out-numbers");
    lines.push("the truth; Arm 3 stays TRUE for every fleet size because the fleet collapses");
    lines.push("to one independent class. The control proves Arm 3 is not rigged: a genuinely");
    lines.push("paid fleet of distinct anchors DOES overturn the truth (priced, not prevented).");

    const md = lines.join("\n");
    const outDir = "D:/Intelligent DB/.arbor/sessions/prior-art-research";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/phase2-capability-results.md`, md, "utf8");
    writeFileSync(
      `${outDir}/phase2-capability-results.json`,
      JSON.stringify({ H, honestIndep, rows }, null, 2),
      "utf8",
    );
    expect(md).toContain("Arm3 IntelligentDB");
  });
});
