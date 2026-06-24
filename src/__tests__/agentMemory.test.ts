/**
 * agentMemory.test.ts — single-agent ERGONOMICS + persistence.
 *
 * (1) createAgentMemory().remember(...).recall(...) works with ZERO identity
 *     management (no passport, no stamp, no seeds, no manual provenance).
 * (2) With a dbPath, memory PERSISTS across close() + reopen, and the cue resolver
 *     rebuilds its index from the store so recall still works after reopen.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import { createAgentMemory } from "../index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

describe("agent memory: attach and use (zero identity management)", () => {
  it("remembers and recalls with no identity wiring at all", () => {
    const mem = createAgentMemory();

    const { id } = mem.remember({
      text: "Ada Lovelace wrote the first algorithm",
      entity: "ada",
    });
    expect(id).toBeTruthy();

    const { facts, halt } = mem.recall("who wrote the first algorithm?");

    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.text).toContain("Ada Lovelace");
    // Grounded in the auto-provisioned default source — the caller never touched it.
    expect(facts[0]!.source).toBe(mem.defaultSourceId);
    expect(facts[0]!.citation).toContain("source ");
    // Never a silent stop.
    expect(halt.reason).toBeTruthy();

    mem.close();
  });

  it("derives a recallable entity when none is given", () => {
    const mem = createAgentMemory();
    mem.remember({ text: "Mount Everest is the tallest mountain" });
    const { facts } = mem.recall("what is the tallest mountain?");
    expect(facts.some((f) => f.text.includes("Everest"))).toBe(true);
    mem.close();
  });

  it("PERSISTS across close() + reopen with a dbPath (resolver rebuilds index)", () => {
    const dbPath = join(tmpdir(), `agentmem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanups.push(() => {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(dbPath + suffix);
        } catch {
          /* ignore */
        }
      }
    });

    // Session 1: write + close.
    const mem1 = createAgentMemory({ dbPath });
    mem1.remember({ text: "The Eiffel Tower is in Paris", entity: "eiffel" });
    mem1.remember({ text: "It was completed in 1889", entity: "eiffel" });
    mem1.close();

    // Session 2: reopen the SAME file. The resolver rebuilds its inverted index from
    // store.allStrands() on construction, so a fuzzy recall works after the reopen.
    const mem2 = createAgentMemory({ dbPath });
    const { facts } = mem2.recall("where is the Eiffel Tower?");

    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.text.includes("Eiffel Tower"))).toBe(true);
    // The sibling fact about the same entity also surfaces via spreading activation.
    expect(facts.some((f) => f.text.includes("1889"))).toBe(true);

    mem2.close();
  });
});
