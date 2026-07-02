---
name: Feature request
about: Propose a new capability or an extension to the existing design
title: "[Feature] "
labels: enhancement
assignees: ''
---

## Is this within, or a change to, the settled architecture?

CLAUDE.md marks the core architecture (spreading-activation traversal, the two-phase
halting mechanics, the forgetting floor, the Source-Identity Layer, demote-never-delete)
as **"settled — do not relitigate."** Please say which of these applies:

- [ ] This is a new capability that fits *within* the existing architecture (e.g. a new
      anchor binder, a new storage backend, a new benchmark) — no design relitigation
      needed.
- [ ] This proposes changing a settled design decision (e.g. halting mechanics, the
      independence-weighting formula, demote-vs-delete semantics). Please explain why the
      existing adversarial reasoning in CLAUDE.md doesn't hold, rather than just proposing
      an alternative — these were reviewed against a "patient attacker who can pay to mint
      identities" threat model and the tradeoffs are intentional. See
      `docs/project-management/GOVERNANCE.md`'s "Class 2" process for what this requires.

## Problem / motivation

<!-- What are you trying to do, and why doesn't the current design support it well? -->

## Proposed solution

<!-- Sketch the approach. If it introduces a new keep/prune/promote/adjudicate rule,
     please include: what does a patient attacker who can pay to mint identities do to
     this rule? Structural defenses (a property an attack can't satisfy) are strongly
     preferred over policy defenses (a tunable threshold). -->

## Alternatives considered

<!-- Any other approaches you thought about and why you didn't propose them. -->

## Additional context

<!-- Links, references, related issues. Check `docs/product/ROADMAP.md` first — this may
     already be a known near/mid/long-term item. -->
