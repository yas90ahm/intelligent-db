# Contributing to Intelligent DB

Thanks for your interest in Intelligent DB — a memory substrate for AI agents built on
spreading activation over a provenance graph, not nearest-neighbor vector search. Before
diving into code, please read [CLAUDE.md](./CLAUDE.md); it is the canonical design and
status document (architecture, the four implemented pillars, and the known-limitations list) and
everything below assumes you've skimmed it. For the current roadmap built on that gap
list, see `docs/product/ROADMAP.md`.

## Ground rules

- **This is a single-maintainer prototype, not yet a community project with SLAs.**
  Response times on issues/PRs are best-effort. See `docs/project-management/GOVERNANCE.md`
  for how decisions are made and how that may evolve as trusted contributors join.
- **`src/core/types.ts` and the resolved architecture in CLAUDE.md are settled.** Read the
  "Core architecture (settled — do not relitigate)" section before proposing changes to
  the traversal-halting mechanics, the forgetting floor, or the source-identity model —
  these were adversarially reviewed and the tradeoffs are documented, not accidental.
  Bug fixes and hardening within that architecture are very welcome; proposals to
  relitigate the settled design should be opened as a discussion/issue first, not a PR.
  `docs/project-management/GOVERNANCE.md` calls this class of change "Class 2"
  (architecture-affecting) versus ordinary "Class 1" implementation work — skim it if
  you're unsure which bucket your change falls in.

## Before you start: open an issue first

For anything beyond a trivial fix (typo, obvious bug, small test), please open an issue
describing the problem or proposal before writing code. This avoids wasted work on PRs
that don't fit the project's direction. Use the issue templates under
`.github/ISSUE_TEMPLATE/`.

## Development setup

Requires Node `>=20` (developed and tested on Node 24, per README). The library itself is
**zero-runtime-dependency** — only `node:` builtins ship in `dist/`; the packages in
`devDependencies` (better-sqlite3, duckdb, qdrant client, transformers, pg, redis, lmdb)
exist solely to power the competitive benchmark harness under `src/__bench__/` and are
never imported by the shipped engine.

```sh
git clone <your fork>
cd intelligent-db
npm install
```

## Required checks — must be green before you open a PR

```sh
npm run typecheck   # tsc --noEmit — strict + NodeNext + verbatimModuleSyntax + exactOptionalPropertyTypes
npm test             # vitest run — the full test suite (see CLAUDE.md for the current count)
```

Both are run in CI (`.github/workflows/ci.yml`) on every push and pull request against
`main` or `master`. A PR that fails either check will not be merged. If you touch benchmark code,
also sanity-check `npm run bench` locally — the benchmark suites are env-gated
(`CROSSDB_BENCH`, `DEPLOY_BENCH`, `RETRIEVAL_BENCH`, `QA_BENCH`) and are not part of the
default CI run because they pull in heavy optional dependencies and external services.

`npm run build` (`tsc -p tsconfig.build.json` → `dist/`, tests and benches excluded)
should also succeed; CI runs it as a smoke check that the shipped artifact compiles cleanly.

Do not hand-quote suite/benchmark counts outside CLAUDE.md; link instead.

## Code style and philosophy

This codebase has an explicit, hard-won ethos — please write to it, not around it:

- **No loud `TODO` stubs land on `main`.** CLAUDE.md's history is blunt about this: "The
  'loud `TODO(crack-A/B)` stub' era is over." If a piece of behavior isn't implemented,
  either implement it, or explicitly scope it out in the code and in the known-limitations list —
  never leave a silently-incomplete stub pretending to be done. A partial implementation
  with a clearly labeled limitation is fine; a `// TODO: fix this later` guarding a real
  correctness gap is not mergeable.
- **Fail-closed vs fail-open is a deliberate, per-subsystem choice — don't flip it by
  accident.** Eviction (`forgetting/tiers.ts`) fails **closed** (missing/stale/uncertain
  evidence keeps the strand). Traversal halting fails **open** (a hard backstop trips and
  stamps `truncated`/`bridge-starved` rather than silently stopping). If you touch either,
  preserve the direction and say so in the PR description.
- **Structural defenses over policy defenses.** Prefer a property an attack mathematically
  cannot satisfy (e.g. share-normalization starving hub spam) over a tunable threshold an
  attacker can route around. If your fix is "add a threshold," ask in the PR whether a
  structural alternative exists first.
- **The model is never its own witness.** Anything that lets an LLM-proposed value count
  as confirmation, corroboration, or independence is a bug, not a feature, however
  convenient. Route load-bearing decisions (stop-when, canonical-pick, independence-count)
  to a gate, a provenance check, or an external signal.
- **Demote, never delete.** Contradiction and disowning move strands downward
  (LIVE → DEMOTED, tier → ARCHIVE-STUB); they must never destroy the `content_hash` /
  provenance record. Any change that deletes a row where the existing code demotes is
  almost certainly wrong.
- **Adversary-facing review for new keep/prune/promote/adjudicate rules.** Before opening
  a PR that adds one, write down (in the PR description is fine) what a patient attacker
  who can pay to mint identities does to it. This mirrors how every existing pillar was
  reviewed (see the "adversarially verified" claims throughout CLAUDE.md).
- **Purity boundaries matter.** Several modules (`forgetting/consolidation.ts`,
  `identity/reputation.ts`'s ledger primitives) are deliberately store-agnostic/pure, with
  a stateful orchestrator (`ratification/disown.ts`, `api.ts`) wiring them to the
  StrandStore. Don't reach into a pure module to add store access — wire it at the
  orchestrator layer instead.
- **TypeScript strictness is not optional.** The `tsconfig.json` is strict +
  `verbatimModuleSyntax` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`. Don't
  add `any`, non-null assertions, or `// @ts-expect-error` to route around a real type
  error — fix the type.

## A note on review findings

Past adversarial-review findings — including two high-severity ones (a fail-open
`independentSources` predicate and a non-atomic `ratify()`) — are all fixed and
regression-tested; the full log of each finding, its fix, and the guarding test lives in
[`docs/launch/REVIEW_FINDINGS.md`](./docs/launch/REVIEW_FINDINGS.md). If you find something
in the same class, that is exactly the report `SECURITY.md` asks for: open an issue per
the policy above, or report privately per `SECURITY.md` if it shouldn't be public before a
fix lands.

## Tests

- New behavior needs a new test; a bug fix needs a regression test that fails before the
  fix and passes after.
- Tests live alongside the code they cover (`src/**/__tests__/*.test.ts` and `*.test.ts`
  siblings) and the top-level integration test is `src/__tests__/systemCoherence.test.ts`
  — if your change touches more than one pillar, check whether that test still models the
  interaction correctly.
- Adversarial/security-flavored tests (Sybil collapse, contradiction-bomb defusal, audit
  byte-flip detection, crash-mid-op rollback) are a first-class category here, not an
  afterthought — if you're hardening a gate, add the adversarial case that motivated it.

## Commit / PR conventions

- Keep commits scoped and the message focused on **why**, not just what changed (see
  `git log` for the existing style — e.g. `fix(...)`, `feat(...)`, `refactor(...)`,
  `docs(...)`, `bench:` prefixes are used loosely as a convention, not enforced by tooling).
- Fill out the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) — in particular the
  "what would an attacker do to this" box for anything touching identity, reputation,
  consolidation, or eviction.
- Do not force-push over review history once a PR has reviewers; prefer new commits during
  review, and clean up (squash/rebase) only right before merge if asked.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/` (`bug_report.md` /
`feature_request.md`). Security vulnerabilities — especially anything touching the
cryptographic identity layer (passports, anchors, the audit/Merkle chain, ratification) —
must **not** be filed as a public issue; see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the project's
[Apache License 2.0](./LICENSE), consistent with the existing `NOTICE` file
(Copyright 2026 Yasir).
