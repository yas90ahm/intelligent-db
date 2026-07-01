/**
 * multiSession.test.ts — TASK B: a DEMOTION persists across process sessions.
 *
 * Gated behind GENERALIZATION_BENCH=1 so a plain `npm test` never runs it. Pure-logic
 * (no LLM): asserts fact_state across a real SQLite file close/reopen.
 *
 *   SESSION 1 — ingest a Sybil poison cluster + a corroborated gold value into a
 *               FILE-BACKED store, pre-earn the primary gold source, adjudicate
 *               (poison → DEMOTED, gold → LIVE), CLOSE the handle.
 *   SESSION 2 — reopen the SAME file with a FRESH handle, re-adjudicate NOTHING, and
 *               verify (a) every poison strand is still DEMOTED and (b) a query returns
 *               ONLY the LIVE gold value.
 *
 * Run: GENERALIZATION_BENCH=1 npx vitest run src/__bench__/generalization/multiSession.test.ts
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactState } from "../../index.js";
import { ingestSession1, openSession2 } from "./multiSession.js";
import type { MultiSessionWorld } from "./multiSession.js";

const RUN = process.env["GENERALIZATION_BENCH"] === "1";

(RUN ? describe : describe.skip)("TASK B — demotion persists across sessions (SQLite reopen)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `id-multisession-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("session 1 demotes the Sybil cluster; session 2 (fresh handle) still sees DEMOTED + only the gold value LIVE", () => {
    // --- SESSION 1: ingest + adjudicate + close ---
    const world: MultiSessionWorld = ingestSession1(dbPath, 8);
    expect(world.poisonStrandIds.length).toBe(8);
    expect(world.goldStrandIds.length).toBe(2);

    // --- SESSION 2: reopen the SAME file, assert across the restart ---
    const s2 = openSession2(dbPath);
    try {
      // (a) every poison strand survived the restart AS DEMOTED (demote-never-delete).
      for (const id of world.poisonStrandIds) {
        expect(s2.factStateOf(id)).toBe(FactState.DEMOTED);
      }

      // The gold co-asserters are still LIVE after the restart.
      for (const id of world.goldStrandIds) {
        expect(s2.factStateOf(id)).toBe(FactState.LIVE);
      }

      // (b) a query returns ONLY the LIVE gold value — the attack stays neutralized with
      //     no re-adjudication in session 2.
      const live = s2.liveValues(world.attrKey);
      expect(live).toEqual([world.goldValue]);
      expect(live).not.toContain(world.poisonValue);
    } finally {
      s2.close();
    }
  });

  it("the persisted demotion is stable across a SECOND reopen (idempotent — no drift)", () => {
    const world = ingestSession1(dbPath, 5);

    // First reopen.
    const a = openSession2(dbPath);
    try {
      expect(a.factStateOf(world.poisonStrandIds[0]!)).toBe(FactState.DEMOTED);
    } finally {
      a.close();
    }

    // Second reopen — state is unchanged; nothing re-ran.
    const b = openSession2(dbPath);
    try {
      for (const id of world.poisonStrandIds) {
        expect(b.factStateOf(id)).toBe(FactState.DEMOTED);
      }
      expect(b.liveValues(world.attrKey)).toEqual([world.goldValue]);
    } finally {
      b.close();
    }
  });
});
