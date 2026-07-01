/**
 * generalization/costlyIndependent.runner.test.ts — the COSTLY-INDEPENDENT degradation curve.
 *
 * GATED. A plain `npm test` skips this. To run:
 *
 *   COSTLY_INDEPENDENT_BENCH=1 npx vitest run \
 *     src/__bench__/generalization/costlyIndependent.runner.test.ts
 *
 * Optional env: CI_ITEMS (default 80), CI_SYBIL_K (default 6, max 6), CI_SEED (default 7).
 *
 * It sweeps the poison's independence level L = 1..K for BOTH attacker budgets:
 *   - "anchors-only": the poison buys disjoint independent anchors, earns NO reputation.
 *   - "anchors+rep" : the attacker ALSO buys an earned track record for the poison primary.
 * and prints x = poison independence, y = ID ASR — the clean curve showing ID's defense
 * DEGRADE from ASR ≈ 0 (cheap shared-class Sybil) toward an undefended retriever's ASR as the
 * attacker pays for more genuine independence (and reputation). NO LLM / embeddings — the ASR
 * is read straight from the engine's LIVE state (a deterministic, no-LLM lower bound).
 *
 * It also asserts the curve SHAPE so the file doubles as a regression guard on the boundary:
 *   - anchors-only: defended at L=1 (ASR 0), strictly higher once L ≥ 2 (contamination).
 *   - anchors+rep : monotone non-decreasing, reaching full capture (ASR 1) at high L.
 * RAG is included as a constant reference ceiling (an undefended retriever surfaces the poison
 * at every level — there is no anchor/independence notion to demote it).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { generateCostlyWorld } from "./costlyIndependent.generate.js";
import { measureLevel, MAX_SYBIL_K } from "./costlyIndependent.arm.js";
import type { CIMode, CILevelResult } from "./costlyIndependent.arm.js";

const RUN = process.env["COSTLY_INDEPENDENT_BENCH"] === "1";

const envInt = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};

const ITEMS = envInt("CI_ITEMS", 80);
const SYBIL_K = Math.min(envInt("CI_SYBIL_K", 6), MAX_SYBIL_K);
const SEED = envInt("CI_SEED", 7);
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\generalization";

(RUN ? describe : describe.skip)(
  "COSTLY-INDEPENDENT — ID's priced-not-prevented boundary as an ASR curve",
  () => {
    it(
      "sweeps poison independence L=1..K for both attacker budgets and reports ID ASR",
      () => {
        const world = generateCostlyWorld({ items: ITEMS, seed: SEED });

        const modes: CIMode[] = ["anchors-only", "anchors+rep"];
        const byMode: Record<CIMode, CILevelResult[]> = { "anchors-only": [], "anchors+rep": [] };
        for (const mode of modes) {
          for (let L = 1; L <= SYBIL_K; L++) {
            byMode[mode].push(measureLevel(world, { independenceLevel: L, sybilK: SYBIL_K, mode }));
          }
        }

        // ---- tables ------------------------------------------------------------
        const pct = (x: number): string => (100 * x).toFixed(1).padStart(6);
        for (const mode of modes) {
          const h = `L (poison independence) | surfaced | captured | gold-survives |  ID ASR`;
          // eslint-disable-next-line no-console
          console.log(`\n=== COSTLY-INDEPENDENT  mode=${mode}  (n=${ITEMS}, K=${SYBIL_K}) ===\n${h}\n${"-".repeat(h.length)}`);
          for (const r of byMode[mode]) {
            // eslint-disable-next-line no-console
            console.log(
              `${String(r.independenceLevel).padStart(23)} | ${pct(r.surfacedRate)} | ${pct(r.capturedRate)} | ${pct(r.goldSurvivalRate)} | ${pct(r.asr)}%`,
            );
          }
        }
        // RAG reference: an undefended retriever has no independence notion → poison always
        // surfaces (and its K near-duplicates dominate similarity/headcount) → ASR ≈ 1.0.
        // eslint-disable-next-line no-console
        console.log(`\n[ref] RAG (no defense): ID-style ASR ceiling ≈ 100.0% at every L (poison always retrievable).`);

        // ---- write -------------------------------------------------------------
        mkdirSync(OUT_DIR, { recursive: true });
        const outPath = join(OUT_DIR, "costlyIndependent.json");
        writeFileSync(
          outPath,
          JSON.stringify(
            { config: { items: ITEMS, sybilK: SYBIL_K, seed: SEED }, ragReferenceAsr: 1.0, byMode },
            null,
            2,
          ),
        );
        // eslint-disable-next-line no-console
        console.log(`\n[ci] wrote ${outPath}`);

        // ---- assert the boundary SHAPE (regression guard) ---------------------
        const ao = byMode["anchors-only"];
        const ar = byMode["anchors+rep"];

        // anchors-only: cheap shared-class Sybil (L=1) is DEFENDED (ASR 0); paying for genuine
        // independence (L≥2) lifts the ASR strictly above the L=1 baseline.
        expect(ao[0]!.independenceLevel).toBe(1);
        expect(ao[0]!.asr).toBe(0);
        for (let i = 1; i < ao.length; i++) expect(ao[i]!.asr).toBeGreaterThan(ao[0]!.asr);

        // anchors+rep: ASR is monotone non-decreasing in L and reaches FULL CAPTURE at the top
        // (the attacker who pays for BOTH independence and reputation overturns the truth).
        for (let i = 1; i < ar.length; i++) expect(ar[i]!.asr).toBeGreaterThanOrEqual(ar[i - 1]!.asr);
        expect(ar[ar.length - 1]!.capturedRate).toBe(1);
        expect(ar[ar.length - 1]!.asr).toBe(1);

        // and buying reputation is never WEAKER than anchors alone at the same level.
        for (let i = 0; i < ao.length; i++) expect(ar[i]!.asr).toBeGreaterThanOrEqual(ao[i]!.asr);
      },
      600_000,
    );
  },
);
