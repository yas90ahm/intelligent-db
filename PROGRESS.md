# PROGRESS — Intelligent DB: empirical validation & benchmark suite

_Last updated: 2026-07-01._

This file tracks the empirical-validation effort layered on top of the engine (see `CLAUDE.md`
for the engine itself and `ARCHITECTURE.md` for the design). The thesis under test:

> **Good memory makes a capable LLM more accurate — and specifically resistant to memory
> poisoning — and the defense is free on clean memory.**

Everything here is reproducible, gated behind env flags (so it never runs in CI / `npm test`),
and driven by real local models via Ollama. No result value is hardcoded; all numbers fall out
of live execution. Benchmark inputs/outputs live under `.arbor/` (git-ignored).

---

## 1. Status at a glance

| Area | State |
|---|---|
| Engine (four roadmap pillars) | DONE — see `CLAUDE.md`; 368 tests pass, typecheck green |
| Reasoning benchmarks (MATH/GPQA/HumanEval/AIME) | DONE — memory ≈ neutral (self-contained tasks can't measure memory) |
| **factworld** (memory-dependent QA) | DONE — the benchmark where memory is load-bearing |
| **PoisonedRAG** (real published attack) | DONE — n=100 ×{nq,hotpotqa,msmarco}, + hotpot n=1000 |
| mem0 baseline (external framework) | DONE — Python sidecar + Qdrant |
| Verification battery (CIs, ablation, dual-metric, spot-checks) | DONE |
| Fidelity audit (paper params + Contriever apples-to-apples) | DONE |
| Second model — qwen3:8b (thinking) | DONE — model-agnostic |
| Integrity/hardcoding audit | DONE — one BLOCKER found, now **RESOLVED** |
| **Non-oracle variant** (BLOCKER fix) | DONE — 2026-06-30/07-01 |
| Raw-data transcript capture | DONE — per-question model outputs |
| Commit to git | THIS COMMIT |
| Push to remote | PENDING — no remote / gh / auth configured yet |

---

## 2. The headline results

### 2.1 factworld — synthetic memory-dependent QA (`src/__bench__/factworld/`)
Fictional entities → the answer lives ONLY in injected memory → `bare` (no memory) floors at
chance, so the benchmark actually measures memory (unlike self-contained reasoning tasks).
Poison = a Sybil cluster (K wrong-answer twins sharing ONE anchor class).

qwen2.5:7b, **n=1200 (601 poisoned)**; clean acc ~99.8% for all memory arms. Poisoned subset:

| arm | acc | ASR |
|---|---|---|
| bare | 0% (construct-validity floor, no leakage) | — |
| rag | 1.3% | 98.7% |
| mem0 | 20% | 79% |
| **substrate (ID)** | **99.8%** | **0.0%** |

### 2.2 PoisonedRAG — the real published attack (`src/__bench__/poisonedrag/`)
Zou et al., USENIX Sec 2025 (`sleeepeer/PoisonedRAG`). 100 target Qs ×{nq,hotpotqa,msmarco},
5 crafted poison docs each, ~50k-passage KB (gold from BEIR qrels + 50k negatives + poison).
ASR = incorrect answer is a substring of the reply (their metric).

**Oracle substrate arm** (qwen2.5:7b, n=100): NQ ID 6%ASR/86%acc vs RAG 93/22, mem0 96/21;
HotpotQA ID 18/82 vs RAG 99/11, mem0 98/14; MS-MARCO ID 7/85 vs RAG 93/16, mem0 92/22.
HotpotQA **n=1000**: ID 14.5/55 vs RAG 87/7, mem0 87/8 — holds at scale.

### 2.3 Second model — qwen3:8b (thinking)
Identical pattern (`PR_NUMPREDICT=2048` for the `<think>` block). A thinking model does NOT
resist poison on its own (rag 90–99% ASR — it reasons over poisoned context and still parrots
it); ID + thinking is best. The defense is model-agnostic (it lives at the retrieval/trust
layer, the model is unchanged).

---

## 3. The integrity audit and its resolution (the important part)

`docs/INTEGRITY_AUDIT.md` is an adversarial self-audit of these benchmarks. It found **one
BLOCKER**:

> The oracle substrate arm derives its trust partition (anchor class + reputation) **from the
> ground-truth gold/poison label**. So it measures *"given a correct external identity oracle,
> does the engine USE it?"* — not *"can the engine DETECT the poison?"* The win is
> oracle-conditional. (This is defensible — the project's own hard theorem says identity MUST
> come from outside the graph — but the framing over-claims unless disclosed.)

### The fix — a NON-ORACLE variant (`poisonedrag/nonOracleArm.ts`)
Independence is derived **in-band from candidate-pool text structure**, reading **zero labels**
(`kind`/`value`/`source`/`anchor_class` are touched ONLY inside `if(stats)` measurement blocks,
never in the drop decision).

- **Structural signal** (measured, `nonOracleCalibrate.test.ts`): the 5 poison docs form a
  dense mutual near-duplicate cluster (poison↔poison cosine 0.83–0.89) that the lone gold
  passage does not (gold↔poison 0.56–0.67). A crafted flood is textually self-similar; genuine
  corroboration is diverse.
- **Defense** = the web's own "same-root flood collapses to multiplicity 1", applied at
  retrieval: union-find near-duplicate clustering (τ=0.78 transitive, MIN_ECHO=3 → only a
  genuine multiplicity collapses, never a pair). Two modes: `collapse` (keep 1 best member =
  dedup) and `exclude` (drop the whole ≥3 flood = treat the flood itself as a Sybil signal).

**Result — the honest spectrum (ASR, nq / hotpotqa / msmarco):**

| arm | qwen2.5:7b | qwen3:8b |
|---|---|---|
| rag (no defense) | 93 / 99 / 93 | 90 / 97 / 94 |
| nonoracle-collapse (dedup only) | 69 / 73 / 82 | 58 / 76 / 73 |
| **nonoracle-exclude (structural, NO label)** | **17 / 23 / 22** | **14 / 22 / 22** |
| substrate (oracle upper bound) | 6 / 18 / 6 | 5 / 15 / 8 |

Echo-collapse purity 86–93% (of dropped docs, ~9/10 were truly poison — inferred, never told).
The counts are **byte-identical across the two models** (clustering is structural, not
reader-driven) — itself evidence the arm never consults the label or the model output.

**What this establishes — a defensible two-tier claim:**
1. **Detection is real** — structural echo-collapse alone, with no oracle, cuts ASR from
   93–99% to 14–23% on both a standard and a thinking model.
2. **The identity layer earns the rest** — the oracle arm (5–18%) is the upper bound and also
   restores accuracy; the gap is the value of a real anchor/reputation signal.

**Honest limits** (stated, not hidden): `collapse` (dedup) alone is insufficient — erasing
multiplicity leaves one top-ranked poison copy, and PoisonedRAG poison out-ranks gold, so rank
is the second lever. Accuracy cost of `exclude` (59–75% vs oracle 82–90%) comes from
occasionally excluding a gold passage pulled into a Sybil cluster. Attacker evasion: shrink the
flood below 3 (weakens concentration) or buy genuinely independent, textually-diverse sources —
the "priced, not prevented" boundary charted by `generalization/costlyIndependent`.

---

## 4. Verification & fidelity (all done)
- **Wilson 95% CIs** (`verification/wilsonCI.mjs`, `reports/confidence_intervals.md`) — RAG-vs-ID
  non-overlapping on all four sets.
- **Ablation** (`poisonedrag/ablationRunner.test.ts` + `noTrustArm.ts`) — disabling ONLY the
  trust filter sends ASR 6%→93% (=rag): the trust layer IS the defense (oracle arm).
- **Dual-metric** (`dualMetricRunner.test.ts`) — substring vs LLM-judge, 88–90% agreement.
- **Spot-checks** (`spotcheckNq.test.ts`, `reports/spotcheck_nq.md`) — engine-state: gold #R=2 @
  LCB 0.81 vs poison #R=1 @ 0 → demoted.
- **Fidelity** (`FIDELITY.md`) — paper-param audit + Contriever apples-to-apples ×3
  (`contrieverRunner.test.ts`, `contriever_embed.py`; facebook/contriever-msmarco + dot-product
  ≈ MiniLM → embedder-agnostic).
- **Generalization** (`generalization/`) — costly-independent boundary + multi-session SQLite
  persistence (reopen keeps poison DEMOTED).
- **Coverage** (`COVERAGE.md`) — maps coverage vs other vectors (MPBench, AgentPoison, Sybil
  flooding, multi-session); MPBench/AgentPoison scoped-and-deferred (no public code).

---

## 5. How to reproduce (env-gated; needs Ollama + the prepped KB under `.arbor/`)

```bash
# prep (once): builds .arbor/cache/poisonedrag/pr_<ds>_{kb,questions}.jsonl from BEIR + adv_texts
python src/__bench__/poisonedrag/prep.py            # nq / hotpotqa / msmarco

# oracle poisoning run (4 arms)
POISONEDRAG_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=nq \
  npx vitest run src/__bench__/poisonedrag/runner.test.ts

# NON-ORACLE run (bare, rag, collapse, exclude, oracle) — the honest detection result
NONORACLE_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=nq \
  npx vitest run src/__bench__/poisonedrag/nonOracleRunner.test.ts

# separation calibration (measures the structural signal the non-oracle arm relies on)
CALIBRATE_BENCH=1 npx vitest run src/__bench__/poisonedrag/nonOracleCalibrate.test.ts

# raw-data transcripts (per-question: question, context, model reply, gold/poison, scores)
TRANSCRIPT_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=nq \
  npx vitest run src/__bench__/poisonedrag/transcriptRunner.test.ts

# factworld (memory-dependent QA); ablation; dual-metric — see each file's header for flags.
```

Outputs land in `.arbor/sessions/poisonedrag/*.json` and `.arbor/sessions/transcripts/*.jsonl`.

**Hardware notes:** RTX 5070 Ti (Blackwell sm_120) needs torch 2.11.0+cu128 (GPU venv at
`.arbor/venv-gpu`, used by `contriever_embed.py --device cuda`). mem0 runs CPU in
`.arbor/venv-mem0`. Windows: set `PYTHONUTF8=1` for the sidecar.

---

## 6. Next steps / open items
- **Push to a remote** — no git remote / `gh` / auth is configured yet; the history is local.
- **Fold non-oracle numbers into `docs/ARCHITECTURE_BENCHMARKS.md`** (currently they live in the
  audit + this file + memory).
- **Unify the warm-up ratify constant** (12 in poisonedrag, 8 in reasoning) — audit §4.
- **MPBench / AgentPoison** — reconstruct when public code lands (scoped in `COVERAGE.md`).
- **Tune the non-oracle knobs** (`NONORACLE_TAU`, `NONORACLE_MINECHO`) per threat model; consider
  routing the cluster-derived independence classes through the engine's `independentRootCount`
  for a fully engine-native (rather than retrieval-level) non-oracle path.

---

## 7. Map of the benchmark tree
```
src/__bench__/
  factworld/        synthetic memory-dependent QA (the benchmark that measures memory)
  poisonedrag/      the real PoisonedRAG attack + oracle/non-oracle/ablation/dual-metric/transcripts
    nonOracleArm.ts        <- the BLOCKER fix: label-free structural Sybil defense
    nonOracleRunner.test.ts / nonOracleCalibrate.test.ts
    arms.ts / noTrustArm.ts / runner.test.ts / ablationRunner.test.ts / dualMetricRunner.test.ts
    transcriptRunner.test.ts / spotcheckNq.test.ts / contrieverRunner.test.ts
    prep.py / hotpot1000_prep.py / contriever_embed.py / data.ts / mem0Arm.ts
  reasoning/        MATH/GPQA/HumanEval/AIME harness (shows self-contained tasks can't measure memory)
  generalization/   costlyIndependent (honest failure boundary) + multiSession (SQLite persistence)
  verification/     wilsonCI.mjs
  reports/          confidence_intervals.md, spotcheck_nq.md
  COVERAGE.md / FIDELITY.md / VERIFICATION.md
docs/
  ARCHITECTURE_ENGINE.md / ARCHITECTURE_BENCHMARKS.md   comprehensive architecture
  INTEGRITY_AUDIT.md                                    the self-audit (BLOCKER + RESOLUTION)
  RAW_SAMPLES.md                                        curated raw model outputs
```
