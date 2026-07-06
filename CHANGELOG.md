# Changelog

All notable changes to Intelligent DB are documented in this file. The project has not yet
cut a tagged release (`package.json` version is pinned at `0.0.0`, `private: true`), so this
log is organized by development era rather than by version number.

Dates are the day of the commit(s), not a release date. Commit hashes refer to `main`.

## [Unreleased]

- 2026-07-06 — full benchmark re-verification in progress: a fresh, from-scratch re-run of
  the FactWorld / PoisonedRAG / retrieval-quality / cross-db / Sybil red-team benchmark suite
  against the current crypto-free engine, to replace the `HISTORICAL` (pre-rebuild) numbers
  called out in `docs/ARCHITECTURE_BENCHMARKS.md`. Tracked in `BENCH_RERUN_2026-07-06.md` and
  `.arbor/sessions/*`; not yet committed as of this writing.
- Repo hygiene pass: `package.json` metadata (description, keywords, repository/homepage/bugs,
  author), this changelog.

## 2026-07-02 — Crypto-free rebuild (Phase 2) and open-source scaffolding

The headline rebuild: the engine drops all cryptographic machinery (keypairs, signing,
Merkle trees, staking) in favor of a crypto-free trust registry that consumes source identity
from configuration, plus a tamper-evident SHA-256 checksum chain for the audit ledger.

- `1537678` **feat: crypto-free rebuild** — trust registry, quarantine ingest, relay fix
  (causal-origin independence classes), dispute horn (pending ledger + owner-override),
  and `explain`/`timeline` introspection verbs. The largest single commit in the project's
  history.
- `00e039f` docs: rewrite for the crypto-free system; move crypto-era docs to `docs/history/`.
- `980993d` chore: open-source scaffolding — LICENSE (Apache-2.0), CI workflow, community docs
  (CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, issue/PR templates).
- `cf43208` docs: professional framing — rename "Honest Record" to "Review Findings", "gap
  list" to "Known Limitations".
- `b1378e9` docs: fix staleness found by the pre-publish cleanup scan.
- `20ecc6a` docs: rewrite `ARCHITECTURE_ENGINE.md` for the current crypto-free engine.
- `eee3763` bench: publish the measured benchmark evidence + reproduction script.
- `6e853c2` chore: rename default branch to `main`; add repository URL to `package.json`.
- `c760a9f` fix: raise the Node floor to `>=22.13` — `node:sqlite` does not exist on Node 20.

## 2026-07-01 — Post-hardening empirical validation

- `3cfa98a` bench: empirical validation suite + non-oracle Sybil defense + progress log.
- `d180b41` docs(bench): fold non-oracle numbers into `ARCHITECTURE_BENCHMARKS.md`.
- `620add8` refactor(bench): unify warm-up ratify count into one shared constant.

## 2026-06-29 — V2 hardening: adversarial red-team fixes

A consensus plan (`V2.md`) to close the red-team breaches found against the crypto-era
system (59 breaches) without regressing the core thesis or performance — landed in six
batches, bringing the breach count down to 25.

- `24f812e` plan: V2.md — consensus plan to fix red-team breaches.
- `2e034aa`/`981c6a3` batch 1: R-primitive, engine-owned-evidence invariant, F1 roots-not-classes
  gate + tests.
- `4fc863e`/`9a3ee0b` batch 2: F2 full-taint disown reversal, F3 intersection guard, OD-7 doc,
  disown-laundering + non-claw guard tests.
- `5bebaa5`/`001abb5` batch 3: F4a multi-class root floor, F4b, dispute-horn rate limit + tests.
- `9b7e8a7`/`b2b74ff` batch 4: M2 depth floor, M3 depth-suppressing scar, M4 depth margin,
  per-pair rate limit, RT-1 numeric + anti-grief reputation tests.
- `a08a218`/`f397653` batch 5: A1 Merkle mutation coverage + leaf cache, A2 wiring, hide-a-disown
  detection tests.
- `2a08e8d`/`9e4b907` batch 6: B1 gated bridge down-weight, B2 ordering, RC-5 approve
  anchor-disjointness + tests.
- `1d4297f` loop-2: fix flaky decay-clock test helpers + disown-downstream scarring.
- `d4f4af1` redteam: port + adapt the 100-attack harness to the V2 API.
- `6ec6a93`/`08aceb0` v2.1: PSL-backed eTLD+1 resolver as the domain-binder default (closes the
  subdomain seam) + both-directions tests.
- `549c0ab` merge: V2 hardening complete (red-team 59 → 25).
- `5a36725`, `6faf95a`, `7dfc759`, `deb343c`, `73ccdd5`, `85c92a2` — behavior-preserving
  cleanup: stray literal NUL bytes, stale stub/deferred comments, fragile line-number
  references, unused imports, deduped provenance-root construction.
- `4474a9f` chore: gitignore internal `.arbor/` run artifacts (kept local, not published).

## 2026-06-28 — Benchmark suite buildout and first red-team assessment

Broad benchmark buildout across retrieval quality, cross-DB comparison, deployment scaling,
and a first formal adversarial red-team pass against the (then crypto-era) system.

- `ca9b74c` bench(capability): 3-arm Sybil-poisoning benchmark (external priced identity vs
  RAG vs passport-only).
- `e5f8d35`/`2ed4ab2`/`7d917be`/`0e884e7`/`768c530` bench(crossdb): cycle 1–2 harness, adapters,
  Docker vector DBs, fair on-disk footprint, Mem0 probe, batched-txn ingest perf, bulk-ingest
  verb, bench clients moved to devDependencies.
- `236eb1b`/`1946e88` bench(deployment): on-disk SQLite/WAL scaling profile (1k–1M rows,
  recall flat).
- `a0ee8d8`/`6ee7c11`/`89fc3cb`/`8c960e1` bench(retrieval): activation-walk vs tuned
  graph+vector hybrid, real LoCoMo arms, wide-net recall-ceiling probe (synthetic + LoCoMo).
- `989a8e7` chore(deps): lock `@huggingface/transformers` (retrieval bench devDependency).
- `a61b05e`/`0c13cb3` bench(librarian): graph-construction ladder (L0/L1/L2/L3) isolating the
  librarian lever.
- `58d6749` bench(retrieval): MultiSeedID vector-kNN seeded activation walk.
- `5a02703`/`0899ea5`/`16102a5` bench(qa): end-task QA harness (LLM reader) + hardened
  Sybil-flood contradiction E2E.
- `6b882ba` docs: correct stale README + `walk.ts` JSDoc; add audit-grounded `PAPER.md` +
  figures.
- `1aa3714` paper: add adversarial red-team limitations (108 attacks, ~55% breach) — the
  baseline the V2 hardening era above was written to fix.

## 2026-06-24 — Initial build (crypto-era)

The first commits: the engine, source-identity layer, and agent-facing surface, all built
against the original crypto-based design (keypairs, signing, Merkle trees, staking) later
replaced by the crypto-free rebuild above.

- `0b7cfcc` Intelligent DB: trust-aware memory substrate for AI agent swarms (initial commit).
- `697b116` identity: wire a real DNS-01 domain-proof prover (`node:dns`).
- `a38e123` bench: add Vitest benchmark harness for the hot paths.
- `4500c60` store(sqlite): batch write APIs (8.3x bulk ingest) + pragma tuning.
- `c4fdcdb` perf(writeFact): eliminate the O(N²) `SHARED_ENTITY` clique (hot-entity cliff).
- `c599bac` agent: cue→seed recall + `AgentMemory` facade + minimal MCP server.
