# LoCoMo retrieval bench — Phase 1c D1/D2 isolation diagnostics

**10 conversations**, **5882 turns**; **1981 questions kept**. Split: **662 dev / 1319 test** — diagnostics run on DEV only. Frozen walk: embedSeedK=16, reinforcement=dominance. Frozen unionTopN=128 (1b's frozen width, reused verbatim).

**Diagnostic weights (never shippable): {"wCos":1,"wWalk":0,"wState":0}** — pure cosine over the union pool; drops the wState floor the embedding-stuffing gate requires, by design (measurement only).

## D1 — pure-cosine control (MiniLM sidecar, DEV)

Embedder: **Xenova/all-MiniLM-L6-v2**.

| metric | value |
|---|---|
| recall@10 | 0.328 |
| recall@20 | 0.428 |
| nDCG@10 | 0.203 |
| MRR | 0.190 |

## D2 — embedder parity (nomic-embed-text via Ollama, DEV, identical protocol)

Embedder: **ollama:nomic-embed-text**.

| metric | D1 (MiniLM) | D2 (nomic) | delta (D2-D1) |
|---|---|---|---|
| recall@10 | 0.328 | 0.381 | +0.053 |
| recall@20 | 0.428 | 0.483 | +0.056 |
| nDCG@10 | 0.203 | 0.244 | +0.042 |
| MRR | 0.190 | 0.226 | +0.036 |

## mem0 DEV control

Real mem0 sidecar, same session, scored over **662** DEV questions:

| metric | mem0 (DEV, this run) |
|---|---|
| recall@10 | 0.381 |
| recall@20 | 0.483 |
| nDCG@10 | 0.244 |
| MRR | 0.218 |

## Verdict

D1 recall@20 = **0.428**. Per spec: "If this lands near mem0's DEV number, the linear blend weights were the loss. If it stays near 0.44, the embedder/chunking is the loss. D2-D1 delta on recall@20 = **+0.056** is the embedder's measured contribution, isolated from the weights.
