# CROSSDB_BENCH Sybil — WITH the Ollama embedder configured (spec §5.2 gate)

24 attack trials (H=3 honest, A in {5, 50, 200}, 8 trials each) — identical scenario generator to the published crossdb baseline. Seeding is WORST-CASE adversarial: `engine.recall()` is seeded PURELY by Ollama cosine-similarity top-64 (no entity/lexical boost at all), so every candidate strand — honest AND cheap-Sybil alike — must win its seed slot by similarity.

**Result: 24/24 correct.**

| A | trial | lit set size | winner | correct |
|---|---|---|---|---|
| 5 | 5:0 | 8 | TRUE:5:0 | yes |
| 5 | 5:1 | 16 | TRUE:5:1 | yes |
| 5 | 5:2 | 24 | TRUE:5:2 | yes |
| 5 | 5:3 | 32 | TRUE:5:3 | yes |
| 5 | 5:4 | 40 | TRUE:5:4 | yes |
| 5 | 5:5 | 48 | TRUE:5:5 | yes |
| 5 | 5:6 | 56 | TRUE:5:6 | yes |
| 5 | 5:7 | 64 | TRUE:5:7 | yes |
| 50 | 50:0 | 117 | TRUE:50:0 | yes |
| 50 | 50:1 | 170 | TRUE:50:1 | yes |
| 50 | 50:2 | 223 | TRUE:50:2 | yes |
| 50 | 50:3 | 276 | TRUE:50:3 | yes |
| 50 | 50:4 | 329 | TRUE:50:4 | yes |
| 50 | 50:5 | 382 | TRUE:50:5 | yes |
| 50 | 50:6 | 435 | TRUE:50:6 | yes |
| 50 | 50:7 | 488 | TRUE:50:7 | yes |
| 200 | 200:0 | 691 | TRUE:200:0 | yes |
| 200 | 200:1 | 894 | TRUE:200:1 | yes |
| 200 | 200:2 | 1097 | TRUE:200:2 | yes |
| 200 | 200:3 | 1300 | TRUE:200:3 | yes |
| 200 | 200:4 | 1503 | TRUE:200:4 | yes |
| 200 | 200:5 | 1706 | TRUE:200:5 | yes |
| 200 | 200:6 | 1909 | TRUE:200:6 | yes |
| 200 | 200:7 | 2000 | TRUE:200:7 | yes |

The winning value is computed the SAME way the published crossdb bench does — max independence-weighted root count (`identity.independentRootCount`) over each value's provenance, H honest facts in DISTINCT classes vs A cheap-Sybil facts sharing ONE class — but the CANDIDATE SET now comes from a real embedder-seeded activation walk instead of a raw index scan. A poisoned near-duplicate payload can (and does) win a seed slot; it never wins the belief ranking, because belief is never a function of similarity.
