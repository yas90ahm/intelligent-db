---
name: Bug report
about: Report a correctness bug, a broken invariant, or unexpected behavior
title: "[Bug] "
labels: bug
assignees: ''
---

**Security note:** if this bug is a *vulnerability* — something that lets a source forge
independence, tamper with the audit chain undetected, bypass a fail-closed gate, or
otherwise break a stated invariant in an exploitable way — please do **not** file it here.
See [SECURITY.md](../../SECURITY.md) for private reporting instead.

## Describe the bug

<!-- A clear, concise description of what the bug is. -->

## Which invariant or behavior is violated?

<!-- E.g. "demote-never-delete", "the model is never its own witness", "fail-closed
     eviction should have kept this strand", "activation should be monotone
     non-increasing", "an independent second lock should have deferred, not resolved" —
     if you're not sure, just describe the observed vs. expected behavior. -->

## To reproduce

Steps / minimal repro (a small script, test case, or `npm test`-style snippet is ideal):

1.
2.
3.

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened. Include error messages / stack traces / test output. -->

## Environment

- Node version: `node --version` →
- OS:
- Commit / branch:
- Relevant `src/` module(s) if known:

## Additional context

<!-- Anything else — screenshots, logs, links to related issues/PRs. -->
