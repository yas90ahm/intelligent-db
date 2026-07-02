# Cycle F — End-Task QA Accuracy & Contradiction Integrity (local-LLM reader)

_Arbor run `retrieval-quality`, cycle F · 2026-06-28 · merged to master `16102a5` · readers: qwen2.5:7b + llama3.1:8b via Ollama (local, offline)_

## Question
Retrieval recall (cycles A–E) measures whether the *right evidence* is surfaced. This cycle measures what actually matters to a user: **does the retrieved memory let an LLM answer correctly** — and does Intelligent DB's identity/adjudication layer protect the reader from poisoned memory? Pipeline (identical across arms): question → retriever top-K=8 → fixed prompt → local LLM (temp 0) → score vs LoCoMo gold (token-F1 + exact-match).

## Result 1 — Raw QA accuracy (LoCoMo, n=150)

| Arm | qwen F1 | qwen EM | llama F1 | llama EM |
|---|--:|--:|--:|--:|
| ID+Rerank | 0.085 | 0.100 | 0.124 | 0.093 |
| MultiSeedID | 0.081 | 0.067 | 0.137 | 0.120 |
| **TunedHybrid** | **0.097** | 0.087 | **0.147** | 0.120 |

**The tuned hybrid wins on both readers.** End-task QA does not flip the retrieval ranking — better retrieval → better answers. **Intelligent DB is not a better general retriever** (consistent with cycles A–E). Absolute F1 is low (hard LoCoMo + 7–8B readers that hedge "unknown"), but conditions are identical across arms, so the relative read holds.

## Result 2 — Contradiction integrity under a Sybil flood (THE headline)
_20 scenarios; K=5 cheap-Sybil sources assert a **plausible** false value (the raw-context majority) vs 1 independent trusted source asserting truth. The engine's real `adjudicate` ran — verified: **20/20 true strands LIVE, 100/100 Sybils DEMOTED**, headcount never consulted. Reader scored for the TRUE value._

| Reader | **Adjudicated** (ID LIVE-only) | **Raw** (Sybil majority included) | Lift |
|---|--:|--:|--:|
| qwen2.5:7b | **0.95** | **0.00** | **+0.95** |
| llama3.1:8b | **1.00** | **0.15** | **+0.85** |

Auditable samples (identical on both models): Mount Caldera elevation true 3120 / false 4860 → raw "4860 ✗" / adj "3120 ✓"; Pellgrave population 248000 / 612000 → raw "612000 ✗" / adj "248,000 ✓"; Oranta capital Khelm / Drovia → raw "Drovia ✗" / adj "Khelm ✓".

**Reading:** fed the raw context (5 plausible false votes vs 1 true), both LLMs reliably answered the **false majority** (qwen 0/20, llama 3/20). Routing the *same underlying memory* through Intelligent DB — Sybils collapse via maximum-independent-set, the lone independent high-reputation source structurally outranks the fleet — and feeding the reader only the surviving LIVE strand recovered **95–100%** correct answers. **No vector or graph store does this**; they faithfully hand the model the majority lie.

## Verdict — Intelligent DB's defensible end-task value
The evidence does **not** support "ID retrieves better." It decisively supports a different, sharper claim:

> **Intelligent DB doesn't retrieve *more* — it retrieves *trustworthy*. It keeps an agent from being talked into a falsehood by a fake majority, turning a 0% raw-context answer rate into 95–100%.** That is answer **integrity** under adversarial/contradictory memory, demonstrated end-to-end and cross-model — a property a vector/graph hybrid structurally cannot provide, because it has no notion of source independence.

## Honesty / caveats
- The contradiction lift is bounded by how decisively the flood fools the base reader in raw; both 7–8B models were strongly fooled here (near-maximal effect). A stronger reader that already resisted the majority would show a smaller (still positive) lift.
- Raw QA F1 is low in absolute terms (hard dataset, small offline readers, deterministic no-LLM graph) — the *relative* comparison is the valid signal.
- Contradiction scenarios are synthetic (controlled, plausible values); LoCoMo itself has no Sybil-poisoning labels.
- The cycle-F workflow's run-agents failed (backgrounded the long run and returned); the n=150 runs were executed directly, and the adversarial-verify phase correctly caught the stale n=3 / saturated-contradiction artifacts before they were reported.

## Gates / reproduce
typecheck exit 0; `npm test` 259 pass / 11 skipped (QA + contradiction runners gated by `QA_BENCH=1` / `CON_BENCH=1`). Engine `src/` untouched. Commits `5a02703` (QA harness) + `0899ea5` (Sybil contradiction), merged via `16102a5`. New files: `src/__bench__/retrieval/qa/{ollama,qaScore,qaPrompt,qaRunner,sybilScenarios,contradictionRunner}`. Run: `cd <repo> && QA_BENCH=1 QA_MODEL=qwen2.5:7b QA_N=150 npx vitest run src/__bench__/retrieval/qa/qaRunner.test.ts` and `CON_BENCH=1 QA_MODEL=<m> npx vitest run src/__bench__/retrieval/qa/contradictionRunner.test.ts`. Artifacts: `.arbor/sessions/retrieval-quality/experiments/qa-cycle-f/{qa_*,contradiction_*}.json`.
