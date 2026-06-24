/**
 * ratification/reconcile.ts — THE TOTAL-LEDGER RECONCILIATION AUDIT (drift detector).
 *
 * Closes the OFF-LEDGER-REPUTATION channel of the undo-engine hardening
 * (ARCHITECTURE.md §4(b) + the Undo/Provenance guarantee, which holds ONLY for
 * influence "recorded as a corroboration event"). The undo engine can only reverse
 * reputation it can SEE recorded; a reputation gain applied WITHOUT a corroboration
 * event is unrecorded — and therefore UNREVERSIBLE. Two complementary defenses:
 *
 *  1. WRITE-TIME INVARIANT (in `api.ratify` via {@link assertRatifyEmitsEvent}): a
 *     reputation-earning ratify that names corroborating strands MUST emit a
 *     corroboration event carrying the EXACT applied α-mass, else throw. No earning
 *     path is silently off-ledger.
 *
 *  2. RECONCILIATION AUDIT (this module's {@link reconcileLedger}): per source, sum
 *     the recorded corroboration-event α-mass deltas (minus already-reversed ones)
 *     and compare with the source's EARNED α-mass above the prior baseline
 *     (`state.alpha − 1`). A source whose earned mass EXCEEDS what its recorded
 *     events explain (beyond tolerance) is flagged DRIFTED — the dangerous direction:
 *     credit that arrived OFF-LEDGER and cannot be reversed by a disown.
 *
 * DECAY HONESTY (a stated risk, not a bug): decay scales `(α−1)` by `λ^Δt`, so a
 * source that earned mass long ago and then sat idle has `earned < explained`. That
 * UNDER-explanation is EXPECTED (the recorded events are pre-decay; the live α has
 * decayed) and is reported as `decayGap`, NEVER as drift. Only the `earned >
 * explained` direction — more live credit than any recorded event accounts for — is
 * sound off-ledger-gain detection, and that is the only thing that sets `drifted`.
 *
 * PURE: this module reads two ledgers and produces a typed report; it mutates
 * nothing. No StrandStore / crypto I/O.
 */

import type { SourceId } from "../core/types.js";
import type { CorroborationLedger } from "./corroboration.js";

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/**
 * One source's reconciliation line. `earned` = `state.alpha − 1` (the live earned
 * α-mass above the prior baseline 1). `explained` = Σ of the source's recorded,
 * NON-reversed corroboration-event deltas. `gap = earned − explained`:
 *  - `gap > tolerance`  ⇒ DRIFTED (off-ledger gain; unreversible by a disown).
 *  - `gap < −tolerance` ⇒ a `decayGap` (recorded mass that has since decayed away —
 *    expected, not fraud).
 *  - `|gap| <= tolerance` ⇒ reconciled.
 */
export interface SourceReconciliation {
  readonly sourceId: SourceId;
  /** Live earned α-mass above baseline (`state.alpha − 1`), clamped at 0. */
  readonly earned: number;
  /** Sum of recorded, non-reversed corroboration-event deltas for this source. */
  readonly explained: number;
  /** `earned − explained`. Positive = unexplained (drift); negative = decayed. */
  readonly gap: number;
}

/**
 * The full reconciliation report. `drifted` names every source whose earned α-mass
 * is NOT fully explained by its recorded events beyond `tolerance` (the off-ledger
 * drift — the dangerous direction). `decayGapped` names sources whose recorded mass
 * exceeds their live mass (expected decay, surfaced for audit, NOT drift). `ok` is
 * `true` iff `drifted` is empty.
 */
export interface ReconciliationReport {
  /** Sources with unexplained earned credit (off-ledger gain). `ok === drifted.length === 0`. */
  readonly drifted: readonly SourceReconciliation[];
  /** Sources whose recorded mass exceeds live mass (decay — expected, not fraud). */
  readonly decayGapped: readonly SourceReconciliation[];
  /** Every reconciled source (within tolerance), for a complete audit trail. */
  readonly reconciled: readonly SourceReconciliation[];
  /** True iff no source DRIFTED (no off-ledger gain detected). */
  readonly ok: boolean;
}

/**
 * The minimal reputation-ledger surface this audit needs: enumerate every source's
 * raw Beta state (`alpha`). Structurally a subset of the real `ReputationLedger`, so
 * any concrete ledger that can list its states satisfies it — but the standard
 * `ReputationLedger` does not expose enumeration, so the CALLER passes the list of
 * `{ sourceId, alpha }` it already holds (the engine knows its sources).
 */
export interface AlphaSnapshot {
  readonly sourceId: SourceId;
  /** The source's live Beta α (>= 1; earned mass is `alpha − 1`). */
  readonly alpha: number;
}

/** Default reconciliation tolerance: small float slack for accumulated α arithmetic. */
export const DEFAULT_RECONCILE_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * RECONCILE a set of sources' EARNED α-mass against their RECORDED corroboration
 * events (the drift detector). For each `{ sourceId, alpha }` snapshot:
 *
 *   earned    = max(0, alpha − 1)                          // live mass above baseline
 *   explained = Σ delta over corroboration events where    // recorded, still-valid mass
 *               beneficiarySourceId === sourceId AND NOT reversed
 *   gap       = earned − explained
 *
 * Classification (see {@link SourceReconciliation}):
 *   gap >  tolerance ⇒ DRIFTED   (off-ledger gain — unreversible by a disown)
 *   gap < −tolerance ⇒ decayGap  (recorded mass decayed away — expected)
 *   else             ⇒ reconciled
 *
 * Reversed events are SUBTRACTED from `explained` (a disowned event no longer
 * explains live mass — and the live α was already lowered by `reverseCredit`, so both
 * sides drop together and the source stays reconciled). The report's `ok` is `true`
 * iff nothing DRIFTED.
 *
 * @param snapshots   the live `{ sourceId, alpha }` for every source to audit (the
 *                    engine supplies these; the standard ledger has no enumeration).
 * @param corroboration the corroboration-event ledger (the recorded explanation).
 * @param tolerance   float slack; defaults to {@link DEFAULT_RECONCILE_TOLERANCE}.
 * @returns a typed {@link ReconciliationReport}.
 */
export function reconcileLedger(
  snapshots: readonly AlphaSnapshot[],
  corroboration: CorroborationLedger,
  tolerance: number = DEFAULT_RECONCILE_TOLERANCE,
): ReconciliationReport {
  // Sum recorded, non-reversed deltas per beneficiary source in ONE pass over events.
  const explainedBySource = new Map<SourceId, number>();
  for (const ev of corroboration.all()) {
    if (corroboration.isReversed(ev.eventId)) continue; // a reversed event explains nothing
    const prior = explainedBySource.get(ev.beneficiarySourceId) ?? 0;
    explainedBySource.set(ev.beneficiarySourceId, prior + ev.reputationDelta);
  }

  const drifted: SourceReconciliation[] = [];
  const decayGapped: SourceReconciliation[] = [];
  const reconciled: SourceReconciliation[] = [];

  // Deterministic order: sort the snapshots by sourceId so the report is reproducible.
  const ordered = [...snapshots].sort((a, b) =>
    String(a.sourceId) < String(b.sourceId)
      ? -1
      : String(a.sourceId) > String(b.sourceId)
        ? 1
        : 0,
  );

  for (const snap of ordered) {
    const earned = Math.max(0, snap.alpha - 1);
    const explained = explainedBySource.get(snap.sourceId) ?? 0;
    const gap = earned - explained;
    const line: SourceReconciliation = {
      sourceId: snap.sourceId,
      earned,
      explained,
      gap,
    };
    if (gap > tolerance) {
      drifted.push(line);
    } else if (gap < -tolerance) {
      decayGapped.push(line);
    } else {
      reconciled.push(line);
    }
  }

  return {
    drifted,
    decayGapped,
    reconciled,
    ok: drifted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Write-time TOTAL-LEDGER invariant
// ---------------------------------------------------------------------------

/**
 * The error thrown when a reputation-earning ratify is applied WITHOUT recording a
 * corroboration event for it — the write-time half of the total-ledger invariant. A
 * named subclass so callers/tests can assert the exact failure.
 */
export class OffLedgerReputationError extends Error {
  constructor(
    readonly sourceId: SourceId,
    readonly appliedDelta: number,
  ) {
    super(
      `OffLedgerReputationError: source ${String(sourceId)} earned α-mass ${appliedDelta} ` +
        "from a corroboration-naming ratify but NO corroboration event was recorded; " +
        "every reputation-earning ratify MUST emit an event so the credit is reversible.",
    );
    this.name = "OffLedgerReputationError";
  }
}

/**
 * WRITE-TIME TOTAL-LEDGER INVARIANT. Assert that a reputation-earning ratify that
 * NAMED corroborating strands actually recorded a corroboration event for the applied
 * α-mass. Called by `api.ratify` on the corroboration earning path:
 *
 *   - If `appliedDelta <= 0` (no real gain — e.g. already at cap, or decayed back),
 *     there is nothing to record and nothing to reverse: OK.
 *   - If `appliedDelta > 0` AND the caller named corroborating strands but `recorded`
 *     is `false` (no event written — e.g. no ledger wired), the gain is OFF-LEDGER and
 *     UNREVERSIBLE: throw {@link OffLedgerReputationError}.
 *   - Otherwise (gain recorded): OK.
 *
 * This makes "every rep path is recorded/reversible" a load-bearing precondition at
 * the only belief-raising verb, not a hope.
 *
 * @param sourceId     the beneficiary source.
 * @param appliedDelta the exact α-mass applied (`after.alpha − before.alpha`).
 * @param namedCorroborators whether the caller named corroborating strands (the
 *                     earning path that obliges an event).
 * @param recorded     whether a corroboration event was actually recorded.
 * @throws {@link OffLedgerReputationError} when a positive gain on the earning path
 *         went unrecorded.
 */
export function assertRatifyEmitsEvent(
  sourceId: SourceId,
  appliedDelta: number,
  namedCorroborators: boolean,
  recorded: boolean,
): void {
  if (appliedDelta <= 0) return; // no gain ⇒ nothing to record or reverse
  if (!namedCorroborators) return; // ordinary (non-corroboration) ratify ⇒ no obligation
  if (!recorded) {
    throw new OffLedgerReputationError(sourceId, appliedDelta);
  }
}
