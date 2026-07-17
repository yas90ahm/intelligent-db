# Intelligent DB — Use Cases

> Intelligent DB is a memory substrate for AI agents — a deliberate inversion of a vector
> database. Instead of fuzzy nearest-neighbor lookup, facts are latent by default and
> surface only via spreading activation over a provenance graph; contradiction demotes
> rather than deletes; and source identity is priced and witnessed from outside the graph
> (the Source-Identity Layer). See `CLAUDE.md` and `docs/ARCHITECTURE_ENGINE.md` for the
> full current design (the crypto-era design is preserved at `docs/history/ARCHITECTURE.md`).
> This document describes who that design is for and why, grounded in what is actually
> implemented today (see `CLAUDE.md`'s "Status" and "KNOWN LIMITATIONS" — this is a
> **single-process prototype**; claims below are scoped accordingly, and each persona
> section notes the current-prototype caveats that matter to it).

---

## 1. AI agent framework builders

**Who:** teams building agent frameworks, assistants, or copilots (in the spirit of
LangChain/AutoGPT-style stacks, or direct Claude/MCP-based tool use) who need their agent
to remember across turns and sessions without hand-rolling a memory layer, and without
inheriting a vector DB's blind spot for prompt-injected or poisoned "facts."

**Why Intelligent DB fits:**
- It ships a working **MCP server** (`src/mcp/server.ts`, zero external runtime
  dependencies) exposing `remember`, `recall`, `list_pending_questions`, and
  `resolve_pending` as tools any MCP-speaking agent client can call directly —
  `claude mcp add intelligent-db -- node dist/mcp/server.js`, or a standard `mcpServers`
  JSON block. No custom integration glue is required to wire an agent up to durable,
  provenance-tracked memory — including the dispute horn: when two independent sources
  genuinely disagree, the agent can ask the owner and record their answer.
- The **two governing invariants** map directly onto agent-safety concerns framework
  builders already worry about: "the model is never its own witness" means an agent's own
  guesses can be recorded as DERIVED facts and *spoken with derivation shown*, but they
  never silently become as-good-as-observed truth until an external source ratifies them
  — a structural check against an agent confidently hallucinating its way into its own
  long-term memory.
- **Latent-by-default, activation-surfaced recall** (not embedding similarity) means
  irrelevant or superficially-similar-but-wrong memories don't get pulled in just because
  they're nearby in vector space; only strands connected by shared entities and
  confirmed links light up.

**Current-prototype caveats that matter here:** this is a **single-process** embedded
library (or a single MCP server process) today — see the "Cross-process concurrency" gap
in `docs/product/ROADMAP.md`. A framework that needs many independent agent processes to
share one memory store concurrently is not yet supported; each MCP server instance owns
its own SQLite file.

---

## 2. Enterprise knowledge assistants needing tamper-evident audit trails

**Who:** teams building internal knowledge assistants (support, legal, ops, engineering
runbooks) where "why did the assistant say that, and can we prove the record wasn't
altered after the fact" is a real question someone will eventually ask — during an
incident review, a customer dispute, or an internal audit.

**Why Intelligent DB fits:**
- Every mutation lands in an **append-only, SHA-256 checksum-chained audit ledger**
  (`src/ratification/pendingLedger.ts`); `verifyChain()` walks the whole chain, recomputes
  every checksum, and names the *first broken record* if anything stored was tampered with
  — flip one persisted byte anywhere and it is caught and located, not just "probably fine."
- **Insider-tamper detection is built in as two composable, plain-data mechanisms:**
  `chainHead()` exports an O(1) checkpoint fingerprint that a rewritten history cannot
  reproduce, and an optional real-time **`AppendSink`** hook hands every audit record to
  external storage *before* the local write (ship-before-write), so a rewrite that fools
  the local verifier still diverges from the already-shipped copy at exactly the forged
  record. Reference sink implementations (append-only file mirror, a crash-safe spool
  pattern for a SIEM, the divergence-detection comparator) ship in
  `src/examples/auditSinks.ts`.
- **Demote-never-delete** means the audit trail itself is immortal: a contradicted or
  disowned fact is archived as an immortal stub (content hash + provenance + timestamps
  intact), never erased, so "what did the system believe, and when, and why did it
  change its mind" is always reconstructable.

**Current-prototype caveats that matter here:** the named trade-off of the crypto-free
design is that **attribution is asserted, not signed** — who wrote each audit record rests
on the writing process being honest at write time, and an actor with live write access can
rewrite local history and re-verify green. The checkpoint and shipping mechanisms above
detect exactly that, but only if their copies live somewhere the writing process cannot
touch — choosing that access-segregated destination (the company's audit stack, an
append-only account) is a deployment step, not shipped code (`docs/product/ROADMAP.md`).
Third-party non-repudiation ("prove to an outsider who wrote this") is gone with the
signatures. There is also no encryption-at-rest yet (the SQLite file is plaintext);
OS-level full-disk encryption is the documented interim mitigation. Cross-process
concurrency is likewise not yet supported. (An earlier draft flagged a then-open
code-review finding that `ratify()` was not atomic; it was fixed and regression-tested —
see `docs/history/launch-2026-07/BUGFIX_REPORT.md`.)

---

## 3. Regulated industries

**Who:** teams in finance, healthcare, insurance, or other compliance-heavy domains where
decisions need to be explainable, contested claims need a defensible resolution process,
and "an algorithm silently overruled a human-entered record" is not an acceptable
failure mode.

**Why Intelligent DB fits:**
- **Contradiction adjudication never resolves by majority or headcount.** A genuinely
  independent (multi-anchor-class) dispute over a fact either auto-resolves on a
  *decisive, earned* reputation margin (`decisiveMargin ≥ 0.30`, winner reputation
  `≥ 0.20`, and — for irreversible/high-impact decisions — an additional gate requiring
  ≥2 independent corroborations, a 90-day recency-clean window, and ≥2 disjoint anchor
  classes) or it **defers to a human** via the `PendingRatification` "vault and doorbell"
  (`src/ratification/pendingLedger.ts`): an append-only signed record of the open dispute,
  and an `approve()` path that enforces a **distinct-approver gate** (a disputed party
  cannot approve their own claim), a **provenance gate** (the approver must be registered
  with at least one priced anchor — no provenance, no voice), and an
  **anchor-disjointness gate** (the approver must be independent of every disputed
  author) before resolving.
- **Reputation is earned slowly and lost fast, never handed out for free.** A fresh
  identity scores exactly 0; `rep_cap` ceilings (from the anchor-cost table) bound how
  much trust even a well-behaved cheap identity can ever reach; one contradiction halves
  a high-reputation source's standing. This directly defeats the "flood the system with
  500 plausible-looking claims" attack pattern that a naive quorum/voting system is
  vulnerable to.
- **The `disown()` sweep gives a real retraction story.** If a source is later found to
  be compromised or fraudulent, `disown` runs a BFS taint-closure that demotes every
  strand transitively derived from it and reverses the *exact recorded* reputation credit
  it caused elsewhere — bounded to the recorded corroboration/derivation closure and
  documented as such, not oversold as unbounded (see `CLAUDE.md`'s corroboration-credit
  reversal section, "BOUNDED" not "exact in the unqualified sense").

**Current-prototype caveats that matter here:** trust-registry claims are
**configuration, not proof** — DOMAIN/ORGANIZATION-grade weight rests on what the
deployment's registry config asserts (e.g. a config-verified SSO custom domain, a
configured system of record), and a misconfigured registry silently mis-weights
independence. Offline independence-class assignment (deciding which real-world
roots are correlated) remains, per `CLAUDE.md`, "a standing human-judgment liability the
code cannot solve" — a class-assignment error silently weakens every downstream trust
bound, and no code change removes that responsibility from whoever operates the system.
(An earlier draft flagged a then-open code-review finding that the `independentSources`
predicate behind `approve()`'s independence gate failed open for unregistered sources; it
was fixed to fail closed and regression-tested — see `docs/history/launch-2026-07/BUGFIX_REPORT.md`.)

---

## 4. Multi-agent systems needing shared corroborated memory

**Who:** teams running several cooperating (or independently operated) AI agents that
need to build a shared fact base where agreement between agents actually means
something — i.e., two agents both claiming X is stronger evidence than one agent
claiming X twice, but only if the two agents are genuinely independent witnesses.

**Why Intelligent DB fits:**
- **Independence is measured, not assumed.** Two facts from the same underlying source
  key (or the same anchor — same domain, same email root) are recognized as an **echo**,
  not corroboration, no matter how many times the "same" agent repeats itself under
  different session IDs. Real corroboration requires disjoint anchors, computed as an
  **exact maximum-independent-set** (Bron–Kerbosch/Tomita) over the anchor-disjointness
  graph — so a fleet of near-identical low-cost agent identities collapses toward a
  single independence class instead of manufacturing false consensus.
- **`CROSS_WEB_BRIDGE` edges are the designed mechanism for one agent's web to
  illuminate another's.** The two-phase halting controller's mandatory bridge sweep
  guarantees every lit-but-uncrossed bridge gets at least one funded exploratory
  crossing from a separate sub-budget — the structural answer to "something a different
  agent/session learned last week is suddenly relevant now," the "web of webs" design.
- **The reputation ledger is the shared trust substrate across agents.** Because
  reputation is keyed to a stable, deterministic source id from the trust registry (not a
  session or a prompt), an agent that has built up track record keeps that earned trust
  across every other agent querying the same store, and a single misbehaving agent's blast
  radius is bounded by the disown sweep's taint closure rather than requiring a full
  manual audit.

**Current-prototype caveats that matter here:** today this composes multiple agents
sharing **one process's** in-memory or SQLite store (e.g., one MCP server instance, or
several logical agents inside one Node runtime) — genuinely independent agent
*processes* writing to the same store concurrently is the cross-process-concurrency gap
in `docs/product/ROADMAP.md`, not yet supported (SQLite's WAL mode rejects a second
concurrent writer rather than coordinating with it).

---

*Every capability claim above is grounded in `CLAUDE.md` (canonical status + design) and
`docs/ARCHITECTURE_ENGINE.md` (the current engine architecture, with file/line citations);
most caveats are drawn from `CLAUDE.md`'s "KNOWN LIMITATIONS." The launch code review's two
findings an earlier draft cited as open (persona 2 and persona 3) are fixed and
regression-tested — `docs/history/launch-2026-07/BUGFIX_REPORT.md` is the closing record. No benchmark
numbers appear in this document; for those, with correct historical and oracle-conditional
caveats attached, see `docs/marketing/COMPARISON.md`. See `docs/product/ROADMAP.md`
generally for what closing each caveat unlocks.*
