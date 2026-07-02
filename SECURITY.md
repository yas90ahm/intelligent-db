# Security Policy

Intelligent DB is a poisoning-resistant memory substrate for AI agents. Its trust layer is
**crypto-free by design**: this codebase signs, mints, and attests nothing. Source identity
is CONSUMED from configuration by a trust registry (owner / SSO tenant / registered
publisher / system-of-record claim producers), and tamper-evidence comes from a plain
SHA-256 **checksum chain** over the append-only audit ledger, with real-time shipping and
exported checkpoints for insider-tamper detection. Vulnerabilities in the trust registry,
the audit chain, the SQLite persistence path, or the traversal/forgetting gates that could
be used to poison, forge, or silently corrupt stored memory are treated as security issues,
not ordinary bugs.

## Supported versions

This project is currently a **pre-1.0 single-maintainer prototype** (`version: 0.0.0` in
`package.json`). There is no long-term-support branch yet — security fixes are made against
the latest commit on `main` only.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| Anything older / tagged releases before 1.0 | No — please upgrade to latest `main` |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately using one of these channels, in order of preference:

1. **GitHub Security Advisories** — use the "Report a vulnerability" button under this
   repository's Security tab (private by default, and lets us collaborate on a fix before
   disclosure).
2. **Email** — 1290yasir@gmail.com. Please include:
   - A description of the vulnerability and its potential impact (e.g. "manufactures an
     independent-looking Sybil witness," "bypasses the fail-closed eviction gate,"
     "rewrites the audit checksum chain without checkpoint/sink divergence,"
     "breaks demote-never-delete").
   - Steps to reproduce, or a minimal proof-of-concept.
   - Which module(s) are affected (`identity/`, `ratification/`, `store/sqliteStore.ts`,
     `traversal/`, `forgetting/`, `agent/`, `mcp/`, etc.) if known.
   - Your assessment of severity, if you have one.

We aim to acknowledge reports within **5 business days**. Since this is currently a
single-maintainer project, a fix timeline will depend on severity and complexity, but we
will keep you updated on progress.

## Scope and threat model — what counts as a security issue here

Given the project's own design philosophy ("identity is priced, not prevented" — see
CLAUDE.md's "hard theorem" section), please treat as in-scope anything that:

- Lets a single actor manufacture **independence** it hasn't earned — e.g. defeats the
  anchor self-stack ladder cap, extracts a DOMAIN-grade anchor from the trust registry
  without the registry config actually verifying it (`identity/trustRegistry.ts`'s claim
  producers: owner, SSO tenant member, publisher, system-of-record), or fools the
  maximum-independent-set root count into over-counting Sybil sources.
- Defeats the **PSL publisher collapse**: any way to make N pages/subdomains of one
  registered domain (eTLD+1, via the bundled Public Suffix List in
  `identity/binders/publicSuffix.ts`) count as more than one witness, or to make one
  operator's fleet of domains escape the `operatorOf` fleet-cap axis.
- Defeats the **relay fix / causal-origin inheritance** (`WriteFactInput.causalOrigin`):
  any way for a relayed or re-fetched fact to mint a fresh independence class it should
  have inherited — manufacturing corroboration out of one underlying observation — or,
  conversely, to abuse class inheritance to collapse a genuine multi-class dispute into a
  same-class echo (the echo gate exists precisely to stop this).
- Lets a source **contradict, corroborate, or ratify its own claims** — any path where the
  web ends up as its own witness (violates the "model is never its own witness"
  invariant), including bypassing the quarantine-exit independence gate or the
  distinct-approver / anchor-disjointness gates on `approve()`.
- **Tampers with the audit checksum chain at rest** without `verifyChain()` /
  `integrityCheck()` detecting it — a persisted byte-flip that still verifies green is a
  serious bug. Note the deliberate boundary: an actor with **live write access** rewriting
  history and recomputing every checksum is the documented asserted-attribution trade-off,
  *detected* by checkpoint (`chainHead()`) divergence and by real-time `AppendSink`
  shipping (ship-before-write), not prevented locally. A way to rewrite history that
  **reproduces a previously exported checkpoint** or **does not diverge from an
  already-shipped sink copy** would break that detection story and is very much in scope.
- Escapes the **atomic compound write** boundary to leave a half-applied operation durable
  (a demotion with no matching OUTRANKS edge; a resolved dispute with no audit record)
  after a crash or unclean shutdown.
- Bypasses a **fail-closed** eviction gate (`forgetting/tiers.ts`) or a **fail-open**
  halting backstop such that a stop/evict decision is made silently instead of stamped —
  including any way for the MCP boundary (`mcp/handler.ts`) to surface a PROVISIONAL or
  DEMOTED fact **without** its state label, or for untrusted payload text to forge the
  structure of a dispute-resolution message.
- Any standard software-security issue in the SQLite persistence path (e.g. SQL
  injection-style query construction — though the store uses parameterized queries by
  design).

Explicitly **out of scope for this pre-1.0 prototype** (see CLAUDE.md's KNOWN LIMITATIONS —
these are known, documented trade-offs rather than hidden gaps):

- **Asserted attribution.** `signerSourceId` on audit records — and source identity
  everywhere — is asserted by the writing process, not cryptographically proven; there is
  no third-party non-repudiation. Reports that amount to "an insider with write access can
  rewrite the local chain" restate the documented trade-off; reports that *defeat the
  checkpoint/sink divergence detection* of such a rewrite are in scope (above).
- **Registry configuration is the security policy.** A deployment that mis-configures its
  trust registry (wrong verified tenant domains, wrong tracked publishers, wrong systems
  of record) silently mis-weights independence — the same liability family as offline
  independence-class assignment. This is an operator responsibility the code cannot solve.
- Cross-process / concurrent-writer coordination, encryption-at-rest, and
  backup/point-in-time recovery (deployment concerns, tracked in
  `docs/product/ROADMAP.md`).
- Choosing an access-segregated destination for `AppendSink` shipping and `chainHead()`
  checkpoints (reference sink implementations live in `src/examples/auditSinks.ts`; the
  destination is a deployment decision).
- **Prompt injection of the consuming agent.** This layer governs how much *weight* a
  claim carries in memory; it cannot stop an agent from being manipulated by hostile text
  it reads. That is the consuming application's responsibility, stated rather than assumed
  away.

## Disclosure

We follow coordinated disclosure: please give us a reasonable window to investigate and
ship a fix before any public write-up. We're happy to credit reporters (by name or
handle, or anonymously if preferred) in the fix's release notes/changelog once resolved.
