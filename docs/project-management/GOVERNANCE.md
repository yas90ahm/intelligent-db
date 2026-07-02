# Governance

This document describes how decisions get made on Intelligent DB today, and how that
model is expected to evolve as the project grows past a single maintainer. It is
deliberately sized for where the project actually is right now: **Apache-2.0, just
launching, one maintainer, no formal team** — not an aspirational governance document for
a project this isn't yet.

## Current state

Intelligent DB is maintained by a single maintainer (Yasir, copyright holder per
`NOTICE`). There is no foundation, no steering committee, and no CI enforcing merges —
`npm run typecheck` and `npm test` are run locally/by the maintainer before merge. This
document exists so that changes to *this* — more contributors, delegated review, a
core-team model — happen by conscious amendment rather than drift.

## Two kinds of decisions

The project's design has an unusual property worth governing explicitly:
[CLAUDE.md](../../CLAUDE.md) contains a section literally titled **"Core architecture
(settled — do not relitigate)"**, plus a proven **hard theorem** (claim adjudication
cannot be solved from inside the graph — see CLAUDE.md, "The hard theorem") and **two
governing invariants** ("the model is never its own witness"; "the web is never its own
witness about source identity"). These aren't arbitrary style preferences — they're the
output of an adversarial design process (a multi-agent council stress-testing the
alternatives) and the rest of the implementation is built to satisfy them. Treat them
differently from ordinary code decisions.

**Class 1 — Implementation decisions.** Anything that doesn't change a settled
invariant: bug fixes, new tests, performance work, new anchor binders, additional gates
inside `forgetting/tiers.ts`, doc updates, tuning constants explicitly flagged in CLAUDE.md
as knobs (e.g. `epsilon`, `gamma`, `decisiveMargin`, the anchor-cost table's weights).
These are ordinary open-source changes:

1. Open a PR against `master`.
2. `npm run typecheck` and `npm test` must stay green (no exceptions — see
   `docs/project-management/RELEASE_PROCESS.md` for what "green" gates).
3. One maintainer approval merges it. Today that's the sole maintainer; once a core team
   exists (see "Contributor path to maintainer" below), any one maintainer other than the
   author may approve.
4. Trivial changes (typos, comment fixes, doc wording) may be merged by any maintainer
   without a second review.

**Class 2 — Architecture-affecting decisions.** Anything that would change a settled
invariant, the four roadmap pillars, the anchor-cost table's *shape* (not its tuning
values), the halting/forgetting/adjudication *rules* (not their thresholds), or add a new
governing invariant. Examples that would fall in this class: changing what counts as
"independent" corroboration, letting the model itself adjudicate a contradiction,
collapsing the two-phase halting into one phase, or removing the "no purely internal rule"
theorem's conclusion by weakening the external identity layer.

Class 2 changes require a **written proposal**, not just a PR:

1. Write a short design note (as a PR description, GitHub Discussion, or issue — no
   separate ADR tooling is mandated) that states: (a) which settled section/invariant it
   touches, (b) *why* the current rule fails under the project's own adversarial standard
   — "what does a patient attacker who can pay to mint identities do to this?" (see
   CLAUDE.md, "Design philosophy for future work") — and (c) whether the proposed
   replacement is a **structural** defense (preferred) or a **policy** defense (must
   justify why no structural alternative exists).
2. The maintainer (or, once a core team exists, a majority of maintainers) must
   explicitly approve the *design* before implementation PRs are merged. Approving the
   code without re-litigating the design defeats the point.
3. On merge, the relevant section of CLAUDE.md is updated in the same PR — settled
   decisions are not left stale once superseded — and the change is recorded in
   `CHANGELOG.md` as a breaking/architectural change (see RELEASE_PROCESS.md).

When in doubt about which class a change falls in, default to Class 2. It's cheaper to
over-scrutinize a proposal than to quietly erode an invariant the whole trust model
depends on.

A concrete test for the boundary, surfaced by this same launch-prep pass's code review:
a fix that makes code *match* a rule CLAUDE.md already documents (e.g. an
independence/anchor check that's supposed to fail closed for an unregistered source but
currently fails open, or a compound write CLAUDE.md says is wrapped in the atomic
`withTxn` helper but isn't) is Class 1 — it restores a documented invariant, it doesn't
change one. It should still land with a regression test proving the failure mode and,
given CLAUDE.md's own habit of naming these hardening passes explicitly, a one-line
CLAUDE.md update noting the fix (not a Class 2 design proposal). A change that instead
*redefines* what "independent" or "atomic" means here would be Class 2.

## Contributor path to maintainer

There is no maintainer team yet — this is the path once contributors show up:

1. **Contributor.** Anyone opening PRs. No special access required.
2. **Trusted contributor (triage).** After a handful of merged, non-trivial PRs that show
   two things — code that stays within existing invariants (or correctly flags when it
   doesn't) and review comments/tests that engage with the adversarial framing (not just
   "it compiles") — the maintainer may grant issue/PR triage rights (labeling, requesting
   changes, closing duplicates). This is a low-stakes, revocable step.
3. **Maintainer (merge rights).** Granted by the existing maintainer(s) to a trusted
   contributor with a sustained track record, on the strength of demonstrated judgment on
   Class 2-shaped questions (even if they never opened one — reviewing one well counts).
   A new maintainer is announced in `CHANGELOG.md` / repo README, not just added silently
   to the org.
4. **Core team (once ≥3 maintainers exist).** At that point Class 2 approval requires a
   majority of maintainers rather than a single person, and this document should be
   amended (itself a Class 2-adjacent change, given it governs Class 2 changes) to specify
   quorum, tie-breaking, and removal of inactive maintainers.

There is no fixed PR count or time-in-project gate — this is a judgment call by existing
maintainer(s), same as most small OSS projects, but the criteria above (invariant-respecting
code, adversarial-quality review) are the bar, not raw activity.

## What this document does not (yet) cover

- **Code of Conduct.** None is adopted yet. Recommended next step: adopt the Contributor
  Covenant (or equivalent) verbatim as `CODE_OF_CONDUCT.md` before the project actively
  solicits outside contributions — this document does not substitute for one.
- **Trademark / naming.** Not addressed; revisit if "Intelligent DB" needs protecting.
- **Security disclosure process.** Not addressed here; if a `SECURITY.md` is added later,
  it supersedes this document for vulnerability reports.
- **Funding / CLA.** No contributor license agreement is required today (Apache-2.0's
  inbound=outbound licensing is relied on as-is); revisit only if a foundation/CLA
  requirement arises.

## Amending this document

Changes to this file follow the Class 2 process above (it governs itself): propose in a
PR, get explicit maintainer sign-off, and note the change in `CHANGELOG.md`.
