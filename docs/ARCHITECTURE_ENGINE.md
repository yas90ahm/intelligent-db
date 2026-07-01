# Intelligent DB — Engine Architecture

> A memory substrate for AI agents that resists the two failure modes of stateless
> models: **forgetting** (context loss) and **hallucination** (inventing facts and
> being unable to tell recall from invention). This document describes the ENGINE —
> the memory substrate itself — grounded in the actual source under `src/`. Every
> claim below cites a file and (where load-bearing) line numbers. It does NOT cover
> the benchmarks.

---

## 1. Mental model

Intelligent DB is **not** a vector database; it is a deliberate inversion of one. A
vector DB does fuzzy nearest-neighbour lookup over an unstructured blob, which is
exactly why it cannot resist hallucination. This design models memory as a **memory
palace / spider-web** (`src/core/types.ts:9-15`):

- **Latent memory, activated by traversal, not query.** Nothing sits in a readable
  list. A cue energises a seed strand; activation spreads across structural threads
  until a cluster "lights up"; only lit strands are assembled into an answer
  (`src/traversal/walk.ts:1-46`). The store even forbids answering by content scan —
  `allStrands()`/`allEdges()` are documented "OFFLINE maintenance only"
  (`src/store/StrandStore.ts:243-259`).
- **Web of webs.** Dense local webs (one conversation / tight cluster) are loosely
  bridged to distant webs by rare `CROSS_WEB_BRIDGE` threads. Activation jumping a
  bridge is what makes "something from last week is suddenly relevant"
  (`src/core/types.ts:119-135`, `EdgeType.CROSS_WEB_BRIDGE`).
- **Threads connect only on shared entity (mechanical) + confirmed link
  (relationship).** `writeFact` attaches purely by the mechanical `SHARED_ENTITY`
  rule, represented as an INDEX (`strandsByEntity`), not a materialised clique
  (`src/api.ts:884-913`); the AI "librarian" that decides confirmed relationships is
  out of scope of the engine.
- **Provenance is first-class** on every strand. Confirmation = corroboration by
  **independent** provenance; two strands agreeing from the *same* root are an echo,
  not corroboration (`src/core/types.ts:192-206`).
- **Observed vs Derived — "wall with a window."** A DERIVED fact may be believed and
  spoken (with derivation shown) but is **never its own witness**; it graduates to
  OBSERVED only when an external source ratifies it (`src/core/types.ts:137-147`).

### The two governing invariants

1. **The model is never its own witness.** It files and speaks memories; it never
   confirms them. "No provenance → no voice." Mapped onto the verbs in
   `src/api.ts:16-28`: `writeFact` files, `recall` speaks, `ratify` (external stamp
   mandatory) is the only verb that raises belief.
2. **The web is never its own witness about source identity.** Trust in *what* a
   fact is comes from inside the web; trust in *who* sourced it must come from
   OUTSIDE — the Source-Identity Layer (`src/identity/index.ts:16-33`). The two
   quantities the web may not self-compute — per-edge `provenance_independence` and
   the independent-root count — are READ FROM the identity stamp
   (`src/core/types.ts:16-19`, `226-245`).

### The hard theorem (why the external layer is mandatory)

Claim adjudication cannot be solved from inside the graph
(`src/forgetting/consolidation.ts:16-35`). Under "identity is priced, not
prevented" (a patient attacker pays a finite cost to mint independent-looking
sources), there is **no purely internal rule** that both (a) lets one true witness
overturn a planted false canonical AND (b) stops two fake sources overturning a true
incumbent. The three fatal internal attacks are the contradiction-set bomb, the
first-arrival trap, and the absence of a second independent lock. The engine's
response is structural: independence is a property of identity, and identity is
witnessed from outside (the four anchor pillars), never decided by in-graph
headcount.

---

## 2. Layering & module map

```
                         ┌─────────────────────────────────────────────┐
   MCP / agents  ───────▶│  agent/agentMemory.ts   (ergonomic facade)   │
                         │  mcp/handler.ts         (JSON-RPC surface)    │
                         └───────────────┬─────────────────────────────┘
                                         │  remember / recall / ratify / adjudicate / disown
                         ┌───────────────▼─────────────────────────────┐
                         │  api.ts  IntelligentDb  (3 verbs + 5 admin)  │
                         │  writeFact · recall · ratify · adjudicate ·  │
                         │  disown · approve · listPending · anchorEpoch│
                         └──┬───────┬──────────┬──────────┬─────────────┘
              ┌─────────────┘       │          │          └──────────────┐
   ┌──────────▼─────┐   ┌───────────▼──┐  ┌────▼──────────────┐  ┌────────▼─────────┐
   │ traversal/     │   │ forgetting/  │  │ identity/          │  │ ratification/    │
   │  walk.ts       │   │  tiers.ts    │  │  index.ts (facade) │  │  pendingLedger   │
   │  halting.ts    │   │  consolidat. │  │  keys/anchors/     │  │  disown/corrob.  │
   │ recall/cue…    │   │              │  │  reputation/stake  │  │  merkleLog/…     │
   └──────────┬─────┘   └───────┬──────┘  └────────┬───────────┘  └────────┬─────────┘
              └─────────────────┴──────────┬───────┴───────────────────────┘
                              ┌────────────▼───────────────┐
                              │ store/StrandStore contract  │
                              │  memoryStore | sqliteStore   │
                              └─────────────────────────────┘
                              ┌─────────────────────────────┐
                              │ core/types.ts  (the contract)│
                              └─────────────────────────────┘
```

`src/index.ts` is the public barrel: it re-exports the stable surface of every layer
(core, store, traversal, forgetting, identity, ratification, api, recall, agent,
mcp), using `export type` for type-only re-exports (verbatimModuleSyntax) and
aliasing the forgetting `NeighborView` to `ForgettingNeighborView` so it never
collides with the store's (`src/index.ts:14-19`, `148-154`).

**Compilation contract:** TypeScript on Node 24, ESM + NodeNext (relative imports
carry `.js`), strict + `verbatimModuleSyntax` + `exactOptionalPropertyTypes`. Zero
external runtime deps — SQLite is Node's built-in `node:sqlite`, loaded via a runtime
`require` so bundlers don't strip the `node:` prefix (`src/identity/reputation.ts:906-909`).

---

## 3. Data model (`src/core/types.ts`)

The single source of truth; no runtime deps, type-checks standalone.

### Branded identifiers (`:29-69`)

Opaque `Brand<string, "…">` types (`StrandId`, `EdgeId`, `EntityId`, `AttributeKey`,
`ProvenanceRootId`, `IndependenceClassId`, `OperatorClassId`, `SourceId`,
`ContradictionSetId`, `ContentHash`, `EpochMs`) — plain strings at runtime, but
one-way assignable through `as` constructors so id namespaces can never cross-wire.
Two independence axes are distinguished:
- `IndependenceClassId` (`:43-49`) — offline-assigned; two roots in one class are
  NOT independent (ancestor sketches / convergence run over these, never raw ids).
- `OperatorClassId` (`:50-59`) — the FLEET axis (registrar / ASN / KYC issuer / email
  provider); N anchors behind one operator collapse toward ONE class, not N.

### Enums (`:91-186`)

| Enum | Values | Role |
|---|---|---|
| `FactState` | LIVE, PROVISIONAL, DEMOTED, COLD | Lifecycle; contradiction demotes, never deletes. |
| `Tier` | HOT, WARM, COLD, ARCHIVE | Storage/decay tier; forgetting only moves downward; ARCHIVE is the immortal stub. |
| `EdgeType` | SHARED_ENTITY, CONFIRMED_LINK, OUTRANKS, DERIVATION, CROSS_WEB_BRIDGE | Structural edge class. |
| `FactOrigin` | OBSERVED, DERIVED | "Wall with a window": DERIVED never its own witness. |
| `AnchorClass` | BARE_KEY … EXTERNAL_AUTHORITY (9) | Ascending real-world cost anchor classes. |
| `ReasonCode` | CONVERGED, NOVELTY_EXHAUSTED, BRIDGE_SWEEP_CLEAR, BRIDGE_STARVED, TRUNCATED | Stamped on every stop/tier-move — never a silent stop. |

### The Strand (`:353-411`)

One latent memory node. Carries the council-converged fields: `entity` +
`attribute` (the shared-entity/claim keys), opaque `payload`, `content_hash`
(immortal-stub address), `origin` (OBSERVED/DERIVED), mutable `fact_state` + `tier`,
a readonly `provenance: ProvenanceRoot[]`, `outEdges`/`inEdges` id lists,
`outranked_by` (the single OUTRANKS edge explaining a demotion), `bridge`
accounting, `salience`, `description_value` (consolidation-eligibility gate only),
`observedAt` (grace floor), `external_reobservation_count`, `contradiction_set` +
`co_equal_claim_cardinality`, `last_tier_reason`, and a per-traversal `register`
(nulled between walks).

### ProvenanceRoot (`:192-206`) & IdentityStamp (`:212-245`)

Each root carries `rootId`, its offline `independenceClass`, the witnessing
`sourceId | null`, and `establishedAt`. The `IdentityStamp` the identity layer emits
mirrors the design doc exactly: `{ source_id, anchor_set, anchor_cost, reputation,
stake_posted }`. This is the ONLY channel through which the web learns
`provenance_independence` and the independent-root count.

### Edge (`:260-286`)

Directed thread with the halting weight `w = link_confidence ·
provenance_independence · recency` and the cached `out_weight_sum` = Σw over the
source strand's out-edges. `computeEdgeWeight` (`:280-286`) is the pure factoriser;
share-normalisation uses `w / out_weight_sum`. `provenance_independence` is READ FROM
the stamp, never self-computed.

### Undo-engine records (`:421-488`)

`WeakInfluenceEdge` (consulted-but-not-cited reads), `ReviewQueueEntry`
(human-review flag from a disown), and `AdjudicationProvenance` (the margin + the
contributing strands that cleared a resolution — so a later disown can recompute and
re-open).

### Walk config (`:513-537`)

`DEFAULT_WALK_CONFIG = { gamma: 0.6, epsilon: 0.02, popCap: 2000, wallClockMs: 2000,
bridgeBudgetFraction: 0.2, bridgeZeroYieldBreaker: 2 }`.

---

## 4. Storage layer (`src/store/`)

### The contract (`StrandStore.ts`)

A pure interface, no impl. It owns identity-keyed strand/edge storage, the adjacency
indexes (`outEdges`/`inEdges`/`neighbors`) that make a walk step O(degree), the seed
indexes (`strandsByEntity`, `strandsByAttribute`), the cached `out_weight_sum`
denominator (`recomputeOutWeightSum`), and offline scans (`allStrands`/`allEdges`).
Deliberately **no delete** — forgetting is a `putStrand` with a lowered `tier`
(`:133-139`). All methods are synchronous (the activation inner loop is hot;
`:36-41`).

`NeighborView` (`:67-72`) bundles an out-edge with its resolved destination strand so
the walk gets both halves in one pass. `putStrandsBatch` (`:163-172`) is the bulk
ingest primitive. An optional `StoreTxn` (`:109-114`) is the unit-of-work handle;
optional `beginTxn()` (NESTABLE — `:279-290`) and `integrityCheck()` (`:292-298`) are
present on the durable backend only.

### Backends

- **`memoryStore.ts`** — in-memory graph + adjacency/entity/attribute indexes. Its
  `withTxn` is a genuine no-op (already atomic-per-call), which is exactly what the
  contract permits.
- **`sqliteStore.ts`** — durable `node:sqlite` WAL store with a `{ db }` shared-handle
  overload so facts + trust + audit ride ONE crash-consistent file; `beginTxn()` is
  nestable via a `#txnDepth` guard (only the outermost issues BEGIN/COMMIT/ROLLBACK);
  `close()` is a no-op for a borrowed handle; `integrityCheck()` runs
  `PRAGMA integrity_check`. `synchronous=NORMAL` is the deliberate operating point.

---

## 5. Traversal — the activation walk (`src/traversal/walk.ts`)

The engine room of "activated by traversal, not query."

### `MaxPriorityQueue<T>` (`:96-211`)

A pure binary max-heap, ORDERING ONLY — no knowledge of halting or decay. O(log n)
push/pop.

### The share-normalized best-first walk (`activationWalk`, `:380-595`)

**Seed** → **expand loop** → **mandatory bridge sweep** → **halt stamp**.

Core recurrence (`:507-509`):
```
child = parent · (edge.w / Σ_eff) · γ           γ = config.gamma ≈ 0.6
```

Load-bearing mechanics:

1. **Share-normalisation starves hubs.** Each of a node's out-edges gets a `w/Σ`
   share, so a high-degree junk hub fans out to nothing. `Σ_eff` folds in a
   **virtual `SHARED_ENTITY` fan** (`:463-493`): `writeFact` mints NO clique edges;
   siblings are DERIVED at read time from `strandsByEntity`. `Σ_eff = Σw(materialised
   out-edges) + K·w_se` with uniform `w_se = 1` and `K = |strandsByEntity| − 1`, so a
   hot entity self-starves EXACTLY as the old O(N²) clique did (`SIBLING_EDGE_WEIGHT`
   `:311`; the uniformity, not the magnitude, proves the self-starve property). The
   virtual PUSH is capped at `VIRTUAL_SIBLING_FANOUT_CAP = 32` (`:324`) so per-pop work
   is O(cap) while the DENOMINATOR still uses full K (spam-resistance intact); the
   entity sibling set is cached per walk (`:417-426`).
2. **Refractory lock via best-first dominance** (`:390-397`, `443`). A `fired` set
   plus best-first ordering means the FIRST candidate popped for a strand carries the
   max energy any path can deliver (energy is monotone non-increasing), so a strand
   fires ONCE at its dominating energy — killing the A→B→A echo and bounding the walk.
3. **Ordering is not stopping** (`:288-291`, `frontierComparator`). Primary key is
   `energy`; ties break on `orderingKey` derived from `convergence_factor`
   (independent-ancestor count). Convergence appears ONLY as a pop-order tiebreak and
   is structurally incapable of gating the stop — a genuine insight bridge has
   convergence 1 and must not be starved.
4. **Bridges skipped in the local phase** (`:499-506`). `CROSS_WEB_BRIDGE` edges are
   never crossed by normal activation; each lit, uncrossed bridge is owed exactly one
   crossing by phase 2.
5. **Termination** (`:365-367`): every share ∈ [0,1], γ < 1 ⇒ energy monotone
   non-increasing; the refractory lock forbids re-firing (each strand expands ≤ once);
   the pop-cap backstop guarantees termination on pathological graphs.

`noveltyOf` (`:659-669`) is the phase-1 signal fed to the controller: a strand adding
≥1 previously-unseen independence CLASS is novel (1), else an echo (0) — reading
provenance classes, NEVER `convergence_factor`.

### Data flow of one recall

```
cue ──▶ WalkSeed[] ──▶ activationWalk(store, seeds, config, halting)
                            │
      ┌── pop max-energy ◀──┤   frontier = MaxPriorityQueue<FrontierCandidate>
      │        │
      │        ├─ refractory? skip
      │        ├─ fire: litMap.set(id, energy)
      │        ├─ halting.onPop(ctx);  if shouldStopLocal → break   (phase 1)
      │        └─ spread child = parent·(w/Σ_eff)·γ  to materialised + virtual siblings
      └────────┘
   ── beginBridgeSweep → while nextBridgeCrossing ≠ null: cross, recordCrossingYield  (phase 2)
   ── finalStamp() ──▶ { lit: LitStrand[], halt: HaltStamp }        (never silent)
```

---

## 6. Two-phase halting (`src/traversal/halting.ts`)

The SOLE authority on "when to stop walking and start speaking." A stateful
single-use `TwoPhaseHaltingController` (`:240-503`) driven by the walk.

- **Phase 1 — local saturation** (`onPop` `:296-313`, `shouldStopLocal` `:329-356`).
  `onPop` maintains an EWMA of `newIndependentCorroboration` (`trailingNovelty`,
  α = 0.3). When it falls below `config.epsilon`, the local walk stops → CONVERGED.
  Reads novelty ONLY; convergence never enters.
- **Hard backstop** (`backstopTripped` `:320-326`). `popCount ≥ popCap` or wall-clock
  exceeded → TRUNCATED. Wins over everything, fails open.
- **Phase 2 — mandatory bridge sweep** (`beginBridgeSweep` `:359-400`,
  `nextBridgeCrossing` `:403-467`, `recordCrossingYield` `:470-483`). Reserves a
  SEPARATE ~20% sub-budget (`round(popCap · bridgeBudgetFraction)`), enumerates every
  lit uncrossed `CROSS_WEB_BRIDGE` across ALL lit strands (`litStrands`), and sorts
  them by the owning strand's offline `earned_bridge_value` DESC (signal before decoys;
  a fresh attacker bridge has earned-value 0 and sorts last — `:388-398`). Each owed
  bridge gets EXACTLY ONE crossing seeded at `γ·factor`, where `factor` is the bridge's
  `provenance_independence` if 0 < indep < 1 else 1 (bare-key stays at γ by design —
  fail-open, since a poison bare-key bridge is indistinguishable from an honest insight
  bridge; `:452-466`). A circuit-breaker trips after
  `bridgeZeroYieldBreaker` (2) consecutive zero-yield crossings.
- **`finalStamp`** (`:486-502`) resolves the outcome to a `ReasonCode`, reports
  `popCount`, `bridgesCrossed`, `bridgeSeedsDownweighted`, and `degraded` (TRUNCATED
  or BRIDGE_STARVED). Never a silent stop.

The walk adapts the store to the narrow `HaltStoreView` (`walk.ts:676-717`):
independent-class counts, lit-bridge enumeration, bridge target, `bridgeIndependence`
(O(1) edge scalar, no MIS round-trip), and `bridgeEarnedValue`.

---

## 7. Forgetting (`src/forgetting/`)

### Tiers & the decay/gate split (`tiers.ts`)

The load-bearing idea is a SPLIT (`:1-41`): **decay sets PRESSURE** (cheap,
self-computable), **gates set PERMISSION** (several read quantities the web cannot
self-witness, sourced from the identity stamp).

- `nextTierDown` (`:268-284`): HOT→WARM→COLD→ARCHIVE; ARCHIVE is the fixed point
  (movement, never deletion).
- `decayPressure` (`:319-363`): pressure in [0,1] rising with idle staleness
  (exponential half-life), damped by keep-signals the web may read about itself
  (`fire_count`, `external_reobservation_count`, salience). Grace-pinned OBSERVED
  strands contribute ZERO pressure (`:324-330`).
- `evaluateEviction` (`:406-459`): two regimes. Regime 1 — a pressure-driven step
  within HOT/WARM (no gates). Regime 2 — BELOW-COLD (COLD→ARCHIVE) requires ALL gates
  to pass AND pressure present.

**The six eviction gates** (`EvictionGate` `:148-197`, `evaluateGates` `:492-559`) are
the **anti-poisoning floor** — every gate FAILS CLOSED (any missing/null/stale/
uncertain evidence keeps the strand, the inverse of halting's fail-open):

| Gate | Passes when |
|---|---|
| `LOW_UNIQUE_VALUE` | Echo-discounted unique reconstruction value vs INDEPENDENT (OBSERVED+LIVE+class-disjoint+has-provenance) neighbours < floor; same-class neighbours collapse to multiplicity 1 (`:585-637`). |
| `FRESH_INDEPENDENCE_STAMP` | Stamp non-null AND freshest provenance root within `stampFreshnessMs` (`:646-664`). |
| `NOT_OUTRANKED_SIDE` | Not outranked, OR winner affirmatively settled (DEMOTED/COLD) — an ALLOWLIST; LIVE/PROVISIONAL/null all FAIL (`:530-537`). |
| `NOT_EARNED_BRIDGE` | `bridge.earned_bridge_value == 0`. |
| `INDEP_SOURCE_COUNT_LE_1` | Identity-layer count is finite AND ≤ 1; null or ≥ 2 FAIL (`:547-550`). |
| `PAST_GRACE_FLOOR` | `observedAt + graceWindowMs < now` (`:679-686`). |

Crucially, `EvictionEvidence` (`:108-131`) is **caller-resolved**: `independentSourceCount`
is READ FROM `SourceIdentityLayer.independentRootCount`, `outrankerState` is resolved
by following `outranked_by`. Forgetting never self-computes these; withholding or
staling evidence can only ever KEEP a strand.

### Consolidation — echo collapse + adjudication (`consolidation.ts`)

Two structurally different jobs that must never be conflated:

1. **Same-root echo collapse** (SIMPLE, `collapseSameRootEchoes` `:177-214`). Folds
   strands making the same claim from a SINGLE shared independence class to
   multiplicity 1 (`echoGroupKeyFor` `:130-136`; a mixed-class strand is never an echo
   candidate, `:111-123`). Preferred survivor = most re-observations, then earliest
   observation, then id (`:145-154`). Pure — no truth judgement.
2. **Contradiction adjudication** (HARD CORE, `tryConsolidate` `:854-1034`) — the
   theorem boundary. Structure:

```
tryConsolidate(set, members, stampsByRoot, now, mintEdgeId?, policy?, highImpact?,
               agreementRootCountOf?, attrCorroborationCountOf?)
   │
   ├─ < 2 distinct claims                        → NOOP
   ├─ rank members by external signal only  (byStrengthDesc: reputation → anchor_cost
   │                                          → stake_posted → id;  NEVER headcount)
   │
   ├─ classes.size > 1  (GENUINELY INDEPENDENT dispute):
   │     ├─ F4a  agreementRootCountOf(top) < multiClassMinRoots (2)   → DEFER  [structural,
   │     │                                                              unconditional 2nd lock]
   │     ├─ F4b  attrCorroborationCountOf(top) < minAttrCorroboration → DEFER  [in-domain re-price]
   │     ├─ M4   dWin < dRun + depthMargin  (depth = #R, real callback)→ DEFER  [depth margin]
   │     ├─ decisive?  top−second ≥ decisiveMargin(0.30) AND top ≥ minWinnerReputation(0.20)
   │     │     ├─ highImpact set AND !clearsHighImpactGate            → DEFER
   │     │     └─ else                                                → RESOLVE (demote losers)
   │     └─ else                                                      → DEFER (human horn)
   │
   └─ classes.size == 1  (same-root echo artifact, SAFE):
         ├─ highImpact set AND !clearsHighImpactGate                  → DEFER
         └─ resolve by external signal only, demote differing claims  → RESOLVE
```

Key properties, all encoded:
- **Never headcount.** `MemberStrength` (`:398-406`) distils only reputation /
  anchor_cost / stake from stamps; a member with no resolvable stamp degrades to the
  ZERO stamp (`:417-432`), so a 500-member fresh flood is exactly as weightless as one
  fresh source and falls to the deterministic id tiebreak (`byStrengthDesc`
  `:445-455`).
- **Decisive-or-defer** thresholds (`AdjudicationPolicy` `:550-633`,
  `DEFAULT_ADJUDICATION_POLICY` `:696-716`): `decisiveMargin = 0.30`,
  `minWinnerReputation = 0.20` (above bare-key rep_cap ~0.05), plus the high-impact
  fields (`minCorroborationCount = 2`, `recencyCleanWindowMs = 90d`,
  `minWinnerAnchorClasses = 2`) and the structural F4a/F4b/M4 fields
  (`multiClassMinRoots = 2`, `minAttrCorroboration = 1`, `depthMargin = 1`).
- **F4a — the structural second lock** (`:941-943`). Multi-class ONLY (extending it to
  the single-class echo path would re-open the contradiction-bomb as a DEFER-DoS,
  documented `:915-940`). A self-stacked / lone winner is #R = 1 and DEFERS on EVERY
  multi-class resolve, high-impact or not.
- **M4 depth-margin** (`:956-982`) fires only when a REAL `#R` callback is supplied
  (detected by identity against the `DEFAULT_AGREEMENT_ROOT_COUNT_OF` sentinel
  `:694`), so it never spuriously defers the pure unit tests; the runner-up is the
  strongest member asserting a DIFFERENT value.
- **High-impact gate** (`clearsHighImpactGate` `:741-758`): for an irreversible
  decision a decisive LCB margin is NECESSARY-BUT-NOT-SUFFICIENT — the winner must also
  clear ≥2 corroborations, a 90-day recency-clean window, and ≥2 independent roots.
- **Demotion never deletes** (`demote` `:331-353`): sets `fact_state = DEMOTED`,
  points `outranked_by` at a single validated OUTRANKS edge; a mis-wired edge throws.

`ConsolidationOutcome` (`:514-517`) is `RESOLVED {demotions} | DEFERRED {pending} |
NOOP`. The module is PURE (store-agnostic): the caller resolves members + stamps and
persists the outcome.

---

## 8. Source-Identity Layer (`src/identity/`)

"Passport control at the border of the memory" — the external trust root that
supplies what the web may not self-witness. The facade (`index.ts`) composes four
injected PORTS: keys, anchors, reputation, stake (`:148-162`).

### Pillar 1 — Passport (`keys.ts`)

Ed25519 keypair per source (`generatePassport`), `sign`/`verify`, and a deterministic
`sourceIdFromPublicKey` = `sha256(DER(SPKI))` base64url so the SAME key always maps to
the SAME `SourceId` (`:1-49`). Proves SAMENESS (echo collapse) — cheap to mint,
necessary but not sufficient for independence.

### Pillar 2 — Anchors (`anchors.ts`)

The **anchor-cost table** as data (`ANCHOR_TABLE` `:105-153`): BARE_KEY (weight 0.00,
cap 0.05) up through EXTERNAL_AUTHORITY (0.90, 0.98), with FINANCIAL_STAKE weight
scaling 0.30–0.85 with deposit (`stakeIndependenceWeight` `:181-188`).

- `repCapFor` (`:209-221`): a source's ceiling = the BEST cap among its anchors
  (empty ⇒ bare-key 0.05).
- `aggregateAnchorCost` (`:235-241`): SUBLINEAR — the source's strongest single
  realised cost, never a sum (anti self-stack).
- `independenceBetween` (`:284-313`): independence = cost-weighted **set-disjointness**.
  Shared anchor classes are excluded (echo on that axis); each side's disjoint
  anchors combine via noisy-OR `combineSublinear` (`:337-344`, `1 − Π(1−wᵢ)`) then
  through `applySelfStackCap` (`:394-406`, clamp to the side's strongest single realised
  weight); the pair score is the MIN of the two sides. Effect: a 10× EMAIL stack
  (noisy-OR ≈ 0.651) caps to 0.10, never reaching DOMAIN's 0.35.

### Pillar 3 — Reputation, Beta(α,β) (`reputation.ts`)

A calibrated Beta model — the counter to the contradiction-bomb and first-arrival
trap.

- **Accrual** (`:1-52`): corroboration adds `α += w` where `w` is the caller-supplied
  independence weight (headcount denied at the caller — one `ratify` per class);
  contradiction adds `β += c·w` with asymmetric `c = 4` (bad news weighs 4×,
  `applyContradiction` `:513-547`).
- **Decay** (`decay` `:420-448`): on each access `α ← 1 + (α−1)·λ^Δt`, `β` likewise,
  90-day half-life. Dormant / bank-then-defect sources drift to the prior Beta(1,1).
- **LCB readout** (`lcbReadout` `:349-388`): `min(rep_cap, mean − z·sd)` with
  `z = √3`, CALIBRATED so the prior Beta(1,1) reads EXACTLY 0 — a fresh / whitewashed
  identity buys ≈ 0 weight (the uncertainty penalty; 500 new keys are 500 zeros,
  `newReputationState` `:251-264`).
- **Decay-on-read** (PURE, `scoreOf` `:779-790`): decays a COPY of stored α/β to the
  clock before readout so a dormant source reads its staleness IMMEDIATELY; the read is
  side-effect-free (only writes persist decay, via decay-before-mutate).
- **M2/M3 structural fields** (`:215-243`): a NON-DECAYING `corroborationDepth`
  (monotone-max MIS depth; feeds a permanent α-floor `floorMass` `:300-307`, deadband 2,
  cap 12) and a NON-DECAYING bounded `scarBeta` (adjudicated betrayal / disown crater;
  suppresses the depth-floor via `d_eff = max(0, depth − scarBeta)` and adds to β_eff),
  recoverable only by genuine NEW independent depth, never by time.
- **Precise reversal** (`applyCreditReversal` / `reverseCredit` `:565-590`): subtract
  EXACTLY the recorded `w` back out of α (clamped at the prior 1) — the exact-disown
  unwind.
- **Direct-seed crater** (`craterState` `:602-627`, `disownSweep` `:817-845`): reset to
  Beta(1,1) + wipe depth + stamp the scar; idempotent (a `disowned` set); fails closed.

`InMemoryReputationLedger` and the drop-in `SqliteReputationLedgerImpl` (shared-handle
or path; read-time legacy migration; `:994-1129`) implement the same pure math.

### Pillar 4 — Stake (`stake.ts`)

In-memory accounting: post / burn / query a source's deposit; `financialStakeWeight`
composes MULTIPLICATIVELY with the row it backs (`:21-44`). The retroactive
consequences of a burn live in reputation.ts, keeping accounting separate from the
sweep.

### The MIS independent-root count (`index.ts:276-511`)

`independentRootCount(rootSet)` is what forgetting reads instead of self-computing.
Two stages:
- **Stage 1** (`:285-289`): collapse by offline independence class — an upper bound
  (`distinctClassCount`). Same-root/same-class floods collapse to 1.
- **Stage 2** (`:291-510`): the EXACT maximum set of pairwise-independent roots = max
  clique in the "independent" graph, via **Bron–Kerbosch with Tomita pivoting** over a
  ≤31-bit bitmask (`:410-492`), deterministic (sort by `rootId`, ascending branch),
  for `n ≤ MAX_EXACT_ROOTS = 18`; above that a bounded deterministic greedy maximal set
  (may undercount — the bomb-safe direction, `:493-507`). Result is clamped to the
  Stage-1 bound.

The `independent(a,b)` predicate (`:370-396`): distinct class AND (if both sources
resolvable) the registry's source-aware `independentSources` (which sees per-anchor
`classId` + the `operatorClassId` fleet axis) else `independenceBetween(...) > 0`;
null-source falls open to the class verdict (never downgrades without positive
correlation evidence). This FIXES the transitivity undercount (A~B, B~C, A⊥C returns
2 in every ordering) while a fake-independence flood sharing an anchor class stays a
clique-less graph ⇒ 1. `independentSources(a,b)` (`:513-534`) is the source-level twin,
so the approve-gate and forgetting count share ONE independence notion.

---

## 9. Ratification subsystem (`src/ratification/`)

The vault, the doorbell, the undo engine, and tamper-evidence.

### The vault + doorbell (`pendingLedger.ts`)

Tanaka-shaped: "a vault and a doorbell, never a judge" (`:1-40`).
- **Vault**: an append-only, hash-chained, Ed25519-signed ledger. Records are
  `PENDING | APPROVAL | MUTATION` (`:78-116`); each chains via `prevHash`
  (genesis = `sha256("GENESIS")`), commits `thisHash` over an explicit canonical
  preimage, and carries a detached `sig`. `verifyChain()` recomputes every hash,
  verifies every signature, and names the first broken seq — the "money artifact."
- **Doorbell**: `appendPending` / `listPending` (reputation-ranked) / `approve`.
  `approve` enforces the **distinct-approver gate** (rejects self-approval — the
  approver must not have authored any disputed member) and a **provenance gate** (the
  approver's passport must verify — "no provenance → no voice"), then emits a
  `ResolvedDispute` PLAN (mint OUTRANKS winner→losers, demote losers, drive
  reputation) the engine applies. Purity boundary: the ledger does NO StrandStore I/O.
- **MUTATION receipts** (`:88-116`) journal control-plane effects (DISOWN_CRATER,
  DEMOTE, REPUTATION_CONTRADICT/RATIFY/REVERSE_CREDIT) so a hidden trust mutation earns
  a committed Merkle leaf. `mutationReceipt.ts` content-addresses the subject
  before/after states (`hashStrandState` commits `fact_state`+`outranked_by`;
  `hashReputationState` commits α/β/scarBeta/depth) — the exact fields a hidden-mutation
  attack must flip.

### The corroboration-event ledger (`corroboration.ts`)

The substrate that makes corroboration credit reversible. When source B earns
reputation because its claim AGREED WITH A's strand — but carries no DERIVATION edge to
A — the graph holds no funding link. The fix: RECORD the link AT EARNING TIME as an
append-only `{ eventId, ratifiedStrandId, corroboratingStrandIds[], beneficiarySourceId,
reputationDelta, at }` (`:53-73`), where `reputationDelta` is the EXACT α-mass added.
On disown, events whose `corroboratingStrandIds` intersect the tainted closure are
reversed exactly once (`markReversed` guard). The intersection IS the guard —
coincidental independent agreement (no recorded funding link) is never punished.

### The disown undo sweep (`disown.ts`)

`downstreamDisownSweep` (`:451-780`) — the store-aware orchestrator finishing pillar 4.
Runs as ONE atomic transaction (`withSweepTxn` `:380-393`):

1. **Direct seed + idempotency** (`:486-505`): delegate to `ledger.disownSweep`; an
   empty clawback ⇒ already disowned ⇒ complete no-op.
2. **Taint roots + tainted class set** (`:519-552`): deduped seed by `content_hash`;
   the tainted independence classes = classes of seed roots whose `sourceId ===
   disowned` (fail-closed fallback to all seed classes).
3. **Downstream BFS** (`:554-658`) over `inEdges` filtered to `DERIVATION`, walked
   BACKWARD (a DERIVATION edge points derived→witness, so edges ENTERING a tainted
   witness have `from` = a derived strand that rested on it). Per downstream strand,
   TWO SEPARATE decisions: **DEMOTE** (existence-rests-on: synthetic OUTRANKS from a
   disown sentinel, demote, putStrand — never delete) and **CONTRADICT** (credit-funded-
   by: only sources with a provenance root in the tainted class set — coincidental
   independent agreement is never punished). Cycle-safe (`visited`), deterministic
   (frontier by `(content_hash, id)`), dedupe-by-root.
4. **HARDENING 4 false-disown protection** (`survivingIndependentSupport` `:331-343`,
   default ON at the engine seam): a derived strand with ≥ `minSurvivingSupport` (2)
   distinct NON-tainted independent classes is SPARED — disowning a rival must not
   suppress their independently-corroborated work.
5. **Precise credit reversal** (`:687-720`) over the FULL tainted closure
   (seed ∪ demoted-downstream), exact, idempotent.
6. **HARDENING 1 weak-influence review queue** (`:722-738`): consulted-but-not-cited
   works → HUMAN review, never auto-demote.
7. **HARDENING 3 adjudication re-opening** (`:740-767`): a RESOLVED dispute whose
   surviving margin (`defaultSurvivingMargin` `:227-239`, biased toward re-opening)
   drops below the decisive threshold once tainted contributors are removed transitions
   back to PENDING (`REOPENED_BY_DISOWN`).

`CORROBORATION_CREDIT_SUBSTRATE_SPEC` (`:301-309`) documents the honest boundary:
reversal is BOUNDED (exact over the recorded DERIVATION + corroboration closure);
re-observation / uncited influence is a priced-not-prevented residual, reported
SAFE-DEFER, not DEFENDED.

### Merkle tamper-evidence (`merkleLog.ts`)

An RFC-6962 CT-style Merkle layer LAYERED on the signed chain (`:1-38`), purely
additive (records ARE the leaves — recomputed on demand, no desync). Domain-separated
hashing (`leafHashOfPreimage` `0x00‖…` `:79-83`; `nodeHash` `0x01‖l‖r` over raw digests
`:94-101`; empty root `sha256("")`). Provides O(log n) inclusion + consistency proofs,
epoch Signed Tree Heads signed by the log key, and publication to ≥2 independent sinks
(fail-closed at wiring). The guarantee is DETECTION-given-an-honest-published-anchor:
any deletion, rollback, reorder, or split-view is detectable (`detectSplitView`); it is
null without live witnesses.

### Reconcile & the other ledgers

- `reconcile.ts` — `reconcileLedger` (off-ledger reputation drift detector),
  `assertRatifyEmitsEvent` (write-time total-ledger invariant: a reputation-earning
  ratify that named corroborators MUST record a reversible event, else throw).
- `weakInfluence.ts` — the consulted-but-not-cited ledger (`edgesConsulting`,
  `markReviewed`).
- `adjudicationProvenance.ts` — records the winning margin + contributing strands of
  RESOLVED disputes (`recordsContributedBy`, `markReopened`) for HARDENING 3.

---

## 10. The engine (`src/api.ts`) — `IntelligentDb`

The thin orchestration seam. Holds NO algorithmic cores; it wires the subsystems.
Three verbs mapped onto the invariants, plus admin verbs.

### `writeFact` (`:884-913`) / `writeFactsBatch` (`:919-932`)

Mints an OBSERVED strand (`makeObservedStrand` `:552-577` — pinned WARM for the grace
window, LIVE, provenance root from the stamp, content hash). Attachment is the
mechanical SHARED_ENTITY INDEX (a single `putStrand` under `withTxn`; siblings derived
at read time), so writeFact is O(1). `provenance_independence` for future edges is
read FROM the stamp (invariant 2). Batch amortises one durability barrier over N facts.

### `recall` (`:938-958`)

Builds a fresh `HaltingController`, runs `activationWalk`, returns `{ lit, halt }`. The
model SPEAKS; it never confirms.

### `ratify` (`:964-1081`)

The ONLY belief-raising verb; structurally requires an external stamp (re-stamped
through the identity layer so the recorded root is canonical). DERIVED → OBSERVED+LIVE
(the "window"), or PROVISIONAL → LIVE, or (already witnessed/demoted) just appends the
external root (`:999-1017`). Drives the reputation ledger with the engine-owned MIS
depth `#R` (`:1050-1051`), records a corroboration event with the EXACT applied α-delta
when it named corroborators (`#deriveAgreementSet`, engine-owned evidence — the caller
cannot inject a corroborator list, `:222-228`, `1053-1072`), and enforces
`assertRatifyEmitsEvent` (`:1079`).

### `adjudicate` (`:1087-1270`)

Resolves LIVE members by attribute, builds `stampsByRoot`, and runs the pure
`tryConsolidate` with engine-supplied callbacks built from its OWN trust layer (OD-8):
`agreementRootCountOf = #R` (F4a), `attrCorroborationCountOf = #deriveAgreementSet.size`
(F4b), and — when `opts.highImpact` — a `HighImpactContext` (`#buildHighImpactContext`
`:808-848`). Routes the outcome:
- **RESOLVED** → persist each loser's OUTRANKS edge + demotion + `reputation.contradict`
  (with the M3 scar, rate-limited per source-pair by `#admitScar` `:792-800`) + a
  DEMOTE MUTATION receipt, then record adjudication provenance — all under one
  `withTxn` (`:1150-1241`).
- **DEFERRED** → `appendPending` with engine-owned dedup evidence (`disputingSources`,
  `coalesceKey` `:1253-1264`); throws if no ledger is wired (a deferral is never
  silently dropped, `:1247-1252`).
- **NOOP** → nothing.

The shared **`#R` primitive** (`:756-768`) unions the target's roots with every
agreeing LIVE strand's roots (same entity + `content_hash`, via `#deriveAgreementSet`
`:733-742`) and defers to `identity.independentRootCount` — the ONE agreement basis all
downstream consumers read (OD-6), anti-inflationary (clamped, can only make gates
harder).

### `disown` (`:1550-1614`)

Enumerates the seed (every strand with a provenance root whose `sourceId === disowned`,
via `allStrands` — an offline op), assembles `DisownHardeningDeps` from the wired
ratification ledgers (`checkSurvivingSupport` defaults ON), and runs
`downstreamDisownSweep` (itself atomic). Throws if no reputation ledger is wired.

### `approve` (`:1382-1544`) / `listPending` (`:1377-1380`)

`approve` runs the ledger's distinct-approver + provenance gate, applies the returned
plan to the store (persisting the EXACT objects the ledger mutated in place — critical
under a clone-on-read SQLite backend, `:1404-1435`), and journals REPUTATION receipts —
all under one `withTxn` so the immortal audit chain never desyncs from the state it
describes.

### Merkle admin (`anchorEpoch` / `publishGenesis` / `merkleLog`, `:705-715`)

Operator/cron-driven epoch anchoring — off the write/recall path.

### Atomic compound writes (`withTxn` `:600-617`)

Wraps each compound op in ONE store transaction; on throw, rollback + rethrow; a no-op
straight call for the in-memory backend. Because the reputation + ratification ledgers
write through the SAME shared db handle in shared-handle mode, their INSERT/UPDATEs
enroll automatically — facts + trust + audit commit together, crash-consistently.

### Composition root (`createIntelligentDb` `:396-404`)

```
createIntelligentDb(
  store: StrandStore,
  identity: SourceIdentityLayer,
  consolidation?: ConsolidationPort | null,   // keep-pressure recompute seam (no-op default)
  reputation?: ReputationLedger | null,       // pillar-3 backend; SAME instance the identity
  ratification?: RatificationDeps | null,     //   facade reads scoreOf from, or the stamp won't move
)
```

`RatificationDeps` (`:413-452`) carries the `ledger` (vault+doorbell), the
`systemSigner` (engine passport signing PENDING/MUTATION records), and optional
`corroboration`, `adjudicationProvenance`, `weakInfluence`, and `merkle` ({signer,
sinks}) ledgers. The Merkle log is built at construction (`:680-690`,
fail-closed on <2 sinks). `systemCoherence.test.ts` wires the WHOLE pipeline over ONE
shared SQLite handle as the canonical composition proof.

---

## 11. Recall entry & agent surface

- **`recall/cueResolver.ts`** — the cue→seed step (the missing entry point).
  `CueResolver` is a pluggable seam; the default `createLexicalCueResolver` is a
  zero-dep token inverted index + exact-entity boost, ranked by match strength
  (`topK = 8`, `energyFloor = 0.15`). `index(strand)` keeps it current; it rebuilds
  from `allStrands()` at construction (survives a SQLite reopen). A future
  `createEmbeddingCueResolver` swaps in with the same signature.
- **`agent/agentMemory.ts`** — the "attach and use" facade. Wires a store (SQLite if
  `dbPath`, else in-memory) + the identity layer over lightweight in-process pillar
  ports + the engine + the cue resolver, and auto-provisions a default single-agent
  source so the simple case needs zero identity management. Surface (`AgentMemory`
  `:149-194`): `remember`, `recall(string | Cue)`, `ratify`, `adjudicate`, `disown`,
  `listPending`, `approve`, `stampFor`. Returns cited, grounded, prompt-ready
  `CitedFact`s (no provenance → no voice, structurally).
- **`mcp/handler.ts`** — a pure, zero-dep JSON-RPC 2.0 MCP handler exposing
  `initialize` / `tools/list` / `tools/call` for the `remember` + `recall` tools;
  `mcp/server.ts` frames stdin/stdout around it.

---

## 12. End-to-end data-flow summary

```
 WRITE (file)     ratify (external witness)        adjudicate (dispute)         disown (fraud)
 ──────────       ────────────────────────         ────────────────────         ──────────────
 stamp+payload    externalStamp + strandId         attributeKey                 sourceId
   │                │                                │                            │
 makeObserved     re-stamp via identity            resolve LIVE members         enumerate seed
 Strand (WARM,    append external root             build stampsByRoot           (allStrands)
 LIVE, prov)      DERIVED→OBSERVED /               tryConsolidate(...#R,        downstreamDisownSweep
   │              PROVISIONAL→LIVE                   #agreementSet, highImpact)   (atomic):
 putStrand        reputation.ratify(depth=#R)       ├ RESOLVED → demote losers    crater seed
 (withTxn)        record corroboration event        │   + OUTRANKS + contradict   BFS DERIVATION↑
   │              (exact α-delta)                    │   + adjProvenance           demote/contradict
 entity index     assertRatifyEmitsEvent            ├ DEFERRED → appendPending    reverse credit
 = read-time                                        └ NOOP                        review queue
 sibling fan                                                                      re-open disputes
                                                                                  (all one txn)

 RECALL (speak):  cue → CueResolver → WalkSeed[] → activationWalk + HaltingController
                  → { lit: LitStrand[], halt: HaltStamp }   (assembler cites; model never confirms)
```

Every belief change flows through `api.ts`; nothing else mutates `fact_state`. The
identity layer is the sole authority for source independence; the store is
value-neutral plumbing; the model proposes and speaks but never witnesses.
