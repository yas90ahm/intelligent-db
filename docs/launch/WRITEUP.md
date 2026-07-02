# Launch-Prep Pass — Master Write-Up

This is the single start-to-end record of the launch-prep documentation pass performed on
this repository (Intelligent DB, Apache-2.0, pre-1.0, `version: 0.0.0`). It indexes every
file the pass produced, summarizes what each workstream found or wrote, and closes with a
concrete launch-readiness checklist. **No files under `src/` were read for editing, or
modified, by any workstream in this pass** — this was a docs/project-organization pass
only, per the constraint each workstream operated under.

---

## 1. What Intelligent DB is / is not (concise version)

Intelligent DB is a memory substrate for AI agents that targets the two ways agents fail:
they **forget** (stateless models lose context across turns/sessions) and they
**hallucinate** (they invent facts and can't distinguish real recall from invention). It is
a **deliberate inversion of a vector database**: instead of embedding everything into one
space and doing fuzzy nearest-neighbor lookup at query time, facts ("strands") sit **latent**
by default and surface only via **spreading activation** propagating along structural
threads (shared entity + confirmed relationship), decaying with each hop. Only the lit
cluster gets assembled into an answer — the "memory palace / spider web" model, with rare
**cross-web bridge** threads producing the "something from last week is suddenly relevant"
effect.

Two governing invariants hold everything else together:

1. **The model is never its own witness.** It files and speaks memories; it never confirms
   them. No provenance, no voice.
2. **The web is never its own witness about source identity.** A multi-agent adversarial
   council proved this formally (the "hard theorem" in CLAUDE.md): under "identity is
   priced, not prevented," no purely internal rule can both let one true witness overturn a
   planted false canonical fact *and* stop two fake sources from overturning a true
   incumbent. Identity must be witnessed from **outside** the graph — hence the
   Source-Identity Layer (passport / anchor / reputation / stake).

It is explicitly **not** a vector database, not a blockchain, not a majority-vote consensus
system, and — per this same pass's own code-review findings folded in — not yet a
finished, audit-closed system (two HIGH findings below are still open).

Full essay, with the complete "what it is NOT" section and cross-links: **[docs/launch/WHAT_IT_IS.md](./WHAT_IT_IS.md)**.

---

## 2. Repo organization changes made for the GitHub launch

New top-level files (repo root):

- `CONTRIBUTING.md` — dev setup, required checks (`npm run typecheck`, `npm test`,
  `npm run build`), code philosophy (no loud TODO stubs, fail-open/fail-closed direction
  preserved, demote-never-delete, adversary-facing review, purity boundaries), and a "known
  current issues" note pointing at the two HIGH code-review findings below.
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1, enforcement contact `1290yasir@gmail.com`.
- `SECURITY.md` — pre-1.0 single-maintainer supported-version table, private reporting via
  GitHub Security Advisories or email, an in-scope/out-of-scope threat-model section
  grounded in "identity is priced, not prevented" and CLAUDE.md's known-limitations list.
- `LICENSE` (Apache-2.0) and `NOTICE` (copyright "2026 Yasir") — **these already existed
  before this pass**; not newly added by it, listed here only for completeness of the root
  directory.

New `.github/` scaffolding:

- `.github/PULL_REQUEST_TEMPLATE.md` — module checklist, required-checks checklist, a
  mandatory adversary-facing-review section gating identity/reputation/consolidation/
  eviction/ratification changes.
- `.github/ISSUE_TEMPLATE/bug_report.md` — redirects vulnerabilities to `SECURITY.md`, asks
  which invariant is violated.
- `.github/ISSUE_TEMPLATE/feature_request.md` — asks whether the proposal is within, or a
  change to, the settled architecture (CLAUDE.md's "do not relitigate" framing).
- `.github/workflows/ci.yml` — GitHub Actions workflow, syntax-validated with
  `yaml.safe_load`; triggers on push/PR to `main` (Node 20.x/24.x matrix); runs
  `npm ci` → `npm run typecheck` → `npm test` → `npm run build`. **Note:** this only fires
  on `main`, and the repo's current default/only long-lived branch is `master` with no
  remote configured — the `git branch -m master main` rename is a documented action item
  (see §6) not performed by this pass.

New `docs/` subtrees (all new this pass):

- `docs/launch/` — `WHAT_IT_IS.md`, `CODE_REVIEW_IDENTITY_RATIFICATION.md`,
  `CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md`, `PRICED_ALTERNATIVES.md`, and this file
  (`WRITEUP.md`).
- `docs/marketing/` — `POSITIONING.md`, `COMPARISON.md`.
- `docs/product/` — `ROADMAP.md`, `USE_CASES.md`.
- `docs/project-management/` — `GOVERNANCE.md`, `RELEASE_PROCESS.md`.

Existing `docs/` files untouched by this pass: `ARCHITECTURE_BENCHMARKS.md`,
`ARCHITECTURE_ENGINE.md`, `INTEGRITY_AUDIT.md`, `RAW_SAMPLES.md`.

Other repo-hygiene notes, checked directly against the working tree during this pass:

- **`logs/*.log` (20 benchmark-run log files under `logs/`) are consolidated under one
  `.gitignore` rule** (`*.log`) rather than tracked individually — they are local run
  artifacts (ablation/factworld/poisonedrag/contriever benchmark logs) and stay untracked
  by a single glob line rather than being enumerated or committed.
- **Empty scratch directories `idb-cf/`, `idb-clean/`, `idb-v2/` were removed** — confirmed
  absent from the current working tree; no trace remains.
- **`idb-rt/` still exists and is a *live* git worktree, not a stray scratch dir** —
  `git worktree list` shows `D:/idb-rt` checked out on `exp/sybil-redteam` and marked
  `prunable`. This is flagged as an open action item in §6, not something this pass removed
  (removing a live worktree is a destructive git operation outside a docs-only pass's
  scope).
- `.gitignore` already carries `*.log`, `*.db*`, `node_modules/`, `dist/`, and an
  `.arbor`/`ARBOR_CONTRACT.md`/`research_config.yaml` block for internal multi-agent run
  artifacts — unchanged by this pass.

---

## 3. Marketing / Product / PM materials produced

- **[docs/marketing/POSITIONING.md](../marketing/POSITIONING.md)** — tagline, pitch, target
  audience, 8 key differentiators (structural retrieval, priced identity, Beta reputation,
  decisive-or-defer adjudication, demote-never-delete, tamper-evident Merkle audit,
  empirically validated benchmarks, zero runtime deps), and a "what this is not" section
  that now includes a "not a finished, audit-closed system" bullet reflecting the two HIGH
  code-review findings.
- **[docs/marketing/COMPARISON.md](../marketing/COMPARISON.md)** — qualitative architecture
  comparison table; the measured FactWorld (0% vs 98.7%/79.4% ASR) and PoisonedRAG
  (6–18% vs 93–99% ASR) tables pulled verbatim from `ARCHITECTURE_BENCHMARKS.md`; the
  oracle-conditional caveat plus the non-oracle 14–23% structural-only numbers; the
  disclosed costly-independent-boundary failure mode (Sybil priced, not prevented); a
  "where it's not the better tool" section pointing at `ROADMAP.md` for multi-tenant gaps.
- **[docs/product/ROADMAP.md](../product/ROADMAP.md)** — current status (all four
  ARCHITECTURE.md pillars shipped, zero CRITICAL gaps per CLAUDE.md at time of writing), a
  new **§0 "Recently identified, not yet in CLAUDE.md's canonical gap list"** section
  documenting the two HIGH code-review findings as reported-but-unconfirmed, then the full
  ACCEPTABLE gap list (HARDWARE/KYC/FINANCIAL_STAKE binders, real external anchor/witness
  services, cross-process concurrency, encryption-at-rest, backup/PITR, schema migration)
  with what each unlocks for real deployments.
- **[docs/product/USE_CASES.md](../product/USE_CASES.md)** — four personas (agent framework
  builders, enterprise knowledge assistants, regulated industries, multi-agent systems
  needing shared corroborated memory), each capability claim traced to CLAUDE.md/
  ARCHITECTURE.md, with inline pointers to the two §0 findings where they qualify a
  persona's pitch (ratify's non-atomicity for the audit-trail claim; `independentSources`'
  fail-open for the `approve()` distinct-approver claim).
- **[docs/project-management/GOVERNANCE.md](../project-management/GOVERNANCE.md)** — sizes
  decision-making for the current one-maintainer, pre-launch state: Class 1 (ordinary PR +
  green checks + one approval) vs. Class 2 (written design proposal + explicit sign-off +
  CLAUDE.md update) split keyed off the settled invariants/hard theorem, with a concrete
  worked boundary test drawn straight from this pass's own findings (restoring a documented
  invariant, e.g. wrapping `ratify()` in the existing `withTxn` convention, is Class 1;
  redefining what "independent" or "atomic" means is Class 2).
- **[docs/project-management/RELEASE_PROCESS.md](../project-management/RELEASE_PROCESS.md)**
  — current-state facts re-verified against the repo this session (`version 0.0.0`,
  `private: true`, no `CHANGELOG.md`, no remote, `master` + `exp/sybil-redteam` branches,
  the linked `idb-rt` worktree), a pre-1.0 SemVer policy that treats CLAUDE.md's "CRITICAL:
  none remain" as a target to re-verify (not a standing fact) given the two counter-examples
  below, an 8-step `0.1.0` launch checklist whose first step is triaging the code-review
  backlog, a Keep-a-Changelog policy, and a branch-strategy section recommending the
  `master` → `main` rename as a pre-CI step.

---

## 4. Code review findings summary

Two independent code-review passes ran over disjoint parts of `src/`. Both are
suggestions-only documents; **no `src/` files were modified**.

**[docs/launch/CODE_REVIEW_IDENTITY_RATIFICATION.md](./CODE_REVIEW_IDENTITY_RATIFICATION.md)**
(`src/identity/*`, `src/ratification/*`):

- **HIGH** — `SourceIdentityLayer.independentSources` (`src/identity/index.ts`) **fails
  open** (returns `true`) for any source never passed through `identity.register()`,
  silently defeating the RC-5 anchor-disjointness gate that `ratification/pendingLedger.ts`'s
  `approve()` relies on to reject colluding/correlated approvers — reachable via the
  sanctioned `WriteFactInput.stamp` / `SourceRef` escape hatches, on both a custom
  `RealAnchorRegistry` wiring and the default `createAgentMemory()` facade.
- **MEDIUM** — the SQLite-backed `corroboration`/`weakInfluence`/`adjudicationProvenance`
  ledgers do full-table scans (O(total records)) per disown-sweep query despite their
  interfaces promising O(matches).
- **LOW** — a stale-but-currently-inert `lastUpdate` in `reputation.ts`'s `craterState`; plus
  a tied test-coverage gap (no existing test constructs an unregistered disputed author).

**[docs/launch/CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md](./CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md)**
(`src/traversal/*`, `src/forgetting/*`, `src/store/*`, `src/api.ts`):

- **HIGH** — `ratify()` in `src/api.ts` is the *only* belief-changing verb not wrapped in the
  atomic `withTxn` transaction used by `adjudicate`/`approve`/`downstreamDisownSweep`/
  `writeFact` — a crash mid-`ratify()` can leave a half-applied reputation update.
- **HIGH** — the `LOW_UNIQUE_VALUE` eviction gate in `src/forgetting/tiers.ts` is a
  **permanent vacuous pass**: `makeObservedStrand` hardcodes `description_value: 0` and
  nothing in `src/` ever updates it, so the gate always passes regardless of actual
  uniqueness.
- **MEDIUM** (three) — a latent negative-depth underflow in `sqliteStore.ts`'s nestable
  `beginTxn()` that would silently disable all future atomicity; a frozen-timestamp
  wall-clock backstop during the phase-2 bridge sweep in `traversal/walk.ts`; and an
  asymmetry where `MemoryStrandStore` leaks live mutable `Strand` references while
  `SqliteStrandStore` hands out clones.

The two HIGH findings from the two reviews are **complementary, not overlapping**: the
identity review's finding is a *correctness* bug in what `approve()`'s independence gate
decides; the traversal/store review's finding is a *durability* bug in `ratify()`, a
neighboring but separate verb that (unlike `approve()`, which already runs inside `withTxn`)
isn't wrapped in a transaction at all.

---

## 5. Priced-identity alternatives analysis

**[docs/history/PRICED_ALTERNATIVES.md](../history/PRICED_ALTERNATIVES.md)** — the author's ask, stated
plainly: **keep "identity is priced, not prevented"; explore removing the cryptographic
machinery specifically** (Ed25519 passports, hash-chained/signed audit ledger, RFC-6962
Merkle proofs), not the anchor-pricing/independence/reputation design itself.

The analysis first establishes that `identity/anchors.ts` and `identity/reputation.ts` are
already mechanism-agnostic pure arithmetic (no crypto imports at all) and `identity/keys.ts`
is where Ed25519 actually lives — contributing zero independence value on its own, making it
the lowest-regret removal target. It then walks six concrete swaps, each scored on what it
keeps / gives up / its new trust assumption / a clear verdict on whether crypto is
eliminated or merely relocated:

- **(A)** OAuth/SSO passport, **(B)** symmetric bearer tokens — replace only the "sameness"
  proof (passport pillar).
- **(C)** platform-account-signal anchor binding, **(D)** human-moderator anchor
  attestation — replace the anchor-binding pillar's DNS-01/email provers.
- **(E)** payment-processor-backed financial stake — the cleanest win; the pricing math
  needs zero changes.
- **(F)** third-party WORM/log-SaaS audit trails in place of the RFC-6962 Merkle log —
  decomposes "crypto" into separately-removable weights (hash-chaining, signing,
  Merkle-proof math).

It closes by folding in the identity-review's HIGH finding (`independentSources` failing
open for a never-registered source) as a bug that undermines `approve()`'s RC-5 gate
**independent of any passport-scheme choice** — i.e., swapping out crypto does not fix it,
so it should be triaged regardless of which alternative (if any) is pursued. Net-read
ranking: **(E)** cleanest, **(A)/(B)** next-cleanest, **(C)/(D)/(F)** real options that trade
away specific guarantees (independent/scarce anchor proof, tamper-evidence without a trusted
third party) for simplicity.

---

## 6. Launch-readiness checklist

**Done this pass:**
- [x] Apache-2.0 `LICENSE` + `NOTICE` in place (pre-existing, confirmed present).
- [x] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` written.
- [x] `.github/` PR template, issue templates, and a CI workflow (`ci.yml`) written
      (not yet active — see below).
- [x] Marketing (`POSITIONING.md`, `COMPARISON.md`), product (`ROADMAP.md`, `USE_CASES.md`),
      and project-management (`GOVERNANCE.md`, `RELEASE_PROCESS.md`) docs written and
      cross-linked.
- [x] Two independent adversarial code reviews completed and written up, covering
      `identity/`, `ratification/`, `traversal/`, `forgetting/`, `store/`, and `api.ts`.
- [x] A crypto-removal alternatives analysis written for the identity/audit layer.
- [x] Confirmed empty scratch dirs (`idb-cf/`, `idb-clean/`, `idb-v2/`) are gone from the
      working tree; confirmed `logs/*.log` is a single gitignore rule, not 20 tracked files.

**Still open before `git push` to a public GitHub remote:**
1. **Triage the two HIGH code-review findings** (both call this out as the first launch
   step): `ratify()` not wrapped in `withTxn`, and `independentSources()` failing open for
   an unregistered source. Either fix both, or consciously accept them and add them to
   CLAUDE.md's canonical gap list — the current "CRITICAL: none remain" claim in CLAUDE.md
   predates this pass's findings and should not ship unreconciled.
2. **Pick a GitHub org/repo name.** Not decided anywhere in this pass's artifacts; needed
   before `git remote add` / `gh repo create`.
3. **Decide the fate of `idb-rt/`.** It is a *live, linked git worktree* on
   `exp/sybil-redteam` (`git worktree list` confirms it, marked `prunable`), not a dead
   scratch directory — running `git worktree remove` (or `prune`) before publishing avoids
   shipping a stray sibling checkout and, per this pass's own RELEASE_PROCESS.md note, avoids
   the test suite being collected twice if it's ever nested under the published tree.
4. **Rename `master` → `main`** (`git branch -m master main`) before relying on
   `.github/workflows/ci.yml`, whose triggers are hardcoded to `branches: [main]` — CI
   silently never fires against a repo still on `master`. Zero-risk today (no remote yet);
   gets riskier once a remote and collaborators exist.
5. **Decide whether `version` bumps off `0.0.0`.** `RELEASE_PROCESS.md`'s recommended
   sequence bumps to `0.1.0` (not `1.0.0`) as one of the *later* steps in its 8-step
   checklist, after the code-review backlog is triaged and a `CHANGELOG.md` exists — not
   automatic, and not yet done.
6. **Add a `CHANGELOG.md`** (Keep-a-Changelog format per `RELEASE_PROCESS.md`'s policy) with
   an initial entry summarizing the current state, before or as part of cutting `0.1.0`.
7. **Decide `private: true` in `package.json`** — currently marked private; this must
   change (or the field removed) for a public npm-adjacent GitHub launch if publishing to
   npm is ever intended, though it does not block a plain public GitHub repo.
8. **Re-run `npm run typecheck && npm test && npm run build` locally** one more time
   immediately before the first push, since `.github/workflows/ci.yml` cannot enforce
   anything until it is live on a remote with the branch rename in place (item 4).

Everything above is either a direct re-statement of what the parallel workstreams already
concluded (cross-linked throughout this document) or a fact independently re-checked against
the working tree while assembling this write-up (`git worktree list`, `git branch -a`,
`git status`, the `docs/` and `.github/` directory listings, and `package.json`).
