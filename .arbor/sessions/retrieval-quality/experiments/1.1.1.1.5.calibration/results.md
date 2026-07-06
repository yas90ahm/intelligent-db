# LoCoMo retrieval bench — Phase 1c calibration (finer linear grid + rrf, per-embedder)

**10 conversations**, **5882 turns**; **1981 questions kept**. Split: **662 dev / 1319 test** (mem0 scored **1319**). Gate: **LoCoMo TEST recall@20 >= 0.484 (mem0's measured number, docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md)**.

Frozen embedder-seeded walk: embedSeedK=16, reinforcement=dominance, unionTopN=128 (all unchanged by this task — only scoreMode/weights/embedder are tuned).

## 1. Per-embedder DEV winners (both recorded per spec)

- MiniLM (Xenova/all-MiniLM-L6-v2) winner: **minilm/linear(wCos=0.8,wWalk=0.3,wState=0.1)** — DEV recall@20 = 0.443
- nomic-embed-text (ollama:nomic-embed-text) winner: **nomic/linear(wCos=0.8,wWalk=0.1,wState=0.1)** — DEV recall@20 = 0.493

## 2. Raw DEV winner (pre stuffing-gate) vs FROZEN (post-gate)

Raw winner: **nomic/linear(wCos=0.8,wWalk=0.1,wState=0.1)** — DEV recall@20 = 0.493, stuffingPass=false

**FALLBACK TRIGGERED**: the raw DEV winner FAILED the stuffing-gate eligibility check (does the LIVE incumbent still rank top-5 against 8 cosine-1.0 attacker candidates?) — per spec, it is excluded and the best remaining ELIGIBLE config ships instead.

**FROZEN config: embedder=nomic, scoreMode=rrf, weights={"wCos":0,"wWalk":0,"wState":0.1}, rrfK=60, unionTopN=128 — DEV recall@20 = 0.477**

## 3. Full DEV sweep (26 combos: 13 x 2 embedders)

| embedder | scoreMode | wCos | wWalk | wState | rrfK | recall@20 (DEV) | nDCG@10 (DEV) | stuffingPass | eligible |
|---|---|---|---|---|---|---|---|---|---|
| minilm | linear | 0.8 | 0 | 0.1 | 60 | 0.428 | 0.203 | false | false |
| minilm | linear | 0.8 | 0.05 | 0.1 | 60 | 0.437 | 0.204 | false | false |
| minilm | linear | 0.8 | 0.1 | 0.1 | 60 | 0.440 | 0.207 | false | false |
| minilm | linear | 0.8 | 0.3 | 0.1 | 60 | 0.443 | 0.211 | false | false |
| minilm | linear | 0.9 | 0 | 0.1 | 60 | 0.428 | 0.203 | false | false |
| minilm | linear | 0.9 | 0.05 | 0.1 | 60 | 0.437 | 0.204 | false | false |
| minilm | linear | 0.9 | 0.1 | 0.1 | 60 | 0.440 | 0.206 | false | false |
| minilm | linear | 0.9 | 0.3 | 0.1 | 60 | 0.443 | 0.210 | false | false |
| minilm | linear | 1 | 0 | 0.1 | 60 | 0.428 | 0.203 | false | false |
| minilm | linear | 1 | 0.05 | 0.1 | 60 | 0.437 | 0.204 | false | false |
| minilm | linear | 1 | 0.1 | 0.1 | 60 | 0.440 | 0.205 | false | false |
| minilm | linear | 1 | 0.3 | 0.1 | 60 | 0.443 | 0.210 | false | false |
| minilm | rrf | 0 | 0 | 0.1 | 60 | 0.437 | 0.206 | true | true |
| nomic | linear | 0.8 | 0 | 0.1 | 60 | 0.483 | 0.244 | false | false |
| nomic | linear | 0.8 | 0.05 | 0.1 | 60 | 0.490 | 0.248 | false | false |
| nomic | linear | 0.8 | 0.1 | 0.1 | 60 | 0.493 | 0.251 | false | false |
| nomic | linear | 0.8 | 0.3 | 0.1 | 60 | 0.491 | 0.254 | false | false |
| nomic | linear | 0.9 | 0 | 0.1 | 60 | 0.483 | 0.244 | false | false |
| nomic | linear | 0.9 | 0.05 | 0.1 | 60 | 0.490 | 0.248 | false | false |
| nomic | linear | 0.9 | 0.1 | 0.1 | 60 | 0.493 | 0.251 | false | false |
| nomic | linear | 0.9 | 0.3 | 0.1 | 60 | 0.491 | 0.254 | false | false |
| nomic | linear | 1 | 0 | 0.1 | 60 | 0.483 | 0.244 | false | false |
| nomic | linear | 1 | 0.05 | 0.1 | 60 | 0.490 | 0.247 | false | false |
| nomic | linear | 1 | 0.1 | 0.1 | 60 | 0.493 | 0.250 | false | false |
| nomic | linear | 1 | 0.3 | 0.1 | 60 | 0.491 | 0.253 | false | false |
| nomic | rrf | 0 | 0 | 0.1 | 60 | 0.477 | 0.247 | true | true |

## 4. Full comparison table — TEST split, macro-averaged (same run, frozen embedder)

| Arm | recall@10 | recall@20 | nDCG@10 | MRR |
|---|---|---|---|---|
| PureID | 0.291 | 0.325 | 0.200 | 0.184 |
| TunedHybrid | 0.382 | 0.468 | 0.235 | 0.208 |
| EmbedSeeded | 0.391 | 0.436 | 0.246 | 0.213 |
| Calibrated | 0.385 | 0.481 | 0.242 | 0.221 |
| mem0 | 0.382 | 0.484 | 0.242 | 0.215 |

## 5. Gate verdict

**FALL SHORT** — Calibrated's recall@20 (0.481) is BELOW the gate (>= 0.484). Same-run mem0: 0.484. Reported honestly per instructions — not tuned to pass.
