# Does ID memory make a model better? (reasoning-benchmark harness)

**Thesis under test:** giving a capable model a good *memory* (Intelligent DB) makes it more
accurate than the **same model with no memory** — "if someone is intelligent, good memory
makes them even better." Measured on math, science, and coding benchmarks.

The headline comparison is **`bare` (no memory) vs `substrate` (ID memory)**. `rag` and
`hybrid` are controls answering the follow-up: *is it ID specifically, or would any retrieval
help?*

## How it's a fair test (no leakage)

Each benchmark is split deterministically (by id) into:

- **TEST set** — the first `N` problems. The model is graded on these. They are **held out**.
- **STUDY bank** — every *other* problem (+ its worked solution), loaded into memory.

For each unseen TEST problem, a memory arm recalls the `K` most relevant **studied** problems
and injects them as worked exemplars. Because the test problems are **never in memory**, any
accuracy gain is genuine recall of related-but-unseen examples — not a near-twin of the
question leaking the answer. `bare` recalls nothing (zero-shot). The model, prompt, `K`,
embedder, and study bank are identical across arms — the only variable is *how* each recalls.

## The arms

| arm | how it recalls study-bank exemplars |
|---|---|
| `bare` | nothing — zero-shot (the **no-memory** control) |
| `substrate` | **Intelligent DB**: activation walk seeded at the cosine-nearest studied problems, spread multi-hop over a kNN memory web, cosine-reranked |
| `rag` | vanilla vector RAG: cosine top-K nearest studied problems (1-hop) |
| `hybrid` | in-repo TunedHybrid: RRF of a vector-kNN channel + a ≤h-hop graph channel |
| `mem0` | **external** memory framework ([mem0](https://github.com/mem0ai/mem0)) — fully local (Ollama LLM + embedder, embedded Qdrant), via a Python sidecar. Uses its OWN pipeline, not ours. |

`bare`/`rag`/`substrate`/`hybrid` share the same embeddings (`Xenova/all-MiniLM-L6-v2`) and
study bank. `mem0` is a genuine third-party substrate — it brings its own embedder
(`nomic-embed-text` via Ollama), vector store (Qdrant), and ranking, so it's a fair
"different memory system" rather than ours in disguise.

## The benchmarks

| id | dataset | size | scoring |
|---|---|---|---|
| `math` | MATH-500 | 500 | exact-match on the boxed/final answer |
| `gpqa` | GPQA-diamond (OpenAI public mirror) | 198 | multiple-choice letter match |
| `coding` | HumanEval | 164 | pass@1 — runs the model's code against hidden unit tests |

## Prerequisites (one-time)

1. **Ollama running** with the models pulled:
   ```powershell
   ollama pull qwen2.5:7b ; ollama pull llama3.1:8b ; ollama pull gemma3
   ```
2. **Datasets prepared** (already done — files in `.arbor/cache/reasoning/`). To regenerate
   (Python stdlib only, needs network):
   ```powershell
   python src/__bench__/reasoning/prep_datasets.py .arbor/cache/reasoning
   ```
3. `coding` executes model-generated Python locally via `python` (10s timeout, temp file). It
   is NOT sandboxed against fs/network — fine for your own machine.
4. **For the `mem0` arm only** — an isolated Python venv with mem0 + an Ollama embed model
   (already set up on this machine at `.arbor/venv-mem0`). To recreate elsewhere:
   ```powershell
   python -m venv .arbor\venv-mem0
   .arbor\venv-mem0\Scripts\python.exe -m pip install mem0ai qdrant-client ollama
   ollama pull nomic-embed-text
   ```
   (Skip this if you don't include `mem0` in `REASON_ARMS`.)

## Configure (env vars)

The harness is a **gated** vitest test (a plain `npm test` never loads it).

| env var | default | meaning |
|---|---|---|
| `REASON_BENCH` | (unset) | must be `1` to run |
| `REASON_MODELS` | `qwen2.5:7b` | comma list of Ollama model tags |
| `REASON_BENCHMARKS` | `math,gpqa,coding` | which benchmarks |
| `REASON_ARMS` | `bare,rag,substrate,hybrid` | which arms (add `mem0` to include it; keep `bare` for the Δ) |
| `REASON_N` | `5` | held-out TEST items per benchmark (the rest become the study bank) |
| `REASON_K` | `3` | exemplars recalled per question |
| `REASON_POISON` | `0` | poison rate in [0,1]: fraction of studied problems given an adversarial wrong-answer twin (0 = clean bank) |
| `REASON_STUDY_CAP` | `0` | cap the study-bank size (0 = all). Bounds `mem0` ingest time on big banks. |
| `MEM0_PYTHON` | `.arbor\venv-mem0\Scripts\python.exe` | interpreter for the mem0 sidecar |
| `MEM0_LLM` / `MEM0_EMBED` | `<first model>` / `nomic-embed-text` | mem0's own Ollama models |
| `MEM0_EMBED_DIMS` | `768` | mem0 embedding dims (must match `MEM0_EMBED`) |

## Run it in the background (PowerShell)

```powershell
Start-Job -Name reasonbench -ScriptBlock {
  Set-Location "D:\Intelligent DB"
  $env:REASON_BENCH="1"
  $env:REASON_MODELS="qwen2.5:7b,llama3.1:8b,gemma3"
  $env:REASON_BENCHMARKS="math,gpqa,coding"
  $env:REASON_ARMS="bare,rag,substrate,hybrid,mem0"
  $env:REASON_N="50"
  $env:REASON_K="3"
  npx vitest run src/__bench__/reasoning/runner.test.ts *>&1 |
    Out-File "D:\Intelligent DB\reason_run.log"
}
```

Watch / check / collect:
```powershell
Get-Content "D:\Intelligent DB\reason_run.log" -Wait                          # live tail
Get-Job reasonbench                                                           # Running / Completed
Get-Content "D:\Intelligent DB\.arbor\sessions\reasoning-bench\results.json"
```

For the simplest possible thesis test (no controls), set `REASON_ARMS="bare,substrate"`.

## Poisoned-bank variant (where ID is designed to win) — `REASON_POISON`

A clean study bank rewards any retriever equally. A **poisoned** one is where the Intelligent
DB's identity + contradiction machinery pays off. With `REASON_POISON=0.5`, half the studied
problems get an **adversarial twin**: the same problem from a low-reputation source carrying a
**wrong** solution. The legit entry (trusted source) and its poison twin share an
(entity, attribute) → a contradiction set.

- `substrate` wires reputation (trusted ≫ adversary) and runs the engine's contradiction
  adjudication: the poison is **DEMOTED** and never recalled.
- `rag` / `hybrid` / `mem0` retrieve by similarity and have no contradiction defense → they
  recall poison.

Two things are measured:
1. **Poison-recall rate** (model-independent, clean signal): of the exemplars each arm recalls,
   what fraction are poison? Validated (poison 0.5): `rag ≈ 17–23%`, `mem0 ≈ 25%`,
   **`substrate = 0%`**.
2. **Downstream accuracy** under the poisoned bank: `rag`/`hybrid` accuracy should degrade
   (misled by wrong exemplars) while `substrate` holds up.

Run it (add `REASON_POISON` to either command above):
```powershell
$env:REASON_POISON="0.5"   # then run as normal
```

> Faithful limit (matches the project's hard theorem): ID catches **contradictions/identity**,
> not arbitrary *novel* plausible falsehoods. Poison with no legit twin to contradict is out of
> scope for this variant by design — that's the honest boundary of what the layer can defend.

## Scale / time

~2–4 s per generation on a GPU. Total generations = `models × benchmarks × arms × N`.

| N | gens (3 models × 3 bench × 4 arms) | rough wall-clock |
|---|---|---|
| 30 | ~1,080 | ~45–60 min |
| 50 | ~1,800 | ~1.5–2 hr |
| full | ~9,400 | overnight |

## Output

- Console: a per-`(model, benchmark, arm)` line, the full table, the headline
  **MEMORY vs NO-MEMORY** table (each memory arm's accuracy and its Δ vs `bare`), and — when
  `REASON_POISON>0` — a **POISON RECALL** table (poison fraction recalled per arm).
- `.arbor/sessions/reasoning-bench/results.json`:
  - `rows[]` — `{ model, benchmark, arm, n, correct, accuracy, avgGenMs, totalGenMs }`
  - `deltaVsBare[]` — `{ model, benchmark, arm, accuracy, baselineBare, deltaVsBare }`
    (the thesis number: positive `deltaVsBare` for `substrate` = memory helped)
  - `poison` — `null` when clean; else `{ rate, perBenchmark: { bench: { studyN, poisonN, recall:{arm:{recalled,poison,rate}} } } }`
  - `samples[]` — a few raw model replies for spot-checking

> `results.json` is **overwritten** each run — copy/rename it between configs.

## Reading the result

- `substrate` Δ **> 0** consistently → ID memory makes the model better (thesis supported).
- `substrate` ≈ `rag` ≈ `hybrid` → memory helps, but not ID-specifically (any retrieval does).
- All arms ≈ `bare` → on these self-contained problems, studied exemplars don't move the
  needle (an honest null — these benchmarks reward raw reasoning, not recall). ID's designed
  edge (resisting *poisoned/contradictory* memory) isn't exercised by clean benchmarks.
