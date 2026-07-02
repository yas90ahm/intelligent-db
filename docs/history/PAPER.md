> **HISTORICAL (pre crypto-free rebuild, superseded 2026-07).** Describes deleted machinery (Ed25519/Merkle/staking);
> the current design is [CLAUDE.md](../../CLAUDE.md) + [docs/ARCHITECTURE_ENGINE.md](../ARCHITECTURE_ENGINE.md).

# Intelligent DB: Trustworthy Memory for AI Agents via External Priced-Identity Adjudication

*A proof-of-concept study, grounded in a five-part audit of the repository (git history, design documents, source code, test suite, and benchmark artifacts) rather than authorial recollection. Single-process TypeScript/Node prototype; benchmarks on commodity hardware (Node 24.16, SQLite/WAL, Dockerised vector DBs, local 7–8B LLM readers via Ollama). Repository genesis 2026-06-24 (`0b7cfcc`); evaluation campaign 2026-06-28 (HEAD `16102a5`).*

---

## Abstract

AI agents fail in two structural ways: they **forget** and they **hallucinate**. The dominant memory substrate — the vector database — addresses neither robustly: it performs fuzzy nearest-neighbour lookup with no notion of *who* asserted a fact, and is defenceless against an adversary who poisons memory with a plausible false majority. We present **Intelligent DB**, a memory substrate built as the deliberate inversion of a vector database: facts are latent and surface only via **spreading activation** along structural threads, and the two quantities a memory cannot honestly compute about itself — **source independence** and **corroboration count** — are read from an **external, cryptographically-priced identity layer**, under the invariant that *the model is never its own witness*. A prior-art audit finds every individual mechanism is established (Sybil-pricing, Beta reputation, Certificate-Transparency logs, spreading-activation retrieval); the contribution is the **synthesis**. A code audit confirms the four pillars are genuinely implemented (Bron–Kerbosch independence count, RFC-6962 Merkle log, Beta-LCB reputation, DERIVATION-graph undo), zero-dependency, with 259 passing tests under a strict type configuration. We evaluate against eight production databases and two LLM readers. The result is two-sided and we report both halves. On **raw retrieval and QA accuracy**, a well-tuned graph+vector hybrid wins — Intelligent DB is *not* a better general retriever. On **trust under adversarial memory**, Intelligent DB is alone: it is the only one of nine systems that resists a Sybil-corroboration attack (24/24 vs 0/24), and end-to-end it lifts an LLM reader's answer accuracy under a poisoned-memory flood from **0–15%** to **95–100%**, on both readers. We argue the defensible value of trust-aware memory is **answer integrity**, not retrieval coverage — and we are explicit that this value is *contingent on a correct external anchor layer*, which the prototype does not itself provide.

---

## 1. Introduction

A long-lived AI agent needs memory, and two failure modes make naïve memory dangerous: **forgetting** (bounded context; a stateless model loses prior sessions) and **hallucination** (models invent facts and cannot tell recall from invention). The de-facto solution — retrieval-augmented generation over a vector database — mitigates forgetting but not hallucination's deeper cause: a vector DB has no spine. It returns nearest neighbours by similarity, with no representation of which facts connect, who asserted them, or whether two corroborating "independent" sources are one adversary. This makes it structurally vulnerable to **memory poisoning**.

This paper asks: *can a memory substrate resist this attack, and at what cost to ordinary retrieval?* We audit and evaluate a prototype, **Intelligent DB**, built to answer it, and report where it wins and where it loses.

**A note on provenance and method.** This paper is deliberately grounded in an audit of the actual repository, not in recollection. The audit covered the git history, the three design documents (`ARCHITECTURE.md`, `CLAUDE.md`, `README.md`), the ~20k LOC of source under `src/`, the 270-test suite, and every benchmark artifact under `.arbor/sessions/`. Where the documents disagree among themselves, or with the code, we report the discrepancy.

---

## 2. Status, Provenance, and a Methodological Caveat

Two facts about the artifact shape every claim below.

**The design predates the repository.** The git history is short and does *not* record the conceptual work. The first commit (`0b7cfcc`, 2026-06-24) is a **squashed genesis of 21,282 insertions across 47 files** that already contained the complete system — all four pillars, both stores, the full ratification suite, and ~205 tests — and a `CLAUDE.md` already declaring it a "production-grade single-process prototype" with the "`TODO(crack-A/B)` stub era … over." The observable history is therefore a 4-day tail: same-day hardening (a real DNS-01 prover `697b116`, the benchmark harness `a38e123`, batch-write APIs `4500c60`, an O(N²) elimination `c4fdcdb`, the agent facade `c599bac`) and then, on 2026-06-28, the entire competitive **evaluation campaign** that this paper reports (cycles A–F, `ca9b74c`→`16102a5`). We make no claim to reconstruct a development arc the repository does not contain.

**The architecture was produced by a multi-agent council.** `ARCHITECTURE.md` states it was "Produced by an architecture council (4 specialist architects + a Sybil/gaming red-teamer + a chief architect)," and `CLAUDE.md` attributes the central impossibility theorem to "a multi-agent adversarial council." The design is, by its own account, the output of an adversarial multi-agent process — relevant context for how its structural-over-policy defences were derived.

**Documentation drift (disclosed).** `README.md` is stale: it still describes the project as a "Scaffold" whose cores "throw or return typed placeholders." The code audit (§5) flatly contradicts this — the cores are implemented. Test counts drift across docs (138 → 205 → an actual **259**). We rely on the code and the test run, not the prose.

---

## 3. The Problem, Precisely

The core difficulty is an **impossibility result**, which `CLAUDE.md` attributes to its adversarial council:

> Under "identity is priced, not prevented" (a patient attacker can pay a finite cost to mint independent-looking sources), there is **no purely internal rule** that both (a) lets one true witness overturn a planted false canonical AND (b) stops two fake sources overturning a true incumbent.

Three attacks are cited as having "no internal repair": the **contradiction-set bomb** (drip 500 plausible claims; denial-of-answer at linear cost), the **first-arrival trap** (any incumbent-protecting threshold protects whoever arrived first), and the absence of a **second independent lock**. The conclusion is a design mandate: a memory can adjudicate *what* a fact is, but not *who* is behind it — identity must be witnessed from **outside**.

---

## 4. Design: The Inversion and the Four Pillars

**Latent memory, activated not queried.** Nothing sits in a readable list. A cue energises a seed strand; activation propagates (`child = parent · (w_edge / Σw_out) · γ`, γ=0.6) until a cluster lights up. Share-normalisation makes spam hubs self-starve; a refractory lock kills echoes; activation is monotone non-increasing, so termination is provable. Threads connect only on **shared entity + confirmed link**; the model is the *librarian* that places a fact, never a witness to its truth.

**Two invariants.** (1) *The model is never its own witness* — "it files and speaks memories; it never confirms them. No provenance → no voice." (2) *The web is never its own witness about source identity* — trust in *what* comes from inside, trust in *who* from outside.

**Four pillars** (the external trust root): **(1) Identity & priced independence** — Ed25519 passports prove sameness; independence is the maximum-independent-set over anchor-set disjointness, cost-weighted, with a sublinear cap. **(2) Provenance & undo** — strands cite their derivations; `disown` runs a BFS taint-closure that demotes (never deletes) and reverses exact reputation. **(3) Earned reputation** — Beta(α,β), independence-weighted, 4× asymmetric, 90-day decay, lower-confidence-bound readout capped at an anchor-derived ceiling. **(4) Tamper-evidence** — append-only hash-chained Ed25519 log, RFC-6962 Merkle tree, Signed Tree Heads, ≥2 witnesses. Contradiction **demotes, never deletes**; derived facts obey a *wall with a window* (speakable, never self-witnessing).

---

## 5. Related Work and Implementation (audited)

**Novelty (prior-art audit).** No individual pillar is novel. Spreading-activation memory traces to ACT-R/SOAR (1980s) and is current in HippoRAG and **SYNAPSE** (arXiv:2601.02744, Jan 2026); "priced, not prevented" plus the impossibility theorem are ~95% **Douceur 2002**; the Beta reputation is **Jøsang & Ismail 2002**; the audit log is ~100% **RFC 6962**; anchor-disjointness is PGP web-of-trust. The one framing not located in the literature is **maximum-independent-set over anchor-disjointness** as the independence count. The contribution is **novel only in synthesis**: no prior system makes an external, priced-identity layer the *adjudication authority* for memory trust with the model and in-graph voting structurally barred from witnessing identity.

**Implementation (code audit, with evidence).** The four pillars are genuinely implemented with the specific algorithms claimed, not stubbed:
- Independence: Bron–Kerbosch with Tomita pivoting over a bitmask adjacency, exact for n ≤ 18 with deterministic greedy fallback (`identity/index.ts:412–496`).
- Reputation: Beta-LCB `min(repCap, mean − z·sd)` with `z = √3` calibrated so the uninformative prior reads **exactly 0**, 90-day decay-on-read, 4× asymmetry, exact credit reversal (`identity/reputation.ts`).
- Undo: backward DERIVATION BFS taint-closure, demote-never-delete via synthetic OUTRANKS sentinel, class-bounded contradiction, false-disown protection (`ratification/disown.ts:508–597`).
- Tamper-evidence: RFC-6962 domain-separated hashing, STH sign/verify, inclusion + consistency proofs, rollback/fork detection (`ratification/merkleLog.ts`).
- Engine: `writeFact`, `writeFactsBatch`, `recall`, `ratify`, `adjudicate`, `disown`, `approve` over a SQLite/WAL store with nestable transactions and atomic compound writes (`api.ts`, `store/sqliteStore.ts`).

The **zero-dependency claim is verified**: `package.json` `dependencies: {}`; only `node:` builtins are imported by the library, and the heavy packages (better-sqlite3, pg, redis, qdrant, transformers) are bench-only devDependencies. Honest blemishes: a stale `@throws … not yet implemented (crack-A)` JSDoc on `activationWalk` that contradicts its own implemented body, and the stale `README`. Documented out-of-scope gaps are real and visible in code: only DOMAIN (DNS-01) and EMAIL binders exist (HARDWARE/KYC/ORG/STAKE are table rows without binders); witness sinks are injected test impls, not live third parties; single-process only; no encryption-at-rest.

**Verification (test audit).** `npm test`: **259 passed, 11 skipped**; `tsc --noEmit` clean under a genuinely strict config. The verification is adversarial, not happy-path — e.g. *"500 same-class corroborations collapse to ONE α"*, *"a bare-key source corroborated 1000× never exceeds ~0.05"*, the Sybil-collapse capability test **and its honesty control** *"DOES flip to an expensive Sybil,"* audit byte-flip detection at the first broken seq, Merkle rollback/fork rejection, demote-never-delete retrievability, and injected-mid-op-crash full rollback. Honest gap: the trust/identity/durability core is rigorously attacked, but the activation-walk and forgetting tiers are covered mainly via the smoke and integration tests, not dedicated adversarial suites.

---

## 6. Evaluation

Methodology and discipline (artifact audit): deterministic seeds; baselines grid-tuned on a dev split and **frozen before scoring on test**; shared graphs and embeddings across compared retrievers; the engine untouched (all harnesses additive); leaky diagnostics explicitly labelled; and the poisoned-context adjudication *verified in-test* (hard asserts on LIVE/DEMOTE counts) before any LLM call. Numbers below are read from the committed artifacts under `.arbor/sessions/`.

### 6.1 Sybil resistance and cost vs eight databases
*N=5000 facts, 250 recalls, 24 attack trials (H=3 honest vs A∈{5,50,200} Sybils).*

| Engine | write_hz | recall_ms | **poison-correct** | bytes/fact |
|---|--:|--:|:--:|--:|
| node:sqlite | 1,006,522 | 0.0057 | **0/24** | 69 |
| better-sqlite3 | 832,515 | 0.0053 | **0/24** | 69 |
| Redis-Stack | 137,032 | 0.650 | 0/24 | 1,631 |
| **IntelligentDB** | **98,911** | **0.0034** | **24/24 ✓** | 2,268 |
| duckdb | 88,264 | 0.907 | 0/24 | 107 |
| Postgres+pgvector | 75,430 | 0.616 | 0/24 | 1,966 |
| Qdrant | 12,216 | 48.05 | 0/24 | 124,205 |
| lmdb | 8,090 | 0.0048 | 0/24 | 52 |

All eight trust-blind stores answer the false majority; only Intelligent DB resists. An honesty control confirms the bound is priced, not absolute (a genuinely-paid distinct-anchor fleet does overturn the truth).

![Figure 1: Sybil-corroboration resistance across nine systems — all eight databases score 0/24, Intelligent DB 24/24.](figures/fig1_sybil_resistance.png) *(Mem0 blocked offline; hnswlib/faiss skipped — no Node-24 prebuilt. The committed `metrics.json` records write_hz 98,911; the prose REPORT cites a post-batching 104,464 — we use the committed figure.)*

### 6.2 Deployment profile (on-disk SQLite/WAL, to 1M strands)
Recall p50 is **1.93→2.08 ms across a 1000× data increase** (lit-set fixed at 77) — recall is O(local web), not O(total memory). Write p50 ~25 µs (p99 ~100–400 µs); cold-start (reopen + first recall) ~4 ms at 1M; concurrent readers scale **4.5× at K=8**; no WAL-checkpoint stalls. A `writeFactsBatch` verb reaches ~100k facts/s, the residual floor being per-fact provenance minting (CPU, not I/O).

![Figure 2: Recall latency stays flat (~2 ms p50) as stored facts grow 1k→1M — recall is O(local web), not O(total memory).](figures/fig2_flat_recall.png)

### 6.3 Retrieval quality (synthetic + LoCoMo)
*Synthetic (53 test queries):* recall@10 ID **0.862** vs hybrid 0.925; but ID is the only system to reach 3-hop targets (multi-hop recall@10 **1.000 vs 0.750**) and the only one to adjudicate contradictions (correct-LIVE **1.000**), while losing pure paraphrase (0.333 vs 1.000 — structurally blind to semantic-only relevance).

*LoCoMo (1319 test questions):*

| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid |
|---|--:|--:|--:|--:|
| recall@10 | 0.245 | 0.271 | 0.282 | **0.307** |
| recall@20 | 0.272 | 0.272 | 0.324 | **0.375** |
| MRR | 0.151 | **0.176** | 0.165 | 0.174 |
| nDCG@10 | 0.166 | 0.193 | 0.185 | **0.194** |

ID+Rerank ties the hybrid on aggregate ranking and wins MRR/early precision, but the hybrid wins deep recall. We then localised ID's coverage cap through controlled cycles and **overturned our initial hypothesis**: a librarian (graph-construction) oracle that perfectly links co-evidence gave **+0.001 recall@10** — graph construction is *not* the lever. Vector multi-seeding halved the deep-recall gap and raised seed→evidence reachability in lockstep with recall, localising the cap to **the seed and the walk's reach to the evidence** — but from identical seeds the activation walk is not a better expander than graph-expansion+RRF. *(We note the retrieval REPORT's prose at one point attributes the deficit to the librarian; its own oracle and multi-seed artifacts contradict that, and we side with the artifacts: the bottleneck is seed/reach.)*

### 6.4 End-task QA and contradiction integrity (local LLM readers)
*QA, LoCoMo n=150, top-K=8, temp 0:*

| Arm | qwen F1 | llama F1 |
|---|--:|--:|
| ID+Rerank | 0.085 | 0.124 |
| MultiSeedID | 0.081 | 0.137 |
| **TunedHybrid** | **0.097** | **0.147** |

Raw QA accuracy follows retrieval — the hybrid wins on both readers; **Intelligent DB is not a better general retriever**. (Absolute F1 is near the floor; arm gaps are within reader noise — a relative read only.)

*Contradiction integrity (20 scenarios, K=5 cheap Sybils asserting a plausible false majority vs 1 trusted source; real `engine.adjudicate`, verified 20/20 true LIVE, 100/100 Sybils DEMOTED before any LLM call):*

| Reader | **Adjudicated** | **Raw** | Lift |
|---|--:|--:|--:|
| qwen2.5:7b | **0.95** | 0.00 | +0.95 |
| llama3.1:8b | **1.00** | 0.15 | +0.85 |

Fed the raw poisoned context, both LLMs answered the false majority. Routing the *same memory* through Intelligent DB — Sybils collapse via MIS, the trusted source structurally outranks them — recovered 95–100% correct answers. No vector or graph store provides this.

![Figure 3: Answer integrity under a Sybil flood — raw retrieval lets both readers answer the false majority (0.00 / 0.15); Intelligent DB's adjudicated memory recovers 0.95 / 1.00.](figures/fig3_contradiction_integrity.png)

---

## 7. Discussion

The two-sided result resolves into one position. Retrieval coverage is a competitive, commoditised problem, and Intelligent DB does not beat a tuned vector+graph hybrid at it. **What it uniquely provides is trust**: it stops an agent being argued into a falsehood by a fake majority, structurally rather than by a tunable threshold. The product thesis the evidence supports:

> **Intelligent DB doesn't retrieve *more* — it retrieves *trustworthy*.** It turns a 0–15% correct-answer rate under memory poisoning into 95–100%, end-to-end and cross-model.

The strongest configuration we found composes the two: vectors for coverage at the input (multi-seed), Intelligent DB's activation + provenance + adjudication for trust and structure, a vector reranker at the output. The trust layer is the moat; the vector machinery is a commodity to compose in, not compete against.

---

## 8. Limitations (stated without hedging)

- **The Sybil win is partly definitional.** The benchmark hands every engine an `independenceClass` field that only Intelligent DB consults; ID is *given* the external independence signal the others lack. This is a faithful model of trust-aware vs trust-blind retrieval, but the 24/24 demonstrates the *architecture's value contingent on a correct external anchor layer* — and providing that layer (binding cheap and costly anchors, pricing fleets per registrar/issuer) is the project's own standing liability, not something the prototype solves.
- **Priced, not prevented.** A funded attacker who buys N genuinely-distinct anchors gets N real identities. The system raises and exposes the cost; it does not make the attack impossible.
- **Lower-bound retrieval numbers.** Graphs were built deterministically with no LLM librarian and a small (MiniLM) embedder; absolute retrieval/QA scores are low. Relative comparisons are valid (identical inputs across arms); LLM readers are not bitwise-reproducible across hardware.
- **Contradiction lift is near-maximal by construction** — 7–8B readers are strongly fooled raw; a stronger reader would show a smaller (still positive) lift.
- **Single-process prototype.** Cross-process concurrency, live anchor/witness services, encryption-at-rest, and the high-cost anchor binders are unbuilt. Independence-class assignment is offline and a standing human-judgment liability.
- **Documentation/artifact drift.** The `README` understates the implementation; one `write_hz` figure differs between a prose report (104,464) and the committed metrics (98,911); a stale JSDoc contradicts its own code. None affects the audited results, but each is disclosed.
- **Adversarial red-team — the periphery is soft.** A 108-attack red-team campaign (three escalating tiers, every outcome read from real engine state, engine untouched, deterministic, verified) breached the engine **59 times (~55%)**: 26 defended, 23 deferred. The result is two-layered and qualifies the headline. The *structural core* holds — naive and coordinated Sybil floods cannot win, because the maximum-independent-set count collapses fakes and co-asserting attackers tie each other into a `DEFER`. But the surrounding trust machinery is soft. Many breaches are concrete demonstrations of *documented* residuals (patient single-betrayal via global/decaying reputation; laundered influence surviving disown; priced-not-prevented; offline class-assignment). Several are *genuine bugs the documents do not cover*: the irreversible-decision gate counts anchor **classes** not independent **roots** (one source self-clears it); disown's "exact" credit reversal is **one-hop, opt-in, and trusts an attacker-supplied corroborator list**; the activation **bridge sweep has no identity gate**; and — most consequential for the Integrity pillar — although the RFC-6962 Merkle layer is cryptographically correct as a standalone module, in the wired engine the audit chain commits only the pending/approval ledger, so **disowns, demotions, and reputation changes are mutable rows with no tamper-evident commitment** (the Merkle layer is composed separately by design and is latent unless explicitly wired with independent witnesses). Encouragingly, fix-probes (simulated at the harness level and shown to flip the breach) indicate most of the *genuine* bugs have clean, often one-line fixes — counting independent roots in the gate, passing the full taint closure to disown, engine-deriving the corroborator set, and an attribute-scoped corroboration floor. The honest reading: the priced-identity *idea* is sound and its core mechanism works, but the prototype's reputation/undo/audit/activation integration is not yet robust to an adaptive single attacker. Full catalogue in `.arbor/sessions/sybil-redteam/FINAL-REPORT.md`.

---

## 9. Conclusion and Future Work

We set out to build a memory substrate resistant to the poisoning attack vector databases cannot withstand, and to measure honestly what that costs. We found it **does not win on retrieval coverage or raw QA accuracy**, and **does win, decisively, on answer integrity under adversarial memory** (0–15% → 95–100%) — a property no production database provides, *contingent on the external anchor layer the design assumes and the prototype does not yet supply*. The proof-of-concept suggests the right architecture for trustworthy agent memory is not *vector DB or trust DB* but *vector retrieval composed under an external priced-identity adjudication layer*, with the model structurally forbidden from witnessing its own memory.

The single most promising next step the evidence points to is a **native vector index inside the engine** — giving Intelligent DB the hybrid's coverage at the seed while keeping its trust guarantees — turning the demonstrated complementarity into one system. Beyond that: building the high-cost anchor binders and live witness services that the central result is contingent upon, and the operational hardening (cross-process coordination, encryption-at-rest) that would move the design from a durable single-process prototype to a deployable substrate.

---

## References (key prior art, from the prior-art audit)
1. J. Douceur. *The Sybil Attack.* IPTPS 2002.
2. A. Jøsang, R. Ismail. *The Beta Reputation System.* Bled 2002.
3. B. Laurie, A. Langley, E. Kasper. *Certificate Transparency.* RFC 6962, 2013.
4. S. Kamvar, M. Schlosser, H. Garcia-Molina. *The EigenTrust Algorithm.* WWW 2003.
5. J. Anderson. *A Spreading-Activation Theory of Memory.* 1983 (ACT-R).
6. HippoRAG: *Neurobiologically Inspired Long-Term Memory for LLMs.* arXiv:2405.14831.
7. SYNAPSE: *Episodic-Semantic Memory via Spreading Activation.* arXiv:2601.02744.
8. J. de Kleer. *An Assumption-Based TMS.* Artificial Intelligence, 1986.
9. LoCoMo: *Evaluating Very Long-Term Conversational Memory.* (snap-research/locomo).

---

*Appendix — audit basis. Development history: genesis `0b7cfcc` (2026-06-24), HEAD `16102a5` (2026-06-28), 25 commits, one author, `master` only. Implementation: ~20k LOC under `src/`, `dependencies: {}`. Verification: 259 passed / 11 skipped, `tsc` clean. Results read from `.arbor/sessions/{cross-db-bench,retrieval-quality}/` metrics artifacts. Every quantitative claim in §6 is traceable to a committed JSON/MD artifact; every implementation claim in §5 to a cited `file:line`.*
