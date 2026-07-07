/**
 * identity/index.ts — THE SOURCE-IDENTITY LAYER's PUBLIC FACADE.
 *
 * This is "passport control at the border of the memory" (CLAUDE.md §"Source-
 * Identity Layer"). The web stops GUESSING whether two sources are independent and
 * ASKS this layer instead. For every incoming OBSERVED fact the layer emits a
 * stamp the web consumes:
 *
 *     { source_id, anchor_set, anchor_cost, reputation, stake_posted }
 *
 * and the two quantities the web is forbidden to compute about itself —
 *   - `provenance_independence` (the per-edge halting weight), and
 *   - the independent-root count used by the forgetting layer
 * — are READ FROM HERE rather than self-computed.
 *
 * This facade is deliberately MECHANICAL: it composes the pillars (source
 * registry, anchors, reputation) into one stamp. It performs no judgement of
 * its own. That honors both governing invariants (CLAUDE.md §"The two
 * governing invariants"):
 *   1. The model is never its own witness — this layer is registries/anchors/
 *      scores, never the model.
 *   2. The web is never its own witness about source identity — identity is
 *      witnessed from OUTSIDE the web, by this layer (consumed from the
 *      deployment's configured trust root, never manufactured here).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Module boundary note: the pillar modules referenced below (identity/sources,
 * identity/trustRegistry, identity/anchors, identity/reputation) are
 * dependencies of this facade. They are injected via {@link createSourceIdentityLayer}'s
 * `deps` argument as PORTS — the minimal collaborator contracts this facade
 * needs — so that the facade composes them without importing their concrete
 * implementations. Each port below documents the sibling module it stands in for.
 * Only `core/types.ts` (the shared contract) and the plain {@link SourceRef}
 * shape (identity/sources) are imported directly.
 *
 * STAKE, RETIRED: the security-deposit pillar is retired as a feature —
 * ATTRIBUTION replaces stake (facts are permanently attributed to named
 * sources; that IS the deterrent). The {@link StakeLedgerPort} survives only so
 * the stamp's shape (`stake_posted: 0`) is unchanged; it defaults to a
 * constant-zero port and no producer posts to it.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type {
  SourceId,
  AnchorBinding,
  IdentityStamp,
  ProvenanceRoot,
  IndependenceClassId,
  Unit,
} from "../core/types.js";
// The SAMENESS pillar's public contract (pillar 1, crypto-free): a plain,
// serializable source descriptor whose deterministic id proves sameness (same
// issuer+subject ⇒ same source ⇒ never corroboration). Its home is
// identity/sources.ts; this facade depends only on its shape. Re-exported
// below for callers of `register`.
import type { SourceRef } from "./sources.js";

export type { SourceRef };

// ---------------------------------------------------------------------------
// Collaborator PORTS (the pillars, injected — see module boundary note)
// ---------------------------------------------------------------------------

/**
 * Port for the SAMENESS pillar (pillar 1) — the source registry side of
 * identity/trustRegistry.ts. Proves SAMENESS: same source id ⇒ same source ⇒
 * never corroboration. Cheap to mint (any issuer+subject pair), so necessary
 * but not sufficient for independence.
 */
export interface SourceRegistryPort {
  /** Record a source at the border (idempotent on `source.sourceId`). */
  register(source: SourceRef): void;
  /** The {@link SourceId} for a source, if registered. */
  sourceIdOf(sourceId: SourceId): SourceId | null;
  /** Whether this source is registered (has shown ID at the door). */
  has(sourceId: SourceId): boolean;
}

/**
 * Port for identity/anchors.ts — the ANCHOR pillar (CLAUDE.md pillar 2:
 * "independence measured against scarce external roots, never declared").
 * Independence between two sources is DISJOINTNESS of their anchor sets weighted
 * by anchor cost; this port owns that pairwise computation and the anchor-cost
 * aggregation, so the facade never reimplements the anchor-cost table.
 */
export interface AnchorRegistryPort {
  /** Bind a source to its anchor set (additive; the layer never declares independence). */
  bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void;
  /** The recorded anchor set for a source (empty ⇒ bare anonymous input). */
  anchorsOf(sourceId: SourceId): readonly AnchorBinding[];
  /**
   * Aggregate (SUBLINEAR) anchor cost for one source — the "price" of its
   * identity. Sublinear so a source can't self-stack ten cheap anchors to fake
   * one expensive one (CLAUDE.md "Rules for the table").
   */
  aggregateCost(anchors: readonly AnchorBinding[]): Unit;
  /**
   * Independence in [0,1] between two anchor SETS = cost-weighted disjointness.
   * Two sets sharing any anchor are not independent on that anchor; independence
   * is driven by their non-overlapping costly anchors (CLAUDE.md pillar 2).
   */
  independenceBetween(
    a: readonly AnchorBinding[],
    b: readonly AnchorBinding[],
  ): Unit;
  /**
   * OPTIONAL source-aware independence predicate. When present, {@link
   * SourceIdentityLayer.independentRootCount} PREFERS this over the list-based
   * {@link independenceBetween} for any pair of resolvable sources, because the
   * list form cannot see two distinguishing axes a real registry owns:
   *   - the per-anchor `classId` (eTLD+1 / normalized address) — so two DOMAIN
   *     sources with DIFFERENT domains are independent (the list form would
   *     collapse them, since they share the `DOMAIN` anchor CLASS); and
   *   - the `operatorClassId` FLEET axis — so two DOMAIN sources behind the SAME
   *     registrar/ASN are NOT independent even with different domains (the
   *     fleet cap; ARCHITECTURE.md §1).
   * Returns `true` iff sources `a` and `b` are mutually independent. A registry
   * that omits this falls back to the list-based path (back-compatible).
   */
  independentSources?(a: SourceId, b: SourceId): boolean;
}

/**
 * Port for identity/reputation.ts — the CREDIT-SCORE pillar (CLAUDE.md pillar 3:
 * "earned slowly, lost fast"). Weight comes from track record, not headcount;
 * ceilinged by the `rep_cap` of a source's anchors. Kills the contradiction-bomb
 * (500 fresh sources start near-zero) and the first-arrival trap.
 */
export interface ReputationLedgerPort {
  /**
   * Current reputation in [0,1] for a source, already ceilinged by the rep_caps
   * of its anchor set. A source with no track record returns its floor (~0).
   */
  scoreOf(sourceId: SourceId): Unit;
}

/**
 * RETIRED pillar port, kept for stamp-shape stability only. Staking is retired
 * as a feature — ATTRIBUTION replaces stake (facts are permanently attributed
 * to named sources; the disown sweep is the clawback). This port survives so
 * `IdentityStamp.stake_posted` keeps its shape (constant 0 by default); no
 * producer posts to it. Omit it from the deps for the zero default.
 */
export interface StakeLedgerPort {
  /** Total stake currently posted backing this source's assertions (0 today). */
  postedFor(sourceId: SourceId): number;
}

/** The constant-zero {@link StakeLedgerPort} default (stake is retired). */
export const ZERO_STAKE_PORT: StakeLedgerPort = {
  postedFor(_sourceId: SourceId): number {
    return 0;
  },
};

// ---------------------------------------------------------------------------
// Facade dependencies
// ---------------------------------------------------------------------------

/**
 * The wiring `createSourceIdentityLayer` needs: one port per pillar. These are
 * the source registry + anchors + reputation ledgers/maps composed into the
 * stamp. The crypto-free trust registry (identity/trustRegistry.ts) satisfies
 * BOTH `sources` and `anchors` — wire ONE instance into both so sameness and
 * independence read from the same book.
 */
export interface SourceIdentityLayerDeps {
  readonly sources: SourceRegistryPort;
  readonly anchors: AnchorRegistryPort;
  readonly reputation: ReputationLedgerPort;
  /** RETIRED pillar; omit for the constant-zero default ({@link ZERO_STAKE_PORT}). */
  readonly stake?: StakeLedgerPort;
  /**
   * OPTIONAL note hook fired when {@link SourceIdentityLayer.independentRootCount}
   * falls back from the EXACT maximum-independent-set to the bounded GREEDY
   * approximation because the root set is too large (`rootCount > exactThreshold`).
   * The fallback may UNDERCOUNT independence (the contradiction-bomb-safe
   * direction) and never hangs. Wire this to the host's logging if observability
   * of the cap matters; omit it (default) for a silent fallback. Never throws.
   */
  readonly onLargeRootSetCap?: (rootCount: number, exactThreshold: number) => void;
}

/**
 * Maximum root-set size for which {@link SourceIdentityLayer.independentRootCount}
 * computes the EXACT maximum-independent-set (max clique in the "independent"
 * graph). At or below this, Bron–Kerbosch with pivoting runs over a single-word
 * (≤31-bit) bitmask per vertex and terminates quickly; above it the method falls
 * back to the deterministic greedy maximal set so it can never hang. Kept ≤31 so
 * the `1 << j` vertex bits stay within a safe 32-bit integer mask.
 */
export const MAX_EXACT_ROOTS = 18;

// ---------------------------------------------------------------------------
// Public facade interface
// ---------------------------------------------------------------------------

/**
 * The Source-Identity Layer the web asks instead of guessing. Mechanical: it
 * assembles facts about source identity that originate OUTSIDE the web; it never
 * adjudicates claims and the model never witnesses through it.
 */
export interface SourceIdentityLayer {
  /**
   * Build the {@link IdentityStamp} the web consumes for an OBSERVED fact from
   * `sourceId`. The stamp's fields mirror CLAUDE.md exactly:
   *   { source_id, anchor_set, anchor_cost, reputation, stake_posted }.
   *
   * Pure composition over the four pillar ports; no side effects. A source that
   * has never registered still yields a well-formed BARE-KEY-equivalent stamp
   * (empty anchor set ⇒ zero cost ⇒ floor reputation ⇒ zero stake), so the web
   * always gets an answer rather than guessing.
   */
  stampFor(sourceId: SourceId): IdentityStamp;

  /**
   * Register a source at the border: record its {@link SourceRef} (sameness)
   * and bind its anchor set (independence roots). Idempotent per source;
   * binding is additive. This is the "shows ID at the door" step before a
   * source counts as a distinct witness. (The trust registry's claim producers
   * — registerOwner / registerSsoMember / registerPublisher /
   * registerSystemOfRecord — are the primary path; this generic form serves
   * manual/legacy wiring.)
   */
  register(source: SourceRef, anchors: AnchorBinding[]): void;

  /**
   * The INDEPENDENT-ROOT COUNT the forgetting layer reads from this layer instead
   * of self-computing (CLAUDE.md §"Interface to the web"). Given a strand's
   * provenance root-set, count how many MUTUALLY-INDEPENDENT roots it really
   * represents.
   *
   * Two roots collapse to one when they are NOT independent — i.e. they share an
   * independence class (offline-assigned, see {@link ProvenanceRoot.independenceClass})
   * OR the anchor sets behind their sources fail `anchors.independenceBetween`
   * disjointness. Same-root floods therefore collapse to multiplicity 1
   * (CLAUDE.md §"Resolved floor: forgetting"), and the count is the number of
   * disjoint independence classes, never the raw root headcount.
   */
  independentRootCount(rootSet: readonly ProvenanceRoot[]): number;

  /**
   * RC-5 — true MIS anchor-independence between two SOURCES (not a mere distinct
   * key). Reproduces the pair logic {@link independentRootCount}'s internal
   * `independent` predicate uses, at the source level, EXCEPT for unregistered
   * sources (see below):
   *   - if EITHER source is unresolvable (never `register()`-ed) ⇒ FAIL CLOSED to
   *     `false`. This is NOT the same situation as `independentRootCount`'s
   *     null-source fallback (a provenance root that recorded no sourceId at all
   *     — genuinely no identity to speak of, judged on the Stage-1 class check
   *     alone). Here the sourceId exists but was never registered, i.e. it never
   *     bound an anchor — that is exactly a BARE_KEY (independence_weight 0.00
   *     per the anchor-cost table), and a BARE_KEY can never be independent of
   *     anything (mirrors the trust registry's matching fail-closed
   *     empty-claim-set case). Treating "unregistered" as "trivially
   *     independent" would let a caller-supplied, never-registered `SourceId`
   *     (e.g. via `WriteFactInput.stamp`/`SourceRef`) pass RC-5's distinct-
   *     approver / anchor-disjointness gate for free;
   *   - else PREFER the registry's source-aware `anchors.independentSources`
   *     (it sees per-anchor `classId` + the `operatorClassId` fleet axis), else
   *     fall back to `anchors.independenceBetween(...) > 0`.
   * Surfacing it here keeps ONE independence notion (anti-drift): the approve-gate
   * (RC-5) and the forgetting count read the SAME predicate.
   */
  independentSources(a: SourceId, b: SourceId): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire the pillar ledgers/maps (source registry + anchors + reputation) into a
 * {@link SourceIdentityLayer}. Pure dependency injection: the concrete backends
 * live in identity/trustRegistry, identity/anchors, identity/reputation and are
 * passed in via `deps`, keeping this facade mechanical and swappable (the
 * registry config + anchor table are "one swappable trust root"). The retired
 * stake port defaults to constant zero.
 */
export function createSourceIdentityLayer(
  deps: SourceIdentityLayerDeps,
): SourceIdentityLayer {
  const { sources, anchors, reputation } = deps;
  const stake = deps.stake ?? ZERO_STAKE_PORT;

  return {
    register(source: SourceRef, anchorBindings: AnchorBinding[]): void {
      // 1. Sameness: record the source descriptor (idempotent on its id).
      sources.register(source);
      // 2. Anchors: bind the scarce external roots that price independence.
      anchors.bind(source.sourceId, anchorBindings);
    },

    stampFor(sourceId: SourceId): IdentityStamp {
      // Mechanical composition — read each pillar and assemble the stamp shape
      // the web consumes. No judgement, no model.
      const anchor_set = anchors.anchorsOf(sourceId);
      const anchor_cost = anchors.aggregateCost(anchor_set);
      const reputationScore = reputation.scoreOf(sourceId);
      const stake_posted = stake.postedFor(sourceId);

      const stamp: IdentityStamp = {
        source_id: sourceId,
        anchor_set,
        anchor_cost,
        reputation: reputationScore,
        stake_posted,
      };
      return stamp;
    },

    independentRootCount(rootSet: readonly ProvenanceRoot[]): number {
      // ─────────────────────────────────────────────────────────────────────
      // STAGE 1 (SIMPLE — implemented): collapse by offline-assigned
      // independence class. Two roots in the same class corroborate nothing
      // (CLAUDE.md: "incremental ancestor-sketch over offline-assigned
      // independence-class ids"), so the count can never exceed the number of
      // DISTINCT independence classes present. This alone makes same-root /
      // same-class floods collapse to multiplicity 1.
      // ─────────────────────────────────────────────────────────────────────
      const classes = new Set<IndependenceClassId>();
      for (const root of rootSet) {
        classes.add(root.independenceClass);
      }
      const distinctClassCount = classes.size;

      // ─────────────────────────────────────────────────────────────────────
      // STAGE 2 (cross-source anchor-disjointness): two roots in DIFFERENT
      // independence classes may STILL fail to be mutually independent once their
      // sources' ANCHOR SETS are examined (e.g. many domains behind one org, or a
      // flood of sources that all share an anchor CLASS). Stage 1 alone would count
      // such a fake-independence flood as many independent roots ⇒ it looks heavily
      // corroborated ⇒ its strands become un-prunable (the contradiction-bomb).
      // Stage 2 COLLAPSES roots whose sources are not anchor-independent so the
      // flood collapses to its TRUE count (≈1) and those strands stay eviction-
      // eligible. The count can NEVER exceed the Stage-1 distinct-class bound.
      //
      // ALGORITHM — deterministic EXACT MAXIMUM-INDEPENDENT-SET:
      //   - Sort roots by their unique `rootId` (a total order ⇒ deterministic;
      //     `independenceClass` is NOT unique, so it is a poor sort key).
      //   - Build the symmetric "independent" graph over the ordered roots:
      //     adj[i][j] = independent(orderedᵢ, orderedⱼ). The answer we want is the
      //     size of the LARGEST set of PAIRWISE-INDEPENDENT roots — i.e. the
      //     MAXIMUM CLIQUE in this "independent" graph (equivalently the maximum
      //     independent set in its complement, the "correlated" graph).
      //   - For small root sets (n ≤ MAX_EXACT_ROOTS) compute the maximum EXACTLY
      //     via recursive Bron–Kerbosch with pivoting (branch in sorted index
      //     order ⇒ deterministic), so a transitivity ordering can NEVER
      //     undercount: A~B, B~C, A⊥C returns {A,C}=2 in EVERY ordering, not the
      //     ordering-dependent greedy 1.
      //   - For LARGE root sets (n > MAX_EXACT_ROOTS) FALL BACK to the original
      //     deterministic greedy maximal-independent-set so the method can never
      //     hang on a pathological input. Greedy finds a MAXIMAL (not MAXIMUM)
      //     set, so the fallback may undercount by the same bounded amount the
      //     exact path fixes — the SAFE direction for the contradiction-bomb
      //     (never OVER-counts independence), and bounded by the recoverable
      //     archive + the other eviction gates. The cap is noted via `onCapNote`.
      //   - Return Math.min(distinctClassCount, maxSetSize): the Stage-1 class
      //     bound is an UPPER CLAMP the count never exceeds.
      //
      // independent(a, b) :=
      //   (a.independenceClass !== b.independenceClass)   // Stage-1 condition kept;
      //                                                   // same class ⇒ echo, and
      //                                                   // this short-circuits
      //                                                   // before any anchor lookup
      //   AND
      //   ( (a.sourceId !== null && b.sourceId !== null)
      //       ? anchors.independenceBetween(
      //           anchorsOf(a.sourceId), anchorsOf(b.sourceId)) > THRESHOLD
      //       : true )                                    // NULL-SOURCE FALLBACK
      //
      // NULL-SOURCE FALLBACK: a root with `sourceId === null` is bare/anonymous —
      // the layer can resolve NO anchor set for it, so there is NO positive
      // evidence of correlation. Independence is only ever DOWNGRADED on POSITIVE
      // correlation evidence (a resolvable, anchor-correlated pair), so such a pair
      // is judged on the Stage-1 class check alone (which already passed to reach
      // here). This is exactly what preserves the existing test's two-distinct-
      // class/null-source case at count 2, and is fail-SAFE for the eviction gate:
      // a null source never manufactures a spurious collapse (never under-reports
      // independence), so it can never license an over-eager eviction.
      //
      // THRESHOLD = 0 with strict `>`: `anchors.independenceBetween` returns
      // EXACTLY 0 for a pure echo / shared anchor CLASS (identity/anchors.ts:
      // shared classes are filtered out, and the empty disjoint side yields
      // combineSublinear([]) = 0, with Math.min pinning the pair to 0), and a
      // POSITIVE value only when the two sources have mutually-disjoint costly
      // anchors. So `> 0` collapses precisely the echo cases and keeps anything
      // with genuine disjoint backing. 0 is produced exactly (no float fuzz at the
      // boundary), so the strict comparison is safe.
      // ─────────────────────────────────────────────────────────────────────
      const INDEPENDENCE_THRESHOLD = 0;

      // Per-call memo of anchor lookups (a source may back multiple roots; this
      // avoids redundant port calls and is local so the method stays stateless
      // across calls).
      const anchorCache = new Map<SourceId, readonly AnchorBinding[]>();
      const anchorsOf = (sourceId: SourceId): readonly AnchorBinding[] => {
        let bound = anchorCache.get(sourceId);
        if (bound === undefined) {
          bound = anchors.anchorsOf(sourceId);
          anchorCache.set(sourceId, bound);
        }
        return bound;
      };

      const independent = (a: ProvenanceRoot, b: ProvenanceRoot): boolean => {
        // Stage-1 condition FIRST: same class ⇒ never independent (echo). Short-
        // circuits before any anchor lookup, so same-class null-source roots never
        // touch the anchor port.
        if (a.independenceClass === b.independenceClass) return false;
        // Only DOWNGRADE on POSITIVE correlation evidence: consult anchors only
        // when BOTH sources are resolvable; otherwise fall back to the (passed)
        // class-disjoint verdict. The `&&` guard guarantees anchorsOf is reached
        // only with non-null SourceIds (strict-null safe).
        if (a.sourceId !== null && b.sourceId !== null) {
          // PREFER the registry's source-aware predicate when it exposes one: it
          // sees the per-anchor `classId` and the `operatorClassId` FLEET axis the
          // list-based form cannot (so different-domain DOMAIN sources are
          // independent, but a same-registrar fleet collapses). Fall back to the
          // anchor-set disjointness math otherwise (back-compatible with mocks).
          if (anchors.independentSources !== undefined) {
            return anchors.independentSources(a.sourceId, b.sourceId);
          }
          return (
            anchors.independenceBetween(
              anchorsOf(a.sourceId),
              anchorsOf(b.sourceId),
            ) > INDEPENDENCE_THRESHOLD
          );
        }
        return true;
      };

      // Deterministic order: sort by the unique rootId. Copy first (rootSet is
      // readonly).
      const ordered = [...rootSet].sort((a, b) =>
        a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0,
      );
      const n = ordered.length;

      // Trivial fast paths (also keeps the exact recursion off empty/singletons).
      if (n === 0) return 0;
      if (n === 1) return Math.min(distinctClassCount, 1);

      let maxSetSize: number;
      if (n <= MAX_EXACT_ROOTS) {
        // ─── EXACT PATH: maximum clique in the "independent" graph ───────────
        // Precompute the symmetric adjacency as bitmasks (n ≤ MAX_EXACT_ROOTS,
        // i.e. ≤ 18, so a single number bitmask per vertex is exact and fast). adj[i]
        // has bit j set iff orderedᵢ and orderedⱼ are INDEPENDENT. Each predicate
        // is evaluated once per unordered pair; `independent` is symmetric.
        const adj: number[] = new Array<number>(n).fill(0);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            if (independent(ordered[i]!, ordered[j]!)) {
              adj[i] = adj[i]! | (1 << j);
              adj[j] = adj[j]! | (1 << i);
            }
          }
        }

        // Bron–Kerbosch with pivoting, tracking only the LARGEST clique size.
        // R = current clique (bitmask), P = candidates extendable into R, X =
        // already-processed. Deterministic: candidate vertices are visited in
        // ascending index order. n ≤ MAX_EXACT_ROOTS (18) here ⇒ `(1 << n) - 1`
        // never needs the n===31 overflow special-case a bare `1 << j` bitmask
        // would require at the true 31-bit ceiling this scheme supports (this
        // branch is only ever entered for n ≤ 18, well under that ceiling) —
        // bounded recursion, never hangs.
        const ALL = (1 << n) - 1;
        let best = 0;

        const popcount = (m: number): number => {
          let c = 0;
          let v = m;
          while (v !== 0) {
            v &= v - 1;
            c++;
          }
          return c;
        };

        const lowestSetIndex = (m: number): number => {
          // m known non-zero.
          let idx = 0;
          let v = m;
          while ((v & 1) === 0) {
            v >>= 1;
            idx++;
          }
          return idx;
        };

        const expand = (rSize: number, pMask: number, xMask: number): void => {
          if (pMask === 0 && xMask === 0) {
            if (rSize > best) best = rSize;
            return;
          }
          // Bound: even taking every remaining candidate can't beat `best`.
          if (rSize + popcount(pMask) <= best) return;

          // Choose a pivot u from P ∪ X maximizing |P ∩ adj[u]| (Tomita pivot)
          // so we only branch on P \ adj[u]. Deterministic tie-break: lowest idx.
          let pivot = -1;
          let pivotCount = -1;
          let pux = pMask | xMask;
          while (pux !== 0) {
            const u = lowestSetIndex(pux);
            pux &= pux - 1;
            const cnt = popcount(pMask & adj[u]!);
            if (cnt > pivotCount) {
              pivotCount = cnt;
              pivot = u;
            }
          }

          // Branch on candidates NOT adjacent to the pivot, ascending index.
          let candidates = pivot >= 0 ? pMask & ~adj[pivot]! : pMask;
          let p = pMask;
          let x = xMask;
          while (candidates !== 0) {
            const v = lowestSetIndex(candidates);
            const vBit = 1 << v;
            candidates &= ~vBit;
            expand(rSize + 1, p & adj[v]!, x & adj[v]!);
            p &= ~vBit;
            x |= vBit;
          }
        };

        expand(0, ALL, 0);
        maxSetSize = best;
      } else {
        // ─── FALLBACK PATH (n > MAX_EXACT_ROOTS): deterministic greedy maximal
        // independent set. May UNDERCOUNT (maximal ≠ maximum) — the bomb-safe
        // direction — but is O(n²) and can never hang. Note the cap so the cap
        // is observable rather than silent.
        deps.onLargeRootSetCap?.(n, MAX_EXACT_ROOTS);
        const representatives: ProvenanceRoot[] = [];
        for (const root of ordered) {
          const isNewRep = representatives.every((rep) =>
            independent(root, rep),
          );
          if (isNewRep) representatives.push(root);
        }
        maxSetSize = representatives.length;
      }

      // Clamp: the count never exceeds the Stage-1 distinct-class bound.
      return Math.min(distinctClassCount, maxSetSize);
    },

    independentSources(a: SourceId, b: SourceId): boolean {
      // RC-5 — the SOURCE-level twin of the `independent`-pair predicate in
      // `independentRootCount` above, so RC-5's approve-gate and the forgetting
      // count share ONE independence notion (anti-drift).
      // A source is trivially not independent of itself (an echo).
      if (a === b) return false;
      // FAIL CLOSED for an unregistered source: it never bound an anchor, so it
      // is a BARE_KEY-equivalent witness (independence_weight 0.00 per the
      // anchor-cost table) and can never be independent of anything — never
      // fall open to `true` just because a caller-supplied `SourceId` was never
      // passed through `identity.register()`.
      if (sources.has(a) && sources.has(b)) {
        // PREFER the registry's source-aware predicate (it sees per-anchor
        // `classId` + the `operatorClassId` fleet axis); else the anchor-set
        // disjointness math with the same `> 0` threshold the count layer uses.
        if (anchors.independentSources !== undefined) {
          return anchors.independentSources(a, b);
        }
        return (
          anchors.independenceBetween(anchors.anchorsOf(a), anchors.anchorsOf(b)) > 0
        );
      }
      return false;
    },
  };
}
