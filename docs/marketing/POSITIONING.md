# Intelligent DB — Positioning

> Status note: Intelligent DB is a production-grade **single-process prototype** (TypeScript,
> Node ≥20, zero runtime dependencies). It is not a hosted product or a managed service. This
> document positions the project as it exists in this repository today; see
> [`../../CLAUDE.md`](../../CLAUDE.md) for the full design and the known-limitations list, and
> [`../ARCHITECTURE_BENCHMARKS.md`](../ARCHITECTURE_BENCHMARKS.md) for the measured evidence
> behind every benchmark claim referenced below.

## Tagline

**Memory that knows who told it, and never lets a crowd of liars outvote one honest witness.**

## The pitch

AI agents fail in two specific ways: they **forget** (context and history evaporate across
sessions) and they **hallucinate** (they invent facts and can't distinguish recall from
invention). Most "agent memory" products are a thin retrieval layer over a vector database —
nearest-neighbor lookup with no structural memory and no concept of who asserted what. That
architecture has a load-bearing weakness: similarity search ranks by *how similar*, and an
attacker (or just a bad, repeated data source) who can inject enough near-duplicate content
wins by *density*, not by truth.

Intelligent DB is a deliberate inversion of that design. Memory is modeled as a
**memory palace / spider-web**: facts are latent by default and are only surfaced by
**spreading activation** — a cue energizes a seed strand and activation propagates across
structural links until a cluster of genuinely relevant, well-corroborated facts "lights up."
Nothing is retrieved by raw similarity; everything is retrieved by traversing a graph whose
edges are formed by shared entities and confirmed relationships, and whose provenance is
first-class on every node.

On top of that traversal substrate sits a **Source-Identity Layer** — the part that makes the
system resistant to poisoning where undefended retrieval is not. Every asserted fact carries
provenance back to a source identified through infrastructure the deployment already trusts
(the owner's own word, SSO tenant membership, a registered domain) — consumed from
configuration by a crypto-free trust registry, not manufactured by home-built key ceremonies.
Sources don't just get to claim independence from one another: independence is measured
against **scarce, externally-priced anchors** (a registered domain collapsed to eTLD+1 via a
bundled Public Suffix List, a config-verified SSO custom domain, a registry-configured system
of record), so minting a thousand fake "independent" witnesses costs a thousand times
more than minting one. Trust is a slowly-earned, fast-lost Beta-distribution reputation score,
not a headcount. Contradictions are adjudicated by a decisive-or-defer rule keyed to *earned*
reputation and anchor diversity — never by majority vote — and anything not clearly decisive
escalates to a human instead of silently picking a winner. When a source turns out to be bad,
`disown()` runs a full backward taint-closure: everything that source's fabrications
influenced is demoted (never deleted — the audit trail survives) and every reputation gain
that rested on that influence is reversed exactly.

## Target audience

Teams building **long-lived AI agents and assistants** that need to remember across sessions
and can't afford silent poisoning of that memory:
- Agent/assistant platforms accumulating user- and tool-sourced facts over weeks or months,
  where a single bad, repeated, or adversarial data source (a scraped page, a malicious tool
  response, a coordinated prompt-injection campaign) must not be able to overwrite what the
  agent believes just by showing up more often than the truth.
- Multi-agent / multi-source systems where facts arrive from many different tools, users, or
  sub-agents of varying trustworthiness, and the system needs a principled way to decide whose
  word counts more — and to say "I'm not sure, ask a human" instead of guessing.
- Builders who want an **auditable** memory: every belief traces back to the source(s) that
  asserted it, every contradiction resolution is logged in a tamper-evident, hash-chained
  ledger, and nothing is ever silently deleted — a fact that was true and later superseded is
  demoted and kept, not erased.
- Teams already using MCP (Model Context Protocol) tooling: the engine exposes a JSON-RPC/MCP
  surface (`mcp/handler.ts`, `mcp/server.ts`) so an agent can read and write this memory as a
  standard tool.

Not (yet) the right fit for: teams that need a hosted/managed multi-tenant service, encryption
at rest, cross-process concurrent writers, or fuzzy semantic search as the primary retrieval
mode (see "What this is not," below, and the known-limitations list in `CLAUDE.md`).

## Key differentiators

1. **Structural, not statistical, retrieval.** Spreading activation over a provenance graph,
   not nearest-neighbor similarity. A cluster of near-duplicate injected content doesn't win by
   density — it collapses to one corroborating witness (same-root echoes are recognized and
   discounted, never counted as independent confirmation).
2. **Identity is priced, not assumed.** Two facts from the same underlying source are an echo.
   Independence between sources is measured against costly, real-world anchors, with a
   provable maximum-independent-set count (Bron–Kerbosch/Tomita) standing in for "how many
   genuinely different witnesses actually agree" — not headcount.
3. **Trust is earned slowly and lost fast.** A Beta(α,β) reputation model with independence-
   weighted evidence, 4× asymmetric penalty for being wrong, exponential time-decay applied on
   every read, and a lower-confidence-bound readout so fresh, untested sources score near zero
   no matter how many of them show up at once.
4. **Contradictions defer to humans when it matters, and never resolve by majority.** A
   decisive-or-defer adjudicator only auto-resolves a dispute on a clear, earned reputation
   margin; ambiguous or high-impact disputes are queued to the tamper-evident, checksum-chained
   "pending ratification" ledger for a human call — never picked by counting votes. The
   personal tier surfaces these as plain questions to the owner; the enterprise tier routes
   each dispute to its owning group from directory config.
5. **Demote, never delete.** Contradiction and disowning a bad source both work by demoting
   affected facts (kept as history, archive stub intact) and reversing exactly the reputation
   credit that rested on them — nothing is silently erased. Per `CLAUDE.md`'s hardening-tick-3
   writeup, the compound writes behind adjudication-resolve, approval, and the disown sweep
   each run as one atomic, crash-consistent transaction over the shared SQLite handle; this is
   an actively-reviewed area (see the project's ongoing code-review notes and
   `docs/product/ROADMAP.md`) rather than a closed, never-revisited guarantee.
6. **Tamper-evident by construction — with the trade-off named.** An append-only SHA-256
   checksum chain over the audit ledger: `verifyChain()` names the first broken record on any
   at-rest byte-flip, `chainHead()` exports an O(1) checkpoint a rewritten history cannot
   reproduce, and an optional real-time `AppendSink` hook ships every record to external
   storage *before* the local write, so an insider rewrite diverges from the already-shipped
   copy at exactly the forged record. Attribution is asserted, not signed — detection against
   an insider rests on storing those copies where the writer can't reach, a disclosed
   deployment step, not a hidden assumption.
7. **Empirically validated, not just argued.** A benchmark suite (FactWorld, a faithful
   PoisonedRAG reproduction on NQ/HotpotQA/MS-MARCO, a label-free "non-oracle" structural
   defense, and a disclosed failure-mode boundary) measures the claim instead of asserting it —
   see the Comparison doc and `docs/ARCHITECTURE_BENCHMARKS.md` for the numbers and the
   caveats attached to each.
8. **Zero runtime dependencies.** The engine itself (`dependencies: {}`) ships on Node
   built-ins only; SQLite/WAL persistence with atomic compound writes. The heavy packages in
   `devDependencies` exist solely to drive the benchmark harness, not the shipped library.

## What this is not

- Not a vector database, and not a drop-in replacement for one where fuzzy semantic search is
  the actual requirement — Intelligent DB's own benchmarks show its coverage is
  graph-construction-bound, and a vector-rerank layer on top is a complementary, not
  competing, technique (see `retrieval-quality` notes referenced in `CLAUDE.md`/benchmarks).
  It is a deliberate *inversion* of that architecture, built for a different failure mode.
- Not Sybil-proof — it is Sybil-*priced*. A patient, well-funded attacker who buys genuinely
  distinct, disjoint real-world anchors (and reputation) can still eventually win; the project
  states this residual explicitly rather than claiming an impossible guarantee (see the
  "costly-independent boundary" benchmark and KNOWN LIMITATIONS in `CLAUDE.md`).
- Not yet a multi-process / multi-tenant service: single-process SQLite/WAL is the current
  durability model; no encryption-at-rest, and the access-segregated destination for audit
  shipping/checkpoints (a SIEM, an append-only account) is a deployment decision, not shipped
  code — reference sink implementations live in `src/examples/auditSinks.ts`.
- Not a finished, audit-closed system. This is a single-maintainer prototype under active,
  ongoing code review; treat every claim above as "true of the design as documented in
  `CLAUDE.md`," not as a guarantee that every code path has zero open findings. Track
  in-progress hardening work in `docs/product/ROADMAP.md`.

## Related documents

- [`../product/USE_CASES.md`](../product/USE_CASES.md) and
  [`../product/ROADMAP.md`](../product/ROADMAP.md) — who this is for today, and what closes
  the remaining gaps.
- [`../project-management/GOVERNANCE.md`](../project-management/GOVERNANCE.md) — how changes
  to the settled architecture get proposed and reviewed.
- `CONTRIBUTING.md` (proposed, not yet committed as of this writing) — for anyone who wants to
  work on the gaps above instead of just reading about them.
