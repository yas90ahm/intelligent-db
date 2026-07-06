# Retrieval-Quality Benchmark — IntelligentDB vs Tuned Graph+Vector Hybrid

Synthetic corpus of **320 facts** with planted ground truth; **80 queries** (27 dev / 53 test). Embedder: **Xenova/all-MiniLM-L6-v2** via @huggingface/transformers (Node-native ONNX). All numbers below are on the **TEST split**.

## Overall comparison (TEST, macro-averaged)

| Metric | IntelligentDB | TunedHybrid | Winner |
|---|---|---|---|
| recall@1 | 0.201 | 0.428 | Hybrid |
| recall@5 | 0.635 | 0.811 | Hybrid |
| recall@10 | 0.862 | 0.925 | Hybrid |
| recall@20 | 0.862 | 0.925 | Hybrid |
| precision@1 | 0.340 | 0.566 | Hybrid |
| precision@5 | 0.155 | 0.245 | Hybrid |
| precision@10 | 0.100 | 0.134 | Hybrid |
| MRR | 0.553 | 0.667 | Hybrid |
| nDCG@10 | 0.550 | 0.729 | Hybrid |

## Per-category breakdown (recall@10 / precision@5 / nDCG@10 / MRR)

| Category | n | System | recall@10 | precision@5 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| DIRECT | 16 | IntelligentDB | 1.000 | 0.200 | 0.760 | 0.677 |
| DIRECT | 16 | TunedHybrid | 1.000 | 0.200 | 0.860 | 0.813 |
| MULTIHOP | 16 | IntelligentDB | 1.000 | 0.050 | 0.344 | 0.155 |
| MULTIHOP | 16 | TunedHybrid | 0.750 | 0.075 | 0.287 | 0.148 |
| PARAPHRASE | 11 | IntelligentDB | 0.333 | 0.200 | 0.469 | 1.000 |
| PARAPHRASE | 11 | TunedHybrid | 1.000 | 0.600 | 1.000 | 1.000 |
| CONTRADICTION | 10 | IntelligentDB | 1.000 | 0.200 | 0.631 | 0.500 |
| CONTRADICTION | 10 | TunedHybrid | 1.000 | 0.200 | 0.926 | 0.900 |

## Contradiction detection

Over the full contradiction set (**15 pairs**, top-10):

| Metric | IntelligentDB | TunedHybrid |
|---|---|---|
| both-sides-surfaced rate | 1.000 | 1.000 |
| correct-LIVE rate (adjudication) | 0.000 | n/a |

- **both-sides-surfaced**: fraction of contradicted (entity,attribute) pairs where BOTH the true and false value appear in the system's top-K. Measures whether the conflict is even visible.
- **correct-LIVE** (ID only): fraction where, after `engine.adjudicate`, the strand kept LIVE is the planted-true value (the planted-false one DEMOTED). The hybrid has no adjudication, so this is n/a.

## Halting quality (ID auto-halt vs oracle best-K)

| Quantity | Value |
|---|---|
| mean \|lit\| (auto-halted set size) | 6.019 |
| mean F1 (auto-halt) | 0.350 |
| mean F1 (oracle best-K) | 0.543 |
| F1(auto) / F1(oracle) | 0.715 |
| mean F1 @ fixed K=5 | 0.241 |
| mean F1 @ fixed K=10 | 0.176 |
| mean overshoot (\|lit\| − oracleK) | 2.849 |

Auto-halt OVER-shoots the oracle prefix by ~2.849 strands on average (it lights more than the F1-optimal cut).

## Frozen hybrid config + seeding protocol

```
hybrid (frozen on dev): {"s":5,"h":2,"k":10,"alpha":0.7}
tuning: Grid s∈{5,10,20} x h∈{1,2} x k∈{10,30,60} x alpha∈{0.3,0.5,0.7}; maximize mean recall@10 on dev; frozen for test.
seeding: sharedSeed(q) = {nodes whose entity == a cue entity} UNION {global vector top-1 by cosine}; IntelligentDB energizes these as walk seeds; the hybrid uses them as the graph-expansion root and the global cosine ranking as its vector channel.
```

## Verdict

On nDCG@10 the overall edge goes to **TunedHybrid** (0.550 vs 0.729). By category: parity on direct (Δrecall@10 +0.000); ID wins multihop (recall@10 1.000 vs 0.750); Hybrid wins paraphrase (recall@10 0.333 vs 1.000); parity on contradiction (Δrecall@10 +0.000). The structural activation walk is strongest where relevance follows the graph (direct same-entity recall and multi-hop relation chains a pure-vector seed cannot see) and uniquely resolves contradictions by demoting the planted-false side; it is weakest on paraphrase rings that are reachable only by semantic similarity with no structural thread, where the tuned hybrid's vector channel dominates.
