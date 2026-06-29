/**
 * batch5MutationCoverage.test.ts — JUNIOR additive coverage for batch 5 (A1/A2).
 *
 * The senior's `batch5Mutation.test.ts` proves appendMutation chains + byte-flip naming,
 * the leaf-cache BYTE-IDENTITY regression, the engine `mk-m3` hide-a-disown via the
 * Merkle witness, and the A2-omitted back-compat. This file adds the two checks the
 * brief called out that were NOT yet asserted as such:
 *
 *   (d) the leaf-cache makes `anchor()` over N records O(N), NOT O(N²) — a deterministic
 *       CALL-COUNT assertion (count the per-record property reads = leaf-hash work), plus
 *       a linear-SCALING assertion (cost at 2N is ~2× the cost at N, not ~4×). This is the
 *       regression contract for the O(n²) `anchor()` close, expressed as cost, not output.
 *
 *   (b/V1-contrast) a HIDDEN disown (the operator drops the MUTATION leaves) leaves the
 *       hash-chain's own `verifyChain()` GREEN — exactly the V1 hole where a demotion had
 *       no leaf — yet the external Merkle WITNESS, holding the post-disown STH, detects the
 *       shrunken tree as ROLLBACK_OR_DELETION. The MUTATION leaves are what the witness can
 *       no longer be shown a consistency proof to. Engine-free (pure ledger + merkle) so it
 *       isolates the audit-layer property from the undo engine.
 *
 * HONEST LIMIT (carried): this is COVERAGE of the cost + detection properties. It does not
 * close mk-m2 (a single signer can re-sign a coherent forged tree from genesis) or mk-m5
 * (no live external witnesses — sinks are in-memory test impls).
 *
 * STACK NOTE: ESM + NodeNext (`.js` on relative imports); `verbatimModuleSyntax`
 * (type-only imports use `import type`); `node:crypto` only via the libs under test.
 */

import { describe, it, expect } from "vitest";

import {
  createPendingLedger,
  createMerkleLog,
  InMemoryPublicationSink,
  verifyInclusion,
  generatePassport,
  asEpochMs,
} from "../index.js";

import type {
  LedgerRecord,
  MutationPayload,
  PendingRatification,
  PendingLedger,
  KeyPair,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);

/** A content-addressed MUTATION payload (the disown-engine receipt shape). */
function mut(op: MutationPayload["op"], n: number): MutationPayload {
  return {
    op,
    subjectId: "subj:" + n,
    subjectHash: "sh:" + n,
    beforeHash: "bh:" + n,
    afterHash: "ah:" + n,
    at: NOW,
  };
}

/** Two throwaway sinks (createMerkleLog fail-closes below 2). */
function sinkPair(): [InMemoryPublicationSink, InMemoryPublicationSink] {
  return [new InMemoryPublicationSink(), new InMemoryPublicationSink()];
}

// ---------------------------------------------------------------------------
// (d) — anchor() over N records is O(N), proven by COUNTING leaf-hash work
// ---------------------------------------------------------------------------

/**
 * A read-only {@link PendingLedger} VIEW over a fixed record slice whose visible length
 * GROWS via `reveal`, and whose every per-record property read is counted. `leafHashOf`
 * reads a fixed number of fields per record (`recordPreimage`), so the count is EXACTLY
 * (fields-per-record × leaves-actually-hashed) — i.e. it measures leaf-hash work, the
 * dominant SHA cost the cache exists to bound.
 */
function countingView(
  records: readonly LedgerRecord[],
): { ledger: PendingLedger; reveal: (k: number) => void; counter: { n: number } } {
  const counter = { n: 0 };
  let visible = 0;
  const proxied = records.map(
    (r) =>
      new Proxy(r, {
        get(target, prop, recv): unknown {
          counter.n++;
          return Reflect.get(target, prop, recv);
        },
      }),
  );
  const stub = (): never => {
    throw new Error("countingView: write op not supported on a read-only view");
  };
  const ledger = {
    records: () => proxied.slice(0, visible),
    appendPending: stub,
    appendMutation: stub,
    listPending: () => [],
    approve: stub,
    verifyChain: () => ({ ok: true, firstBrokenSeq: null }),
  } as unknown as PendingLedger;
  return { ledger, reveal: (k: number) => void (visible = k), counter };
}

/** Build N real, signed MUTATION records to anchor over. */
function buildRecords(n: number, signer: KeyPair): readonly LedgerRecord[] {
  const real = createPendingLedger();
  for (let i = 0; i < n; i++) real.appendMutation(mut("DEMOTE", i), signer);
  return [...real.records()];
}

/**
 * Drive the CACHED path: ONE MerkleLog, `anchor()` after revealing each next record
 * (the epoch-cadence anchoring an operator does). With the incremental `#leafCache`,
 * each record's fields are read EXACTLY ONCE across the whole run ⇒ total reads ∝ N.
 */
function cachedAnchorReads(n: number, signer: KeyPair): number {
  const records = buildRecords(n, signer);
  const { ledger, reveal, counter } = countingView(records);
  const log = createMerkleLog({ ledger, signer, sinks: sinkPair() });
  for (let k = 1; k <= n; k++) {
    reveal(k);
    log.anchor(NOW);
  }
  return counter.n;
}

describe("(d) leaf-cache — anchor() over N records is O(N), not O(N²)", () => {
  it("a CACHED log re-reads each record once; a fresh-per-epoch log is quadratic", () => {
    const signer = generatePassport();
    const N = 64;

    // CACHED: one log, anchored each epoch. Total record-field reads are LINEAR in N.
    const cached = cachedAnchorReads(N, signer);

    // CONTROL — no cache reuse: a FRESH MerkleLog every epoch must re-hash every revealed
    // leaf from scratch ⇒ Σ_{k=1..N} k = N(N+1)/2 leaf hashes ⇒ quadratic field reads.
    const records = buildRecords(N, signer);
    const { ledger, reveal, counter } = countingView(records);
    for (let k = 1; k <= N; k++) {
      reveal(k);
      createMerkleLog({ ledger, signer, sinks: sinkPair() }).anchor(NOW);
    }
    const fresh = counter.n;

    // The cached path is LINEAR: each of N records read a small constant number of times.
    expect(cached).toBeGreaterThan(0);
    expect(cached).toBeLessThanOrEqual(8 * N);

    // The quadratic control blows up relative to the cached path — the gap is the defused
    // O(N²). For N=64 the ratio ≈ (N+1)/2 ≈ 32×; assert it is at least order-N/4.
    expect(fresh).toBeGreaterThan(cached * (N / 4));
  });

  it("cached anchor cost SCALES LINEARLY: cost(2N) ≈ 2 × cost(N) (not 4×)", () => {
    const signer = generatePassport();
    const at1 = cachedAnchorReads(50, signer);
    const at2 = cachedAnchorReads(100, signer);
    const ratio = at2 / at1;
    // Linear ⇒ ratio ≈ 2. An O(N²) anchor would land near 4. Band it well clear of 4.
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.6);
  });
});

// ---------------------------------------------------------------------------
// (b / V1-contrast) — a hidden disown leaves verifyChain GREEN but the witness catches it
// ---------------------------------------------------------------------------

/** A read-only {@link PendingLedger} view over a fixed record slice (the hidden tree). */
function ledgerView(records: readonly LedgerRecord[]): PendingLedger {
  const stub = (): never => {
    throw new Error("ledgerView: write op not supported on a read-only view");
  };
  return {
    records: () => records,
    appendPending: stub,
    appendMutation: stub,
    listPending: () => [],
    approve: stub,
    verifyChain: () => ({ ok: true, firstBrokenSeq: null }),
  } as unknown as PendingLedger;
}

function pendingOf(n: number): PendingRatification {
  return {
    contradictionSetId: ("cset:" + n) as PendingRatification["contradictionSetId"],
    attribute: "berlin#capital_of" as PendingRatification["attribute"],
    members: [("strand:" + n) as PendingRatification["members"][number]],
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

describe("(b) hide-a-disown — verifyChain stays GREEN (V1 hole) but the Merkle witness detects it (V2 fix)", () => {
  it("dropping the MUTATION leaves yields a still-valid chain that the witness flags as ROLLBACK_OR_DELETION", () => {
    const systemSigner = generatePassport();
    const merkleSigner = generatePassport();

    // FULL ledger = pre-disown doorbell traffic (2 PENDING) + the disown's EFFECT leaves
    // (DISOWN_CRATER + DEMOTE). Ed25519 is deterministic, so identical (kind,payload,signer)
    // appends produce BYTE-IDENTICAL records ⇒ the prefix leaves match the hidden ledger's.
    const full = createPendingLedger();
    full.appendPending(pendingOf(0), systemSigner);
    full.appendPending(pendingOf(1), systemSigner);
    full.appendMutation(mut("DISOWN_CRATER", 2), systemSigner);
    full.appendMutation(mut("DEMOTE", 3), systemSigner);
    expect(full.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // Anchor the POST-disown STH₁ (tree_size 4) to both sinks — what an honest witness holds.
    const [sinkA, sinkB] = sinkPair();
    const fullLog = createMerkleLog({ ledger: full, signer: merkleSigner, sinks: [sinkA, sinkB] });
    const sth1 = fullLog.anchor(NOW);
    expect(sth1.tree_size).toBe(4);
    expect(sinkA.latest()!.tree_size).toBe(4);
    expect(sinkB.latest()!.tree_size).toBe(4);

    // (a-style) the DEMOTE leaf is inclusion-provable under the anchored root.
    const demoteSeq = full
      .records()
      .findIndex((r) => r.kind === "MUTATION" && (r.payload as MutationPayload).op === "DEMOTE");
    expect(demoteSeq).toBeGreaterThanOrEqual(0);
    const proof = fullLog.inclusionProof(demoteSeq);
    expect(verifyInclusion(fullLog.leafHashAt(demoteSeq), proof, sth1.root)).toBe(true);

    // HIDE THE DISOWN: the operator presents only the pre-disown prefix (the 2 PENDING),
    // the DISOWN_CRATER + DEMOTE leaves erased. Build that hidden ledger by appending ONLY
    // the surviving records with the SAME key (byte-identical prefix, deterministic sigs).
    const hidden = createPendingLedger();
    hidden.appendPending(pendingOf(0), systemSigner);
    hidden.appendPending(pendingOf(1), systemSigner);

    // V1 HOLE: the hidden chain is a perfectly valid prefix — its OWN verifyChain is GREEN.
    // A demotion had no leaf in V1, so this erasure is invisible to the chain verifier.
    expect(hidden.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // The two surviving leaves are byte-identical to the full tree's first two leaves
    // (proving the operator only TRUNCATED — exactly the hideable rollback).
    expect(hidden.records()[0]!.thisHash).toBe(full.records()[0]!.thisHash);
    expect(hidden.records()[1]!.thisHash).toBe(full.records()[1]!.thisHash);

    // V2 FIX: a witness holding STH₁ (size 4) checks the operator's hidden tree (size 2).
    // The operator re-signs with the same log key (mk-m2 residual), but cannot extend the
    // prior STH — the smaller tree is DETECTED as a rollback/deletion.
    const hiddenLog = createMerkleLog({
      ledger: ledgerView(hidden.records()),
      signer: merkleSigner,
      sinks: sinkPair(),
    });
    const caught = hiddenLog.witness(sinkA, NOW);
    expect(caught.ok).toBe(false);
    expect(caught.reason).toBe("ROLLBACK_OR_DELETION");

    // And the honest full log still witnesses OK against the same sink (no false positive).
    const honest = fullLog.witness(sinkA, NOW);
    expect(honest.ok).toBe(true);
    expect(honest.reason).toBe("OK");
  });
});
