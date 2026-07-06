# LoCoMo retrieval bench — Blend arm (Phase 1b Measurement)

**10 conversations**, **5882 turns**; **1981 questions kept**. Split: **662 dev / 1319 test** (mem0 scored **1319**). Embedder: **Xenova/all-MiniLM-L6-v2**. Gate: **LoCoMo recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1B_RANKING_SPEC.md)**.

Frozen embedder-seeded walk: embedSeedK=16, reinforcement=dominance (Phase-1 defaults, not re-tuned here). Frozen TunedHybrid config: {"s":5,"h":1,"k":10,"alpha":0.5}.

**Frozen Blend config: weights={"wCos":0.9,"wWalk":0.3,"wState":0.1}, unionTopN=128**

## 1. DEV sweep (wCos x wWalk x unionTopN) — recall@20 / nDCG@10

| wCos | wWalk | wState | unionTopN | recall@20 (DEV) | nDCG@10 (DEV) |
|---|---|---|---|---|---|
| 0.5 | 0.1 | 0.1 | 32 | 0.435 | 0.209 |
| 0.5 | 0.1 | 0.1 | 64 | 0.439 | 0.209 |
| 0.5 | 0.1 | 0.1 | 128 | 0.442 | 0.209 |
| 0.5 | 0.3 | 0.1 | 32 | 0.442 | 0.209 |
| 0.5 | 0.3 | 0.1 | 64 | 0.442 | 0.210 |
| 0.5 | 0.3 | 0.1 | 128 | 0.442 | 0.211 |
| 0.5 | 0.5 | 0.1 | 32 | 0.442 | 0.211 |
| 0.5 | 0.5 | 0.1 | 64 | 0.442 | 0.211 |
| 0.5 | 0.5 | 0.1 | 128 | 0.442 | 0.212 |
| 0.7 | 0.1 | 0.1 | 32 | 0.435 | 0.208 |
| 0.7 | 0.1 | 0.1 | 64 | 0.439 | 0.209 |
| 0.7 | 0.1 | 0.1 | 128 | 0.441 | 0.209 |
| 0.7 | 0.3 | 0.1 | 32 | 0.439 | 0.210 |
| 0.7 | 0.3 | 0.1 | 64 | 0.439 | 0.211 |
| 0.7 | 0.3 | 0.1 | 128 | 0.442 | 0.211 |
| 0.7 | 0.5 | 0.1 | 32 | 0.442 | 0.210 |
| 0.7 | 0.5 | 0.1 | 64 | 0.442 | 0.210 |
| 0.7 | 0.5 | 0.1 | 128 | 0.442 | 0.212 |
| 0.9 | 0.1 | 0.1 | 32 | 0.435 | 0.206 |
| 0.9 | 0.1 | 0.1 | 64 | 0.439 | 0.206 |
| 0.9 | 0.1 | 0.1 | 128 | 0.440 | 0.206 |
| 0.9 | 0.3 | 0.1 | 32 | 0.437 | 0.209 |
| 0.9 | 0.3 | 0.1 | 64 | 0.439 | 0.211 |
| 0.9 | 0.3 | 0.1 | 128 | 0.443 | 0.210 |
| 0.9 | 0.5 | 0.1 | 32 | 0.442 | 0.210 |
| 0.9 | 0.5 | 0.1 | 64 | 0.442 | 0.210 |
| 0.9 | 0.5 | 0.1 | 128 | 0.442 | 0.211 |

## 2. Full comparison table — TEST split, macro-averaged (same run)

| Arm | recall@10 | recall@20 | nDCG@10 | MRR |
|---|---|---|---|---|
| PureID | 0.245 | 0.272 | 0.166 | 0.151 |
| TunedHybrid | 0.307 | 0.375 | 0.194 | 0.174 |
| EmbedSeeded | 0.320 | 0.362 | 0.203 | 0.177 |
| Blend | 0.322 | 0.419 | 0.203 | 0.188 |
| mem0 | 0.382 | 0.484 | 0.242 | 0.215 |

## 3. Gate verdict

**FALL SHORT** — Blend's recall@20 (0.419) is BELOW the gate (>= 0.484). Same-run mem0: 0.484. Reported honestly per instructions — not tuned to pass.

mem0's previously-published same-run number (cross-reference only): {"recall10":0.382,"recall20":0.484,"ndcg10":0.242,"mrr":0.215}
