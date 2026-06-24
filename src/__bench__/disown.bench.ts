/**
 * disown.bench.ts — DISOWN SWEEP over a modest DERIVATION graph.
 *
 * downstreamDisownSweep craters the disowned source, then BFS-walks DERIVATION edges
 * BACKWARD to demote every downstream strand whose existence rested on the tainted
 * seed. We bench it over a ~1000-strand derivation chain/tree of bounded depth.
 *
 * The sweep is IDEMPOTENT (a disowned source is recorded and a second sweep no-ops), so
 * each iteration must rebuild a fresh store + reputation ledger. The build dominates,
 * so the bench is bounded; the relative cost still surfaces how a 1k-node taint closure
 * behaves.
 */

import { bench, describe } from "vitest";

import {
  EdgeType,
  createMemoryStore,
  createReputationLedger,
  downstreamDisownSweep,
} from "../index.js";
import type {
  EntityId,
  ReputationLedger,
  SourceId,
  StrandId,
  StrandStore,
  Unit,
} from "../index.js";

import { NOW, makeEdge, makeStrand } from "./fixtures.js";

const ENTITY = "entity:disown" as EntityId;
const DISOWNED = "src:fraud" as SourceId;
const GRAPH_N = 1_000;
const FANOUT = 4; // each strand derives from its parent; a wide-ish tree of depth ~5

interface Built {
  readonly store: StrandStore;
  readonly ledger: ReputationLedger;
  readonly seed: StrandId[];
}

/**
 * Build a derivation tree of `n` strands rooted at a single tainted seed authored by
 * DISOWNED. Strand i (i>0) DERIVES FROM strand floor((i-1)/FANOUT): a DERIVATION edge
 * points derived -> witness, so the sweep walks these backward from the seed.
 */
function build(n: number): Built {
  const store: StrandStore = createMemoryStore();
  const ids: StrandId[] = [];
  for (let i = 0; i < n; i++) {
    // The seed (i=0) is authored by the disowned source; downstream strands by others.
    const src = i === 0 ? DISOWNED : (`src:${i}` as SourceId);
    const cls = i === 0 ? "cls:tainted" : `cls:d:${i}`;
    const s = makeStrand(`dis:${i}`, ENTITY, src, cls, { i });
    store.putStrand(s);
    ids.push(s.id);
  }
  // DERIVATION edges: child -> parent (derived rests on witness).
  for (let i = 1; i < n; i++) {
    const parent = ids[Math.floor((i - 1) / FANOUT)]!;
    const child = ids[i]!;
    store.putEdge(makeEdge(`dis:e:${i}`, child, parent, EdgeType.DERIVATION));
  }
  for (const id of ids) store.recomputeOutWeightSum(id);

  const ledger = createReputationLedger(() => 0.6 as Unit, undefined, () => NOW);
  // Give the disowned source some earned credit so the crater has something to undo.
  ledger.ratify(DISOWNED, NOW, 0.5);

  return { store, ledger, seed: [ids[0]!] };
}

describe(`DISOWN · downstreamDisownSweep over ~${GRAPH_N}-node derivation graph`, () => {
  bench(
    "sweep (rebuild + crater + taint closure)",
    () => {
      const b = build(GRAPH_N);
      downstreamDisownSweep(DISOWNED, b.seed, b.store, b.ledger, NOW);
    },
    { time: 600 },
  );
});
