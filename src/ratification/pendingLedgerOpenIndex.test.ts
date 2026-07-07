/**
 * pendingLedgerOpenIndex.test.ts — REGRESSION for `pending-ledger-full-scan-on-write-path`
 * (perf audit, CRITICAL): `PendingLedger`'s open-dispute lookups (`listPending()`'s
 * internal scan, the OD-2 horn rate-limit scan every `appendPending(..., opts)` runs,
 * and `approve()`'s dispute lookup) used to recompute "which PENDING records are still
 * open" from scratch — a full two-pass walk of the ENTIRE chain — on EVERY call,
 * including the IN-MEMORY default `createAgentMemory()` wires. Production's
 * `adjudicate()` DEFERRED branch ALWAYS supplies `opts` (api.ts), so every deferred
 * dispute append scaled with total ledger history, not with the current open-dispute
 * count.
 *
 * This file drives a LARGE number of real `appendPending`/`approve` calls through the
 * REAL public ledger interface (never reaching into private internals) on BOTH
 * backends, and proves via the REAL `listPending()` that the incrementally-maintained
 * index matches an INDEPENDENT full-scan reference computed from `records()` (the
 * ledger's own complete, public chain accessor) at every checkpoint — across appends,
 * across resolutions, and across a SQLite close+reopen. It also proves the SQLite
 * backend's write path no longer re-reads the whole table on every append (the
 * concrete manifestation of the audit's "hot write path" complaint).
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  createPendingLedger,
  createSqlitePendingLedger,
} from "../index.js";

import type {
  ApprovalPayload,
  ApproveContext,
  AttributeKey,
  ContradictionSetId,
  EdgeId,
  EpochMs,
  LedgerRecord,
  PendingLedger,
  PendingPayload,
  PendingRatification,
  SourceId,
  StrandId,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;

// --- temp db lifecycle -------------------------------------------------------

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-pendingidx-${tag}-${unique}.db`);
  paths.push(p);
  return p;
}

function track<T extends { close(): void }>(x: T): T {
  closers.push(() => {
    try {
      x.close();
    } catch {
      // already closed
    }
  });
  return x;
}

beforeEach(() => {
  paths = [];
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const base of paths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// --- fixtures ----------------------------------------------------------------

function pendingOf(csid: ContradictionSetId, members: StrandId[]): PendingRatification {
  return {
    contradictionSetId: csid,
    attribute: ATTR,
    members,
    reason: "INDEPENDENT_DISPUTE",
    createdAt: NOW,
  };
}

/** A no-store ApproveContext: the winner IS the only "loser-free" resolution path
 *  exercised here (winner == members[0]), so no store reads/writes are needed. */
function trivialCtx(): ApproveContext {
  return {
    authorsOf: (): readonly SourceId[] => [],
    memberStrand: () => null, // every OTHER member is a no-op skip (fail-closed, tested elsewhere)
    mintEdgeId: (winner: StrandId, loser: StrandId): EdgeId =>
      `edge:${String(winner)}->${String(loser)}` as EdgeId,
    independentSources: (): boolean => true,
    approverHasAnchors: (): boolean => true,
  };
}

/**
 * The INDEPENDENT full-scan reference oracle: exactly the semantics `listPending()`
 * document ("every PENDING whose contradictionSetId has no APPROVAL anywhere in the
 * chain"), computed directly from the ledger's own public `records()` accessor —
 * never touching the incremental index under test. This is the "full-scan reference"
 * the audit finding asks the regression to compare against.
 */
function fullScanOpenPending(records: readonly LedgerRecord[]): PendingPayload[] {
  const approved = new Set<string>();
  for (const r of records) {
    if (r.kind === "APPROVAL") {
      approved.add(String((r.payload as ApprovalPayload).contradictionSetId));
    }
  }
  const out: PendingPayload[] = [];
  for (const r of records) {
    if (r.kind !== "PENDING") continue;
    if (!approved.has(String((r.payload as PendingPayload).contradictionSetId))) {
      out.push(r.payload as PendingPayload);
    }
  }
  return out;
}

function sortByCsid(payloads: readonly PendingPayload[]): string[] {
  return payloads.map((p) => String(p.contradictionSetId)).sort();
}

const N = 1500; // "large" — pre-fix this makes each appendPending(opts) O(N) => O(N^2) total

/** Drive N appendPending(...,opts) calls (every one exercising the OD-2 horn
 *  rate-limit scan, mirroring api.ts's ALWAYS-supplied opts on the deferred path),
 *  then approve every 3rd dispute, leaving the rest open — across BOTH operations. */
function driveDisputes(ledger: PendingLedger, sys: SourceId, approver: SourceId): void {
  for (let i = 0; i < N; i++) {
    const csid = `cset:${i}` as ContradictionSetId;
    const a = asStrandId(`s:${i}:a`);
    const b = asStrandId(`s:${i}:b`);
    ledger.appendPending(pendingOf(csid, [a, b]), sys, {
      disputingSources: [`src:${i}:a` as SourceId, `src:${i}:b` as SourceId],
      coalesceKey: `coalesce:${i}`,
    });
  }
  for (let i = 0; i < N; i += 3) {
    const csid = `cset:${i}` as ContradictionSetId;
    const a = asStrandId(`s:${i}:a`);
    ledger.approve(csid, a, approver, NOW, trivialCtx());
  }
}

describe("PendingLedger open-dispute index — matches a full-scan reference across appends and resolutions", () => {
  it("in-memory: listPending() after 1500 appends + interleaved approvals matches the full-scan reference exactly", () => {
    const ledger = createPendingLedger();
    const sys = "src:system" as SourceId;
    const approver = "src:approver" as SourceId;

    driveDisputes(ledger, sys, approver);

    const reference = fullScanOpenPending(ledger.records());
    const real = ledger.listPending();

    // Sanity: this fixture actually produced a mix of open AND resolved disputes.
    expect(reference.length).toBeGreaterThan(0);
    expect(reference.length).toBeLessThan(N);
    expect(sortByCsid(real)).toEqual(sortByCsid(reference));

    // approve()'s own open-dispute lookup agrees with the reference too: every
    // reference-open csid is genuinely approvable (no spurious "already resolved"),
    // and every reference-closed csid genuinely throws "already resolved".
    const openSet = new Set(reference.map((p) => String(p.contradictionSetId)));
    for (let i = 0; i < N; i += 137) {
      const csid = `cset:${i}` as ContradictionSetId;
      const a = asStrandId(`s:${i}:a`);
      if (openSet.has(String(csid))) {
        expect(() => ledger.approve(csid, a, approver, NOW, trivialCtx())).not.toThrow();
      } else {
        expect(() => ledger.approve(csid, a, approver, NOW, trivialCtx())).toThrow(/already resolved/);
      }
    }
  });

  it("SQLite: listPending() after 1500 appends + interleaved approvals matches the full-scan reference, survives a close+reopen, and the write path no longer rescans the whole table", () => {
    const path = freshPath("pending");
    const ledger = track(createSqlitePendingLedger({ path }));
    const sys = "src:system" as SourceId;
    const approver = "src:approver" as SourceId;

    const start = performance.now();
    driveDisputes(ledger, sys, approver);
    const elapsedMs = performance.now() - start;

    const reference = fullScanOpenPending(ledger.records());
    const real = ledger.listPending();
    expect(reference.length).toBeGreaterThan(0);
    expect(reference.length).toBeLessThan(N);
    expect(sortByCsid(real)).toEqual(sortByCsid(reference));

    // STRUCTURAL/PERFORMANCE PROOF the write path no longer rescans the whole table
    // on every append: N appends each carrying `opts` (so each one runs the OD-2
    // open-pending scan) complete quickly. Pre-fix, EVERY append re-read + re-parsed
    // up to N growing rows from disk (O(N) per call => O(N^2) total); at N=1500 that
    // is several million row reads and reliably takes multiple SECONDS. Post-fix,
    // each append is an O(1) amortized index update, so the whole run is fast. The
    // bound below is generous (well over 10x the observed post-fix time) specifically
    // so it fails only against the O(N^2) shape, never on incidental machine noise.
    expect(elapsedMs).toBeLessThan(3000);

    // Close + REOPEN on the SAME file: the one-time index rebuild at construction
    // must reproduce the identical open-dispute set from the persisted chain.
    ledger.close();
    const reopened = track(createSqlitePendingLedger({ path }));
    const referenceAfterReopen = fullScanOpenPending(reopened.records());
    const realAfterReopen = reopened.listPending();
    expect(sortByCsid(realAfterReopen)).toEqual(sortByCsid(referenceAfterReopen));
    expect(sortByCsid(realAfterReopen)).toEqual(sortByCsid(reference));

    // And the reopened ledger's approve() still agrees with the reference for a
    // spot-check of both open and already-resolved csids.
    const openSet = new Set(referenceAfterReopen.map((p) => String(p.contradictionSetId)));
    for (let i = 0; i < N; i += 211) {
      const csid = `cset:${i}` as ContradictionSetId;
      const a = asStrandId(`s:${i}:a`);
      if (openSet.has(String(csid))) {
        expect(() => reopened.approve(csid, a, approver, NOW, trivialCtx())).not.toThrow();
      } else {
        expect(() => reopened.approve(csid, a, approver, NOW, trivialCtx())).toThrow(/already resolved/);
      }
    }
  });
});
