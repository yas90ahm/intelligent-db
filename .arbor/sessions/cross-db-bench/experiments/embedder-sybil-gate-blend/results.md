# CROSSDB_BENCH Sybil — WITH the Ollama embedder, rankMode='blend' (Phase 1b spec §2 gate)

24 attack trials (H=3 honest, A in {5, 50, 200}, 8 trials each) — IDENTICAL scenario generator + worst-case cosine-only seeding to the walk-mode gate. The lit set is then re-ranked through the real Phase 1b `rankRecallResult(..., { rankMode: 'blend' })` before the winning value is computed.

**Result: 24/24 correct; 24/24 belief-unchanged vs walk mode.**

| A | trial | lit (walk) | lit (blend) | winner (blend) | winner (walk) | correct | unchanged vs walk |
|---|---|---|---|---|---|---|---|
| 5 | 5:0 | 8 | 2 | TRUE:5:0 | TRUE:5:0 | yes | yes |
| 5 | 5:1 | 16 | 4 | TRUE:5:1 | TRUE:5:1 | yes | yes |
| 5 | 5:2 | 24 | 6 | TRUE:5:2 | TRUE:5:2 | yes | yes |
| 5 | 5:3 | 32 | 8 | TRUE:5:3 | TRUE:5:3 | yes | yes |
| 5 | 5:4 | 40 | 10 | TRUE:5:4 | TRUE:5:4 | yes | yes |
| 5 | 5:5 | 48 | 12 | TRUE:5:5 | TRUE:5:5 | yes | yes |
| 5 | 5:6 | 56 | 14 | TRUE:5:6 | TRUE:5:6 | yes | yes |
| 5 | 5:7 | 64 | 16 | TRUE:5:7 | TRUE:5:7 | yes | yes |
| 50 | 50:0 | 117 | 18 | TRUE:50:0 | TRUE:50:0 | yes | yes |
| 50 | 50:1 | 170 | 20 | TRUE:50:1 | TRUE:50:1 | yes | yes |
| 50 | 50:2 | 223 | 22 | TRUE:50:2 | TRUE:50:2 | yes | yes |
| 50 | 50:3 | 276 | 24 | TRUE:50:3 | TRUE:50:3 | yes | yes |
| 50 | 50:4 | 329 | 26 | TRUE:50:4 | TRUE:50:4 | yes | yes |
| 50 | 50:5 | 382 | 28 | TRUE:50:5 | TRUE:50:5 | yes | yes |
| 50 | 50:6 | 435 | 30 | TRUE:50:6 | TRUE:50:6 | yes | yes |
| 50 | 50:7 | 488 | 32 | TRUE:50:7 | TRUE:50:7 | yes | yes |
| 200 | 200:0 | 691 | 34 | TRUE:200:0 | TRUE:200:0 | yes | yes |
| 200 | 200:1 | 894 | 36 | TRUE:200:1 | TRUE:200:1 | yes | yes |
| 200 | 200:2 | 1097 | 38 | TRUE:200:2 | TRUE:200:2 | yes | yes |
| 200 | 200:3 | 1300 | 40 | TRUE:200:3 | TRUE:200:3 | yes | yes |
| 200 | 200:4 | 1503 | 42 | TRUE:200:4 | TRUE:200:4 | yes | yes |
| 200 | 200:5 | 1706 | 44 | TRUE:200:5 | TRUE:200:5 | yes | yes |
| 200 | 200:6 | 1909 | 46 | TRUE:200:6 | TRUE:200:6 | yes | yes |
| 200 | 200:7 | 2000 | 48 | TRUE:200:7 | TRUE:200:7 | yes | yes |

The winning value is computed the SAME way in both modes — max independence-weighted root count (`identity.independentRootCount`) over each value's provenance. Blend mode widens/reorders the PRESENTATION of the lit set (cosine-heavy score, union-added candidates) but never touches this computation's inputs in a way that changes the outcome: belief stays a function of independence, never similarity.
