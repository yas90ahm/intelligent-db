/**
 * __bench__/redteam/redteam.test.ts — CYCLE-1 SYBIL RED-TEAM RUNNER (gated REDTEAM=1).
 *
 * Registered ONLY when REDTEAM=1, so a plain `npm test` never loads it (the runner is
 * `describe.skip` otherwise and the 259-test suite is unaffected). Run with:
 *
 *   REDTEAM=1 npx vitest run src/__bench__/redteam/redteam.test.ts
 *
 * For each of the ~36 designed Sybil attacks it materializes REAL engine state, runs the
 * REAL engine verbs, classifies the OUTCOME from real fact_state / adjudication kind, and
 * writes the cycle-1 results.json the designers consume. Nothing is hardcoded: every
 * classification is read back out of the engine.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { ATTACKS } from "./attacks.js";
import type { Attack, AttackResult, Outcome } from "./attacks.js";

const RUN = process.env["REDTEAM"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\sybil-redteam\\cycle1";

(RUN ? describe : describe.skip)("SYBIL RED-TEAM — real-engine attack harness (cycle 1)", () => {
  it(
    "runs every designed Sybil attack against the REAL engine and classifies from real state",
    () => {
      const rows: Array<{
        name: string;
        tier: string;
        novelty: string;
        outcome: Outcome;
        mechanism: string;
        evidence: string;
      }> = [];

      for (const attack of ATTACKS as Attack[]) {
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
          tier: attack.tier,
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
        cycle: 1,
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
      expect(total).toBe(ATTACKS.length);

      // eslint-disable-next-line no-console
      console.log(
        `[redteam] total=${total} defended=${defended} breached=${breached} ` +
          `deferred=${deferred} na=${na} -> ${outPath}`,
      );
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(`[redteam]   ${r.outcome.padEnd(8)} ${r.tier.padEnd(18)} ${r.name}`);
      }
      for (const r of rows.filter((x) => x.outcome === "BREACHED" || x.outcome === "DEFERRED")) {
        // eslint-disable-next-line no-console
        console.log(`[redteam] ${r.outcome}: ${r.name}\n    mech: ${r.mechanism}\n    ev:   ${r.evidence}`);
      }
    },
    600_000,
  );
});
