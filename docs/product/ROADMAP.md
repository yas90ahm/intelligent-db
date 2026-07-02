# Intelligent DB — Product Roadmap

> Status snapshot this roadmap is written against: **production-grade single-process
> prototype** (TypeScript on Node 24), after the five-phase **crypto-free rebuild**
> (`docs/launch/REBUILD_SUMMARY.md`): relay fix, crypto-free trust registry, trust-tiered
> quarantine ingest, per-tier dispute horn, and the re-measurement pass. The codebase
> builds and owns zero cryptographic machinery; the full Vitest suite is green (see
> `CLAUDE.md` for the current count — its Status line is the single canonical number).
> This document does not restate what ships — it is the list of what is **not yet
> built or decided**, drawn from `CLAUDE.md`'s "KNOWN LIMITATIONS" and
> `docs/launch/REBUILD_SUMMARY.md` §7 ("What remains open"). Nothing here should read as
> a capability claim; every item is a gap in the shipped prototype today.

## How to read this roadmap

`CLAUDE.md` splits gaps into two tiers: **CRITICAL** (would block calling this a durable
prototype) and **ACCEPTABLE** (known, deliberate limitations, each safe for a
single-process durable prototype). As of the current status, **zero CRITICAL gaps
remain** — atomic compound writes, crash-consistent reopen, and corruption detection
(structural `integrity_check` + the semantic chain verifier) are done and tested, and the
three launch-review findings (including the `ratify()` atomicity and `independentSources`
fail-open bugs an earlier draft of this roadmap carried as open §0 items) are **fixed and
regression-tested** — `docs/launch/BUGFIX_REPORT.md` is the closing record. Every item
below is therefore an ACCEPTABLE-tier gap or an open deployment/ownership decision.

---

## Near-term: the open items from the rebuild (REBUILD_SUMMARY §7)

### 1. Sink / checkpoint storage destinations

**Current gap:** insider-tamper detection for the audit ledger is built and tested — the
real-time `AppendSink` shipping hook (ship-before-write) and the exported `chainHead()`
checkpoint, with reference sink implementations in `src/examples/auditSinks.ts` (an
append-only file mirror, a crash-safe spool pattern for network destinations like a
company SIEM, an explicit availability wrapper, and the divergence-detection comparator)
— but the **destination** is deliberately not shipped code.

**What it takes:** pointing the sink and the checkpoint export somewhere the writing
process cannot touch — the company's audit stack, a WORM bucket, an append-only location
under a different account — and deciding the checkpoint cadence.

**What it unlocks:** the difference between "any at-rest tampering is caught and located"
(true today, locally) and "an insider with live write access who rewrites history is
caught at exactly the forged record" (true only once the shipped copies are
access-segregated). This is the load-bearing deployment step behind the
asserted-attribution trade-off.

### 2. Dispute-routing transport + reviewer operations (enterprise tier)

**Current gap:** `createDisputeRouter` (pure, deterministic, config-driven) maps open
disputes to owning groups (e.g. IdP groups), and the personal tier's dispute horn is
fully wired (`pendingQuestions()` / `resolvePending()` + the MCP tools). What is
deliberately not shipped is the **transport** — actually delivering a routed dispute to a
Slack channel / ticket queue / email — and the human side: reviewer staffing and SLAs.

**What it takes:** a thin delivery adapter per deployment (the router's output is
replayable plain data by design), plus an owner for the review queue.

**What it unlocks:** the enterprise dispute horn ringing somewhere someone actually
looks, instead of accumulating in `listPending()`.

### 3. Registry-config ownership (the security policy needs an owner)

**Current gap:** the trust registry consumes its policy from configuration — which SSO
tenants have verified custom domains, which publishers are tracked, which systems are
authoritative for which domains of fact. That configuration **is** the security policy
("the whole table is one swappable trust root"), and a misconfigured registry silently
mis-weights independence — the same liability family as offline independence-class
assignment.

**What it takes:** no code — a named owner, a review cadence, and change control for the
registry config in each deployment.

**What it unlocks:** the priced-anchor math resting on asserted claims someone is
actually accountable for.

### 4. Re-run the LLM-scored benchmarks against the rebuilt system

**Current gap:** the locally-runnable poisoning arms were re-measured against the rebuilt
tree at **0% attack success** (`docs/ARCHITECTURE_BENCHMARKS.md` §10.3), but the
LLM-scored end-to-end suites — FactWorld's headline "ID 0% vs RAG 98.7% / mem0 79.4%",
the PoisonedRAG reproduction, retrieval quality, cross-DB — need Ollama-served models, an
embedding pipeline, and the mem0 Python sidecar, none of which were available for the
re-measurement pass. Their numbers are labeled **HISTORICAL (pre-rebuild)** everywhere
they are quoted (`ARCHITECTURE_BENCHMARKS.md` §9–§10.4).

**What it takes:** the documented reproduction environment (`ARCHITECTURE_BENCHMARKS.md`
§6) and GPU time.

**What it unlocks:** retiring the HISTORICAL label — quoting the headline comparative
numbers as measurements of the system as it exists now.

---

## Near-term: the standing ACCEPTABLE gap list (unchanged by the rebuild)

- **Cross-process concurrency.** Single-process is assumed; WAL gives one writer + many
  readers, and a second writing process is rejected by SQLite's lock, not coordinated.
  Closing it means an app-level single-writer coordination layer (leader election / lock
  service) or a server-mode backend, with the `withTxn` atomicity invariants ported
  across. This is the precondition for the "multi-agent systems" persona
  (`USE_CASES.md`) to run agents as independent processes.
- **Encryption-at-rest.** The SQLite file is plaintext. OS/disk-level full-disk
  encryption is the documented interim posture; page-level encryption (SQLCipher or
  equivalent) would be a real trade-off against the zero-runtime-dependency constraint
  and needs an explicit decision.
- **Backup / restore / point-in-time recovery.** No snapshotting, no WAL-archiving PITR;
  recovery is "reopen the file." Any production deployment needs at minimum a documented
  backup cadence.
- **Schema migration / versioning.** Tables are `CREATE TABLE IF NOT EXISTS`; there is no
  `user_version` ladder. A field change needs a manual migration.
- **`synchronous=NORMAL` vs `FULL`.** NORMAL is the deliberate operating point (a
  power-cut can lose the last committed transaction but never corrupt the file or leave a
  half-applied compound op). Zero-loss-on-power-cut deployments need the `FULL` knob
  exposed as a documented configuration choice, at a throughput cost.

## Long-term

- **Class-assignment tooling.** Offline independence-class assignment is "a standing
  human-judgment liability the code cannot solve" (`CLAUDE.md`). Tooling that surfaces
  operator/registrar/tenant metadata to the human assigning classes would reduce the
  error rate of that judgment without pretending to eliminate it.
- **Distributed / federated deployment.** Beyond "two processes share one file": a
  sharded or replicated store where the audit-shipping divergence check doubles as a
  cross-replica consistency mechanism.
- **Tuning-knob refinements flagged as "known simplifications" in `CLAUDE.md`:**
  activation uses path *dominance* rather than reinforcement-by-summation; `noveltyOf` is
  a 0/1 signal where a saturating curve is a tuning knob; `independenceFromStamp` reads
  `anchor_cost` directly rather than pairwise anchor-set disjointness against the
  thread's other endpoint; `description_value` is an order-0 entropy proxy, not true
  reconstruction-loss vs independent neighbors. None block correctness today; they are
  calibration opportunities once real usage data exists.

## Retired (crypto era) — dropped, not deferred

These items appeared on earlier versions of this roadmap and are **retired with the
machinery they extended**, per the crypto-free rebuild (`docs/launch/REBUILD_SUMMARY.md`;
historical design in `docs/history/ARCHITECTURE.md`). They are listed so their absence
reads as a decision, not an omission:

- **HARDWARE / KYC / FINANCIAL_STAKE anchor binders.** The codebase no longer mints or
  proves anchors at all — identity claims are consumed from deployment configuration. The
  anchor-cost table's high-trust rows are now populated by registry claim producers
  (owner, system-of-record, config-verified domains); staking is retired outright
  (permanent named attribution + the disown clawback is the deterrent).
- **Real DNS-01 / email-round-trip anchor services.** The prover seams these would have
  filled were deleted with the binder pipeline.
- **Merkle witness sinks / signed tree heads.** The RFC-6962 layer is deleted, not
  replaced; it was detection-given-live-witnesses and the witnesses were never built, so
  nothing currently delivered was lost — but efficient third-party inclusion/consistency
  proofs are foreclosed. The history-rewrite threat it addressed is covered by the
  checksum chain + checkpoint export + real-time shipping (item 1 above), under the
  disclosed asserted-attribution trade-off.

---

*Source of truth for every gap-list claim above: `CLAUDE.md`, section "KNOWN LIMITATIONS",
and `docs/launch/REBUILD_SUMMARY.md` §7. If this roadmap and `CLAUDE.md` ever disagree,
`CLAUDE.md` is canonical. For process/maturity context (single-maintainer status,
semver-`0.0.0`), see `docs/project-management/GOVERNANCE.md` and `RELEASE_PROCESS.md`; for
the full, correctly-caveated benchmark number set, see `docs/marketing/COMPARISON.md`.*
