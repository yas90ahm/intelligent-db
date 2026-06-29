/**
 * __bench__/redteam/redteam3.test.ts — CYCLE-3 SYBIL RED-TEAM RUNNER (gated REDTEAM=1).
 *
 * Registered ONLY when REDTEAM=1, so a plain `npm test` never loads it. Run with:
 *
 *   REDTEAM=1 npx vitest run src/__bench__/redteam/redteam3.test.ts
 *
 * Materializes each cycle-3 combined/adaptive attack + fix-probe as REAL engine state,
 * runs the REAL engine verbs (and, for fix-probes, SIMULATES the candidate fix at the
 * harness/adapter level reusing the engine's own primitives), classifies the OUTCOME
 * strictly from real post-call state, and writes the cycle-3 results.json with the
 * additive {attacks, fixProbes} shape. Nothing is hardcoded.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { CYCLE3_SPECS } from "./cycle3.js";
import type { Cycle3Result, FixProbeVerdict } from "./cycle3.js";
import type { Outcome } from "./attacks.js";

const RUN = process.env["REDTEAM"] === "1";
const OUT_DIR = "D:\\Intelligent DB\\.arbor\\sessions\\sybil-redteam\\cycle3";

(RUN ? describe : describe.skip)("SYBIL RED-TEAM — real-engine attack harness (cycle 3)", () => {
  it(
    "runs every cycle-3 combined/adaptive attack + fix-probe against the REAL engine and classifies from real state",
    () => {
      const attacks: Array<{
        id: string;
        name: string;
        family: string;
        novelty: string;
        outcome: Outcome;
        mechanism: string;
        evidence: string;
      }> = [];
      const fixProbes: Array<FixProbeVerdict & { specId: string }> = [];

      for (const spec of CYCLE3_SPECS) {
        let res: Cycle3Result;
        try {
          res = spec.run();
        } catch (err) {
          res = {
            outcome: "N/A",
            mechanism: "harness error",
            evidence: `threw: ${(err as Error).message}\n${(err as Error).stack ?? ""}`,
          };
        }
        attacks.push({
          id: spec.id,
          name: spec.name,
          family: spec.tier,
          novelty: spec.novelty,
          outcome: res.outcome,
          mechanism: res.mechanism,
          evidence: res.evidence,
        });
        if (res.fixProbe !== undefined) {
          fixProbes.push({ specId: spec.id, ...res.fixProbe });
        }
      }

      const tally = (o: Outcome): number => attacks.filter((r) => r.outcome === o).length;
      const defended = tally("DEFENDED");
      const breached = tally("BREACHED");
      const deferred = tally("DEFERRED");
      const na = tally("N/A");
      const total = attacks.length;

      const out = {
        cycle: 3,
        total,
        defended,
        breached,
        deferred,
        na,
        attacks,
        fixProbes,
      };

      mkdirSync(OUT_DIR, { recursive: true });
      const outPath = join(OUT_DIR, "results.json");
      writeFileSync(outPath, JSON.stringify(out, null, 2));
      expect(existsSync(outPath)).toBe(true);
      expect(total).toBe(CYCLE3_SPECS.length);

      // eslint-disable-next-line no-console
      console.log(
        `[redteam3] total=${total} defended=${defended} breached=${breached} ` +
          `deferred=${deferred} na=${na} fixProbes=${fixProbes.length} -> ${outPath}`,
      );
      for (const r of attacks) {
        // eslint-disable-next-line no-console
        console.log(`[redteam3]   ${r.outcome.padEnd(8)} ${r.family.padEnd(20)} ${r.id.padEnd(12)} ${r.name}`);
      }
      for (const r of attacks.filter((x) => x.outcome === "N/A")) {
        // eslint-disable-next-line no-console
        console.log(`[redteam3] N/A ${r.id}: ${r.evidence}`);
      }
      for (const fp of fixProbes) {
        // eslint-disable-next-line no-console
        console.log(
          `[redteam3] FIX ${fp.specId.padEnd(12)} ${fp.fixOutcome.padEnd(8)} sim=${fp.simulated} breachToday=${fp.breachesToday} :: ${fp.fix}`,
        );
      }
    },
    600_000,
  );
});
