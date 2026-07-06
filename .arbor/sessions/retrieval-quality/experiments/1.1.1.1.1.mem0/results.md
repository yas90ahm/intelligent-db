# LoCoMo retrieval bench — mem0 competitor arm (same-run vs 4 IDB arms)

**10 conversations**, **5882 turns**; **1981 questions kept**. Split: **662 dev / 1319 test**. mem0 scored **1319/1319** TEST questions (mem0: llm=qwen2.5:7b, embed=nomic-embed-text(768d), fully local Ollama+embedded-Qdrant; IDB embedder: Xenova/all-MiniLM-L6-v2). All numbers below are on the TEST split, macro-averaged.

mem0 ingest: **5882 items** in 137757ms (**43 items/sec**). mem0 search: 1319 queries, 30860ms total (mean 23.4ms/query). Total mem0 wall time: 199808ms.

## 1. Five-arm comparison (TEST, macro-averaged)

| Metric | PureID | ID+Rerank | MultiSeedID | TunedHybrid | mem0 | Best |
|---|---|---|---|---|---|---|
| recall@1 | 0.096 | 0.095 | 0.093 | 0.093 | 0.114 | mem0 |
| recall@5 | 0.184 | 0.256 | 0.217 | 0.234 | 0.293 | mem0 |
| recall@10 | 0.245 | 0.271 | 0.282 | 0.307 | 0.382 | mem0 |
| recall@20 | 0.272 | 0.272 | 0.324 | 0.375 | 0.484 | mem0 |
| precision@1 | 0.104 | 0.102 | 0.100 | 0.100 | 0.125 | mem0 |
| precision@5 | 0.042 | 0.059 | 0.050 | 0.054 | 0.066 | mem0 |
| precision@10 | 0.028 | 0.032 | 0.033 | 0.036 | 0.044 | mem0 |
| MRR | 0.151 | 0.176 | 0.165 | 0.174 | 0.215 | mem0 |
| nDCG@10 | 0.166 | 0.193 | 0.185 | 0.194 | 0.242 | mem0 |

## 2. Per-LoCoMo-category breakdown (recall@10 / nDCG@10 / MRR)

| Category | n | Arm | recall@10 | nDCG@10 | MRR | precision@5 |
|---|---|---|---|---|---|---|
| single-hop | 560 | PureID | 0.286 | 0.183 | 0.154 | 0.045 |
| single-hop | 560 | ID+Rerank | 0.316 | 0.222 | 0.192 | 0.064 |
| single-hop | 560 | MultiSeedID | 0.320 | 0.209 | 0.182 | 0.054 |
| single-hop | 560 | TunedHybrid | 0.349 | 0.220 | 0.189 | 0.058 |
| single-hop | 560 | mem0 (n=560) | 0.435 | 0.264 | 0.223 | 0.069 |
| multi-hop | 188 | PureID | 0.078 | 0.055 | 0.081 | 0.031 |
| multi-hop | 188 | ID+Rerank | 0.102 | 0.077 | 0.112 | 0.049 |
| multi-hop | 188 | MultiSeedID | 0.103 | 0.065 | 0.079 | 0.031 |
| multi-hop | 188 | TunedHybrid | 0.111 | 0.070 | 0.085 | 0.040 |
| multi-hop | 188 | mem0 (n=188) | 0.112 | 0.070 | 0.083 | 0.034 |
| temporal | 213 | PureID | 0.271 | 0.202 | 0.194 | 0.050 |
| temporal | 213 | ID+Rerank | 0.292 | 0.200 | 0.182 | 0.060 |
| temporal | 213 | MultiSeedID | 0.246 | 0.172 | 0.163 | 0.049 |
| temporal | 213 | TunedHybrid | 0.307 | 0.189 | 0.169 | 0.051 |
| temporal | 213 | mem0 (n=213) | 0.389 | 0.243 | 0.224 | 0.071 |
| open-domain | 61 | PureID | 0.102 | 0.066 | 0.064 | 0.023 |
| open-domain | 61 | ID+Rerank | 0.112 | 0.073 | 0.075 | 0.033 |
| open-domain | 61 | MultiSeedID | 0.132 | 0.086 | 0.090 | 0.026 |
| open-domain | 61 | TunedHybrid | 0.087 | 0.061 | 0.074 | 0.026 |
| open-domain | 61 | mem0 (n=61) | 0.149 | 0.099 | 0.103 | 0.036 |
| adversarial | 297 | PureID | 0.283 | 0.199 | 0.175 | 0.041 |
| adversarial | 297 | ID+Rerank | 0.310 | 0.229 | 0.203 | 0.062 |
| adversarial | 297 | MultiSeedID | 0.379 | 0.243 | 0.203 | 0.059 |
| adversarial | 297 | TunedHybrid | 0.399 | 0.256 | 0.226 | 0.064 |
| adversarial | 297 | mem0 (n=297) | 0.495 | 0.338 | 0.299 | 0.084 |

## 3. Frozen config + fairness audit

```
hybrid (frozen this run):     {"s":5,"h":1,"k":10,"alpha":0.5}
rerank blend (frozen):        0.2
multi-seed k (frozen):        20
mem0 search top_k:            20
fairness:                     mem0 gets ONE sidecar (embedded-Qdrant collection) per LoCoMo conversation, built from that conversation's turns only (mem.add(text, infer=False) — same-run ingest, no LLM summarization), and is queried ONLY with that conversation's TEST question cue texts (mem.search) — the same conversation-scoping the 4 IDB arms get for free from their per-conversation graph/store. The 4 IDB arms (PureID / ID+Rerank / MultiSeedID / TunedHybrid) are re-tuned on DEV and re-scored on TEST in THIS SAME run (identical methodology to experiments/1.1 and 1.1.1.1.1) so every number in this report comes from one process invocation.
```

## 4. Verdict

mem0 recall@10 0.382 vs TunedHybrid 0.307 (+0.075); nDCG@10 0.242 vs 0.194 (+0.048). mem0 beats the frozen tuned hybrid on recall@10 on this run.
