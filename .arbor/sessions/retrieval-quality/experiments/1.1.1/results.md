# Retrieval-Quality Benchmark (Cycle C) — WIDE-NET WalkConfig on real LoCoMo

**10 conversations**, **5882 turns**; **1981 questions** kept. Split: **662 dev / 1319 test** (stratified). Embedder: **Xenova/all-MiniLM-L6-v2**. All numbers on the **TEST split**, macro-averaged. The wide WalkConfig was grid-tuned on **dev** (max ID+Rerank recall@20); the TunedHybrid config is **reused frozen from cycle B** (not re-tuned).

```
frozen WIDE WalkConfig:  epsilon=0.002  gamma=0.6  popCap=2000  (wallClockMs=2000)
frozen WIDE rerank blend: 0.2
DEFAULT (before) config:  epsilon=0.02  gamma=0.6  popCap=2000   (before rerank blend 0.2)
frozen TunedHybrid:       {"s":5,"h":1,"k":10,"alpha":0.5}  (reused from cycle B)
```

## 1. Before (cycle B / DEFAULT) → After (WIDE) — ID arms vs frozen hybrid (TEST)

| Metric | PureID before | PureID wide | ID+Rerank before | ID+Rerank wide | TunedHybrid (frozen) |
|---|---|---|---|---|---|
| recall@1 | 0.096 | 0.096 | 0.095 | 0.093 | 0.093 |
| recall@5 | 0.184 | 0.170 | 0.256 | 0.244 | 0.234 |
| recall@10 | 0.245 | 0.226 | 0.271 | 0.273 | 0.307 |
| recall@20 | 0.272 | 0.280 | 0.272 | 0.280 | 0.375 |
| precision@1 | 0.104 | 0.104 | 0.102 | 0.100 | 0.100 |
| precision@5 | 0.042 | 0.038 | 0.059 | 0.056 | 0.054 |
| precision@10 | 0.028 | 0.026 | 0.032 | 0.032 | 0.036 |
| MRR | 0.151 | 0.146 | 0.176 | 0.172 | 0.174 |
| nDCG@10 | 0.166 | 0.157 | 0.193 | 0.190 | 0.194 |

ID+Rerank recall@20: **0.272 → 0.280** (Δ +0.009); gap to frozen hybrid **-0.103 → -0.095**.

## 2. Per-LoCoMo-category breakdown (recall@20 / recall@10 / nDCG@10 / MRR)

| Category | n | Arm | recall@20 | recall@10 | nDCG@10 | MRR | precision@5 |
|---|---|---|---|---|---|---|---|
| single-hop | 560 | PureID before | 0.316 | 0.286 | 0.183 | 0.154 | 0.045 |
| single-hop | 560 | PureID wide | 0.321 | 0.263 | 0.172 | 0.149 | 0.040 |
| single-hop | 560 | ID+Rerank before | 0.316 | 0.316 | 0.222 | 0.192 | 0.064 |
| single-hop | 560 | ID+Rerank wide | 0.321 | 0.320 | 0.219 | 0.188 | 0.061 |
| single-hop | 560 | TunedHybrid | 0.422 | 0.349 | 0.220 | 0.189 | 0.058 |
| multi-hop | 188 | PureID before | 0.103 | 0.078 | 0.055 | 0.081 | 0.031 |
| multi-hop | 188 | PureID wide | 0.114 | 0.069 | 0.050 | 0.075 | 0.024 |
| multi-hop | 188 | ID+Rerank before | 0.103 | 0.102 | 0.077 | 0.112 | 0.049 |
| multi-hop | 188 | ID+Rerank wide | 0.114 | 0.104 | 0.076 | 0.108 | 0.048 |
| multi-hop | 188 | TunedHybrid | 0.149 | 0.111 | 0.070 | 0.085 | 0.040 |
| temporal | 213 | PureID before | 0.297 | 0.271 | 0.202 | 0.194 | 0.050 |
| temporal | 213 | PureID wide | 0.306 | 0.263 | 0.197 | 0.191 | 0.048 |
| temporal | 213 | ID+Rerank before | 0.297 | 0.292 | 0.200 | 0.182 | 0.060 |
| temporal | 213 | ID+Rerank wide | 0.306 | 0.292 | 0.196 | 0.178 | 0.056 |
| temporal | 213 | TunedHybrid | 0.353 | 0.307 | 0.189 | 0.169 | 0.051 |
| open-domain | 61 | PureID before | 0.112 | 0.102 | 0.066 | 0.064 | 0.023 |
| open-domain | 61 | PureID wide | 0.137 | 0.098 | 0.061 | 0.064 | 0.016 |
| open-domain | 61 | ID+Rerank before | 0.112 | 0.112 | 0.073 | 0.075 | 0.033 |
| open-domain | 61 | ID+Rerank wide | 0.137 | 0.124 | 0.076 | 0.079 | 0.026 |
| open-domain | 61 | TunedHybrid | 0.108 | 0.087 | 0.061 | 0.074 | 0.026 |
| adversarial | 297 | PureID before | 0.310 | 0.283 | 0.199 | 0.175 | 0.041 |
| adversarial | 297 | PureID wide | 0.320 | 0.256 | 0.187 | 0.171 | 0.039 |
| adversarial | 297 | ID+Rerank before | 0.310 | 0.310 | 0.229 | 0.203 | 0.062 |
| adversarial | 297 | ID+Rerank wide | 0.320 | 0.308 | 0.224 | 0.197 | 0.059 |
| adversarial | 297 | TunedHybrid | 0.502 | 0.399 | 0.256 | 0.226 | 0.064 |

## 3. The COST of widening (honest tradeoff)

| Quantity | Before (DEFAULT) | After (WIDE) | Change |
|---|---|---|---|
| mean \|lit\| (auto-halted size) | 13.060 | 20.027 | 1.53× |
| mean recall latency / query (ms) | 0.039 | 0.060 | 1.55× |
| total walk time over test (ms) | 51.201 | 79.382 | — |
| precision@5 (PureID) | 0.042 | 0.038 | -0.004 |
| precision@5 (ID+Rerank) | 0.059 | 0.056 | -0.003 |
| precision@10 (ID+Rerank) | 0.032 | 0.032 | +0.000 |
| recall@1 (ID+Rerank) early rank | 0.095 | 0.093 | -0.002 |

## 4. ID halting behavior — before vs wide (auto-halt vs oracle best-K)

| Quantity | Before (DEFAULT) | After (WIDE) |
|---|---|---|
| mean \|lit\| | 13.060 | 20.027 |
| mean F1 (auto-halt) | 0.044 | 0.031 |
| mean F1 (oracle best-K) | 0.168 | 0.162 |
| F1(auto)/F1(oracle) | 0.403 | 0.364 |
| mean overshoot (\|lit\|−oracleK) | 11.697 | 18.022 |

Auto-halt still OVER-shoots the F1-optimal prefix (by ~18.022 strands wide vs ~11.697 before): widening lifts the recall ceiling but the wider net is even further from the precision-optimal stop, which is exactly why the rerank discriminator (not the energy order) is what converts the wider lit set into recall.

## 5. Verdict

Only the local-saturation **epsilon** moved the lit set: at fixed epsilon, every gamma∈{0.6..0.85} and popCap∈{2000,4000} produced the IDENTICAL lit set / recall@20 (dev trace), because the halt gate thresholds NOVELTY (new independent corroboration), not energy magnitude, and popCap never binds (~20 ≪ 2000). So the frozen wide config is epsilon=0.002 (DEFAULT/10), gamma/popCap unchanged. That lower epsilon lifts the ceiling only modestly: ID+Rerank recall@20 0.272→0.280, narrowing but NOT closing the gap to the frozen hybrid (-0.095 on recall@20; hybrid stays ahead on deep recall + adversarial). Adversarial (n=297) ID+Rerank recall@20 0.310→0.320 vs hybrid 0.502. Multi-hop (n=188) ID+Rerank recall@20 0.103→0.114 vs hybrid 0.149. ID KEEPS its edges: open-domain recall@20 (ID+Rerank 0.137 > hybrid 0.108) and multi-hop nDCG@10. The cost is walk latency (1.55× per query) and a wider, LESS precise auto-halt set (mean |lit| 13.060→20.027, overshoot 11.697→18.022); precision@5 dips (0.059→0.056). NET: widening did NOT flip the deep-recall/adversarial losses — the residual gap is STRUCTURAL graph reach (the evidence turns aren't densely linked to the seed), not the halt threshold; epsilon is the only adapter lever and it is near-exhausted at the grid edge (/10), so further recall needs an engine-level reach change (recommendation), not more walk tuning.
