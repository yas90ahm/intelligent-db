REPORT A then the delimiter then REPORT B follow. Both are returned verbatim below for the orchestrator to persist.

# Cycle-3 (final tier)

## Defense profile
Real-engine, 36 specs, classified from post-call store state (BREACHED ≡ `falseLive && trueDemoted` after a real `adjudicate()`/`recall()`/`disown()`; not hardcoded). Verifier re-ran `REDTEAM=1 vitest` live; all 36 outcomes byte-identical to the committed `results.json`.

- total = 36 · defended = 11 · breached = 25 · deferred = 0 · na = 0
- DEFENDED (11): cc-c3-06, al-c3-06, ce-c3-04, ce-c3-05, ce-c3-06, fp-6, pt-1, pt-5, mk-m1, mk-m6, mk-coverage
- BREACHED (25): cc-c3-01..05, al-c3-01..05, ce-c3-01..03, fp-1..5, pt-2, pt-3, pt-4, mk-m2, mk-m3, mk-m4, mk-m5

Cycle 3 deliberately mixes three things under one count: (a) genuine novel combined/adaptive attacks (cc/al/ce/pt families), (b) FIX-PROBE specs that are *designed* to breach-today and then demonstrate a candidate fix, and (c) merkle CONFIRM specs that assert the crypto core holds. So "25 breached" overstates the raw threat surface — ~10 of the breaches are fix-probe targets the harness raises specifically to measure a fix, and the merkle breaches (m2–m5) are boundary/wiring breaks, not proof breaks. The honest read: the cryptographic core and the MIS-collapse core HELD; the soft trust periphery (global reputation, symmetric decay, disown one-hop reversal, identity-blind bridge sweep, class-vs-root gate) is where every real breach lands.

## Breach catalogue (mechanism, all real engine state)
Combined/chained (cc):
- cc-c3-01 Rep-farm → class-stacked silent flip: high-impact gate counts anchor CLASSES not independent ROOTS; farmed global LCB 0.407 + incumbent decayed to 0.040 (gap 0.366) → irreversible RESOLVED, no horn. (Caveat: depends on the integrator wiring `anchorClassCountOf` to count classes — see caveats.)
- cc-c3-02 Key-rotation whitewash: disown craters the KEY; rebinding the same DOMAIN under a fresh key re-enters LCB 0, un-cratered, full independence weight.
- cc-c3-03 Transient-bond harvest: corroboration α baked at WRITE time (permanent), independence priced at READ time; bond withdrawal is not a disown trigger → no `reverseCredit` ever runs, α stays 2.000.
- cc-c3-04 (fix-probe) Multi-hop clawback: second-order A→B→E credit survives one-hop reversal (E α unchanged; today reverses only `corrob:0`).
- cc-c3-05 (fix-probe) Bridgehead-beacon: identity-blind Phase-2 sweep crosses a bare-key (indep 0) bridge at constant γ; poison surfaces on recall.

Adaptive-LCB (al):
- al-c3-01 Straddle-defer DoS: 200 cross-class straddles → real `listPending` depth 200, 0 demotions (the DEFER itself is the payload; no rate-limit/stake/dedup on the horn).
- al-c3-02 Amortized global flip: build LCB ~0.40 once, flip 50 distinct attributes at $0 marginal (global attribute-agnostic rep, no incumbency floor).
- al-c3-03 Dormancy-decay trough: pure decay-on-read is a free side-effect-free oracle; poll `scoreOf` until incumbent decays 0.60→0.06, strike with fresh 0.40.
- al-c3-04 / al-c3-05 (fix-probes): tenured-incumbent flat-margin flip; global-rep un-earned-attribute flip — both RESOLVE today.

Class-assignment E2E (ce):
- ce-c3-01 Registrar carousel: K distinct registrar×ASN DOMAIN classes → MIS = K, one-hop disown leaves the bloc standing. (Breach criterion is `rootCount≥K && survives`; the adjudicate itself honestly DEFERRED — this demonstrates the documented offline-class-assignment gap, not a flip.)
- ce-c3-02 Subdomain seam: sub1..subK.evilcorp.com → MIS = K (no PSL eTLD+1 boundary).
- ce-c3-03 Null-source laundromat: class-reweighted bare-key agreement + 2-hop credit survives disown.

Fix-probe targets (fp):
- fp-1 Two-class costume (self-stacked EMAIL+DOMAIN) clears the CLASS-count high-impact gate → RESOLVED.
- fp-2 Self-built decisive overturn (0 external corroboration) RESOLVES.
- fp-3 Cross-domain halo: global LCB 0.589 flips a security attribute.
- fp-4 1v1 out-earn RESOLVES.
- fp-5 Bridgehead-beacon (identity-blind sweep) — duplicate of cc-c3-05 in the fp family.

Provenance-tipping (pt):
- pt-2 Tainted-closure gap: derived strand D demoted but B's credit (event names D) not reversed — disown intersects only the DIRECT seed, not the demoted closure.
- pt-3 Multi-hop laundering: C's hop-2 credit (corroborates B's independently-observed SB) survives disown(A); credit attribution is intransitive while existence-taint is transitive.
- pt-4 Misattributed corroborator: B names a decoy clean strand; disown reverses nothing yet reconcile balances.

Merkle (mk) — boundary breaches, not crypto breaks:
- mk-m2 Keyholder forge-from-genesis: single-signer (log==audit==operator) + operator-owned sinks → forged coherent tree, `verifyChain.ok=true`, `detectSplitView=false`, zero detection.
- mk-m3 Hide-a-disown: disown/demotion/OUTRANKS/reputation are mutable store rows OUTSIDE the STH commitment; a demotion restored to LIVE leaves verifyChain/witness clean.
- mk-m4 Pre-anchor / un-wired tail: `createIntelligentDb` instantiates no MerkleLog → the whole live chain is an unanchored, rewritable tail.
- mk-m5 Split-view with no collector: `detectSplitView` is sound but no wired path calls it across sinks; two lineages each `witness()` OK in isolation.

## FIX-PROBE results table
"breaches today" is in every case a real engine run; the fix is either a real re-run (simulated:false / real adjudicate) or a simulation built on real engine primitives (MIS, reputation values, corroboration-event graph).

| Fix | Target attack | Breaches today | Outcome | Cost / how |
|---|---|---|---|---|
| fp-1 anchorClassCountOf := independentRootCount (MIS) | Two-class costume | yes | **CLOSES** | low — one wiring change; root-count resolver → DEFER (real re-run). Legit 2-operator winner still resolves. |
| al-c3-05 attribute-scoped corrob + ROOT-count floor | amortized global flip + FP1 | yes | **CLOSES** amortization | medium — adds (source,attr) scoping; MIS root-count=1 collapses self-corroboration. 2 paid disjoint roots still clear (priced residual). |
| pt-2 pass taintedStrandIds (full demoted closure) | derived-corroborator gap | yes | **CLOSES** this hop | trivial — one-line; reverses B over closure {S,D}. Does not close pt-3. |
| pt-4 engine-derive corroborators + drop no-name exemption | misattribution / unnamed witness | yes | **CLOSES** | medium — engine emits the agreement event mechanically; genuinely-independent ratify stays non-reversible by design. |
| fp-6 RFC-6962 confirm | history-rewrite / split-view | no | **CLOSES**/holds | zero code — layer already holds given ≥2 independent sinks. |
| cc-c3-04 transitive BFS clawback over corrob graph | second-order launder (A→B→E) | yes | PARTIAL | medium — BFS reverses E, spares independent F; cannot reach UN-logged agreement (pair with mandatory event recording). |
| cc-c3-05 / fp-5 soft γ gate on bridge sweep | bridgehead-beacon | yes | PARTIAL | low — seed = γ·provenance_independence; poison seed 0.000 dropped, insight 0.210 crosses. Reasoned arithmetic; patient attacker earns far-side priority (priced). |
| al-c3-04 incumbency-scaled decisive margin | amortized / dormancy flip | yes | PARTIAL | medium — required 0.655 > gap 0.314 → DEFER; re-introduces first-arrival trap + leaves fresh-true incumbents exposed. Not structural. |
| fp-2 universal ≥2-independent-corrob precondition | self-built overturn | yes | PARTIAL | medium — MIS=1 → DEFER; patient attacker buys 2 real corroborations; scope to multi-class only (else human-fatigue bomb). |
| fp-3 per-(source, attribute-domain) reputation | cross-domain halo | yes | PARTIAL | high — closes halo (scoped LCB 0 → DEFER) but adds offline domain-taxonomy liability + N×M state; reasoned, not measured (engine has no per-domain rep today). |
| ce-c3-04 PSL eTLD+1 collapse at bind time | subdomain seam | yes | PARTIAL | low — seam → 1, github.io PRIVATE preserved → 2; carousel untouched (count 5). Hygiene, not structural. |
| ce-c3-05 root-count + operator-graph fleet-cap | registrar carousel | yes | PARTIAL | medium — correlated carousel → 1; correlation-free carousel still mints K (hard-theorem residual). |
| pt-1 distinct-root denominator / exact α-recompute | contributor padding | **no (engine already defends)** | PARTIAL | engine derives contributingStrandIds = winner+same-source (pads self-taint); proportional model is the only residual. |
| mk-m6 external witness + journaling (F-A..F-D) | m2/m3/m4/m5 | yes | PARTIAL | operational — independent prior STH catches the forged shorter tree (`ROLLBACK_OR_DELETION`); F-C journaling closes m3; irreducible trust-root cost like TLS/CAs. |
| fp-4 defer ALL 1v1 disputes | 1v1 out-earn | yes | **FAILS** (REJECT) | net-negative — defers but re-opens DoS at linear cost, routes every legit binary correction to a human, and is evaded by one self-stacked 2v1 co-asserter. |

## Merkle-audit verdict
The cryptographic core HELD. All seven CONFIRM specs pass against the real layer (mk-m1, cc-c3-06, al-c3-06, ce-c3-06, fp-6, mk-m6, mk-coverage): byte-flip → `verifyChain` names the first broken seq (seq 3/5/1234/2 across probes); rollback/deletion → `ROLLBACK_OR_DELETION`; split-view → `SAME_SIZE_DIFFERENT_ROOT` / `NON_MONOTONIC`; key rotation cannot manufacture an extension proof (`PRIOR_STH_BAD_SIG`, forgery rejected regardless of signing key); detection holds under a 4096-leaf mass-DEFER flood with inclusion proofs staying O(log n); forged-class adjudications are immutably auditable. The four merkle BREACHES (m2/m3/m4/m5) are boundary/coverage/wiring breaks — single-signer key model, mutable state outside the commitment, un-wired anchor (`createIntelligentDb` wires no MerkleLog), and an absent cross-sink collector — exactly the operational residuals already enumerated in CLAUDE.md's GAP LIST, not a break of the proof. mk-coverage additionally confirms the corroboration/adjudication/weak-influence credit ledgers sit OUTSIDE the STH boundary (no prevHash chain, no Ed25519 sig, no Merkle leaf), so a silently-skipped reversal (pt-4) is invisible to all tamper-evidence — a sound detector of TAMPERING, not of a correctly-logged illegitimate credit state.

## Verifier caveats folded in
1. cc-c3-01 and fp-1 "breach today" depend on the high-impact gate being wired to count anchor CLASSES (`selfAnchorHighImpact`). The engine takes `anchorClassCountOf` as a caller-supplied callback; the harness's own default counts ROOTS (which DEFENDS). These are real breaches of a plausible/naive integrator wiring that literally matches CLAUDE.md's "≥2 disjoint anchor classes" phrasing — a legitimate spec-ambiguity finding, fix demonstrated by real re-run. The shipped resolver is not itself defective; the breach is interpretation-dependent.
2. mk-m4's breach predicate `!engineHasMerkle` checks `"anchor" in Harness.prototype` (tautologically false), so part of the predicate is trivially true — but the underlying claim (`createIntelligentDb` wires no MerkleLog) is true and documented, and the windowed-tail half is real.
3. Several fix sims (fp-2/fp-3 attribute-scoped halves, al-c3-05 scoped corrob) hardcode a correct-by-construction zero (per-domain/per-attribute rep the engine does not track yet) rather than measuring it. Legitimate and labeled `simulated:true`/PARTIAL throughout; the only fixes that CLOSE on a measured premise are those where the real MIS does the work (fp-1, al-c3-05 root-count, pt-2 closure).