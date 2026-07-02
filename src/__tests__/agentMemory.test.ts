/**
 * agentMemory.test.ts — single-agent ERGONOMICS + persistence.
 *
 * (1) createAgentMemory().remember(...).recall(...) works with ZERO identity
 *     management (no passport, no stamp, no seeds, no manual provenance).
 * (2) With a dbPath, memory PERSISTS across close() + reopen, and the cue resolver
 *     rebuilds its index from the store so recall still works after reopen.
 * (3) REGRESSION (Phase-3 review finding): recall's CitedFact carries fact_state,
 *     so a quarantined (PROVISIONAL) low-trust fact is DISTINGUISHABLE from a
 *     believed (LIVE) one at the consumption boundary — the facade must never
 *     hand an agent an unverified claim that looks identical to a verified one.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import { createAgentMemory, createSqliteStore, FactState } from "../index.js";
import type { Strand } from "../index.js";

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

describe("agent memory: recall exposes fact_state (quarantine visible at the consumption boundary)", () => {
  it("labels a quarantined low-trust fact PROVISIONAL, the owner's LIVE, and flips the label after an independent ratify", () => {
    const mem = createAgentMemory();

    // The owner's own fact: OWNER (0.90) clears the ingest gate ⇒ LIVE.
    mem.remember({
      text: "Acme revenue is 2 billion",
      entity: "acme",
      attribute: "revenue",
    });

    // An UNVERIFIED publisher (PUBLISHER_UNVERIFIED, 0.04 < 0.10 gate) files a
    // competing claim through the facade's multi-source path ⇒ quarantined.
    const publisher = mem.trust.registerPublisher("https://sketchy-claims.example/post/1");
    const { id: quarantinedId } = mem.remember({
      text: "Acme revenue is 9 billion",
      entity: "acme",
      attribute: "revenue-rumor",
      source: { sourceId: publisher.sourceId },
    });

    // THE REGRESSION: both facts light (superpositions are shown BY DESIGN), but
    // the caller must be able to TELL THEM APART — CitedFact.fact_state.
    const first = mem.recall("what is Acme revenue?");
    const owned = first.facts.find((f) => f.text.includes("2 billion"));
    const rumor = first.facts.find((f) => f.text.includes("9 billion"));
    expect(owned).toBeDefined();
    expect(rumor).toBeDefined();
    expect(owned!.fact_state).toBe(FactState.LIVE);
    expect(rumor!.fact_state).toBe(FactState.PROVISIONAL); // labeled, never laundered

    // Quarantine-exit: the OWNER (anchor-independent of the publisher) ratifies
    // ⇒ PROVISIONAL → LIVE, and recall's label follows the promotion.
    mem.ratify(quarantinedId);
    const second = mem.recall("what is Acme revenue?");
    const promoted = second.facts.find((f) => f.text.includes("9 billion"));
    expect(promoted).toBeDefined();
    expect(promoted!.fact_state).toBe(FactState.LIVE);

    mem.close();
  });
});

describe("agent memory: RememberInput.origin threads trust + causal origin through the facade", () => {
  it("origin 'web' lands PROVISIONAL (quarantined publisher); omitted origin stays LIVE (regression pin)", () => {
    const mem = createAgentMemory();

    // Omitted origin: owner-stamped, bit-for-bit today's behavior ⇒ LIVE.
    mem.remember({ text: "Saturn has rings", entity: "saturn" });

    // origin 'web': filed under the page's UNVERIFIED publisher — the facade
    // finally routes non-user content through the existing quarantine gate
    // instead of stamping everything owner-grade (weight 0.90).
    mem.remember({
      text: "Saturn has exactly one million rings",
      entity: "saturn",
      origin: { kind: "web", resourceId: "https://rumor-mill.example/saturn" },
    });

    const { facts } = mem.recall("tell me about saturn");
    const owned = facts.find((f) => f.text.includes("has rings"));
    const scraped = facts.find((f) => f.text.includes("one million"));
    expect(owned).toBeDefined();
    expect(owned!.fact_state).toBe(FactState.LIVE);
    expect(scraped).toBeDefined();
    expect(scraped!.fact_state).toBe(FactState.PROVISIONAL);
    // The scraped fact is grounded in the PUBLISHER source, not the owner.
    expect(scraped!.source).not.toBe(mem.defaultSourceId);

    mem.close();
  });

  it("origin 'document'/'tool' quarantine under a deterministic per-resource filer; resourceId is required", () => {
    const mem = createAgentMemory();

    mem.remember({
      text: "The Q3 report projects 12% growth",
      entity: "q3-report",
      origin: { kind: "document", resourceId: "doc:q3-report.pdf" },
    });
    mem.remember({
      text: "The calculator returned 42",
      entity: "calc-result",
      origin: { kind: "tool", resourceId: "tool:calculator" },
    });

    const { facts } = mem.recall("what does the Q3 report project?");
    const doc = facts.find((f) => f.text.includes("12% growth"));
    expect(doc).toBeDefined();
    expect(doc!.fact_state).toBe(FactState.PROVISIONAL); // anchorless filer ⇒ quarantined
    expect(doc!.source).not.toBe(mem.defaultSourceId);

    // The requirement is NAMED when the resource id is missing.
    expect(() =>
      mem.remember({ text: "x", origin: { kind: "web" } }),
    ).toThrow(/origin\.resourceId is required/);
    expect(() =>
      mem.remember({ text: "x", origin: { kind: "document" } }),
    ).toThrow(/origin\.resourceId is required/);

    mem.close();
  });

  it("the SAME document filed by two different agents collapses to ONE independence class (and one filer)", () => {
    const dbPath = join(
      tmpdir(),
      `agentmem-origin-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    cleanups.push(() => {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(dbPath + suffix);
        } catch {
          /* ignore */
        }
      }
    });

    const RESOURCE = "doc:shared-brief.pdf";

    // Agent 1 (session 1) files a fact from the document, then goes away.
    const mem1 = createAgentMemory({ dbPath });
    const { id: id1 } = mem1.remember({
      text: "The brief names Lisbon as the venue",
      entity: "venue-brief",
      origin: { kind: "document", resourceId: RESOURCE },
    });
    mem1.close();

    // Agent 2 (a SEPARATE session over the same durable memory) files its own
    // reading of the SAME document.
    const mem2 = createAgentMemory({ dbPath });
    const { id: id2 } = mem2.remember({
      text: "The brief names Lisbon as the venue",
      entity: "venue-brief",
      origin: { kind: "document", resourceId: RESOURCE },
    });
    mem2.close();

    // Inspect the durable strands directly: ONE independence class across both
    // filings (the per-resource DOCUMENT class), so the same page can never be
    // double-counted as fresh corroboration no matter which agent fetched it —
    // and the deterministic filer is the same source in both sessions.
    const store = createSqliteStore(dbPath);
    const s1 = store.getStrand(id1) as Strand;
    const s2 = store.getStrand(id2) as Strand;
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    const classes1 = s1.provenance.map((r) => String(r.independenceClass)).sort();
    const classes2 = s2.provenance.map((r) => String(r.independenceClass)).sort();
    expect(classes1).toEqual(classes2);
    expect(classes1).toHaveLength(1);
    expect(classes1[0]!.startsWith("class:resource:")).toBe(true);
    expect(s1.provenance[0]!.sourceId).toBe(s2.provenance[0]!.sourceId);
    store.close();
  });
});
