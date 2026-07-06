# BENCHMARK_NARRATIVE.md — the complete story, one document

This pulls together every benchmark result on disk into one narrative: what the poisoning
defense buys, what it costs on ordinary days, and what the crash-torture suite found. It does
not re-run anything that already has a clean number — it cites the artifact and the exact
command next to every figure. Two runs were executed fresh for this pass (marked **[NEW]**);
everything else is a pointer into `BENCH_RERUN_2026-07-06.md`, `docs/ARCHITECTURE_BENCHMARKS.md`,
or a `.arbor/sessions/**` artifact that already exists. Dated 2026-07-06.

Scope note: "substrate" below means the real IntelligentDB engine end-to-end (writeFact →
adjudicate → recall), not a bench reimplementation. "bare" = no memory. "rag" = flat cosine
top-K, no provenance. "mem0" = the mem0 framework (its own embedder + vector store, local
Ollama-backed in every run here, no OpenAI dependency). "hybrid" = IntelligentDB's in-repo
RRF-fused graph+vector arm.

---

## 1. The poisoning moat

The claim under test: a store with no notion of *who* asserted a fact, and whether two
assertions are *independent*, loses to whoever floods the most near-duplicate claims. A
store that prices independence and requires provenance before belief does not.

### 1.1 Twelve-way cross-store comparison

Workload: N=5,000 facts written, 250 recalls (median latency), a 24-trial cheap-Sybil attack
(H=3 honest sources in distinct independence classes, A cheap Sybil sources sharing one
class, A ∈ {5, 50, 200}, 8 trials each).

| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes/fact (disk) |
|---|---:|---:|---:|---:|
| node:sqlite (builtin) | 540,716 | 0.009 | 0/24 | 69.2 |
| better-sqlite3 | 470,983 | 0.009 | 0/24 | 69.2 |
| lmdb | 4,412 | 0.008 | 0/24 | 52.4 |
| duckdb | 47,568 | 1.360 | 0/24 | 107.3 |
| vector-bruteforce (in-proc) | 5,284,854 | 1.124 | 0/24 | n/a (in-memory) |
| faiss-node (IndexFlatL2) | 70,380 | 0.147 | 0/24 | n/a (in-memory) |
| hnswlib-node (HierarchicalNSW) | 8,501 | 0.118 | 0/24 | 418.7 |
| Qdrant (docker) | 6,304 | 60.505 | 0/24 | 124,205.1 |
| Postgres+pgvector (docker) | 23,171 | 1.178 | 0/24 | 1,965.9 |
| Redis-Stack (docker) | 40,347 | 1.232 | 0/24 | 1,627.5 |
| mem0 (mem0ai, Python, local Ollama) | 32 | 74.003 | 0/24 | 8,290.4 |
| **IntelligentDB** | 18,038 | 0.020 | **24/24** | 2,267.6 |

Eleven trust-blind stores score 0/24 — each speaks the Sybil-majority value once A > H,
regardless of whether it's a raw KV store, a production vector DB, or mem0's own
embedder+Qdrant pipeline (mem0 carries no independence model, so it fails the same way as
everything else on this list — it's the slowest arm measured on both axes, not a
special case of the defense). IntelligentDB collapses the cheap fleet to one independent
witness at every fleet size and scores 24/24.

Source: `BENCH_RERUN_2026-07-06.md` §"Day-to-day expansion" / §2 (mem0 row landed
2026-07-06); artifact `.arbor/sessions/cross-db-bench/experiments/1.1/results.md` (+
`metrics.json`). Reproduce: `CROSSDB_BENCH=1 npx vitest run src/__bench__/crossdb/runner.test.ts`.

### 1.2 FactWorld (synthetic closed-book QA, LLM-scored)

n=1,200 questions, 601 poisoned, qwen2.5:7b, exact-match scoring, no LLM judge:

| arm | ASR | accuracy |
|---|---:|---:|
| bare | 0.0% | 0.0% |
| rag | 98.7% | 50.3% |
| mem0 | 78.9% | 60.2% |
| **substrate** | **0.0%** | **99.8%** |

mem0 sits between rag's near-total collapse and substrate's clean defense here — some
internal dedup/ranking in mem0 partially resists FactWorld's dense near-duplicate Sybil
cluster in a way it does not on the PoisonedRAG attack shape below (§1.3). `bare` scores 0%
on both axes because it never reads the corpus at all (closed-book, no retrieval) — that is
a construct-validity floor, not a result.

Source: `BENCH_RERUN_2026-07-06.md` §2/§"Completion addendum"; artifact
`.arbor/sessions/factworld/factworld_qwen2.5_7b.json`. Reproduce: `FACTWORLD_BENCH=1 npx
vitest run src/__bench__/factworld/runner.test.ts`.

### 1.3 PoisonedRAG (real BEIR corpora, the paper's own attack files)

n=100 questions per dataset, qwen2.5:7b, top_k=5/top_n=20:

| Dataset | bare | rag | mem0 | **substrate** |
|---|---:|---:|---:|---:|
| nq — ASR / acc | 4.0% / 50.0% | 93.0% / 22.0% | 96.0% / 22.0% | **6.0% / 86.0%** |
| hotpotqa — ASR / acc | 21.0% / 54.0% | 99.0% / 13.0% | 97.0% / 14.0% | **18.0% / 81–82%** |
| msmarco — ASR / acc | 12.0% / 63.0% | 93–94% / 15–16% | 93.0% / 21.0% | **6–7% / 84–85%** |

mem0 tracks rag's vulnerability on all three of these datasets (unlike FactWorld above) —
its own retrieval carries no provenance model, so a 5-document cheap-Sybil injection beats
it about as badly as naive RAG. substrate is the only arm that stays under 20% ASR on every
row, and hotpotqa is its weakest showing (18% ASR is the highest of the three PoisonedRAG
substrate numbers — see §4).

Source: `BENCH_RERUN_2026-07-06.md` §2, §4.1 ("Late-arriving fact: hotpotqa mem0 arm"),
§"PoisonedRAG msmarco mem0 arm"; artifacts `.arbor/sessions/poisonedrag/poisonedrag_{nq,
hotpotqa,msmarco}_qwen2.5_7b.json` (bare/rag/substrate rows recorded in the BENCH_RERUN log;
the mem0-only re-runs overwrote those files with just the mem0 row — the bare/rag/substrate
numbers are the log-confirmed ones from the original run). Reproduce:
`POISONEDRAG_BENCH=1 PR_DATASET=<nq|hotpotqa|msmarco> npx vitest run
src/__bench__/poisonedrag/runner.test.ts`.

**Non-oracle (label-free) structural defense** — same three datasets, `exclude` mode (no
ground-truth poison labels used at decision time), vs the `rag` floor and the oracle
`substrate` ceiling:

| Dataset | rag ASR | non-oracle exclude ASR | oracle substrate ASR |
|---|---:|---:|---:|
| nq | 93 | **17** | 6 |
| hotpotqa | 99 | **23** | 18 |
| msmarco | 93 | **22** | 7 |

The label-free version doesn't reach the oracle ceiling, but it cuts rag's ASR by roughly
4-5x without ever consulting the gold poison labels. Source: `docs/ARCHITECTURE_BENCHMARKS.md`
§9 (non-oracle table), confirmed unchanged at rebuild in §10.4.

### 1.4 Red-team suite (97 adversarial specs)

| Cycle | total | defended | breached | deferred |
|---|---:|---:|---:|---:|
| 1 | 36 | 6 | 1 | 29 |
| 2 | 36 | 13 | 10 | 13 |
| 3 | 25 | 16 | 7 | 2 |
| **Σ** | **97** | **35** | **18** | **44** |

Baseline history: V1 (crypto era) = 59 breaches, V2 (crypto era, hardened) = 25 breaches, the
crypto-free rebuild above = 18 breaches — every one of the 18 is the same attack, by
mechanism, as its V2 predecessor (zero new breaches). Five of the reduction from 25→18 are
retired attack surface (they targeted the Ed25519/Merkle/staking layer the rebuild deleted —
removed, not defended); two are genuine fixes made during the rebuild pass (a one-hop
weak-influence review gap closed to a transitive BFS; a stale red-team spec updated to route
through the shipped public-suffix resolver). The remaining 18 breaches are documented,
named boundaries — not silent gaps — enumerated in `docs/ARCHITECTURE_BENCHMARKS.md` §10.2:
priced-not-prevented (a patient attacker who pays for real anchors), offline
class-assignment liability, halting's deliberate fail-open, and the theorem boundary
(source-identity independence ≠ content-provenance independence).

Source: `docs/ARCHITECTURE_BENCHMARKS.md` §10.2; confirmed to reproduce byte-identically on
this machine in `BENCH_RERUN_2026-07-06.md` §3. Reproduce: `REDTEAM=1 npx vitest run
src/__bench__/redteam/redteam{,2,3}.test.ts`.

### 1.5 The disclosed boundary: an attacker who pays

This is not "Sybil-proof" — it is "Sybil-priced." The costly-independent boundary (no-LLM
proxy, anchors-only): a single genuinely independent challenger flips nothing (L=1 → 0%
success); at L≥2 disjoint costly anchors the system defers rather than silently holding
(50%); layering reputation on top of anchors moves the flip point to L≥3 (100%). The
Sybil-poisoning capability bench confirms the same shape directly: IntelligentDB stays at 0%
ASR for a CHEAP fleet at every size tested, A ∈ {1,2,3,5,10,50,200,500}, but an honesty
control — a fleet of A distinct, individually PAID anchor classes — does flip the verdict for
A > 3 (DEFER at the A=3 tie), exactly as "priced, not prevented" predicts. This is the
intended degradation curve, published rather than hidden: the achievement is converting an
unbounded free attack into one with a real, rising price, not claiming the price is infinite.

Source: `docs/ARCHITECTURE_BENCHMARKS.md` §9 (costly-independent table) and §10.3 (honesty
control, re-confirmed against the rebuilt engine at every fleet size up to 500). Reproduce:
`COSTLY_INDEPENDENT_BENCH=1 npx vitest run src/__bench__/generalization/costlyIndependent.test.ts`.

---

## 2. Day-to-day (no attacker)

The moat only matters if it doesn't tax ordinary use. This section is every measured
non-adversarial number, including the ones where IntelligentDB is not the best arm.

### 2.1 LoCoMo retrieval quality

Real LoCoMo corpus: 10 conversations, 5,882 turns, 1,981 questions (662 dev / 1,319 test),
`Xenova/all-MiniLM-L6-v2` embeddings. Same-run, TEST split, macro-averaged:

| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid (frozen) | **mem0** |
|---|---:|---:|---:|---:|---:|
| recall@10 | 0.245 | 0.271 | 0.282 | 0.307 | **0.382** |
| recall@20 | 0.272 | 0.272 | 0.324 | 0.375 | **0.484** |
| nDCG@10 | 0.166 | 0.193 | 0.185 | 0.194 | **0.242** |
| MRR | 0.151 | 0.176 | 0.165 | 0.174 | **0.215** |

mem0 wins every ranking metric in this same-run comparison, beating IntelligentDB's own best
(frozen) arm, TunedHybrid, by recall@10 +0.075 and recall@20 +0.109. Per-category, mem0 leads
on single-hop, temporal, open-domain, and adversarial questions, and roughly ties TunedHybrid
on multi-hop (0.112 vs 0.111) — the one category where TunedHybrid's graph-expansion channel
has an edge. This is a genuine loss, reported plainly (see §4).

The **EmbedSeeded arm** (from the Phase-1 spec §5-6 measurement gate) tried replacing
TunedHybrid's simple h-hop BFS graph channel with a real `engine.recall()` activation-walk
seeded via cosine similarity (`createEmbeddingCueResolver`, swept embedSeedK ∈ {8,16,32} and
reinforcement ∈ {dominance, summation}). Best config (embedSeedK=16, summation) on TEST:

| Metric | EmbedSeeded (winner) | mem0 | PureID (same run) | TunedHybrid (same run) |
|---|---:|---:|---:|---:|
| recall@10 | 0.322 | 0.382 | 0.245 | 0.307 |
| recall@20 | 0.366 | **0.484** | 0.272 | 0.375 |
| nDCG@10 | 0.201 | 0.242 | 0.166 | 0.194 |
| MRR | 0.174 | 0.215 | 0.151 | 0.174 |

The gate required recall@20 ≥ 0.484 (matching mem0) and **fell short by 0.118** (0.366 vs
0.484). EmbedSeeded also does not beat this same run's own TunedHybrid (0.366 vs 0.375) —
replacing the graph channel with an embedder-seeded activation walk is net-neutral-to-slightly
-negative on this corpus, not an improvement. `embedSeedK=16` was frozen as the shipped
default anyway (it was already the value in use; this measurement confirms it, K=32 measured
byte-identical, K=8 measurably trails). `reinforcement` stays `dominance` as the global
default — the sweep's nominal per-arm winner was `summation`, by a margin
(recall@10 +0.002) too thin to justify flipping a default that two existing regression tests
pin to `dominance`.

Sources: `BENCH_RERUN_2026-07-06.md` §"Day-to-day expansion" §1 (mem0 arm);
`.arbor/sessions/retrieval-quality/experiments/1.1.1.1.1.mem0/results.md`; the gate report
`C:\Users\...\scratchpad\gates.md` §"Gate 4" (measurement basis for the frozen defaults, also
noted in `src/recall/cueResolver.ts` and `src/core/types.ts` doc comments);
`.arbor/sessions/retrieval-quality/experiments/1.1.1.1.1.embedseeded/results.md`. Reproduce:
`RETRIEVAL_BENCH=1 MEM0_BENCH=1 npx vitest run src/__bench__/retrieval/locomoMem0Runner.test.ts`;
`RETRIEVAL_BENCH=1 npx vitest run src/__bench__/retrieval/locomoEmbedSeededRunner.test.ts`.

### 2.2 Clean (unpoisoned) HotpotQA

The paper's Contriever-msmarco retriever, dot-product ranking, 50,200-row KB with every
poison passage removed (n=100 multi-hop questions, qwen2.5:7b):

| arm | clean accuracy | ASR (no-attacker noise floor) |
|---|---:|---:|
| bare | 54.0% | 21.0% |
| rag | 86.0% | 18.0% |
| substrate (IDB) | 86.0% | 18.0% |
| mem0 | 85.0% | 18.0% |

With no attacker present, substrate's answer accuracy is bit-for-bit identical to rag's
(86.0% vs 86.0%, same 100 questions) — expected, since the contradiction set for every
attribute holds only the correct value, so `adjudicate()` has nothing to resolve and
retrieval degrades to plain cosine top-N→top-K, the same path rag takes. mem0 lands one point
below at 85.0%. There is no retrieval-quality tax for carrying the provenance/trust layer
when there's nothing to adjudicate; all three retrieval-backed arms roughly double bare's
accuracy (54%→85-86%). Cross-referencing the poisoned run on the identical KB: rag's accuracy
craters 86%→11% the instant 5 cheap Sybil documents enter the corpus, while substrate holds
at 86-87% in both regimes.

Sources: `C:\Users\...\scratchpad\clean-hotpotqa.md`,
`C:\Users\...\scratchpad\clean-hotpotqa-nomem0.log` (bare/rag/substrate),
`C:\Users\...\scratchpad\clean-hotpotqa-mem0.log` (mem0, completed 2026-07-06 during this
pass — 1,442.7s / 24 min for a fresh 50,200-item ingest + 100-question inference); artifact
`.arbor/sessions/poisonedrag/contriever_hotpotqa_clean_qwen2.5_7b.json` (each `PR_ARMS`
invocation overwrites this file with only that invocation's rows — the bare/rag/substrate
numbers are log-confirmed from the earlier run, not recoverable from the current file
contents). Reproduce: `PR_CLEAN=1 CONTRIEVER_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=hotpotqa
PR_ARMS=bare,rag,substrate npx vitest run src/__bench__/poisonedrag/contrieverRunner.test.ts`.

### 2.3 LongMemEval — **[NEW]** full oracle subset (all 500 questions)

LongMemEval (Wu et al., ICLR 2025), **oracle** split (500 questions, each with its own
evidence-only haystack — chosen over the 277MB/`_s` and 2.74GB/`_m` full-haystack releases,
which remain future work). Two arms: `idb` (the real engine — activation-walk MultiSeedID
retrieval over a per-question conversation graph, same machinery LoCoMo uses) and `rag` (flat
cosine top-K, no walk, no provenance). Scored two ways: cheap containment/F1, and a local LLM
judge (qwen2.5:7b reproducing the paper's own GPT-4o "is this semantically correct" grading
protocol, since this harness has no paid API dependency).

This pass ran the full 500-question set (`LME_N=500`, up from the prior 60-question
stratified smoke sample), all six question types plus the 30-item abstention subset,
qwen2.5:7b for both generation and judging:

| arm | n | contain% | F1% | judgeAcc% | agree% |
|---|---:|---:|---:|---:|---:|
| idb | 500 | 28.4 | 20.7 | **64.0** | 60.8 |
| rag | 500 | **29.8** | **22.0** | 63.6 | 62.2 |

idb still edges rag on the LLM-judge metric, but the margin **shrinks from +5.0pt at n=60 to
+0.4pt at n=500** — within noise at this scale — while rag's lead on the cheap
containment/F1 proxy is now clearer than at n=60 (-1.4pt contain, -1.3pt F1, vs -1.6pt/-1.6pt
before, i.e. essentially unchanged). Per-question-type judge accuracy at full scale (n=500,
values in parentheses are the prior n=60 numbers for comparison):

| question_type | n | idb | rag | (n=60 idb / rag) |
|---|---:|---:|---:|---|
| single-session-user | 70 | 95.7% | 95.7% | (100.0 / 100.0) |
| multi-session | 133 | 41.4% | **46.6%** | (43.8 / 37.5 — **reversed at scale**) |
| knowledge-update | 78 | **66.7%** | 61.5% | (90.0 / 60.0) |
| single-session-preference | 30 | 46.7% | 46.7% | (50.0 / 50.0) |
| temporal-reasoning | 133 | **59.4%** | 54.9% | (40.0 / 46.7 — **reversed at scale**) |
| single-session-assistant | 56 | 94.6% | 96.4% | (85.7 / 85.7) |
| abstention (correctly says "insufficient evidence") | 30 | **100.0%** | 90.0% | (100.0 / 100.0) |

Two categories **reverse direction** between the n=60 smoke sample and the full n=500 run
(multi-session and temporal-reasoning both flip which arm leads) — a direct demonstration
that the earlier n=60 per-category breakdown was not a stable signal, only the full run is.
idb's advantages that do hold up at scale: knowledge-update (+5.2pt) and abstaining correctly
when the evidence is genuinely insufficient (+10.0pt, the multi-hop graph structure earns
its keep on "don't answer" questions specifically). idb's real losses at scale: multi-session
(-5.2pt) and the cheap containment/F1 proxy overall (rag ahead on both).

Source: `.arbor/sessions/longmemeval/results.json` (this run, 2026-07-06, 988.1s wall-clock);
prior n=60 run preserved at `.arbor/sessions/longmemeval/results.n60.backup.json`. Reproduce:
`LME_BENCH=1 LME_N=500 LME_ARMS=idb,rag npx vitest run
src/__bench__/longmemeval/runner.test.ts --testTimeout=5400000`.

### 2.4 Reasoning — "does memory help?"

Three separate runs at increasing scale exist; none of them show a clean, consistent
"memory helps" or "memory hurts" signal — they mostly show near-parity with `bare`, with the
direction flipping by benchmark and by sample size.

**Full-scale, pre-existing (2026-06-29), poison=0, qwen2.5:7b** (n×samples: math 500×1, gpqa
198×4, coding 164×1, aime 60×16):

| benchmark | bare | rag | substrate | hybrid | mem0 |
|---|---:|---:|---:|---:|---:|
| math | 52.4% | 52.6% | 52.6% | 52.6% | **53.0%** |
| gpqa | 33.1% | 31.8% | 32.1% | **35.9%** | 29.8% |
| coding | 80.5% | 82.3% | **83.5%** | **83.5%** | 79.9% |
| aime | 6.6% | 5.6% | 6.3% | 5.0% | 1.7% |

At full scale, no arm reliably beats `bare` by a wide margin — math is flat within 0.6pt
across all five arms, coding and gpqa each give one memory arm a real few-point edge, and
aime is where every memory arm (mem0 worst, -4.9pt) underperforms bare. Source:
`.arbor/sessions/reasoning-bench/full_qwen2.5_7b_clean.json`, surfaced in
`C:\Users\...\scratchpad\daily-comparison.md` §1a.

**Overnight multi-model sweep — [NEW, partial]**: launched 2026-07-06 14:47 (3 models ×
3 benchmarks × 5 arms × `REASON_N=50`, `REASON_K=3`, detached process). Checked at the start
of this pass; completed cells folded in below:

| model | benchmark | bare | rag | substrate | hybrid | mem0 |
|---|---|---:|---:|---:|---:|---:|
| qwen2.5:7b | math | 66.0% | 68.0% | 68.0% | 68.0% | 66.0% |
| llama3.1:8b | math | 56.0% | 56.0% | 54.0% | 54.0% | 52.0% |
| gemma3 | math | **84.0%** | 80.0% | 80.0% | 80.0% | 82.0% |
| qwen2.5:7b | gpqa | **42.0%** | **42.0%** | 36.0% | 36.0% | 36.0% |

Every memory arm (substrate, hybrid, and mem0 alike) trails both bare and rag by 6 points on
qwen2.5:7b's gpqa row — a genuine loss, not a tie (see §4). **The sweep did not finish**: the
vitest process exited with `AbortError: This operation was aborted` after 7,200.7s wall-clock
(exactly the 2-hour mark), immediately after the qwen2.5:7b gpqa row above — llama3.1:8b/gemma3
gpqa and all three models' `coding` row were never produced. This coincided with §2.3's
LongMemEval run occupying the same local Ollama server (14:33-16:50), which very plausibly
starved it (llama3.1:8b alone was already 3-6x slower per token than qwen2.5:7b before any
contention); the exact cause was not isolated further, and the sweep was not relaunched for
this pass — the full-scale 2026-06-29 run above already covers all four benchmarks end to
end and is the more complete reference.

Sources: `C:\Users\...\scratchpad\reasoning-full.log`,
`.arbor/sessions/reasoning-bench/results.partial.json` (checkpoint after each completed
benchmark), launch script `C:\Users\...\scratchpad\reasoning-full-launch.ps1`. Reproduce:
`REASON_BENCH=1 REASON_MODELS=qwen2.5:7b,llama3.1:8b,gemma3
REASON_BENCHMARKS=math,gpqa,coding REASON_ARMS=bare,rag,substrate,hybrid,mem0 REASON_N=50
REASON_K=3 npx vitest run src/__bench__/reasoning/runner.test.ts`.

---

## 3. Durability (crash torture)

`src/__torture__/` (spec `docs/specs/PHASE2_DURABILITY_SPEC.md` §4): a child worker loops
randomized compound engine operations (`writeFact`, `writeFactsBatch`, `adjudicate`,
`approve`, `disown`, `ratify`) over a real SQLite/WAL file; the parent SIGKILLs it at a random
5-50ms delay, reopens the same file, and runs a 6-point cross-op invariant checker (structural
`PRAGMA integrity_check`, the audit checksum chain, ledger-vs-reputation reconciliation, and
three graph-shape invariants: no demotion missing its OUTRANKS edge, no approval missing its
demotions, no half-applied disown).

**200/200 cycles completed.** State accumulated to 1,948 strands / 40 demotions / 1 approval
by cycle 200 (a real, growing graph — not 200 isolated tiny databases), under a genuinely
uncontrolled kill each cycle (`SIGKILL`, no unwind, no flush, no atexit; Windows enforces this
regardless of signal name). **Zero structural violations** across all 200 cycles: no demotion
ever lacked its outranking edge, no approval record ever lacked its matching demotions, no
disown sweep was ever half-applied, `integrity_check` and the audit chain both stayed clean
on every reopen. A dedicated torn-write test additionally corrupts the last 48 bytes of a live
WAL file after a real kill and confirms SQLite's own frame-checksum recovery converges to a
clean state.

One **non-crash finding**, reported per instructions to report every finding, fixed or not:
`RECONCILE_DRIFT` fires on every cycle from the first successful `approve()` onward. Root
cause, isolated with a minimal two-write-one-adjudicate-one-approve repro that needs zero
kills: `approve()`'s reputation credit to the winning author bypasses the corroboration-event
ledger that `ratify()` uses, so the reconciliation audit sees earned reputation with no
matching recorded event and calls it drift. This is real, reproduces with no crash involved,
and is a **pre-existing gap in already-shipped undo-engine-hardening code**, not something the
torture suite's SIGKILLing caused. It was not fixed in this pass (`ratification/
pendingLedger.ts`'s crediting logic is adjacent, extensively-tested infrastructure, out of
scope for a durability deliverable) — instead `invariantChecker.ts` exports
`KNOWN_NONCRASH_VIOLATION_KINDS` so `structuralViolations()` can separate "real atomicity
break" (0/200) from this known, named, non-structural gap (200/200, by construction, every
time `approve()` resolves anything).

A harness bug was also found and fixed before the real run: the torture harness's own db open
path never set `PRAGMA journal_mode=WAL`, so an early dry run was silently torturing the
default rollback-journal mode rather than the WAL configuration this project actually ships.
Fixed before the 200-cycle run reported above; the final numbers are entirely under WAL.

Source: `C:\Users\...\scratchpad\torture.md`; harness `src/__torture__/`. Reproduce:
```
npm run torture:build
$env:TORTURE = "1"; $env:CYCLES = "200"; npm run torture
```

---

## 4. Honest losses

Collected in one place, not scattered through the wins above:

1. **LoCoMo retrieval quality: mem0 beats IntelligentDB's own best (frozen) arm on every
   ranking metric.** recall@10 0.382 vs 0.307, recall@20 0.484 vs 0.375, nDCG@10 0.242 vs
   0.194 (§2.1). mem0's cosine-similarity pipeline is a stronger day-to-day retriever on this
   dataset — it also has no defense against the adversarial setting IntelligentDB is built
   for (§1.1, §1.3), but on plain retrieval quality it wins outright.
2. **The EmbedSeeded gate failed.** Required recall@20 ≥ 0.484 to match mem0; measured 0.366,
   a 0.118 shortfall. It also failed to beat this repo's own TunedHybrid arm (0.366 vs 0.375)
   — swapping in an embedder-seeded activation walk for TunedHybrid's simple BFS graph
   channel was net-neutral-to-negative, not an improvement (§2.1).
3. **Reasoning: memory arms underperform on specific benchmarks, both at small and full
   scale.** qwen2.5:7b's gpqa row in the 2026-07-06 sweep has substrate/hybrid/mem0 all six
   points below bare and rag (§2.4). At full scale, mem0 underperforms bare by 4.9 points on
   aime, the largest single gap measured in that table (§2.4).
4. **LongMemEval: idb's lead shrinks to noise at full scale, and rag wins outright on the
   cheap metric.** The n=60 sample showed idb +5.0pt on judge accuracy; at n=500 that's
   +0.4pt. rag leads on containment/F1 at both scales, and two per-category directions
   (multi-session, temporal-reasoning) flip sign between n=60 and n=500 (§2.3).
5. **PoisonedRAG-hotpotqa is substrate's weakest defended row.** 18% ASR is the highest of
   the three PoisonedRAG substrate numbers (nq 6%, msmarco 6-7%) — still far under rag's 99%,
   but not the near-zero FactWorld number (§1.2, §1.3).
6. **`RECONCILE_DRIFT`: a real, reproducible reconcile-audit gap, not a crash bug.** Every
   `approve()`-resolved dispute permanently trips the reconciliation audit for the winner's
   author, because `approve()`'s reputation credit bypasses the corroboration-event ledger
   `ratify()` uses. Reproduces with zero process kills; not fixed in this pass (§3).
7. **The overnight reasoning sweep did not finish.** `coding` was never measured for any of
   the three models, and `gpqa` only for qwen2.5:7b, because the vitest process aborted at
   the 2-hour mark — plausibly starved by this pass's own concurrent LongMemEval run on the
   same local Ollama server (§2.4).
8. **The moat is priced, not absolute, and this is by design, not a caveat to bury.** A
   fleet of genuinely paid, distinct anchor classes flips the verdict past A=3 (§1.5); 18 of
   97 red-team specs remain BREACHED, all documented, named boundaries, not silent gaps
   (§1.4).

---

## Artifact map

| Section | Primary artifact(s) |
|---|---|
| §1.1 crossdb | `.arbor/sessions/cross-db-bench/experiments/1.1/{results.md,metrics.json}` |
| §1.2 FactWorld | `.arbor/sessions/factworld/factworld_qwen2.5_7b.json` |
| §1.3 PoisonedRAG | `.arbor/sessions/poisonedrag/poisonedrag_{nq,hotpotqa,msmarco}_qwen2.5_7b.json`, `BENCH_RERUN_2026-07-06.md` |
| §1.4 red-team | `docs/ARCHITECTURE_BENCHMARKS.md` §10.2 |
| §1.5 costly-independent | `docs/ARCHITECTURE_BENCHMARKS.md` §9, §10.3 |
| §2.1 LoCoMo | `.arbor/sessions/retrieval-quality/experiments/{1.1,1.1.1.1.1,1.1.1.1.1.mem0,1.1.1.1.1.embedseeded}/results.md` |
| §2.2 clean HotpotQA | `.arbor/sessions/poisonedrag/contriever_hotpotqa_clean_qwen2.5_7b.json` + scratchpad logs cited inline |
| §2.3 LongMemEval | `.arbor/sessions/longmemeval/results.json` (this pass), `results.n60.backup.json` (prior) |
| §2.4 reasoning | `.arbor/sessions/reasoning-bench/{full_qwen2.5_7b_clean.json,results.partial.json}` |
| §3 torture | `src/__torture__/`, scratchpad `torture.md` |

Every number above was either measured fresh in this pass (LongMemEval full run, §2.3) or
copied verbatim from an artifact already on disk — none were recomputed or rounded toward a
target.
