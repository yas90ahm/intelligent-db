# Intelligent DB vs. Vector DBs / RAG / mem0-style Memory

> Every number in this document is copied from, or directly derivable from,
> [`../ARCHITECTURE_BENCHMARKS.md`](../ARCHITECTURE_BENCHMARKS.md) and
> [`../../CLAUDE.md`](../../CLAUDE.md). Where a comparison point is architectural/qualitative
> rather than a measured benchmark, it is labeled **(architectural claim)** instead of given a
> number. Read [`../INTEGRITY_AUDIT.md`](../INTEGRITY_AUDIT.md) alongside the numbers below —
> it is the project's own adversarial audit of these benchmarks and states plainly where a
> result is **oracle-conditional** (the trust partition — which sources are "gold" vs
> "poison" — is handed to the substrate arm from a ground-truth label, not discovered by it).
> We repeat that caveat here rather than hide it.

## 1. Architectural comparison (qualitative)

| | **Vector DB / flat RAG** | **mem0-style memory** | **Intelligent DB** |
|---|---|---|---|
| Retrieval model | Cosine/ANN top-K over all ingested embeddings | Its own embedder + vector store + text search over all ingested content | Spreading activation over a provenance graph; nothing is retrieved by raw similarity alone |
| Provenance | Not first-class; a passage is a passage | Not first-class (no independence accounting in the sidecar tested) | First-class on every strand: every fact traces to the source(s) that asserted it |
| Echo vs. corroboration | No distinction — near-duplicate content from one source counts as many hits | No distinction | Same-root assertions collapse to one witness (`content_hash` union); corroboration requires *independent* provenance |
| Contradiction handling | None — top-K ranking just returns whatever is most similar, true or not | None — same | Demote-never-delete; contradictions are adjudicated by earned reputation + anchor independence, deferring to a human when the margin isn't decisive |
| Effect of a dense duplicated/poisoned cluster | Wins by density: K near-duplicate passages crowd out the true one **(architectural claim; measured below)** | Same failure mode — no provenance defense **(measured below)** | Collapses to a single low-independence witness and is out-ranked / demoted by the adjudicator **(measured below)** |
| Deletion semantics | Application-defined | Application-defined | Never deletes — downward tier movement to an immortal archive stub; forgetting has fail-closed eviction gates |
| Audit trail | Not inherent to the storage model | Not inherent to the storage model | Append-only SHA-256 checksum-chain ledger: `verifyChain()` names the first tampered record, `chainHead()` exports a checkpoint a rewritten history can't reproduce, and an optional `AppendSink` hook ships every record externally before the local write (attribution asserted, not signed — the disclosed crypto-free trade-off) |
| Identity / Sybil resistance | None — a "source" concept doesn't generally exist at the storage layer | None (tested: no provenance defense in the sidecar) | Source identity is consumed from infrastructure the deployment already trusts (owner, SSO tenant, registered domain via Public Suffix List eTLD+1 collapse, configured systems of record) by a crypto-free trust registry, and independence is priced against those scarce external anchors, not self-declared |
| Runtime dependencies | Varies by product | Varies by product | Zero runtime dependencies (`dependencies: {}`); Node built-ins + SQLite/WAL persistence |
| Maturity | Mature, widely deployed category | Mature framework | Single-process prototype (the full Vitest suite is green — see CLAUDE.md for the current count); actively code-reviewed with findings tracked in `docs/product/ROADMAP.md`; not yet a hosted/multi-tenant service |

## 2. Measured poisoning-resistance results

> **HISTORICAL (pre-rebuild, pending re-run).** Every LLM-scored number in this section
> (FactWorld, PoisonedRAG, mem0 comparisons, non-oracle variants) was measured against the
> crypto-era (V2) system, before the crypto-free rebuild, and requires local LLMs / embedding
> models / a Python sidecar to re-run — see `docs/ARCHITECTURE_BENCHMARKS.md` §9–§10. The
> locally-runnable poisoning arms (FactWorld substrate adjudication, the Sybil-fleet
> capability benchmark) *were* re-measured against the rebuilt tree at **0% attack success**
> (`ARCHITECTURE_BENCHMARKS.md` §10.3).

These are the project's own benchmark numbers (see `ARCHITECTURE_BENCHMARKS.md §2, §9` for
full methodology, confidence intervals, and reproduction commands). All three arms — `rag`
(flat vector top-K, undefended), `mem0` (a real external mem0 sidecar with its own embedder
and vector store), and `substrate` (the actual Intelligent DB engine) — consume the **same
embeddings, questions, prompt template, and reader LLM**; the only variable is how each arm
adjudicates provenance.

### 2.1 FactWorld (synthetic closed-book QA, n_poisoned = 601)

| arm | ASR (poison answered) | accuracy |
|---|---|---|
| bare (no memory) | 0% | 0% |
| rag (flat vector top-K) | 98.7% | 1.3% |
| mem0 | 79.4% | 20.1% |
| **substrate (Intelligent DB)** | **0.0%** | **99.8%** |

### 2.2 PoisonedRAG — faithful reproduction (arXiv:2402.07867 / USENIX Sec 2025), n=100/dataset

| dataset | rag ASR | mem0 ASR | **substrate ASR** | substrate accuracy |
|---|---|---|---|---|
| NQ | 93% | 96% | **6%** | 86% |
| HotpotQA | 99% | 98% | **18%** | 82% |
| MS-MARCO | 93% | 92% | **7%** | 85% |

Wilson 95% confidence intervals on ASR are **disjoint** between `rag` and `substrate` on all
four datasets tested (NQ, HotpotQA, MS-MARCO, FactWorld) — the gap is measured as significant,
not noise (`reports/confidence_intervals.md`).

### 2.3 The oracle caveat, stated plainly

The headline numbers above come from a `substrate` arm that is handed the correct trust
partition (which sources are independent/"gold" vs. a Sybil cluster) from the benchmark's
ground-truth label, exactly as `docs/INTEGRITY_AUDIT.md` documents. That measures *"given a
correct external identity signal, does the engine correctly use it to demote poison?"* — a
fair test of the adjudication mechanism, but not by itself proof the system can *detect*
poison with no external signal at all.

A **label-free, non-oracle** variant closes most of that gap by inferring independence from
candidate-pool text structure alone (near-duplicate clustering of the retrieved passages —
zero ground-truth labels touched in the decision path):

| dataset | rag ASR (no defense) | substrate-nonoracle "exclude" ASR (structural, no label) | substrate ASR (oracle upper bound) |
|---|---|---|---|
| NQ | 93 / 90 (qwen2.5 / qwen3) | **17 / 14** | 6 / 5 |
| HotpotQA | 99 / 97 | **23 / 22** | 18 / 15 |
| MS-MARCO | 93 / 94 | **22 / 22** | 7 / 8 |

The precise two-tier claim (per `ARCHITECTURE_BENCHMARKS.md §1.7, §2.2`): structural
near-duplicate detection alone — no identity oracle — already cuts ASR from 93–99% down to
14–23%; the external Source-Identity Layer closes most of the remaining gap. Both numbers are
reported here deliberately, rather than only the more favorable oracle figure.

### 2.4 The disclosed failure mode — Sybil is priced, not prevented

Intelligent DB does not claim Sybil-proofness. The `costlyIndependent` generalization
benchmark sweeps how many genuinely distinct, disjoint anchor classes an attacker is willing
to *pay for*, and reports the no-LLM ASR proxy read directly from post-adjudication state:

| attacker independence level (L) | anchors-only ASR | anchors + bought reputation ASR |
|---|---|---|
| L=1 (single shared anchor class — cheap Sybil) | 0% (demoted) | 0% (demoted) |
| L=2 (matches the truth's independence depth) | 50% (contaminates — defers, survives alongside truth) | 50% |
| L≥3 (out-depths and out-earns the truth) | rising | 100% (full capture) |

This is presented in the project's own docs as the disclosed boundary of "priced, not
prevented": an attacker who genuinely buys enough independent, disjoint real-world anchors —
and enough earned reputation — eventually wins, exactly as the design's threat model states.
A flat vector DB / RAG arm has no such floor at all: it is at the undefended ASR ceiling
(≈93–99%, per §2.2) at every level, because it has no independence accounting to spend the
attacker's budget against in the first place.

## 3. Where Intelligent DB is *not* the better tool

- **Pure semantic / fuzzy recall.** If the actual requirement is "find me anything roughly
  about X" over a large unstructured corpus with no adversarial concern and no need for
  provenance, a vector DB's nearest-neighbor search is a simpler, more mature, purpose-built
  tool. Intelligent DB's coverage is bound by how well the graph was constructed (the
  "librarian" step), not by walk depth **(architectural claim)** — it complements, rather than
  replaces, a vector-rerank layer for that use case.
- **Multi-tenant / hosted deployments today.** The current implementation is a durable
  single-process prototype (SQLite/WAL, one writer). It does not yet offer the
  cross-process concurrency, encryption-at-rest, or managed-service surface that an
  off-the-shelf hosted vector DB or mem0 deployment provides out of the box. See
  `docs/product/ROADMAP.md` for what closing these gaps would take.
- **Cases with no real adversarial or multi-source-trust concern.** If every fact in memory
  comes from one trusted pipeline with no risk of contradiction or poisoning, the identity
  and adjudication machinery is overhead a flat store doesn't need to pay for.

## 4. Bottom line

Where a memory system's job is to resist being fed confidently-wrong, densely-repeated, or
adversarial content — the failure mode vector-similarity retrieval and undefended external
memory frameworks are measured (above) to be vulnerable to — Intelligent DB's provenance-first,
identity-priced design is measured to collapse that attack close to zero, discloses exactly
where that defense degrades (an attacker who pays for real independence), and keeps a
tamper-evident, demote-never-delete audit trail of every belief it ever held.
