# Adversarial Scientific-Integrity Audit — Intelligent DB benchmarks

Scope: `src/__bench__/**` and the engine seams the arms consume. Every claim below is
grounded in the actual code (file:line), not comments or prose summaries. The audit is
written to be non-defensive: the goal is to surface what a hostile reviewer would catch.

Severity legend:
- **BLOCKER** — would materially mislead a reader about what the system does; must be fixed
  or the headline claim reframed before publication.
- **DISCLOSE-IN-PAPER** — legitimate modeling choice, but load-bearing and non-obvious; a
  reviewer will (rightly) demand it be stated explicitly next to the number.
- **BENIGN** — standard practice, correctly done, or already disclosed.

---

## 0. TL;DR — the one finding that matters

Every "substrate wins the poisoning benchmark" result (PoisonedRAG ASR, FactWorld,
Reasoning poisoned-bank, LOCOMO contradiction, cross-DB Sybil) is produced by a harness that
**hands the Intelligent-DB arm a ground-truth-derived trust partition** — the anchor-class
assignment and the reputation warm-up are computed *from the prep label* (`kind` / `trusted`
/ `poison`), which is exactly the thing a real deployment would have to *discover*. The
engine's `adjudicate()` code is real and does run, but its **inputs are constructed so the
outcome is predetermined**: gold = 2 disjoint anchor classes + a pre-earned reputation that
clears the decisive margin; poison = 1 shared anchor class + reputation 0. The plain `rag`
arm is (correctly) given none of this. So the benchmark measures *"given a correct external
identity oracle, does the engine use it correctly?"* — which is close to tautological — and
**not** *"can the substrate detect poison?"* The paper must say this in plain words. It is
defensible (the project's own hard theorem says identity MUST come from outside the graph),
but the headline framing over-claims unless the oracle is disclosed.

The ablation (`substrate-nofilter` / `substrate-notrust`) does **not** rescue this: both
ablation arms reuse the *same* label-derived partition and only toggle the filter/adjudication
*step*. It proves the filter is load-bearing; it does **not** prove the engine could identify
the poison without the label.

**UPDATE (2026-06-30):** a non-oracle variant now closes this gap (see finding #1 below /
`poisonedrag/nonOracleArm.ts`). Deriving the trust partition purely from candidate-pool text
structure — no label — cuts PoisonedRAG ASR from 93–99% to **17–23%** (vs the oracle arm's
6–18%). The honest two-tier claim: structural detection alone gets most of the way; the
external identity layer closes the rest. The oracle arms remain valid as the *upper bound*.

---

## 1. CENTRAL CONCERN (b): ground-truth labels drive the trust partition

### 1.1 PoisonedRAG substrate arm — anchor class + reputation set from `kind`
`src/__bench__/poisonedrag/arms.ts`
- **94**: `if (p.kind !== "gold" && p.kind !== "poison") continue;` — the prep oracle label
  partitions the world.
- **107**: `const cls = i === 0 ? AnchorClass.DOMAIN : AnchorClass.ORGANIZATION;` — gold gets
  ≥2 *disjoint* anchor classes purely because it is labeled gold.
- **126**: poison sources all get `AnchorClass.EMAIL_OAUTH` and share one class
  `cls:sybil:${qid}` (line 125) — a one-witness Sybil cluster *by fiat*.
- **146**: `repCapOf = (s) => (earn.has(String(s)) ? 0.95 : 0.05)` — reputation ceiling set by
  label.
- **154**: `for (const s of earn) for (let r = 0; r < 12; r++) reputation.ratify(...)` — gold
  primary pre-earned to a decisive LCB; poison earns nothing.
- **157**: `engine.adjudicate(qid)` then mechanically demotes the low-rep single-class side.

What this is: the classification decision ("this passage is poison") is made by `prep.py`,
not by the engine. The engine only *executes a demotion that the constructed inputs force*.
**Severity: BLOCKER** for any claim phrased as "the substrate detects/defends against
PoisonedRAG." **DISCLOSE-IN-PAPER** if reframed as "given an external anchor layer that
assigns a Sybil cluster one class and gold independent classes, the engine correctly demotes
the cluster." Honest fix: state the oracle assumption next to the ASR number; cite
`generalization/costlyIndependent` (§3) as the honest failure-mode counterpart.

### 1.2 Same construction, replicated verbatim in every poisoning arm
- `src/__bench__/factworld/arms.ts:201-211,225` — `a.kind === "current"` → trusted;
  `anchorClassFor` (168-172) hands `current` witness 0/1 → DOMAIN/ORGANIZATION and every
  `poison` → EMAIL_OAUTH; `repCapOf` 0.95/0.05; 12 ratifies.
- `src/__bench__/reasoning/arms.ts:250-251,266` — `bank.filter((e) => e.trusted)` sets the
  trusted set from the `BankEntry.trusted` flag stamped by `poison.ts:buildBank`; 0.95/0.05;
  12 ratifies.
- `src/__bench__/generalization/costlyIndependent.arm.ts:262-304` — same 0.95/0.05 + explicit
  ratify counts.
- `src/__bench__/generalization/multiSession.ts:193-254` — same 0.95/0.05, 12 ratifies.
- `src/__bench__/retrieval/retrievers.ts:121-138` — trusted set = `dataset.trustedSources`
  (oracle field); pre-earn loop (8 ratifies, note the inconsistent constant — §4). Worse: the
  read-back at **142-153** compares LIVE state against the *known* `pair.trueFactId` /
  `pair.falseFactId`, i.e. the harness knows the exact true/false pair a-priori.

All the same finding. **Severity: BLOCKER→DISCLOSE** as in §1.1. The uniformity is itself
worth noting: this is a systematic modeling choice, not a one-off.

### 1.3 Does the engine genuinely decide, or is it a hardcoded skip?
Genuinely runs — this is *not* a fake short-circuit. The arms call `engine.adjudicate(attr)`
and then read `store.getStrand(...).fact_state === FactState.DEMOTED`
(`poisonedrag/arms.ts:161-163`, `factworld/arms.ts:228,234-236`,
`reasoning/arms.ts:271-274`). The demotion is performed by real engine code. The integrity
problem is upstream: the *inputs* are oracle-built so the real decision has only one possible
outcome. Credit where due — no result value is hardcoded; the number falls out of real engine
execution over rigged inputs.

### 1.4 Why the ablation does not close the gap
`src/__bench__/poisonedrag/ablationRunner.test.ts` + `noTrustArm.ts`:
- `substrate-nofilter` (`arms.ts:85` `applyDemotedFilter=false`, used at
  `ablationRunner:108`): identical store, identical label-derived partition, identical
  adjudication (poison IS demoted) — only the retrieval-time *filter* is off.
- `substrate-notrust` (`noTrustArm.ts`): identical strands/anchors, but `repCapOf`≡0.05
  (124) and no `ratify`/no `adjudicate` (133-138) → nothing demoted.

Both controls **still consume the ground-truth-labeled anchor/reputation construction**
(`noTrustArm.ts:74,101-102` re-assign EMAIL_OAUTH to `p.kind==="poison"`). So the ablation
isolates *"is the trust filter the thing that removes poison at retrieval time?"* — a real
and useful control — but it **cannot** demonstrate that the engine could separate gold from
poison without the oracle label, because the label is present and load-bearing in all three
arms. The assertions at `ablationRunner:165-169` (`noFilter>sub`, `|noFilter-rag|<|noFilter-sub|`)
are honest about what they test, but the file header's phrase "prove the trust/provenance
layer IS the defense" should read "prove the trust *filter step* is load-bearing *given a
correct identity partition*." **Severity: DISCLOSE-IN-PAPER.**

---

## 2. UNFAIR-ADVANTAGE ANALYSIS (d)

### 2.1 Substrate sees an oracle partition; RAG/mem0 see nothing
By construction the substrate arm is handed `anchor_class` + reputation derived from the
ground-truth `kind`; `rag`/`mem0` retrieve by cosine over raw text only
(`poisonedrag/arms.ts:53-60`, `mem0Arm.ts`). This asymmetry is *the intended thesis* (RAG has
no trust layer) — but the fair statement is "RAG lacks a trust layer AND the trust layer is
fed a ground-truth oracle," not "the trust layer earned the win." The retrieval *channel* is
held identical (same embeddings/vectors, `ablationRunner:99-102`), which is the genuinely
fair part and correctly done. **Severity: DISCLOSE-IN-PAPER.**

### 2.2 The "poison = one shared anchor class" assumption is the favorable case
`prep.py:115-123` assigns all 5 real PoisonedRAG `adv_texts` for a query `anchor_class:
cls:sybil:${qid}` — one class. Nothing in the actual attack data justifies this: a patient
attacker could post the 5 adv_texts from 5 genuinely distinct domains (5 disjoint anchor
classes), in which case `independentRootCount` would NOT collapse them and the engine would be
poisoned exactly like RAG. The benchmark models the *cheap-Sybil* attacker only.
**Severity: DISCLOSE-IN-PAPER.** Strong mitigation: `generalization/costlyIndependent.arm.ts`
(§3) explicitly sweeps the unfavorable case and reports the engine *does* get captured — that
is the honest counterpart and should be cited in the same breath as the ASR win.

### 2.3 Capability / cross-DB "arms" are reimplemented decision rules, not the engine
`src/__bench__/capability/sybilPoisoning.capability.test.ts:90-108`: Arm1 (`falseCount >=
trueCount ? "FALSE" : "TRUE"`), Arm2, and Arm3 (`trueIndep > falseIndep ...`) are **3-line
reimplementations** of the decision rule. Arm3 consumes the REAL
`identity.independentRootCount` (131-132), but the decisive-or-defer verdict is not
`engine.adjudicate` — it is inlined. The cross-DB `attack.ts` similarly hand-builds the
scenario. This is transparent and the honesty control at **168-177** (an expensive distinct-
class Sybil DOES flip Arm3) is exactly the right non-rigged check — but the paper should not
call Arm1/Arm2 "vanilla RAG / passport" as if they were real systems; they are toy majority
functions. The *real* DB adapters live in `crossdb/adapters/*` and are used by
`crossdb/runner.test.ts`. **Severity: DISCLOSE-IN-PAPER** (toy arms), **BENIGN** (honesty
control is present and correct).

---

## 3. HONEST COUNTER-EVIDENCE ALREADY IN THE REPO (mitigating)

`src/__bench__/generalization/costlyIndependent.arm.ts` is the one arm that does NOT rig the
outcome in the engine's favor: it spreads the poison across `L` genuinely-disjoint real anchor
classes (267-284) and lets the attacker also buy an earned reputation track record
(`anchors+rep` mode, 280-283, 304), then reports capture/contamination honestly (311-331). Its
header (76-100) and the LCB arithmetic comment (78-83) openly reverse-engineer the ratify
counts to the policy thresholds. This is the scientifically honest sibling of §1 and its
existence is a point in the project's favor — **but it also proves the poisonedrag/factworld
wins depend on the cheap-Sybil assumption**, which is precisely why §2.2 must be disclosed.
**Severity: BENIGN** (and should be foregrounded, not buried).

---

## 4. HARDCODED VALUES / MAGIC NUMBERS (a)

| Value | Locations | Classification |
|---|---|---|
| `repCap 0.95 / 0.05` (trusted vs untrusted) | poisonedrag/arms.ts:146, factworld:211, reasoning:251, costlyIndependent:287, multiSession:213, retrievers.ts:122,342, noTrustArm:124 | **Result-biasing** — label-derived; the *gap* between them plus the warm-up is what guarantees the demotion. Disclose as part of §1. |
| Warm-up `12` ratifies | poisonedrag/arms.ts:154, factworld:225, reasoning:266, multiSession:254 | **Result-biasing tuning** — reverse-engineered so gold LCB clears `decisiveMargin=0.30` + `minWinnerReputation=0.20`. Legitimate as "model a credible source" but the exact count is chosen for the outcome. DISCLOSE. |
| Warm-up `8` ratifies | retrievers.ts:138 | Same as above, **inconsistent constant** across benchmarks (12 elsewhere, 8 here) — no principled reason given; looks tuned per-benchmark. DISCLOSE / unify. |
| `TRUE_PRIMARY_RATIFIES=2`, `POISON_PRIMARY_RATIFIES=10` | costlyIndependent.arm.ts:85-86 | **Result-shaping but openly documented** (LCB≈0.415 vs ≈0.784 vs the 0.30 gap). Honest; DISCLOSE the reverse-engineering. |
| `independenceBetween ⇒ 0.5` for any disjoint pair | poisonedrag/arms.ts:143, factworld:163, costlyIndependent:219 | **BENIGN** — only the sign (>0) is load-bearing for MIS; magnitude irrelevant here. |
| `decisiveMargin 0.30`, `minWinnerReputation 0.20` | engine `DEFAULT_ADJUDICATION_POLICY` (referenced costlyIndependent:78) | **Legitimate engine tuning constant**, not a bench artifact — but the bench ratify counts are fitted to it, so disclose the coupling. |
| `TOP_K=5`, `TOP_N=20` | poisonedrag runners :34-35, ablation :48-49 | **BENIGN** — standard RAG top-k; `topN` candidate pool is the same cosine channel for substrate; disclosed in config output. |
| `num_predict=64` (raise for thinking models) | poisonedrag/runner:36,107, ablation:122 | **BENIGN** — shared across ALL arms; `FIDELITY.md:60` already discloses deviation from PoisonedRAG's PaLM2 generator. |
| `temperature=0` | ollama.ts:28-29, all runners | **BENIGN / good** — determinism. |
| `sybilK`, `poisonRate` | factworld/generate.ts, poison.ts | **BENIGN** — attack-strength knobs, swept/reported. |

No hardcoded ASR/accuracy *result* values were found anywhere; every headline number is
computed from LLM output substring-matching (`ablationRunner:127-130`) or from engine LIVE
state (`costlyIndependent:314-325`). That part is clean.

---

## 5. LEAKAGE (c)

- **Reasoning study/test split — CLEAN.** `datasets.ts:48-55 splitStudyTest` sorts by id and
  removes the held-out test items from the study bank; test items are provably absent from
  memory. **BENIGN.**
- **Poison twin shares the gold's `retrieval_text`** (`poison.ts:83,102-107`) — this is an
  *intended* head-to-head cosine collision, not answer leakage; the poison carries a WRONG
  `solution_text` and `gold:""`. **BENIGN.**
- **FactWorld tokens** are unique fictional strings (`generate.ts:96-110` `tokenFactory` with
  a `used` set) so values never collide/leak; the gold value appearing in the assertion pool
  is the *point* of a memory benchmark, not leakage. **BENIGN.**
- **PoisonedRAG gold passage is in the retrieval pool** alongside 50k negatives + real poison
  (`prep.py:104-131`) — this is standard closed-pool RAG, not a test-answer leak. The
  substrate demoted-filter only ever removes *poison* passages (`arms.ts:90,128,176`;
  `poisonStrandToPassage` is poison-only), so gold/negatives are never preferentially
  surfaced by the filter. **BENIGN.**
- **mem0 arm** receives raw statements only, no oracle (`poisonedrag/mem0Arm.ts`) — a fair
  no-trust baseline alongside `rag`. **BENIGN.**

No test answers are injected into the retrieval pool beyond the standard gold-passage-in-corpus
setup; no dedup filter secretly removes the attacker's docs.

---

## 6. DETERMINISM / SEED (f)

- `crossdb/attack.ts:22-23` — explicitly no `Math.random`, no wall-clock; ids derived from
  indices + seed. **BENIGN/good.**
- `factworld/generate.ts:71-80` `mulberry32` seeded; clean/poison banks paired by consuming
  the PRNG identically (154-156 comment). **BENIGN/good.**
- `reasoning/poison.ts:38-49` FNV-1a `hash32`/`hashFrac` deterministic poison selection.
  **BENIGN.**
- `prep.py:79` `random.Random(13)` seeded reservoir sampling of negatives. **BENIGN.**
- Cosine tie-breaks are deterministic (`arms.ts:45` `|| a.i - b.i`; reasoning uses id-hash
  ties so legit/poison twins aren't systematically favored, `reasoning/arms.ts:74-83`).
  **BENIGN/good.**
- **Residual caveat (DISCLOSE):** the LLM-scored runners depend on a local Ollama model at
  `temperature=0`; greedy decoding is deterministic per (model, build, GPU) but not guaranteed
  bit-identical across hardware/driver versions. The ASR numbers are therefore reproducible on
  the same box, approximately reproducible across boxes. Worth a one-line disclosure.

---

## 7. SHORT-CIRCUITS / FAKE RESULTS (e)

None found. No arm returns a canned score; no `if (arm==='substrate') return 0` style cheat.
The closest thing to a "skip" is the substrate's demoted-poison filter
(`arms.ts:176`), which is the actual mechanism under test, not a cheat. The capability/cross-DB
Arm1-3 verdict functions (§2.3) are reimplementations rather than short-circuits — they
compute a real (if toy) decision. `FIDELITY.md` and `VERIFICATION.md` already disclose several
deviations from the original PoisonedRAG protocol (generator model, decomposition craft),
which is to the authors' credit.

---

## Top findings by severity

**BLOCKER (as currently framed):**
1. §1.1–1.2 — The substrate/ID arm's trust partition (anchor class + reputation) is computed
   **from the ground-truth prep label** (`kind`/`trusted`/`poison`), in every poisoning
   benchmark. The engine's `adjudicate()` runs for real but over inputs constructed to force
   the demotion. Any claim of the form "the substrate detects/defends against the poison" is
   over-stated; it must be reframed as "given a correct external identity oracle (Sybil
   cluster → one anchor class, gold → independent classes + earned reputation), the engine
   correctly demotes the cluster." The win is oracle-conditional, not detection.

   **RESOLVED (2026-06-30) — non-oracle variant added.** `poisonedrag/nonOracleArm.ts` +
   `nonOracleRunner.test.ts` remove the oracle: the trust partition is derived IN-BAND from
   candidate-pool text structure (near-duplicate Sybil-cluster detection), reading ZERO labels
   — `kind`/`value`/`source`/`anchor_class` are touched ONLY inside `if(stats)` measurement
   blocks, never in the drop decision. Calibrated by `nonOracleCalibrate.test.ts` (poison-poison
   cosine 0.83–0.89 vs gold-poison 0.56–0.67). Result (qwen2.5:7b, n=100, nq/hotpot/msmarco):
   `rag` 93/99/93% ASR → `nonoracle-exclude` **17/23/22%** → oracle `substrate` 6/18/6%. So the
   defense recovers the BULK of the poison reduction with no oracle (hotpot 23% ≈ oracle 18%),
   at an honest accuracy cost (59–74% vs 82–86%). The claim to make is now two-tier: (a)
   DETECTION — structural echo-collapse alone cuts ASR 93–99%→17–23% with no external identity;
   (b) the external identity layer (oracle arm) closes the residual gap and restores accuracy.
   The middle result (not 0%) is the honest signature of a real non-oracle defense.
   Confirmed MODEL-AGNOSTIC on qwen3:8b (rag 90–97% → exclude 14–22% → oracle 5–15%); the
   echo-collapse counts are byte-identical across models (clustering is structural, not reader-
   driven), which is itself evidence the arm never consults the label or the model's output.

**DISCLOSE-IN-PAPER:**
2. §1.4 — The ablation proves the trust *filter step* is load-bearing, NOT that the engine
   could identify poison without the label (all three arms share the label-derived partition).
3. §2.2 — Results depend on the cheap-Sybil assumption (poison = one shared anchor class);
   distinct-domain poison would defeat the engine. Foreground `generalization/costlyIndependent`
   (§3), which honestly shows capture in that regime.
4. §4 — Warm-up ratify counts (12; 8 in retrievers.ts) and 0.95/0.05 caps are reverse-
   engineered to the engine's `decisiveMargin 0.30` / `minWinnerReputation 0.20`; disclose the
   coupling and unify the inconsistent 8-vs-12 constant.
5. §2.3 — Capability/cross-DB Arm1/Arm2/Arm3 are reimplemented decision rules (toy majority /
   inlined decisive-or-defer), not the shipped engine path; don't present them as real systems.
6. §6 — LLM-scored ASR is reproducible on-box, only approximately across hardware.

**BENIGN / to the authors' credit:**
7. No hardcoded result values; all numbers fall out of real execution.
8. Retrieval channel held identical across arms (same embeddings/vectors).
9. Leakage-free study/test split (reasoning), unique fictional tokens (factworld), seeded
   determinism throughout the data-generation layer.
10. `generalization/costlyIndependent` and the capability "honesty control" (expensive Sybil
    flips the engine) are exactly the right non-rigged counter-tests and already exist.
