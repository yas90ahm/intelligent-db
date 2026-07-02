# run-full-reasoning-bench.ps1 — the overnight full-scale reasoning benchmark (4 runs).
#
#   qwen2.5:7b (fast)  x {clean, poison} x full sets x 5 arms, FULL RIGOR (avg@16 AIME, avg@4 GPQA) -> ~20h
#   qwen3:8b  (thinking, slow) x {clean, poison} x full sets x 3 thesis arms, single-sample -> ~16h
#   Thesis arms (bare/rag/substrate) carry avg@k on the noisy sets; controls (hybrid/mem0) single-sample.
#   Each run writes a distinct file: .arbor/sessions/reasoning-bench/full_<model>_<clean|poisonX>.json
#   and a per-run log full_<tag>.log . Per-benchmark checkpoints land in full_<tag>.partial.json .
#
# PREREQS: a local Ollama server with qwen2.5:7b and qwen3:8b pulled (`ollama pull ...`).
#
# IMPORTANT — concurrency: Ollama only runs requests in parallel up to OLLAMA_NUM_PARALLEL.
#   For the FULL_CONCURRENCY below to actually speed things up, START THE OLLAMA SERVER WITH:
#       $env:OLLAMA_NUM_PARALLEL = "4"     # (set in the environment, then restart `ollama serve`
#                                          #  or restart the Ollama app) BEFORE running this script.
#   Without it, requests serialize on the server and the runs take ~3-4x longer.
#
# Run it from anywhere:   pwsh -File scripts/run-full-reasoning-bench.ps1

Set-Location (Split-Path -Parent $PSScriptRoot)   # repo root
$ErrorActionPreference = "Continue"

# ---- shared config ----------------------------------------------------------
$env:FULL_BENCH        = "1"
$env:FULL_BENCHMARKS   = "math,gpqa,coding,aime"
$env:FULL_THESIS_ARMS  = "bare,rag,substrate"
$env:FULL_K            = "3"
$env:FULL_CONCURRENCY  = "4"
$env:FULL_STUDY_CAP    = "2000"
$env:FULL_DEDUP        = "0.92"
$env:FULL_SAMPLES_MATH = "1"
$env:FULL_SAMPLES_CODING = "1"

$test = "src/__bench__/reasoning/fullRunner.test.ts"
$logdir = (Get-Location).Path

function Run-One($model, $poison, $arms, $samplesGpqa, $samplesAime, $npExtra) {
  $env:FULL_MODEL        = $model
  $env:FULL_POISON       = $poison
  $env:FULL_ARMS         = $arms
  $env:FULL_SAMPLES_GPQA = $samplesGpqa
  $env:FULL_SAMPLES_AIME = $samplesAime
  # per-model num_predict overrides (reasoning models need bigger budgets); clear if none.
  Remove-Item Env:FULL_NUMPREDICT_AIME, Env:FULL_NUMPREDICT_MATH, Env:FULL_NUMPREDICT_GPQA, Env:FULL_NUMPREDICT_CODING -ErrorAction SilentlyContinue
  foreach ($kv in $npExtra.GetEnumerator()) { Set-Item -Path ("Env:" + $kv.Key) -Value $kv.Value }

  if ([double]$poison -gt 0) { $cond = "poison$poison" } else { $cond = "clean" }
  $tag = ($model -replace '[^A-Za-z0-9._-]+','_') + "_" + $cond
  $log = Join-Path $logdir "full_$tag.log"
  Write-Host "=== RUN: model=$model poison=$poison gpqa@$samplesGpqa aime@$samplesAime -> $log ==="
  npx vitest run $test *>&1 | Tee-Object -FilePath $log
  Write-Host "=== DONE: $tag ==="
}

# ---- the 4 runs (qwen2.5 pair first → headline result in ~20h) ---------------
$allArms    = "bare,rag,substrate,hybrid,mem0"
$thesisArms = "bare,rag,substrate"

# qwen2.5:7b — fast instruct model: FULL RIGOR — all 5 arms, avg@16 AIME, avg@4 GPQA.
Run-One "qwen2.5:7b" "0"   $allArms "4" "16" @{}
Run-One "qwen2.5:7b" "0.5" $allArms "4" "16" @{}

# qwen3:8b — thinking model (slow): TRIMMED — thesis arms only, single-sample, bigger budgets.
$qwen3np = @{ FULL_NUMPREDICT_AIME = "6144"; FULL_NUMPREDICT_MATH = "4096"; FULL_NUMPREDICT_GPQA = "4096"; FULL_NUMPREDICT_CODING = "3072" }
Run-One "qwen3:8b" "0"   $thesisArms "1" "1" $qwen3np
Run-One "qwen3:8b" "0.5" $thesisArms "1" "1" $qwen3np

Write-Host "ALL RUNS COMPLETE. Results: .arbor/sessions/reasoning-bench/full_*.json"
