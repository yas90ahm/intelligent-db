# Phase 1c — Ranking calibration + embedder parity (spec)

Owner: product. Status: approved. This is a NEW iteration with new hypotheses and a
fresh DEV-tune/TEST-once protocol — not post-TEST tuning of 1b (whose frozen result,
0.419, stands as reported).

## What 1b proved

Union coverage on TEST is 0.819 — candidate generation is SOLVED. recall@20 is 0.419 —
the remaining loss vs mem0 (0.484) is ranking placement inside an 82%-coverage pool,
possibly compounded by embedder asymmetry: our sidecar used MiniLM
(Xenova/all-MiniLM-L6-v2) while mem0 ran nomic-embed-text.

## Hypotheses to isolate (run these DEV diagnostics FIRST, in this order)

D1. **Pure-cosine control**: rank the 1b union pool by cosine alone (wCos=1, wWalk=0,
    wState=0 — DIAGNOSTIC ONLY, never shippable, see Gate note) on DEV with the
    MiniLM sidecar. If this lands near mem0's DEV number, the linear blend weights
    were the loss. If it stays near 0.44, the embedder/chunking is the loss.
D2. **Embedder parity**: rebuild the sidecar with nomic-embed-text via the Ollama
    reference embedder (same model mem0 used) and repeat D1. The delta D2-D1 is the
    embedder's contribution.
Report both before tuning anything.

## Design changes allowed this iteration

1. `PresentationScoreMode: 'linear' | 'rrf'`. RRF (reciprocal-rank fusion,
   k=60 default) fuses the candidate's COSINE RANK and WALK-ENERGY RANK instead of
   mixing raw scores — rank fusion is scale-free and typically beats hand-tuned
   linear mixes when signals have mismatched distributions. stateWeight applies as
   a post-fusion multiplier in both modes.
2. Finer linear grid where D1/D2 indicate: wCos in {0.8, 0.9, 1.0},
   wWalk in {0.0, 0.05, 0.1, 0.3}, wState fixed 0.1.
3. Embedder for the shipped config: whichever of MiniLM / nomic-embed-text wins on
   DEV (embedder choice is config, not architecture — record both numbers).

## Gate note (unchanged invariants, one addition)

All 1b gates re-run on the winning config (Sybil blend 24/24, FactWorld 0.0% ASR,
extended stuffing). ADDITION: any SHIPPED config must keep wState >= 0.1 (or the
RRF post-multiplier equivalent) — the pure-cosine diagnostic arm intentionally
drops the state nudge and would fail the stuffing gate; it exists to measure, not
to ship. The stuffing gate is the reason wWalk=0 configs are suspect: if the DEV
winner has wWalk=0, the stuffing gate decides whether it is shippable — if it
fails, the best wWalk>0 config ships instead. Belief isolation is untouched
either way.

## Protocol

DEV for all diagnostics and tuning. Freeze ONE config (mode, weights, embedder,
unionTopN). Score TEST once, same-run with mem0 and the walk arms. Target: TEST
recall@20 >= 0.484. Whatever the outcome, report it plainly; if met, update the
README day-to-day paragraph with the win in the same honest register the loss was
reported in, and freeze the config as the tuned default for the bench arm and the
agent facade's opt-in blend mode.
