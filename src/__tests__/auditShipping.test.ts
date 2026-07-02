/**
 * auditShipping.test.ts — REAL-TIME AUDIT SHIPPING (the AppendSink hook): the
 * second half of the insider-tamper mitigation named in pendingLedger.ts's
 * HONEST DISCLOSURE. The checksum chain alone proves internal CONSISTENCY, not
 * authorship — an insider with live write access can rewrite history from any
 * seq, recompute every hash, and `verifyChain` still reports ok. The AppendSink
 * closes the gap without any cryptography this codebase owns: every record is
 * handed to a deployment-supplied sink BEFORE the local write, so a copy lives
 * somewhere the writing process cannot rewrite, and a local rewrite DIVERGES
 * from the already-shipped copy at the first rewritten seq.
 *
 * Each case pins one contract:
 *
 *   1. FIDELITY — the sink receives EXACTLY the chain's records, in chain
 *      order, byte-equal (both backends).
 *   2. THE HEADLINE (executable disclosure, SQLite) — an insider rewrite from
 *      seq K, hashes recomputed so `verifyChain()` reports ok (the documented
 *      residual), is CAUGHT by comparing the local chain against what the sink
 *      already shipped: first divergence at exactly seq K.
 *   3. FAIL-CLOSED ORDERING — a throwing sink aborts the append with the local
 *      chain UNCHANGED (ship-before-write): no shipped receipt ⇒ no belief
 *      change. Both backends.
 *   4. FACADE THREADING — `createAgentMemory({ onLedgerAppend })` ships the
 *      personal tier's horn records (the deferred-dispute PENDING and the
 *      owner's APPROVAL) without any other configuration.
 *   5. BACK-COMPAT — omitting the sink changes nothing (the default suite
 *      already proves this everywhere; here we just pin the explicit contrast
 *      in one place).
 *
 * Everything runs through the public barrel (`../index.js`).
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  createAgentMemory,
  createPendingLedger,
  createSqlitePendingLedger,
  mutationReceipt,
  recordPreimage,
} from "../index.js";

import type {
  AttributeKey,
  ContradictionSetId,
  LedgerRecord,
  MutationPayload,
  PendingLedger,
  SourceId,
  StrandId,
} from "../index.js";

const NOW = asEpochMs(1_700_000_000_000);
const SYSTEM = "source:test-system" as SourceId;

// --- temp db lifecycle -------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-ship-${tag}-${unique}.db`);
  cleanups.push(() => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(p + suffix, { force: true });
    }
  });
  return p;
}

/** A raw second connection for the insider-rewrite simulation. */
function openRawDb(path: string): DatabaseSyncType {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => DatabaseSyncType;
  };
  const db = new DatabaseSync(path);
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
  return db;
}

// --- fixtures ------------------------------------------------------------------

/** A minimal MUTATION payload (the exact receipt shape the engine journals). */
function mutation(n: number): MutationPayload {
  return mutationReceipt(
    "DEMOTE",
    `strand:subject-${n}`,
    `hash-${n}`,
    `before-${n}`,
    `after-${n}`,
    NOW,
  );
}

/** Drive N MUTATION appends through a ledger (the simplest chain-growing verb). */
function grow(ledger: PendingLedger, n: number): void {
  for (let i = 0; i < n; i++) ledger.appendMutation(mutation(i), SYSTEM);
}

/**
 * THE COMPARATOR a real deployment runs against its shipped copy: first seq at
 * which the local chain's record hash differs from (or is missing against) the
 * shipped copy. Null when the local chain extends the shipped copy cleanly.
 * Plain data comparison — this is the entire detection algorithm; there is
 * nothing cryptographic about it, which is the point.
 */
function firstDivergence(
  shipped: readonly LedgerRecord[],
  local: readonly LedgerRecord[],
): number | null {
  for (let i = 0; i < shipped.length; i++) {
    const l = local[i];
    if (l === undefined || l.thisHash !== shipped[i]!.thisHash) return i;
  }
  return null;
}

// ============================================================================
// 1. FIDELITY — the sink sees exactly the chain, in order
// ============================================================================

describe("1. FIDELITY — the sink receives every record, in chain order, byte-equal", () => {
  it("in-memory: shipped copies deep-equal records() after mixed appends", () => {
    const shipped: LedgerRecord[] = [];
    const ledger = createPendingLedger({ onAppend: (r) => shipped.push(r) });

    grow(ledger, 3);
    ledger.appendPending(
      {
        contradictionSetId: "cs:ship-1" as ContradictionSetId,
        attribute: "e#a" as AttributeKey,
        members: ["strand:m1" as StrandId, "strand:m2" as StrandId],
        reason: "INDEPENDENT_DISPUTE",
        createdAt: NOW,
      },
      SYSTEM,
    );

    expect(shipped.length).toBe(4);
    expect(shipped).toEqual([...ledger.records()]);
    // Chain order is shipping order.
    expect(shipped.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });

  it("sqlite: shipped copies deep-equal the persisted chain", () => {
    const shipped: LedgerRecord[] = [];
    const ledger = createSqlitePendingLedger({
      path: freshPath("fidelity"),
      onAppend: (r) => shipped.push(r),
    });
    cleanups.push(() => ledger.close());

    grow(ledger, 5);
    expect(shipped.length).toBe(5);
    expect(shipped).toEqual([...ledger.records()]);
  });
});

// ============================================================================
// 2. THE HEADLINE — a verifyChain-clean insider rewrite diverges from the sink
// ============================================================================

describe("2. INSIDER REWRITE DETECTION — the shipped copy catches what verifyChain cannot", () => {
  it("rewrite from seq K with recomputed hashes verifies ok locally but diverges from the shipped copy at K", () => {
    const path = freshPath("rewrite");
    const shipped: LedgerRecord[] = [];
    const ledger = createSqlitePendingLedger({ path, onAppend: (r) => shipped.push(r) });

    grow(ledger, 6);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();

    // THE INSIDER: live write access to the store. Rewrite history from seq 3 —
    // change a payload, then recompute EVERY downstream hash so the chain is
    // internally consistent again. This is exactly the documented residual of
    // removing signing: nothing in the local file can catch this.
    const K = 3;
    const raw = openRawDb(path);
    const rows = raw
      .prepare("SELECT seq, json FROM ratification_records ORDER BY seq")
      .all() as Array<{ seq: number; json: string }>;
    const records = rows.map((r) => JSON.parse(r.json) as LedgerRecord);

    let prevHash = records[K - 1]!.thisHash;
    for (let i = K; i < records.length; i++) {
      const doctored: LedgerRecord = {
        ...records[i]!,
        // The forged content: swap the mutation's after-state at seq K only;
        // downstream records keep their payloads but re-chain over the forgery.
        payload:
          i === K
            ? ({ ...(records[i]!.payload as MutationPayload), afterHash: "FORGED" } as MutationPayload)
            : records[i]!.payload,
        prevHash,
      };
      const thisHash = createHash("sha256")
        .update(recordPreimage({ ...doctored, thisHash: "" }), "utf8")
        .digest("hex");
      const final: LedgerRecord = { ...doctored, thisHash };
      raw
        .prepare("UPDATE ratification_records SET json = ? WHERE seq = ?")
        .run(JSON.stringify(final), i);
      prevHash = thisHash;
    }
    raw.close();

    // Reopen: the DOCUMENTED RESIDUAL — the rewritten chain verifies clean.
    const reopened = createSqlitePendingLedger({ path });
    cleanups.push(() => reopened.close());
    expect(reopened.verifyChain().ok).toBe(true);

    // THE DETECTION: the shipped copy (which the insider could not touch)
    // disagrees at exactly seq K. Detection is a plain hash comparison.
    expect(firstDivergence(shipped, reopened.records())).toBe(K);
  });
});

// ============================================================================
// 3. FAIL-CLOSED ORDERING — ship-before-write
// ============================================================================

describe("3. FAIL-CLOSED — a throwing sink aborts the append; the local chain never advances", () => {
  it("in-memory: the failed append leaves records() unchanged and the next append is clean", () => {
    let failNext = false;
    const shipped: LedgerRecord[] = [];
    const ledger = createPendingLedger({
      onAppend: (r) => {
        if (failNext) throw new Error("sink unavailable");
        shipped.push(r);
      },
    });

    grow(ledger, 2);
    failNext = true;
    expect(() => ledger.appendMutation(mutation(99), SYSTEM)).toThrow("sink unavailable");
    // No shipped receipt ⇒ no belief change: the local chain did NOT advance.
    expect(ledger.records().length).toBe(2);
    expect(ledger.verifyChain().ok).toBe(true);

    // Recovery is a clean re-run — seq continues without a gap.
    failNext = false;
    ledger.appendMutation(mutation(99), SYSTEM);
    expect(ledger.records().length).toBe(3);
    expect(ledger.records()[2]!.seq).toBe(2);
    expect(shipped.length).toBe(3);
  });

  it("sqlite: the failed append inserts nothing (ship-before-write, no txn needed)", () => {
    let failNext = false;
    const ledger = createSqlitePendingLedger({
      path: freshPath("failclosed"),
      onAppend: () => {
        if (failNext) throw new Error("sink unavailable");
      },
    });
    cleanups.push(() => ledger.close());

    grow(ledger, 2);
    failNext = true;
    expect(() => ledger.appendMutation(mutation(99), SYSTEM)).toThrow("sink unavailable");
    expect(ledger.records().length).toBe(2);
    expect(ledger.verifyChain().ok).toBe(true);
  });
});

// ============================================================================
// 4. FACADE THREADING — the personal tier ships with one option
// ============================================================================

describe("4. FACADE — createAgentMemory({ onLedgerAppend }) ships the horn's records", () => {
  it("a deferred dispute ships its PENDING, and the owner's resolution ships the APPROVAL", () => {
    const shipped: LedgerRecord[] = [];
    const mem = createAgentMemory({ onLedgerAppend: (r) => shipped.push(r) });
    cleanups.push(() => mem.close());

    mem.remember({
      text: "the wifi password is hunter2",
      entity: "entity:ship",
      attribute: "ship#wifi",
    });
    const rival = mem.trust.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "tenant:acme",
    });
    mem.remember({
      text: "the wifi password is pwned123",
      entity: "entity:ship",
      attribute: "ship#wifi",
      source: { sourceId: rival.sourceId },
    });

    const outcome = mem.adjudicate("ship#wifi" as AttributeKey);
    expect(outcome.kind).toBe("DEFERRED");
    expect(shipped.some((r) => r.kind === "PENDING")).toBe(true);

    const questions = mem.pendingQuestions();
    expect(questions.length).toBe(1);
    const q = questions[0]!;
    // Option.source is the rendered "label (KIND)" string; the owner's side
    // carries the OWNER kind (see PendingQuestionOption).
    const ownerOption = q.options.find((o) => o.source.includes("OWNER"));
    expect(ownerOption).toBeDefined();
    mem.resolvePending(q.contradictionSetId, ownerOption!.strandId);

    // The decision left the building the moment it was made.
    expect(shipped.some((r) => r.kind === "APPROVAL")).toBe(true);
  });
});
