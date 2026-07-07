/**
 * backup.test.ts — regression coverage for the Durability-lane fix to
 * `restoreToTimestamp`'s REFUSAL RULE: a restored database that carries any
 * `ratification_records` rows must throw {@link UnverifiedLedgerRestoreError} when
 * the caller omits `chainVerifier` — never silently return success (an UNVERIFIED
 * restore) — and must delete the half-written output before throwing. See the
 * module doc + `RestoreOptions.chainVerifier`.
 *
 * (The sibling `{ db }` shared-handle WAL-verification fix lives in
 * `store/sqliteStore.ts` and is regression-tested in `sqliteStore.test.ts`.)
 *
 * This regression was confirmed live against the compiled `dist/` build during the
 * adversarial audit before this fix landed (see the audit's repro scripts); this
 * test exercises the REAL exported `restoreToTimestamp` over a REAL SQLite file and
 * a REAL `SqlitePendingLedger`, not a re-derived assertion.
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asEpochMs,
  asStrandId,
  FactOrigin,
  FactState,
  Tier,
} from "../core/types.js";
import type {
  AttributeKey,
  ContentHash,
  ContradictionSetId,
  EntityId,
  SourceId,
  Strand,
} from "../core/types.js";
import { createSqlitePendingLedger } from "../ratification/pendingLedger.js";
import {
  createWalArchiver,
  restoreToTimestamp,
  UnverifiedLedgerRestoreError,
} from "./backup.js";
import { createSqliteStore } from "./sqliteStore.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "idb-backup-store-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeStrand(i: number): Strand {
  const now = asEpochMs(1_700_000_000_000 + i);
  return {
    id: asStrandId(`strand:fixture-${i}`),
    entity: `entity:acme` as EntityId,
    attribute: `attr-${i}` as AttributeKey,
    payload: { text: `fact number ${i}` },
    content_hash: `hash-${i}` as ContentHash,
    fact_state: FactState.LIVE,
    origin: FactOrigin.OBSERVED,
    tier: Tier.WARM,
    provenance: [
      {
        rootId: `root:${i}`,
        sourceId: "source:owner" as SourceId,
        independenceClass: "class:source:owner",
        establishedAt: now,
      },
    ],
    outEdges: [],
    inEdges: [],
    outranked_by: null,
    bridge: { earned_bridge_value: 0, far_side_potential: 0 },
    salience: { s: 1, last_fire_time: now, lambda: 0.1, fire_count: 0 },
    description_value: 1,
    observedAt: now,
    external_reobservation_count: 0,
    contradiction_set: null,
    co_equal_claim_cardinality: 0,
    last_tier_reason: null,
    register: null,
  } as unknown as Strand;
}

describe("restoreToTimestamp — the chainVerifier refusal rule (finding: restore-chainverifier-unenforced)", () => {
  it("THROWS and leaves NO output file when the restored db carries ratification_records rows and chainVerifier is omitted", () => {
    const dbPath = join(workDir, "live.db");
    const archiveDir = join(workDir, "archive");
    const snapshotPath = join(workDir, "snap.db");
    const restoredPath = join(workDir, "restored.db");

    let clockMs = 3_000_000;
    const now = (): number => clockMs;

    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    const store = createSqliteStore({ db: handle });
    // A REAL SqlitePendingLedger over the shared handle (no reputation port needed
    // for appendPending alone) — the exact production type restoreToTimestamp's
    // refusal rule is guarding.
    const ledger = createSqlitePendingLedger({ db: handle });

    store.putStrand(makeStrand(0));
    // One real PENDING record => ratification_records has exactly 1 row.
    ledger.appendPending(
      {
        contradictionSetId: "cset:fixture-0" as ContradictionSetId,
        attribute: "attr-0" as AttributeKey,
        members: [asStrandId("strand:fixture-0")],
        reason: "INDEPENDENT_DISPUTE",
        createdAt: asEpochMs(clockMs),
      },
      "source:owner" as SourceId,
    );

    const archiver = createWalArchiver(handle, { dir: archiveDir, now });
    clockMs += 1000;
    store.snapshot(snapshotPath, { chainHead: ledger.chainHead(), now });
    clockMs += 1000;
    const tTarget = clockMs;

    archiver.close();
    handle.close();

    // Sanity: the archived base really does carry the ledger row (so a silent
    // success below would be a genuine desync, not a vacuous pass).
    const baseHandle = new DatabaseSync(join(archiveDir, "base.db"));
    const row = baseHandle
      .prepare("SELECT COUNT(*) AS n FROM ratification_records")
      .get() as { n: number };
    baseHandle.close();
    expect(row.n).toBe(1);

    // THE ACTUAL REGRESSION: call the REAL restoreToTimestamp with NO opts at all
    // (chainVerifier omitted) against a db that carries ledger rows.
    expect(() =>
      restoreToTimestamp(snapshotPath, archiveDir, asEpochMs(tTarget), restoredPath),
    ).toThrow(UnverifiedLedgerRestoreError);

    // FAIL-CLOSED: no half-restored output left behind (never mistaken for a good one).
    expect(existsSync(restoredPath)).toBe(false);
    expect(existsSync(`${restoredPath}-wal`)).toBe(false);
    expect(existsSync(`${restoredPath}-shm`)).toBe(false);
  });

  it("still succeeds with chainVerifier omitted when the restored db has ZERO ratification_records rows (no ledger ever wired)", () => {
    const dbPath = join(workDir, "live2.db");
    const archiveDir = join(workDir, "archive2");
    const snapshotPath = join(workDir, "snap2.db");
    const restoredPath = join(workDir, "restored2.db");

    let clockMs = 4_000_000;
    const now = (): number => clockMs;

    const handle = new DatabaseSync(dbPath);
    handle.exec("PRAGMA journal_mode=WAL");
    const store = createSqliteStore({ db: handle });
    store.putStrand(makeStrand(0));

    const archiver = createWalArchiver(handle, { dir: archiveDir, now });
    clockMs += 1000;
    store.snapshot(snapshotPath, { chainHead: null, now });
    clockMs += 1000;
    const tTarget = clockMs;

    archiver.close();
    handle.close();

    // No ratification ledger was ever constructed against this handle, so there is
    // no ratification_records table at all — the refusal gate must stay inert.
    const result = restoreToTimestamp(
      snapshotPath,
      archiveDir,
      asEpochMs(tTarget),
      restoredPath,
    );
    expect(result.chainHead).toBeNull();
    expect(existsSync(restoredPath)).toBe(true);
  });
});
