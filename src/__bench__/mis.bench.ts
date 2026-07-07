/**
 * mis.bench.ts — independentRootCount (MAX-INDEPENDENT-SET): THE SUSPECTED HOTSPOT.
 *
 * `independentRootCount` runs EXACT Bron–Kerbosch with Tomita pivoting for root sets
 * up to MAX_EXACT_ROOTS (18), then falls back to a bounded greedy maximal set. The
 * exact branch is the only place a clique search can get expensive, and its worst
 * case is a FULLY-INDEPENDENT graph (every pair independent ⇒ one giant clique).
 *
 * We bench at root-set sizes 8, 16, 18 (the exact boundary), 19, 30, 100, 500, 1000,
 * 5000 (Wave-3 `mis-greedy-fallback-tail-cost`: realistic tail sizes for the GREEDY
 * fallback, not just the small n=19/30/100 smoke sizes), in TWO shapes:
 *   - FULLY-INDEPENDENT: the exact-branch worst case. CAPPED at n=18 — never feed the
 *     exact branch a larger fully-independent graph (n>18 fully-independent only
 *     exercises the bounded GREEDY fallback, which is what we want to confirm stays
 *     tractable at realistic tail sizes). A fully-independent set is ALSO the
 *     greedy fallback's own worst case (every root becomes its own representative,
 *     so the `representatives.every(...)` scan grows linearly every iteration —
 *     the true O(n²) cost, not merely its average case).
 *   - FLEET-COLLAPSED: all roots share one independence class ⇒ edgeless graph ⇒ the
 *     distinct-class clamp short-circuits to 1 (cheap at every size).
 *
 * Expectation the numbers should confirm: exact cost climbs steeply approaching n=18;
 * the n>18 greedy fallback stays roughly quadratic but tractable through n=5000 (a
 * few ms, not seconds — see MEASURED below); fleet-collapsed is cheap everywhere.
 *
 * MEASURED (2026-07-07, `npx vitest bench --run src/__bench__/mis.bench.ts`, this
 * machine — full output in `w3-engine.md`): the fully-independent GREEDY
 * fallback's MEAN time per call was 0.037ms @ n=100, 0.673ms @ n=500, 2.935ms @
 * n=1000, and 68.72ms @ n=5000 — consistent with the O(n²) shape (500->1000,
 * 2x the size, cost ~4.4x; 1000->5000, 5x the size, cost ~23.4x, close to the
 * 25x an exact quadratic predicts), but with NO cliff: growth is smooth across
 * the whole 100-5000 range, never a discontinuous jump. Even at n=5000 (an
 * unrealistically large single-attribute provenance root-set — corroboration
 * this dense is not a shape the live write path or any shipped benchmark
 * produces) a single `independentRootCount` call is still low-double-digit
 * milliseconds, not a hang or a multi-second stall. CONCLUSION: no cap added —
 * the measurement does not show a real cliff at the sizes this backlog item
 * asked about (500-5000); revisit only if a real deployment's per-attribute
 * root-set count is ever observed anywhere near this range (it would already
 * be an anomaly the eviction gates / quarantine gate should be catching
 * upstream).
 */

import { bench, describe } from "vitest";

import { MAX_EXACT_ROOTS } from "../index.js";
import type { ProvenanceRoot } from "../index.js";

import { collapsedRoots, independentRoots, makeIdentity } from "./fixtures.js";

// One identity layer (null-source roots short-circuit before any anchor lookup, so the
// stub anchor registry is never consulted — this isolates the clique recursion).
const { identity } = makeIdentity();

const SIZES = [8, 16, 18, 19, 30, 100, 500, 1000, 5000] as const;

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
