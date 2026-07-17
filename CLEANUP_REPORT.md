# Cleanup report

This pass separated current documentation from the July 2026 launch-prep record. The old
work is still available, but it no longer sits in the path used for current guidance.

## What moved

The eight files under `docs/launch/` moved to `docs/history/launch-2026-07/`:

- `BUGFIX_REPORT.md`
- `CODE_REVIEW_IDENTITY_RATIFICATION.md`
- `CODE_REVIEW_TRAVERSAL_FORGETTING_STORE.md`
- `CRYPTO_FREE_IDENTITY_DESIGN.md`
- `REBUILD_SUMMARY.md`
- `REVIEW_FINDINGS.md`
- `WHAT_IT_IS.md`
- `WRITEUP.md`

The new archive README explains that these are historical records, not current operating
instructions. Links from current docs and links inside the moved files were repaired.

## What was removed

`.arbor/sessions/verification/confidence_intervals.md` was an exact duplicate of
`src/__bench__/reports/confidence_intervals.md`. The `.arbor` copy was removed and the
report under `src/__bench__/reports/` is now the canonical copy.

No review findings or design history were deleted.

## What changed

- The README was rewritten in plain language and now states the measured retrieval limits
  instead of presenting the experiment as settled infrastructure.
- `CLAUDE.md` now begins with current corrections: the old `RECONCILE_DRIFT` issue is
  fixed, the torture allowlist is empty, and the live remote-memory type check is in
  `src/mcp/server.ts`.
- The stale CI comment about allowlisting `RECONCILE_DRIFT` was corrected.
- `docs/project-management/RELEASE_PROCESS.md` now matches the real repository: `main` is
  the trunk, the package is still private at version `0.0.0`, and the SQLite migration
  ladder is currently at version 2.
- The package description was shortened and made less promotional.
- The confidence-interval generator now finds the repository from its own file location
  instead of using `D:/Intelligent DB`, and it points at the canonical report path.

## Validation

- Local Markdown-link scan: passed; no broken local links found.
- Confidence-interval generator: executed successfully from this checkout after the path
  fix.
- `git diff --check`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed on Node 24.16.0. Vitest reported 490 suites, 895 passing tests,
  44 skipped tests and no failures.

The clean install's native build scripts could not run inside the restricted Windows
build environment, so validation used `npm ci --ignore-scripts`. The dependency audit
reported five findings: three moderate, one high and one critical. Those need a separate
dependency review rather than a blind forced upgrade.

The latest CI evidence available before this cleanup was mixed: Node 22 passed, while
Node 24 hit one daemon shutdown-auth race in
`src/daemon/__e2e__/adversarial.e2e.test.ts`. The crash-torture job passed. That race was
not changed as part of a documentation cleanup.

## Human review still needed

- Confirm Node 22 and Node 24 remain green in GitHub Actions. The local Node 24 run passed,
  but the earlier CI race has not been explained.
- Review the daemon shutdown-auth race before treating the Node 24 matrix as reliable.
- The benchmark generator currently reads the raw results present under `.arbor/`. In
  this checkout those inputs would regenerate a smaller table than the recorded canonical
  report. The recorded report was left unchanged. Confirm which raw result set is complete
  before regenerating or publishing the numbers.
- `CLAUDE.md` is a long chronological record. The correction block makes the current state
  clear, but a later human pass should decide whether the rest belongs in history too.
- The package remains private. Publishing, choosing a version and adding an npm token are
  deliberate human decisions, not cleanup tasks.
