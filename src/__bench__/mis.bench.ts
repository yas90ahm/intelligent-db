/**
 * mis.bench.ts — independentRootCount (MAX-INDEPENDENT-SET): THE SUSPECTED HOTSPOT.
 *
 * `independentRootCount` runs EXACT Bron–Kerbosch with Tomita pivoting for root sets
 * up to MAX_EXACT_ROOTS (18), then falls back to a bounded greedy maximal set. The
 * exact branch is the only place a clique search can get expensive, and its worst
 * case is a FULLY-INDEPENDENT graph (every pair independent ⇒ one giant clique).
 *
 * We bench at root-set sizes 8, 16, 18 (the exact boundary), 19, 30, 100, in TWO
 * shapes:
 *   - FULLY-INDEPENDENT: the exact-branch worst case. CAPPED at n=18 — never feed the
 *     exact branch a larger fully-independent graph (19/30/100 fully-independent only
 *     exercise the bounded GREEDY fallback, which is what we want to confirm is flat).
 *   - FLEET-COLLAPSED: all roots share one independence class ⇒ edgeless graph ⇒ the
 *     distinct-class clamp short-circuits to 1 (cheap at every size).
 *
 * Expectation the numbers should confirm: exact cost climbs steeply approaching n=18;
 * the n>18 greedy fallback (19/30/100) is fast and roughly flat; fleet-collapsed is
 * cheap everywhere.
 */

import { bench, describe } from "vitest";

import { MAX_EXACT_ROOTS } from "../index.js";
import type { ProvenanceRoot } from "../index.js";

import { collapsedRoots, independentRoots, makeIdentity } from "./fixtures.js";

// One identity layer (null-source roots short-circuit before any anchor lookup, so the
// stub anchor registry is never consulted — this isolates the clique recursion).
const { identity } = makeIdentity();

const SIZES = [8, 16, 18, 19, 30, 100] as const;

// --- EXACT-branch worst case: fully-independent, CAPPED at the exact boundary -----
describe("MIS · fully-independent (EXACT Bron–Kerbosch worst case)", () => {
  for (const n of SIZES) {
    if (n > MAX_EXACT_ROOTS) {
      // n>18 fully-independent goes to the GREEDY fallback, NOT the exact clique search
      // — safe to bench at 19/30/100 (bounded O(n²)); confirms the fallback is flat.
      const roots: ProvenanceRoot[] = independentRoots(n);
      bench(`n=${n} (greedy fallback)`, () => {
        identity.independentRootCount(roots);
      });
    } else {
      // n<=18 exercises the EXACT branch. n=18 is the boundary worst case.
      const roots: ProvenanceRoot[] = independentRoots(n);
      bench(
        `n=${n} (exact)`,
        () => {
          identity.independentRootCount(roots);
        },
        // Bound the n=18 exact worst case so it can never run away.
        n >= 18 ? { time: 600 } : undefined,
      );
    }
  }
});

// --- FLEET-COLLAPSED: edgeless "independent" graph (count clamps to 1) -------------
describe("MIS · fleet-collapsed (single class ⇒ clamp to 1)", () => {
  for (const n of SIZES) {
    const roots: ProvenanceRoot[] = collapsedRoots(n);
    bench(`n=${n}`, () => {
      identity.independentRootCount(roots);
    });
  }
});
