# CYCLE-2 RED-TEAM REPORT — Sybil / Identity-Layer Adversary Suite (REAL engine, classified from real post-call state)

## 1. DEFENSE PROFILE

**Headline: 28 BREACHED / 6 DEFENDED / 2 DEFERRED / 0 N/A — of 36 attacks.**

- Source of record: `D:/Intelligent DB/.arbor/sessions/sybil-redteam/cycle2/results.json` (`{cycle:2, total:36, defended:6, breached:28, deferred:2, na:0}`) — reproduced byte-for-byte by re-running the gated harness (`REDTEAM=1 npx vitest run …/redteam2.test.ts`).
- Engine integrity: `npx tsc --noEmit` exits 0; `npm test` = 259 passed / 13 skipped; the cycle-2 commit `71b0161` (branch `exp/sybil-redteam`) adds only `src/__bench__/redteam/cycle2.ts` + `redteam2.test.ts`. `git diff` of `src` excluding `__bench__` against the merge-base is empty — engine untouched, additive only.
- Every outcome is a computed expression off real post-call reads (`fact_state`, `ConsolidationOutcome.kind`, `independentRootCount`, the `DownstreamDisownResult` receipt, reputation α/LCB) — no hardcoded literals. Verifier verdict: TRUSTWORTHY.

### By family (breached / defended / deferred of 6 each)

| Family | Breached | Defended | Deferred | Where the family bites |
|---|---|---|---|---|
| patient-betrayal | 5 | 0 | 1 | Reputation is SourceId-global, decay has a maintainable fixed point, no internal re-open |
| whitewash-stake | 5 | 0 | 1 | Scars decay symmetrically; stake/anchor changes never claw back banked α |
| disown-evasion | 5 | 1 | 0 | Credit/weak-influence reversal is ONE-HOP, opt-in, and caller-asserted |
| decay-dormancy-bridge | 6 | 0 | 0 | No incumbency floor; bridge sweep has no identity gate; ring keepalive is cheap |
| derived-self-witness | 4 | 2 | 0 | `approve()`/graduation check key-provenance, not content/anchor independence |
| mis-fleet-novel | 3 | 3 | 0 | Class-disjoint COUNT is manufacturable; the MATH (weight) mostly defends |

**The two clean structural walls** (whole sub-families that held): the same-passport echo-collapse (`independentSources(K,K)=false` consulted BEFORE class-disjointness) defeats every "one identity manufactures roots" attack (OUROBOROS-CHAIN, ANCHOR-REBINDING-TIME-TRAVEL); and `independenceBetween` excising EVERY shared anchor class defeats partial-overlap seams (Seam Straddle) and the MIS 18-root cliff (Eclipse Padding, Boundary Oscillator) because the correlation model is equivalence-class (transitive), so the non-transitive correlation the undercount weapon needs is unrepresentable.

---

## 2. BREACH CATALOGUE

Format per entry: mechanism — real boundary revealed — documented-liability vs genuine-surprise — relation to cycle-1's confirmed "single-source default-impact auto-resolve" finding.

### patient-betrayal (5 breach, 1 defer)

1. **CrossDomainSpend** — reputation keyed by SourceId, `tryConsolidate` ranks on the source-GLOBAL LCB; trust farmed on trivia (LCB 0.361) auto-wins an unrelated lie vs a fresh true witness (0.000), true=DEMOTED. Boundary: no per-attribute reputation partition. **Genuine surprise** (sharpens cycle-1). This is the cycle-1 single-source-auto-resolve finding given a NEW dimension: not just "one aged source wins" but "credit is fungible ACROSS attributes," so the attacker need not even have a track record on the disputed attribute.

2. **TrustPacemaker** — decay-before-mutate re-anchors `lastUpdate` at each ratify; one cheap corroboration per ~180d pins LCB at the decay fixed point (0.319 after 3yr) forever. Boundary: decay has a cheaply-maintainable steady state. **Genuine surprise.** Turns the cycle-1 aged-incumbent win into a PERPETUAL flip cannon (~2 corroborations/yr).

3. **ArmoredBetrayal** — banked α≈7 absorbs one 4× contradiction (post-hit LCB 0.347, still flip-capable) ⇒ TWO betrayals before disqualification. Boundary: the 4× asymmetry slows recovery but does not one-shot-floor a banked identity. **Documented-ish** (asymmetric-β is a known tuning knob) but the multi-betrayal headroom is a surprise. Extends cycle-1: a single aged source can win MORE than once.

4. **SilentPermanentFlip** — `tryConsolidate` has no "new contradicting evidence reopens a RESOLVED set" path; the demoted true strand is no longer a LIVE member, so re-adjudication (+400d) returns DEFERRED and never reconsiders it. Only operator `db.disown` reopens. Boundary: no internal anomaly detector on a single-source win. **Documented liability** (re-open is disown-only by design) but its composition with cycle-1 is the teeth: the cycle-1 auto-resolve is PERMANENT absent a human.

5. **SelfStackedClasses** — `clearsHighImpactGate` reads `ctx.anchorClassCountOf(winner)` with NO requirement that the classes belong to DISTINCT sources; a class-set resolver returns 2 for one Email+Domain source ⇒ the irreversible gate is cleared by one actor (RESOLVED). Boundary: class-count ≠ actor-count. **Genuine surprise, but parameter-dependent** — the engine ships NO resolver; the harness's own provenance-based default returns 1 and DEFENDS. This is the high-impact escalation of cycle-1's single-source win. (See caveat in §5.)

- **IncumbencyMoat (DEFERRED, unexpected-defer worth cataloguing)** — restorer LCB 0.460 can't reach incumbent 0.313 + 0.30 ≈ 0.61, so the engine DEFERS (correct on the ledger). BUT the first-arrived FALSE value stays the displayed LIVE canonical. Boundary: the decisive-margin gate is direction-blind — it entrenches whoever paid the floor cost first. **Documented** (first-arrival trap) made quantitative: denial-of-RESTORATION, not a value flip. Directly the inverse face of cycle-1: the same margin that lets an aged source win also forbids truth from being restored.

### whitewash-stake (5 breach, 1 defer)

6. **Sleeper Corroboration Harvest** — actively farms 40 true corroborations → LCB 0.600 → flips one lie at DEFAULT impact (true=DEMOTED). High-impact variant DEFERS (gate defends). Boundary: track-record is fungible and farmable faster than decay-aging. **Genuine surprise.** This is the cycle-1 finding weaponized into an active strategy rather than passive aging.

7. **Transient Bond Cap-Inflation** — post a short bond to lift `applySelfStackCap` to 0.85, harvest cap-inflated α (6.0) + 5 corroboration events, withdraw the bond; nothing reverses (α stays 6.0). Boundary: stake EXPIRY triggers no claw-back. **Genuine surprise** but VERIFIER-FLAGGED as near-tautological (rebinding never touches the reputation ledger; doesn't prove the α was causally cap-inflated). Real state read, weak finding.

8. **Two-Class Costume (Stake+Email)** — {EMAIL, FINANCIAL_STAKE} = 2 class ids from one wallet clears the high-impact ≥2-class clause (RESOLVED). Boundary: class-disjointness ≠ actor-disjointness; MIS over CLASSES can't see one wallet. **Genuine surprise, parameter-dependent** (same class-count-resolver dependence as #5).

9. **Key-Rotation Whitewash** — reputation ledgered per passport key; a new key under the SAME retained DOMAIN anchor reads clean LCB 0.000; `disown(old)` cannot follow the anchor across the key change. Boundary: no anchor-level reputational lien. **Genuine surprise** — a real architectural gap (scar binds to key, scarcity binds to anchor).

10. **Dormancy Beta-Decay Wash** — symmetric 90d decay erodes the 4× β scar in absolute terms (0.509 → contradicted 0.165 → 360d → 0.019 ≈ fresh); `contradictedCount` is audit-only, never read by `lcbReadout`. Boundary: "lost fast" leaves no LASTING scar. **Genuine surprise.** Note: re-reaching HIGH trust is still DEFENDED (decay pulls to the prior, not 0.5); only the deterrent evaporates.

- **Bond-Backed Authority Synthesis (DEFERRED, expected-defend)** — a single 0.85-weight bond is `independentRootCount=1`; every anti-Sybil gate is COUNT-based ≥2, so high-impact DEFERS, truth holds. DEFENDED-in-effect. Confirms the design's intent: no gate substitutes a single high WEIGHT for COUNT≥2.

### disown-evasion (5 breach, 1 defend) — the Confederate-Launder family

11. **Two-Hop Relay** — B earns by naming proxy c1; c1 names a1. `disown(A)` ⇒ `eventsIntersecting({a1})` reverses ONLY C's event (`["corrob:0"]`, C α 2→1); E_B names c1 (sourceId C, not in A's seed) ⇒ B α 2→2, b1 LIVE. Boundary: credit reversal is ONE-HOP, never a transitive DAG closure (`disown.ts:620`).

12. **The Unnamed Witness** — B ratifies with NO `corroboratingStrandIds` ⇒ 0 events recorded; `disown(A)` reverses nothing; B α 4→4. Boundary: event recording is OPT-IN; the launderer just never names A.

13. **Decoy-Corroborator Misattribution** — B names a clean independent twin d1 ⇒ 1 event exists (balances a coverage audit) but `eventsIntersecting({a1})=[]` ⇒ B α 2→2. Boundary: corroborator sets are caller-ASSERTED, never verified.

14. **Proxy-Consulted Weak-Influence Launder** — weak-influence edge filed against c1; `edgesConsulting({a1})` is one-hop, queues only c1, never b1. Boundary: the uncited-influence channel has the SAME one-hop horizon (`disown.ts:634`).

15. **Re-Observation Bleach** — read A, re-file as a fresh OBSERVED strand under an attacker-assigned class with zero links; invisible to all three channels AND raises V's `independentRootCount` 1→2 (partially HEALING the planted claim). Boundary: the sweep follows only RECORDED links; a re-observation records none.

- **Contributor-Padding Margin Dilution (DEFENDED)** — the engine DERIVES `contributingStrandIds = winner + members sharing the winner's source`; clean pads can't be injected because any strand sharing the winner's source is itself disown-tainted ⇒ margin collapses to ~0 ⇒ dispute re-opens. Boundary held: the contributor list is NOT attacker-controllable through the engine. (Verifier note: the ACTUAL defense was same-source echoes collapsing the margin — slightly different from the contributor-derivation narrative — but "truth not flipped" is correct.)

All five breaches map to the documented residual that "credit-reversal CLOSED" was only ever claimed for self-declared, single-hop, correctly-attributed corroboration EVENTS. They are genuine surprises in DEPTH (the four orthogonal evasions) but map to a known structural boundary.

### decay-dormancy-bridge (6 breach, 0 defend)

16. **Trough-Synchronized Eclipse** — no incumbency floor; 400d dormancy decays a 6-witness incumbent 0.600→0.031; a 0.402 attacker clears the gap (RESOLVED, true=DEMOTED). Boundary: decay erases the DEPTH of past corroboration; a 6-witness and 2-witness fact are equally overturnable once both decay to the prior. **Genuine surprise**, generalizes cycle-1.

17. **Penance-by-Dormancy** — β decays at the same 90d half-life as α; one anchored identity recycled 3 lie-cycles (each contradicted ≈0.17 → washed ≈0.02); `contradictedCount` never read by the readout. Boundary: lost adjudications call `contradict` (recoverable), not `disown` (permanent). **Genuine surprise** — cost-amortization, not single-shot inversion.

18. **Recency-Window Straddle** — high-impact `recencyCleanWindowMs` is a fixed 90d lookback on a SINGLE `lastContradictionAt`; wait it out + keep α warm + buy ≥2 corroborations/classes ⇒ irreversible gate cleared (RESOLVED). Boundary: the gate adds DELAY + a 2-anchor price, not unforgeability. **Parameter-dependent** (same caveat as #5/#8 — needs an attacker-supplied HighImpactContext).

19. **Bridgehead Beacon** — `nextBridgeCrossing` guarantees one crossing per lit bridge with NO identity gate; a ZERO-independence bare-key CROSS_WEB_BRIDGE surfaces a false far fact on recall (Fpoison in `lit`). Boundary: the trust layer gates ADJUDICATION but not ACTIVATION/RETRIEVAL. **Genuine surprise** — a different attack surface (retrieval, never adjudicated). NOT related to cycle-1; this is the recall layer.

20. **Bridge-Sweep Eclipse** — 500 yielding decoy bridges off one hub; `halt=BRIDGE_STARVED degraded=true`, the genuine insight never crosses. Boundary: no per-source cap, no earned-value crossing priority on the ~20% sub-budget. **Genuine surprise** (denial-of-insight). Verifier note: `bridgesCrossed=2` ⇒ the precise cause is likely the low-yield circuit-breaker, not budget exhaustion — mechanism detail imprecise, breach real.

21. **Mutual-Keepalive Ring** — ~1–2 cross-ratifications/identity/yr pin a 3-source disjoint-class ring at LCB 0.369 for 3yr; one member's false canonical beats a fresh challenger forever. Boundary: the earned floor has no "expensive-to-MAINTAIN" term, no novelty/diversity requirement, no clique detection. **Genuine surprise** — collusion equilibrium that cycle-1's single-source frame didn't reach.

### derived-self-witness (4 breach, 2 defend)

22. **WINDOW-FORGERY** — `ratify` graduates DERIVED→OBSERVED checking only key/anchor provenance (`api.ts:729-732`), never content-causality; the web's own derived conclusion becomes its own external witness. Boundary: key-provenance independence ≠ content-provenance independence. **Genuine surprise** — direct violation of the "wall-with-a-window" invariant in substance while satisfying its letter.

23. **SCHRODINGER-RATCHET** — a single attacker times `adjudicate()` to a 220d-dormant honest incumbent's decay trough (0.060 vs warm 0.509) so a held PROVISIONAL collapses (RESOLVED, true=DEMOTED) without the attacker proving anything. Boundary: decay-on-read is symmetric in time but asymmetric in fairness — "continuously re-witnessed" is an UNSTATED precondition for truth to survive. (Verifier classified RESOLVED-for-the-lie.) Composes cycle-1 with attacker-controlled timing.

24. **RATIFICATION-BOOTSTRAP** — `approve()` gates on author-distinctness + valid passport ONLY (`pendingLedger.ts:454-480`), NOT anchor-independence; a sibling key sharing the asserter's anchor self-approves the lie (true=DEMOTED). Boundary: the missing check is `independenceBetween(approver, member) > 0`. **THE CLEANEST INVARIANT VIOLATION** and the single most valuable code-level finding — promote without an INDEPENDENT external stamp. Not parameter-dependent; a shipped-engine flaw on the human-ratify horn.

25. **RE-OBSERVATION-LAUNDERING** — `disown` reverses the tagged event d1 (B α 3→2) but the untagged re-observation credit d2 survives (B α stays >1). Boundary: taint-closure is exact only over DERIVATION edges + recorded EVENTS; a re-observation is tracked by neither. Same residual as #15, at the reputation layer.

- **OUROBOROS-CHAIN (DEFENDED)** & **ANCHOR-REBINDING-TIME-TRAVEL (DEFENDED)** — `independent()` consults `independentSources(K,K)=false` (same-passport echo) BEFORE class-disjointness, so one identity cannot mint independent roots regardless of class labels or sequential rebinding (count stays 1). Structural wall.

### mis-fleet-novel (3 breach, 3 defend)

26. **Registrar Carousel** — 4 distinct registrar×ASN DOMAIN corroborators (kept low-rep so they don't dilute the champion) yield 4 distinct operator classIds ⇒ no fleet collapse ⇒ `independentRootCount=5`; the high-impact ≥2-corroboration/≥2-class/recency-clean prereqs are satisfied on top of a 0.509 aged champion (RESOLVED, true=DEMOTED). Boundary: the system CANNOT see one puppeteer funds all four. **The documented offline class-assignment liability** at high impact — and the STRONGEST high-impact finding because it uses the harness's FAITHFUL provenance-based default resolver (not an attacker-supplied one). Genuinely manufactures the count.

27. **Mega-Provider Tenant Seam** — one tenant mints 6 per-address EMAIL anchors (each a distinct classId); the fleet-cap can't group by the shared mega-provider domain without false over-collapse of honest users. DEFENDED on WEIGHT (each ~0.10, rep_cap 0.30 — can't win a decisive adjudication) but BREACHED on integer COUNT (`independentRootCount=6` arms every count-based gate: eviction floor, ≥2-corroboration prereq, root-set padding). Boundary: count-based gates trust class-disjoint headcount. **Genuine surprise** (the weight/count split).

28. **Null-Source Laundromat** — two null-source distinct-class roots get class-only independence (`independentRootCount=2`); the disown sweep has no resolvable sourceId to contradict, so the poison strand stays LIVE through `disown(P)` (demotedDownstream=0). Boundary: the class-only fallback GRANTS independence to unresolvable roots (permissive, not conservative) AND disown keys on resolvable sourceIds. **Genuine surprise** — a permissive-fallback hole.

- **Eclipse Padding / Boundary Oscillator (DEFENDED)** — the MIS greedy-undercount-to-1 weapon needs a NON-transitive correlation (a root correlated with both G1 and G2 while G1⊥G2), unrepresentable in the equivalence-class correlation model; greedy keeps both honest distinct classes ⇒ count≥2, eviction floor holds. The 18-vertex cliff exists but is not weaponizable for suppression here.
- **Seam Straddle (DEFENDED)** — `independenceBetween({DOMAIN,EMAIL},{DOMAIN,EMAIL})=0`; class-granular excision removes BOTH shared classes, no disjoint residual. The MATH defends; only the offline `indClass` assignment can be fooled — the same standing liability, not a new math hole.

---

## 3. CONFEDERATE-LAUNDER RE-DERIVATION — EXPLICIT VERDICT

**Outcome: REAL BREACH. Laundering is a TRUE residual — the real corroboration/weak-influence ledgers do NOT defend it.** Re-derived through the SHIPPED ledgers (`createCorroborationLedger()`) via the engine's `ratify`/`disown` verbs (not a hand-built channel), reading `res.reversedCorroborationEventIds` off the real `DownstreamDisownResult` receipt, it breaks four orthogonal ways, each confirmed from post-disown α:

- **Two-Hop Relay** reverses only `["corrob:0"]` (C's), B's α holds 2.000 — reversal is one-hop, not a transitive DAG closure.
- **Unnamed Witness** records 0 events — recording is opt-in.
- **Decoy Misattribution** records 1 event naming d1, reverses [] — corroborator sets are caller-asserted, never verified.
- **Re-Observation-Laundering** reverses only the tagged d1, B's α stays 2.000 > 1 — credit-reversal is open for re-observed content.

The "credit-reversal CLOSED" guarantee in CLAUDE.md holds ONLY for self-declared, single-hop, correctly-attributed corroboration EVENTS. The weak-influence review queue shares the identical one-hop horizon (Proxy-Consulted, #14). Verifier confirmed GENUINE: all four drive the real wired ledger and classify off the real receipt.

---

## 4. PATTERNS — structural defenses vs parameter-dependent holds

**Structural defenses (a property the attack mathematically cannot satisfy — these held against adaptive pressure):**
- Same-passport echo-collapse (`independentSources(K,K)=false`) consulted before class-disjointness ⇒ one identity can never manufacture independent roots (OUROBOROS-CHAIN, ANCHOR-REBINDING). This is the strongest wall in the system.
- Class-granular anchor excision in `independenceBetween` ⇒ partial-overlap seams collapse to 0 (Seam Straddle).
- Equivalence-class (transitive) correlation model ⇒ the non-transitive correlation the MIS undercount needs is unrepresentable (Eclipse Padding, Boundary Oscillator) — the 18-root cliff is real but not weaponizable for suppression.
- Engine-derived `contributingStrandIds` ⇒ attacker can't inject clean pads (Contributor-Padding).
- COUNT≥2 gates ⇒ a single high WEIGHT never substitutes for count (Bond-Backed Authority).

**Parameter-dependent / contract-hazard holds (the gate is a tunable threshold or relies on caller-supplied wiring — these BREACH or DEFEND depending on configuration, not math):**
- The high-impact gate's class-COUNT reads (`anchorClassCountOf`, `corroborationCountOf`) are an UNSAFE-RESOLVER hazard: SelfStackedClasses (#5), Two-Class Costume (#8), Recency-Window Straddle (#18) BREACH only under an attacker-supplied resolver that counts a single source's OWN classes; the harness's provenance-based default returns 1 and DEFENDS. The engine ships NO resolver — the gate's "≥2 disjoint anchor classes" WORDING invites the unsafe reading.
- Decay parameters (90d half-life, symmetric β) ⇒ every decay-trough / keepalive / scar-wash breach (TrustPacemaker, Trough Eclipse, Penance, Dormancy-Wash, Mutual-Keepalive, SCHRODINGER) is a threshold an attacker tunes around by WAITING. No structural floor, only a calendar.
- The decisive-margin (0.30) is direction-blind ⇒ entrenches the first-mover (IncumbencyMoat) and lets cross-domain LCB win (CrossDomainSpend).
- Count-based gates trust class-disjoint headcount ⇒ manufacturable by fleet seams (Mega-Provider, Registrar Carousel, Null-Source).

**The meta-pattern:** every BREACH is either (a) a missing structural defense where the design relies on a tunable threshold (decay/margin), or (b) a recorded-link gap (one-hop, opt-in, caller-asserted) in the disown/credit machinery, or (c) a count-vs-actor / key-vs-anchor / class-vs-actor conflation. The DEFENDED set is exactly where a structural invariant (echo-collapse, class excision, engine-derivation) replaces a threshold.

---

## 5. CYCLE-3 ATTACK IDEAS + CANDIDATE FIXES TO PROBE

### Most-novel / combined / adaptive attack ideas

1. **Anchor-Lien Carousel (combines #9 Key-Rotation + #26 Registrar Carousel + #16 Trough Eclipse).** Rotate keys under a fixed pool of 4 registrar×ASN anchors on a decay-trough cadence: each fresh key reads clean (no per-key scar), the 4 anchors manufacture `independentRootCount≥2` to clear the high-impact gate, and dormancy-timing puts the honest incumbent in its trough. Tests whether ANY single fix (anchor-level lien, per-attribute scoping, incumbency floor) closes the COMPOSITION or only one leg.

2. **Transitive Launder Chain at depth N (adaptive #11/#13).** Build an A→c1→c2→…→cN→B relay where each hop names only its immediate proxy, then measure how many hops `disown(A)` reverses. Predicts reversal stops at hop 1 regardless of N. Directly stresses any "make reversal transitive" fix and quantifies the linear-cost laundering claim.

3. **Bridge-Beacon + Re-Observation Healing (combines #19 Bridgehead + #15 Re-Observation Bleach).** Plant a false far fact via an identity-gateless bridge, then re-observe what surfaces as a fresh OBSERVED strand to raise its root count — converting a stamped-low-corroboration retrieval into a count-healed "independent" witness. Probes whether a retrieval-layer identity gate AND credit-reversal-over-re-observation are BOTH needed.

4. **Self-Ratification Ring on the human horn (adaptive #24 RATIFICATION-BOOTSTRAP + #21 Keepalive Ring).** A disjoint-class Sybil ring where each member `approve()`s another's disputes (distinct authors, valid passports, no anchor-independence check) — turning the human-ratify vault into an internal majority machine. The single highest-value target: it defeats the "external stamp" invariant directly.

5. **Per-Attribute Sleeper Swarm (adaptive #1 CrossDomainSpend + #6 Sleeper Harvest).** Many sources each farm LCB on disjoint trivia attributes, then converge to spend on ONE high-value lie — tests whether per-attribute reputation scoping (candidate fix below) actually forces re-earning, or whether headcount of cross-domain LCB still aggregates.

### Candidate FIXES cycle-3 should probe (and which attacks each must close)

- **≥2-corroboration-for-ANY-auto-resolve (raise default-impact to the high-impact COUNT bar).** Probe against the patient-betrayal + whitewash families (#1–10, #16, #23). This is the most leveraged single fix: it would convert every single-source default-impact auto-resolve (the confirmed CYCLE-1 finding, re-confirmed here as the root of ~12 breaches) into a DEFER. Cycle-3 must verify it does NOT merely shift the bar to the Registrar Carousel (#26) / Mega-Provider (#27) count-manufacturing attacks — i.e., test that count-quality (actor-disjointness), not just count, is enforced.

- **Per-attribute reputation scoping (key the LCB by (source, attribute) or attribute-family).** Probe against CrossDomainSpend (#1), Sleeper Harvest (#6), Two-Hop relays that farm on trivia. Must confirm it doesn't break legitimate cross-domain experts and that "attribute" can't be gamed by fine-grained partitioning.

- **Defer-ALL-1v1 (never auto-resolve a two-member single-independence-class OR single-winning-source dispute).** Probe against SilentPermanentFlip (#4), ArmoredBetrayal (#3), TrustPacemaker (#2), Trough Eclipse (#16), SCHRODINGER (#23). The cleanest expression of cycle-1's lesson: if exactly one source backs the winning value, route to the human horn unconditionally. Cycle-3 must measure the false-DEFER rate (does it flood `listPending`?) — the contradiction-bomb risk in reverse.

Additional fixes cycle-3 should at least scope (highest-value code-level, from §2): an **anchor-independence check in `approve()`** (`independenceBetween(approver, member) > 0`) to close RATIFICATION-BOOTSTRAP (#24); an **anchor-level reputational lien** to close Key-Rotation Whitewash (#9); a **retrieval-layer identity gate on bridge crossings** to close Bridgehead Beacon (#19); and making `disown` credit/weak-influence reversal **transitive over the corroboration DAG** to close the one-hop laundering family (#11–15, #25).

---

## 6. VERIFIER CAVEATS (folded in — read these with the counts)

The counts and engine-untouched claims are reproducible and correct; the laundering re-derivation is genuine (real wired ledger). Three qualifications on WHICH of the 28 are shipped-engine flaws vs integration-contract hazards:

- **SelfStackedClasses / Two-Class Costume / Recency-Window Straddle (#5, #8, #18)** BREACH only under an ATTACKER-supplied `HighImpactContext` whose `anchorClassCountOf`/`corroborationCountOf` count a single source's OWN classes/ratifications. The engine ships NO resolver; under the harness's DEFAULT provenance-based resolver (independentRootCount=1 for one source) these three DEFER (defend). They are integration-contract hazards (the gate's "≥2 disjoint anchor classes" wording invites an unsafe resolver), NOT breaches of the engine's faithful wiring. Read them as a documentation/API-shape risk, not shipped-engine holes.
- **Transient Bond Cap-Inflation (#7)** is near-tautological — rebinding anchors never touches the reputation ledger, so "α unchanged after dropping the bond" doesn't demonstrate the α was causally cap-inflated. Real state read, weak finding.
- **Bridge-Sweep Eclipse (#20)** breach is real (legit insight suppressed, `halt=BRIDGE_STARVED degraded=true`), but `bridgesCrossed=2` indicates the precise cause is likely the low-yield circuit-breaker, not "20% budget exhausted" as the narrative states — mechanism detail imprecise, breach real.

The other ~24 breaches are real under faithful/default wiring. **Registrar Carousel (#26) is the strongest high-impact finding** precisely because it uses the harness's FAITHFUL provenance-based default resolver and still manufactures `independentRootCount=5` via distinct offline operator classes — the documented offline class-assignment liability, not an attacker-chosen gate. The DEFENDED/DEFERRED set is honestly classified — truth is never demoted in any of the 8 (Contributor-Padding's actual mechanism was same-source echo collapse rather than the contributor-derivation narrative, but "truth not flipped" is correct).

**Bottom line:** of 36, the engine structurally defends 6 and correctly defers 2; of the 28 breaches, ~24 are real under default wiring and 4 (the self-anchor high-impact trio + the tautological bond) depend on attacker-chosen gate wiring or are weak. The dominant root cause — confirmed continuous with cycle-1 — is single-source / single-class auto-resolve at default impact, plus symmetric decay with no incumbency floor and a one-hop, opt-in, caller-asserted disown-reversal machinery. The cleanest shipped-engine invariant violation is RATIFICATION-BOOTSTRAP (#24): `approve()` promotes a lie with no anchor-independent external stamp.