/**
 * __bench__/redteam/redteam2.test.ts — CYCLE-2 SYBIL RED-TEAM RUNNER (gated REDTEAM=1).
 *
 * Registered ONLY when REDTEAM=1, so a plain `npm test` never loads it. Run with:
 *
 *   REDTEAM=1 npx vitest run src/__bench__/redteam/redteam2.test.ts
 *
 * Materializes each of the 36 cycle-2 novel-mechanism attacks as REAL engine state,
 * runs the REAL engine verbs, classifies the OUTCOME strictly from real state, and
 * writes the cycle-2 results.json. Nothing is hardcoded.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { CYCLE2_ATTACKS } from "./cycle2.js";
import type { Attack, AttackResult, Outcome } from "./attacks.js";

const RUN = process.env["REDTEAM"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\sybil-redteam\\cycle2";

(RUN ? describe : describe.skip)("SYBIL RED-TEAM — real-engine attack harness (cycle 2)", () => {
  it(
    "runs every cycle-2 novel-mechanism attack against the REAL engine and classifies from real state",
    () => {
      const rows: Array<{
        name: string;
        family: string;
        novelty: string;
        outcome: Outcome;
        mechanism: string;
        evidence: string;
      }> = [];

      for (const attack of CYCLE2_ATTACKS as Attack[]) {
        let res: AttackResult;
        try {
          res = attack.run();
        } catch (err) {
          res = {
            outcome: "N/A",
            mechanism: "harness error",
            evidence: `threw: ${(err as Error).message}`,
          };
        }
        rows.push({
          name: attack.name,
          family: attack.tier,
          novelty: attack.novelty,
          outcome: res.outcome,
          mechanism: res.mechanism,
          evidence: res.evidence,
        });
      }

      const tally = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
      const defended = tally("DEFENDED");
      const breached = tally("BREACHED");
      const deferred = tally("DEFERRED");
      const na = tally("N/A");
      const total = rows.length;

      const out = {
        cycle: 2,
        total,
        defended,
        breached,
        deferred,
        na,
        attacks: rows,
      };

      mkdirSync(OUT_DIR, { recursive: true });
      const outPath = join(OUT_DIR, "results.json");
      writeFileSync(outPath, JSON.stringify(out, null, 2));
      expect(existsSync(outPath)).toBe(true);
      expect(total).toBe(CYCLE2_ATTACKS.length);

      // eslint-disable-next-line no-console
      console.log(
        `[redteam2] total=${total} defended=${defended} breached=${breached} ` +
          `deferred=${deferred} na=${na} -> ${outPath}`,
      );
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(`[redteam2]   ${r.outcome.padEnd(8)} ${r.family.padEnd(22)} ${r.name}`);
      }
      for (const r of rows.filter((x) => x.outcome === "BREACHED" || x.outcome === "DEFERRED")) {
        // eslint-disable-next-line no-console
        console.log(`[redteam2] ${r.outcome}: ${r.name}\n    mech: ${r.mechanism}\n    ev:   ${r.evidence}`);
      }
    },
    600_000,
  );
});
