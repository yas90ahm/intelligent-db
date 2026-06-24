/**
 * anchors.bench.ts — ANCHOR micro-benches: independenceBetween / repCapFor.
 *
 * These run on the inside of the MIS predicate (independenceBetween is consulted per
 * resolvable pair) and on every stamp/adjudication (repCapFor ceilings reputation), so
 * their per-call cost multiplies through the hot paths. Benched over representative
 * anchor sets: a small disjoint pair, a large self-stacked pair (exercises the
 * noisy-OR + self-stack cap), and a fully-shared (echo) pair.
 */

import { bench, describe } from "vitest";

import { AnchorClass, independenceBetween, repCapFor } from "../index.js";
import type { AnchorBinding } from "../index.js";

function binding(c: AnchorClass, weight: number, cost = weight): AnchorBinding {
  return { anchorClass: c, realizedCost: cost, independenceWeight: weight };
}

// A small, genuinely disjoint pair (DOMAIN vs ORGANIZATION).
const A_SMALL: AnchorBinding[] = [binding(AnchorClass.DOMAIN, 0.35)];
const B_SMALL: AnchorBinding[] = [binding(AnchorClass.ORGANIZATION, 0.75)];

// A self-stacked side: 10 EMAIL anchors (exercises combineSublinear + applySelfStackCap).
const A_STACK: AnchorBinding[] = Array.from({ length: 10 }, () =>
  binding(AnchorClass.EMAIL_OAUTH, 0.1),
);
const B_STACK: AnchorBinding[] = [binding(AnchorClass.VERIFIED_HUMAN, 0.7)];

// A fully-shared echo pair (same single class on both sides ⇒ 0 independence).
const A_ECHO: AnchorBinding[] = [binding(AnchorClass.DOMAIN, 0.35)];
const B_ECHO: AnchorBinding[] = [binding(AnchorClass.DOMAIN, 0.35)];

describe("ANCHORS · independenceBetween", () => {
  bench("small disjoint pair", () => {
    independenceBetween(A_SMALL, B_SMALL);
  });
  bench("10-stack vs single (self-stack cap)", () => {
    independenceBetween(A_STACK, B_STACK);
  });
  bench("echo pair (same class)", () => {
    independenceBetween(A_ECHO, B_ECHO);
  });
});

describe("ANCHORS · repCapFor", () => {
  bench("single anchor", () => {
    repCapFor(B_SMALL);
  });
  bench("10-stack", () => {
    repCapFor(A_STACK);
  });
  bench("empty (bare key)", () => {
    repCapFor([]);
  });
});
