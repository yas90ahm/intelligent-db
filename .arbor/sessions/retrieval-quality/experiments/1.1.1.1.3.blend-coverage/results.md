# LoCoMo Blend arm — coverage diagnostic (frozen config, read-only)

Frozen: embedSeedK=16, reinforcement=dominance, blend weights={"wCos":0.9,"wWalk":0.3,"wState":0.1}, unionTopN=128.

| split | arm | coverage (full candidate set) | recall@20 (top-20 cut) |
|---|---|---|---|
| DEV | EmbedSeeded (walk only) | 0.392 | 0.392 |
| DEV | Blend (walk UNION cosine-top-128) | 0.839 | 0.443 |
| TEST | EmbedSeeded (walk only) | 0.362 | 0.362 |
| TEST | Blend (walk UNION cosine-top-128) | 0.819 | 0.419 |

Coverage = fraction of a question's gold evidence-turn ids present ANYWHERE in the arm's full (untruncated) candidate set (the recall@infinity ceiling); recall@20 is the same arm's actual top-20 output. A coverage-recall@20 gap is a RANKING cost (evidence was surfaced but not in the top 20); coverage itself below ~0.45-0.55 points at candidate generation, not ranking, as the remaining lever (spec's decision rule, `locomoCoverageDiagnostic.test.ts`).
