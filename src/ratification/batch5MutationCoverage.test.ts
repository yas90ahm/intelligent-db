/**
 * batch5MutationCoverage.test.ts — JUNIOR additive coverage for batch 5 (A1).
 *
 * The senior's `batch5Mutation.test.ts` proves appendMutation chains + byte-flip
 * naming and the engine's disown EFFECT coverage. This file adds the V1-contrast
 * check, re-expressed crypto-free over the checksum chain + checkpoint:
 *
 *   (b/V1-contrast) a HIDDEN disown (the operator truncates the chain back to the
 *       pre-disown prefix) leaves the chain's own `verifyChain()` GREEN — exactly
 *       the V1 hole where a demotion had no committed record, and exactly the
 *       honest-disclosure limit of a checksum chain (a writer with the pen can
 *       present a consistent shorter history). The EXTERNAL `chainHead()`
 *       CHECKPOINT, exported to access-segregated storage after the disown, is
 *       what detects it: the truncated chain can never reproduce the checkpointed
 *       `{seq, headHash}` (and any record it re-appends at that seq diverges,
 *       because the checksum commits to the erased MUTATION records).
 *
 * HONEST LIMIT (carried): detection rests on the operator actually EXPORTING the
 * checkpoint to storage the writing process cannot reach. Without a live external
 * checkpoint there is no insider-tamper evidence — stated, not papered over.
 *
 * STACK NOTE: ESM + NodeNext (`.js` on relative imports); `verbatimModuleSyntax`
 * (type-only imports use `import type`).
 */

import { describe, it, expect } from "vitest";
import { freshSource } from "../testSupport/identityFixtures.js";

import { createPendingLedger, asEpochMs } from "../index.js";

import type { MutationPayload, PendingRatification } from "../index.js";

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

function pendingOf(n: number): PendingRatification {
  return {
    contradictionSetId: ("cset:" + n) as PendingRatification["contradictionSetId"],
    attribute: "berlin#capital_of" as PendingRatification["attribute"],
    members: [("strand:" + n) as PendingRatification["members"][number]],
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

describe("(b) hide-a-disown — verifyChain stays GREEN (the disclosed limit) but the exported checkpoint detects it", () => {
  it("truncating away the MUTATION records yields a still-valid chain that cannot reproduce the checkpointed head", () => {
    const systemSource = freshSource().sourceId;

    // FULL ledger = pre-disown doorbell traffic (2 PENDING) + the disown's EFFECT
    // records (DISOWN_CRATER + DEMOTE). The canonical form is deterministic, so
    // identical (kind, payload, signer) appends produce BYTE-IDENTICAL records ⇒
    // the surviving prefix matches the hidden ledger's exactly.
    const full = createPendingLedger();
    full.appendPending(pendingOf(0), systemSource);
    full.appendPending(pendingOf(1), systemSource);
    full.appendMutation(mut("DISOWN_CRATER", 2), systemSource);
    full.appendMutation(mut("DEMOTE", 3), systemSource);
    expect(full.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });

    // EXPORT the post-disown CHECKPOINT — what an honest operator ships to
    // access-segregated storage (plain data; the writing process can't reach it).
    const checkpoint = full.chainHead();
    expect(checkpoint.seq).toBe(3);
    expect(checkpoint.headHash).toBe(full.records()[3]!.thisHash);

    // HIDE THE DISOWN: the operator presents only the pre-disown prefix (the 2
    // PENDING), the DISOWN_CRATER + DEMOTE records erased.
    const hidden = createPendingLedger();
    hidden.appendPending(pendingOf(0), systemSource);
    hidden.appendPending(pendingOf(1), systemSource);

    // V1 HOLE / DISCLOSED LIMIT: the hidden chain is a perfectly valid prefix —
    // its OWN verifyChain is GREEN. The erasure is invisible to the chain verifier.
    expect(hidden.verifyChain()).toEqual({ ok: true, firstBrokenSeq: null });
    // The two surviving records are byte-identical to the full chain's first two
    // (proving the operator only TRUNCATED — exactly the hideable rollback).
    expect(hidden.records()[0]!.thisHash).toBe(full.records()[0]!.thisHash);
    expect(hidden.records()[1]!.thisHash).toBe(full.records()[1]!.thisHash);

    // THE FIX: the externally-stored checkpoint exposes the truncation — the hidden
    // chain's head is at the wrong seq with the wrong hash, and it can NEVER
    // re-reach the checkpointed head without re-committing the erased records
    // (whose checksums the checkpoint transitively pins via the prevHash chain).
    const hiddenHead = hidden.chainHead();
    expect(hiddenHead.seq).not.toBe(checkpoint.seq);
    expect(hiddenHead.headHash).not.toBe(checkpoint.headHash);

    // Even a REWRITTEN history of the same LENGTH (the disown swapped for benign
    // padding) cannot match: the checkpointed head commits to the erased records.
    const padded = createPendingLedger();
    padded.appendPending(pendingOf(0), systemSource);
    padded.appendPending(pendingOf(1), systemSource);
    padded.appendMutation(mut("REPUTATION_RATIFY", 2), systemSource);
    padded.appendMutation(mut("REPUTATION_RATIFY", 3), systemSource);
    expect(padded.verifyChain().ok).toBe(true); // internally consistent...
    const paddedHead = padded.chainHead();
    expect(paddedHead.seq).toBe(checkpoint.seq); // ...same length...
    expect(paddedHead.headHash).not.toBe(checkpoint.headHash); // ...but exposed.
  });
});
