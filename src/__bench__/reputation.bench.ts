/**
 * reputation.bench.ts — BETA(α,β) reputation: ratify / contradict + LCB scoreOf.
 *
 * Benches the pure update rules (applyRatification / applyContradiction / lcbReadout)
 * and the live ledger's ratify/contradict + scoreOf. scoreOf is benched in two clock
 * regimes:
 *   - SYNCHRONOUS (Δt ≈ 0): the decay-on-read is a no-op on the mass — the common hot
 *     read.
 *   - DORMANT (clock advanced past the 90-day window): the decay-on-read actually
 *     re-decays a copy of the state on every read — the worst case for a read.
 */

import { bench, describe } from "vitest";

import {
  DEFAULT_REPUTATION_PARAMS,
  applyContradiction,
  applyRatification,
  createReputationLedger,
  lcbReadout,
  newReputationState,
} from "../index.js";
import type { EpochMs, ReputationState, SourceId, Unit } from "../index.js";

import { DAY_MS, NOW } from "./fixtures.js";

const CAP = 0.6 as Unit; // a DOMAIN-tier rep cap
const SRC = "src:rep" as SourceId;

// A pre-built state with some earned mass (so readout has non-trivial variance math).
let earned: ReputationState = newReputationState(SRC, NOW);
for (let i = 0; i < 5; i++) {
  earned = applyRatification(earned, 0.5, CAP, ((NOW as number) + i * DAY_MS) as EpochMs);
}

describe("REPUTATION · pure update rules", () => {
  bench("applyRatification", () => {
    applyRatification(earned, 0.5, CAP, NOW);
  });
  bench("applyContradiction (4× asymmetric)", () => {
    applyContradiction(earned, 0.5, CAP, NOW);
  });
  bench("lcbReadout (mean − z·sd)", () => {
    lcbReadout(earned, CAP, DEFAULT_REPUTATION_PARAMS);
  });
});

describe("REPUTATION · live ledger ratify/contradict", () => {
  const ledger = createReputationLedger(() => CAP, undefined, () => NOW);
  // Spread sources so each call materializes/decays a distinct entry (no single-key cache).
  let k = 0;
  bench("ratify", () => {
    ledger.ratify((`src:rat:${k++ & 1023}` as SourceId), NOW, 0.5);
  });
  bench("contradict", () => {
    ledger.contradict((`src:con:${k++ & 1023}` as SourceId), NOW, 0.5);
  });
});

describe("REPUTATION · scoreOf (decay-on-read)", () => {
  // Synchronous clock: Δt ≈ 0, decay is a no-op on the mass.
  const syncLedger = createReputationLedger(() => CAP, undefined, () => NOW);
  syncLedger.ratify(SRC, NOW, 0.5);
  bench("scoreOf (synchronous, Δt≈0)", () => {
    syncLedger.scoreOf(SRC);
  });

  // Dormant clock: read happens 180 days after the last write ⇒ real re-decay per read.
  const future = ((NOW as number) + 180 * DAY_MS) as EpochMs;
  const dormantLedger = createReputationLedger(() => CAP, undefined, () => future);
  dormantLedger.ratify(SRC, NOW, 0.5); // earned at NOW, read at NOW+180d
  bench("scoreOf (dormant, past 90-day window)", () => {
    dormantLedger.scoreOf(SRC);
  });
});
