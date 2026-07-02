# Retrieval-Quality Benchmark (Cycle B) — Real LoCoMo, 3 arms

**10 conversations**, **5882 turns**; **1981/1986 questions** kept (5 dropped for unresolvable evidence); 2819/2822 evidence turn-ids resolved to the corpus. Split: **662 dev / 1319 test** (stratified by category). Embedder: **Xenova/all-MiniLM-L6-v2**. All numbers below are on the **TEST split**, macro-averaged.

## 1. Three-arm comparison (TEST, macro-averaged)

| Metric | PureID | TunedHybrid | ID+Rerank | Best |
|---|---|---|---|---|
| recall@1 | 0.096 | 0.093 | 0.095 | PureID |
| recall@5 | 0.184 | 0.234 | 0.256 | ID+Rerank |
| recall@10 | 0.245 | 0.307 | 0.271 | TunedHybrid |
| recall@20 | 0.272 | 0.375 | 0.272 | TunedHybrid |
| precision@1 | 0.104 | 0.100 | 0.102 | PureID |
| precision@5 | 0.042 | 0.054 | 0.059 | ID+Rerank |
| precision@10 | 0.028 | 0.036 | 0.032 | TunedHybrid |
| MRR | 0.151 | 0.174 | 0.176 | ID+Rerank |
| nDCG@10 | 0.166 | 0.194 | 0.193 | TunedHybrid |

## 2. Per-LoCoMo-category breakdown (recall@10 / nDCG@10 / MRR)

| Category | n | Arm | recall@10 | nDCG@10 | MRR | precision@5 |
|---|---|---|---|---|---|---|
| single-hop | 560 | PureID | 0.286 | 0.183 | 0.154 | 0.045 |
| single-hop | 560 | TunedHybrid | 0.349 | 0.220 | 0.189 | 0.058 |
| single-hop | 560 | ID+Rerank | 0.316 | 0.222 | 0.192 | 0.064 |
| multi-hop | 188 | PureID | 0.078 | 0.055 | 0.081 | 0.031 |
| multi-hop | 188 | TunedHybrid | 0.111 | 0.070 | 0.085 | 0.040 |
| multi-hop | 188 | ID+Rerank | 0.102 | 0.077 | 0.112 | 0.049 |
| temporal | 213 | PureID | 0.271 | 0.202 | 0.194 | 0.050 |
| temporal | 213 | TunedHybrid | 0.307 | 0.189 | 0.169 | 0.051 |
| temporal | 213 | ID+Rerank | 0.292 | 0.200 | 0.182 | 0.060 |
| open-domain | 61 | PureID | 0.102 | 0.066 | 0.064 | 0.023 |
| open-domain | 61 | TunedHybrid | 0.087 | 0.061 | 0.074 | 0.026 |
| open-domain | 61 | ID+Rerank | 0.112 | 0.073 | 0.075 | 0.033 |
| adversarial | 297 | PureID | 0.283 | 0.199 | 0.175 | 0.041 |
| adversarial | 297 | TunedHybrid | 0.399 | 0.256 | 0.226 | 0.064 |
| adversarial | 297 | ID+Rerank | 0.310 | 0.229 | 0.203 | 0.062 |

## 3. Halting quality (auto-halted lit set vs oracle best-K)

| Quantity | PureID | ID+Rerank |
|---|---|---|
| mean \|lit\| (auto-halted size) | 13.060 | 13.060 |
| mean F1 (auto-halt) | 0.044 | 0.044 |
| mean F1 (oracle best-K) | 0.168 | 0.197 |
| F1(auto)/F1(oracle) | 0.403 | 0.275 |
| mean F1 @ K=5 | 0.067 | 0.094 |
| mean F1 @ K=10 | 0.050 | 0.056 |
| mean overshoot (\|lit\|−oracleK) | 11.697 | 12.265 |

The lit SET (recall ceiling) is identical for PureID and ID+Rerank — reranking only reorders it. Auto-halt OVER-shoots the F1-optimal prefix by ~11.697 strands on average.

## 4. Frozen config + fairness audit

```
hybrid (frozen on dev):  {"s":5,"h":1,"k":10,"alpha":0.5}
rerank blend (frozen):   0.2
hybrid tuning:           grid s∈{5,10,20} × h∈{1,2} × k∈{10,30,60} × alpha∈{0.3,0.5,0.7}; max mean recall@10 on dev.
rerank tuning:           blend∈{0,0.1,0.2,0.3,0.4,0.5,0.7,1} (blend·normActivation + (1−blend)·cosine); max mean nDCG@10 on dev.
entity-extraction rule:  proper-noun phrases: tokens matching /^[A-Z][a-z]{2,}$/ (not in STOPWORDS) merged across consecutive positions, lowercased; the two conversation speaker names excluded as mention keys/cues; mention SHARED_ENTITY edges built for keys with DF in [2,25]. Same rule applied to turns and to question cues.
graph rule:              nodes = turns; CONFIRMED_LINK = same-session adjacency; SHARED_ENTITY = same speaker (engine entity-index sibling fan + graph speaker adjacency) + shared mention (materialized edges).
seeding protocol:        seed(q) = {turns mentioning a cue proper-noun entity} UNION {global vector top-1 by cosine}; the SAME seed is handed to all three arms (ID energizes it as walk seeds; the hybrid uses it as the graph-expansion root; ID+rerank inherits the ID lit set).
category counts (kept):  {"temporal":320,"open-domain":92,"multi-hop":282,"single-hop":841,"adversarial":446}
```

## 5. Verdict

On aggregate nDCG@10 ID+Rerank trails the tuned hybrid by -0.002 (MRR +0.002); pure-ID activation order alone scores nDCG@10 0.166. So adding the cosine ranking discriminator does NOT cleanly let ID match/beat the pure hybrid on ranking. On multi-hop (n=188): PureID recall@10 0.078, Hybrid 0.111, ID+Rerank 0.102 (nDCG@10 0.077 vs Hybrid 0.070). Pure ID's structural reach is a recall ceiling; the rerank inherits that ceiling and adds the ranking signal ID lacks.
