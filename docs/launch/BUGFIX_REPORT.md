# Bug-fix report — three findings from the launch code review

Scope: fixes for three defects surfaced by
[`docs/launch/CODE_REVIEW_IDENTITY_RATIFICATION.md`](./CODE_REVIEW_IDENTITY_RATIFICATION.md) and
[`docs/launch/CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md`](./CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md),
plus an independent adversarial re-verification of each fix. This report is the final
record of that pass — it does not re-litigate the reviews' full findings, only the three
that were fixed.

## 1. The three bugs

- **Bug A — `ratify()` was not atomic.** Found in `CODE_REVIEW_IDENTITY_RATIFICATION.md`:
  unlike `writeFact`/`adjudicate`/`approve`, `IntelligentDbImpl.ratify()` performed its
  strand promotion, reputation credit, and corroboration-event recording as separate
  un-transacted writes, so a crash or mid-op throw could promote a strand with no
  matching reputation gain (or vice versa).
- **Bug B — `independentSources()` fail-open on an unregistered source.** Found in
  `CODE_REVIEW_IDENTITY_RATIFICATION.md`: the RC-5 predicate in `src/identity/index.ts`
  returned `true` (independent) whenever either source had never called
  `identity.register()`, letting a caller-supplied, never-registered `SourceId` pass the
  distinct-approver / anchor-disjointness gate in `approve()` for free.
- **Bug C — `description_value` hardcoded to `0`.** Found in
  `CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md`: every strand minted by `makeObservedStrand`
  carried `description_value: 0`, which made the `LOW_UNIQUE_VALUE` below-COLD eviction
  gate in `forgetting/tiers.ts` dead weight — it always passed regardless of a strand's
  actual uniqueness.

## 2. What changed per bug (from the real `git diff`)

`git diff --stat` for this pass (tracked files only):

```
README.md                                 |   9 +++
src/__tests__/atomicCompound.test.ts      | 112 ++++++++++++++++++++++++++++-
src/__tests__/smoke.test.ts               | 115 ++++++++++++++++++++++++++++++
src/api.ts                                |  39 +++++++++-
src/identity/index.ts                     |  29 +++++---
src/ratification/engineAdjudicate.test.ts |  75 ++++++++++++++++++-
6 files changed, 366 insertions(+), 13 deletions(-)
```

No dependency was added anywhere in this pass — `package.json` / `package-lock.json` are
untouched.

### Bug A — `src/api.ts`
`ratify(input)` now delegates its whole body to a new private `#ratifyImpl(input)`,
called as `withTxn(this.#store, () => { this.#ratifyImpl(input); })` — the same
`withTxn` helper `writeFact`/`adjudicate`/`approve` already use. The strand promotion
(`putStrand`, DERIVED→OBSERVED / PROVISIONAL→LIVE), the `reputation.ratify` call, and the
corroboration-event record (and `assertRatifyEmitsEvent`'s invariant check) all now run
inside one transaction. `#ratifyImpl` has exactly one call site.

**Test fixture change:** `src/__tests__/atomicCompound.test.ts`'s `wire()` helper gained
an `opts?: { withCorroboration?: boolean }` parameter that optionally wires a
`createSqliteCorroborationLedger` onto the shared handle, because the new regression
test needs a real corroboration-recording path to exercise (a target DERIVED/PROVISIONAL
strand plus a same-content-hash corroborator strand, so the ratify has a named-corroborator
earning path). The new test forces `reputation.ratify` to throw mid-op and asserts the
target strand is unchanged (still DERIVED/PROVISIONAL, `provenance.length` unchanged) —
under the pre-fix unwrapped code this assertion would genuinely fail, since SQLite
auto-commits each `putStrand` outside a transaction.

### Bug B — `src/identity/index.ts`
The RC-5 `independentSources(a, b)` predicate's unregistered-side branch flips from
`return true` to `return false`, with the doc comment above it rewritten to justify the
fail-closed direction: an unregistered `SourceId` never bound an anchor, i.e. it is a
BARE_KEY-equivalent witness (`independence_weight` 0.00), and a BARE_KEY can never be
independent of anything. The comment also now explicitly distinguishes this from
`independentRootCount`'s *different* null-source fallback (a provenance root recording no
`sourceId` at all, judged on the Stage-1 class check alone) — that fallback was
intentionally left unchanged.

**Test fixture change:** `src/ratification/engineAdjudicate.test.ts` gained a new test
building a hand-constructed unregistered `src:raw` author, asserting `independentSources`
returns `false` directly and that `db.approve()` throws for it. The pre-existing
"unregistered ⇒ fail-open" test in the same file was updated to register both disputed
authors with real anchors instead of relying on the old fail-open loophole, since that
loophole no longer exists.

### Bug C — `src/api.ts`
A new `descriptionValueOf(payload)` helper computes an order-0 Shannon-entropy estimate
(bits) over `JSON.stringify(payload)` — zero-dependency, deterministic, one pass — and
`makeObservedStrand` now sets `description_value: descriptionValueOf(input.payload)`
instead of the hardcoded `0`.

**Test fixture change:** `src/__tests__/smoke.test.ts` gained two new regression tests
that go through the real engine path (`db.writeFact` → `makeObservedStrand`), not a
hand-built fixture: (1) a long, non-repetitive payload produces a `description_value`
comfortably above the gate's `1.0`-bit floor with no covering neighbor, so
`LOW_UNIQUE_VALUE` correctly denies eviction; (2) two writes of the identical tiny payload
`{v:1}` from different passports produce equal `description_value`s, so coverage collapses
to zero unique bits and the gate correctly permits eviction.

## 3. Adversarial review verdicts (verbatim)

> **Fix A — ratify() atomicity: CONFIRMED**
> `src/api.ts` now has `ratify()` delegate to a new private `#ratifyImpl` wrapped in `withTxn(this.#store, ...)` — the exact same pattern used by `writeFact`/`adjudicate`/`approve`. Traced the full body: `putStrand(promoted)` (the DERIVED→OBSERVED/PROVISIONAL→LIVE promotion) runs before `reputation.ratify`, and `assertRatifyEmitsEvent`'s throw path is also inside the same `#ratifyImpl`, so all of it now shares one transaction. The new regression test in `atomicCompound.test.ts` forces `reputation.ratify` to throw mid-op and asserts the strand stays DERIVED/PROVISIONAL with `provenance.length` unchanged — since the SQLite store auto-commits each `putStrand` outside a transaction, this assertion would genuinely have failed on the old (unwrapped) code, confirming the test is discriminating, not decorative. Only `src/api.ts` and the one test file were touched; no dependency added; `#ratifyImpl` has exactly one call site.

> **Fix B — independentSources fail-closed: CONFIRMED**
> `src/identity/index.ts`'s `independentSources(a,b)` flips the unregistered-side branch from `return true` to `return false`. Checked every consumer of this predicate: it's used only in `pendingLedger.ts`'s RC-5 distinct-approver/anchor-independence gate for `approve()`, where returning `false` more often is the conservative direction (rejects more approvals, never wrongly approves) — no fail-open inversion introduced elsewhere. The new test in `engineAdjudicate.test.ts` builds a hand-built unregistered `src:raw` author, asserts `independentSources` returns `false` directly, and asserts `db.approve()` throws — under the old fail-open code this would have returned `true` and let `approve()` succeed, so the test genuinely exercises the bug. The pre-existing "unregistered ⇒ fail-open" test was correctly updated to register both disputed authors with real anchors instead of relying on the loophole. Only the two named files touched; no dependency added.

> **Fix C — LOW_UNIQUE_VALUE gate / description_value: CONFIRMED (with one caveat worth flagging)**
> `src/api.ts` adds `descriptionValueOf` (order-0 Shannon entropy over `JSON.stringify(payload)`) and wires it into `makeObservedStrand` in place of the hardcoded `0`. Traced `forgetting/tiers.ts`'s `lowUniqueValuePasses`: with `dv=0` the gate always passed (`uniqueBits = 0 - coverage → 0 < 1.0` floor) regardless of neighbors — confirmed dead weight before the fix. Manually verified the arithmetic behind both new tests in `smoke.test.ts`: a long/non-repetitive payload yields `dv` far above the `1.0`-bit floor with no covering neighbor ⇒ gate correctly denies eviction; two writes of the identical tiny payload `{v:1}` from different passports yield equal `description_value`s, so `coverage = min(dv, dv) = dv` ⇒ `uniqueBits = 0` ⇒ gate correctly permits eviction. Checked blast radius directly: grepped every non-test file using `description_value` (7 bench arm/fixture files) — all hand-construct `Strand` objects via `store.putStrand` directly and never route through `makeObservedStrand`/`db.writeFact`, so none are affected by the change; `forgetting/consolidation.ts` doesn't read the field at all. No dependency added; only `src/api.ts` and `src/__tests__/smoke.test.ts` touched.
> Caveat (not a defect, a residual worth naming): the entropy-over-JSON-string proxy is a heuristic, not true "reconstruction-loss bits vs independent neighbors" — key-order-sensitive, and gameable by an attacker who pads a duplicate payload with high-entropy filler to dodge eviction, or conversely by two independent sources phrasing the same fact slightly differently (never exactly canceling coverage). This is an accepted approximation consistent with the codebase's other documented "known simplifications," not a fail-open/fail-closed inversion — flagging for visibility, not blocking.

**Plain statement: there is one CONCERN-adjacent caveat, on Fix C.** The verdict on Fix C
is CONFIRMED, but it comes with an explicitly-named residual: the entropy-over-JSON proxy
for `description_value` is a heuristic (key-order-sensitive, gameable by padding a
duplicate payload with high-entropy filler, or by near-duplicate independent phrasing that
never exactly cancels coverage). It is not classified as a fail-open/fail-closed defect and
does not block the fix, but it is a real, named limitation and should not be glossed over.

## 4. Final test suite status (this run)

Run directly in this final step, from `D:\Intelligent DB`:

- `npm run typecheck` — clean, zero errors.
- `npm test` — **631 tests passed, 42 skipped, 0 failed** (62 test files passed, 37
  skipped, out of 99 total files). Matches the adversarial reviewer's independently-run
  numbers exactly. Note: the aggregate file/test counts include a stale duplicate copy of
  the suite under the untracked `idb-rt/` directory (a second git worktree on an older
  source snapshot — see below); this inflates the absolute counts but does not affect the
  correctness of any test that exercises the three fixes, all of which live under `src/`.
- `npm run build` — clean, `tsc -p .` succeeds with no errors.

`git status --short` at the end of this pass:

```
 M README.md
 M src/__tests__/atomicCompound.test.ts
 M src/__tests__/smoke.test.ts
 M src/api.ts
 M src/identity/index.ts
 M src/ratification/engineAdjudicate.test.ts
?? .github/
?? CODE_OF_CONDUCT.md
?? CONTRIBUTING.md
?? LICENSE
?? NOTICE
?? SECURITY.md
?? docs/launch/
?? docs/marketing/
?? docs/product/
?? docs/project-management/
?? idb-rt/
```

The untracked entries (`.github/`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `LICENSE`,
`NOTICE`, `SECURITY.md`, `docs/marketing/`, `docs/product/`, `docs/project-management/`)
are pre-existing launch-prep scaffolding unrelated to these three bug fixes. `idb-rt/` is
a genuine second git worktree (`idb-rt/.git` points at `.git/worktrees/idb-rt`) sitting on
an older snapshot of the source that predates all three fixes; it is picked up by a
root-level `npm test` run alongside `src/`, which is why the total test-file count in this
report (and in the adversarial reviewer's run) includes its stale duplicate tests too. It
was not touched by this pass.

Only six tracked files changed across this whole pass: `README.md` (a docs-index addition,
unrelated to the three fixes), `src/api.ts`, `src/identity/index.ts`, and three test files
(`src/__tests__/atomicCompound.test.ts`, `src/__tests__/smoke.test.ts`,
`src/ratification/engineAdjudicate.test.ts`).

## 5. Note on CLAUDE.md

This pass did **not** edit `CLAUDE.md`. Its "HONEST GAP LIST" and status/pillar
descriptions still describe the pre-fix state of `ratify()` atomicity, RC-5
independence fail-open/closed behavior, and `description_value`; the maintainer should
manually review and update those sections to reflect the three fixes above.
