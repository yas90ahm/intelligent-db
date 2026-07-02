# Cycle-1 Sybil Red-Team — Report

**Commit:** `6c06a46` (adds only `src/__bench__/redteam/{harness,attacks,redteam.test}.ts`; zero `src/` engine files changed). **Typecheck:** `npx tsc --noEmit` PASS (exit 0). **Tests:** 259 passed / 12 skipped (REDTEAM-gated runner skipped). Reproduced live via `REDTEAM=1 vitest`, deterministic. **Verifier verdict:** TRUSTWORTHY — every outcome read back from real engine state (`fact_state`, `ConsolidationOutcome.kind`, `independentRootCount`, `listPending().length`, post-disown `repOf`); no outcome hardcoded.

## 1. DEFENSE PROFILE

**36 attacks: 9 DEFENDED · 6 BREACHED · 21 DEFERRED · 0 N/A**

| Attack family | Total | DEFENDED | BREACHED | DEFERRED |
|---|---|---|---|---|
| flood-echo | 6 | 3 | 0 | 3 |
| contradiction-bomb | 6 | 1 | 1 | 4 |
| first-arrival | 6 | 0 | 3 | 3 |
| reputation-weight | 6 | 1 | 1 | 4 |
| class-anchor | 6 | 4 | 0 | 2 |
| mixed-novel | 6 | 0 | 1 | 5 |
| **Total** | **36** | **9** | **6** | **21** |

Breaches concentrate where a **single** laundered/aged source meets the decisive-EARNED auto-resolve gate (first-arrival 3/6, plus one each in contradiction-bomb and reputation-weight) and at the **disown reachability boundary** (mixed-novel). Defenses concentrate in the structural-collapse families (class-anchor 4/6, flood-echo 3/6). The 21 DEFERs are dominated by one real engine property (§3): multi-witness co-assertion collapses its own decisive margin.

## 2. BREACH CATALOGUE

**B1 · SleeperRepLaundering** (contradiction-bomb) — *maps to "priced not prevented."* One DOMAIN source earns global LCB 0.509 on unrelated truths, then lies on a fresh attribute where the honest witness reads exactly 0. Multi-class, default impact → RESOLVED for the lie (gap 0.509 ≥ 0.30, top ≥ 0.20): `true=DEMOTED, false=LIVE`. **Boundary:** reputation is per-source and attribute-agnostic — trust is a transferable bearer asset; one laundered witness overturns a fresh true one. Engine behaving exactly as its thresholds specify; genuine integrity gap, not an impl defect.

**B2 · Patient-Zero / Slow-Burn Single-Anchor Canonical** (first-arrival) — *maps to "priced not prevented" + first-arrival.* Same mechanic on a low-impact attribute. Aged single anchor (LCB 0.509) vs fresh true (0) → AUTO-RESOLVE for the false first-arrival canonical, no DEFER. `true=DEMOTED, false=LIVE`. **Boundary:** the decisive-EARNED gate is incumbent-protecting — it rewards whoever banked reputation first.

**B3 · Reputation Carry-Over / Cross-Attribute Trust Spend** (first-arrival) — *maps to "priced not prevented."* Authority banked on attribute X spent on a false claim in attribute Y. BREACHED at default impact (`true=DEMOTED, false=LIVE`); DEFERS only when the caller passes `highImpact` (the lie's single anchor class fails the ≥2-disjoint-class clause). **Boundary:** no per-attribute reputation partition; the only defense is opt-in per call.

**B4 · Decay-Keepalive / Dormancy-Gaming the 90-Day Window** (first-arrival) — *genuine surprise (operational).* Incumbent pays O(1 ratify / 60 days) to cancel the 90-day decay: LCB held at 0.490 across 720 sim-days while every fresh challenger restarts at 0; the planted false `price` auto-resolves indefinitely. **Boundary:** "decay sets pressure" is defeated by a cheap heartbeat — decay bites only the honest dormant source, never the active liar. Time axis gameable at O(1) cost. Partially novel.

**B5 · Sleeper Whitewash + Disown-Evasion Pivot** (reputation-weight) — *most important disown finding; maps to documented disown semantics.* A single decisive lie auto-resolves at t0 (`true=DEMOTED, false=LIVE`, single-source gap 0.4). Then `disown(S)` craters S's reputation to 0.000 **but the false value stays LIVE and the true stays DEMOTED** — the sweep demotes only DERIVATION-downstream derivatives, not S's own seed strand, and the re-open emits a PENDING horn rather than auto-restoring truth. **Boundary:** disown is **not self-healing** for a directly-seeded lie; it must be re-adjudicated by a human, leaving a t0→disown exposure window (already-spoken).

**B6 · Confederate Launder / disown taint-closure evasion** (mixed-novel) — *maps to bounded-taint-closure design tradeoff; SUSPECT-adjacent.* S_ben's rep is lifted by a clean third party (direct `earnTo`, no corroboration event intersecting S_bad's seed), so `disown(S_bad)` leaves S_ben's rep unchanged (0.509) and its FALSE_OWNER copy survives. **Boundary:** the "never punish coincidental independent agreement" rule is inverted into a laundering channel; clawback stops at the reachability boundary. **Flagged:** the no-intersecting-event precondition is hand-built into the harness — treat as "taint-closure boundary demonstrated," not "exploit discovered." Known design tradeoff surfaced concretely.

## 3. HEADLINE: the 21 DEFERRED

The decisive-margin gate compares the **top-vs-second ranked member** (`consolidation.ts` ln 834-842: `top=ranked[0]` vs `second=ranked[1]`, `gap = top.rep − second.rep ≥ decisiveMargin`), **not** winning-value vs best-other-value. Co-asserting witnesses appear as separate top-tied members → gap 0 → **collapse their own decisive margin → DEFER.** So every multi-witness "priced-not-prevented" attack predicted to BREACH instead DEFERS (PATIENT-AGED-DOMAIN-CARTEL, PricedQuorumFlip, Two-Anchor Notary, Sleeper Syndicate, Class-Disjoint Bond Farm, Trojan Witness, Decay-Trough Ambush, Variance Starvation). The engine is *more* integrity-defended than designed — a lone witness breaches, a corroborating pair does not. Verifier confirmed this in source.

Two real costs inside the DEFER bucket (integrity held, other axes breached): (a) **Availability/DoS** — no stake-to-contradict backpressure: Sandbag the Doorbell = 60 immortal tickets; LCB-Margin Sniper = 30 forced tickets; HighImpactStarvationOfTruth permanently DEFERS the most irreversible decision. (b) **Forged `independentRootCount`** (offline class-assignment liability) measured live even while adjudication defers: ClassCollusionEcho=6, Mislabeled-Class Sybil=8, Anchor Twins=3, CLASS-COLLISION-LAUNDERING/Mislabeled-Twins/Partial-Overlap=2 (true=1), Unresolvable-Root Mirage=4 — defeating the eviction floor and the high-impact ≥2-disjoint-class clause (correctly not scored as value-flips).

## 4. STRUCTURAL vs PARAMETRIC

**Structural (attack mathematically can't satisfy) — the DEFENDED 9:** content_hash echo-collapse (SELF-ECHO-MULTIPLICITY-PUMP 1500→1); shared-class collapse (SHARED-CLASS-EMAIL-CARTEL 200→1); operatorClassId fleet-cap (Shared-Registrar Fleet 50→1); bare-key cap 0.05 + once-per-class α (Bare-Key Avalanche 500→1 weightless); applySelfStackCap (Stacked-Cheap Costume 12× EMAIL→0.10); fresh-rep-0 starting point; eviction floor INDEP_SOURCE_COUNT≥2 + demote-never-delete (Eighteen-Plus Greedy Sag — *but this is a pure unit-check, not a full adjudication path*).

**Parametric / held only under these parameters (the fragile wins):** the **decisive-margin co-assertion collapse** carrying all 21 DEFERS is a *consequence of the ranked[0]-vs-ranked[1] comparison, not a designed Sybil defense* — an attacker who makes one witness *dominate* rather than co-assert re-opens the breach (the strongest apparent defense is an accidental byproduct). Reputation-gate-over-forged-counts (Unresolvable-Root Mirage held *despite* a genuinely forged count=4). decisiveMargin=0.30 / minWinnerReputation=0.20 are tunable straddle points (LCB-Margin Sniper).

## 5. CYCLE-2 ATTACK IDEAS (escalating novelty)

1. **Margin-Dominator** — defeats the §3 headline directly: one high-rep laundered witness asserts the false value while confederates *withhold* (or assert a throwaway third value) so they never tie the top → restore the decisive gap → convert the DEFER bucket into BREACHES. Tests whether the margin defense is real or merely accidental co-assertion.
2. **Keepalive-Cartel** (B4 × priced quorum) — combine the O(1)/60-day keepalive with genuinely class-disjoint anchors, staggering assertions so only one is `ranked[0]` at adjudicate time. Tests whether time-axis gaming + margin-dominance compose.
3. **Disown-Proof Seeding** (escalates B5) — seed lie → disown → observe PENDING → seed a second laundered identity that "corroborates" the lie before the human acts. Measures the exposure window and whether disown can be made monotonically losing for the defender.
4. **Count-Forgery → Eviction/High-Impact** — drive a forged mislabeled-twin count=2 to satisfy the high-impact ≥2-disjoint-class clause AND supply a margin-dominant top witness, composing forged independence with the dominance attack into a high-impact value-flip on an irreversible decision.
5. **Stake-Backpressure / Ledger-Exhaustion** (escalates Sandbag + LCB-Sniper) — drive `listPending` into the thousands and measure whether review latency lets first-arrived false canonicals dominate the read-path indefinitely (First-Arrival Freeze at scale), showing DoS and denial-of-truth are the same surface.

## Flagged SUSPECT / caveats
- **B6 Confederate Launder — SUSPECT-adjacent:** channel is partly hand-built; boundary demonstrated, not exploit discovered.
- **DriftBombDeferDoS:** mechanism prose says "DEFERS" but the actual outcome is RESOLVED-for-truth (depth 0); DEFENDED classification correct, narrative loose.
- **Eighteen-Plus Greedy Sag / Unresolvable-Root Mirage** are narrower than full attacks (a unit-check, and a DEFENDED-despite-forged-count=4 respectively); DEFENDED labels refer to the adjudication outcome, not a claim the count defense held.
- **Fidelity (not a defect):** the harness substitutes a custom `AnchorRegistryPort` keyed on offline `indClass`/`operatorClass` (the correct way to express the class-mislabel/fleet seam); the load-bearing math (`independenceBetween`, `repCapFor`, Beta ledger, `tryConsolidate`, disown sweep, `independentRootCount`) is the real production engine.

NOTE TO ORCHESTRATOR: target file `D:/Intelligent DB/.arbor/sessions/sybil-redteam/cycle1/REPORT.md` was NOT written — the subagent file-write guard blocked it. The full report content is above for the calling script to persist.