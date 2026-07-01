/**
 * factworld/substrate.validate.test.ts — de-risk the ID arm's core mechanism.
 *
 * Pure engine logic (no GPU/LLM): build a poisoned FactWorld, ingest into the real
 * Intelligent DB engine via the substrate arm, and assert that after adjudication the ONLY
 * LIVE value for each (entity,attribute) is the CURRENT TRUE value — i.e. the Sybil cluster
 * (one shared anchor class) and the superseded old value are DEMOTED. This is the precondition
 * for ID to beat rag/mem0 on the poison benchmark.
 */

import { describe, it, expect } from "vitest";

import { generateFactWorld } from "./generate.js";
import { substrateArm } from "./arms.js";

describe("factworld substrate arm — adjudication demotes the Sybil cluster", () => {
  it("returns ONLY the true current value as LIVE, even under heavy poison", async () => {
    const world = generateFactWorld({ entities: 5, condition: "poison", poisonRate: 1.0, sybilK: 8, seed: 7 });
    const arm = substrateArm(world.assertions);

    const dummyVec = new Float32Array(0);
    let poisonedChecked = 0;
    for (const q of world.questions) {
      const ctx = await arm.contextFor(q, dummyVec);
      // exactly one believed value, and it is the gold (current true) value.
      expect(ctx.length).toBe(1);
      expect(ctx[0]).toContain(q.gold);
      if (q.poisoned) poisonedChecked += 1;
    }
    // sanity: the poison condition actually poisoned (almost) everything at rate 1.0
    expect(poisonedChecked).toBeGreaterThan(world.questions.length * 0.7);
  });

  it("clean bank: the true value is LIVE and unique", async () => {
    const world = generateFactWorld({ entities: 5, condition: "clean", poisonRate: 0, sybilK: 0, seed: 7 });
    const arm = substrateArm(world.assertions);
    for (const q of world.questions) {
      const ctx = await arm.contextFor(q, new Float32Array(0));
      expect(ctx.length).toBe(1);
      expect(ctx[0]).toContain(q.gold);
    }
  });
});
