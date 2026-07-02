# Release Process

## Current state (unverified beyond what's in the repo)

`package.json` today pins:

```json
"version": "0.0.0",
"private": true
```

There is no `CHANGELOG.md` yet, and no
git remote configured locally — `git branch -a` shows only local `master` and
`exp/sybil-redteam`. This document describes the policy to adopt *when* the project
starts cutting real releases; it does not claim any of this infrastructure exists yet.

## Semver policy

Standard [SemVer 2.0.0](https://semver.org/) applies to the published package
(`intelligent-db`), with the usual pre-1.0 caveat made explicit rather than assumed:

- **`0.x.y` (current and initial public phase): no stability guarantee, by SemVer's own
  rules.** A `0.x` minor bump (`0.1.0` → `0.2.0`) MAY contain breaking API changes.
  This is not a loophole to abuse — see "What can break pre-1.0" below — but it is the
  state given the project's own **GAP LIST** (CLAUDE.md): cross-process
  concurrency, real external anchor/witness services, encryption-at-rest, and the
  HARDWARE/KYC/STAKE binders are explicitly unbuilt. Advertising `1.0.0` while those gaps
  are open would misrepresent stability the project doesn't have.
- **`1.0.0`: reserved for when the public API is meant to be depended on without reading
  the gap list first.** Recommended bar before cutting `1.0.0` (not exhaustive, revisit
  when the time comes): the CRITICAL section of the gap list stays empty, and enough of
  the ACCEPTABLE section is either closed or the maintainer is comfortable committing to
  it long-term as documented, deliberate scope (e.g. single-process-only may simply stay a
  `1.x` design constraint, not a blocker — but that should be a conscious decision at
  `1.0.0` time, not an oversight). CLAUDE.md's own status line currently claims the
  CRITICAL section is empty ("none remain"); treat that as the *target* state to
  re-verify at `1.0.0` time, not a standing fact to take on faith — a concurrent
  code-review pass in this same launch-prep round flagged candidate counter-examples
  (e.g. a compound-write path outside the documented `withTxn` wrapping, and a fail-open
  identity-independence check on an unregistered source) that, if confirmed, would
  reopen a CRITICAL-tier item. Resolve or explicitly re-triage findings like these — and
  any other code-review backlog — as part of deciding whether the gap list's CRITICAL
  section is *actually* empty, not just documented as such, before either `0.1.0` (where
  it's a disclosure question) or `1.0.0` (where it's a stability promise).
- **Patch (`0.x.PATCH`):** bug fixes and internal changes with no API surface change.
- **Minor (`0.MINOR.x`):** additive, non-breaking changes pre-1.0 by convention (even
  though SemVer permits breaking minors pre-1.0, this project should prefer *not* to break
  without cause — see below), or a breaking change explicitly called out pre-1.0.
- **Major (`MAJOR.x.x`):** any breaking change once at `1.0.0` or above — a changed
  function signature in `src/api.ts`'s public verbs (`writeFact`, `recall`, `ratify`,
  `adjudicate`, `disown`, `approve`), a changed `SqliteStrandStore` on-disk schema without
  a migration path (see CLAUDE.md gap list: "No schema migration / versioning" is a known
  gap — closing it is a prerequisite for painless major bumps), or a changed meaning of an
  existing stamp/field in `src/core/types.ts`.

### What can break pre-1.0 vs what shouldn't without cause

Being pre-1.0 is licence to break the API, not licence to break it *carelessly*. In
practice:

- Class 2 (architecture-affecting) changes per `GOVERNANCE.md` are exactly the kind of
  change that justifies a pre-1.0 breaking minor bump — they're already gated by a design
  proposal and explicit maintainer sign-off, so by the time they land they're deliberate.
- Class 1 (implementation) changes should not silently break the public API even pre-1.0;
  if a Class 1 change does turn out to break something, that's a signal it was
  mis-classified and should have gone through the Class 2 process.

## Cutting the first public release (`0.1.0`)

Recommended sequence, in order, when ready to launch publicly (this is a checklist, not a
description of something already done):

1. **Triage the open code-review backlog** (this launch-prep pass surfaced several
   findings across `identity/`, `ratification/`, and `traversal/`/`forgetting/`/`api.ts` —
   see the semver policy note above for two examples). Each finding should be either
   fixed, or consciously accepted and added to CLAUDE.md's gap list so `0.1.0` ships with
   a current gap list rather than a stale "none remain" claim.
2. **Flip `private: true` → remove it (or set `false`)** in `package.json` — required
   before `npm publish` will do anything but refuse.
3. **Bump `version` to `0.1.0`** (not `1.0.0` — see semver policy above) in
   `package.json`.
4. **Confirm `npm run build` produces a working `dist/`** and that the `bin` entry
   (`intelligent-db-mcp` → `dist/mcp/server.js`) actually exists post-build, since it's
   what `npm install -g` / `npx` would expose.
5. **Add a `CHANGELOG.md`** (see policy below) with an initial `0.1.0` entry summarizing
   what ships (the four pillars, per CLAUDE.md's status section) and linking the GAP LIST
   for accuracy about what doesn't.
6. **Push to a real remote and tag the release** (`git tag v0.1.0`) once a remote exists —
   none is configured in this local repo today.
7. **`npm publish`** (public, since there's no indication this should be a private/scoped
   package) once the above are in place.
8. CI is already wired (`.github/workflows/ci.yml` runs `npm run typecheck` + `npm test`
   on every push and PR to `master`/`main`); it activates the moment the repo is pushed to
   GitHub — see "CI" below.

Nothing about this sequence is urgent to do *right now* — it's the recipe for whenever
"public launch" is actually decided, since the repo currently has no remote and is marked
private.

## CI

`.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every PR and push
to `master`/`main` — both fast, deterministic commands (see CLAUDE.md: "Must stay
green"). It takes effect automatically once the repo is pushed to GitHub; until then the
maintainer is the enforcement mechanism.

## Changelog policy

Adopt [Keep a Changelog](https://keepachangelog.com/) format at `CHANGELOG.md`, one entry
per released version, sections `Added` / `Changed` / `Fixed` / `Removed` / `Security` as
applicable. Practical notes given this repo's actual history:

- Existing commit messages are *already* loosely prefixed (`feat`, `fix`, `docs`,
  `bench`, `chore`, `cleanup`, `merge`, `v2:`) but not strictly
  [Conventional Commits](https://www.conventionalcommits.org/) — don't assume a changelog
  can be auto-generated from git log today without cleanup. Two options going forward:
  - Tighten commit message discipline to strict Conventional Commits from here on, and
    then a changelog generator (e.g. `conventional-changelog`) becomes viable for future
    releases.
  - Or keep hand-writing `CHANGELOG.md` per release from the PR/commit list — lower
    tooling investment, fine at current commit volume.
- Every Class 2 (architecture-affecting) change per `GOVERNANCE.md` MUST get a
  changelog entry regardless of which option is chosen — that's the audit trail for
  "when did a settled invariant change."
- Pre-1.0 breaking changes still get called out explicitly in the changelog (e.g. a
  `**BREAKING**` marker under `Changed`), since SemVer doesn't make that visible from the
  version number alone within `0.x`.

## Branch strategy

Current repo state: a single long-lived branch, `main`, plus
ad-hoc experimental branches (e.g. `exp/sybil-redteam`) that get merged back with real
(non-squash) merge commits — `git log --merges` shows genuine two-parent merges, not
rebased/squashed history. Recommended policy, formalizing what's already the de facto
pattern:

- **`master`** is the trunk. It should stay green (`npm run typecheck` + `npm test`)
  at every commit — the project's own status line (CLAUDE.md) carries the canonical
  current test count; treat that figure as CLAUDE.md's self-report rather than re-verified here (a
  local `npm test` run during this pass reported a much larger number, but a stray
  untracked `idb-rt/` worktree directory in the working tree currently causes the test
  suite to be collected twice, which inflates the count — worth a one-line CI/`.gitignore`
  check before trusting any raw `npm test` total at face value).
- **Feature/fix branches** off `master`, named descriptively (`feat/...`, `fix/...`, or
  the `exp/...` convention already in use for exploratory/red-team work that may not
  land), merged back via real merge commits (matches existing history — see `git log
  --merges` for precedent) or PR "merge" (not squash) once hosted on a forge, so the
  granular history survives.
- **Release tags** (`vX.Y.Z`) are cut on `master` once a remote exists; no separate
  `release/*` branch line is needed at this project's current size — introduce one only
  if patch releases for an older minor are needed concurrently with `master` moving ahead
  (not a problem yet at pre-0.1.0).
- **Renaming `master` → `main`:** done — the default branch is `main`, renamed locally
  before the first push so no remote default-branch update or clone migration was ever
  needed. The CI workflow triggers on both names, so historical references to `master`
  in older docs are harmless.
