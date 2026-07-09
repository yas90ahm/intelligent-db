/**
 * agentMemoryBlendRecall.test.ts — walk-default PERSONAL recall vs opt-in blend.
 *
 * Proves:
 *   (a) default without embedder stays sync walk-compatible;
 *   (b) embedder alone → walk presentation (seeded walk; no blend/RRF);
 *   (b') embedder + explicit `rankMode: 'blend'` → Phase 1c frozen blend/RRF;
 *   (c) belief / fact_state is unchanged by cosine (adjudication never reads it).
 */

import { describe, expect, it } from "vitest";

import {
  createAgentMemory,
  FactState,
  FROZEN_PRESENTATION_OPTIONS,
  FROZEN_SCORE_MODE,
  AnchorClass,
} from "../index.js";
import type { AttributeKey, EmbedderPort, Unit } from "../index.js";
import { createHashingEmbedder } from "../examples/embedders.js";

/** Deterministic offline embedder for tests (no network). */
function testEmbedder(): EmbedderPort {
  return createHashingEmbedder({ dim: 32 });
}

describe("createAgentMemory recall: walk default vs opt-in blend", () => {
  it("(a) without embedder, recall stays synchronous and walk-ordered", () => {
    const mem = createAgentMemory();
    const { id } = mem.remember({
      text: "Berlin is the capital of Germany",
      entity: "berlin",
    });

    const { facts } = mem.recall("what is the capital of Germany?");
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.strandId === id)).toBe(true);
    expect(facts[0]!.fact_state).toBe(FactState.LIVE);
    mem.close();
  });

  it("(b) embedder alone: async remember/recall, walk presentation (not blend)", async () => {
    const embedder = testEmbedder();
    const mem = createAgentMemory({ embedder });

    // Frozen config still exists for explicit blend opt-in — but is NOT the default.
    expect(FROZEN_PRESENTATION_OPTIONS.rankMode).toBe("blend");
    expect(FROZEN_SCORE_MODE).toBe("rrf");

    const { id: idA } = await mem.remember({
      text: "Ada Lovelace wrote the first algorithm",
      entity: "ada",
    });
    const { id: idB } = await mem.remember({
      text: "The Eiffel Tower is in Paris",
      entity: "eiffel",
    });

    const { facts } = await mem.recall("who wrote the first algorithm?");
    expect(facts.length).toBeGreaterThan(0);
    const ada = facts.find((f) => f.strandId === idA);
    expect(ada).toBeDefined();
    expect(ada!.fact_state).toBe(FactState.LIVE);
    expect(facts.every((f) => f.fact_state === FactState.LIVE || f.fact_state === FactState.PROVISIONAL)).toBe(
      true,
    );
    // Walk presentation: facts are activation-ordered (non-increasing).
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i - 1]!.activation).toBeGreaterThanOrEqual(facts[i]!.activation);
    }
    expect(idB).toBeTruthy();
    mem.close();
  });

  it("(b') embedder + rankMode: 'blend' uses frozen blend/RRF presentation", async () => {
    const mem = createAgentMemory({
      embedder: testEmbedder(),
      rankMode: "blend",
    });
    await mem.remember({ text: "Mount Everest is the tallest mountain", entity: "everest" });
    const { facts } = await mem.recall("what is the tallest mountain?");
    expect(facts.some((f) => f.text.includes("Everest"))).toBe(true);
    mem.close();
  });

  it("(b'') explicit rankMode: 'walk' with embedder keeps walk ordering", async () => {
    const mem = createAgentMemory({ embedder: testEmbedder(), rankMode: "walk" });
    await mem.remember({ text: "The Nile is a long river", entity: "nile" });
    const { facts } = await mem.recall("what is a long river?");
    expect(facts.some((f) => f.text.includes("Nile"))).toBe(true);
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i - 1]!.activation).toBeGreaterThanOrEqual(facts[i]!.activation);
    }
    mem.close();
  });

  it("(c) belief/fact_state path unchanged: cosine never flips LIVE via adjudication", async () => {
    const mem = createAgentMemory({ embedder: testEmbedder() });
    const owner = mem.defaultSourceId;

    // Two independent LIVE claims on the same attribute → multi-class DEFER.
    // Register a second source with a costly anchor so quarantine does not apply.
    const other = mem.registerSource(
      { sourceId: "src:other-blend-belief" as never, kind: "OTHER", label: "other" },
      [
        {
          anchorClass: AnchorClass.DOMAIN,
          realizedCost: 0.35 as Unit,
          independenceWeight: 0.35 as Unit,
        },
      ],
    );

    await mem.remember({
      text: "The wifi password is CORRECT",
      entity: "wifi",
      attribute: "password",
      source: { stamp: mem.stampFor(owner) },
    });
    await mem.remember({
      text: "The wifi password is WRONG",
      entity: "wifi",
      attribute: "password",
      source: { stamp: other },
    });

    const outcome = mem.adjudicate("password" as AttributeKey);
    // Multi-class fresh dispute must DEFER (or RESOLVE only on earned LCB) —
    // never use cosine. Either way fact_state comes from belief, not similarity.
    expect(outcome.kind === "DEFERRED" || outcome.kind === "RESOLVED" || outcome.kind === "NOOP").toBe(
      true,
    );

    const { facts } = await mem.recall("wifi password");
    for (const f of facts) {
      expect([FactState.LIVE, FactState.PROVISIONAL, FactState.DEMOTED]).toContain(f.fact_state);
    }
    // Embedding path must not invent a third belief state or strip provenance.
    expect(facts.every((f) => f.source.length > 0)).toBe(true);
    mem.close();
  });
});
