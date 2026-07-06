/**
 * embeddingStuffingBlend.test.ts — Phase 1b adversarial gate §3
 * (docs/specs/PHASE1B_RANKING_SPEC.md): "Embedding-stuffing test extended: attacker
 * writes M near-duplicate payloads (cosine ~1.0 to the cue). Assert in blend mode:
 * (a) the LIVE incumbent with independent provenance appears in the top-k rendered
 * results; (b) every attacker item present is labeled PROVISIONAL (or its true
 * state); (c) belief metrics (winning value by independent root count) unchanged
 * vs walk mode."
 *
 * UPDATED for Phase 1c (docs/specs/PHASE1C_RANKING_CALIBRATION_SPEC.md, "re-run all
 * gates on the frozen config"): the re-rank now uses `FROZEN_PRESENTATION_OPTIONS`
 * (`../__bench__/frozenPresentationConfig.js` — scoreMode 'rrf', k=60, wState=0.1,
 * unionTopN=128) instead of `DEFAULT_PRESENTATION_WEIGHTS`. This scenario is in fact
 * EXACTLY the check that determined the frozen scoreMode: the Phase 1c DEV-tuning
 * sweep found the ENTIRE finer linear grid (wCos in {0.8,0.9,1.0}, wWalk in
 * {0.0,...,0.3}) fails requirement (a) here — an exact-duplicate (cosine 1.0)
 * attacker cluster outranks a LIVE incumbent at a merely-strong (0.6) cosine for
 * every linear weighting in that grid — while `'rrf'` passes, which is why `'rrf'`
 * shipped as the frozen scoreMode instead of the raw highest-DEV-recall linear config
 * (see `frozenPresentationConfig.ts`'s header doc for the exact threshold math).
 *
 * This EXTENDS the existing walk-mode gate (`embedderSeedUnion.test.ts`'s
 * "adversarial embedding-stuffing (spec §5.4)") into `rankMode: 'blend'` via the
 * real Phase 1b module (`recall/presentationRank.ts`'s `rankRecallResult`), with a
 * genuine multi-value belief contest so "winning value by independent root count"
 * is a real, non-trivial computation (not just a single-value fixture):
 *
 *   - TRUE value ("Jane Doe"): 2 strands, each LIVE, each rooted in its OWN
 *     independence class — 2 genuinely independent witnesses (mirrors the crossdb
 *     Sybil scenario's H=2 honest classes).
 *   - FALSE value ("John Smith"): M=8 PROVISIONAL strands, ALL sharing ONE
 *     independence class (the attacker controls KEYS/strand count, never class
 *     assignment — same modeling choice as `crossdb/attack.ts`). Every attacker
 *     vector is set to cosine EXACTLY 1.0 against the cue — the worst-case
 *     "near-duplicate payload" stuffing attack, the strongest possible pull
 *     toward the top of a similarity-heavy presentation score.
 *
 * The walk's own lit set only ever contains the two TRUE-value witnesses (the
 * attacker cluster never won a walk seed slot in this scenario); blend mode's
 * union pulls in all 8 attacker strands purely by cosine similarity. The gate:
 * this must change PRESENTATION (the attacker cluster now appears, most of it
 * near the top by raw cosine) without ever changing BELIEF — the incumbent still
 * ranks in the top-k despite the attacker's maximal cosine, every attacker strand
 * present stays labeled PROVISIONAL, and the winning value by independence-
 * weighted root count (`identity.independentRootCount`) is identical in both
 * modes: "Jane Doe" (root count 2) beats the Sybil cluster (root count 1, since
 * all 8 attacker roots share one class and are therefore not pairwise
 * independent) — exactly as it does in walk mode, where the attacker cluster
 * isn't even a candidate.
 */

import { describe, it, expect } from "vitest";

import { FactState, asStrandId, createMemoryStore, createMemoryVectorSidecar, rankRecallResult } from "../index.js";
import type { ContentHash, EntityId, ProvenanceRoot, ProvenanceRootId, RecallResult, Strand, StrandId } from "../index.js";

import { makeStrand, makeIdentity } from "../__bench__/fixtures.js";
import { FROZEN_PRESENTATION_OPTIONS } from "../__bench__/frozenPresentationConfig.js";

function vec(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

describe("adversarial embedding-stuffing, EXTENDED to blend mode (Phase 1b spec §5 gate 3)", () => {
  it("blend mode: LIVE incumbent stays in the top-k, attacker cluster stays PROVISIONAL, winning value unchanged vs walk mode", () => {
    const store = createMemoryStore();
    const vectors = createMemoryVectorSidecar();
    const modelId = "test-model";
    const { identity } = makeIdentity();

    const entity = "entity:acme_ceo" as EntityId;
    const attribute = "acme#ceo" as never;

    // ---- TRUE value: 2 LIVE strands, 2 DISTINCT independence classes --------
    // sourceId: null (not a string) so independence is judged on the CLASS axis
    // alone (Stage-1 of identity.independentRootCount's `independent` predicate) —
    // the SAME modeling convention every other passing gate in this codebase uses
    // (crossdb/embedderSybilGateBlend.test.ts's honest/Sybil roots, etc.). A
    // non-null-but-UNREGISTERED sourceId instead routes through the anchor-
    // independence check, which fails CLOSED to "not independent" for any
    // never-`register()`-ed source regardless of distinct class — silently
    // collapsing "2 genuinely independent witnesses" to a root count of 1 (a tie
    // with the Sybil cluster's own count of 1), which happened to be masked by
    // presentation-order-dependent tie-breaking under every scoreMode tried before
    // 'rrf' exposed it. The attacker controls strand COUNT, never class assignment
    // (same convention `crossdb/attack.ts` documents) — sourceId isn't the
    // identity-bearing field this synthetic scenario is testing.
    const true1 = { ...makeStrand("true1", entity, null, "cls:true:1", { value: "Jane Doe" }, attribute) };
    const true2 = { ...makeStrand("true2", entity, null, "cls:true:2", { value: "Jane Doe" }, attribute) };
    store.putStrand(true1);
    store.putStrand(true2);
    // Moderate cosine to the cue — a genuine (non-1.0) similarity, unlike the attacker.
    vectors.put(true1.content_hash, modelId, vec(0.6, 0.8));
    // true2 intentionally carries NO vector — it is a second independent witness
    // the WALK already lit (below), not something blend's cosine union needs to
    // rediscover; belief must count it regardless of its presentation rank.

    // ---- FALSE value: M=8 PROVISIONAL strands sharing ONE independence class,
    //      every one an exact cosine-1.0 near-duplicate of the cue -----------
    const M = 8;
    const attackerIds: StrandId[] = [];
    for (let i = 0; i < M; i++) {
      const s: Strand = {
        ...makeStrand(`sybil${i}`, entity, null, "cls:sybil:SHARED", { value: "John Smith" }, attribute),
        fact_state: FactState.PROVISIONAL,
      };
      store.putStrand(s);
      vectors.put(s.content_hash, modelId, vec(1, 0)); // cosine EXACTLY 1.0 to the cue
      attackerIds.push(s.id);
    }

    const cue = vec(1, 0);

    // ---- WALK-MODE lit set: only the two TRUE-value witnesses were ever seeded
    //      (the attacker cluster never won a walk seed slot in this scenario) ---
    const baseResult: RecallResult = {
      lit: [
        { strandId: true1.id, activation: 0.9 },
        { strandId: true2.id, activation: 0.85 },
      ],
      halt: { reason: "CONVERGED", popCount: 2, bridgesCrossed: 0, bridgeSeedsDownweighted: 0, degraded: false } as never,
      unresolvedSeeds: [],
      seedsResolved: 2,
    };

    // ---- Belief metric: winning value by independence-weighted root count,
    //      grouped the SAME way the crossdb Sybil gates do (over whichever
    //      strands are present in a given mode's lit set). --------------------
    function winningValueOf(lit: RecallResult["lit"]): string | null {
      // Group by value in a CANONICAL (strandId-sorted) order, never `lit`'s own
      // presentation order — belief must not depend on presentation rank, and
      // a tie in independentRootCount must not silently pick whichever value's
      // Map entry a given mode's ordering happened to insert first (the thesis
      // invariant this gate exists to prove, applied to the TEST HELPER too).
      const sorted = [...lit].sort((a, b) => (String(a.strandId) < String(b.strandId) ? -1 : 1));
      const rootsByValue = new Map<string, ProvenanceRoot[]>();
      for (const l of sorted) {
        const strand = store.getStrand(l.strandId);
        if (strand === null) continue;
        const value = (strand.payload as { value: string }).value;
        const arr = rootsByValue.get(value) ?? [];
        arr.push(...strand.provenance);
        rootsByValue.set(value, arr);
      }
      let winner: string | null = null;
      let bestScore = -1;
      for (const [value, roots] of rootsByValue) {
        const score = identity.independentRootCount(roots);
        if (score > bestScore) {
          bestScore = score;
          winner = value;
        }
      }
      return winner;
    }

    const winnerWalk = winningValueOf(baseResult.lit);
    expect(winnerWalk).toBe("Jane Doe"); // sanity: the attacker isn't even a candidate yet

    // ---- BLEND MODE: union in the attacker cluster via cosine, re-rank -------
    const blended = rankRecallResult(store, baseResult, { vectors, modelId, cueVector: cue }, FROZEN_PRESENTATION_OPTIONS);

    const blendedIds = blended.lit.map((l) => String(l.strandId));
    // The attacker cluster IS now present (union pulled in every cosine-1.0 match).
    for (const id of attackerIds) expect(blendedIds).toContain(String(id));

    // (a) the LIVE incumbent (true1) appears in the top-k rendered results,
    //     despite the attacker's maximal (1.0) cosine advantage — the presentation
    //     score's wWalk/wState terms keep it from being crowded out.
    const TOP_K = 5;
    const topK = blended.lit.slice(0, TOP_K).map((l) => String(l.strandId));
    expect(topK).toContain(String(true1.id));

    // (b) every attacker item present in the blended results is labeled
    //     PROVISIONAL (its true fact_state) — never silently promoted by cosine.
    for (const l of blended.lit) {
      if (attackerIds.some((a) => String(a) === String(l.strandId))) {
        const strand = store.getStrand(l.strandId);
        expect(strand?.fact_state).toBe(FactState.PROVISIONAL);
      }
    }

    // (c) belief metric (winning value by independent root count) UNCHANGED
    //     vs walk mode — the Sybil cluster's shared-class flood never outranks
    //     the true value's 2 genuinely independent witnesses.
    const winnerBlend = winningValueOf(blended.lit);
    expect(winnerBlend).toBe(winnerWalk);
    expect(winnerBlend).toBe("Jane Doe");

    void asStrandId; // referenced for type-consistency; no-op
  });
});
