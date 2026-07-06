# Phase 1b diagnostic — LoCoMo DEV coverage vs recall@20 ("Why seeding alone missed")

**10 conversations**, **5882 turns**; **662 DEV questions**. Embedder: **Xenova/all-MiniLM-L6-v2**. Frozen TunedHybrid config: `{"s":5,"h":1,"k":10,"alpha":0.5}`. EmbedSeeded winner: `{"embedSeedK":16,"reinforcement":"summation"}`.

## 1. Headline table (DEV, macro-averaged)

| Arm | coverage (candidate-set) | recall@20 (as shipped) | gap (coverage − recall@20) |
|---|---|---|---|
| TunedHybrid | 0.560 | 0.387 | 0.173 |
| EmbedSeeded | 0.397 | 0.397 | 0.000 |
| cosine-top-64-only | 0.674 | n/a (coverage-only reference) | — |

Published (honest) TEST-split numbers for context: TunedHybrid recall@20=0.375, EmbedSeeded recall@20=0.366. Both arms are grid-tuned AND measured on DEV in this diagnostic (fast pre-flight check per the spec's own instruction to run this diagnostic on the DEV split); this is mildly optimistic vs the held-out TEST numbers reported alongside for context.

## 2. Per-category breakdown

| Category | n | TunedHybrid coverage | TunedHybrid recall@20 | EmbedSeeded coverage | EmbedSeeded recall@20 | cos-top-64 coverage |
|---|---|---|---|---|---|---|
| single-hop | 281 | 0.559 | 0.403 | 0.417 | 0.417 | 0.690 |
| multi-hop | 94 | 0.308 | 0.153 | 0.198 | 0.198 | 0.467 |
| temporal | 107 | 0.495 | 0.388 | 0.422 | 0.422 | 0.696 |
| open-domain | 31 | 0.332 | 0.185 | 0.194 | 0.194 | 0.447 |
| adversarial | 149 | 0.815 | 0.547 | 0.507 | 0.507 | 0.805 |

## 3. Verdict (spec decision rule: coverage >= 0.55 => ranking-bound; coverage < 0.45 => coverage-bound)

- **TunedHybrid**: coverage 0.560, recall@20 0.387 => **ranking-bound**
- **EmbedSeeded**: coverage 0.397, recall@20 0.397 => **coverage-bound**

## 4. EmbedSeeded sweep (DEV, all embedSeedK x reinforcement configs)

| embedSeedK | reinforcement | recall@10 | recall@20 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| 8 | dominance | 0.326 | 0.369 | 0.204 | 0.179 |
| 8 | summation | 0.312 | 0.369 | 0.199 | 0.178 |
| 16 | dominance | 0.345 | 0.397 | 0.210 | 0.182 |
| 16 | summation | 0.346 | 0.397 | 0.210 | 0.183 |
| 32 | dominance | 0.345 | 0.392 | 0.210 | 0.182 |
| 32 | summation | 0.346 | 0.392 | 0.210 | 0.183 |

## 5. Definitions + fairness audit

```
candidate-set definition: TunedHybrid: top-cfg.s cosine ids UNION graphExpand(seed, cfg.h) ids (the two maps hybridRetrieveFromSeed RRF-fuses before sorting). EmbedSeeded: same top-cfg.s cosine ids UNION the embedder-seeded engine.recall lit set (activation desc) — the two maps the shipped EmbedSeeded arm RRF-fuses before sorting. Both are measured BEFORE the recall@20 truncation.
cosine-top-64 definition: VectorSidecar.topK(cueVec, MODEL_ID, 64) mapped back to turn ids via content_hash — pure brute-force cosine, no walk/graph/entity seed at all (spec §2's default N=64 union candidate count in isolation).
frozen TunedHybrid config (dev-tuned, max mean recall@10): {"s":5,"h":1,"k":10,"alpha":0.5}
EmbedSeeded winner (dev-tuned, max mean recall@20): {"embedSeedK":16,"reinforcement":"summation"}
```
