# Retrieval-Quality Benchmark (Cycle E) — MULTI-SEED activation walk on real LoCoMo

**10 conversations**, **5882 turns**; **1981 questions** kept. Split: **662 dev / 1319 test** (stratified). Embedder: **Xenova/all-MiniLM-L6-v2**. All numbers on the **TEST split**, macro-averaged. MultiSeedID seeds the engine's activation walk at the **top-k cosine-nearest turns** to the cue (the SAME vector-kNN entry the hybrid uses); k was grid-tuned on **dev** (max recall@20). The rerank blend and the TunedHybrid config are **reused frozen from cycle B**. Engine src/ is untouched (adapter-level seeding only).

```
frozen MultiSeed k:       20   (swept over {1,3,5,10,20} on dev)
frozen rerank blend:      0.2   (reused from cycle B)
frozen TunedHybrid:       {"s":5,"h":1,"k":10,"alpha":0.5}   (reused from cycle B)
```

## 1. Four-arm comparison (TEST)

| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid (frozen) |
|---|---|---|---|---|
| recall@1 | 0.096 | 0.095 | 0.093 | 0.093 |
| recall@5 | 0.184 | 0.256 | 0.217 | 0.234 |
| recall@10 | 0.245 | 0.271 | 0.282 | 0.307 |
| recall@20 | 0.272 | 0.272 | 0.324 | 0.375 |
| precision@1 | 0.104 | 0.102 | 0.100 | 0.100 |
| precision@5 | 0.042 | 0.059 | 0.050 | 0.054 |
| precision@10 | 0.028 | 0.032 | 0.033 | 0.036 |
| MRR | 0.151 | 0.176 | 0.165 | 0.174 |
| nDCG@10 | 0.166 | 0.193 | 0.185 | 0.194 |

recall@20 gap to hybrid: ID+Rerank **-0.103** → MultiSeedID **-0.051** (narrowed but not closed).

## 2. Per-LoCoMo-category breakdown (recall@20 / recall@10 / nDCG@10 / MRR / precision@5)

| Category | n | Arm | recall@20 | recall@10 | nDCG@10 | MRR | precision@5 |
|---|---|---|---|---|---|---|---|
| single-hop | 560 | PureID | 0.316 | 0.286 | 0.183 | 0.154 | 0.045 |
| single-hop | 560 | ID+Rerank | 0.316 | 0.316 | 0.222 | 0.192 | 0.064 |
| single-hop | 560 | MultiSeedID | 0.385 | 0.320 | 0.209 | 0.182 | 0.054 |
| single-hop | 560 | TunedHybrid | 0.422 | 0.349 | 0.220 | 0.189 | 0.058 |
| multi-hop | 188 | PureID | 0.103 | 0.078 | 0.055 | 0.081 | 0.031 |
| multi-hop | 188 | ID+Rerank | 0.103 | 0.102 | 0.077 | 0.112 | 0.049 |
| multi-hop | 188 | MultiSeedID | 0.135 | 0.103 | 0.065 | 0.079 | 0.031 |
| multi-hop | 188 | TunedHybrid | 0.149 | 0.111 | 0.070 | 0.085 | 0.040 |
| temporal | 213 | PureID | 0.297 | 0.271 | 0.202 | 0.194 | 0.050 |
| temporal | 213 | ID+Rerank | 0.297 | 0.292 | 0.200 | 0.182 | 0.060 |
| temporal | 213 | MultiSeedID | 0.291 | 0.246 | 0.172 | 0.163 | 0.049 |
| temporal | 213 | TunedHybrid | 0.353 | 0.307 | 0.189 | 0.169 | 0.051 |
| open-domain | 61 | PureID | 0.112 | 0.102 | 0.066 | 0.064 | 0.023 |
| open-domain | 61 | ID+Rerank | 0.112 | 0.112 | 0.073 | 0.075 | 0.033 |
| open-domain | 61 | MultiSeedID | 0.134 | 0.132 | 0.086 | 0.090 | 0.026 |
| open-domain | 61 | TunedHybrid | 0.108 | 0.087 | 0.061 | 0.074 | 0.026 |
| adversarial | 297 | PureID | 0.310 | 0.283 | 0.199 | 0.175 | 0.041 |
| adversarial | 297 | ID+Rerank | 0.310 | 0.310 | 0.229 | 0.203 | 0.062 |
| adversarial | 297 | MultiSeedID | 0.391 | 0.379 | 0.243 | 0.203 | 0.059 |
| adversarial | 297 | TunedHybrid | 0.502 | 0.399 | 0.256 | 0.226 | 0.064 |

## 3. Seed→evidence reachability (the diagnostic) + honest cost

| Quantity | Single-seed (cycle B) | Multi-seed (frozen k) | Change |
|---|---|---|---|
| seed→evidence reachability (mean frac of evidence turns in lit set) | 0.272 | 0.324 | +0.052 |
| mean \|lit\| (auto-halted size) | 13.060 | 13.552 | 1.04× |
| mean recall latency / query (ms) | 0.042 | 0.274 | 6.47× |
| precision@1 (PureID / ID+Rerank / MultiSeedID / hybrid) | 0.104 / 0.102 | — | MultiSeedID 0.100 vs hybrid 0.100 |

k-sweep on dev (recall@20 / nDCG@10 / mean |lit| / reachability):

| k | recall@20 | nDCG@10 | mean \|lit\| | reachability |
|---|---|---|---|---|
| 1 | 0.240 | 0.175 | 13.000 | 0.240 |
| 3 | 0.233 | 0.169 | 14.088 | 0.233 |
| 5 | 0.258 | 0.179 | 13.233 | 0.258 |
| 10 | 0.335 | 0.203 | 14.237 | 0.335 |
| 20 ★ | 0.346 | 0.197 | 13.618 | 0.346 |

## 4. Verdict (Q1–Q4)

**Q1 (close/flip the deep-recall + adversarial gap?)** MultiSeedID recall@10 0.282 (gap to hybrid -0.026), recall@20 0.324 (gap -0.051) — the gap NARROWED but did NOT close vs ID+Rerank's pre-seed gap of -0.103. Adversarial (n=297): MultiSeedID recall@20 0.391 vs hybrid 0.502, vs ID+Rerank 0.310. **Q2 (same vector seeds: does activation-walk beat graph+RRF?)** Not on overall recall@20 — from the SAME vector-kNN entry, MultiSeedID trails/matches the hybrid (0.324 vs 0.375); the per-category rows show where activation+provenance expansion wins vs k-hop graph+RRF. Multi-hop (n=188): MultiSeedID recall@20 0.135 / nDCG@10 0.065 vs hybrid 0.149 / 0.070. **Q3 (kept ID's multi-hop edge while gaining coverage?)** PARTIALLY — multi-hop nDCG@10 0.065 vs hybrid 0.070. **Q4 (reachability rose as predicted?)** Seed→evidence reachability 0.272 → 0.324 (ROSE); reachability and recall moved in lockstep, CONFIRMING the cycle C+D seed/reach diagnosis. COST: mean |lit| 13.060 → 13.552 (1.04×), latency 6.47× per query, precision@1 0.102 (ID+Rerank) → 0.100 (MultiSeedID).
