## What does this PR do?

<!-- One or two sentences: what changed and why. Link any related issue. -->

Closes #

## Which pillar(s) / module(s) does this touch?

<!-- Check all that apply -->

- [ ] Core types / strand model (`src/core/types.ts`)
- [ ] Storage (`src/store/`)
- [ ] Traversal / activation walk / halting (`src/traversal/`)
- [ ] Forgetting / tiers / consolidation (`src/forgetting/`)
- [ ] Source-Identity Layer (`src/identity/`)
- [ ] Ratification / Merkle audit / disown / reputation ledger (`src/ratification/`)
- [ ] Engine facade (`src/api.ts`, `src/index.ts`)
- [ ] Benchmarks (`src/__bench__/`)
- [ ] Docs / project scaffolding only (no `src/` changes)

## Checklist

- [ ] `npm run typecheck` passes locally
- [ ] `npm test` passes locally
- [ ] I added/updated tests covering the change (new behavior → new test; bug fix →
      regression test that fails before the fix)
- [ ] No new `TODO`/stub left guarding a real correctness gap — if something is
      intentionally out of scope, it's noted in the PR description and, if user-facing,
      in CLAUDE.md's gap list
- [ ] I preserved existing fail-open / fail-closed direction for any gate I touched
      (see CONTRIBUTING.md) — or explicitly called out and justified a change to it
- [ ] Demote-never-delete preserved for anything touching contradiction/disown/eviction

## Adversary-facing review (required for changes to identity, reputation, consolidation, eviction, or the audit/ratification ledger — otherwise delete this section)

What does a patient attacker who can pay to mint identities (Sybil sources, cheap anchors,
repeated claims) do to this change? Why does it still hold?

<!-- Your answer here -->

## Additional context

<!-- Anything a reviewer needs: design tradeoffs considered, alternatives rejected, perf
     notes, screenshots/output for bench changes, etc. -->
