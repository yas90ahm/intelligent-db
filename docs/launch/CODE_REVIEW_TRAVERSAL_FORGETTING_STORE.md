# Code review: traversal + forgetting + store + api

**Scope:** `src/traversal/halting.ts`, `src/traversal/walk.ts`, `src/forgetting/tiers.ts`, `src/forgetting/consolidation.ts`, `src/store/StrandStore.ts`, `src/store/memoryStore.ts`, `src/store/sqliteStore.ts`, `src/core/types.ts`, `src/api.ts`, `src/index.ts`.

No source files were modified as part of this review — findings only. All eight findings below were re-verified against the current working tree immediately before this final pass (line numbers and code snippets re-checked directly against the files); none had drifted.

**Note on overlap with the parallel "Code review: identity + ratification" workstream:** that review covers `src/identity/*.ts` and `src/ratification/*.ts` and found a distinct HIGH-severity bug — `SourceIdentityLayer.independentSources` fails OPEN for a never-registered source, undermining the RC-5 anchor-disjointness gate consulted inside `approve()` (wired at `src/api.ts:1431`, `independentSources: (a, b) => this.#identity.independentSources(a, b)`). That is a *correctness* bug in the independence predicate itself. Finding #1 below is an orthogonal *durability* bug in a neighboring belief-changing verb (`ratify()`, not `approve()`): `approve()` already runs inside `withTxn` (confirmed at `src/api.ts:1444`), so that workstream's finding is about what the gate decides, not whether the decision is committed atomically. Both findings concern the same `api.ts` "belief-changing verb" surface and are worth reading together, but they do not overlap or contradict each other.

---

## 1. `ratify()` is the one belief-changing verb not wrapped in the atomic-compound-write transaction — HIGH

**File:** `src/api.ts` (method `ratify`, lines ~964–1081)

CLAUDE.md's own hardening-tick-3 writeup enumerates exactly four compound ops wrapped in `withTxn`: `adjudicate` RESOLVED, `approve`, `downstreamDisownSweep`, and `writeFact`/`writeFactsBatch`. Grepping `src/api.ts` for `withTxn(this.#store, ...)` confirms exactly four call sites (lines 908, 927, 1161, 1444) — `writeFact`/`writeFactsBatch`, `adjudicate`, and `approve` respectively — and `ratify()` (964–1081) is not among them.

The code confirms the gap directly: `ratify()` performs `this.#store.putStrand(promoted)` (line ~1017), then — unconditionally, outside any `withTxn` — `this.#reputation.ratify(...)` (line 1051) and, when a corroboration ledger is wired and criteria are met, `this.#ratification.corroboration.record(...)` (line ~1064). None of these three writes is enclosed in `withTxn`, even though in the shared-handle deployment (store + reputation ledger + corroboration ledger + audit ledger riding one `DatabaseSync`, exactly the configuration CLAUDE.md recommends) each is its own autocommitted statement.

A crash between any two of these writes leaves a permanently half-applied ratify — e.g. the strand promoted to OBSERVED/LIVE with a new external provenance root but no matching reputation credit, or a reputation credit granted with no corroboration event recorded — precisely the "off-ledger (unreversible)" state that `assertRatifyEmitsEvent` (line ~1079) is designed to catch. That check is a runtime assertion that fires **after** the writes already committed, so even without a crash, if it throws, the strand promotion and reputation gain are already durably applied — the throw reports the corruption after the fact, it does not roll anything back. This directly undercuts the "exact `reverseCredit`" and "total-ledger reconciliation" guarantees the project stakes its durability story on.

**Suggested improvement:** Wrap the whole body of `ratify()` (strand promotion + `reputation.ratify` + the corroboration-record call + the `assertRatifyEmitsEvent` check) in the same `withTxn(this.#store, () => { ... })` helper already used by the other four ops, so a thrown assertion or a mid-op crash rolls back the strand promotion and the reputation gain together, not just the parts that happen to write later.

---

## 2. `LOW_UNIQUE_VALUE` eviction gate is a vacuous pass for every strand the engine actually creates — HIGH

**Files:** `src/forgetting/tiers.ts` (`lowUniqueValuePasses`, lines 585–637) and `src/api.ts` (`makeObservedStrand`, line 569)

`evaluateGates` ANDs six gates and documents `LOW_UNIQUE_VALUE` as fail-closed ("no qualifying neighbor ⇒ full unique value ⇒ FAIL"). But the predicate is `uniqueBits = max(0, strand.description_value - coverage) < cfg.uniqueValueFloorBits` (default `1.0`). Every strand ever minted through `writeFact`/`writeFactsBatch` is constructed via `makeObservedStrand`, which hardcodes `description_value: 0` (re-confirmed at `src/api.ts:569`) — and grepping the whole `src/` tree (outside tests/benchmarks) shows no code anywhere updates `description_value` after creation. With `dv = 0` always, `uniqueBits` is always `0`, which is unconditionally `< 1.0`, so this gate **always PASSES** regardless of neighbors, class overlap, or actual uniqueness.

In the currently-wired system this is not a fail-closed anti-poisoning gate at all — it is dead weight that never blocks an eviction. A genuinely unique, singly-witnessed strand that clears the other five gates (fresh stamp, not outranked, not an earned bridge, independent-count ≤ 1, past grace) will be evicted exactly as readily as a fully-redundant echo, because the "unique value" signal it's supposed to weigh was never computed.

**Suggested improvement:** Either (a) wire a real `description_value` computation (a reconstruction-loss/coverage estimate vs. independent neighbors, recomputed at write time or by an offline maintenance sweep, as CLAUDE.md's strand-field list describes), or (b) explicitly document in CLAUDE.md's gap list that `LOW_UNIQUE_VALUE` is currently a no-op pending that computation, so the "six ANDed fail-closed gates" claim isn't overstated relative to what's actually wired.

---

## 3. SQLite `beginTxn()`'s nesting-depth counter can go negative and silently disable future atomicity — MEDIUM

**File:** `src/store/sqliteStore.ts` (`beginTxn`, lines 481–505)

The nesting contract is: an inner `rollback()` "collapses the depth to 0 and emits exactly one `ROLLBACK`" (comment at lines 496–498), i.e. an inner rollback unilaterally aborts the entire outer unit of work. But the outer `StoreTxn` handle returned to the outer caller has its own independent `settled`/closure state and has no way to learn that an inner sibling already forced `#txnDepth` to 0 and issued a real `ROLLBACK`. If the outer caller's code path does not immediately propagate the inner failure (e.g. it catches locally and continues, or simply calls its own `commit()` afterward believing the unit of work is still open), the outer `commit()` runs `this.#txnDepth--` starting from `0`, leaving `#txnDepth === -1` permanently.

On every subsequent `beginTxn()` call, `outermost = this.#txnDepth === 0` is now false, so no `BEGIN` is ever issued again for the lifetime of the process — every later "atomic" compound operation silently degrades to a sequence of independent autocommitted writes with no error raised anywhere. Today's call graph happens not to trigger this (every module — `api.ts`'s `withTxn` at all four call sites, `disown.ts`'s `withSweepTxn` — opens exactly one level of `beginTxn` per operation and always rethrows on error before any sibling could call `commit()`), so this is currently latent. But it's a real soundness gap in a primitive the code explicitly designed to be "nestable" for composing future compound operations (`beginTxn`'s own doc: "a compound engine operation may open ONE txn around helpers that themselves manage writes").

Note: finding #1 above widens the set of future callers that could compose against this primitive (a fixed `ratify()` wrapped in `withTxn` would be exactly the kind of new nesting site this latent bug is waiting for), so closing #1 and #3 together is lower-risk than closing #1 alone.

**Suggested improvement:** Make an inner `rollback()` (depth > 0 at rollback time) throw or otherwise force every outstanding outer handle into a "poisoned" state (e.g. a shared mutable flag closed over by all handles from the same `beginTxn()` call chain), so a later `commit()`/`rollback()` call on an already-rolled-back outer handle is a detectable no-op rather than silently decrementing depth below zero.

---

## 4. Bridge-sweep wall-clock backstop is checked against a frozen timestamp — MEDIUM

**Files:** `src/traversal/walk.ts` (lines 560–588) and `src/traversal/halting.ts` (`backstopTripped`, `nextBridgeCrossing`)

`activationWalk` builds one `sweepCtx` (`now: asEpochMs(Date.now())`, or reused from `lastCtx`) before entering the `for (;;) { halting.nextBridgeCrossing(sweepCtx) }` loop, and never refreshes `sweepCtx.now` between crossings. `TwoPhaseHaltingController.nextBridgeCrossing` calls `this.backstopTripped(ctx.now)` on every iteration, so `config.wallClockMs` is checked against a value that never advances during the entire phase-2 sweep.

The bridge sub-budget (`bridgeBudgetFraction * popCap`, pop-consumption-based) still bounds the number of crossings, so this can't hang forever, but the documented hard backstop ("absolute pop-cap + wall-clock... on trip, stamp TRUNCATED") is effectively wall-clock-blind for the entire bridge-sweep phase — only the local phase's wall-clock check (which does read a fresh `Date.now()` per pop via `ctx.now` inside the main loop) is real.

**Suggested improvement:** Re-read `Date.now()` per bridge crossing (e.g. build a fresh `HaltContext` — or at least a fresh `now` — for each `nextBridgeCrossing`/`recordCrossingYield` pair) so the wall-clock backstop is live across both phases, not just phase 1.

---

## 5. Stale comment claims the bridge sweep "currently yields nothing" — LOW

**File:** `src/traversal/walk.ts` (lines 560–562)

The comment above the phase-2 drive loop reads: *"MANDATORY bridge sweep (phase 2). Enumeration is crack-B and currently yields nothing, so this clears immediately — but the drive loop is fully wired, so the sweep activates the moment crack-B lands with NO change here."* Per CLAUDE.md's status section, crack-B (the mandatory bridge sweep enumeration) has since landed in `traversal/halting.ts`'s `beginBridgeSweep`, which does real enumeration from `litBridgesFrom` and is exercised by a regression test (`smoke.test.ts`, "a cross-web bridge lights up the far side via the mandatory sweep"). This comment (still present verbatim, re-confirmed at lines 560–562) is now factually wrong and could mislead a future maintainer into thinking the sweep is still inert.

**Suggested improvement:** Update the comment to reflect that the sweep is live (crack-B implemented in `halting.ts`), removing the "currently yields nothing" claim.

---

## 6. A bridge crossing lights exactly one far-side strand, never continues local expansion beyond it — LOW/MEDIUM

**File:** `src/traversal/walk.ts` (phase-2 loop, lines 572–588)

When the controller yields a `BridgeCrossing`, the walk marks `crossing.target` fired and adds it to `litMap` with `seedActivation`, then immediately reports a yield back to the controller — it never pushes `target`'s own out-edges/siblings back onto the frontier for further local-phase expansion. So "something from last week is suddenly relevant" currently means exactly one specific far-side strand lights up per crossed bridge; any facts one hop beyond that bridge target on the far web (which may be the actually-relevant fact, with the bridge target itself being just an entry point) are never surfaced by a single `recall()`. This may be an intentional scope boundary (a bounded, single "exploratory" crossing per the sub-budget accounting), but if the intent is a bounded sub-walk into the far web rather than a single-node peek, this is worth confirming against the design intent.

**Suggested improvement:** If deeper far-side exploration is intended, seed a small local re-expansion from `target` (bounded by the remaining bridge sub-budget) instead of only marking it lit; if a single-node peek is the deliberate design, add a comment stating that explicitly so a future reader doesn't assume deeper propagation happens.

---

## 7. `src/index.ts` gives a first-time external adopter no signal about the intended entry point — MEDIUM

**File:** `src/index.ts` (whole file, ~470 lines / ~150 exports)

The barrel re-exports essentially every internal module verbatim and flat — `createIntelligentDb` sits at the same level of prominence as `createDnsDomainProofChecker`, `createSqlitePublicationSink`, `signAttestation`, `hashStrandState`, `applySelfStackCap`, and a dozen other clearly-internal/advanced wiring primitives. There is no tiered structure (no separate "quickstart" vs. "advanced/internal" export group, no `@public`/`@internal` markers), and neither `README.md` nor `index.ts`'s header comment gives a minimal usage snippet (e.g., which of `createIntelligentDb(store, identity)`, `createAgentMemory(...)`, or the raw ledger constructors is the recommended way to get started). A newcomer opening `index.ts` to learn "how do I use this library" has to read through the entire Source-Identity Layer's binder/anchor/Merkle internals before finding the three actual engine verbs.

This is a docs/DX gap, not a bug — flagged here for visibility alongside the parallel "Repo structure & GitHub launch hygiene" workstream, since a README quickstart section would be the natural place to close it rather than restructuring `index.ts` itself.

**Suggested improvement:** Add a short header block (or a `## Quickstart` section in README.md) showing the minimal path — e.g. `createMemoryStore()` / `createSqliteStore(path)` + `createIntelligentDb(store, identity)` (or `createAgentMemory(...)` if that's the intended ergonomic facade) — and/or group the barrel's exports under clearly-labeled sections distinguishing "core engine surface" from "advanced / pluggable internals," so a first-time reader isn't left to reverse-engineer the entry point from ~150 flat exports.

---

## 8. `MemoryStrandStore` leaks live, mutable `Strand` references while the SQLite backend hands out fresh clones — MEDIUM (mostly pre-existing/acknowledged tension, flagged for visibility)

**Files:** `src/store/memoryStore.ts` (`getStrand`, `collectStrands`, `allStrands`) vs. `src/store/sqliteStore.ts` (`parseStrand`)

`Edge` reads are frozen on both backends (`freezeEdge` in-memory, `Object.freeze` in `parseEdge` for SQLite), but `Strand` reads are asymmetric: `MemoryStrandStore.getStrand`/`strandsByEntity`/`strandsByAttribute`/`allStrands` all return the live object stored in `strandMap` with no clone and no `Object.freeze`, while `SqliteStrandStoreImpl.getStrand` etc. return a fresh `JSON.parse`'d clone each time.

`api.ts` already has to work around exactly this asymmetry in `approve()` (the "CRITICAL with a CLONE-ON-READ backend" comment/`handed` cache around lines 1397–1424), which shows the maintainers are aware of it for that one call site — but the asymmetry is store-wide, not scoped to `approve`. Any other caller (present or future) that reads a strand via `strandsByEntity`/`allStrands()` and mutates a field directly (e.g. `entity` or `attribute`) instead of round-tripping through `putStrand` will silently corrupt the in-memory store's entity/attribute indexes (stale membership), while the identical code against the SQLite backend would silently do nothing (the mutation is lost on the next real read) — i.e., the two "drop-in" backends are not actually interchangeable under direct-mutation usage, and the failure mode differs (corruption vs. silent no-op) rather than erroring in either case.

**Suggested improvement:** Either freeze `Strand` reads on the in-memory backend too (matching the `Edge` contract) so accidental direct mutation throws instead of silently corrupting indexes, or explicitly document on `StrandStore.getStrand`/`strandsByEntity`/`allStrands` that callers must never mutate a returned `Strand` in place and must always re-`putStrand` any change — the current doc comments describe this only obliquely (via the `demote()`/`approve()` call sites), not as a general contract rule.

---

## Revision notes (this pass)

- Re-verified all eight findings directly against the current working tree (fresh reads of `src/api.ts`, `src/forgetting/tiers.ts`, `src/traversal/walk.ts`, `src/store/sqliteStore.ts`) rather than trusting the prior draft's line numbers; nothing had drifted, and the four confirmed `withTxn` call sites (908, 927, 1161, 1444) tightened finding #1's evidence from "the writeup enumerates four ops" to a directly-grepped confirmation that `ratify()` is the fifth belief-changing verb and the only one omitted.
- Added an explicit cross-reference at the top to the parallel "Code review: identity + ratification" draft's HIGH finding (`independentSources` fail-open in the RC-5 approve-gate) to make clear the two reviews' HIGH findings on `api.ts`'s ratification surface are complementary, not overlapping or contradictory: theirs is a correctness bug in what `approve()`'s gate decides; #1 here is a durability bug in `ratify()`, a neighboring but separate verb that (unlike `approve()`) is not wrapped in `withTxn` at all.
- Added a forward-reference from finding #3 (the SQLite nested-transaction depth-underflow) to finding #1, noting that fixing #1 by adding a new `withTxn` call site is exactly the kind of future nesting scenario #3's latent bug would affect — so a maintainer fixing #1 should be aware of #3 rather than treating them as unrelated.
- Softened finding #7 from a pure code-organization complaint into an explicit pointer at the parallel "Repo structure & GitHub launch hygiene" and README-quickstart work, since a README addition is the more natural fix than restructuring the barrel file itself, and other workstreams are already touching docs/repo-hygiene in this same pass.
- No changes to severity ratings, technical claims, or suggested fixes in this pass — all were re-confirmed accurate; only cross-references and one clarifying sentence in #1 were added.
