/**
 * scarLimiterBounded.test.ts — Wave-3 remediation item
 * `scar-limiter-unbounded-and-non-durable`.
 *
 * `IntelligentDbImpl`'s M3 anti-grief per-`(contradictor,target,class)` scar
 * rate-limiter used to be a plain, never-pruned `Map<string, EpochMs>` living
 * for the whole process lifetime — a slow memory leak under sustained
 * disown/contradiction traffic. It is now backed by the exported
 * {@link ScarLimiterStore} (the EXACT class `#admitScar` delegates to — this
 * drives the real production storage, not a re-implementation of its logic):
 * bounded by a hard size cap (oldest-first eviction) and by amortized
 * age-based pruning of entries that can no longer affect a future decision.
 *
 * These tests exercise `ScarLimiterStore` directly (imported from `../api.js`,
 * the same pattern already used by other tests in this suite to reach
 * `api.ts`-local exports without going through the `index.ts` barrel) because
 * the engine's `#scarLimiter` field is a true private class field — invisible
 * from outside `IntelligentDbImpl` even to a test in the same package — so the
 * only way to observe the bounded-storage behavior is through the class that
 * IS the storage.
 */

import { describe, it, expect } from "vitest";

import { ScarLimiterStore } from "../api.js";
import { asEpochMs } from "../index.js";
import type { EpochMs } from "../index.js";

describe("ScarLimiterStore — bounded memory (scar-limiter-unbounded-and-non-durable)", () => {
  it("SIZE CAP: pushing far more distinct keys than maxEntries keeps the store's size capped, never growing unbounded", () => {
    const windowMs = 90 * 86_400_000; // the real 90-day anti-grief window
    const maxEntries = 100;
    const store = new ScarLimiterStore(windowMs, maxEntries);

    // Sustained disown/contradiction activity: 10,000 DISTINCT (contradictor,
    // target,class) triples, all well inside the window (1ms apart), so
    // staleness pruning never fires — only the size cap can bound this.
    for (let i = 0; i < 10_000; i++) {
      store.admit(`pair-${i}`, asEpochMs(i));
    }

    expect(store.size).toBeLessThanOrEqual(maxEntries);
    expect(store.size).toBe(maxEntries); // the cap is exactly enforced, not just "some" bound
  });

  it("SIZE CAP holds throughout a long sustained run, not only at the end", () => {
    const windowMs = 90 * 86_400_000;
    const maxEntries = 50;
    const store = new ScarLimiterStore(windowMs, maxEntries);

    for (let i = 0; i < 5_000; i++) {
      store.admit(`k-${i}`, asEpochMs(i));
      // Spot-check every 500 insertions: the cap must never be exceeded, even
      // transiently, which is what a genuinely bounded (not just eventually
      // bounded) memory footprint requires.
      if (i % 500 === 0) {
        expect(store.size).toBeLessThanOrEqual(maxEntries);
      }
    }
    expect(store.size).toBeLessThanOrEqual(maxEntries);
  });

  it("STALE PRUNE: an entry older than the anti-grief window is actually removed from storage (not just logically ignored)", () => {
    const windowMs = 1_000; // 1s toy window
    const store = new ScarLimiterStore(windowMs, /* maxEntries */ 1_000_000, /* pruneIntervalMs */ 100);

    store.admit("betrayer->victim:classA", asEpochMs(0));
    expect(store.has("betrayer->victim:classA")).toBe(true);
    expect(store.size).toBe(1);

    // Advance well past the window AND past the prune interval, driving enough
    // fresh admissions to trigger the amortized sweep (each admit() checks
    // whether it's time to prune before doing anything else).
    for (let t = 200; t <= 5_000; t += 200) {
      store.admit(`filler-${t}`, asEpochMs(t));
    }

    // The stale entry must be GONE from the underlying storage — this is the
    // "prune entries older than the anti-grief window" requirement, not merely
    // "the decision still comes out right" (which the next test covers
    // separately, since that would hold even with no pruning at all).
    expect(store.has("betrayer->victim:classA")).toBe(false);
  });

  it("bounded growth under REALISTIC sustained activity: a small recurring working set persists while a long tail of one-off pairs ages out", () => {
    const windowMs = 1_000;
    // A generous cap so this test isolates PRUNING specifically (not the size cap).
    const store = new ScarLimiterStore(windowMs, /* maxEntries */ 100_000, /* pruneIntervalMs */ 50);

    // Recurring pairs: a small set of contradictor/target/class triples that
    // keep re-scarring every window — a genuine, ongoing anti-grief working set.
    const RECURRING = 20;
    // One-off pairs: NEW distinct triples every window that never recur — the
    // realistic bulk of disown/contradiction traffic in a long-lived process.
    const ONE_OFF_PER_WINDOW = 40;
    const WINDOWS = 200;

    let t = 0;
    let oneOffCounter = 0;
    for (let w = 0; w < WINDOWS; w++) {
      for (let i = 0; i < RECURRING; i++) {
        store.admit(`recurring-${i}`, asEpochMs(t));
        t += 1;
      }
      for (let i = 0; i < ONE_OFF_PER_WINDOW; i++) {
        store.admit(`one-off-${oneOffCounter++}`, asEpochMs(t));
        t += 1;
      }
      t += windowMs; // advance past the window before the next batch
    }

    // Without pruning this would have accumulated RECURRING + WINDOWS*ONE_OFF_PER_WINDOW
    // = 20 + 200*40 = 8,020 entries that NEVER shrink for the life of the process.
    const naiveUnboundedTotal = RECURRING + WINDOWS * ONE_OFF_PER_WINDOW;
    expect(store.size).toBeLessThan(naiveUnboundedTotal / 10); // orders of magnitude smaller

    // The genuine, still-active working set survived (this window's recurring
    // triples were just admitted).
    expect(store.has("recurring-0")).toBe(true);
    expect(store.has(`recurring-${RECURRING - 1}`)).toBe(true);
    // The very first one-off pair, ~200 windows stale, was swept — this is the
    // "prune entries older than the anti-grief window" behavior in action, not
    // just a small total by coincidence.
    expect(store.has("one-off-0")).toBe(false);
  });

  it("REGRESSION — the admit() decision is unchanged by bounding: repeat inside the window is rejected, after the window it is re-admitted", () => {
    const windowMs = 1_000;
    const store = new ScarLimiterStore(windowMs);
    const key = "a->b:class";

    expect(store.admit(key, asEpochMs(0))).toBe(true); // first arrival: admitted
    expect(store.admit(key, asEpochMs(500))).toBe(false); // inside window: rejected
    expect(store.admit(key, asEpochMs(999))).toBe(false); // still inside: rejected
    expect(store.admit(key, asEpochMs(1_000))).toBe(true); // exactly at the window: re-admitted
    expect(store.admit(key, asEpochMs(1_050))).toBe(false); // freshly re-armed window: rejected again
  });

  it("distinct keys are independent: a flood of unrelated pairs never blocks a genuinely new pair/class from being admitted", () => {
    const windowMs = 90 * 86_400_000;
    const store = new ScarLimiterStore(windowMs, 10); // tiny cap to stress eviction

    for (let i = 0; i < 1_000; i++) store.admit(`noise-${i}`, asEpochMs(i));

    // A brand-new pair/class must still be admittable — the size cap bounds
    // memory, it never starves a fresh legitimate scar from firing.
    const now: EpochMs = asEpochMs(1_000_000);
    expect(store.admit("real-contradictor->real-target:real-class", now)).toBe(true);
  });
});
