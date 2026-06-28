/**
 * retrieval/qa/contradictionRunner.test.ts — CYCLE F: HARDENED SYBIL-FLOOD E2E (gated).
 *
 * Registered ONLY when CON_BENCH=1, so a plain `npm test` never loads the LLM. This is
 * the adversarial replacement for the saturated "1 true + 1 false" contradiction E2E:
 * for each of ~20 (entity, attribute) scenarios, ONE high-trust independent source
 * asserts the TRUE value and K=5 cheap Sybil sources (distinct keys, ONE shared
 * independence class) flood a PLAUSIBLE-FALSE value — so the false value is the MAJORITY
 * of the raw memory set.
 *
 * The scenarios are materialized as REAL engine strands and the REAL adjudication runs
 * (the same `createIdRetriever` → `engine.adjudicate` path the cycle-F runner uses):
 * the engine MUST keep the TRUE strand LIVE and DEMOTE every Sybil (verified below). We
 * then read TWO contexts with the SAME prompt template and score whether the LLM answers
 * the TRUE value (qaScore containment):
 *   - RAW         = ALL K+1 memory texts (false is the majority), deterministic order.
 *   - ADJUDICATED = only the LIVE strands' texts after adjudication (= the true value).
 *
 * Expectation TESTED (not assumed): RAW accuracy LOW (majority-false fools the reader),
 * ADJUDICATED accuracy HIGH. Whatever actually happens is reported.
 *
 *   CON_BENCH=1 QA_MODEL=qwen2.5:7b \
 *     npx vitest run src/__bench__/retrieval/qa/contradictionRunner.test.ts
 *
 * Output: .arbor/sessions/retrieval-quality/experiments/qa-cycle-f/contradiction_<model>.json
 * Determinism: temperature 0, fixed scenario table, index-derived ids, hash-ordered context.
 * Engine src/ UNTOUCHED — purely additive QA-layer code.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { asStrandId, FactState } from "../../../index.js";
import { EMBED_DIM } from "../embed.js";
import { buildGraph } from "../graph.js";
import { createIdRetriever } from "../retrievers.js";
import { buildQaPrompt } from "./qaPrompt.js";
import { scoreAnswer } from "./qaScore.js";
import { ollamaGenerate, ollamaReachable, ollamaHost } from "./ollama.js";
import { buildSybilCorpus, deterministicOrder } from "./sybilScenarios.js";

const RUN = process.env["CON_BENCH"] === "1";
const OUT_DIR =
  "D:\\Intelligent DB\\.arbor\\sessions\\retrieval-quality\\experiments\\qa-cycle-f";

interface Sample {
  readonly entity: string;
  readonly attribute: string;
  readonly trueVal: string;
  readonly falseVal: string;
  readonly rawAnswer: string;
  readonly adjAnswer: string;
  readonly rawCorrect: boolean;
  readonly adjCorrect: boolean;
}

(RUN ? describe : describe.skip)(
  "CONTRADICTION SYBIL-FLOOD E2E — real engine adjudication vs a local LLM reader",
  () => {
    it(
      "keeps the TRUE strand LIVE / demotes the Sybils, then scores adjudicated vs raw reader accuracy",
      async () => {
        // ---- 0) LLM liveness (fail LOUD if blocked) -------------------------
        const model = process.env["QA_MODEL"]?.trim();
        if (!model) throw new Error("QA_MODEL is not set (e.g. QA_MODEL=qwen2.5:7b)");
        if (!(await ollamaReachable())) {
          throw new Error(`Ollama unreachable at ${ollamaHost()} — start it and pull ${model}`);
        }

        // ---- 1) BUILD the Sybil-flood corpus + materialize it in the engine -
        const corpus = buildSybilCorpus();
        const { dataset, scenarios, factText, k } = corpus;
        // No retrieval here (we never call retrieve()), so zero vectors suffice — the
        // graph exists only to satisfy createIdRetriever's signature.
        const zeros = dataset.facts.map(() => new Float32Array(EMBED_DIM));
        const graph = buildGraph(dataset, zeros);
        // The constructor runs the REAL engine.adjudicate over every contradiction
        // attribute (true source pre-earned to a decisive LCB; Sybils start at rep 0).
        const idr = createIdRetriever(graph, dataset);

        // ---- 2) VERIFY the engine REALLY adjudicated -------------------------
        // true LIVE; every Sybil DEMOTED (never deleted). Headcount is never consulted
        // — the lone independent high-rep source outranks the K-strong shared-class fleet.
        let trueLiveCount = 0;
        let sybilDemotedCount = 0;
        let scenariosFullyResolved = 0;
        for (const sc of scenarios) {
          const trueStrand = idr.store.getStrand(asStrandId(sc.trueFactId));
          const trueLive = trueStrand?.fact_state === FactState.LIVE;
          if (trueLive) trueLiveCount += 1;
          let allDemoted = true;
          for (const sid of sc.sybilFactIds) {
            const s = idr.store.getStrand(asStrandId(sid));
            const demoted = s?.fact_state === FactState.DEMOTED;
            if (demoted) sybilDemotedCount += 1;
            else allDemoted = false;
          }
          if (trueLive && allDemoted) scenariosFullyResolved += 1;
        }
        // HARD gate: the construction MUST exercise a real adjudication that keeps every
        // true strand LIVE and demotes every Sybil. If not, the test fails loudly.
        expect(trueLiveCount).toBe(scenarios.length);
        expect(sybilDemotedCount).toBe(scenarios.length * k);
        expect(scenariosFullyResolved).toBe(scenarios.length);

        // ---- 3) READ both contexts per scenario + SCORE ---------------------
        let rawCorrect = 0;
        let adjCorrect = 0;
        const samples: Sample[] = [];
        for (const sc of scenarios) {
          // RAW: ALL K+1 planted texts (false is the majority), deterministic order.
          const allIds = deterministicOrder([sc.trueFactId, ...sc.sybilFactIds]);
          const ctxRaw = allIds.map((id) => factText.get(id)!);
          // ADJUDICATED: only the strands the engine kept LIVE (= the true value).
          const liveIds = deterministicOrder(
            [sc.trueFactId, ...sc.sybilFactIds].filter((id) => {
              const s = idr.store.getStrand(asStrandId(id));
              return s !== null && s.fact_state === FactState.LIVE;
            }),
          );
          const ctxAdj = liveIds.map((id) => factText.get(id)!);

          const rawAnswer = await ollamaGenerate(buildQaPrompt(sc.question, ctxRaw), { model });
          const adjAnswer = await ollamaGenerate(buildQaPrompt(sc.question, ctxAdj), { model });
          const rawOk = scoreAnswer(rawAnswer, sc.trueVal).contains === 1;
          const adjOk = scoreAnswer(adjAnswer, sc.trueVal).contains === 1;
          if (rawOk) rawCorrect += 1;
          if (adjOk) adjCorrect += 1;
          if (samples.length < 5) {
            samples.push({
              entity: sc.subject,
              attribute: sc.attribute,
              trueVal: sc.trueVal,
              falseVal: sc.falseVal,
              rawAnswer,
              adjAnswer,
              rawCorrect: rawOk,
              adjCorrect: adjOk,
            });
          }
        }

        const n = scenarios.length;
        const out = {
          model,
          nScenarios: n,
          K: k,
          adjudicated: { acc: n ? adjCorrect / n : 0, n },
          raw: { acc: n ? rawCorrect / n : 0, n },
          samples,
          meta: {
            cycle: "F (hardened Sybil-flood contradiction E2E)",
            construction:
              "per scenario: 1 TRUE value from one high-trust independent source (distinct class) " +
              `vs ${k} Sybil sources (distinct keys, ONE shared independence class) flooding a ` +
              "plausible-FALSE value (the majority of the raw set).",
            engineVerification:
              "real createIdRetriever→engine.adjudicate; verified true LIVE + every Sybil DEMOTED",
            llmHost: ollamaHost(),
            metric: "fraction where the reader answer CONTAINS the planted-TRUE value (qaScore containment)",
            rawContext: "all K+1 memory texts, deterministic (hash) order",
            adjudicatedContext: "only the LIVE strands' texts after adjudication",
            scoring: "qaScore containment (lowercase, strip punctuation/articles, digit-separator-insensitive)",
            promptTemplate: "fixed grounded-QA template, identical to qaRunner",
            adjudicationFacts: { trueLiveCount, sybilDemotedCount, scenariosFullyResolved },
          },
        };

        mkdirSync(OUT_DIR, { recursive: true });
        const sanitized = model.replace(/[^A-Za-z0-9._-]+/g, "_");
        const outPath = join(OUT_DIR, `contradiction_${sanitized}.json`);
        writeFileSync(outPath, JSON.stringify(out, null, 2));

        expect(existsSync(outPath)).toBe(true);
        // eslint-disable-next-line no-console
        console.log(
          `[con-bench] ${model}: adjudicated acc=${out.adjudicated.acc.toFixed(3)} ` +
            `raw acc=${out.raw.acc.toFixed(3)} (n=${n}, K=${k}) -> ${outPath}`,
        );
      },
      3_600_000,
    );
  },
);
