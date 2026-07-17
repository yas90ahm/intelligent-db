# Documentation index

One-screen map of everything under `docs/`. Start at the top and go as deep as you need —
each row says what the file covers and why you'd open it.

## Start here

| Doc | Covers |
|---|---|
| [`../README.md`](../README.md) | Project overview, quickstart, MCP setup, benchmark summary. |
| [`../CLAUDE.md`](../CLAUDE.md) | **Canonical status document**: full mechanics, what's implemented, exact known limitations. Read this before making claims about the system. |
| [`ARCHITECTURE_ENGINE.md`](./ARCHITECTURE_ENGINE.md) | The current (crypto-free) engine architecture, layer by layer, module map, the hard theorem. The technical reference. |

## Benchmarks (the poisoning-resistance evidence)

| Doc | Covers |
|---|---|
| [`ARCHITECTURE_BENCHMARKS.md`](./ARCHITECTURE_BENCHMARKS.md) | The full benchmark suite: the 5 experimental arms (bare/rag/substrate/mem0/hybrid), FactWorld + PoisonedRAG + generalization + reasoning families, metrics, Wilson CIs, reproduction commands, file index. |
| [`INTEGRITY_AUDIT.md`](./INTEGRITY_AUDIT.md) | An adversarial scientific-integrity audit of the benchmark suite itself — every claim checked against file:line, written to be non-defensive. |
| [`RAW_SAMPLES.md`](./RAW_SAMPLES.md) | Raw, immediately-viewable transcripts from the poisoning benchmarks: real question, retrieved context per arm, verbatim model reply, gold/poison answers, per-metric verdicts. |
| [`../BENCH_RERUN_2026-07-06.md`](../BENCH_RERUN_2026-07-06.md) | The 2026-07-06 full re-verification pass against the current engine — the source for every "re-verified" number in the top-level README. |

## July 2026 launch-prep record

This work is useful history, but it is not the current operating guide. It lives under
`history/launch-2026-07/` so old review notes do not look like present instructions.

| Doc | Covers |
|---|---|
| [`history/launch-2026-07/README.md`](./history/launch-2026-07/README.md) | A short note on what this archive is and how to read it. |
| [`history/launch-2026-07/WHAT_IT_IS.md`](./history/launch-2026-07/WHAT_IT_IS.md) | The plain-language framing used during that pass. |
| [`history/launch-2026-07/REBUILD_SUMMARY.md`](./history/launch-2026-07/REBUILD_SUMMARY.md) | What changed during the crypto-free rebuild. |
| [`history/launch-2026-07/BUGFIX_REPORT.md`](./history/launch-2026-07/BUGFIX_REPORT.md) | Defects found in review and the fixes made at the time. |
| [`history/launch-2026-07/REVIEW_FINDINGS.md`](./history/launch-2026-07/REVIEW_FINDINGS.md) | The review log from that work. |

## Positioning and comparisons (`marketing/`)

| Doc | Covers |
|---|---|
| [`marketing/POSITIONING.md`](./marketing/POSITIONING.md) | How the project positions itself: what it is, what stage it's at, who it's for. |
| [`marketing/COMPARISON.md`](./marketing/COMPARISON.md) | Intelligent DB vs. vector DBs / RAG / mem0-style memory, point by point — every number sourced back to `ARCHITECTURE_BENCHMARKS.md` or `CLAUDE.md`. |

## Product (`product/`)

| Doc | Covers |
|---|---|
| [`product/USE_CASES.md`](./product/USE_CASES.md) | Concrete use cases the memory substrate is designed for. |
| [`product/ROADMAP.md`](./product/ROADMAP.md) | Where the project is headed from the current production-grade single-process prototype. |

## Project management (`project-management/`)

| Doc | Covers |
|---|---|
| [`project-management/GOVERNANCE.md`](./project-management/GOVERNANCE.md) | How decisions get made today (single maintainer, Apache-2.0, just launching) and how that's expected to evolve. |
| [`project-management/RELEASE_PROCESS.md`](./project-management/RELEASE_PROCESS.md) | Current release/versioning state and process. |

## Historical (pre-rebuild, crypto-era) — `history/`

Preserved with **HISTORICAL** banners; describes machinery (Ed25519 keys, Merkle audit log,
staking) that no longer exists in the shipped engine. Read only for archaeology — for the
current design, use `ARCHITECTURE_ENGINE.md` and `CLAUDE.md` instead.

| Doc | Covers |
|---|---|
| [`history/ARCHITECTURE.md`](./history/ARCHITECTURE.md) | The original target-architecture plan (four roadmap pillars) an architecture council produced. |
| [`history/ARCHITECTURE_ENGINE_CRYPTO_ERA.md`](./history/ARCHITECTURE_ENGINE_CRYPTO_ERA.md) | The pre-rebuild engine architecture (Ed25519/Merkle/staking). |
| [`history/V2.md`](./history/V2.md) | The panel-consensus plan to plug red-team breaches found against V1, without compromising the thesis. |
| [`history/PRICED_ALTERNATIVES.md`](./history/PRICED_ALTERNATIVES.md) | Standalone analysis of priced-identity alternatives to cryptography. |
| [`history/PROGRESS.md`](./history/PROGRESS.md) | Empirical validation & benchmark-suite progress log, pre-rebuild. |
| [`history/PAPER.md`](./history/PAPER.md) | The pre-rebuild synthesis paper: "Trustworthy Memory for AI Agents via External Priced-Identity Adjudication." |

## Suggested reading order

1. [`../README.md`](../README.md) — what this is, why it exists, quickstart.
2. [`history/launch-2026-07/WHAT_IT_IS.md`](./history/launch-2026-07/WHAT_IT_IS.md) — the thesis in plain language, preserved from the launch-prep pass.
3. [`ARCHITECTURE_ENGINE.md`](./ARCHITECTURE_ENGINE.md) — how it actually works.
4. [`ARCHITECTURE_BENCHMARKS.md`](./ARCHITECTURE_BENCHMARKS.md) — how the poisoning-resistance claims are measured.
5. [`../CLAUDE.md`](../CLAUDE.md) — the exact status and known limitations, for due diligence.
6. `marketing/`, `product/`, `project-management/` and the historical launch record — as needed.
