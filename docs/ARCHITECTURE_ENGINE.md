# Intelligent DB — Engine Architecture

**This documents the current, crypto-free engine** — the system as it ships today, after
the rebuild that deleted all self-minted cryptography (keys, signing, Merkle log, staking)
and replaced it with configuration-consumed identity. The pre-rebuild architecture is
preserved in [`history/ARCHITECTURE_ENGINE_CRYPTO_ERA.md`](./history/ARCHITECTURE_ENGINE_CRYPTO_ERA.md);
the original design plan is [`history/ARCHITECTURE.md`](./history/ARCHITECTURE.md).
Status, test counts, and known limitations live in [`../CLAUDE.md`](../CLAUDE.md) — the
canonical status document. Citations here are `file → symbol`, not line numbers, so they
survive edits; every named symbol is grep-able in `src/`.

---

## 1. Mental model

Intelligent DB is a **memory substrate for AI agents**, built against the two ways agents
fail: they **forget** (context evaporates across sessions) and they **hallucinate** (they
invent facts and can't tell recall from invention). It is deliberately **not** a vector
database — it is an inversion of one. A vector DB does fuzzy nearest-neighbor lookup over
an unstructured pile, which is exactly why it can't resist poisoning: similarity search
ranks by density, so whoever injects the most near-duplicates wins.

Instead, memory is modeled as a **spider-web / memory palace**:

- **Facts are latent strands.** Nothing sits in a readable list. A strand surfaces only
  when a recall cue energizes a seed and **spreading activation** propagates along
  structural threads until a cluster "lights up." Only lit strands are spoken.
- **Web of webs.** Dense local webs (one conversation, one tight cluster) are loosely
  connected by rare `CROSS_WEB_BRIDGE` edges. Activation jumping a bridge is what produces
  "something from last week is suddenly relevant."
- **The librarian proposes; the engine disposes.** The AI model decides *where* a new
  strand attaches (`CONFIRMED_LINK`, bridges); the mechanical shared-entity relation is an
  index the store maintains itself. Every load-bearing decision — when to stop walking,
  what is canonical, who is independent — is a gate, never a model judgment.
- **Contradiction demotes, never deletes.** A losing fact becomes `DEMOTED` history with
  an explaining `OUTRANKS` edge; derived facts like "X moved" *emerge* from one strand
  outranking another over time.

### The two governing invariants

1. **The model is never its own witness.** It files and speaks memories; it never confirms
   them. No provenance → no voice.
2. **The web is never its own witness about source identity.** Trust in *what* a fact is
   comes from inside the web; trust in *who* sourced it must come from outside.

### The hard theorem (why the identity layer is mandatory)

An adversarial design review proved that claim adjudication cannot be solved from inside
the graph: under "identity is priced, not prevented" (a patient attacker can pay a finite
cost to mint independent-looking sources), **no purely internal rule** can both (a) let one
true witness overturn a planted false canonical and (b) stop two fake sources from
overturning a true incumbent. Independence is a property of identity, and identity is
forgeable from inside a graph. Identity must therefore be witnessed from outside — the
Source-Identity Layer (§7). The rebuild's insight is that real deployments **already have
a trust root** (the owner, the company IdP, registered domains), so the layer *consumes*
identity from configuration rather than manufacturing its own.

---

## 2. Layering and module map

```
            ┌────────────────────────────────────────────────────┐
            │  Agent facade + MCP        src/agent/, src/mcp/    │   remember / recall /
            ├────────────────────────────────────────────────────┤   pendingQuestions / explain
            │  Engine verbs              src/api.ts              │   writeFact / recall / ratify /
            ├──────────────┬──────────────────┬──────────────────┤   adjudicate / approve / disown
            │  Traversal   │  Forgetting      │  Ratification    │
            │  src/traversal, src/recall      │  src/ratification│   walk+halting · tiers+consolidation
            ├──────────────┴──────────────────┴──────────────────┤   · audit chain + undo engine
            │  Source-Identity Layer     src/identity/           │   trust registry · anchors ·
            ├────────────────────────────────────────────────────┤   reputation · MIS count
            │  Storage                   src/store/              │   StrandStore: memory | SQLite/WAL
            └────────────────────────────────────────────────────┘
```

| Path | Role |
|---|---|
| `src/core/types.ts` | The shared contract: strand/edge model, enums, branded ids, identity stamp, walk config. |
| `src/core/canonicalJson.ts` | Key-order-independent JSON serialization — the `content_hash` "same claim" fingerprint. |
| `src/store/StrandStore.ts` · `memoryStore.ts` · `sqliteStore.ts` | Pluggable storage contract (no deletion by design) + in-memory and durable SQLite/WAL backends. |
| `src/recall/cueResolver.ts` | Cue→seed resolution (pluggable; zero-dep lexical baseline ships). |
| `src/traversal/walk.ts` · `halting.ts` | Share-normalized activation walk + the two-phase stop controller. |
| `src/forgetting/tiers.ts` · `consolidation.ts` | Tier decay + fail-closed eviction gates; echo collapse + decisive-or-defer adjudication. |
| `src/identity/sources.ts` · `trustRegistry.ts` | Deterministic source ids (sameness) + the configuration-consuming claim producers. |
| `src/identity/anchors.ts` · `binders/publicSuffix.ts` | Anchor-cost table, independence math, self-stack cap; eTLD+1 publisher collapse. |
| `src/identity/reputation.ts` · `index.ts` | Beta(α,β) reputation ledger; the layer facade + exact max-independent-set count. |
| `src/ratification/pendingLedger.ts` | The tamper-evident checksum-chain audit ledger + dispute vault/doorbell. |
| `src/ratification/corroboration.ts` · `disown.ts` · `weakInfluence.ts` · `adjudicationProvenance.ts` · `reconcile.ts` · `mutationReceipt.ts` | The undo engine: recorded credit, taint-closure sweep, human-review queue, margin re-opening, drift audit, mutation receipts. |
| `src/ratification/disputeRouting.ts` | Pure, deterministic enterprise dispute-routing adapter (IdP groups). |
| `src/api.ts` | The engine: `IntelligentDb` verbs, trust-tiered ingest, atomic compound writes, introspection. |
| `src/agent/agentMemory.ts` · `src/mcp/` | The agent facade (PERSONAL preset) + the zero-dependency stdio MCP server. |
| `src/index.ts` | Public barrel. |

The engine has **zero runtime dependencies** (`dependencies: {}` — only `node:` builtins);
it builds and owns **zero cryptographic machinery**. Plain SHA-256 appears only as a
checksum: content hashes, hash-chained audit records, deterministic ids.

---

## 3. Data model (`src/core/types.ts`)

**Branded identifiers** (`StrandId`, `EdgeId`, `SourceId`, `ContradictionSetId`,
`AttributeKey`, `EpochMs`, …) make id-mixups type errors, not runtime surprises.

**The Strand** carries, among others:

- `fact_state`: `LIVE` (believed) / `PROVISIONAL` (a visible superposition held until
  ratified) / `DEMOTED` (was believed, kept as history) — plus the observed/derived flag
  (`FactOrigin`) and the single `outranked_by` edge that explains any demotion.
- **Provenance root-set** (`ProvenanceRoot[]`): per-root source id, independence-class id,
  establishment timestamp, and `inheritedClass` (marks relay/resource-copied classes so
  the disown sweep never scars an honest upstream source's class — §8).
- **Traversal state**: per-walk activation register, `refractory_until`, edge
  `out_weight_sum`, convergence sketch (ordering only, never a stop gate).
- **Forgetting state**: `tier` (`HOT`/`WARM`/`COLD`/`ARCHIVE_STUB`), salience + decay,
  observation-age grace floor, `external_reobservation_count`, `description_value`
  (an order-0 Shannon-entropy estimate over the payload, computed at write time),
  `last_tier_reason` — a reason is stamped on every tier move.
- `content_hash` — the canonical-JSON fingerprint of the claim; the engine's "same claim"
  test for echo collapse, corroboration agreement, and the relay echo gate. Key order
  never changes the hash (`canonicalJson`); array order does (it is part of the value).

**Edges** are typed: `SHARED_ENTITY` is an *index relation* (derived at read time from the
store's entity index — never materialized as O(siblings) edges), `CONFIRMED_LINK` and
`CROSS_WEB_BRIDGE` are the librarian's, `DERIVATION` points derived→witness (the direction
the disown sweep walks), `OUTRANKS` explains demotions. Edge weight
`w = link_confidence × provenance_independence × recency`, where `provenance_independence`
is **read from the identity stamp, never self-computed** (invariant 2).

**The identity stamp** `{ source_id, anchor_set, anchor_cost, reputation, stake_posted }`
is the interface between the identity layer and the web (`stake_posted` is a frozen shape
field, constant 0 — staking is retired; attribution replaces stake).

---

## 4. Storage (`src/store/`)

`StrandStore` is the pluggable contract: `putStrand`/`getStrand`, typed edge queries
(`outEdges`/`inEdges`), the entity/attribute indexes, and **no delete operation** —
forgetting is downward tier movement, and the `ARCHIVE_STUB` (content hash + independent
roots + timestamps) is immortal.

Two backends:

- `createMemoryStore()` — the fast default and test substrate; atomic per call.
- `createSqliteStore(path | { db })` — durable SQLite in WAL mode via `node:sqlite`. The
  `{ db }` overload lets the store share **one** `DatabaseSync` handle with the reputation
  and ratification ledgers, so facts + trust + audit live in one crash-consistent file.
  `beginTxn()` is nestable (a depth guard means only the outermost frame issues
  `BEGIN`/`COMMIT`/`ROLLBACK`), and `integrityCheck()` runs `PRAGMA integrity_check`.

**Atomic compound writes.** Every multi-write engine operation — `writeFact`,
`writeFactsBatch`, `ratify`, `adjudicate`-RESOLVED, `approve`, and the whole disown sweep —
runs inside one transaction via the `withTxn` helper (a no-op passthrough on the in-memory
backend, exactly as the contract permits). A crash mid-operation rolls back completely: no
loser demoted without its `OUTRANKS` edge, no audit record without the state it describes,
no strand promoted without its reputation credit. Corruption detection is two-layered:
`integrityCheck()` is the structural half; the audit chain's `verifyChain()` (§9) is the
semantic half. Proven in `src/__tests__/atomicCompound.test.ts`, including WAL recovery
across an unclean reopen.

The deliberate operating point is `synchronous=NORMAL`: an OS-level power cut can lose the
last committed transaction but can never corrupt the file or leave a half-applied compound
operation.

---

## 5. Recall — the activation pipeline

One recall runs three stages, all fail-open (surface with a stamp rather than hide):

**Cue → seeds** (`src/recall/cueResolver.ts`). `CueResolver` is a deliberate seam: the
shipped `createLexicalCueResolver` is a zero-dependency token inverted-index baseline
(entity/attribute/payload tokens), and a deployment can swap in an embedding-based
resolver without touching the walk. A cue whose seeds all fail to resolve halts with an
explicit `NO_SEEDS_RESOLVED` stamp — never a silent empty answer.

**The walk** (`src/traversal/walk.ts`, `activationWalk`). Share-normalized best-first
spreading activation: pop the max-priority unexpanded strand;
`child = parent × (w_edge / Σw_out) × γ` (γ ≈ 0.6). Share-normalization is the structural
anti-spam defense — a high-degree junk hub splits its energy N ways and self-starves. A
per-traversal refractory lock kills A→B→A echo; each strand fires once at the maximum
energy any path delivers (best-first dominance), keeping activation monotone
non-increasing, which makes termination provable. Every stop decision is delegated to the
halting controller.

**Two-phase halting** (`src/traversal/halting.ts`). Phase 1 — local saturation: an EWMA of
*new independent corroboration* (novelty, never the convergence factor) thresholded
against ε → `CONVERGED`. Phase 2 — the **mandatory bridge sweep**: the local phase never
crosses `CROSS_WEB_BRIDGE` edges; the controller accumulates lit-but-uncrossed bridges and
funds **exactly one crossing per bridge** from a separate ~20% sub-budget (so
bridge-chasing can't starve the main answer), with a circuit-breaker after two zero-yield
crossings (`BRIDGE_STARVED`). A hard backstop (pop-cap + wall-clock) stamps `TRUNCATED`.
Convergence may *order* the frontier; it may never *stop* the walk — a genuine insight
bridge has convergence 1 and would be starved otherwise.

---

## 6. Forgetting (`src/forgetting/`)

**Decay sets pressure; gates set permission** (`tiers.ts`). Salience decays continuously;
tier movement is `HOT→WARM→COLD→ARCHIVE_STUB`, never deletion. Eviction below COLD is
permitted only if **all six gates affirmatively pass on present, fresh, trustworthy
evidence** — the exact inverse of halting's fail-open, because eviction is where a
poisoner would launder away the truth. `evaluateEviction` takes an `EvictionEvidence`
object the *caller* resolves; the independent-source count is read from
`identity.independentRootCount`, never self-computed (invariant 2). Highlights: a
corroborated strand (count ≥ 2) is unevictable; the outranked-side gate is an allowlist
(the winner must be `DEMOTED`/`COLD` to evict the loser); the unique-value gate counts
only observed, live, class-disjoint neighbors *with* provenance (no echo/ghost
laundering). New observed strands are pinned WARM for an unforgeable grace window;
same-root floods collapse to multiplicity 1.

**Consolidation** (`consolidation.ts`, `tryConsolidate` — pure, store-agnostic). A
contradiction set resolves by structure, never headcount:

- **Single independence class** (an echo dispute, the safe case): resolved by external
  stamp signal only, lexicographically `reputation → anchor_cost → stake_posted →
  deterministic id`. Losers are demoted with an `OUTRANKS` edge, never deleted.
- **Multiple independence classes** (a genuine independent dispute): auto-resolves **only**
  on a decisive, earned reputation margin — top-vs-second LCB gap ≥ 0.30 *and* winner ≥
  0.20 (above the bare-key ceiling) — else it **defers**, emitting a `PendingRatification`
  for the human horn (§9). A weightless flood fails the earned gate; two comparable
  independents fail the gap. For **high-impact** (irreversible) decisions the margin
  becomes necessary but not sufficient: the winner must also clear ≥2 independent
  corroborations, a 90-day recency-clean window, and ≥2 disjoint anchor classes — evidence
  the *engine* constructs from its own trust layer.

This is the structural defusal of the three attacks behind the hard theorem: fresh
same-class echoes fall to the deterministic tiebreak (no majority win); a high-reputation
incumbent outranks fresh challengers (no first-arrival trap in reverse); cross-class fresh
floods all read LCB ≈ 0, fail the earned gate, and defer to a human.

---

## 7. Source-Identity Layer (`src/identity/`) — crypto-free

Passport control at the border of the memory: before any source counts as a distinct
witness, it shows ID at the door. The layer **consumes** identity from configuration —
it never manufactures or proves it.

**Sameness** (`sources.ts`). `sourceIdFor(issuer, subject)` is a deterministic checksum
id: same id = same source. Cheap to mint, so necessary but never sufficient for
independence — sameness collapses echoes; anchors price independence.

**The trust registry** (`trustRegistry.ts`, `createTrustRegistry`). Four claim producers
mint priced anchors from configuration:

- `registerOwner` — the PERSONAL preset's ground truth; OWNER at external-authority grade
  (weight 0.90 / rep-cap 0.98).
- `registerSsoMember` — SSO_TENANT_MEMBER, deliberately email-grade (0.12/0.30) because a
  fresh tenant is near-free; a DOMAIN lift applies **only** when the registry
  configuration verifies the tenant's custom domain. A caller-supplied hint that is
  unconfigured, or contradicts configuration, grants nothing.
- `registerPublisher` — URLs collapse to eTLD+1 via the shipped Public Suffix List
  derivation (`binders/publicSuffix.ts`), so `a.example.com` and `b.example.com` are one
  source. PUBLISHER_UNVERIFIED is near-noise (0.04/0.10); PUBLISHER_TRACKED (0.18/0.35)
  only for configured publishers. An `operatorOf` axis fleet-caps N domains behind one
  operator into one independence class.
- `registerSystemOfRecord` — registry-configured authoritative systems (Workday-for-HR),
  0.90/0.98.

**Anchors and independence** (`anchors.ts`). Independence between two sources is
**disjointness of their anchor sets, weighted by anchor cost** — never declared, never
added linearly. `independenceBetween` runs each side's disjoint bindings through a
sublinear combiner and then `applySelfStackCap`: a source's combined strength is clamped
to its own strongest single anchor weight, so ten stacked emails (noisy-OR ≈ 0.65) cap at
email's 0.10 and can never impersonate one domain (0.35). `independentSources` **fails
closed** for unregistered or anchorless sides.

**Reputation** (`reputation.ts`, `createReputationLedger` / `createSqliteReputationLedger`).
Beta(α,β) per source: independence-weighted α (one ratify per class — headcount is denied
at the caller), 4× asymmetric β (lost fast), 90-day exponential **decay applied on each
read** (a dormant high-scorer reads stale-discounted immediately; the read is
side-effect-free), lower-confidence-bound readout (the prior reads exactly 0), ceilinged
by the anchor table's `rep_cap`, with exact `reverseCredit` for the undo engine. A fresh
source scores exactly 0; a bare key can never exceed ~0.05; one contradiction halves a
high-reputation source.

**The independent-root count** (`index.ts`, `independentRootCount`). The number the
forgetting and adjudication gates consume is the **exact maximum set of pairwise
independent roots** — a max-clique over the independence graph via Bron–Kerbosch with
Tomita pivoting (deterministic, bitmask adjacency) for root sets ≤ 18, falling back to the
bounded greedy maximal set above that (may undercount — the safe direction). Clamped to
the distinct-class bound, so a fake-independence flood sharing an anchor class still
counts 1.

**Residual assumption, stated plainly:** this does not make Sybil attacks impossible — it
converts an unbounded free attack into a priced, visible, self-limiting one. The anchors
bottom out in an external trust root (the owner, the IdP, DNS), exactly where TLS and CAs
bottom out. The design's achievement is shrinking all trust assumptions to that one
small, swappable root. The anchor table *is* the security policy knob.

---

## 8. Trust-tiered ingest — quarantine and the relay fix (`src/api.ts`)

**The quarantine gate.** `writeFact` re-stamps the filer through `identity.stampFor`
(engine-owned evidence — the caller-supplied stamp is inflatable and is never trusted for
gating) and takes the stamp's strongest single anchor weight. Below the
`quarantineThreshold` (default 0.10) the fact lands **`PROVISIONAL`** — stored, indexed,
traversable, and recallable (labeled, never hidden), but structurally unable to displace a
believed fact: `adjudicate` admits only `LIVE` members, so a `PROVISIONAL` flood produces
zero disputes. Quarantine exits only through the existing promotion paths: `ratify()` by a
source that is anchor-independent of **every** source on the strand's provenance (the same
predicate the approve-gate uses — one independence notion everywhere), or an `approve()`
resolution. An echo ratify (the author, or a fleet-correlated sibling) still records and
still drives reputation, but belief does not flip. `quarantineThreshold: 0` is the
explicit escape hatch restoring always-LIVE ingest.

**Causal-origin classes (the relay fix).** The write path prices *where a fact causally
came from*, not just who filed it, via the optional `WriteFactInput.causalOrigin`:

- omitted / `USER_STATEMENT` → the filer's own class (pre-fix behavior, bit-for-bit);
- `TOOL_CALL` / `DOCUMENT` → a deterministic per-resource class, so the same resource
  collapses to one class no matter which agent fetched it;
- `AGENT_RELAY` → the strand **copies the consulted strands' classes** (marked
  `inheritedClass`) and mints one `DERIVATION` edge per witness — so agent B re-filing
  what agent A said is an echo of A's class, not manufactured corroboration.

Two adversarial refinements are load-bearing: the **echo gate** (a class is copied only
for the *same claim* — same `content_hash` + attribute — so a contradicting payload citing
a rival cannot inherit the rival's class and collapse a genuine dispute into the echo
lane), and the **taint bound** (`inheritedClass` roots are excluded from the disown
sweep's tainted-class set, so disowning a relayer never scars the honest upstream source).

---

## 9. Ratification, audit, and the undo engine (`src/ratification/`)

**The audit ledger** (`pendingLedger.ts`) is an append-only, hash-chained **checksum
chain** — "a vault and a doorbell, never a judge." Each record
`{seq, prevHash, kind: PENDING|APPROVAL|MUTATION, payload, signerSourceId, thisHash}`
chains from a fixed genesis; `thisHash` is SHA-256 over an explicit hand-ordered preimage.
`verifyChain()` recomputes the whole chain and names the first broken seq — any at-rest
byte flip is caught. `chainHead()` exports an O(1) `{seq, headHash}` checkpoint for
access-segregated storage.

**The disclosed trade-off:** `signerSourceId` is *asserted* attribution. An actor with
live write access can rewrite history and re-verify green; what they cannot do is
reproduce a previously exported checkpoint, or un-ship a record already sent through the
**`AppendSink`** — an optional sink that receives every record *before* the local write
(ship-before-write: a throwing sink aborts the append fail-closed), so a local rewrite
diverges from the shipped copy at exactly the forged seq. Reference sinks (JSONL mirror,
crash-safe spool for SIEM-style destinations, divergence comparator) ship in
`src/examples/auditSinks.ts`. Choosing the segregated destination is a deployment step —
see Known Limitations in `CLAUDE.md`.

**The dispute doorbell.** A deferred adjudication is recorded as a PENDING record (a
deferral is never silently dropped); `listPending()` returns open disputes
reputation-ranked; `approve(csid, winner, approver, …)` enforces three fail-closed gates —
**distinct approver** (no self-approval), **provenance** (the approver must hold ≥1 priced
anchor: no provenance → no voice), and **anchor-disjointness** (the approver must be
independent of every disputed author) — then resolves: winner stays LIVE, losers demoted
with persisted `OUTRANKS` edges, reputation driven, all in one transaction with the
APPROVAL receipt.

**The undo engine** (`disown.ts`, `downstreamDisownSweep` — wired as `db.disown()`).
Disowning a fraudulent source runs one atomic sweep: crater the source's earned credit;
BFS the `DERIVATION` taint closure and **demote (never delete)** every strand that rests
on tainted witness — *sparing* derivatives whose independent corroboration survives
(false-disown-as-suppression protection); contradict backing sources only where their
provenance roots fall in the tainted class set (coincidental independent agreement is
never punished); reverse **exactly** the corroboration credit recorded at earning time
(`corroboration.ts` records each gain with its applied α-mass; the sweep reverses the
recorded deltas that intersect the demoted closure — the intersection *is* the guard);
re-open any resolved dispute the tainted strands merely tipped
(`adjudicationProvenance.ts` records the winning margin's contributors, so the sweep
recomputes the margin without them); and route consulted-but-not-cited influence to a
**human review queue** (`weakInfluence.ts` — a transitive backward closure; uncited
influence is unprovable, so it is never auto-demoted). `reconcile.ts` is the off-ledger
drift detector: reputation may only move with a matching recorded event. Uncited,
re-observed influence with no recorded funding link is the documented, priced residual.

**Enterprise routing** (`disputeRouting.ts`, `createDisputeRouter`): a pure, deterministic,
first-match-wins adapter mapping open disputes to owning-group labels (IdP groups), with
high-impact escalation. Transport is deliberately the deployment's job.

---

## 10. The engine surface (`src/api.ts`, `IntelligentDb`)

`createIntelligentDb(store, identity, reputation?, ratification?, ingest?)` wires the
layers over one (optionally shared) handle. The verbs:

| Verb | What it does |
|---|---|
| `writeFact` / `writeFactsBatch` | File observed facts: provenance-rooted strand mint, causal-origin class rules, quarantine gate, entity indexing, real `description_value` — one transaction (batch pays one durability barrier). |
| `recall` | Cue → seeds → activation walk → halting; returns lit strands + the halt stamp. The model speaks; it does not confirm. |
| `ratify` | External promotion: DERIVED→OBSERVED (the "wall with a window") or PROVISIONAL→LIVE; requires an external stamp; drives reputation + the corroboration record atomically. |
| `adjudicate` | Resolve or defer a contradiction (§6); `{ highImpact }` arms the irreversibility gate. |
| `listPending` / `approve` | The dispute doorbell (§9); `approve` accepts the receipted owner-override option (§11). |
| `disown` | The full retroactive undo sweep (§9); idempotent. |
| `explain` | **The belief dossier** (read-only): claim, state, backing sources with canonical stamps, the gates' *own* independence count (never a parallel computation), derivation citations both directions, demotion cause, dispute status, corroboration events, audit receipts — with explicit `coverage` flags where an unwired ledger limits evidence. |
| `beliefTimeline` | **Time-travel** for an (entity, attribute): every dated event's timestamp is copied verbatim from a named record/strand field (the fabrication ban is mechanical — nothing is inferred); undatable transitions land in `undatedEvents` rather than being guessed. |

Facts recalled while a pending dispute is open carry `contested: true` — label, never
hide; the walk itself observes nothing.

---

## 11. Deployment presets — one engine, one swappable trust table

**PERSONAL** (`src/agent/agentMemory.ts`, `createAgentMemory`). Zero configuration: the
owner is auto-provisioned as the trust root (OWNER anchor, external-authority grade).
`remember` / `recall` (string cue or structured), `pendingQuestions()` renders every open
dispute as a plain-data question answered by `resolvePending()` — and because the owner
*is* the personal tier's trust root, resolving a dispute over facts the owner authored is
ground truth, not self-dealing: the override bypasses only the distinct-approver and
independence-vs-authors gates, keeps every other gate unconditional, and stamps the
APPROVAL record `ownerOverride: true` — committed into the checksum, auditable forever.
`explain` / `beliefTimeline` are surfaced on the facade. Durable mode is one option:
`createAgentMemory({ dbPath, onLedgerAppend? })`.

**ENTERPRISE.** The same engine with identity consumed from the company's IdP/SSO and a
configured source-of-truth registry; disputes route to owning groups via
`createDisputeRouter`; the audit chain ships to the company's segregated sink.

**MCP** (`src/mcp/handler.ts` + `server.ts`, a zero-dependency stdio binary). Four tools:
`remember`, `recall`, `list_pending_questions`, `resolve_pending`. The boundary is
hardened: recall rendering labels non-LIVE states (`[DEMOTED]` / `[PROVISIONAL]`) and
contested facts (`[CONTESTED]`), untrusted payload text is control-character-escaped and
quote-delimited so a hostile fact cannot forge the line structure a relaying agent echoes
into the state-mutating `resolve_pending`, inputs are size-capped, and the stdio reader is
bounded.

---

## 12. Design philosophy

- Prefer **structural** defenses (a property an attack mathematically can't satisfy) over
  **policy** defenses (a threshold an attacker tunes around). Share-normalization beating
  hub spam is the template.
- The **fail-direction asymmetry** is deliberate and inverted between subsystems: recall
  fails **open** (surface low-corroboration strands with a stamp — hiding is the harm);
  eviction and every trust gate fail **closed** (missing/stale evidence keeps the strand,
  denies the approver, grants no independence — believing is the harm).
- When tempted to let the model decide something load-bearing, don't: route it to a gate,
  a provenance check, or an external signal. The model proposes; it never witnesses.
- Every keep/prune/promote rule is adversary-facing. The standing review question: what
  does a patient attacker who can pay to mint identities do to this?

**Verification.** The Vitest suite (see `CLAUDE.md` for the current count) spans
per-invariant adversarial tests, mid-operation crash-rollback and WAL-recovery cases, MCP
injection resistance, and one end-to-end integration test
(`src/__tests__/systemCoherence.test.ts`) that wires the whole pipeline over one shared
SQLite handle. The 97-spec red-team suite and the poisoning benchmarks are documented in
[`ARCHITECTURE_BENCHMARKS.md`](./ARCHITECTURE_BENCHMARKS.md); the review-findings log is
[`history/launch-2026-07/REVIEW_FINDINGS.md`](./history/launch-2026-07/REVIEW_FINDINGS.md); known limitations are
enumerated in [`../CLAUDE.md`](../CLAUDE.md).
