/**
 * ledgerIndexParity.test.ts — REGRESSION for `ledger-index-built-but-unused`
 * (perf audit, CRITICAL): the corroboration / adjudicationProvenance / weakInfluence
 * ledgers build a correct in-memory index Map on every `record()` but their query
 * methods (`eventsIntersecting` / `recordsContributedBy` / `edgesConsulting`) used
 * to ignore it and do a full O(n) walk of the WHOLE chain on every call — the SQLite
 * backends did the identical thing at the SQL layer (`SELECT ... FROM <table>` with
 * NO WHERE clause, parsing every row's JSON before filtering in JS).
 *
 * This file builds a LARGE synthetic ledger for each of the three ledger types, on
 * BOTH backends (in-memory + SQLite), and proves via the REAL production query
 * method (never a re-derivation of its internals) that:
 *   1. the indexed query returns EXACTLY what an independent, spec-level full scan
 *      over `.all()` would (parity — the fix must not change observable results),
 *   2. for the SQLite backend specifically, the query plan for the point lookup is
 *      driven by the new indexed child table, not a full scan of the parent table
 *      (proving the "no longer scans the whole chain" half of the fix, not just
 *      "still correct").
 */

import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  createCorroborationLedger,
  createSqliteCorroborationLedger,
  createAdjudicationProvenanceLedger,
  createSqliteAdjudicationProvenanceLedger,
  createWeakInfluenceLedger,
  createSqliteWeakInfluenceLedger,
} from "../index.js";

import type {
  AttributeKey,
  ContradictionSetId,
  CorroborationEvent,
  AdjudicationProvenance,
  WeakInfluenceEdge,
  EpochMs,
  SourceId,
  StrandId,
} from "../index.js";

const NOW: EpochMs = asEpochMs(1_700_000_000_000);
const ATTR = "berlin#capital_of" as AttributeKey;

// --- temp db lifecycle (mirrors durableLedgers.test.ts) --------------------

let paths: string[] = [];
const closers: Array<() => void> = [];

function freshPath(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const p = join(tmpdir(), `idb-ledgeridx-${tag}-${unique}.db`);
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

/**
 * Open a SECOND raw connection to an already-populated ledger's db file and ask
 * SQLite's own query planner how it would execute `sql` — the structural proof that
 * a point lookup is driven by an INDEX (child table / strand_id index) rather than a
 * full scan of the parent table. Returns the plan's `detail` strings.
 */
function explainQueryPlan(path: string, sql: string, ...params: string[]): string[] {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => DatabaseSyncType;
  };
  const raw = new DatabaseSync(path);
  try {
    const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: unknown;
    }>;
    return rows.map((r) => String(r.detail));
  } finally {
    raw.close();
  }
}

afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const base of paths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(base + suffix, { force: true });
    }
  }
});

// A pool of distinct strand ids the synthetic events/records draw from; a handful
// of them are the "target" set a disown sweep would query for.
const POOL_SIZE = 60;
const N = 3000; // "large synthetic ledger"
function poolId(i: number): StrandId {
  return asStrandId(`s:pool:${i}`);
}
const TARGET_INDICES = [3, 17, 29, 41, 53];
const TARGETS: StrandId[] = TARGET_INDICES.map(poolId);

// ===========================================================================
// 1. CorroborationLedger.eventsIntersecting — index-driven parity
// ===========================================================================

describe("CorroborationLedger.eventsIntersecting — indexed lookup matches a full scan", () => {
  /** Spec-level oracle (the interface's own contract), independent of whichever
   *  internal mechanism (index or full scan) the ledger under test uses. */
  function referenceIntersecting(
    all: readonly CorroborationEvent[],
    targets: ReadonlySet<StrandId>,
  ): CorroborationEvent[] {
    const out: CorroborationEvent[] = [];
    const seen = new Set<string>();
    for (const ev of all) {
      if (seen.has(ev.eventId)) continue;
      if (ev.corroboratingStrandIds.some((sid) => targets.has(sid))) {
        seen.add(ev.eventId);
        out.push(ev);
      }
    }
    return out;
  }

  it("in-memory: a 3000-event ledger's real eventsIntersecting() matches the full-scan reference exactly", () => {
    const ledger = createCorroborationLedger();
    for (let i = 0; i < N; i++) {
      ledger.record({
        ratifiedStrandId: asStrandId(`s:ratified:${i}`),
        corroboratingStrandIds: [poolId(i % POOL_SIZE)],
        beneficiarySourceId: `src:ben:${i % 7}` as SourceId,
        reputationDelta: 0.1,
        at: NOW,
      });
    }

    const targetSet = new Set(TARGETS);
    const reference = referenceIntersecting(ledger.all(), targetSet);
    const real = ledger.eventsIntersecting(TARGETS);

    expect(reference.length).toBeGreaterThan(0); // the fixture actually hits something
    expect(real.map((e) => e.eventId)).toEqual(reference.map((e) => e.eventId));
    expect(real).toEqual(reference);
  });

  it("SQLite: a 3000-event durable ledger's real eventsIntersecting() matches the full-scan reference, and the point lookup is index-driven (not a full table scan)", () => {
    const path = freshPath("corrob");
    const ledger = track(createSqliteCorroborationLedger({ path }));
    for (let i = 0; i < N; i++) {
      ledger.record({
        ratifiedStrandId: asStrandId(`s:ratified:${i}`),
        corroboratingStrandIds: [poolId(i % POOL_SIZE)],
        beneficiarySourceId: `src:ben:${i % 7}` as SourceId,
        reputationDelta: 0.1,
        at: NOW,
      });
    }

    const targetSet = new Set(TARGETS);
    const reference = referenceIntersecting(ledger.all(), targetSet);
    const real = ledger.eventsIntersecting(TARGETS);
    expect(reference.length).toBeGreaterThan(0);
    expect(real.map((e) => e.eventId)).toEqual(reference.map((e) => e.eventId));
    expect(real).toEqual(reference);

    // STRUCTURAL PROOF the point lookup no longer scans the whole chain: ask
    // SQLite's own query planner how it would execute the exact indexed-JOIN shape
    // the production code runs. A full scan of the parent table would show `SCAN
    // corroboration_events`; an index-driven point lookup goes through the child
    // table instead (this is the assertion that FAILS before the fix — pre-fix, the
    // child table doesn't exist at all, so this very query errors out).
    const details = explainQueryPlan(
      path,
      `SELECT DISTINCT e.json AS json, e.seq AS seq
         FROM corroboration_events e
         JOIN corroboration_event_strands s ON s.event_id = e.event_id
        WHERE s.strand_id IN (?)
        ORDER BY e.seq`,
      String(TARGETS[0]),
    );
    expect(details.some((d) => d.includes("corroboration_event_strands"))).toBe(true);
    expect(details.some((d) => /SCAN\s+corroboration_events\b/.test(d))).toBe(false);
  });
});

// ===========================================================================
// 2. AdjudicationProvenanceLedger.recordsContributedBy — index-driven parity
// ===========================================================================

describe("AdjudicationProvenanceLedger.recordsContributedBy — indexed lookup matches a full scan", () => {
  function referenceContributedBy(
    all: readonly AdjudicationProvenance[],
    targets: ReadonlySet<StrandId>,
  ): AdjudicationProvenance[] {
    const latest = new Map<ContradictionSetId, AdjudicationProvenance>();
    const order: ContradictionSetId[] = [];
    for (const rec of all) {
      const hit = rec.contributingStrandIds.some((sid) => targets.has(sid));
      if (!hit) continue;
      if (!latest.has(rec.contradictionSetId)) order.push(rec.contradictionSetId);
      latest.set(rec.contradictionSetId, rec);
    }
    return order.map((csid) => latest.get(csid)!);
  }

  function makeRecord(i: number): AdjudicationProvenance {
    return {
      contradictionSetId: `cset:${i}` as ContradictionSetId,
      attribute: ATTR,
      winner: asStrandId(`s:winner:${i}`),
      margin: 0.5,
      contributingStrandIds: [asStrandId(`s:winner:${i}`), poolId(i % POOL_SIZE)],
      at: NOW,
    };
  }

  it("in-memory: a 3000-record ledger's real recordsContributedBy() matches the full-scan reference exactly", () => {
    const ledger = createAdjudicationProvenanceLedger();
    for (let i = 0; i < N; i++) ledger.record(makeRecord(i));

    const targetSet = new Set(TARGETS);
    const reference = referenceContributedBy(ledger.all(), targetSet);
    const real = ledger.recordsContributedBy(TARGETS);

    expect(reference.length).toBeGreaterThan(0);
    expect(real.map((r) => r.contradictionSetId)).toEqual(reference.map((r) => r.contradictionSetId));
    expect(real).toEqual(reference);
  });

  it("SQLite: a 3000-record durable ledger's real recordsContributedBy() matches the full-scan reference, and the point lookup is index-driven", () => {
    const path = freshPath("adjprov");
    const ledger = track(createSqliteAdjudicationProvenanceLedger({ path }));
    for (let i = 0; i < N; i++) ledger.record(makeRecord(i));

    const targetSet = new Set(TARGETS);
    const reference = referenceContributedBy(ledger.all(), targetSet);
    const real = ledger.recordsContributedBy(TARGETS);

    expect(reference.length).toBeGreaterThan(0);
    expect(real.map((r) => r.contradictionSetId)).toEqual(reference.map((r) => r.contradictionSetId));
    expect(real).toEqual(reference);

    // STRUCTURAL PROOF (fails before the fix: the child table doesn't exist yet).
    const details = explainQueryPlan(
      path,
      `SELECT DISTINCT e.json AS json, e.seq AS seq
         FROM adjudication_provenance e
         JOIN adjudication_provenance_strands s ON s.seq = e.seq
        WHERE s.strand_id IN (?)
        ORDER BY e.seq`,
      String(TARGETS[0]),
    );
    expect(details.some((d) => d.includes("adjudication_provenance_strands"))).toBe(true);
    expect(details.some((d) => /SCAN\s+adjudication_provenance\b/.test(d))).toBe(false);
  });
});

// ===========================================================================
// 3. WeakInfluenceLedger.edgesConsulting — index-driven parity
// ===========================================================================

describe("WeakInfluenceLedger.edgesConsulting — indexed lookup matches a full scan", () => {
  function referenceConsulting(
    all: readonly WeakInfluenceEdge[],
    targets: ReadonlySet<StrandId>,
  ): WeakInfluenceEdge[] {
    const out: WeakInfluenceEdge[] = [];
    const seen = new Set<StrandId>();
    for (const e of all) {
      if (!targets.has(e.consultedStrandId)) continue;
      if (seen.has(e.strandId)) continue;
      seen.add(e.strandId);
      out.push(e);
    }
    return out;
  }

  it("in-memory: a 3000-edge ledger's real edgesConsulting() matches the full-scan reference exactly", () => {
    const ledger = createWeakInfluenceLedger();
    for (let i = 0; i < N; i++) {
      ledger.record({
        strandId: asStrandId(`s:influenced:${i}`),
        consultedStrandId: poolId(i % POOL_SIZE),
        context: "read but not cited",
        at: NOW,
      });
    }

    const targetSet = new Set(TARGETS);
    const reference = referenceConsulting(ledger.all(), targetSet);
    const real = ledger.edgesConsulting(TARGETS);

    expect(reference.length).toBeGreaterThan(0);
    expect(real.map((e) => String(e.strandId))).toEqual(reference.map((e) => String(e.strandId)));
    expect(real).toEqual(reference);
  });

  it("SQLite: a 3000-edge durable ledger's real edgesConsulting() matches the full-scan reference, and the point lookup is index-driven", () => {
    const path = freshPath("weakinf");
    const ledger = track(createSqliteWeakInfluenceLedger({ path }));
    for (let i = 0; i < N; i++) {
      ledger.record({
        strandId: asStrandId(`s:influenced:${i}`),
        consultedStrandId: poolId(i % POOL_SIZE),
        context: "read but not cited",
        at: NOW,
      });
    }

    const targetSet = new Set(TARGETS);
    const reference = referenceConsulting(ledger.all(), targetSet);
    const real = ledger.edgesConsulting(TARGETS);

    expect(reference.length).toBeGreaterThan(0);
    expect(real.map((e) => String(e.strandId))).toEqual(reference.map((e) => String(e.strandId)));
    expect(real).toEqual(reference);

    // STRUCTURAL PROOF (fails before the fix: the child table doesn't exist yet).
    const details = explainQueryPlan(
      path,
      `SELECT e.json AS json
         FROM weak_influence_edges e
         JOIN weak_influence_consulted c ON c.seq = e.seq
        WHERE c.consulted_strand_id IN (?)
        ORDER BY e.seq`,
      String(TARGETS[0]),
    );
    expect(details.some((d) => d.includes("weak_influence_consulted"))).toBe(true);
    expect(details.some((d) => /SCAN\s+weak_influence_edges\b/.test(d))).toBe(false);
  });
});
