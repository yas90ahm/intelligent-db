# Librarian Ladder (Cycle D) — graph-construction quality isolation, real LoCoMo

**10 conversations**, **5882 turns**, **1981 questions** (**662 dev / 1319 test**, stratified). Embedder: **Xenova/all-MiniLM-L6-v2**. All TEST numbers, macro-averaged. **Isolation:** vary ONLY the librarian (graph edges); same turns, same MiniLM vectors, same retrievers, and the SAME per-query seed (computed once from the L0 graph, reused across all rungs).

## 1. Rung × retriever (TEST) — recall@10 / recall@20 / MRR / nDCG@10

| Rung | PureID r@10/r@20/MRR/nDCG | ID+Rerank r@10/r@20/MRR/nDCG | Hybrid r@10/r@20/MRR/nDCG | ID+Rerank−Hybrid (r@10 / r@20 / nDCG) |
|---|---|---|---|---|
| L0-baseline | 0.245/0.272/0.151/0.166 | 0.271/0.272/0.176/0.193 | 0.307/0.375/0.174/0.194 | -0.036 / -0.103 / -0.002 |
| L1-semantic | 0.250/0.283/0.149/0.165 | 0.281/0.283/0.172/0.193 | 0.314/0.385/0.176/0.197 | -0.034 / -0.102 / -0.004 |
| L2-richer-entity | 0.248/0.276/0.150/0.166 | 0.275/0.276/0.178/0.195 | 0.308/0.375/0.174/0.195 | -0.033 / -0.099 / +0.001 |
| L1+L2 | 0.256/0.290/0.150/0.167 | 0.288/0.290/0.177/0.198 | 0.314/0.385/0.176/0.197 | -0.026 / -0.095 / +0.001 |

Gap column = ID+Rerank minus Hybrid (positive ⇒ the better librarian let ID overtake the hybrid). L3 oracle is reported separately below (it is LEAKY — not comparable to the deployable rungs).

## 2. Per-category breakdown (recall@10 / nDCG@10) for L0, L1, L1+L2

| Category | n | Rung | PureID r@10/nDCG | ID+Rerank r@10/nDCG | Hybrid r@10/nDCG |
|---|---|---|---|---|---|
| single-hop | 560 | L0-baseline | 0.286/0.183 | 0.316/0.222 | 0.349/0.220 |
| single-hop | 560 | L1-semantic | 0.292/0.182 | 0.329/0.223 | 0.354/0.222 |
| single-hop | 560 | L1+L2 | 0.299/0.184 | 0.339/0.228 | 0.354/0.222 |
| multi-hop | 188 | L0-baseline | 0.078/0.055 | 0.102/0.077 | 0.111/0.070 |
| multi-hop | 188 | L1-semantic | 0.097/0.061 | 0.125/0.087 | 0.131/0.080 |
| multi-hop | 188 | L1+L2 | 0.087/0.057 | 0.117/0.085 | 0.131/0.080 |
| temporal | 213 | L0-baseline | 0.271/0.202 | 0.292/0.200 | 0.307/0.189 |
| temporal | 213 | L1-semantic | 0.268/0.201 | 0.289/0.196 | 0.315/0.192 |
| temporal | 213 | L1+L2 | 0.266/0.199 | 0.287/0.198 | 0.320/0.193 |
| open-domain | 61 | L0-baseline | 0.102/0.066 | 0.112/0.073 | 0.087/0.061 |
| open-domain | 61 | L1-semantic | 0.123/0.072 | 0.145/0.088 | 0.087/0.065 |
| open-domain | 61 | L1+L2 | 0.102/0.061 | 0.128/0.080 | 0.087/0.065 |
| adversarial | 297 | L0-baseline | 0.283/0.199 | 0.310/0.229 | 0.399/0.256 |
| adversarial | 297 | L1-semantic | 0.279/0.194 | 0.310/0.224 | 0.402/0.256 |
| adversarial | 297 | L1+L2 | 0.305/0.205 | 0.333/0.237 | 0.399/0.255 |

## 3. ORACLE CEILING (LEAKY — diagnostic upper bound, NOT deployable)

> ⚠️ L3 adds edges between turns that are co-evidence for the SAME question, using GROUND-TRUTH
> evidence sets (TEST LABELS). Its scores are an UPPER BOUND on headroom from perfect graph
> construction — they are NOT a fair/deployable retrieval result and must not be compared to the rungs above as such.

| Arm | L0 r@10 | Oracle r@10 | Δ headroom | L0 nDCG@10 | Oracle nDCG@10 | Δ |
|---|---|---|---|---|---|---|
| PureID | 0.245 | 0.244 | -0.001 | 0.166 | 0.166 | +0.000 |
| IDRerank | 0.271 | 0.271 | +0.001 | 0.193 | 0.193 | +0.001 |
| TunedHybrid | 0.307 | 0.308 | +0.000 | 0.194 | 0.195 | +0.000 |

## 4. Graph-density stats per rung (cost of density)

| Rung | nodes | materialized edges | mean edges/node | SHARED_ENTITY | CONFIRMED_LINK |
|---|---|---|---|---|---|
| L0-baseline | 5882 | 13886 | 4.722 | 8276 | 5610 |
| L1-semantic | 5882 | 40339 | 13.716 | 8276 | 32063 |
| L2-richer-entity | 5882 | 38568 | 13.114 | 32958 | 5610 |
| L1+L2 | 5882 | 62759 | 21.339 | 32958 | 29801 |
| L3-oracle-LEAKY | 5882 | 15536 | 5.283 | 8276 | 7260 |

(Same-speaker sibling connectivity is constant across rungs and not counted here; these are the librarian's materialized mention/session/semantic/oracle edges only.)

## 5. Frozen config + fairness audit

```
L1 frozen (m,τ):       {"m":8,"tau":0.45}   [tuned on dev: max mean ID+Rerank recall@20 on dev (nDCG@10 tie-break)]
L1 grid:               [{"m":3,"tau":0.45},{"m":3,"tau":0.55},{"m":3,"tau":0.65},{"m":5,"tau":0.45},{"m":5,"tau":0.55},{"m":5,"tau":0.65},{"m":8,"tau":0.45},{"m":8,"tau":0.55},{"m":8,"tau":0.65}]
hybrid frozen:         {"s":5,"h":1,"k":10,"alpha":0.5}   [dev-tuned on L0, reused all rungs]
rerank blend frozen:   0.2   [dev-tuned on L0, reused all rungs]
L2 entity rule:        richer proper-noun-PHRASE extraction + alias normalization: tokens stripped of surrounding punctuation + trailing possessive, lowercased; proper-noun = /^[A-Z][a-z]{2,}$/ OR acronym /^[A-Z]{2,5}$/ (minus stopwords); consecutive proper nouns merge into a phrase AND each multi-token phrase also emits its constituent token keys; SHARED_ENTITY edges for keys with DF∈[2,40].
L3 oracle:             LEAKY/diagnostic: edges between turns co-evidence for the SAME question (uses ground-truth labels).
```

## 6. Verdict (Q1–Q4)

**Q1 (does L1 close/flip the ID+Rerank-vs-Hybrid recall gap?)** At L0 the ID+Rerank−Hybrid recall@10 gap is -0.036 (r@20 -0.103); the deployable semantic librarian L1 moves it to -0.034 (r@20 -0.102) — a narrowing of +0.003 at r@10. **Q2 (does a better librarian help ID more than the hybrid?)** Going L0→L1, ID+Rerank recall@10 moves +0.010 while the hybrid moves +0.007 — the lever is ID-favouring (gap shrinks). **Q3 (oracle headroom).** Perfect (leaky) graph construction lifts ID+Rerank recall@10 by +0.001 over L0 (to 0.271); MODEST ⇒ ID is substantially walk/embedding-bound, not graph-bound. **Q4 (which category benefits most).** The biggest L0→L1+L2 ID+Rerank recall@10 gain is on **adversarial** (+0.024). Combined L1+L2 recall@10 (ID+Rerank) = 0.288 vs L0 0.271.
