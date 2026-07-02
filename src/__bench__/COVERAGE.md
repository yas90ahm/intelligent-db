# Attack-Vector Coverage — Intelligent DB Anti-Poisoning Study

This document maps the memory/RAG poisoning threat landscape onto what the Intelligent DB (ID) trust substrate has been **measured** against, the specific ID mechanism that defends each vector, and the **honest scope** of what remains expected-but-unmeasured. All ID numbers are a **no-LLM lower bound**: attack-success rate (ASR) is read directly from the engine's post-adjudication `fact_state`, so a downstream reader/LLM can only do worse than these figures if it ignores `LIVE`/`DEMOTED` state, never better.

## Coverage matrix

| # | Attack vector | Tested? | How (harness, scale, model) | ID defending mechanism | Result / expectation |
|---|---|---|---|---|---|
| 1 | **Knowledge corruption — synthetic (FactWorld)** | ✅ Measured | `factworld` synthetic, n=1200 (601 poisoned), qwen2.5:7b | Independent-root count (`#R`) + decisive-or-defer adjudication: shared-anchor Sybil poison collapses to `#R=1`, loses the reputation/depth contest → `DEMOTED` | ID **0% ASR / 99.8% acc** vs RAG 98.7% ASR / 1.3% acc, mem0 79% ASR / 20% acc |
| 2 | **Knowledge corruption — real corpora (PoisonedRAG black-box)** | ✅ Measured | PoisonedRAG attack on NQ / HotpotQA / MS-MARCO, n=100 each, qwen2.5:7b; 5 corroborating poison passages/question sharing one anchor class (`#R=1`) | Same as #1 — anchor-set disjointness denies the poison cluster independence; one-class flood → demoted | NQ ID **6% / 86%** (RAG 93/22, mem0 96/21); HotpotQA ID **18% / 82%** (RAG 99/11, mem0 98/14); MS-MARCO ID **7% / 85%** (RAG 93/16, mem0 92/22) |
| 2c | **Knowledge corruption — HotpotQA at scale (n=1000)** | 🟡 Harness built, full run pending | `hotpot1000_prep.py` generates KB+questions in the existing runner schema; gold = 2 supporting-facts paragraphs (`#R=2`), poison = 5 model-generated passages sharing one anchor (`#R=1`). Smoke (n=3) verified | Same as #2 | **Expected** to track the n=100 HotpotQA result; **unmeasured at n=1000** until the full run completes |
| 3 | **Sybil flooding (free identities)** | ✅ Measured (within #1/#2) | Poison clusters in FactWorld/PoisonedRAG are Sybil floods sharing one anchor class (K strands, `#R=1`) | "Identity is priced, not prevented": same-source echo-collapse + anchor-set disjointness; a free flood never earns independence or reputation (`α≈0`) | Demoted at L=1 in every harness — the **0% ASR** FactWorld point is the clean Sybil-flood result |
| 4 | **Costly-independent boundary (attacker pays for real anchors)** | ✅ Measured | `costlyIndependent` harness, real engine, n=80, K=6; sweeps poison independence L=1..6 across disjoint real anchor classes; two budgets (anchors-only, anchors+rep) | The deliberate, documented limit of the priced-not-prevented thesis: defense **degrades** as the attacker buys genuine disjoint anchors + earned reputation | anchors-only: L=1 → **0%**, L≥2 → **50%** (DEFER→contamination). anchors+rep: L=1,2 → 50%, L≥3 → **100%** (poison out-depths + out-ranks truth → capture). Monotone rise to the undefended ceiling — the **honest boundary**, not a defense claim |
| 5 | **Multi-session / persistence (does a verdict survive restart?)** | ✅ Measured | `multiSession` harness: SQLite file-backed shared handle; session 1 ingests gold (`#R=2`) + K-Sybil poison (`#R=1`), `adjudicate`→RESOLVED, closes handle (WAL flush); session 2 reopens with a fresh handle, reads `fact_state` only | Atomic compound writes over one shared handle (facts+trust+audit crash-consistent); demote-never-delete persisted; no re-adjudication on reopen | Poison stays **`DEMOTED`**, gold stays **`LIVE`**, `liveValues` = `["Berlin"]` across restart; **stable on second reopen** (no drift) |
| 6 | **MPBench — 6 memory-write attack classes** | ❌ Not tested | — | observed/derived split + provenance gate; agreeing-record classes → Sybil-flood case (#3); contradicting-record classes → decisive-or-defer (#1) | **Not measured.** No public dataset/harness (~1–2 wk reconstruction). Expected-but-unvalidated |
| 7 | **AgentPoison — backdoor/trigger injection** | ❌ Not tested | — | single-source backdoor cluster is `#R=1` → demoted before assembly; trigger optimizes retrieval similarity, which ID does NOT use as a trust signal (retrieval ≠ ratification) | **Not measured.** Needs a trigger/agent execution harness. No measured defense against optimized trigger embeddings. Expected-but-unvalidated |

## ID mechanism → attack mapping (summary)

- **Passport (one stable source id per source)** collapses echoes: two strands from one source id are never corroboration.
- **Anchor-set disjointness + cost table** make independence an external, *priced* property. A flood sharing any anchor class is `#R=1` → loses adjudication. Load-bearing defense for #1–#3.
- **Decisive-or-defer adjudication** (reputation as an external signal, never headcount) resolves only on a decisive *and* earned margin, else defers to the human ratify horn. Defeats the contradiction-bomb and the first-arrival trap.
- **Reputation Beta(α,β)** — earned slowly, lost fast, decay-on-read — makes fresh flood sources loud but weightless.
- **Demote-never-delete + atomic compound writes** make verdicts durable and auditable (#5).

## Honesty notes
- Every "expected" entry is **unmeasured** and flagged as such; only ✅ rows carry numbers.
- The costly-independent curve (#4) is reported as a **failure-mode boundary**, not a defense — ID's ASR rises monotonically to the undefended ceiling as the attacker pays. This is the central honesty of "priced, not prevented" and should be presented as such.
- All ID ASR figures are a **no-LLM engine-state lower bound**; baselines (RAG, mem0) use the same questions/corpora.
