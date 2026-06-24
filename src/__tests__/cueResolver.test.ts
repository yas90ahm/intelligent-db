/**
 * cueResolver.test.ts — the CUE→SEED step (the entry point that makes recall work
 * from a fuzzy English question, not just an exact entity name).
 *
 * Asserts: (1) remember several plain-English facts, recall by a FUZZY cue, and the
 * RIGHT facts come back lit + cited; (2) the activation walk actually SPREAD — a
 * sibling fact the cue did NOT directly token-match still lights up via the
 * shared-entity thread; (3) ranking by match strength; (4) the exact-entity boost.
 */

import { describe, it, expect } from "vitest";

import { createAgentMemory, createLexicalCueResolver, createMemoryStore } from "../index.js";
import type { EntityId } from "../index.js";

describe("cue resolver: ask in English → relevant grounded facts", () => {
  it("recalls the RIGHT facts from a fuzzy cue and cites them", () => {
    const mem = createAgentMemory();
    mem.remember({ text: "Berlin is the capital of Germany", entity: "berlin" });
    mem.remember({ text: "Paris is the capital of France", entity: "paris" });
    mem.remember({ text: "The Rhine is a river in Germany", entity: "rhine" });

    const { facts } = mem.recall("which city is the capital of Germany?");

    // The Berlin fact (shares 'capital' + 'germany') is the strongest match and must
    // lead. The Rhine fact (shares 'germany') is unrelated to a capital but lexically
    // weaker; Paris (shares only 'capital') ranks below Berlin — honest lexical
    // behavior, recovered by ranking, not by pretending Paris shares no tokens.
    expect(facts.length).toBeGreaterThan(0);
    const texts = facts.map((f) => f.text);
    expect(texts.some((t) => t.includes("Berlin"))).toBe(true);

    // Berlin (2 matched tokens) outranks Paris (1 matched token).
    const berlinRank = facts.findIndex((f) => f.text.includes("Berlin"));
    const parisRank = facts.findIndex((f) => f.text.includes("Paris"));
    expect(berlinRank).toBe(0);
    if (parisRank !== -1) expect(berlinRank).toBeLessThan(parisRank);

    // Every returned fact is cited and grounded in a real source.
    for (const f of facts) {
      expect(f.source).toBeTruthy();
      expect(f.citation).toContain("source ");
      expect(f.activation).toBeGreaterThan(0);
    }

    // The strongest match (Berlin: capital + germany) ranks first.
    expect(facts[0]!.text).toContain("Berlin");
  });

  it("ACTIVATION SPREADS: a sibling not directly token-matched still lights up", () => {
    const mem = createAgentMemory();
    // Two facts about the SAME entity. Only the first token-matches the cue; the
    // second shares NO cue tokens, so it can only light via the shared-entity walk.
    const entity = "berlin";
    mem.remember({ text: "Berlin is the capital of Germany", entity });
    mem.remember({ text: "Population roughly four million inhabitants", entity });

    const { facts } = mem.recall("what is the capital of Germany?");
    const texts = facts.map((f) => f.text);

    // Direct token match.
    expect(texts.some((t) => t.includes("capital of Germany"))).toBe(true);
    // The sibling, reached ONLY by spreading activation across the shared-entity
    // thread (it shares no token with the cue).
    expect(texts.some((t) => t.includes("four million"))).toBe(true);
  });

  it("ranks by match strength: more matched tokens ⇒ higher energy seed", () => {
    const store = createMemoryStore();
    const resolver = createLexicalCueResolver(store);

    // Build strands directly via the facade so they are stored + indexed.
    const mem = createAgentMemory();
    mem.remember({ text: "alpha beta gamma delta", entity: "e1" });
    mem.remember({ text: "alpha only here", entity: "e2" });

    // Resolve a cue against the FACADE's resolver indirectly via recall ranking:
    const { facts } = mem.recall("alpha beta gamma");
    // The 3-token-overlap fact outranks the 1-token-overlap fact.
    expect(facts[0]!.text).toContain("beta gamma");

    void resolver; // (the standalone resolver is exercised in the persistence test)
  });

  it("exact-entity boost seeds at full energy", () => {
    const store = createMemoryStore();
    const resolver = createLexicalCueResolver(store);
    const mem = createAgentMemory();
    // No explicit entity ⇒ the facade derives `entity:<slug>` from the text.
    mem.remember({ text: "the sky is blue" });

    // The facade and the standalone resolver index different stores, so use the
    // facade's Cue path for the entity boost end-to-end. deriveEntity slugs ALL
    // tokens (no stopword drop) → entity:the-sky-is-blue.
    const { facts } = mem.recall({ entities: ["entity:the-sky-is-blue" as EntityId] });
    expect(facts.length).toBe(1);
    expect(facts[0]!.text).toBe("the sky is blue");
    // Exact-entity seed carries full energy 1.0 (the seed itself lights at energy 1).
    expect(facts[0]!.activation).toBeCloseTo(1, 5);

    void resolver;
  });
});
