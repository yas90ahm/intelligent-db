/**
 * noVoice.test.ts — "no provenance → no voice" preserved through the facade.
 *
 * Wave-2 audit finding `no-voice-test-bypasses-real-filter` (HIGH, test quality):
 * the prior version of this suite planted an ungrounded strand into a HAND-ROLLED
 * store, called the raw `engine.recall()`, then re-implemented the grounding
 * predicate INLINE (`.filter((s) => s.provenance.some((r) => r.sourceId !== null))`)
 * instead of calling the real filter — which lives in `agent/agentMemory.ts`'s
 * `recall()` (`if (root.sourceId !== null) ...`). A second test called the real
 * `createAgentMemory().recall()` but only ever inserted facts via `remember()`,
 * which always stamps a real source — so no ungrounded strand was ever presented
 * to the real filter either. A regression that deleted or inverted the real
 * filter would have passed both tests.
 *
 * This version drives the REAL `createAgentMemory({ dbPath })` SQLite-backed
 * store end-to-end: `remember()` mints a grounded fact through the real engine;
 * a genuinely ungrounded strand — its only provenance root has `sourceId: null`,
 * something `writeFact` can never produce (it always stamps `stamp.source_id`,
 * non-null by type) — is planted directly into the SAME on-disk file via a
 * second raw `DatabaseSync` connection (WAL mode supports concurrent connections
 * to one file; `migrations.test.ts` already relies on the identical pattern),
 * sharing the grounded fact's `entity` so the walk's real SHARED_ENTITY join
 * (`store.strandsByEntity`) reaches it too — a strand the walk never visits can't
 * prove the filter works, only that it was never exercised. The engine-level
 * `mem.engine.recall()` (pre-filter) proves genuine reachability; the facade's
 * real `mem.recall()` is what the exclusion assertion runs against — no
 * re-derived predicate, no shortcut.
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentMemory, FactOrigin, FactState, Tier } from "../index.js";
import type { Activation, EntityId, Strand } from "../index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

let dbPaths: string[] = [];

afterEach(() => {
  for (const p of dbPaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(p + suffix, { force: true });
    }
  }
});

function freshDbPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-novoice-${tag}-${unique}.db`);
  dbPaths.push(p);
  return p;
}

describe("no provenance → no voice (facade recall never returns ungrounded)", () => {
  it("plants a genuinely ungrounded strand into a REAL createAgentMemory() SQLite store; the real recall() excludes it", () => {
    const path = freshDbPath("real-filter");
    const entity = "entity:berlin" as EntityId;

    const mem = createAgentMemory({ dbPath: path });
    try {
      const { id: groundedId } = mem.remember({
        text: "Berlin is the capital of Germany",
        entity,
      });

      // Reach into the SAME on-disk store via a SECOND raw connection and INSERT
      // a strand the real engine could never mint: its only provenance root's
      // sourceId is null. Same `entity` as the grounded fact so it participates
      // in the real SHARED_ENTITY join.
      const raw = new DatabaseSync(path);
      const at = Date.now();
      const ungrounded: Strand = {
        id: "strand:ungrounded-rumor" as Strand["id"],
        entity,
        attribute: null,
        payload: { text: "Berlin ungrounded rumor with no provenance" },
        content_hash: "hash:ungrounded-rumor" as Strand["content_hash"],
        origin: FactOrigin.OBSERVED,
        fact_state: FactState.LIVE,
        tier: Tier.WARM,
        provenance: [
          {
            rootId: "root:ungrounded" as Strand["provenance"][number]["rootId"],
            independenceClass:
              "class:ungrounded" as Strand["provenance"][number]["independenceClass"],
            sourceId: null,
            establishedAt: at as Strand["provenance"][number]["establishedAt"],
          },
        ],
        outEdges: [],
        inEdges: [],
        outranked_by: null,
        bridge: { earned_bridge_value: 0, far_side_potential: 0 },
        salience: {
          s: 1,
          last_fire_time: at as Strand["salience"]["last_fire_time"],
          lambda: 0.05,
          fire_count: 0,
        },
        description_value: 0,
        observedAt: at as Strand["observedAt"],
        external_reobservation_count: 0,
        contradiction_set: null,
        co_equal_claim_cardinality: 0,
        last_tier_reason: null,
      };
      raw
        .prepare("INSERT INTO strands (id, json, entity, attribute) VALUES (?, ?, ?, ?)")
        .run(String(ungrounded.id), JSON.stringify(ungrounded), String(entity), null);
      raw.close();

      // REACHABILITY SANITY (via the real ENGINE, pre-facade-filter): both
      // strands must actually light in the walk, or the exclusion below would be
      // vacuous — proof the filter was exercised, not merely never challenged.
      const rawResult = mem.engine.recall({
        seeds: [{ strandId: groundedId, energy: 1 as Activation }],
      });
      const litIds = rawResult.lit.map((l) => l.strandId);
      expect(litIds).toContain(groundedId);
      expect(litIds).toContain(ungrounded.id);

      // THE REAL ASSERTION: drive the REAL facade recall (agentMemory.ts's own
      // grounding filter) — no re-derived predicate, no shortcut.
      const { facts } = mem.recall("capital of Germany");

      const groundedFact = facts.find((f) => f.strandId === groundedId);
      expect(groundedFact).toBeDefined();
      expect(groundedFact!.source).toBe(mem.defaultSourceId);

      expect(facts.some((f) => f.strandId === ungrounded.id)).toBe(false);
      for (const f of facts) expect(f.source).toBeTruthy();
    } finally {
      // Close BEFORE afterEach's rmSync — an open handle blocks file deletion on
      // Windows even when an assertion above threw.
      mem.close();
    }
  });

  it("facade recall never surfaces anything but grounded facts through the ordinary remember/recall path", () => {
    // Every fact minted through the public remember() path is grounded by
    // construction (writeFact always stamps a real source) — a lighter
    // complementary check that the ordinary path stays grounded end-to-end.
    const mem = createAgentMemory();
    try {
      mem.remember({ text: "Berlin is the capital of Germany", entity: "berlin" });

      const { facts } = mem.recall("capital of Germany");
      expect(facts.length).toBeGreaterThan(0);
      for (const f of facts) {
        expect(f.source).toBeTruthy();
        expect(f.source).toBe(mem.defaultSourceId);
      }
    } finally {
      mem.close();
    }
  });
});
