# LoCoMo retrieval bench — EmbedSeeded arm (Phase-1 retrieval spec §6)

**10 conversations**, **5882 turns**; **1981 questions kept**. Split: **662 dev / 1319 test**. Embedder: **Xenova/all-MiniLM-L6-v2**. Gate: **LoCoMo recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1_RETRIEVAL_SPEC.md)**.

Construction: EmbedSeeded = TunedHybrid's RRF fusion (frozen {s,k,alpha} this run) with its graph channel REPLACED by a real engine.recall() lit-set (activation desc) seeded via createEmbeddingCueResolver (spec §3: baseline entity∪vector-top1 UNION cosine-top-embedSeedK, energy-clamped) and WalkConfig.reinforcement (spec §4a) — both real shipped code paths, not bench reimplementations.

## 1. Full sweep (embedSeedK x reinforcement) — TEST split, macro-averaged

| embedSeedK | reinforcement | recall@10 | recall@20 | nDCG@10 | MRR | recall@20 vs mem0 (0.484) |
|---|---|---|---|---|---|---|
| 8 | dominance | 0.308 | 0.355 | 0.197 | 0.172 | -0.129 |
| 8 | summation | 0.298 | 0.355 | 0.194 | 0.171 | -0.129 |
| 16 | dominance | 0.320 | 0.366 | 0.200 | 0.174 | -0.118 |
| 16 | summation | 0.322 | 0.366 | 0.201 | 0.174 | -0.118 |
| 32 | dominance | 0.320 | 0.366 | 0.200 | 0.174 | -0.118 |
| 32 | summation | 0.322 | 0.366 | 0.201 | 0.174 | -0.118 |

## 2. Winner (max mean recall@20 on DEV) — TEST numbers

**Frozen config: embedSeedK=16, reinforcement=summation**

| Metric | EmbedSeeded (winner) | mem0 | PureID (same run) | TunedHybrid (same run) |
|---|---|---|---|---|
| recall@10 | 0.322 | 0.382 | 0.245 | 0.307 |
| recall@20 | 0.366 | 0.484 | 0.272 | 0.375 |
| nDCG@10 | 0.201 | 0.242 | 0.166 | 0.194 |
| MRR | 0.174 | 0.215 | 0.151 | 0.174 |

## 3. Gate verdict

**FALL SHORT** — winner's recall@20 (0.366) is BELOW the gate (>= 0.484) by 0.118. Reported honestly per instructions — this is not tuned to pass.

## 4. Frozen config + fairness audit

```
hybrid fusion (frozen, reused from TunedHybrid this run): {"s":5,"h":1,"k":10,"alpha":0.5}
embedSeedK grid swept: [8,16,32]
reinforcement grid swept: ["dominance","summation"]
mem0 baseline (from experiments/1.1.1.1.1.mem0/results.md, same LoCoMo split methodology): {"recall10":0.382,"recall20":0.484,"ndcg10":0.242,"mrr":0.215}
```
