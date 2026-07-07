/**
 * traversal/walk.ts — Share-normalized best-first spreading-activation walk.
 *
 * This module is the engine room of "latent memory, activated by traversal, not
 * query" (CLAUDE.md). A cue energizes one or more SEED strands; activation
 * propagates across connected threads (edges) until a cluster of relevant facts
 * "lights up". Only LIT strands are later assembled into an answer.
 *
 * Two clearly separated concerns live here:
 *
 *  1. {@link MaxPriorityQueue} — a SIMPLE, fully-implemented binary max-heap that
 *     orders which unexpanded strand to pop next. This is the "best-first"
 *     mechanism. It is purely an ORDERING device.
 *
 *  2. {@link activationWalk} — the HARD algorithmic core (the frontier-expansion
 *     body). IMPLEMENTED: the pop loop runs `child = parent * (edge.w /
 *     edge.out_weight_sum) * γ`, honors the refractory lock, and delegates every
 *     stop decision to the {@link HaltingController}. See the function doc for the
 *     exact loop.
 *
 * Design invariants this file must honor (CLAUDE.md "Resolved: traversal halting"):
 *
 *  - **Share-normalized best-first.** Pop the max-priority unexpanded strand;
 *    `child = parent * (edge.w / edge.out_weight_sum) * γ`. Share-normalization
 *    makes high-degree junk hubs self-starve: each of a hub's N out-edges gets a
 *    `1/N`-style share, so spam fans out to nothing.
 *
 *  - **Refractory lock.** A per-traversal `fired` set kills the A→B→A echo: a
 *    strand that has fired cannot re-fire within the same walk.
 *
 *  - **Monotone non-increasing energy.** Because `γ < 1` and every normalized
 *    share is in `[0,1]`, child energy is strictly ≤ parent energy. Energy is
 *    therefore monotone non-increasing along any path, which makes TERMINATION
 *    PROVABLE (combined with the refractory lock and the hard pop-cap backstop).
 *
 *  - **Ordering is NOT stopping.** Pop order is decided by energy ALONE (the
 *    best-first heap). ALL stop decisions are delegated to the
 *    {@link HaltingController}: this walk asks the controller after every
 *    expansion and never decides to stop on its own except at the structural
 *    backstops the controller itself owns. (An earlier revision also broke
 *    energy ties on a `convergence_factor` ordering key sourced from a
 *    per-traversal `Strand.register`; that register was never populated to
 *    anything but `null` anywhere in the engine, so the tiebreak always compared
 *    `0` to `0` and never actually ordered a single pop. Removed as dead code —
 *    Wave-2 `convergence-ordering-dead` — rather than half-wired; see CLAUDE.md
 *    KNOWN LIMITATIONS.)
 *
 * STACK NOTE: ESM + NodeNext means relative imports carry the `.js` extension;
 * `verbatimModuleSyntax` means every type-only import MUST use `import type`.
 */

import {
  EdgeType,
  ReasonCode,
  asEpochMs,
  type Activation,
  type Edge,
  type EdgeId,
  type LitStrand,
  type HaltStamp,
  type Strand,
  type StrandId,
  type WalkConfig,
} from "../core/types.js";
import type { StrandStore } from "../store/StrandStore.js";
import type {
  HaltingController,
  HaltContext,
  HaltStoreView,
} from "./halting.js";

// ===========================================================================
// MaxPriorityQueue<T> — SIMPLE part, fully implemented binary max-heap.
// ===========================================================================

/**
 * A comparator over `T`. Returns:
 *  - a positive number when `a` has HIGHER priority than `b` (a should pop first),
 *  - a negative number when `a` has LOWER priority than `b`,
 *  - zero when they are equal in priority.
 *
 * This is the standard "subtract" convention for a MAX-priority queue: e.g.
 * `(a, b) => a.energy - b.energy` pops the highest-energy item first.
 */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * Binary max-heap priority queue.
 *
 * Backs the best-first frontier of {@link activationWalk}: the walk pushes every
 * newly-reachable (strand, energy) candidate and pops the highest-priority one to
 * expand next. This class is ORDERING ONLY — it has no knowledge of halting,
 * refractory locks, or energy decay; those live in the walk body.
 *
 * Complexity: `push` and `pop` are O(log n); `peek`, `size`, `isEmpty` are O(1).
 * The heap is stored in a flat array using the usual index arithmetic
 * (parent `(i-1)>>1`, children `2i+1` / `2i+2`).
 *
 * @typeParam T - the element type ordered by the supplied {@link Comparator}.
 */
export class MaxPriorityQueue<T> {
  /** Backing array; `heap[0]` is always the current maximum (or empty). */
  private readonly heap: T[] = [];

  /**
   * @param compare - priority comparator; positive => first arg pops sooner.
   *   The default assumes `T extends number` and orders numbers descending.
   */
  constructor(
    private readonly compare: Comparator<T> = (a, b) =>
      (a as unknown as number) - (b as unknown as number),
  ) {}

  /** Number of elements currently in the queue. O(1). */
  get size(): number {
    return this.heap.length;
  }

  /** True when the queue holds no elements. O(1). */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Return — but do NOT remove — the highest-priority element, or `undefined`
   * when the queue is empty. O(1).
   */
  peek(): T | undefined {
    return this.heap.length === 0 ? undefined : this.heap[0];
  }

  /**
   * Insert `value` and restore the heap property by sifting it up toward the
   * root. O(log n).
   *
   * @param value - the element to enqueue.
   */
  push(value: T): void {
    this.heap.push(value);
    this.siftUp(this.heap.length - 1);
  }

  /**
   * Remove and return the highest-priority element, or `undefined` when empty.
   * Moves the last element to the root and sifts it down to restore the heap.
   * O(log n).
   */
  pop(): T | undefined {
    const n = this.heap.length;
    if (n === 0) return undefined;

    const top = this.heap[0] as T;
    const last = this.heap.pop() as T;
    // If the popped element WAS the last one, the heap is now empty.
    if (n > 1) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /**
   * Restore the heap upward: swap `i` with its parent while it out-prioritizes
   * that parent.
   */
  private siftUp(i: number): void {
    let child = i;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.compare(this.heap[child] as T, this.heap[parent] as T) > 0) {
        this.swap(child, parent);
        child = parent;
      } else {
        break;
      }
    }
  }

  /**
   * Restore the heap downward: swap `i` with its highest-priority child while a
   * child out-prioritizes it.
   */
  private siftDown(i: number): void {
    const n = this.heap.length;
    let parent = i;
    for (;;) {
      const left = 2 * parent + 1;
      const right = 2 * parent + 2;
      let best = parent;

      if (
        left < n &&
        this.compare(this.heap[left] as T, this.heap[best] as T) > 0
      ) {
        best = left;
      }
      if (
        right < n &&
        this.compare(this.heap[right] as T, this.heap[best] as T) > 0
      ) {
        best = right;
      }
      if (best === parent) break;

      this.swap(parent, best);
      parent = best;
    }
  }

  /** Swap two slots in the backing array. */
  private swap(i: number, j: number): void {
    const tmp = this.heap[i] as T;
    this.heap[i] = this.heap[j] as T;
    this.heap[j] = tmp;
  }
}

// ===========================================================================
// Walk I/O contract — SIMPLE shapes, fully specified.
// ===========================================================================

/**
 * A seed for {@link activationWalk}: one strand to inject initial energy into.
 *
 * A cue typically resolves to one or a few seeds (the strands a query "touches"
 * first). The walk spreads `energy` outward from each seed along share-normalized
 * threads. Multiple seeds with overlapping reach naturally reinforce the same
 * downstream strands.
 */
export interface WalkSeed {
  /** The strand to energize at traversal start. */
  readonly strandId: StrandId;
  /** Initial activation energy injected at this seed (`> 0`, typically `1.0`). */
  readonly energy: Activation;
}

/**
 * The outcome of a walk: the lit cluster plus the (never-silent) halt stamp.
 *
 * `lit` is the set of strands that ended the walk holding activation, each paired
 * with the energy it retained — this is what the assembler turns into an answer.
 * `halt` records WHY the walk stopped and whether the result is degraded
 * (truncated / bridge-starved), so a partial answer is always surfaced WITH a
 * stamp rather than hidden (halting "fails open").
 */
export interface WalkResult {
  /** Strands that lit up, with their final activation. Order is unspecified. */
  readonly lit: LitStrand[];
  /** The halt stamp explaining how/why the traversal stopped. */
  readonly halt: HaltStamp;
  /**
   * Seed ids that did NOT resolve in the store (dangling cue entry points),
   * in seed order. ALWAYS present (empty when every seed resolved): a caller
   * must be able to tell "the cue touched the web" from "my ids were stale"
   * without inspecting optionality. When NO seed resolves (and at least one was
   * supplied) the walk returns {@link import('../core/types.js').ReasonCode.NO_SEEDS_RESOLVED}
   * with `degraded: true` instead of running a vacuous bridge sweep.
   */
  readonly unresolvedSeeds: readonly StrandId[];
  /** How many supplied seeds resolved in the store. ALWAYS present. */
  readonly seedsResolved: number;
}

// ===========================================================================
// Frontier candidate — internal ordering record for the heap.
// ===========================================================================

/**
 * One entry in the best-first frontier: a reachable strand and the energy it
 * would receive if expanded now. Carried in the {@link MaxPriorityQueue}.
 *
 * Exported so the crack-A implementor (and tests) can construct/inspect frontier
 * candidates against a stable shape.
 *
 * REMOVED (Wave-2 `convergence-ordering-dead`): this used to also carry an
 * `orderingKey` field (a `convergence_factor`-derived secondary sort key meant to
 * break energy ties toward better-corroborated strands). `convergence_factor` was
 * never populated to anything but 0 anywhere in the engine, so the tiebreak always
 * compared `0` to `0` — dead weight, never an actual ordering signal. Dropped
 * along with `frontierComparator`'s secondary key, `orderingKeyFor`, and the
 * unused `makeChildCandidate` helper. See CLAUDE.md KNOWN LIMITATIONS.
 */
export interface FrontierCandidate {
  /** The strand this candidate would expand. */
  readonly strandId: StrandId;
  /**
   * Energy to deposit on `strandId` when popped:
   * `parent * (edge.w / edge.out_weight_sum) * γ`. Monotone non-increasing
   * relative to the parent (share ∈ [0,1], γ < 1).
   */
  readonly energy: Activation;
}

/**
 * The frontier comparator for the best-first heap: highest energy pops first —
 * this is what makes the walk "best-first" and what the monotone-non-increasing
 * guarantee is stated against. Equal-energy candidates are popped in whatever
 * order {@link MaxPriorityQueue} happens to hold ties in (unspecified, never a
 * correctness dependency — termination and the monotone-non-increasing proof
 * don't depend on tie order).
 */
export const frontierComparator: Comparator<FrontierCandidate> = (a, b) => a.energy - b.energy;

// ===========================================================================
// activationWalk — HARD CORE. Signature + doc complete; body is crack-A.
// ===========================================================================

/**
 * The UNIFORM per-thread weight of a derived (lazy, index-backed) SHARED_ENTITY
 * sibling: `computeEdgeWeight(link_confidence=1, provenance_independence=1,
 * recency=1) = 1`. SHARED_ENTITY is a MECHANICAL, checkable join (not an inferred
 * relationship), so its link_confidence is 1; a derived sibling has no aged recency
 * to discount; and the walk reads only the store (it never witnesses identity), so
 * the independence factor is the mechanical join's 1, not a self-computed value.
 *
 * What is load-bearing is that this weight is IDENTICAL for every sibling of a given
 * entity: with a uniform `w_se`, the K-sibling fan folded into the share denominator
 * Σ_eff gives each sibling `w_se / (materialized + K·w_se) ≈ 1/K` for a hot entity,
 * so a high-degree entity self-starves EXACTLY as the old O(N^2) clique did — spam
 * cannot dominate (the spam-resistance property is preserved structurally).
 */
const SIBLING_EDGE_WEIGHT = 1;

/**
 * Maximum number of derived shared-entity sibling candidates pushed PER POP. A hot
 * entity (e.g. one bank account with 10k facts) would otherwise make each pop push K
 * frontier entries, turning the eliminated O(N^2) write cost into an un-bounded
 * O(popCap·K) read cost. Each sibling's energy is `≈ γ/K`, so beyond a small constant
 * the candidates are negligible and best-first-dominated; capping the PUSH (while the
 * share DENOMINATOR still uses the full K) keeps per-pop work O(cap) and total read
 * work strictly pop-cap-bounded, with the spam-resistance / self-starve theorem
 * mathematically intact. Connectivity for ordinary entities (a handful of facts) is
 * unaffected — they have far fewer than `VIRTUAL_SIBLING_FANOUT_CAP` siblings.
 */
const VIRTUAL_SIBLING_FANOUT_CAP = 32;

/**
 * Run a share-normalized best-first spreading-activation walk from `seeds`.
 *
 * THE LOOP the body must implement (CLAUDE.md "Share-normalized best-first walk"):
 *
 *  1. **Seed.** For each {@link WalkSeed}, fetch the strand from `store` and push
 *     a {@link FrontierCandidate} (seed energy) onto a {@link MaxPriorityQueue}
 *     ordered by {@link frontierComparator}.
 *
 *  2. **Expand.** While the frontier is non-empty AND the
 *     {@link HaltingController} has not told us to stop:
 *       a. POP the max-priority unexpanded candidate.
 *       b. Skip it if its strand already fired this traversal (the `fired` set
 *          is the refractory lock) — this is the A→B→A echo killer.
 *       c. Mark the strand fired: record its final activation, add it to the
 *          `fired` set so it cannot re-fire this traversal, and add it to the
 *          lit set.
 *       d. For each out-edge `e` of the strand (read its `Edge` from `store`):
 *          compute the child energy
 *            `childEnergy = parentEnergy * (e.w / e.out_weight_sum) * config.gamma`.
 *          Share-normalization (`e.w / e.out_weight_sum`) is what starves
 *          high-degree hubs. Push a new {@link FrontierCandidate} for `e.to`
 *          (folding energy into any existing un-expanded candidate as the
 *          implementor sees fit).
 *       e. After the expansion, CALL the {@link HaltingController} with the
 *          observed novelty / corroboration so it can run its two-phase gates
 *          (phase 1 local saturation at `epsilon`; phase 2 the mandatory bridge
 *          sweep funded by the ~20% bridge sub-budget with its zero-yield
 *          circuit-breaker) and the hard backstops (pop-cap, wall-clock).
 *
 *  3. **Halt.** When the controller signals stop (or the frontier empties), obtain
 *     the {@link HaltStamp} from the controller and return `{ lit, halt }`. The
 *     stamp is ALWAYS present — a truncated or bridge-starved walk is surfaced
 *     WITH a `degraded` stamp, never silently.
 *
 * TERMINATION: energy is monotone non-increasing (every share ∈ [0,1], γ < 1) and
 * the refractory lock forbids re-firing, so each strand is expanded at most once;
 * the absolute pop-cap backstop guarantees termination even on pathological graphs.
 *
 * SEPARATION OF CONCERNS: this function NEVER decides to stop on its own. The
 * frontier only ORDERS pops (by energy). Stopping is delegated entirely to
 * `halting`. The walk must not gate on the frontier being "good enough".
 *
 * @param store   - pluggable strand/edge store (in-memory today; swappable later).
 * @param seeds   - initial energized strands (the cue's entry points).
 * @param config  - tunables (γ, ε, pop-cap, wall-clock, bridge budget, breaker).
 * @param halting - the SOLE authority on when to stop; produces the halt stamp.
 * @returns the lit cluster plus the never-silent halt stamp.
 */
export function activationWalk(
  store: StrandStore,
  seeds: WalkSeed[],
  config: WalkConfig,
  halting: HaltingController,
): WalkResult {
  // The frontier is a best-first max-heap of reachable candidates, ordered by
  // energy alone (frontierComparator) — never a stop decision.
  const frontier = new MaxPriorityQueue<FrontierCandidate>(frontierComparator);

  // Fired strands = the refractory lock. Best-first guarantees the FIRST candidate
  // popped for a strand carries the maximum energy any path can deliver (energy is
  // monotone non-increasing), so a strand fires ONCE, at that dominating energy.
  // FIRING (which strand expands its out-edges, and when) is IDENTICAL in both
  // reinforcement modes — every later candidate for an already-fired strand is
  // still skipped for RE-EXPANSION purposes, which is what bounds the walk (each
  // strand expands at most once) and keeps termination provable regardless of mode.
  const fired = new Set<StrandId>();

  // -- Reinforcement-by-summation bookkeeping (WalkConfig.reinforcement, spec §4a) --
  // "dominance" (default) leaves the walk BYTE-FOR-BYTE unchanged: these maps are
  // simply never read. "summation" tracks, for every strand ANY energy delivery was
  // computed for (seed energy, a materialized-edge child, or a virtual-sibling
  // child) — including deliveries that arrive AFTER the strand already fired — the
  // running SUM of all deliveries and the running MAX of any single delivery. The
  // strand's REPORTED (lit) activation is then `min(sum, max * summationCap)`,
  // computed once at the end of the local phase: the clamp is what keeps a cycle
  // from amplifying energy without bound (a cycle can only ever re-deliver ENERGY
  // THAT WAS ALREADY MONOTONE-DECREASING along its path, and the cap ties the
  // ceiling to the single largest delivery actually observed).
  const reinforcement = config.reinforcement ?? "dominance";
  const summationCap = config.summationCap ?? 2.0;
  const maxSingleDelivery = new Map<StrandId, number>();
  const summedEnergy = new Map<StrandId, number>();
  function recordDelivery(id: StrandId, energy: number): void {
    if (reinforcement !== "summation") return;
    const prevMax = maxSingleDelivery.get(id) ?? 0;
    if (energy > prevMax) maxSingleDelivery.set(id, energy);
    summedEnergy.set(id, (summedEnergy.get(id) ?? 0) + energy);
  }

  // Final activation per lit strand — assembled into the answer at the end.
  const litMap = new Map<StrandId, Activation>();

  // Independence classes already surfaced — the basis for PHASE-1 novelty. NEW
  // independent corroboration (not convergence_factor) is what the controller
  // thresholds against epsilon (CLAUDE.md "Separate ordering from stopping").
  const seenClasses = new Set<string>();

  // Wave-2 [walk-redundant-outedges-refetch]: per-walk cache of each POPPED
  // strand's out-edges array. The pop loop below already fetches
  // `store.outEdges(cand.strandId)` once (to sum materialized weight); this
  // cache lets (1) the neighbor-spread loop just below reuse that SAME array
  // instead of a second `store.neighbors(...)` round-trip that would re-fetch
  // the identical rows, and (2) the bridge sweep's `litBridgesFrom` (called
  // once per LIT strand at `beginBridgeSweep`, after the local phase) reuse it
  // again instead of a THIRD fetch — on the SQLite backend each of these was a
  // real prepared-statement round-trip, not a free in-memory read. A strand is
  // cached at most once (it fires — and therefore gets its out-edges fetched —
  // at most once per walk, the same refractory-lock guarantee that bounds
  // firing itself).
  const outEdgesCache = new Map<StrandId, readonly Edge[]>();

  // Narrow read-only adapter the controller uses for bridge enumeration etc.
  const view: HaltStoreView = makeHaltStoreView(store, outEdgesCache);

  // Per-walk cache of each entity's shared-entity sibling set. The web is not
  // mutated during a walk, so `strandsByEntity(E)` is invariant within one
  // traversal; caching it means a HOT entity's index is materialized ONCE (not once
  // per pop). Without this, a 10k-fact entity would rebuild a 10k-element array on
  // every one of up to popCap pops — re-introducing an O(popCap·K) cost the
  // pop-cap can't bound. With it, the derived-sibling read is O(K) once + O(cap) per
  // pop, strictly pop-cap-bounded (the cost the design wants the pop-cap to govern).
  const entitySiblingCache = new Map<string, readonly Strand[]>();
  const siblingsOf = (s: Strand): readonly Strand[] => {
    const key = String(s.entity);
    let cached = entitySiblingCache.get(key);
    if (cached === undefined) {
      cached = store.strandsByEntity(s.entity);
      entitySiblingCache.set(key, cached);
    }
    return cached;
  };

  // 1) SEED. Energize each resolvable seed strand and push it onto the frontier.
  //    Unresolvable ids are COLLECTED, never silently dropped: an all-dangling cue
  //    must return an honest NO_SEEDS_RESOLVED stamp (below), not a healthy-looking
  //    empty answer.
  const unresolvedSeeds: StrandId[] = [];
  let seedsResolved = 0;
  for (const seed of seeds) {
    const s = store.getStrand(seed.strandId);
    if (s === null) {
      unresolvedSeeds.push(seed.strandId);
      continue;
    }
    seedsResolved += 1;
    recordDelivery(seed.strandId, seed.energy);
    frontier.push({
      strandId: seed.strandId,
      energy: seed.energy,
    });
  }

  // HONEST HALT for a cue that never touched the web: seeds were supplied but NONE
  // resolved. Running on would execute the pop loop zero times and then drive the
  // bridge sweep against a FABRICATED context, returning BRIDGE_SWEEP_CLEAR /
  // popCount 0 / degraded false — indistinguishable from a genuine healthy empty
  // answer (a silent stop wearing a success stamp, which halting's "never a silent
  // stop" contract forbids). So: skip the pop loop AND the sweep entirely and stamp
  // NO_SEEDS_RESOLVED, degraded. The seeds.length === 0 path is DIFFERENT — an
  // empty cue is the caller's legitimate no-op — and is deliberately unchanged.
  if (seedsResolved === 0 && seeds.length > 0) {
    return {
      lit: [],
      halt: {
        reason: ReasonCode.NO_SEEDS_RESOLVED,
        popCount: 0,
        bridgesCrossed: 0,
        bridgeSeedsDownweighted: 0,
        degraded: true,
      },
      unresolvedSeeds,
      seedsResolved: 0,
    };
  }

  // 2) EXPAND. Best-first pop loop; EVERY stop decision is delegated to `halting`.
  let lastCtx: HaltContext | null = null;
  while (!frontier.isEmpty()) {
    const cand = frontier.pop() as FrontierCandidate;
    if (fired.has(cand.strandId)) continue; // dominated / refractory: already fired
    const strand = store.getStrand(cand.strandId);
    if (strand === null) continue;

    // Fire: record the (dominating) activation, lock against re-firing, light it up.
    fired.add(cand.strandId);
    litMap.set(cand.strandId, cand.energy);

    const ctx: HaltContext = {
      strandId: cand.strandId,
      activation: cand.energy,
      newIndependentCorroboration: gradeNovelty(noveltyOf(strand, seenClasses), config),
      now: asEpochMs(Date.now()),
      store: view,
    };
    lastCtx = ctx;

    halting.onPop(ctx);
    if (halting.shouldStopLocal(ctx)) break; // phase 1 saturated, or a hard backstop

    // SHARE-NORMALIZATION DENOMINATOR with the VIRTUAL shared-entity fan folded in.
    //
    // SHARED_ENTITY siblings are NOT materialized as edges (writeFact stopped
    // minting the O(N^2) clique); they are DERIVED at read time from the store's
    // entity index. To keep a hot entity self-starving EXACTLY as the old clique
    // did, the virtual sibling fan must share ONE denominator with the materialized
    // out-edges: each of the K virtual siblings gets `w_se / Σ_eff` where
    //   Σ_eff = (Σ w over materialized out-edges) + K * w_se,
    // so a 10k-sibling entity gives each sibling ≈ γ·(w_se / (mat + 10k·w_se)) ≈
    // γ/10k → it self-starves identically to the old per-edge clique (spam can't
    // dominate). `w_se` is UNIFORM across siblings — a mechanical shared-entity join
    // weight `computeEdgeWeight(1,1,1) = 1` (link_confidence 1, recency 1) — and it
    // is uniformity, not its magnitude, that proves the self-starve property. The
    // walk reads ONLY the store (it never witnesses identity), so the per-edge
    // independence is the mechanical join weight, not a self-computed one.
    // The virtual fan DEGREE is the structural sibling count (every other strand
    // about this entity), exactly like the old clique's out-degree — it does NOT
    // depend on which siblings have already fired (the old materialized
    // `out_weight_sum` summed every sibling edge regardless of traversal state). So
    // it is `K = |strandsByEntity(entity)| - 1`, read in O(1) from the index array's
    // length — NO per-pop O(K) scan of the siblings to compute the denominator.
    const siblings = siblingsOf(strand);
    const virtualSiblingCount = siblings.length > 0 ? siblings.length - 1 : 0;

    // Materialized Σw over the popped strand's out-edges (the store's denominator).
    // Wave-2 [walk-redundant-outedges-refetch]: fetched EXACTLY ONCE per pop and
    // cached (below) for reuse by the neighbor-spread loop and later the bridge
    // sweep — a strand fires at most once (the refractory lock), so this is at
    // most one `outEdges` round-trip per strand for the WHOLE walk, not up to
    // three (materializedOutSum + `store.neighbors` + the bridge sweep's
    // `litBridgesFrom`, each independently re-querying the SAME rows on the
    // SQLite backend).
    let materializedOutSum = 0;
    const outEdges = store.outEdges(cand.strandId);
    for (const e of outEdges) materializedOutSum += e.w;
    outEdgesCache.set(cand.strandId, outEdges);

    const effectiveOutSum =
      materializedOutSum + virtualSiblingCount * SIBLING_EDGE_WEIGHT;

    // Spread share-normalized, γ-decayed energy to each MATERIALIZED neighbor:
    //   child = parent * (edge.w / Σ_eff) * γ
    // Share-normalization (w / Σ_eff) is what starves high-degree hubs; Σ_eff folds
    // in the virtual sibling fan so the denominator is the true total out-strength.
    // Built LOCALLY from `outEdges` (already fetched above) instead of a second
    // `store.neighbors(cand.strandId)` call — resolving each edge's destination
    // strand here reproduces `neighbors()`'s exact semantics (a dangling edge,
    // whose destination is not yet stored, forms no candidate) byte-for-byte.
    for (const e of outEdges) {
      // Bridges are NOT part of normal local activation: each lit, un-crossed
      // CROSS_WEB_BRIDGE is owed EXACTLY ONE crossing by the phase-2 mandatory
      // sweep, funded by the SEPARATE bridge sub-budget. Spreading energy across
      // a bridge here would cross it in the local phase and bypass that budget,
      // so the local expansion SKIPS bridges entirely (CLAUDE.md "Resolved:
      // traversal halting").
      if (e.edgeType === EdgeType.CROSS_WEB_BRIDGE) continue;
      const dest = store.getStrand(e.to);
      if (dest === null) continue; // dangling edge: no NeighborView, matches store.neighbors()
      const alreadyFired = fired.has(e.to);
      // DOMINANCE (default): an already-fired target gets nothing further —
      // byte-for-byte the original fast path. SUMMATION: still compute the
      // delivery and record it (below) so a strand's REPORTED activation
      // reflects every path that reached it, even after it first fired; it is
      // never re-pushed/re-expanded either way (bounds the walk identically).
      if (alreadyFired && reinforcement === "dominance") continue;
      const share = effectiveOutSum > 0 ? e.w / effectiveOutSum : 0;
      const childEnergy = cand.energy * share * config.gamma;
      if (childEnergy <= 0) continue; // weightless / hub-starved thread
      recordDelivery(e.to, childEnergy);
      if (alreadyFired) continue; // summation: tracked, but no re-expansion
      frontier.push({
        strandId: e.to,
        energy: childEnergy,
      });
    }

    // Spread to the DERIVED shared-entity siblings (the lazy index-derived fan).
    // Each gets the SAME share-normalized, γ-decayed energy a materialized
    // SHARED_ENTITY edge of uniform weight `SIBLING_EDGE_WEIGHT` would have
    // delivered, folded into Σ_eff above. This preserves recall connectivity ("a
    // fact written about an entity is reachable when recalling that entity") now
    // that the clique is gone.
    //
    // BOUNDED FAN-OUT: a HOT entity (one account with 10k facts) must not make each
    // pop push 10k frontier candidates — that would move the old O(N^2) write cost
    // into an O(popCap·K) read cost (un-bounded by the pop-cap). The energy each
    // sibling receives is `≈ γ·w_se/Σ_eff ≈ γ/K`, so beyond a small constant the
    // candidates are vanishingly weak AND best-first-dominated; we therefore push at
    // most `VIRTUAL_SIBLING_FANOUT_CAP` un-fired siblings per pop. The DENOMINATOR
    // still uses the FULL K (above), so the self-starve / spam-resistance property is
    // mathematically unchanged — a hot entity's siblings each still get the true
    // `1/K` share; we merely stop enumerating the negligible tail. Per-pop work is
    // thus O(cap), and total read work is O(popCap · cap) — strictly pop-cap-bounded.
    // A sibling reachable BOTH here AND via a materialized edge (a hand-built
    // buildWeb web) is de-duplicated by the `fired` set + best-first dominance: it
    // fires once at the max energy any path delivers (connectivity additive, never
    // double-counted).
    if (virtualSiblingCount > 0) {
      const siblingShare =
        effectiveOutSum > 0 ? SIBLING_EDGE_WEIGHT / effectiveOutSum : 0;
      const siblingEnergy = cand.energy * siblingShare * config.gamma;
      if (siblingEnergy > 0) {
        let pushed = 0;
        for (const sib of siblings) {
          if (pushed >= VIRTUAL_SIBLING_FANOUT_CAP) break;
          if (sib.id === cand.strandId) continue;
          // No-op in dominance mode (recordDelivery short-circuits immediately);
          // in summation mode this is what lets an ALREADY-FIRED sibling's later
          // delivery still count toward its reported (clamped) activation.
          recordDelivery(sib.id, siblingEnergy);
          if (fired.has(sib.id)) continue;
          frontier.push({
            strandId: sib.id,
            energy: siblingEnergy,
          });
          pushed += 1;
        }
      }
    }
  }

  // REINFORCEMENT-BY-SUMMATION finalization (spec §4a): only in "summation" mode,
  // overwrite each LOCALLY-fired strand's reported activation with
  // `min(Σ deliveries, summationCap × max single delivery)` — computed HERE, once,
  // after every delivery this walk will ever compute for these strands has been
  // recorded (later deliveries during the bridge sweep target NEW, not-yet-fired
  // strands only, so they cannot retroactively change this set). Dominance mode's
  // `litMap` entries (set at fire time, above) are left completely untouched.
  if (reinforcement === "summation") {
    for (const id of fired) {
      const cap = (maxSingleDelivery.get(id) ?? 0) * summationCap;
      const sum = summedEnergy.get(id) ?? 0;
      litMap.set(id, Math.min(sum, cap) as Activation);
    }
  }

  // 3) MANDATORY bridge sweep (phase 2). Enumeration is crack-B and currently
  //    yields nothing, so this clears immediately — but the drive loop is fully
  //    wired, so the sweep activates the moment crack-B lands with NO change here.
  const sweepBaseCtx: HaltContext =
    lastCtx ?? {
      strandId: seeds[0]?.strandId ?? ("" as StrandId),
      activation: 0,
      newIndependentCorroboration: 0,
      now: asEpochMs(Date.now()),
      store: view,
    };
  halting.beginBridgeSweep(sweepBaseCtx);
  for (;;) {
    // FIX (bridge-sweep-backstop-frozen): rebuild the context EVERY iteration
    // with a FRESH wall-clock reading — `HaltContext` fields are readonly, and
    // reusing one frozen object (as this used to) across the whole sweep loop
    // meant `ctx.now` never advanced past the last LOCAL-phase pop, so the hard
    // backstop's wall-clock check (`now - startedAt >= wallClockMs`) could
    // never observe real elapsed time during a long-running phase 2. Only
    // `now` needs to change per call; everything else in the base ctx
    // (store view, last-popped strand/activation/novelty) is unused by
    // `nextBridgeCrossing` except through `ctx.store`.
    const sweepCtx: HaltContext = { ...sweepBaseCtx, now: asEpochMs(Date.now()) };
    const crossing = halting.nextBridgeCrossing(sweepCtx);
    if (crossing === null) break;
    // Perform the one guaranteed exploratory crossing: seed the far side.
    const target = store.getStrand(crossing.target);
    let yieldCorroboration = 0;
    if (target !== null && !fired.has(crossing.target)) {
      fired.add(crossing.target);
      litMap.set(crossing.target, crossing.seedActivation);
      yieldCorroboration = gradeNovelty(noveltyOf(target, seenClasses), config);
    }
    halting.recordCrossingYield({
      bridgeEdge: crossing.bridgeEdge,
      yieldCorroboration,
      popsConsumed: 1,
    });
  }

  // 4) HALT — always a stamp, never silent (CLAUDE.md "halting fails open").
  const halt: HaltStamp = halting.finalStamp();
  const lit: LitStrand[] = [];
  for (const [strandId, activation] of litMap) lit.push({ strandId, activation });
  return { lit, halt, unresolvedSeeds, seedsResolved };
}

// REMOVED (Wave-2 `convergence-ordering-dead`): `makeChildCandidate` (a
// standalone child-energy-formula helper taking a `convergenceFactor` param
// that only ever fed the now-removed `orderingKey`) and `orderingKeyFor` (which
// read `strand.register?.convergence_factor ?? 0` — always 0, since
// `Strand.register` was never populated to anything but `null` anywhere in the
// engine). Neither was called from `activationWalk` itself (which always
// inlined the child-energy formula directly) or from any test. See CLAUDE.md
// KNOWN LIMITATIONS for the historical record of this finding.

// ===========================================================================
// Internal walk helpers (not exported).
// ===========================================================================

/**
 * The RAW count of NEW independent-provenance CLASSES a popped strand
 * contributes (`seenClasses` is mutated to fold them in so later pops see them
 * as seen). This is the count {@link gradeNovelty} shapes into the signal
 * PHASE-1 halting actually consumes — kept separate so the "how many NEW
 * classes" fact and the "how do we grade that into [0,1]" policy don't conflate.
 *
 * Deliberately reads PROVENANCE CLASSES, never `convergence_factor`: ordering is
 * convergence, stopping is novelty (CLAUDE.md "Separate ordering from stopping").
 */
function noveltyOf(strand: Strand, seenClasses: Set<string>): number {
  let added = 0;
  for (const root of strand.provenance) {
    const cls = String(root.independenceClass);
    if (!seenClasses.has(cls)) {
      seenClasses.add(cls);
      added += 1;
    }
  }
  return added;
}

/**
 * Shape a raw new-independent-root COUNT (from {@link noveltyOf}) into the [0,1]
 * signal PHASE-1 halting's EWMA consumes (Phase-1 retrieval spec §4b).
 *
 * `config.noveltyMode` omitted or `"binary"` (the DEFAULT): TODAY's 0/1 signal —
 * `added > 0 ? 1 : 0` — byte-for-byte unchanged from the pre-graded behavior.
 *
 * `"graded"`: the saturating curve `1 - exp(-added / tau)` (`config.noveltyTau`,
 * default 1.0), so 2 new independent roots register MORE novelty than 1 without
 * ever reaching a hard ceiling (approaches but never reaches 1). `added === 0`
 * still maps to exactly 0 in both modes (no novelty is no novelty).
 *
 * Affects ONLY the halting EWMA input — ordering (convergence_factor) is
 * untouched, and the ReasonCode / stop CONTRACT this feeds into is unchanged;
 * only how "saturated" the local phase LOOKS after any given pop differs.
 */
function gradeNovelty(added: number, config: WalkConfig): number {
  if (added <= 0) return 0;
  if (config.noveltyMode !== "graded") return 1; // DEFAULT: today's binary signal
  const tau = config.noveltyTau ?? 1.0;
  if (!(tau > 0)) return 1; // fail-safe: a non-positive tau degrades to binary
  return 1 - Math.exp(-added / tau);
}

/**
 * Adapt the full {@link StrandStore} to the narrow read-only {@link HaltStoreView}
 * the halting controller needs (independent-class counts + lit-bridge resolution
 * for the phase-2 sweep). The controller never mutates through this view.
 *
 * @param outEdgesCache - Wave-2 [walk-redundant-outedges-refetch]: the pop
 *   loop's per-strand out-edges cache. `litBridgesFrom` is called once per LIT
 *   strand at `beginBridgeSweep` — EVERY such strand was already popped (and
 *   therefore already had its out-edges fetched) during the local phase, so
 *   this is a cache HIT in the overwhelming common case; a strand this view is
 *   ever asked about that is somehow not cached (e.g. a future caller reusing
 *   this adapter outside the walk's own pop loop) still gets a correct answer
 *   via the store fallback, never a wrong one.
 */
function makeHaltStoreView(
  store: StrandStore,
  outEdgesCache: ReadonlyMap<StrandId, readonly Edge[]>,
): HaltStoreView {
  return {
    independentClassCount(strandId: StrandId): number {
      const s = store.getStrand(strandId);
      if (s === null) return 0;
      const classes = new Set<string>();
      for (const root of s.provenance) classes.add(String(root.independenceClass));
      return classes.size;
    },
    litBridgesFrom(strandId: StrandId): readonly EdgeId[] {
      const out: EdgeId[] = [];
      const edges = outEdgesCache.get(strandId) ?? store.outEdges(strandId);
      for (const e of edges) {
        if (e.edgeType === EdgeType.CROSS_WEB_BRIDGE) out.push(e.id);
      }
      return out;
    },
    bridgeTarget(edgeId: EdgeId): StrandId {
      const e = store.getEdge(edgeId);
      if (e === null) {
        throw new Error(`bridgeTarget: unknown bridge edge ${String(edgeId)}`);
      }
      return e.to;
    },
    bridgeIndependence(edgeId: EdgeId): number {
      // B1 — read the already-loaded per-edge provenance_independence stamp.
      // Fail-open: an unknown edge / absent / non-positive stamp ⇒ 0 (caller
      // stays at γ). O(1) field read — NO MIS/identity round-trip on recall.
      const e = store.getEdge(edgeId);
      if (e === null) return 0;
      const v = e.provenance_independence as number;
      return Number.isFinite(v) && v > 0 ? v : 0;
    },
    bridgeEarnedValue(edgeId: EdgeId): number {
      // B2 — the owning (from) strand's offline earned_bridge_value. 0 if the
      // edge or its origin strand is unknown (fail-open ⇒ sorts last).
      const e = store.getEdge(edgeId);
      if (e === null) return 0;
      const s = store.getStrand(e.from);
      return s === null ? 0 : s.bridge.earned_bridge_value;
    },
  };
}
