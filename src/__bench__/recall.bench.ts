/**
 * recall.bench.ts — RECALL / activationWalk latency vs WEB SIZE.
 *
 * The share-normalized best-first walk is the read hot path. We bench a FIXED walk
 * (one seed, DEFAULT_WALK_CONFIG, a real halting controller) over webs of ~100, ~1k,
 * ~10k strands to show how recall scales with web size. Reported as ops/sec on the
 * fixed walk: because the walk fires each strand at most once and the controller's
 * pop-cap (~2000) backstops it, the per-call cost should saturate rather than grow
 * linearly past the cap — exactly the scaling the bench surfaces.
 *
 * Each walk attaches a fresh per-traversal register, so the same pre-seeded web is
 * reused across iterations (the walk mutates nothing persistent).
 */

import { bench, describe } from "vitest";

import {
  DEFAULT_WALK_CONFIG,
  activationWalk,
  createHaltingController,
} from "../index.js";
import type { EntityId, StrandStore, StrandId, WalkSeed } from "../index.js";

import { buildWeb } from "./fixtures.js";

const SIZES = [100, 1_000, 10_000] as const;

interface Built {
  readonly store: StrandStore;
  readonly seeds: WalkSeed[];
}

const webs = new Map<number, Built>();
for (const size of SIZES) {
  const w = buildWeb(size, (`ent:recall:${size}` as EntityId));
  webs.set(size, { store: w.store, seeds: [{ strandId: w.seedId as StrandId, energy: 1 }] });
}

for (const size of SIZES) {
  describe(`RECALL · activationWalk over ~${size} strands`, () => {
    const built = webs.get(size)!;
    bench("walk", () => {
      const halting = createHaltingController(DEFAULT_WALK_CONFIG);
      activationWalk(built.store, [...built.seeds], DEFAULT_WALK_CONFIG, halting);
    });
  });
}
