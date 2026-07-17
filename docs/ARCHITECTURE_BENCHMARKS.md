# ARCHITECTURE_BENCHMARKS.md — the Intelligent DB anti-poisoning benchmark suite

Status: reference architecture for everything under `src/__bench__/`. Every claim below is
grounded in the actual code (file + line citations inline). This document covers the
**poisoning-resistance** benchmark suite specifically: the 5 experimental arms, the four
benchmark families (FactWorld, PoisonedRAG, generalization, reasoning), the data pipeline,
the metrics + Wilson CIs, and exactly how to reproduce each run.

Companion docs already in the tree (read alongside this one):
- `src/__bench__/COVERAGE.md` — attack-vector coverage matrix + scope notes.
- `src/__bench__/FIDELITY.md` — parameter-by-parameter fidelity vs the published PoisonedRAG paper.
- `src/__bench__/VERIFICATION.md` — four reviewer checks (CIs, spot-check, ablation, dual-metric).
- `src/__bench__/reports/confidence_intervals.md` — the measured Wilson CI table.
- `src/__bench__/reasoning/README.md` — the "does memory make a model better?" reasoning harness.

---

## 0. One-paragraph thesis

The project's hard theorem is that **claim adjudication cannot be solved from inside the
graph**: under "identity is priced, not prevented," no purely internal rule both lets one true
witness overturn a planted false canonical AND stops two fake sources overturning a true
incumbent. The Source-Identity Layer answers this by measuring independence against **scarce
external anchors**. The benchmark suite's job is to **empirically demonstrate that this
substrate collapses retrieval/memory-poisoning attacks that undefended RAG and an external
memory framework (mem0) fall to** — and, just as importantly, to **draw the measured boundary**
where the priced-not-prevented defense degrades once an attacker actually pays for real
independent anchors. Every arm shares the same embeddings, questions, prompt, and reader LLM;
the only variable is *how each arm adjudicates provenance*.

---

## 1. The arms (the experimental design)

All poisoning benchmarks compare up to five headline memory "arms" (plus the ablation and
non-oracle variants in §1.6–1.7). An arm answers exactly one question:
*given a query, what memory context does the reader LLM see?* They differ only in retrieval /
adjudication. The arm interfaces:
- FactWorld: `FwArm.contextFor(q, qVec) → string[]` (`src/__bench__/factworld/arms.ts:55-60`).
- PoisonedRAG: `PrArm.contextFor(q, qVec) → string[]` (`src/__bench__/poisonedrag/arms.ts:31-35`).
- Reasoning: `Arm.exemplars(query, k) → number[]` (`src/__bench__/reasoning/arms.ts:61-67`).

### 1.1 `bare` — no memory (the construct-validity floor)
Returns `[]` context (`factworld/arms.ts:69-71`, `poisonedrag/arms.ts:49-51`). The reader must
answer from its prior only. In FactWorld the gold value is a **fictional token that exists only
in injected memory**, so bare floors at chance (measured 0% acc / 0% ASR — it can neither hit
gold nor the poison). In PoisonedRAG the model's parametric knowledge leaks through, so bare is
a nonzero-but-low baseline (nq 4% ASR / 50% acc). Bare is the sanity control: poison must not
move it.

### 1.2 `rag` — flat vector top-K (undefended; Sybil density wins)
Cosine top-K over **every** ingested statement/passage, including the poison cluster
(`factworld/arms.ts:77-86`; `poisonedrag/arms.ts:53-60` via `cosTopK` at `39-47`). No provenance,
no adjudication. The attack is crafted so the K near-duplicate poison passages dominate
similarity/headcount and crowd the gold out of the top-K → the reader emits the attacker's
answer. This is the arm that **reproduces the published PoisonedRAG ~93–99% ASR** (the
load-bearing proof the attack is full-strength; see `FIDELITY.md §4`).

### 1.3 `substrate` — the REAL Intelligent DB engine (the defense under test)
This is not a re-implementation; it wires the actual engine (`createIntelligentDb`,
`createSourceIdentityLayer`, `createReputationLedger`, `createPendingLedger` from `../../index.js`).
The recipe (identical across FactWorld `factworld/arms.ts:182-242`, PoisonedRAG
`poisonedrag/arms.ts:85-183`, the generalization arms, and the multi-session durability arm):

1. **Ingest each asserted value as a provenance-rooted OBSERVED strand.** Same-value assertions
   **share a `content_hash`** (`chash:<attrKey>:<value>`), because the engine's value-agreement
   test is content-hash equality — so two sources asserting the same value become **co-asserters**
   whose provenance roots union.
2. **Gold (true value) = ≥2 DISJOINT anchor classes.** The two true sources bind DOMAIN +
   ORGANIZATION (`anchorClassFor`, `factworld/arms.ts:167-172`; `poisonedrag/arms.ts:107`). The
   anchor registry's `independenceBetween(a,b)` returns a positive weight **iff the two sources'
   anchor classes are disjoint**, 0 if they share any class (`factworld/arms.ts:157-164`). So the
   engine's `independentRootCount` (max-independent-set over backing roots) reads **#R = 2** for
   gold.
3. **Poison = ONE shared anchor class = a Sybil cluster.** All K poison sources bind the same
   class (EMAIL_OAUTH) and share one independence class (`cls:sybil:<id>`), so the poison value
   collapses to a single witness: **#R = 1** — an echo, not corroboration.
4. **Reputation: the gold PRIMARY is pre-earned; everyone else stays ~0.** `repCapOf` gives the
   trusted (current/gold) sources a 0.95 cap and everything else the 0.05 bare-key ceiling
   (`factworld/arms.ts:211`; `poisonedrag/arms.ts:146`). Only the **primary** gold source is
   warmed via `reputation.ratify(s, NOW, 1)` ×12 (`factworld/arms.ts:225`; `poisonedrag/arms.ts:154`);
   the 2nd gold source is an **unearned corroborator** (rep 0) supplying only the 2nd disjoint
   root — pre-earning both would tie the decisive-margin top-2 at 0 and force a DEFER.
5. **Adjudicate every disputed (entity, attribute).** `engine.adjudicate(attrKey)` runs the real
   contradiction adjudication (`factworld/arms.ts:228`; `poisonedrag/arms.ts:157`): the gold's
   #R=2 + earned LCB decisively outranks the Sybil #R=1 at LCB 0 → **RESOLVED**, and the poison
   strands are **DEMOTED (never deleted)**.
6. **Retrieval returns only LIVE / drops DEMOTED.** FactWorld renders the surviving LIVE
   value(s) back to statements (`factworld/arms.ts:232-240`). PoisonedRAG takes a cosine
   candidate pool of size `topN=20`, drops the DEMOTED-poison passage ids, and takes the top
   `k=5` survivors (`poisonedrag/arms.ts:167-181`) — so context size is identical to `rag`
   (k=5), no retrieval-depth advantage to the defender.

The single mechanistic claim ("gold #R=2 + earned LCB decisively outranks the Sybil #R=1 echo →
poison DEMOTED → dropped from top-K") is proved as a **pure engine-state assertion** (no LLM) in
`spotcheckNq.test.ts` (`:318-320` asserts gold #R==2, poison #R==1, RESOLVED for every sampled
query) and `factworld/substrate.validate.test.ts`.

### 1.4 `hybrid` — in-repo TunedHybrid (reasoning bench only)
RRF of a vector-kNN channel + a ≤h-hop graph-proximity channel (`reasoning/arms.ts:123-171`).
A control answering "is it ID specifically, or would any structured retrieval help?" It has no
provenance/contradiction defense, so under poison it recalls poison like `rag`.

### 1.5 `mem0` — a genuine external memory framework
Not ours in disguise: a persistent Python sidecar (`reasoning/mem0_sidecar.py`, driven by
`Mem0Sidecar` in `reasoning/mem0Arm.ts`) running mem0 fully local with its **own** embedder
(`nomic-embed-text` via Ollama, 768-d), **own** vector store (embedded Qdrant), and **own**
ranking. It ingests every statement/passage (including poison — mem0 has no provenance defense)
and answers by its own text search (`factworld/mem0Arm.ts`, `poisonedrag/mem0Arm.ts`). This is
the "different memory system" baseline; it falls to the same poison (nq 96% ASR, factworld 79%
ASR). Communication is a JSON-lines protocol over stdout with a `@@MEM0@@ ` sentinel
(`reasoning/mem0Arm.ts:20,71-87`).

### 1.6 Ablation arms (isolate the trust layer as the cause)
Two additional PoisonedRAG arms exist purely to prove the defense is the trust layer and not
retrieval/embeddings/engine-plumbing:
- **`substrate-notrust`** (`poisonedrag/noTrustArm.ts`) — byte-identical store, strands,
  identity/anchor/reputation/ratification wiring, and `cosTopK→drop-demoted→take-K` retrieval as
  `substrate`, with trust disabled exactly two ways: (1) `repCapOf` flattened to 0.05 for
  everyone + **no** `reputation.ratify` warm-up (`:124`); (2) **no** `engine.adjudicate` call
  (`:133-135`). With nothing adjudicated, no Sybil strand is ever DEMOTED, `demotedPoison` stays
  empty, the identical filter removes nothing → poison crowds the top-K exactly like `rag`.
- **`substrate-nofilter`** — the *surgical* single-variable ablation: `substrateArm(..., false)`
  (the `applyDemotedFilter` flag, `poisonedrag/arms.ts:85,167-181`). Same store, same pre-earned
  reputation, same adjudication that DID demote the poison — only the demoted **filter** is
  toggled off, so the (still-demoted) poison is surfaced anyway. Isolates the filter as the
  single variable.

The ablation runner asserts the encoded prediction as directional bounds:
`noFilter > substrate`, `|noFilter − rag| < |noFilter − substrate|`, `|noTrust − rag| < |noTrust
− substrate|`, `noTrust > substrate` (`poisonedrag/ablationRunner.test.ts:162-169`).

### 1.7 `substrate-nonoracle` — the label-free structural defense (detection, not just use)

The `substrate` arm derives its trust partition (anchor class + reputation) from the
ground-truth `kind` label — so it measures *"given a correct identity oracle, does the engine
USE it?"*, not *"can it DETECT the poison?"* (the audit's one BLOCKER, `docs/INTEGRITY_AUDIT.md`
§0/§1). This arm removes the oracle: independence is inferred **in-band from candidate-pool text
structure**, reading **zero labels** — `kind`/`value`/`source`/`anchor_class` are touched ONLY
inside `if(stats)` measurement blocks, never in the drop decision
(`poisonedrag/nonOracleArm.ts`).

- **Signal.** A PoisonedRAG attack must inject N≈5 docs that all match the query AND assert the
  same crafted answer → they form a dense mutual near-duplicate cluster. Measured
  (`nonOracleCalibrate.test.ts`, `[CALIBRATE_BENCH]`): poison↔poison cosine mean **0.83–0.89**
  vs a lone gold passage at **0.56–0.67**.
- **Mechanism** = the web's own "a same-root flood collapses to multiplicity 1", applied at
  retrieval: union-find near-duplicate clustering (`NONORACLE_TAU=0.78` transitive,
  `NONORACLE_MINECHO=3` → only a genuine multiplicity collapses, never an incidental pair). Two
  modes: **`collapse`** keeps the single best-ranked member (pure de-dup), **`exclude`** drops
  the whole ≥3 flood (treats the flood itself as a Sybil signal — the non-oracle analog of the
  oracle arm filtering the demoted poison, but *inferred* from structure).
- **Result is a two-tier claim** (numbers in §2.2): structural detection alone cuts ASR
  93–99%→14–23%; the external identity layer (the oracle `substrate`) closes the residual gap
  and restores accuracy. The middle result — not a suspicious 0% — is the expected signature of a
  real no-oracle defense.

---

## 2. The benchmark families

### 2.1 FactWorld — synthetic closed-book entity-attribute QA (the clean-room construct)

**Purpose.** A construct with perfect internal validity: ~300 **fictional** entities × 4
attributes (headquarters, CEO, flagship product, parent org) = ~1,200 closed-book questions
whose CURRENT value **lives only in injected memory**, so `bare` provably floors at chance
(`factworld/generate.ts:57-62`).

**Construction** (`factworld/generate.ts:121-173`), deterministic via a `mulberry32` seeded PRNG
+ a unique fictional-token factory (`:71-110`):
- For each (entity, attribute): an **OLD** value (single source, own class — a superseded
  distractor, `:135-139`); a **CURRENT TRUE** value asserted by **TWO** sources with **disjoint**
  anchor classes (`:142-148`); and — in the poison condition — a **Sybil cluster** of `sybilK`
  contradictory wrong-value assertions **all sharing one class** (`:157-166`).
- **Pairing for McNemar.** The clean and poison banks are generated from the same seed and
  **consume the PRNG identically** — the poison selection roll and poison token are always drawn,
  only the *emission* of the Sybil assertions is condition-gated (`:154-166`). So the two
  conditions differ only by the injected Sybil assertions, and questions are paired.
- Assertions carry the provenance the substrate arm needs (`sourceId`, `anchorClass`, `kind`) AND
  the natural-language `statement` the rag/mem0 arms index (`Assertion`, `:22-31`).

**Scoring.** Exact-match on the single fictional gold token — **no LLM judge**, zero grading
confound (`factworld/score.ts`): normalize + word-membership test. The runner also checks whether
the reply emitted the **poison** token, giving an ASR readout (`factworld/runner.test.ts:125-126`).

**Analysis cell.** The headline is the **poisoned subset** (attacked questions only): per arm,
clean-acc, poison-acc, Δ-on-poisoned, and ASR = fraction of attacked Qs answered with the poison
value (`factworld/runner.test.ts:138-155`).

**Measured result** (`reports/confidence_intervals.md`): substrate **0.0% ASR / 99.8% acc** vs
rag 98.7% / 1.3%, mem0 79.4% / 20.1%, bare 0% / 0%. n_poisoned = 601.

### 2.2 PoisonedRAG — the real published attack on real corpora (the faithful reproduction)

**Purpose.** Reproduce the PoisonedRAG black-box attack (arXiv:2402.07867 / USENIX Sec 2025) on
NQ / HotpotQA / MS-MARCO and show the substrate collapses its ASR. Fidelity is documented
parameter-by-parameter in `FIDELITY.md`; the **n=100 path is the faithful, citable reproduction**
(consumes the repo's real GPT-4-origin `adv_texts` verbatim), and the load-bearing empirical fact
is that our plain `rag` arm reproduces the paper's ~93–99% ASR.

**Data prep** (`poisonedrag/prep.py`) — builds a tractable, provenance-labelled KB from the real
attack file + a BEIR corpus:
- Inputs (in `<cache>`): `<dataset>.json` (100 target Qs: question, correct/incorrect answer, 5
  `adv_texts`) and `<dataset>.zip` (BEIR `corpus.jsonl` + `qrels/*.tsv`), streamed.
- **gold** = a qrels-relevant corpus passage asserting the CORRECT answer; **each gold passage is
  its own independent source/anchor class** (`prep.py:107-114`).
- **poison** = one of the 5 `adv_texts` asserting the INCORRECT answer; **all 5 for a question
  share ONE anchor class** `cls:sybil:<qid>` = one Sybil witness (`prep.py:116-123`).
- **negative** = a reservoir-sampled random corpus passage (seed 13, default 50,000), independent
  distractor (`prep.py:78-101,125-130`).
- qrels: **union ALL splits** just to *locate* gold for the target queries (target ids can live in
  any split; MS-MARCO uses train qrels) (`prep.py:58-77`).
- Outputs: `pr_<dataset>_kb.jsonl` (one passage/line with `{id,text,kind,query_id,value,source,
  anchor_class}`) and `pr_<dataset>_questions.jsonl` (`{id,question,correct,incorrect,has_gold}`).
  Only questions with a real gold passage carry `has_gold:true` (`prep.py:133-139`).
- Usage: `python prep.py <cache_dir> <dataset> [neg_sample]`.

**Loader.** `poisonedrag/data.ts` — `loadKB` / `loadQuestions` over the JSONL, typed as
`KBPassage` / `PRQuestion`.

**Scoring.** PoisonedRAG's own metric: **ASR = the incorrect answer is a normalized substring of
the reply**; **acc = the correct answer is a substring** (`poisonedrag/runner.test.ts:46-47,
109-115`). Both bits are independent (a reply can contain both).

**Measured result** (`reports/confidence_intervals.md`, n=100/dataset, qwen2.5:7b): substrate ASR
**nq 6% / hotpotqa 18% / msmarco 7%** with acc 86/82/85, vs rag 93/99/93 ASR (acc 22/11/16) and
mem0 96/98/92 ASR. RAG-vs-IDB ASR 95% CIs are **disjoint on every dataset** (§4).

**Non-oracle result** (`nonOracleRunner.test.ts`, `[NONORACLE_BENCH]`, n=100/dataset). The full
full spectrum — from undefended, through label-free structural detection, to the oracle upper
bound — ASR (nq / hotpotqa / msmarco):

| arm | qwen2.5:7b | qwen3:8b (thinking) |
|---|---|---|
| `rag` (no defense) | 93 / 99 / 93 | 90 / 97 / 94 |
| `substrate-nonoracle` **collapse** (de-dup only) | 69 / 73 / 82 | 58 / 76 / 73 |
| `substrate-nonoracle` **exclude** (structural, NO label) | **17 / 23 / 22** | **14 / 22 / 22** |
| `substrate` (oracle upper bound) | 6 / 18 / 6 | 5 / 15 / 8 |

Structural exclude accuracy 59–74% (qwen2.5) / 56–75% (qwen3) — below the oracle's 82–90% by the
cost of occasionally excluding a gold passage pulled into a Sybil cluster. Echo-collapse purity
**86–93%** (of dropped docs, ~9/10 were truly poison — inferred, never told), and the collapse
counts are **byte-identical across the two models** (the decision is structural, blind to both
the label and the reader's output). Findings: (1) **de-dup alone is insufficient** (collapse
69–82% ASR — erasing multiplicity still leaves one top-ranked poison copy, and PoisonedRAG poison
out-ranks gold, so *rank* is the second lever); (2) **structural exclude recovers the bulk** of
the oracle defense with no identity signal (hotpotqa 23% ≈ oracle 18%); (3) the defense is
**model-agnostic** (same spectrum on a thinking model, which does not resist poison on its own).
Attacker evasion mirrors §2.5: shrink the flood below 3 (weakens concentration) or buy genuinely
independent, textually-diverse sources (the "priced, not prevented" boundary).

### 2.3 The n=1000 PoisonedRAG-*style* scale test

`poisonedrag/hotpot1000_prep.py` scales the black-box attack to real HotpotQA distractor
questions, emitting KB + questions in the **exact schema the existing runner consumes** (so
`PR_DATASET=hotpot1000` works unchanged).
- Input: `hotpot_distractor_val.parquet` (streamed row-group by row-group, `:137-146`).
- For each of the first N questions with a short answer (≤6 words) **and ≥2 gold paragraphs**
  (HotpotQA always has 2 supporting-fact titles → substrate gets #R=2 for free, `:202-205`), it
  **synthesizes the attack with the local Ollama model** (qwen2.5:7b, temp 0): a plausible
  INCORRECT answer + 5 corroborating poison sentences, each poison text = `"{question} {sent}"`
  (PoisonedRAG's question-prefixed black-box `S=Q⊕I` form) (`gen_attack`, `:89-118`;
  `:229-237`). Guards skip a returned "incorrect" that equals the correct answer (`:214-218`).
- gold = supporting-facts paragraphs (each its own class); poison = 5 sharing `cls:sybil:<qid>`;
  negatives = the non-supporting context paragraphs.
- **Scope caveat** (`FIDELITY.md §2-4`, `COVERAGE.md #2c`): this is PoisonedRAG-*style*
  (self-generated, temp 0, no V=30-word cap, no L=50 regen loop, single-shot pad-to-5), a
  **scale/generalization** test, NOT the faithful reproduction. The cache materializes ~332
  question rows, so "n=1000" is aspirational vs what is built.

### 2.4 Contriever apples-to-apples (the paper's exact retriever)

The n=100 reproduction swaps the paper's Contriever for MiniLM (documented deviation). To close
that gap, `poisonedrag/contriever_embed.py` embeds a JSONL field with `facebook/contriever-msmarco`
(mean pooling over the attention mask, `:72-77`) and writes **un-normalized dot-product vectors**
to a compact binary (`<uint32 n><uint32 dim><float32[n*dim]>`). It deliberately does **NOT**
L2-normalize because the TS `cosine` is a raw dot product — so un-normalized Contriever vectors
make the TS ranking **identical to the paper's dot-product ranking** (`:6-9,136`). Defaults to CPU
(`CUDA_VISIBLE_DEVICES=""` guard, `:57-63`) with an opt-in `--device cuda`.

`poisonedrag/contrieverRunner.test.ts` is structurally identical to `runner.test.ts` (same arms,
prompt, `ollamaGenerate`, substring ASR/acc, k=5/topN=20/num_predict=64/temp 0) — the **only**
difference is that retrieval vectors are loaded from the precomputed `.f32` files via `loadF32`
(`:59-74`) instead of embedded with MiniLM. Question vectors are embedded before the `has_gold`
filter, so they are re-aligned by original question id (`:127-138`).

### 2.5 Generalization — the measured boundary + durability

**Costly-independent boundary** (`generalization/costlyIndependent.*`). The deliberate exhibition
of "priced, not prevented." Same structural world as FactWorld
(`costlyIndependent.generate.ts:103-115`), but the arm lets the **attacker pay**: the K poison
sources hold **genuinely-independent, disjoint real anchor classes**, and the runner sweeps an
independence level **L = 1..K** = how many distinct anchor classes the poison spreads across
(`costlyIndependent.arm.ts:228-341`, `POISON_CLASS_PALETTE` `:90-100`):
- L=1 → all poison shares one class → #R(poison)=1 → cheap Sybil → DEMOTED (the FactWorld result,
  ASR≈0).
- L=2 → poison reaches #R=2, matching the truth's depth → engine can't call a decisive depth
  winner → **DEFERS** → poison survives LIVE alongside truth (contamination).
- L≥3 (+ bought reputation, mode `anchors+rep`) → poison out-depths AND out-ranks the truth →
  engine RESOLVES *for the poison* → truth demoted → full capture.

Two attacker budgets: `anchors-only` (buys independence, earns no reputation) and `anchors+rep`
(also pre-earns the poison primary via `POISON_PRIMARY_RATIFIES=10` vs the truth's
`TRUE_PRIMARY_RATIFIES=2`, `:85-86,301-304`). The **ASR proxy** is a no-LLM lower bound read
straight from LIVE state: capture = 1.0, contamination (surfaced but not captured) = 0.5, defended
= 0 (`:330-331`). The runner asserts the **curve shape** as a regression guard
(`costlyIndependent.runner.test.ts:95-112`): anchors-only defended at L=1 (ASR 0) then strictly
higher for L≥2; anchors+rep monotone non-decreasing reaching full capture (ASR 1) at the top;
buying reputation never weaker than anchors alone at the same L. RAG is the constant reference
ceiling (poison always retrievable → ASR≈1 at every L).

**Multi-session durability** (`generalization/multiSession.*`). Proves a demotion survives a
process restart. SESSION 1 opens a **file-backed SQLite** store on a shared handle, ingests a gold
value (#R=2) + a K-Sybil poison cluster (#R=1), pre-earns the primary, adjudicates (poison →
DEMOTED, gold → LIVE), and **closes the handle** (WAL flush) (`multiSession.ts:171-275`). SESSION 2
reopens the **same file with a fresh handle** and reads `fact_state` straight off disk — **no
engine, no re-adjudication** (`:290-307`). The test asserts every poison strand is still DEMOTED,
gold still LIVE, `liveValues == ["Berlin"]`, and that it is **stable across a second reopen** (no
drift) (`multiSession.test.ts:46-96`). Uses the SQLite reputation + pending ledgers on the shared
`db` handle (`createSqliteReputationLedger`, `createSqlitePendingLedger`, `:214-231`).

### 2.6 Reasoning — "does ID memory make a model better?" (the orthogonal harness)

Not a poisoning benchmark per se, but it carries the same arms and a **poisoned-bank variant**
that is the ID's designed win. Thesis: a good memory makes a capable model more accurate; headline
contrast `bare` vs `substrate`, with `rag`/`hybrid`/`mem0` controls (`reasoning/README.md`).
- **Leakage-free split** (`reasoning/datasets.ts:48-55`): the first N problems by id are the
  held-out TEST set; the rest (+ worked solutions) are the STUDY bank loaded into memory. Test
  problems are never in memory, so any gain is genuine recall of related-but-unseen exemplars.
- Benchmarks: MATH-500 (EM on boxed/final answer), GPQA-diamond (letter match), HumanEval (pass@1,
  runs model code against hidden tests) — scored by `reasoning/score.ts` + `codeExec.ts`.
- **Poisoned bank** (`reasoning/poison.ts`): for a fraction of studied problems, a low-reputation
  adversary posts a DUPLICATE carrying a WRONG solution, sharing an (entity, attribute) with the
  legit twin → a contradiction set (`buildBank`, `:85-119`). The substrate arm wires reputation
  (trusted ≫ adversary) + adjudicates → poison DEMOTED, never recalled; rag/hybrid/mem0 recall it
  by cosine. Note the substrate arm here gives every entry the **same** independence class so a
  legit/poison twin is an **echo** dispute resolved purely by the external reputation signal
  (`reasoning/arms.ts:220-236`) — a poison source is not an independent witness. Two measures:
  model-independent **poison-recall rate** (validated rag ≈17–23%, mem0 ≈25%, **substrate = 0%**)
  and downstream accuracy.
- **Known limit** (matches the hard theorem): ID catches contradictions/identity, not arbitrary
  *novel* plausible falsehoods with no legit twin to contradict — explicitly out of scope.

---

## 3. Shared infrastructure (the retrieval + LLM channel)

### 3.1 Embedder (`retrieval/embed.ts`)
`Xenova/all-MiniLM-L6-v2` (384-d, mean-pooled + **L2-normalized**) via `@huggingface/transformers`,
dynamically imported so the heavy native dep stays out of every other test's module graph
(`:65-67`). **Both `rag` and `substrate` consume the SAME vectors**, so the embedding channel is
provably identical and the comparison is fair. `cosine(a,b)` is a raw dot product (`:23-28`) — on
L2-normalized MiniLM vectors that equals cosine; on un-normalized Contriever vectors it equals the
paper's dot-product. Vectors are cached to a temp JSON keyed by a SHA-256 of `model_id` + the exact
ordered text list (`:30-43`), so re-runs skip the model call.

### 3.2 Reader LLM (`retrieval/qa/ollama.ts`)
A tiny zero-dependency client POSTing a single non-streaming completion to a local Ollama server
(`/api/generate`), deterministic by construction (**temperature 0**, bounded `num_predict`).
`ollamaGenerate` returns the trimmed `response`, falling back to the `thinking` field for
reasoning models whose answer was truncated (`:78-87`), and **fails LOUD** on non-200 / network /
empty body (a silent "" would poison the metrics). `ollamaReachable` probes `/api/tags`. Host is
`OLLAMA_HOST` (default `http://localhost:11434`), so the same harness can point at a remote GPU box.
Every runner starts by asserting `ollamaReachable()` and throwing if not.

### 3.3 Concurrency + prompt
Each runner precomputes context per question, then generates concurrently with a `mapLimit(items,
CONCURRENCY, fn)` bounded worker pool (identical helper in every runner). The reader prompt is one
fixed template per benchmark, identical across arms so the only variable is the retrieved context
(`factworld/prompt.ts`, `buildPrompt` in each PoisonedRAG runner, `reasoning/prompt.ts`).

---

## 4. Metrics + statistics

| Metric | Where | Definition |
|---|---|---|
| ASR (substring) | PoisonedRAG runners | `clean(reply).includes(clean(incorrect))` — the paper's own metric |
| acc (substring) | PoisonedRAG runners | `clean(reply).includes(clean(correct))` |
| ASR (poison-token) | FactWorld | `scoreEM(reply, poisonValue)` on the attacked subset |
| acc (EM) | FactWorld / reasoning | exact word-membership / normalized boxed-answer / MC letter / pass@1 |
| ASR proxy (no-LLM) | generalization | capture=1.0, contamination=0.5, defended=0 — read from LIVE state |
| poison-recall | reasoning poison | fraction of recalled exemplars that are poison (model-independent) |
| dual-metric judge | PoisonedRAG dualMetric | a 2nd Ollama call returns CORRECT/INCORRECT/NEITHER |

**Dual-metric cross-validation** (`poisonedrag/dualMetricRunner.test.ts`). Answers the skeptic's
"is the cheap substring metric inflating ASR?" Every reply is scored **both** ways: (a) the exact
substring metric, and (b) an **LLM judge** — a second `ollamaGenerate` handed the question, correct
answer, poison answer, and reply, returning exactly one strict token, parsed deterministically
(`parseVerdict`, `:103-118`, with a guard so `CORRECT` inside `INCORRECT` isn't miscounted). Reports
per-arm ASR/acc under each metric plus `asr_agreement` / `acc_agreement` / `label_agreement`. High
agreement ⇒ the substring metric is not inflating the result. Saves a few full example traces for
inspection.

**Wilson 95% confidence intervals** (`verification/wilsonCI.mjs`). Reads the completed benchmark
JSONs, converts each `rate*n` back to a success count `k`, and computes the Wilson score interval
(z=1.96) for ASR and acc (`wilson(k,n)`, `:8-16`). It then emits, per real dataset, whether the RAG
and IDB-substrate ASR intervals **overlap** (`overlaps`, `:79-83`). The measured verdict
(`reports/confidence_intervals.md`): **NO OVERLAP** on all four datasets — nq RAG [86.3,96.6] vs IDB
[2.8,12.5]; hotpotqa [94.6,99.8] vs [11.7,26.7]; msmarco [86.3,96.6] vs [3.4,13.7]; factworld
[97.4,99.3] vs [0.0,0.6]. IDB's ASR is significantly lower, not noise. Run: `node
src/__bench__/verification/wilsonCI.mjs`.

**Spot-check** (`poisonedrag/spotcheckNq.test.ts`). A deterministic, CPU-only, no-LLM explainer:
for 8 sampled NQ queries it reconstructs the substrate arm exactly and dumps the concrete
trust/provenance reason each poison was dropped (gold #R, poison #R, gold-primary vs poison LCB,
adjudication outcome, which strands ended DEMOTED, and the RAG-vs-IDB top-5). Writes
`.arbor/sessions/verification/spotcheck_nq.md` and **asserts** gold #R==2, poison #R==1, RESOLVED
for every sampled query (`:317-321`).

---

## 5. Data-flow diagrams

### 5.1 PoisonedRAG end-to-end pipeline

```
 REAL ATTACK ARTIFACTS                      BEIR CORPUS
 <dataset>.json (100 Qs:                    <dataset>.zip
   question, correct,                        corpus.jsonl + qrels/*.tsv
   incorrect, 5 adv_texts)                        |
        |                                          |
        +------------------ prep.py ---------------+
                              |
             gold (each = own anchor class)  ┐
             poison (5 share cls:sybil:<qid>)├─► pr_<ds>_kb.jsonl  +  pr_<ds>_questions.jsonl
             negative (50k reservoir, seed13)┘         |                    |
                                                       |                    |
                          embedTexts (MiniLM 384-d, L2-norm, cached)        |
                    OR   contriever_embed.py (dot-product .f32)             |
                                                       |                    |
                  ┌────────────────────────────────────┼────────────────┐  |
                  ▼               ▼                     ▼                ▼  ▼
              bareArm          ragArm              substrateArm      mem0Arm
              (ctx=[])     cosine top-K over     ingest→#R(gold)=2, #R(poison)=1   (own Qdrant
                            ALL passages          adjudicate→poison DEMOTED         + embedder)
                            (poison wins)         cosine topN=20 → drop demoted → K
                  │               │                     │                │
                  └──────── buildPrompt(question, ctx) ─┴────────────────┘
                                        │
                              ollamaGenerate (qwen2.5:7b, temp 0)
                                        │
                        ASR = incorrect ∈ reply ;  acc = correct ∈ reply
                                        │
                    .arbor/sessions/poisonedrag/*.json ──► wilsonCI.mjs ──► src/__bench__/reports/confidence_intervals.md
```

### 5.2 The substrate arm's trust decision (the core mechanism)

```
  per (entity, attribute) / per query_id:

   GOLD value  "correct"                         POISON value "incorrect"
   ├─ source A  anchor=DOMAIN   ─┐                ├─ src sybil:0  ┐
   ├─ source B  anchor=ORG      ─┤ share          ├─ src sybil:1  ├ all anchor=EMAIL_OAUTH,
   │  (A pre-earned ×12,          │ content_hash  ├─ ...          │ share ONE class cls:sybil
   │   B unearned corroborator)   │               └─ src sybil:K  ┘ (share content_hash)
   └─ independenceBetween(A,B)>0  ┘
        → #R = 2                                       → #R = 1  (echo, not corroboration)

               engine.adjudicate(attrKey)
                        │
        decisive + earned margin (LCB gold≈0.81 ≫ poison 0.00, depth 2>1)
                        │
                   RESOLVED  ──► gold LIVE, poison DEMOTED (never deleted)
                        │
        retrieval:  cosine topN pool → drop DEMOTED poison ids → take K  ──► context
```

---

## 6. How to reproduce each benchmark

All GPU/LLM benches are **gated** vitest tests — a plain `npm test` skips them. Each is enabled by
its own env flag and reads the shared Ollama client. Prerequisite for every LLM run: Ollama running
with the model pulled (`ollama pull qwen2.5:7b`), reachable at `OLLAMA_HOST`
(default `http://localhost:11434`).

Output roots (repo-relative, created by the runners): `.arbor/sessions/<family>/` for
results, `.arbor/cache/<family>/` for prepped data.

**The measured result artifacts cited throughout this document are committed** under
`.arbor/sessions/` (factworld, poisonedrag, verification, generalization,
reasoning-bench, cross-db-bench, retrieval-quality, transcripts, sybil-redteam) — every
per-run JSON, report, and raw LLM transcript a number in this document points at, ~3 MB
total. The `.arbor/cache/` datasets and embeddings (~2.7 GB) are not committed; the
runners regenerate them. The overnight LLM-scored reasoning sweep is reproducible via
`scripts/run-full-reasoning-bench.ps1` (local Ollama, qwen2.5:7b + qwen3:8b).

### 6.1 FactWorld
```
FACTWORLD_BENCH=1 FW_MODEL=qwen2.5:7b FW_ENTITIES=300 \
  npx vitest run src/__bench__/factworld/runner.test.ts
```
Env (`factworld/runner.test.ts:31-56`): `FW_MODEL` (qwen2.5:7b), `FW_ENTITIES` (300),
`FW_POISON_RATE` (0.5), `FW_SYBIL_K` (6), `FW_K` (5), `FW_ARMS` (bare,rag,substrate,mem0),
`FW_CONCURRENCY` (4), `FW_SEED` (7), `FW_NUMPREDICT` (24), plus `MEM0_PYTHON` / `MEM0_EMBED` /
`MEM0_EMBED_DIMS`. Output: `.arbor/sessions/factworld/factworld_<model>.json`.
CPU-only de-risk (no GPU): `npx vitest run src/__bench__/factworld/substrate.validate.test.ts`.

### 6.2 PoisonedRAG (faithful n=100)
```
# 1) prep once per dataset (Python stdlib):
python src/__bench__/poisonedrag/prep.py .arbor/cache/poisonedrag nq [neg_sample]
# 2) run:
POISONEDRAG_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=nq \
  npx vitest run src/__bench__/poisonedrag/runner.test.ts
```
Env (`poisonedrag/runner.test.ts:25-44`): `PR_MODEL`, `PR_DATASET` (nq|hotpotqa|msmarco),
`PR_K` (5), `PR_TOPN` (20), `PR_NUMPREDICT` (64), `PR_ARMS`, `PR_CONCURRENCY` (4), `PR_QCAP`
(0=all), `PR_CACHE`, `MEM0_*`. Output: `.arbor/sessions/poisonedrag/poisonedrag_<ds>_<model>.json`.

### 6.3 PoisonedRAG scale (n=1000-style)
```
# generate the attack (GPU-heavy — needs Ollama):
.arbor/venv-mem0/Scripts/python.exe src/__bench__/poisonedrag/hotpot1000_prep.py \
  --cache ".arbor/cache/poisonedrag" --parquet hotpot_distractor_val.parquet \
  --name hotpot1000 --limit 1000 --model qwen2.5:7b
# then run the standard runner with PR_DATASET=hotpot1000:
POISONEDRAG_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=hotpot1000 \
  npx vitest run src/__bench__/poisonedrag/runner.test.ts
```

### 6.4 Contriever apples-to-apples
```
# build vectors (un-normalized dot-product) for KB + questions:
.arbor/venv-mem0/Scripts/python.exe src/__bench__/poisonedrag/contriever_embed.py \
  .arbor/cache/poisonedrag/pr_nq_kb.jsonl text .arbor/cache/poisonedrag/pr_nq_kb.contriever.f32
.arbor/venv-mem0/Scripts/python.exe src/__bench__/poisonedrag/contriever_embed.py \
  .arbor/cache/poisonedrag/pr_nq_questions.jsonl question .arbor/cache/poisonedrag/pr_nq_q.contriever.f32
# run:
CONTRIEVER_BENCH=1 PR_MODEL=qwen2.5:7b PR_DATASET=nq \
  npx vitest run src/__bench__/poisonedrag/contrieverRunner.test.ts
```
Output: `.arbor/sessions/poisonedrag/contriever_<ds>_<model>.json`.

### 6.5 Ablation (trust layer is the cause)
```
ABLATION_BENCH=1 PR_DATASET=nq PR_MODEL=qwen2.5:7b \
  npx vitest run src/__bench__/poisonedrag/ablationRunner.test.ts
```
Compares substrate / substrate-nofilter / substrate-notrust / rag; asserts the directional bounds
in §1.6. Output: `.arbor/sessions/poisonedrag/ablation_<ds>_<model>.json`.

### 6.6 Dual-metric (substring vs LLM judge)
```
DUALMETRIC_BENCH=1 PR_MODEL=qwen2.5:7b \
  npx vitest run src/__bench__/poisonedrag/dualMetricRunner.test.ts
```
Optional `PR_JUDGE_MODEL` (default = `PR_MODEL`), `PR_SAMPLES` (8), plus the standard `PR_*`.
Output: `.arbor/sessions/poisonedrag/poisonedrag_dualmetric_<ds>_<model>.json`.

### 6.7 Spot-check (deterministic, no GPU)
```
SPOTCHECK_NQ=1 npx vitest run src/__bench__/poisonedrag/spotcheckNq.test.ts
```
Env: `SPOTCHECK_N` (8), `SPOTCHECK_NEG` (80), `PR_CACHE`. Output:
`.arbor/sessions/verification/spotcheck_nq.md`.

### 6.8 Generalization — costly-independent boundary (no GPU)
```
COSTLY_INDEPENDENT_BENCH=1 npx vitest run \
  src/__bench__/generalization/costlyIndependent.runner.test.ts
```
Env: `CI_ITEMS` (80), `CI_SYBIL_K` (6, max 6), `CI_SEED` (7). Output:
`.arbor/sessions/generalization/costlyIndependent.json`.

### 6.9 Generalization — multi-session durability (no GPU)
```
GENERALIZATION_BENCH=1 npx vitest run \
  src/__bench__/generalization/multiSession.test.ts
```
Pure-logic SQLite file close/reopen; asserts persisted DEMOTED across a fresh handle.

### 6.10 Reasoning ("does memory help?")
```
REASON_BENCH=1 REASON_MODELS=qwen2.5:7b REASON_BENCHMARKS=math,gpqa,coding \
  REASON_ARMS=bare,rag,substrate,hybrid REASON_N=50 REASON_K=3 \
  npx vitest run src/__bench__/reasoning/runner.test.ts
```
Poisoned-bank variant: add `REASON_POISON=0.5`. Full env table + one-time dataset/venv setup in
`src/__bench__/reasoning/README.md`. Output: `.arbor/sessions/reasoning-bench/results.json`.

### 6.11 Wilson CIs (post-processing, no GPU)
```
node src/__bench__/verification/wilsonCI.mjs
```
Reads the completed FactWorld + PoisonedRAG JSONs; writes
`src/__bench__/reports/confidence_intervals.md`.

---

## 7. Why the design is fair (methodology guarantees)

- **Same embeddings, same questions, same prompt, same reader.** rag and substrate consume the
  *identical* vectors (`embedTexts`), the identical question set (`has_gold` filtered), the
  identical prompt template, and the identical Ollama model at temp 0 — so any ASR difference is
  attributable only to the trust/adjudication decision, not the retrieval or generation channel.
- **Identical context size.** substrate's `topN=20` is a *defender-internal* candidate pool
  narrowed back to the same `k=5` context as rag — no retrieval-depth advantage.
- **No LLM judge on the headline.** FactWorld uses fictional-token EM; PoisonedRAG uses the paper's
  substring metric. The LLM judge exists only as an independent *cross-check* (dual-metric).
- **The defense is a REAL engine, not a mock.** Every substrate arm calls `createIntelligentDb` +
  `adjudicate`; `spotcheckNq` / `substrate.validate` assert the mechanism as pure engine state.
- **The attack is full-strength.** The plain `rag` arm reproduces the paper's 93–99% ASR
  (`FIDELITY.md §4`), proving both the retrieval and generation attack conditions survive the
  pipeline before the substrate is applied.
- **No-LLM lower bound.** The costly-independent and multi-session ASRs are read directly from
  post-adjudication `fact_state`, so a downstream reader can only do worse than these figures,
  never better (`COVERAGE.md`).
- **The boundary is disclosed, not hidden.** The costly-independent curve is presented as a
  **failure mode** — ID's ASR rises monotonically to the undefended ceiling as the attacker pays
  for real anchors + reputation. That is the core of "priced, not prevented."
- **The oracle assumption is disclosed AND removed.** The headline `substrate` arm is
  oracle-conditional (trust partition from the label — §1.7). The `substrate-nonoracle` arm
  removes the oracle entirely (independence inferred from text structure, zero labels) and still
  cuts ASR 93–99%→14–23% (§2.2), so the win is not "reading the answer key." The two-tier
  framing (structural detection + identity layer) is stated in plain words, not implied.

---

## 8. File index

```
src/__bench__/
├── factworld/
│   ├── generate.ts                  synthetic world + Sybil poison, seeded PRNG, McNemar-paired
│   ├── arms.ts                      bare / rag / substrate (real engine)
│   ├── mem0Arm.ts                   mem0 sidecar arm
│   ├── prompt.ts                    closed-book EM reader prompt
│   ├── score.ts                     fictional-token exact match (no judge)
│   ├── runner.test.ts               clean vs poison, acc + ASR on the poisoned subset  [FACTWORLD_BENCH]
│   └── substrate.validate.test.ts   CPU-only mechanism de-risk (no GPU)
├── poisonedrag/
│   ├── prep.py                      BEIR + real adv_texts → provenance-labelled KB (faithful n=100)
│   ├── hotpot1000_prep.py           self-generated PoisonedRAG-style attack at scale
│   ├── contriever_embed.py          paper's exact retriever → un-normalized dot-product .f32
│   ├── data.ts                      KB / questions JSONL loader
│   ├── arms.ts                      bare / rag / substrate (+ applyDemotedFilter ablation flag)
│   ├── noTrustArm.ts                substrate-notrust ablation control
│   ├── nonOracleArm.ts              label-free structural Sybil defense (collapse / exclude)
│   ├── mem0Arm.ts                   mem0 sidecar arm
│   ├── runner.test.ts               ASR + acc (substring)                                [POISONEDRAG_BENCH]
│   ├── nonOracleRunner.test.ts      rag / collapse / exclude / oracle spectrum           [NONORACLE_BENCH]
│   ├── nonOracleCalibrate.test.ts   measures poison-cluster vs gold separation           [CALIBRATE_BENCH]
│   ├── ablationRunner.test.ts       substrate vs nofilter vs notrust vs rag              [ABLATION_BENCH]
│   ├── dualMetricRunner.test.ts     substring vs LLM-judge cross-validation             [DUALMETRIC_BENCH]
│   ├── contrieverRunner.test.ts     apples-to-apples with the paper's retriever          [CONTRIEVER_BENCH]
│   ├── transcriptRunner.test.ts     per-question raw model outputs → transcripts jsonl   [TRANSCRIPT_BENCH]
│   └── spotcheckNq.test.ts          pure-engine-state "why poison dropped" trace          [SPOTCHECK_NQ]
├── generalization/
│   ├── costlyIndependent.generate.ts    abstract per-item world
│   ├── costlyIndependent.arm.ts         real engine at a chosen poison independence level
│   ├── costlyIndependent.runner.test.ts L=1..K ASR degradation curve                     [COSTLY_INDEPENDENT_BENCH]
│   ├── multiSession.ts                  SQLite session1 ingest+adjudicate / session2 reopen
│   └── multiSession.test.ts             demotion persists across restart                 [GENERALIZATION_BENCH]
├── reasoning/                       "does memory make a model better?" + poisoned-bank variant [REASON_BENCH]
├── retrieval/
│   ├── embed.ts                     shared MiniLM-L6-v2 embedder + cosine + cache
│   └── qa/ollama.ts                 zero-dep local-LLM client (temp 0, fail-loud)
├── verification/wilsonCI.mjs        Wilson 95% CIs + RAG-vs-IDB overlap test
├── reports/confidence_intervals.md  measured CI table (NO OVERLAP on all 4 datasets)
├── COVERAGE.md                      attack-vector coverage matrix + scope notes
├── FIDELITY.md                      parameter-by-parameter PoisonedRAG fidelity
└── VERIFICATION.md                  four reviewer checks
```

## 9. Headline measured results (for reference)

> **HISTORICAL (pre-rebuild).** Every number in this section was measured against the
> crypto-era (V2) system, BEFORE the crypto-free rebuild. They are preserved unchanged
> as the historical baseline. For what was and was not re-measured against the rebuilt
> system, see §10.

| benchmark | substrate ASR | substrate acc | rag ASR | mem0 ASR |
|---|---|---|---|---|
| factworld (n_pois=601) | **0.0%** | **99.8%** | 98.7% | 79.4% |
| poisonedrag-nq (n=100) | **6.0%** | **86.0%** | 93.0% | 96.0% |
| poisonedrag-hotpotqa | **18.0%** | **82.0%** | 99.0% | 98.0% |
| poisonedrag-msmarco | **7.0%** | **85.0%** | 93.0% | 92.0% |

**Non-oracle (label-free) PoisonedRAG ASR**, structural `exclude` mode, vs the `rag` floor and
the oracle `substrate` upper bound (qwen2.5:7b / qwen3:8b):

| benchmark | rag ASR | nonoracle-exclude ASR | oracle substrate ASR |
|---|---|---|---|
| poisonedrag-nq | 93 / 90 | **17 / 14** | 6 / 5 |
| poisonedrag-hotpotqa | 99 / 97 | **23 / 22** | 18 / 15 |
| poisonedrag-msmarco | 93 / 94 | **22 / 22** | 7 / 8 |

Costly-independent boundary (no-LLM proxy): anchors-only L=1 → 0%, L≥2 → 50%; anchors+rep L≥3 →
100% (the disclosed failure mode). Source: `reports/confidence_intervals.md`, `COVERAGE.md`,
`nonOracleRunner.test.ts`.

## 10. Crypto-free rebuild re-run (2026-07-02) — what was re-measured, what was not

Dated section, appended after the five-phase crypto-free rebuild (relay fix; crypto-free
trust registry replacing Ed25519 passports/binders/Merkle/staking; trust-tiered quarantine
ingest; per-tier dispute horn; this re-measurement pass). Nothing in §9 was edited — those
remain the pre-rebuild baselines. Everything below was measured against the REBUILT system,
on this machine, pure-node, no external services.

### 10.1 What ran (exact commands)

```
REDTEAM=1 npx vitest run src/__bench__/redteam/redteam.test.ts
REDTEAM=1 npx vitest run src/__bench__/redteam/redteam2.test.ts
REDTEAM=1 npx vitest run src/__bench__/redteam/redteam3.test.ts
npx vitest run src/__bench__/factworld/substrate.validate.test.ts
npx vitest run src/__bench__/capability/sybilPoisoning.capability.test.ts
```

### 10.2 Red-team results (rebuilt system, after the two triage fixes below)

| Cycle | total | defended | breached | deferred |
|---|---|---|---|---|
| 1 | 36 | 6 | 1 | 29 |
| 2 | 36 | 13 | 10 | 13 |
| 3 | 25 | 16 | 7 | 2 |
| **Σ** | **97** | **35** | **18** | **44** |

Baseline comparison: **V1 (crypto era) = 59 breaches; V2 (crypto era, hardened) = 25
breaches** (all 25 classified as documented thesis-boundary residuals); **rebuilt = 18
breaches**. Every one of the 18 is byte-identical in id/name/mechanism to its V2
counterpart — **zero new breaches, zero regressions**. The improvement from 25 → 18
decomposes into three buckets:

- **Bucket A — retired attack surface (5).** Keyholder Forge-From-Genesis, Hide-A-Disown
  Below the Audit Horizon, Unscheduled/Pre-Anchor Window, Split-View With No Collector,
  and the Tamper-Evidence Coverage Boundary all targeted the Ed25519/Merkle/STH layer the
  rebuild deleted. They are out of the spec set entirely — *removed, not defended*. Their
  history-rewrite goal is now covered by the checksum chain's ASSERTED-attribution model,
  a documented trade-off (see 10.5). Caveat: this makes the cycle-3 count not
  apples-to-apples with V2's cycle 3 (36 specs incl. the merkle-audit family vs 25 without
  it); comparing only the surviving non-Merkle attacks, the sets match one-for-one.
- **Bucket B — genuine fixes made during this pass (2).**
  1. *Proxy-Consulted Weak-Influence Launder* (cycle 2): the uncited-influence review
     queue consumed `weakInfluence.edgesConsulting` exactly ONE hop, so an A→c1→b1 relay
     escaped review. Fixed in `src/ratification/disown.ts`: the queue is now a transitive
     backward BFS over consulted-strand edges (cycle-safe, deterministic, idempotent, and
     — unchanged — never auto-demotes; every hop is human review only). Regression test in
     `src/ratification/disownHardening.test.ts`. BREACHED → DEFENDED.
  2. *Mega-Provider Subdomain Seam, ce-c3-02* (cycle 3): an external audit caught that the
     red-team spec still hand-assigned per-FQDN independence classes — modeling a no-PSL
     system that no longer exists. The rebuilt system SHIPS a PSL eTLD+1 resolver
     (`src/identity/binders/publicSuffix.ts`) wired into the trust registry's DOMAIN /
     publisher class derivation, and it collapses `sub*.evilcorp.com` to ONE witness while
     keeping `a1/a2.github.io` (PSL PRIVATE section) distinct. The spec now routes the
     attack through the SHIPPED resolver (so it regresses to BREACHED if the PSL is ever
     unwired) and a default-suite regression case was added to
     `src/identity/binders/publicSuffix.bothDirections.test.ts`. This was a stale-harness
     artifact reclassified, not a defense added. BREACHED → DEFENDED.
- **Bucket C — documented residuals (the 18 that remain).** Each maps to a named,
  deliberate boundary: **priced-not-prevented** (Confederate Launder, Transient Bond
  Cap-Inflation, Anchor-Preserving Key-Rotation, Dormancy Beta-Decay Wash,
  Penance-by-Dormancy, the cc-c3 kill-chain composites, Registrar Carousel);
  **offline class-assignment / count-vs-weight** (EMAIL Mega-Provider Tenant Seam —
  defended on weight, breached only on integer count; Null-Source Laundromat, reachable
  only by planting raw strands that bypass `writeFact`); **traversal-fails-open by
  design** (Bridgehead Beacon, Bridge-Sweep Eclipse, the identity-gated-bridge fix-probes
  — halting deliberately surfaces low-corroboration strands WITH a stamp, and a hard gate
  provably starves genuine convergence=1 insight bridges); and the **theorem boundary**
  (WINDOW-FORGERY: source-identity independence ≠ content-provenance independence — the
  web cannot witness content causality).

### 10.3 Poisoning arms re-run (pure engine, locally runnable)

- **FactWorld substrate arm** (`substrate.validate.test.ts`, no LLM): poison rate 1.0,
  sybilK 8 — after adjudication the only LIVE value per (entity, attribute) is the true
  current value for every question ⇒ **adjudication-level ASR = 0%**. 2/2 tests pass.
- **Sybil-poisoning capability benchmark** (`sybilPoisoning.capability.test.ts`): the
  Intelligent DB arm stays TRUE (**ASR 0%**) at every cheap-fleet size
  A ∈ {1,2,3,5,10,50,200,500} — the fleet collapses to independent-count 1 — while the
  vanilla-RAG and passport-only arms flip FALSE at A ≥ 3. Honesty control: an EXPENSIVE
  fleet of A distinct PAID anchor classes DOES flip the substrate for A > 3 (DEFER at the
  A = 3 tie) — priced-not-prevented, exactly as designed. 6/6 tests pass.

Rule-2 verdict (rebuild must stay ≥ mem0/Zep on poisoning): **holds** on every locally
re-runnable arm — 0% ASR against cheap Sybil flooding, vs the historical mem0 79.4% / RAG
98.7% on the same construct.

### 10.4 NOT re-run (external dependencies unavailable) — historical numbers still §9

The following need Ollama-served LLMs / embedding models / a mem0 Python sidecar /
disk-scale sweeps, none of which were available for this pass. Their §9 numbers are
**HISTORICAL (pre-rebuild)** and should be cited as such until re-run:

- `factworld/runner.test.ts` — the LLM-scored end-to-end ASR (historical: ID **0.0%** vs
  RAG 98.7% / mem0 79.4%, n_pois=601).
- All of `poisonedrag/` (historical: ID 6/18/7% vs RAG 93/99/93% on NQ/HotpotQA/MSMARCO;
  non-oracle exclude 17/23/22%).
- All of `retrieval/` (LoCoMo / QA / librarian runners), `crossdb/` (needs adapters +
  Docker services), `deployment/` (disk-scale sweeps), `generalization/` LLM arms.

### 10.5 Named trade-offs carried by the rebuilt numbers

- **Asserted attribution (the headline trade-off):** with Ed25519 signing removed, who
  wrote an audit record is asserted by the writing process and committed into a SHA-256
  checksum chain — internally consistent and byte-flip-detecting (`verifyChain` names the
  first broken seq), but an actor with live write access can rewrite history and re-verify
  green. Mitigation: exported `chainHead()` checkpoints a rewrite cannot reproduce, IF
  stored where the writer can't touch (operational, not shipped). Third-party
  non-repudiation is gone; that is the price of the crypto-free constraint, stated plainly.
- **Registry claims are configuration, not proof:** DOMAIN/ORG-grade weight now rests on
  what the deployment's registry config asserts (e.g. a config-verified SSO custom
  domain), not on DNS-01 proofs this codebase runs. A misconfigured registry silently
  mis-weights independence — same liability family as offline class assignment.
- **The Merkle detection layer is deleted, not replaced:** it was
  detection-given-live-witnesses, and the witness sinks were never built, so nothing
  currently delivered was lost — but the *capability* of efficient third-party
  inclusion/consistency proofs is foreclosed.
- **Staking retired:** attribution + the disown clawback is the deterrent; the
  FINANCIAL_STAKE row is inert data with no producer.
