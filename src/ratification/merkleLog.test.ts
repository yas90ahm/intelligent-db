/**
 * merkleLog.test.ts — RFC 6962 Merkle layer + STH + publication/witness, one test per
 * invariant of roadmap item 2 (the Merkle-anchored, externally-witnessed upgrade).
 *
 * THE GUARANTEE under test: given an authentic published STH from an independent
 * witness, ANY deletion, rollback, reordering, post-anchor truncation, or split-view of
 * the ledger is DETECTABLE (detection, not prevention; uncompromised log-signer key).
 *
 * Matrix:
 *   1. INCLUSION proof verifies for every leaf against the live root.
 *   2. TAMPERED leaf fails inclusion (a flipped record ⇒ different leaf hash ⇒ ≠ root).
 *   3. CONSISTENCY proof verifies a real append (every old ⊂ new prefix).
 *   4. CONSISTENCY REJECTS a rollback (newSize < oldSize) and a forked same-size tree.
 *   5. STH signs + verifies; a wrong key fails.
 *   6. SPLIT-VIEW (two same-size STHs, different roots) is flagged as equivocation.
 *   7. WITNESSED deletion/rollback caught via a consistency check vs a sink's prior STH.
 *   8. GENESIS STH published at init to ≥2 sinks (size 0, empty-tree root).
 *   9. KNOWN-ANSWER vectors against the published RFC 6962 reference hashes.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  createPendingLedger,
  generatePassport,
  asEpochMs,
  asStrandId,
  createMerkleLog,
  signTreeHead,
  verifyTreeHead,
  verifyInclusion,
  verifyConsistency,
  detectSplitView,
  leafHashOfPreimage,
  nodeHash,
  EMPTY_TREE_ROOT,
  InMemoryPublicationSink,
  createSqlitePublicationSink,
} from "../index.js";

import type {
  AttributeKey,
  ContradictionSetId,
  Hash,
  KeyPair,
  MerkleLog,
  PendingLedger,
  PendingRatification,
  STH,
  StrandId,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;

/** A deferred dispute (the body does not matter here — we only need a real record). */
function pendingOf(n: number): PendingRatification {
  return {
    contradictionSetId: ("cset:" + n) as ContradictionSetId,
    attribute: ATTR,
    members: [asStrandId("strand:" + n)],
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

/** Build a ledger with `count` real PENDING records (the Merkle leaves). */
function ledgerWith(count: number, signer: KeyPair): PendingLedger {
  const ledger = createPendingLedger();
  for (let i = 0; i < count; i++) ledger.appendPending(pendingOf(i), signer);
  return ledger;
}

/** A MerkleLog over a fresh ledger of `count` records and two in-memory sinks. */
function merkleWith(count: number): {
  ledger: PendingLedger;
  signer: KeyPair;
  log: MerkleLog;
  sinkA: InMemoryPublicationSink;
  sinkB: InMemoryPublicationSink;
} {
  const signer = generatePassport();
  const ledger = ledgerWith(count, signer);
  const sinkA = new InMemoryPublicationSink();
  const sinkB = new InMemoryPublicationSink();
  const log = createMerkleLog({ ledger, signer, sinks: [sinkA, sinkB] });
  return { ledger, signer, log, sinkA, sinkB };
}

describe("RFC 6962 Merkle core — known-answer vectors", () => {
  it("empty tree root is sha256(\"\")", () => {
    expect(EMPTY_TREE_ROOT).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("a one-leaf root is the leaf hash; a two-leaf root is nodeHash(l0,l1)", () => {
    const { log } = merkleWith(2);
    const l0 = log.leafHashAt(0);
    const l1 = log.leafHashAt(1);
    expect(log.merkleRoot(1)).toBe(l0);
    expect(log.merkleRoot(2)).toBe(nodeHash(l0, l1));
  });

  it("leaf hashing uses the 0x00 domain prefix (RFC 6962 leaf vector)", () => {
    // RFC 6962: leaf hash of the empty leaf = sha256(0x00).
    expect(leafHashOfPreimage("")).toBe(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
  });
});

describe("INCLUSION proofs", () => {
  it("INVARIANT 1: every leaf has a proof that verifies against the live root", () => {
    const { log } = merkleWith(7); // odd, exercises the unbalanced split paths
    const root = log.merkleRoot();
    for (let i = 0; i < 7; i++) {
      const proof = log.inclusionProof(i);
      expect(proof.leafIndex).toBe(i);
      expect(proof.treeSize).toBe(7);
      expect(verifyInclusion(log.leafHashAt(i), proof, root)).toBe(true);
    }
  });

  it("INVARIANT 2: a TAMPERED leaf fails inclusion against the honest root", () => {
    const { log } = merkleWith(5);
    const root = log.merkleRoot();
    const proof = log.inclusionProof(2);

    // The honest leaf verifies; a tampered (different) leaf hash does not.
    expect(verifyInclusion(log.leafHashAt(2), proof, root)).toBe(true);
    const tampered: Hash = leafHashOfPreimage("a different record entirely");
    expect(verifyInclusion(tampered, proof, root)).toBe(false);
  });

  it("rejects a proof against the WRONG root and an out-of-range index", () => {
    const { log } = merkleWith(4);
    const proof = log.inclusionProof(1);
    const wrongRoot: Hash = "0".repeat(64);
    expect(verifyInclusion(log.leafHashAt(1), proof, wrongRoot)).toBe(false);
    // Out-of-range leaf index in the proof object.
    expect(
      verifyInclusion(log.leafHashAt(1), { ...proof, leafIndex: 99 }, log.merkleRoot()),
    ).toBe(false);
  });
});

describe("CONSISTENCY proofs", () => {
  it("INVARIANT 3: a consistency proof verifies a REAL append (every old ⊂ new)", () => {
    const { log } = merkleWith(8);
    const newRoot = log.merkleRoot(8);
    for (let oldSize = 1; oldSize < 8; oldSize++) {
      const oldRoot = log.merkleRoot(oldSize);
      const proof = log.consistencyProof(oldSize, 8);
      expect(verifyConsistency(oldRoot, oldSize, newRoot, 8, proof)).toBe(true);
    }
  });

  it("INVARIANT 4a: a ROLLBACK (newSize < oldSize) is REJECTED", () => {
    const { log } = merkleWith(6);
    const big = log.merkleRoot(6);
    const small = log.merkleRoot(3);
    // Claiming the size-6 tree "extends to" size 3 is a rollback.
    expect(verifyConsistency(big, 6, small, 3, [])).toBe(false);
  });

  it("INVARIANT 4b: a FORKED same-size tree is REJECTED", () => {
    const a = merkleWith(5);
    const proof = a.log.consistencyProof(3, 5);
    const oldRoot = a.log.merkleRoot(3);
    const newRoot = a.log.merkleRoot(5);
    // A genuinely different tree of the SAME new size (different signer ⇒ different
    // record preimages ⇒ different leaves) does not satisfy the proof.
    const b = merkleWith(5);
    const forkedNewRoot = b.log.merkleRoot(5);
    expect(forkedNewRoot).not.toBe(newRoot);
    expect(verifyConsistency(oldRoot, 3, forkedNewRoot, 5, proof)).toBe(false);
    // And a forked OLD root against the honest new root also fails.
    const forkedOldRoot = b.log.merkleRoot(3);
    expect(verifyConsistency(forkedOldRoot, 3, newRoot, 5, proof)).toBe(false);
  });

  it("edge cases: oldSize 0 is trivially consistent; equal sizes need equal roots", () => {
    const { log } = merkleWith(4);
    const root = log.merkleRoot(4);
    expect(verifyConsistency(EMPTY_TREE_ROOT, 0, root, 4, [])).toBe(true);
    expect(verifyConsistency(root, 4, root, 4, [])).toBe(true);
    expect(verifyConsistency("f".repeat(64), 4, root, 4, [])).toBe(false);
  });
});

describe("SIGNED TREE HEAD", () => {
  it("INVARIANT 5: an STH signs and verifies; a WRONG key fails", () => {
    const { log, signer } = merkleWith(3);
    const sth = log.signTreeHead(NOW);
    expect(sth.tree_size).toBe(3);
    expect(sth.root).toBe(log.merkleRoot(3));
    expect(verifyTreeHead(sth, signer.publicKeyPem)).toBe(true);

    const other = generatePassport();
    expect(verifyTreeHead(sth, other.publicKeyPem)).toBe(false);
  });

  it("a tampered STH (root or size flipped) fails verification", () => {
    const { log, signer } = merkleWith(3);
    const sth = log.signTreeHead(NOW);
    const tamperedRoot: STH = { ...sth, root: "0".repeat(64) };
    expect(verifyTreeHead(tamperedRoot, signer.publicKeyPem)).toBe(false);
    const tamperedSize: STH = { ...sth, tree_size: 99 };
    expect(verifyTreeHead(tamperedSize, signer.publicKeyPem)).toBe(false);
  });
});

describe("PUBLICATION + GENESIS", () => {
  it("INVARIANT 8: the GENESIS STH (size 0, empty root) is published to ≥2 sinks", () => {
    const { log, sinkA, sinkB, signer } = merkleWith(0);
    const genesis = log.publishGenesis(NOW);
    expect(genesis.tree_size).toBe(0);
    expect(genesis.root).toBe(EMPTY_TREE_ROOT);

    for (const sink of [sinkA, sinkB]) {
      const latest = sink.latest();
      expect(latest).not.toBeNull();
      expect(latest!.tree_size).toBe(0);
      expect(verifyTreeHead(latest!, signer.publicKeyPem)).toBe(true);
    }
  });

  it("anchor() publishes the current STH to every sink", () => {
    const { log, sinkA, sinkB } = merkleWith(4);
    const sth = log.anchor(NOW);
    expect(sinkA.latest()).toEqual(sth);
    expect(sinkB.latest()).toEqual(sth);
    expect(sinkA.history().length).toBe(1);
  });

  it("createMerkleLog requires at least 2 independent sinks", () => {
    const signer = generatePassport();
    const ledger = ledgerWith(1, signer);
    expect(() =>
      createMerkleLog({ ledger, signer, sinks: [new InMemoryPublicationSink()] }),
    ).toThrow(/at least 2/i);
  });
});

describe("SPLIT-VIEW equivocation", () => {
  it("INVARIANT 6: two same-size STHs with DIFFERENT roots are flagged", () => {
    // Two genuinely different trees of the same size, both validly signed by the SAME
    // log key, are non-repudiable proof of equivocation.
    const signer = generatePassport();
    const a = ledgerWith(3, signer);
    const b = createPendingLedger();
    for (let i = 0; i < 2; i++) b.appendPending(pendingOf(100 + i), signer);
    b.appendPending(pendingOf(999), signer); // 3 records, different content

    const rootA: Hash = createMerkleLog({
      ledger: a,
      signer,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    }).merkleRoot(3);
    const rootB: Hash = createMerkleLog({
      ledger: b,
      signer,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    }).merkleRoot(3);
    expect(rootA).not.toBe(rootB);

    const sthA = signTreeHead(signer, 3, rootA, NOW);
    const sthB = signTreeHead(signer, 3, rootB, NOW);

    const result = detectSplitView([sthA, sthB]);
    expect(result.detected).toBe(true);
    expect(result.reason).toBe("SAME_SIZE_DIFFERENT_ROOT");
    expect(result.conflicting).not.toBeNull();
    // Both conflicting STHs are validly signed — that is the non-repudiable proof.
    expect(verifyTreeHead(result.conflicting![0], signer.publicKeyPem)).toBe(true);
    expect(verifyTreeHead(result.conflicting![1], signer.publicKeyPem)).toBe(true);
  });

  it("a consistent, monotonically-growing STH stream is NOT flagged", () => {
    const { log } = merkleWith(5);
    // Honest STHs over real growing prefixes (size 1..5), all from the same tree.
    const honest: STH[] = [];
    for (let size = 1; size <= 5; size++) honest.push(log.signTreeHeadAt(size, NOW));
    expect(detectSplitView(honest).detected).toBe(false);
  });

  it("a NON-MONOTONIC size sequence (rollback) is flagged", () => {
    const { log } = merkleWith(5);
    const big = log.signTreeHeadAt(5, NOW);
    const small = log.signTreeHeadAt(2, NOW);
    expect(detectSplitView([big, small]).detected).toBe(true);
    expect(detectSplitView([big, small]).reason).toBe("NON_MONOTONIC");
  });
});

describe("WITNESS — rollback / deletion detection vs a published prior STH", () => {
  it("INVARIANT 7: a healthy append passes the witness; a ROLLBACK is detected", () => {
    // Phase 1: ledger has 3 records; publish an STH to both sinks (the witness now
    // holds a prior STH at size 3).
    const signer = generatePassport();
    const ledger = ledgerWith(3, signer);
    const sinkA = new InMemoryPublicationSink();
    const sinkB = new InMemoryPublicationSink();
    const log = createMerkleLog({ ledger, signer, sinks: [sinkA, sinkB] });
    log.anchor(NOW);

    // Phase 2: honest growth to 6 records — the operator can serve a valid consistency
    // proof, so the witness PASSES.
    for (let i = 0; i < 3; i++) ledger.appendPending(pendingOf(10 + i), signer);
    const healthy = log.witness(sinkA, NOW);
    expect(healthy.ok).toBe(true);
    expect(healthy.reason).toBe("OK");

    // Phase 3: the operator ROLLS BACK to a forked smaller log. We simulate the live
    // tree shrinking by building a NEW, smaller ledger and a log over it, while the
    // witness still holds the size-3 (now size-6) prior STH from the original sink.
    const rolledLedger = ledgerWith(2, signer); // smaller than the witnessed size 6
    const rolledLog = createMerkleLog({
      ledger: rolledLedger,
      signer,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    });
    // The witness presents sinkA's prior STH (size 6) to the rolled-back log.
    const caught = rolledLog.witness(sinkA, NOW);
    expect(caught.ok).toBe(false);
    expect(caught.reason).toBe("ROLLBACK_OR_DELETION");
    expect(caught.prior).not.toBeNull();
  });

  it("a WHOLE-LOG DELETION (empty live tree) is detected vs a published prior STH", () => {
    const signer = generatePassport();
    const ledger = ledgerWith(4, signer);
    const sinkA = new InMemoryPublicationSink();
    const sinkB = new InMemoryPublicationSink();
    const log = createMerkleLog({ ledger, signer, sinks: [sinkA, sinkB] });
    log.anchor(NOW); // witness holds a size-4 STH

    // Operator deletes the log: a fresh empty ledger.
    const emptyLedger = createPendingLedger();
    const emptyLog = createMerkleLog({
      ledger: emptyLedger,
      signer,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    });
    const result = emptyLog.witness(sinkA, NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ROLLBACK_OR_DELETION");
  });

  it("witness with NO prior STH reports NO_PRIOR_STH (cannot enforce yet)", () => {
    const { log, sinkA } = merkleWith(2);
    const result = log.witness(sinkA, NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_PRIOR_STH");
  });
});

describe("SQLite publication sink — durable, file-backed witness", () => {
  const paths: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const c of closers.splice(0)) {
      try {
        c();
      } catch {
        /* already closed */
      }
    }
    for (const base of paths.splice(0)) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(base + suffix, { force: true });
      }
    }
  });

  function freshPath(): string {
    const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const p = join(tmpdir(), `idb-merkle-sink-${unique}.db`);
    paths.push(p);
    return p;
  }

  it("publishes STHs that SURVIVE a reopen and still witness a rollback", () => {
    const signer = generatePassport();
    const ledger = ledgerWith(4, signer);
    const path = freshPath();

    // Two independent durable sinks (a real file + an in-memory peer).
    const fileSink = createSqlitePublicationSink({ path });
    closers.push(() => fileSink.close());
    const memSink = new InMemoryPublicationSink();
    const log = createMerkleLog({ ledger, signer, sinks: [fileSink, memSink] });

    log.publishGenesis(NOW); // genesis at init
    log.anchor(NOW); // size-4 STH

    expect(fileSink.history().length).toBe(2);
    expect(fileSink.history()[0]!.tree_size).toBe(0); // genesis
    expect(fileSink.latest()!.tree_size).toBe(4);
    fileSink.close();

    // Reopen the file sink: the witness still holds its prior STHs across a restart.
    const reopened = createSqlitePublicationSink({ path });
    closers.push(() => reopened.close());
    expect(reopened.history().length).toBe(2);
    const recovered = reopened.latest()!;
    expect(recovered.tree_size).toBe(4);
    expect(verifyTreeHead(recovered, signer.publicKeyPem)).toBe(true);

    // A rolled-back (smaller) live log is caught against the reopened sink's prior STH.
    const rolled = createMerkleLog({
      ledger: ledgerWith(1, signer),
      signer,
      sinks: [new InMemoryPublicationSink(), new InMemoryPublicationSink()],
    });
    const caught = rolled.witness(reopened, NOW);
    expect(caught.ok).toBe(false);
    expect(caught.reason).toBe("ROLLBACK_OR_DELETION");
  });
});
