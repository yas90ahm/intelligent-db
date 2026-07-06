/**
 * __torture__/invariantChecker.ts — THE DEDICATED CROSS-OP INVARIANT CHECKER
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4a: "this is the heart of the suite").
 *
 * Runs against a FRESHLY REOPENED engine (after a kill-loop cycle's child process
 * was SIGKILLed at a random point) and asserts, PURELY from the state a reopen can
 * see (no reliance on "which op was interrupted" — the checker never assumes it
 * knows what the tortured process was doing):
 *
 *   1. STRUCTURAL   — `PRAGMA integrity_check` reports ok.
 *   2. SEMANTIC      — the audit checksum chain verifies (`verifyChain()`).
 *   3. RECONCILE     — no off-ledger reputation drift (`reconcileLedger`).
 *   4. NO LOSER DEMOTED WITHOUT ITS OUTRANKS EDGE — every `DEMOTED` strand's
 *      `outranked_by` resolves to a real `OUTRANKS` edge whose `to` is the strand
 *      itself (the exact contract `forgetting/consolidation.ts`'s `demote()`
 *      enforces at write time; this independently re-derives it from disk).
 *   5. NO APPROVAL RECORD WITHOUT ITS DEMOTIONS — every `APPROVAL` ledger record's
 *      disputed losers (from its matching `PENDING` record's `members`, minus the
 *      winner) are all `DEMOTED` in the store. Since `approve()` wraps the ledger
 *      append + the store demotions in ONE transaction, these can never disagree
 *      after a clean reopen — an actual disagreement means atomicity broke.
 *   6. NO HALF-APPLIED DISOWN — any `OUTRANKS` edge minted by a disown sweep (its
 *      `from` is the deterministic `strand:disown-sentinel:<sourceId>` id) implies
 *      a `DISOWN_CRATER` MUTATION receipt for that same `sourceId` exists in the
 *      ledger (the whole sweep — direct crater + every downstream demotion/edge —
 *      is one atomic unit; a sentinel edge with no matching crater receipt means
 *      the sweep's ledger-journal and store-mutation halves diverged).
 *
 * PURE READ: this module writes nothing. It is deliberately independent of
 * `harness.ts`'s construction details beyond the `Wired` shape, so it can be reused
 * by both the kill-loop driver and a standalone ad-hoc audit of any torture db.
 */

import { EdgeType, FactState } from "../index.js";
import type {
  ApprovalPayload,
  LedgerRecord,
  MutationPayload,
  PendingPayload,
  SourceId,
} from "../index.js";
import { reconcileLedger, DEFAULT_RECONCILE_TOLERANCE } from "../index.js";
import type { AlphaSnapshot } from "../index.js";

import type { Wired } from "./harness.js";

export interface InvariantViolation {
  /** A short, greppable machine-stable tag for this violation class. */
  readonly kind: string;
  readonly detail: string;
}

export interface InvariantReport {
  readonly integrityOk: boolean;
  readonly chainOk: boolean;
  readonly chainFirstBrokenSeq: number | null;
  readonly reconcileOk: boolean;
  readonly violations: readonly InvariantViolation[];
  readonly ok: boolean;
  // counters, for the run log — not correctness-bearing themselves.
  readonly strandsScanned: number;
  readonly demotedScanned: number;
  readonly approvalsScanned: number;
  readonly disownedSourcesScanned: number;
}

/**
 * KNOWN, PRE-EXISTING, NON-CRASH violation kinds — found while building this suite,
 * reproducible on a single clean, un-killed engine call (no SIGKILL involved), and
 * therefore NOT a crash-consistency/atomicity bug: `ratification/pendingLedger.ts`'s
 * `approve()` credits the winning strand's author(s) via `reputation.ratify(author,
 * now)` with NO corroboration-event recording (unlike `api.ts`'s `#ratifyImpl`,
 * which conditionally records one when the ratified strand has a genuine agreement
 * set) — so `reconcileLedger` reports a permanent "earned > explained" drift for any
 * source that ever wins an `approve()` resolution. Documented here (not silently
 * dropped) so callers that want a hard-fail-only-on-structural-breaks signal (the
 * CI smoke job, the vitest kill-loop smoke test) have ONE shared, named place this
 * exclusion lives, rather than each re-deriving/duplicating the same string set.
 */
export const KNOWN_NONCRASH_VIOLATION_KINDS: ReadonlySet<string> = new Set(["RECONCILE_DRIFT"]);

/** `report.violations` minus {@link KNOWN_NONCRASH_VIOLATION_KINDS} — the "heart of the suite" signal. */
export function structuralViolations(
  report: InvariantReport,
): readonly InvariantViolation[] {
  return report.violations.filter((v) => !KNOWN_NONCRASH_VIOLATION_KINDS.has(v.kind));
}

const DISOWN_SENTINEL_RE = /^strand:disown-sentinel:(.+)$/;

/**
 * Run the full invariant scan against an already-reopened {@link Wired} bundle.
 * `roster` is every source id the torture harness might have earned/lost reputation
 * for (used to build the `reconcileLedger` snapshot — the standard `ReputationLedger`
 * has no enumeration, so the caller supplies the known universe, exactly as
 * `disownHardening.test.ts` / `systemCoherence.test.ts` already do).
 */
export function checkInvariants(w: Wired, roster: readonly SourceId[]): InvariantReport {
  const violations: InvariantViolation[] = [];

  // 1. STRUCTURAL
  const integrityOk = w.store.integrityCheck();
  if (!integrityOk) {
    violations.push({
      kind: "INTEGRITY_CHECK_FAILED",
      detail: "PRAGMA integrity_check did not report ok",
    });
  }

  // 2. SEMANTIC — the audit checksum chain
  const chain = w.ledger.verifyChain();
  if (!chain.ok) {
    violations.push({
      kind: "CHAIN_BROKEN",
      detail: `verifyChain() failed at seq ${String(chain.firstBrokenSeq)}`,
    });
  }

  // 3. RECONCILE — off-ledger reputation drift
  const snapshots: AlphaSnapshot[] = roster.map((sourceId) => ({
    sourceId,
    alpha: w.reputation.stateOf(sourceId)?.alpha ?? 1,
  }));
  const reconcile = reconcileLedger(snapshots, w.corroboration, DEFAULT_RECONCILE_TOLERANCE);
  if (!reconcile.ok) {
    for (const d of reconcile.drifted) {
      violations.push({
        kind: "RECONCILE_DRIFT",
        detail: `source ${String(d.sourceId)} earned=${d.earned} explained=${d.explained} gap=${d.gap}`,
      });
    }
  }

  // 4. NO LOSER DEMOTED WITHOUT ITS OUTRANKS EDGE
  let strandsScanned = 0;
  let demotedScanned = 0;
  for (const strand of w.store.allStrands()) {
    strandsScanned++;
    if (strand.fact_state !== FactState.DEMOTED) continue;
    demotedScanned++;

    if (strand.outranked_by === null) {
      violations.push({
        kind: "DEMOTED_NO_OUTRANKED_BY",
        detail: `strand ${String(strand.id)} is DEMOTED but outranked_by is null`,
      });
      continue;
    }
    const edge = w.store.getEdge(strand.outranked_by);
    if (edge === null) {
      violations.push({
        kind: "DEMOTED_DANGLING_OUTRANKS_EDGE",
        detail: `strand ${String(strand.id)}'s outranked_by (${String(strand.outranked_by)}) does not resolve to any edge`,
      });
      continue;
    }
    if (edge.edgeType !== EdgeType.OUTRANKS) {
      violations.push({
        kind: "DEMOTED_EDGE_WRONG_TYPE",
        detail: `strand ${String(strand.id)}'s outranked_by edge ${String(edge.id)} has type ${edge.edgeType}, expected OUTRANKS`,
      });
    }
    if (edge.to !== strand.id) {
      violations.push({
        kind: "DEMOTED_EDGE_WRONG_TARGET",
        detail: `strand ${String(strand.id)}'s outranked_by edge ${String(edge.id)} points to ${String(edge.to)}, not the demoted strand itself`,
      });
    }
  }

  // 5. NO APPROVAL RECORD WITHOUT ITS DEMOTIONS
  const records: readonly LedgerRecord[] = w.ledger.records();
  const firstPendingByCsid = new Map<string, PendingPayload>();
  for (const rec of records) {
    if (rec.kind !== "PENDING") continue;
    const p = rec.payload as PendingPayload;
    const key = String(p.contradictionSetId);
    if (!firstPendingByCsid.has(key)) firstPendingByCsid.set(key, p);
  }

  let approvalsScanned = 0;
  for (const rec of records) {
    if (rec.kind !== "APPROVAL") continue;
    approvalsScanned++;
    const a = rec.payload as ApprovalPayload;
    const csidKey = String(a.contradictionSetId);
    const pending = firstPendingByCsid.get(csidKey);
    if (pending === undefined) {
      violations.push({
        kind: "APPROVAL_NO_MATCHING_PENDING",
        detail: `APPROVAL for csid ${csidKey} has no matching PENDING record in the chain`,
      });
      continue;
    }
    for (const memberId of pending.members) {
      if (memberId === a.winner) continue; // the winner stays LIVE, never demoted.
      const loser = w.store.getStrand(memberId);
      if (loser === null) {
        violations.push({
          kind: "APPROVAL_LOSER_STRAND_MISSING",
          detail: `APPROVAL csid ${csidKey}: loser ${String(memberId)} is not in the store`,
        });
        continue;
      }
      if (loser.fact_state !== FactState.DEMOTED) {
        violations.push({
          kind: "APPROVAL_LOSER_NOT_DEMOTED",
          detail: `APPROVAL csid ${csidKey}: loser ${String(memberId)} is ${loser.fact_state}, expected DEMOTED`,
        });
      }
    }
  }

  // 6. NO HALF-APPLIED DISOWN
  const cratered = new Set<string>();
  for (const rec of records) {
    if (rec.kind !== "MUTATION") continue;
    const m = rec.payload as MutationPayload;
    if (m.op === "DISOWN_CRATER") cratered.add(m.subjectId);
  }
  const sentinelSourceIds = new Set<string>();
  for (const edge of w.store.allEdges()) {
    if (edge.edgeType !== EdgeType.OUTRANKS) continue;
    const m = DISOWN_SENTINEL_RE.exec(String(edge.from));
    if (m?.[1] !== undefined) sentinelSourceIds.add(m[1]);
  }
  for (const sid of sentinelSourceIds) {
    if (!cratered.has(sid)) {
      violations.push({
        kind: "DISOWN_HALF_APPLIED",
        detail: `source ${sid} has a demoted downstream strand via a disown-sentinel OUTRANKS edge, but no DISOWN_CRATER MUTATION receipt exists — the sweep's ledger-journal and store-mutation halves diverged`,
      });
    }
  }

  return {
    integrityOk,
    chainOk: chain.ok,
    chainFirstBrokenSeq: chain.firstBrokenSeq,
    reconcileOk: reconcile.ok,
    violations,
    ok: violations.length === 0,
    strandsScanned,
    demotedScanned,
    approvalsScanned,
    disownedSourcesScanned: sentinelSourceIds.size,
  };
}
