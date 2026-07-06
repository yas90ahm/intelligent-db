# Phase 1b — Close the LoCoMo gap: blended presentation ranking (spec)

Owner: product. Status: approved for implementation.
Gate: LoCoMo TEST recall@20 >= 0.484 (mem0's measured number), same-run, with the
Sybil 24/24 and FactWorld 0.0% ASR gates re-passed in blend mode.

## Why seeding alone missed (diagnosis to confirm first)

EmbedSeeded scored 0.366 recall@20 — below TunedHybrid's 0.375 and far from mem0's
0.484. Hypothesis: on LoCoMo, candidate COVERAGE isn't the bottleneck (conversational
cues already hit lexical/entity seeds); the loss is in RANKING — the walk's energy
ordering discards the similarity signal that recall@k rewards. mem0 is evidence that
pure cosine ranks this dataset at ~0.48.

Implementation must START with the diagnostic that confirms or kills this: for the
LoCoMo DEV split, measure (a) coverage — fraction of gold strands present ANYWHERE
in the surfaced candidate set, and (b) ranked recall@20 as shipped. If coverage is
already >= 0.55 while recall@20 is ~0.37, ranking is confirmed as the gap and the
design below applies. If coverage itself is < 0.45, report before proceeding —
the fix would then be candidate generation, not ranking, and the spec's §2 union
term (cosine top-N into candidates) becomes the primary lever instead of the score.

## The thesis line (unchanged, sharpened)

- BELIEF — fact_state, adjudication, independence, reputation, eviction — never
  reads similarity. No exceptions, same as Phase 1.
- PRESENTATION — the order in which already-surfaced, correctly-labeled candidates
  are returned to the caller — MAY use similarity. Ordering a reading list is not
  witnessing. The state labels and provenance travel with every item regardless of
  rank.

## Design

1. `RecallOptions.rankMode: 'walk' | 'blend'`, default `'walk'` (zero behavior
   change unless opted in; the tuned bench arm and the agent facade may opt in
   after the gates pass).
2. Candidate set in blend mode: (walk lit set) UNION (cosine top-N over the
   strand_vectors sidecar, default N=64), deduped by content_hash. The union may
   only ADD candidates — never remove or re-state anything the walk surfaced.
3. Presentation score per candidate:
   `score = wCos * cosine(cue, strand) + wWalk * normalizedWalkEnergy + wState * stateWeight`
   - `normalizedWalkEnergy`: walk energy min-max normalized within this result set;
     0 for union-added candidates the walk never lit.
   - `stateWeight`: LIVE 1.0, PROVISIONAL 0.85, DEMOTED 0.4 (constants, config-
     overridable). This is a PRESENTATION nudge so quarantined floods cannot crowd
     the top ranks; it reads the state, it never sets it.
   - Weights (wCos, wWalk, wState) tuned on the LoCoMo DEV split only; frozen
     before TEST is scored; sweep grid: wCos in {0.5, 0.7, 0.9}, wWalk in
     {0.1, 0.3, 0.5}, wState fixed 0.1 initially.
4. Rendering/labels: unchanged. `CitedFact.fact_state`, provenance, and dispute
   surfacing behave identically in both modes.

## Adversarial gates (all in blend mode)

1. Full default suite + typecheck green (blend off by default keeps this trivial —
   but ALSO run the store matrix once with blend forced on via test config).
2. Sybil crossdb gate (the embedderSybilGate variant): 24/24 must hold with
   rankMode='blend' on the recall path.
3. Embedding-stuffing test extended: attacker writes M near-duplicate payloads
   (cosine ~1.0 to the cue). Assert in blend mode: (a) the LIVE incumbent with
   independent provenance appears in the top-k rendered results; (b) every
   attacker item present is labeled PROVISIONAL (or its true state); (c) belief
   metrics (winning value by independent root count) unchanged vs walk mode.
4. FactWorld substrate quick arm: 0.0% ASR with blend mode active on the recall
   path.

## Measurement

LoCoMo same-run (RETRIEVAL_BENCH + MEM0_BENCH): report walk-mode arms, the new
`Blend` arm, and mem0 across recall@10/@20, nDCG@10, MRR — DEV for tuning, TEST
once, no post-TEST tuning. If the gate number is met, freeze blend weights as the
tuned bench default and update the README day-to-day section with the honest
before/after. If it is not met, report the shortfall and the coverage diagnostic —
do not iterate past the frozen TEST protocol inside this task.
