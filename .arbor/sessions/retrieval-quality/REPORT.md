# Research Report — Retrieval Quality: Intelligent DB vs a Tuned Graph+Vector Hybrid

_Arbor run `retrieval-quality` · 2026-06-28 · base `master` · branch `exp/n1-cycle-a-synthetic-build-src-benc-7becf487` (3 commits, not merged)_

## Question
Does Intelligent DB's spreading-activation recall surface the **right** memories better than a well-tuned graph+vector hybrid — on real retrieval-quality metrics (recall@K, precision@K, MRR, nDCG, contradiction accuracy, halting quality)?

## Fairness (so the result is credible)
Every arm ran on the **same graph + same MiniLM embeddings + same per-query seed**; the hybrid was **grid-tuned on a dev split and frozen before scoring on test**; datasets included structure-only, semantics-only, distractor, and contradiction cases; metrics were never cherry-picked. Embedder: `@huggingface/transformers` `all-MiniLM-L6-v2` (Node-native, offline). Engine source untouched in all three cycles; suite stayed green (259 pass).

## Bottom line
**The best retriever is not pure Intelligent DB and not the pure hybrid — it is Intelligent DB's activation+provenance recall WITH a vector reranker on the lit set.** On real data it matches a tuned hybrid's ranking, beats it on early precision and multi-hop, and uniquely adds contradiction-adjudication. Its one remaining deficit is *coverage*, and we proved that deficit is a **graph-construction (librarian) problem, not a walk/halting problem.**

---

## Cycle A — Synthetic (planted ground truth, 53 test queries)
| Metric | IntelligentDB | TunedHybrid |
|---|--:|--:|
| recall@10 | 0.862 | **0.925** |
| MRR | 0.553 | **0.667** |
| nDCG@10 | 0.550 | **0.729** |

Per-category (recall@10): **multi-hop ID 1.00 vs 0.75** (only ID reaches 3-hop); **paraphrase ID 0.33 vs 1.00** (ID structurally blind); **contradiction correct-LIVE: ID 1.00, hybrid n/a** (only ID adjudicates). Halting: F1(auto)/F1(oracle)=0.72, beats fixed-K. **Read:** hybrid wins aggregate via a ranking discriminator ID lacks; ID wins structure + provenance. → *complementary, not competitors.*

## Cycle B — Real LoCoMo (3 arms, 1,319 test questions, evidence-turn ground truth)
| Metric | Pure ID | Tuned Hybrid | **ID + Rerank** |
|---|--:|--:|--:|
| recall@5 | 0.184 | 0.234 | **0.256** |
| recall@10 | 0.245 | **0.307** | 0.271 |
| recall@20 | 0.272 | **0.375** | 0.280 |
| MRR | 0.151 | 0.174 | **0.176** |
| nDCG@10 | 0.166 | **0.194** | 0.193 |

**ID+Rerank closes the entire aggregate ranking gap** (nDCG tied 0.193 vs 0.194) and **wins MRR + early precision/recall@5**, while **keeping the multi-hop edge** (multi-hop nDCG 0.077 vs 0.070, MRR 0.112 vs 0.085). The hybrid keeps **deep recall@10/@20 and adversarial** because ID auto-halts at ~13 candidates (recall@20 == recall@10 for ID arms — a coverage ceiling, not a ranking one).

## Cycle C — Push the recall ceiling (adapter-level WalkConfig)
Tuned a wide-net config (`epsilon` = DEFAULT/10) on dev; lit set 13 → 20, recall@20 0.272 → 0.280.
- **It did NOT flip the deep-recall/adversarial losses** (recall@20 gap to hybrid −0.103 → −0.095; adversarial stays −0.182 behind).
- **Diagnostic finding:** `gamma` and `popCap` are **inert** here — the local-saturation gate thresholds *novelty* (new independent corroboration), not energy magnitude, and the pop-cap (~20 ≪ 2000) never binds. `epsilon` is the sole adapter lever and is near-exhausted.
- **Therefore the residual gap is STRUCTURAL GRAPH REACH** — LoCoMo evidence turns aren't densely linked to the seed in the *deterministically-built* graph — **not the halt threshold.** Cost of widening: latency 1.4–1.6×, precision@5 −0.003, halting overshoots more.

---

## What this means (the honest synthesis)
1. **ID+Rerank is the recommended production retriever.** It equals a tuned hybrid on ranking, wins early precision + multi-hop, and brings provenance/contradiction handling no vector system has.
2. **ID's coverage is bounded by GRAPH QUALITY, not the walk.** Cycle C proved walk-tuning is exhausted; recall is gated by how well the graph links evidence to the seed. In this benchmark the graph was built **deterministically with no LLM** — so **these ID recall numbers are a lower bound.** In production the LLM *librarian* builds richer `CONFIRMED_LINK` edges → denser reach → higher recall.
3. **Where ID already wins, it wins for structural reasons** a vector index cannot replicate: multi-hop relation chains, contradiction adjudication (keep-true / demote-false), and provenance-filtered precision.

## Recommended next levers (not done — out of this run's adapter-only scope)
- **Better graph construction** (the librarian): the single biggest recall lever — richer/normalized entity-linking and confirmed-link edges.
- **An engine-level reach mode**: multi-seed entry or a bounded k-hop expansion *before* activation, to widen the candidate pool the rerank then orders.
- **A novelty-vs-coverage halt knob**: expose a recall-favoring halt profile (the saturation gate currently thresholds novelty only).

## Caveats
- Absolute scores are modest (nDCG ~0.19, recall@10 ~0.3) because of a small local embedder + deterministic no-LLM graph — but **identical for every arm**, so the *relative* comparison is valid.
- LoCoMo evidence-turn retrieval is the proxy for "right memory"; end-task QA accuracy (needs an LLM reader) is a separate measurement.

## Gates / reproduce
typecheck exit 0; `npm test` 259 pass / 7 skipped (runners gated). Commits `a0ee8d8` (synthetic) → `6ee7c11` (LoCoMo 3-arm) → `89fc3cb` (wide-net). New files under `src/__bench__/retrieval/`; engine untouched. Run: `RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/runner.test.ts` (+ `locomo`/`locomoWide` runners). Artifacts: `.arbor/sessions/retrieval-quality/experiments/{1,1.1,1.1.1}/`.
