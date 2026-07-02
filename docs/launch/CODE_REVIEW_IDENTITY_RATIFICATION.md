# Code review: identity + ratification

**Status:** final pass, suggestions-only. No source files were edited — this document is
findings-only, produced against a read-only pass over the code.

**Scope read in full:**
`src/identity/{index,anchors,reputation,keys,stake,binding,anchorRegistry}.ts` and
`src/ratification/{disown,corroboration,weakInfluence,adjudicationProvenance,reconcile,pendingLedger,merkleLog,mutationReceipt}.ts`,
plus the call sites in `src/api.ts` and `src/agent/agentMemory.ts` needed to confirm
exploitability. Every line reference and code excerpt below was re-verified against the
current file contents before finalizing (re-read `identity/index.ts:360-396` and `:495-536`,
`identity/anchorRegistry.ts:195-229`, `api.ts:1415-1436`, `ratification/pendingLedger.ts:340-364`
and `:718-751`, `identity/index.ts:258-274` for `stampFor`).

**Cross-reference to the sibling review in this batch:** the parallel "Code review: traversal +
forgetting + store + api" pass independently found that `ratify()` is *not* wrapped in the
atomic-compound-write transaction that CLAUDE.md's "hardening tick 3" section claims covers
all belief-changing compound ops. That finding and Finding 1 below are complementary, not
overlapping: one is a missing-transaction *durability* gap in `ratify()`; this one is a
fail-open *logic* gap in `independentSources()` reached from `approve()` (which already runs
inside `withTxn`). Read together, they mean CLAUDE.md's hardening-tick-3 and
"adversarially verified" claims should be read as **strong, not complete** — both reviews found
a real gap the stated hardening didn't catch.

**Severity summary:** 1 High, 1 Medium (+ a test-coverage gap tied to the High), 2 Low.

---

## 1. HIGH — `SourceIdentityLayer.independentSources` fails OPEN for a never-registered source, silently defeating the RC-5 "no anchor → no independent voice" approve-gate

**File:** `src/identity/index.ts` — the standalone `independentSources` method (lines 513–534),
contrasted with the same module's `independentRootCount`'s internal `independent(a, b)`
predicate (lines 370–396) and `src/identity/anchorRegistry.ts`'s
`RealAnchorRegistry.independentSources` (lines 201–229, whose own comment says *"Fail-closed:
a BARE_KEY (no valid anchor) side is never independent"*).

**The bug.** The facade's public `independentSources(a, b)` — the exact predicate
`ratification/pendingLedger.ts`'s `approve()` distinct-approver gate (RC-5, "4b — MIS
ANCHOR-DISJOINTNESS GATE", lines 732–751) calls via `ctx.independentSources` (wired in
`src/api.ts:1431-1432`) — gates on:

```ts
if (keys.has(a) && keys.has(b)) { … consult anchors … }
return true;   // <-- fail OPEN whenever EITHER side was never identity.register()-ed
```

This is a *different* resolvability test than the one `independentRootCount`'s internal
`independent(a, b)` uses for the identical adjacency: that predicate gates on
`a.sourceId !== null && b.sourceId !== null` (i.e., whether the `ProvenanceRoot` recorded a
sourceId at all) and, when both are non-null, delegates straight to
`anchors.independentSources`, which itself fails closed for an anchorless source
(`aw.length === 0 ⇒ false` in `RealAnchorRegistry`). The standalone method's docstring claims it
is "the SOURCE-level twin of the `independent`-pair predicate ... so RC-5's approve-gate and the
forgetting count share ONE independence notion (anti-drift)" — but they are not the same test: a
source whose id is non-null but was **never passed through `identity.register()`** is judged
differently by the two call sites. `independentRootCount`'s path reaches the anchor registry
regardless (correctly fails closed there, since it only checks id-nullness, not passport
registration) while the standalone `independentSources()` short-circuits to `true` on the
`keys.has()` gate *before* ever asking the anchor registry — `keys` here is the passport
`KeyRegistryPort` (populated only by `identity.register()`), confirmed at
`identity/index.ts:248-256`.

**Why this is exploitable, not hypothetical.** Nothing requires a strand's provenance
`sourceId` to have been registered. `WriteFactInput.stamp: IdentityStamp` and
`agentMemory.ts`'s `SourceRef.stamp` / `SourceRef.sourceId` are documented, sanctioned escape
hatches ("an explicit identity stamp ... assembled by a caller managing identity"), and
`identity.stampFor(sourceId)` (lines 258–274) deliberately returns a well-formed bare stamp
(`anchor_cost = 0`, empty `anchor_set`) for *any* unregistered id with no registration check at
all — a source that has never registered still yields a well-formed BARE-KEY-equivalent stamp.
So a disputed member's author can easily reach `approve()` having never called `register()`.
When that happens, `ctx.independentSources(approverSourceId, author)` returns `true`
unconditionally (line 533), and the RC-5 gate at `pendingLedger.ts:743-751` — whose entire
purpose is to reject an approver who is anchor-correlated with a disputed author — is silently
bypassed for that author.

Note `approve()` also runs a separate `approverHasAnchors(approverSourceId)` check (line 738,
`stampFor(sourceId).anchor_cost > 0`) that fails closed for an anchorless *approver* — but that
gate only inspects the approver, never the author, so it does not cover this hole: the
vulnerable path is specifically an unregistered *author*. The gate then degrades to only the
earlier same-key self-approval check (`author === approverSourceId`, lines 722–730), which does
nothing against a distinct-key but correlated/colluding approver.

This also reproduces with the **default** facade shipped by `createAgentMemory()`:
`makeAnchorRegistry()` there (`src/agent/agentMemory.ts:226`) doesn't implement
`independentSources` at all, so the facade falls back to `independenceBetween(...) > 0` — but
only *after* the same `keys.has(a) && keys.has(b)` gate, so the same fail-open applies on the
primary public path, not just a custom `RealAnchorRegistry` wiring.

**Suggested improvement.** Make `independentSources()` mirror `independentRootCount`'s own
predicate exactly: drop the `keys.has()` gate and resolve independence straight from the anchor
registry (treat an unregistered/anchorless source the same way `RealAnchorRegistry.independentSources`
already does — fail closed, i.e. never independent), consistent with "no anchor → no
independent voice" applying to *both* parties in the RC-5 gate, not just the approver (which
already has its own dedicated `approverHasAnchors` check).

---

## 2. MEDIUM — SQLite-backed hardening ledgers advertise O(matches) but implement O(total records) per query

**Files:** `src/ratification/corroboration.ts`
(`SqliteCorroborationLedgerImpl.eventsIntersecting` / `eventsByCorroboratingStrand`),
`src/ratification/weakInfluence.ts` (`SqliteWeakInfluenceLedgerImpl.edgesConsulting`),
`src/ratification/adjudicationProvenance.ts`
(`SqliteAdjudicationProvenanceLedgerImpl.recordsContributedBy`).

Each interface's doc comment claims an "index ... so the disown sweep can find — in
O(matches) — every event/edge/record" (true for the in-memory `Map`-indexed implementation),
but every SQLite-backed implementation does `SELECT json FROM … ORDER BY seq` (a full table
scan) and `JSON.parse`s **every** historical row before filtering in JS, on every single call.
`downstreamDisownSweep` calls `eventsIntersecting`, `edgesConsulting`, and
`recordsContributedBy` once per sweep, so on a long-running durable deployment with a large
event history this degrades linearly with total lifetime ledger size rather than with the size
of the tainted set — a real scalability gap for what CLAUDE.md calls the "durable" backend, and
a documentation/implementation mismatch (the interface promises a complexity the concrete
durable class doesn't deliver).

**Suggested improvement.** Either maintain a persisted secondary index table (e.g.
`corroboration_strand_index(strand_id, event_id)`) queried with `WHERE strand_id IN (...)`, or
explicitly document the durable backend's complexity as O(n) and size its use accordingly
(disown is presumably rare, so this may be an acceptable, but currently silent, tradeoff).

---

## 3. LOW — `craterState` doesn't refresh `lastUpdate`, leaving a stale decay-clock anchor

**File:** `src/identity/reputation.ts`, `craterState()` (~line 602–627).

On disown, the crater resets `alpha = 1, beta = 1` but sets `lastUpdate: prior.lastUpdate` (the
source's *pre-crater* last-touch time) rather than `contradictionAt`/`now`. This is currently
numerically inert — every other field's decay collapses to a no-op when `alpha`/`beta` are
already exactly at the Beta(1,1) prior (`1 + (1-1)*factor === 1` for any `factor`) — but it's an
inconsistency versus every other mutation path (`applyRatification`, `applyContradiction`,
`applyCreditReversal`, `decay` itself) which all stamp `lastUpdate: now`. If the decay/M2/M3
model is ever extended to decay something keyed off `lastUpdate` besides `(α−1)`/`(β−1)`, this
becomes a live bug that silently reintroduces an arbitrarily large stale Δt on the very next
mutation after a disown.

**Suggested improvement.** Set `lastUpdate: contradictionAt` in `craterState` for consistency
with every sibling mutation, even though it's a no-op today.

---

## 4. Test-coverage gap tied to Finding 1

**Files:** `src/identity/index.ts`, `src/ratification/pendingLedger.test.ts`,
`src/__tests__/batch6BridgeAndApprove*.test.ts`.

Every existing test that exercises `independentSources` / the RC-5 approve-gate first calls
`identity.register(...)` for both the approver and every disputed author (verified across
`batch6BridgeAndApprove.test.ts`, `batch6BridgeAndApproveExtra.test.ts`,
`durableLedgers.test.ts`, `systemCoherence.test.ts`, `pendingLedger.test.ts`). None of them
cover the case where a disputed member's author was **never** registered (only "registered as
bare-key" and "registered with anchors" are covered) — precisely the blind spot behind
Finding 1. Given the module is described as "adversarially verified," this specific fail-open
path evidently escaped that review because no test ever constructs an unregistered author.

**Suggested improvement.** Add a regression test that writes a fact with a hand-built
`IdentityStamp`/raw `sourceId` that is never passed through `identity.register()`, puts it into
a multi-class dispute, and asserts `approve()` is REJECTED (once Finding 1 is fixed) rather than
silently succeeding.

---

## 5. LOW (ergonomics/design note, not a defect per se)

**Files:** `src/api.ts` (`WriteFactInput.stamp`), `src/agent/agentMemory.ts`
(`SourceRef.stamp` / `SourceRef.sourceId`).

The engine's public surface lets a caller mint an observed strand under any `sourceId` —
including ids that never went through `identity.register()` — with no warning or guard. This is
a deliberate simplicity feature (bare-key stamps "just work" per the design's "the web always
gets an answer rather than guessing"), but combined with Finding 1 it's a foot-gun: an
unregistered source silently participates in independence math with the *wrong* fail-direction
at exactly the point (RC-5 / dispute approval) where the design's "hard theorem" says external
identity witnessing is mandatory. Once Finding 1 is fixed this stops being dangerous
(unregistered ⇒ correctly non-independent everywhere), but it's worth calling out as the root
cause that makes Finding 1 reachable from ordinary API usage rather than a deep internal wiring
mistake.

---

## Noted but NOT flagged as findings (reviewed and judged sound)

- `identity/index.ts`'s Bron–Kerbosch `independentRootCount` (`MAX_EXACT_ROOTS = 18`,
  Tomita-pivoted, deterministic branch order, greedy fallback above the cap): correctly bounded,
  terminates, and the fallback is documented to undercount in the safe direction. The only soft
  spot is that the per-call `anchorCache`/adjacency matrix is rebuilt from scratch on every call
  with no cross-call memoization, which is a possible (but already benchmarked — see
  `src/__bench__/mis.bench.ts`) hot path if invoked densely over many overlapping root sets; not
  raising this as a separate finding since it's already acknowledged/instrumented in-repo.
- `identity/anchors.ts`'s self-stack cap (`applySelfStackCap`) neutralizes a plausible
  duplicate-attestation concern in `anchorRegistry.ts` (re-ingesting/renewing the same domain
  attestation before expiry, producing two `AnchorBinding`s for one real anchor) — the cap
  clamps to the strongest single realized weight regardless of duplicate count, so this isn't
  independently exploitable.
- `ratification/disown.ts`'s BFS taint closure, dedupe-by-content-hash, cycle-safety, fail-closed
  dangling-edge handling, and the four opt-in hardenings (weak-influence review queue,
  adjudication re-opening, false-disown survival check, exact corroboration-credit reversal) all
  read correctly against their own stated invariants; no fail-open holes found there.
- `ratification/merkleLog.ts`'s RFC 6962 math (leaf/node domain separation, inclusion/consistency
  proof verify, split-view detection) looks correct on inspection.
