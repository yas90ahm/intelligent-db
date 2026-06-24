/**
 * merkle.bench.ts — MERKLE tamper-evidence: root build vs O(log n) proofs.
 *
 * The Merkle log recomputes its tree from the ledger records on demand. We seed a
 * PendingLedger with N PENDING records (the leaves) at tree sizes ~1k, ~10k, ~100k and
 * bench:
 *   - merkleRoot         — O(n) root build (should grow ~linearly with tree size).
 *   - inclusionProof+verify   — O(log n) (should be near-FLAT across sizes).
 *   - consistencyProof+verify — O(log n) (near-flat across sizes).
 *
 * The 100k tree is built ONCE in module init and reused across the three proof benches.
 * The 100k root build is bounded (low time/iterations) since it is the heaviest O(n)
 * case. Proofs being flat while root-build grows is the load-bearing observation.
 */

import { bench, describe } from "vitest";

import {
  createMerkleLog,
  createPendingLedger,
  generatePassport,
  verifyConsistency,
  verifyInclusion,
  InMemoryPublicationSink,
} from "../index.js";
import type { MerkleLog, PendingLedger } from "../index.js";

import { NOW } from "./fixtures.js";

const SIGNER = generatePassport(); // one key for the whole bench (minting is expensive)

const SIZES = [1_000, 10_000, 100_000] as const;

interface Tree {
  readonly log: MerkleLog;
  readonly size: number;
  readonly root: string;
}

/** Seed a PendingLedger with `n` signed PENDING records, then wrap it in a MerkleLog. */
function buildTree(n: number): Tree {
  const ledger: PendingLedger = createPendingLedger();
  for (let i = 0; i < n; i++) {
    ledger.appendPending(
      {
        contradictionSetId: (`cset:${i}` as never),
        attribute: (`attr:${i}` as never),
        members: [],
        reason: "INDEPENDENT_DISPUTE",
        createdAt: NOW,
      },
      SIGNER,
    );
  }
  const log = createMerkleLog({
    ledger,
    signer: SIGNER,
    sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
  });
  return { log, size: n, root: log.merkleRoot() };
}

// Build each tree ONCE (the 100k build is the dominant fixed cost; reused below).
const trees = new Map<number, Tree>();
for (const n of SIZES) trees.set(n, buildTree(n));

describe("MERKLE · merkleRoot (O(n) build)", () => {
  for (const n of SIZES) {
    const t = trees.get(n)!;
    bench(
      `tree=${n}`,
      () => {
        t.log.merkleRoot();
      },
      n >= 100_000 ? { time: 500, iterations: 5 } : undefined,
    );
  }
});

describe("MERKLE · inclusionProof + verify (O(log n))", () => {
  for (const n of SIZES) {
    const t = trees.get(n)!;
    const mid = n >> 1;
    bench(`tree=${n}`, () => {
      const proof = t.log.inclusionProof(mid);
      const leaf = t.log.leafHashAt(mid);
      verifyInclusion(leaf, proof, t.root);
    });
  }
});

describe("MERKLE · consistencyProof + verify (O(log n))", () => {
  for (const n of SIZES) {
    const t = trees.get(n)!;
    const oldSize = n >> 1;
    const oldRoot = t.log.merkleRoot(oldSize);
    bench(`tree=${n} (old=${oldSize})`, () => {
      const proof = t.log.consistencyProof(oldSize, n);
      verifyConsistency(oldRoot, oldSize, t.root, n, proof);
    });
  }
});
