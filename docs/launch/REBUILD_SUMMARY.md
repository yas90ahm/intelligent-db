# The Crypto-Free Rebuild — Plain-Language Summary

**Date: 2026-07-02.** This document describes the five-phase autonomous rebuild of
Intelligent DB's identity and trust layer, written for a non-engineering reader. It covers
what changed and why, what hostile reviewers found along the way (all of it), the measured
security results against the old baselines, the trade-offs that were accepted by name, and
what is still open. Everything described here currently lives in the **uncommitted working
tree** on the `master` branch — nothing has been committed or pushed.

---

## 1. Why the rebuild happened

The previous version of Intelligent DB proved sources were who they said they were using
cryptography this project built and operated itself: signing keys for every source, domain-
ownership proofs, a Merkle audit tree, and a staking system. That machinery worked, but it
answered the wrong deployment question. Real users are either one person's agents (where
the owner is the trust root and key ceremonies are pointless friction) or a company's agent
fleet (where the company's existing login system — SSO — already knows who everyone is).
The rebuild's premise: **keep the trust math, delete the home-built cryptography, and
consume identity from infrastructure the deployment already has** instead of manufacturing
proof of it.

One thing did not change: the core memory design (the "spider-web" — facts surfaced by
spreading activation, contradiction demoting but never deleting, independent corroboration
required before belief) was declared untouchable and was not touched.

## 2. What changed, phase by phase

**Phase 1 — the relay fix.** A real bug, no attacker required: if agent A researched a
fact and told agent B, and B wrote it to memory, the system counted that as *two*
independent witnesses of one observation. Fixed structurally: a fact can now declare where
it causally came from (a tool call, a document, the user, or another agent's statement),
and a relayed fact inherits its source's identity instead of minting a fresh one. Two
agents fetching the *same* web page now count as one witness, not two.

**Phase 2 — the crypto-free trust registry.** All cryptographic machinery was deleted:
signing keys, domain-proof challenges, the Merkle audit tree, staking. In its place, a
trust registry that *consumes* identity claims from configuration: the owner's own word
(personal deployments), SSO tenant membership (company deployments), and web publishers
collapsed to their registered domain via a bundled Public Suffix List — so fifty pages
from one website count as one witness, while fifty genuinely different site owners count
as fifty. The audit trail became a checksum chain: any tampering with stored history is
detected and located, with an exportable "checkpoint" fingerprint that a rewritten history
cannot reproduce.

**Phase 3 — trust-tiered quarantine.** Previously, any source's claim was believed on
arrival. Now, facts from low-trust sources (anonymous input, unrecognized websites) land
in a visible "provisional" state: recallable and clearly labeled, but structurally unable
to overturn an established fact, and released only when someone genuinely independent
corroborates them or a reviewer approves them.

**Phase 4 — the dispute horn, per tier.** When two genuinely independent sources disagree
and neither has clearly earned more trust, the system refuses to pick a winner itself and
rings a bell instead. Personal deployments now surface these as plain questions the owner
answers (with the owner's override receipted permanently in the audit trail). Enterprise
deployments route each dispute to the right owning group from the company's directory.

**Phase 5 — re-measurement and closeout (this pass).** Every benchmark that can run
locally was re-run against the rebuilt system; every red-team breach was triaged and
classified accurately; two real fixes came out of it (section 3); the documentation was
updated to separate fresh numbers from historical ones.

## 3. What the hostile reviewers caught — the review findings

Every phase was reviewed adversarially, and every finding is listed here, including the
ones found in this final pass.

- **Design review (before any code):** the initial proposal would have given a brand-new
  SSO tenant the same trust weight as a verified organization — but creating a fresh SSO
  tenant takes five minutes and costs nothing, which would have quietly reopened the exact
  cheap-identity attack this layer exists to stop. Fixed in the design: bare tenant
  membership is priced near email-grade; organization-grade weight requires a
  config-verified custom domain.
- **Design review, disclosed regression:** removing signatures means the audit trail's
  record of *who* wrote something is asserted, not cryptographically proven. This was
  disclosed bluntly at design time rather than discovered later, and it remains the
  rebuild's headline trade-off (section 5).
- **Relay-fix review (Phase 1, before landing):** two holes caught and closed. A fact
  that *contradicted* a cited source could still inherit that source's identity,
  collapsing a genuine dispute into a fake echo — now inheritance requires actually
  agreeing. And disowning a middleman could unfairly punish the honest source upstream of
  him — now the punishment stops at what the fraudster actually owned.
- **Phase-4 review:** the tool boundary that agents talk through was hardened — recalled
  facts now carry visible state labels (demoted/provisional), and untrusted text is
  escaped so a hostile fact cannot forge the structure of a reviewer's approval message.
- **Phase-5 triage finding:** the "review queue" that flags consulted-but-uncited
  influence for human eyes only looked one step deep, so a two-step relay escaped review.
  Fixed: it now follows the whole chain (still human-review-only — it never auto-punishes).
  This turned one standing red-team breach into a defense.
- **Phase-5 independent audit finding:** one red-team attack ("subdomain seam") was still
  scoring as a breach because the *test harness* modeled the old system without a Public
  Suffix List — the rebuilt system actually ships and wires exactly that defense. The
  test was corrected to attack the real shipped mechanism, which defends it. This was a
  bookkeeping error in the benchmark, reclassified — not a new defense.

The pattern worth stating plainly: at every stage, an independent second look found
something the stage's own tests had not. That is why the process keeps using them.

## 4. The measured security numbers

**Red-team suite** (97 attack specs, real engine, re-run 2026-07-02):

| System | Breaches |
|---|---|
| V1 (crypto era) | 59 |
| V2 (crypto era, hardened) | 25 — all documented, accepted residuals |
| **Rebuilt (crypto-free)** | **18** |

The 25 → 18 improvement decomposes with no sleight of hand: 5 attacks targeted the
deleted Merkle/signing layer and are *retired with their target* (removed, not defended
— their goal now falls under the asserted-attribution trade-off); 2 were genuinely fixed
during this pass (the two Phase-5 findings above); the remaining 18 are identical to
V2's documented residuals — **zero new breaches, zero regressions**. Each residual maps
to a named boundary: attacks that cost real, linear money ("priced, not prevented"),
human misjudgment in offline class assignment, the deliberate choice that memory retrieval
fails open (surfacing low-trust facts *with a warning label* rather than hiding them), and
the proven theorem that the system cannot witness content causality from inside.

**Poisoning immunity** (the "stay at least as good as mem0/Zep" rule): the locally
runnable poisoning benchmarks re-ran at **0% attack success** — a cheap fake-source fleet
of up to 500 identities collapses to a single witness and never flips a true fact, while
vanilla RAG and a passport-only ablation flip at 3 fakes. The honesty control also still
behaves as designed: an attacker who buys genuinely independent, expensive anchors *can*
win — that is the priced-not-prevented thesis, visible in the numbers.

**Not re-run** (requires local LLMs, embedding models, and a Python sidecar that were not
available): the LLM-scored end-to-end benchmarks — factworld's headline "Intelligent DB 0%
vs RAG 98.7% / mem0 79.4%", the PoisonedRAG suite, retrieval quality, and cross-DB
comparisons. Those numbers are preserved in `docs/ARCHITECTURE_BENCHMARKS.md` labeled
**HISTORICAL (pre-rebuild)** and should be quoted as such until re-run.

**Engineering health:** typecheck clean; full test suite **405 passed, 26 skipped**
(the skips are the gated benchmarks that need external services; count as of that phase —
the suite keeps growing, and `CLAUDE.md`'s Status line is canonical for the current count).

## 5. The trade-offs, named

- **Asserted attribution (the big one).** Without signatures, the audit trail's claim of
  who wrote each record rests on the writing process being honest at write time. The
  checksum chain catches any tampering with stored history, and two shipped mechanisms
  catch even a full rewrite: an exported checkpoint fingerprint, and — added post-Phase-5 —
  **real-time shipping**: an optional one-line hook (`onLedgerAppend`) hands every audit
  record to external storage *before* it is written locally, so a rewritten local history
  diverges from the already-shipped copy at exactly the forged record (proven by an
  executable test that fools the local verifier completely and is still caught). Both
  need a destination the writer cannot reach — a deployment step, not shipped code.
  Third-party non-repudiation ("prove to an outsider who wrote this") is gone — though
  notably, the removed signing key lived in the same writing process, so it never truly
  provided that against an insider either; the guarantee always came from segregation.
- **Registry claims are configuration, not proof.** Trust weights now rest on what the
  deployment's configuration asserts (which SSO tenants have verified domains, which
  systems are authoritative). A misconfigured registry silently mis-weights independence.
- **The Merkle layer is deleted, not replaced.** In practice it was delivering nothing
  (its external witnesses were never built), but the future capability of efficient
  third-party proofs is foreclosed.
- **Staking is retired.** Permanent named attribution plus the retroactive disown sweep
  is the deterrent now; nothing is financially at stake.
- **Prompt injection is named, not solved.** This layer governs how much *weight* a claim
  carries — it cannot stop an agent from being manipulated by hostile text it reads. That
  is the consuming application's responsibility, stated rather than assumed away.

## 6. The four rules the rebuild ran under, and how each held

1. **Stay green.** Typecheck and the full test suite pass at every step; they pass now
   (405 tests, zero failures — count as of that phase; `CLAUDE.md` is canonical for the
   current count).
2. **Never regress below mem0/Zep on security.** Poisoning immunity re-measured at 0%
   attack success on every locally runnable arm; zero new red-team breaches vs the old
   baseline.
3. **The spider-web is untouchable.** No changes to traversal, halting, or forgetting.
   Several red-team residuals *could* have been "fixed" by gating retrieval on trust —
   that was refused each time, because retrieval deliberately fails open (label, don't
   hide) and a hard gate provably starves genuine single-witness insights.
4. **No cryptography.** The codebase builds and owns zero cryptographic machinery. Both
   Phase-5 fixes are plain logic. SHA-256 survives only as a checksum, not as identity.

## 7. What remains open

Decisions and work that belong to the owner:

- **Push to GitHub.** Everything — Phases 1 through 5 — is uncommitted local work.
  Committing, and setting up the remote/auth that does not exist yet, is the next step.
- **Re-run the external-dependency benchmarks** (needs Ollama, embedding models, and the
  mem0 Python sidecar) so the headline LLM-scored numbers stop being historical.
- **Sink/checkpoint storage destination.** The real-time shipping hook and the
  checkpoint export are both built and tested, and reference implementations ship in
  `src/examples/auditSinks.ts` (an append-only file mirror, a crash-safe spool pattern
  for network destinations like a company SIEM, an explicit availability wrapper, and
  the divergence-detection comparator — all typechecked and tested with the suite).
  Insider-tamper detection depends on pointing them somewhere the writing process
  cannot touch (the company's audit stack, an append-only location under a different
  account). Choosing that destination is a deployment decision.
- **Enterprise operational items.** Dispute-routing transport and reviewer staffing/SLAs;
  the registry configuration itself (which publishers and systems of record to trust) is
  the security policy and needs an owner.
- **Known engine residuals** are documented in `CLAUDE.md`'s gap list and
  `docs/ARCHITECTURE_BENCHMARKS.md` §10 — none are hidden, none are new.

## 8. Council review pass (2026-07-02)

After the rebuild landed, a multi-persona review council (engineering, security,
operations, and narrative reviewers) audited the whole tree and proposed a ranked
change list; the accepted items were implemented in three batches and independently
re-verified (typecheck clean; full suite green at the count in `CLAUDE.md`).

**Landed:**

- Fixed a SQLite transaction-nesting bug where an inner rollback could silently
  poison every later "atomic" operation; commit-after-rollback now throws loudly,
  the WAL journal mode is verified rather than assumed, and network (UNC) database
  paths are rejected by default.
- `content_hash` now uses canonical (key-order-independent) JSON, so the same claim
  serialized in a different key order is recognized as the same claim (corroboration,
  relay class inheritance, and disown dedupe all depended on this).
- A recall whose seed ids all fail to resolve now returns an explicit
  `NO_SEEDS_RESOLVED` degraded stamp instead of looking like a healthy empty answer.
- MCP boundary hardened: `remember` accepts an `origin` (web/document/tool input is
  quarantined PROVISIONAL instead of inheriting owner trust), all inputs have named
  size caps, the stdio reader is bounded against oversized lines, the server file is
  directly executable, and `recall` accepts `cue` as an alias for `query`.
- The audit-mirror reader survives torn (crash-truncated) final lines and names the
  exact line on mid-file corruption.
- README rewritten around the measured story with a verified runnable quickstart;
  `docs/launch/REVIEW_FINDINGS.md` added (each review finding, its fix, and its regression test); the
  four crypto-era root docs moved to `docs/history/` with HISTORICAL banners and
  every live doc reconciled to the crypto-free design; test counts single-sourced
  to `CLAUDE.md`.
- Launch hygiene: package entry-point metadata + Apache-2.0 license field, a build
  config that keeps tests/benches out of `dist`, CI triggers include `master`, and
  an off-repo backup script for the uncommitted work (run once, verified).
- `npm run demo`: a 60-second narrated script — the owner's facts stay LIVE, a
  50-identity flood lands quarantined, a genuine dispute rings the horn and
  resolves with the loser DEMOTED, receipts printed — pinned by its own test.

**Deferred to the owner / next pass:** durable persistence for the scar
rate-limiter window; injectable clocks at the engine/walk seams; quarantining the
heavy benchmark harness out of the default install; a `db.explain()` belief
dossier + MCP tool; `beliefTimeline()` time-travel recall; contested-fact labels
at the recall boundary; an OWASP LLM Top 10 mapping doc; vector-guard positioning;
bring-your-own-memory benchmark packaging; the full getting-started ladder; and
all publish decisions (commit, remote, npm, license flip). One proposal (a
pid-based single-writer lock file) was rejected as unsound.
