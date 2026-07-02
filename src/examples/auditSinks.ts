/**
 * examples/auditSinks.ts — REFERENCE {@link AppendSink} IMPLEMENTATIONS.
 *
 * The ledger's real-time shipping hook (see ratification/pendingLedger.ts's
 * HONEST DISCLOSURE and the {@link AppendSink} ordering contract) is just a
 * function `(record) => void` — the ledger hands every audit record to it
 * BEFORE the local write. WHAT makes a destination worth shipping to is not
 * code, it is three properties of the destination itself:
 *
 *   1. DIFFERENT ACCESS DOMAIN — the credentials the memory process runs under
 *      cannot modify or delete there (a different OS account, a different cloud
 *      role, INSERT-only database grants, WORM storage);
 *   2. APPEND-ONLY or VERSIONED — an overwrite leaves the original recoverable;
 *   3. DURABLE ENOUGH to outlive a dispute.
 *
 * This module ships three composable starting points plus the detection-side
 * comparator, all zero-dependency (node: builtins only):
 *
 *   - {@link createJsonlFileSink} — the simplest real sink: one JSON line per
 *     record appended to a file. Strict (fail-closed): an unwritable file
 *     aborts the belief change. Point the path at a directory owned by a
 *     DIFFERENT OS account that granted this process append/write access —
 *     the access-domain boundary is the OS, not this code.
 *
 *   - {@link createSpoolSink} + {@link shipSpool} — the SPOOL PATTERN for
 *     network destinations (SIEM / WORM object storage). {@link AppendSink} is
 *     deliberately SYNCHRONOUS (that is what makes ship-before-write
 *     fail-closed), so a sink must not block on the network. Instead the sink
 *     appends to a local spool file in microseconds, and a SEPARATE process —
 *     running under a different account, on its own schedule — drains the
 *     spool to the real destination with {@link shipSpool}. The segregation
 *     boundary is the spool owner's account; the write path never waits on a
 *     network.
 *
 *   - {@link lenient} — the availability-over-strict-coupling wrapper. The
 *     ledger treats a throwing sink as "no shipped receipt ⇒ no belief change"
 *     (fail-closed). A deployment that would rather keep operating through a
 *     sink outage (accepting an audit gap it can see) wraps its sink in this;
 *     the choice is explicit, never a silent default.
 *
 *   - {@link firstDivergence} — the DETECTION side: compare the shipped copy
 *     against the live chain; the first differing seq is where history was
 *     rewritten. This is the entire detection algorithm — a plain hash
 *     comparison; the guarantee comes from WHERE the shipped copy lives.
 *
 * Wiring (personal tier — one option, zero other config):
 *
 *     const mem = createAgentMemory({
 *       onLedgerAppend: createJsonlFileSink("D:/audit-mirror/memory-audit.jsonl"),
 *     });
 *
 * Wiring (enterprise — direct ledger construction):
 *
 *     const spool = createSpoolSink("/var/spool/iddb-audit");
 *     const ledger = createSqlitePendingLedger({ db, onAppend: spool });
 *     // elsewhere, under a different account, on a timer:
 *     //   await shipSpool("/var/spool/iddb-audit", async (lines) => {
 *     //     await fetch(SIEM_HEC_URL, { method: "POST", headers: AUTH,
 *     //       body: lines.join("\n") });   // Splunk HEC / Sentinel / Elastic
 *     //   });
 *
 * These are EXAMPLES: small, readable, meant to be copied and adapted. They are
 * typechecked and tested with the suite so they can never silently rot, but
 * they are deliberately NOT exported from the package barrel — the API surface
 * is the {@link AppendSink} type; destinations belong to the deployment.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`);
 * `verbatimModuleSyntax` (type-only imports use `import type`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppendSink, LedgerRecord } from "../ratification/pendingLedger.js";

// ---------------------------------------------------------------------------
// 1. The append-only JSONL file sink (strict / fail-closed)
// ---------------------------------------------------------------------------

/**
 * One JSON line per record, appended to `path` (parent directories created on
 * first use). STRICT: any write failure propagates, which the ledger turns into
 * "the belief change never happened" (ship-before-write). That is the correct
 * default — wrap in {@link lenient} only as an explicit availability choice.
 *
 * The access-domain boundary is the FILESYSTEM's, not this function's: point
 * `path` somewhere the memory process can append but not rewrite (a directory
 * owned by another OS account, a mounted append-only share, a versioned sync
 * folder). Writing to a path the process fully owns still detects ACCIDENTAL
 * corruption but not a deliberate insider — see the module doc.
 */
export function createJsonlFileSink(path: string): AppendSink {
  let dirReady = false;
  return (record: LedgerRecord): void => {
    if (!dirReady) {
      // Lazy, once: create the parent chain if missing. Never truncates.
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    // O_APPEND via flag "a": each line lands atomically at the current end for
    // line-sized writes — no read-modify-write window to corrupt.
    appendFileSync(path, JSON.stringify(record) + "\n", { flag: "a" });
  };
}

/**
 * The full parse report of a JSONL audit mirror — the crash-tolerant detection
 * input. A mirror's FINAL line can legitimately be TORN (the writing process died
 * mid-`appendFileSync`), and that is EXACTLY when the mirror gets read — a reader
 * that crashes on the torn line breaks the documented detection flow at the one
 * moment it matters. Torn tail ≠ corruption:
 *
 *   - `tornTail` — the LAST non-empty line failed to parse. The parsed PREFIX is
 *     still fully comparable ({@link firstDivergence} works on prefixes), so
 *     detection proceeds on `records`.
 *   - `corruptAtLine` — a NON-final line failed to parse (1-based line number).
 *     A torn append can only ever damage the tail, so mid-file garbage is a
 *     DISTINCT tamper/corruption signal, never silently tolerated.
 *
 * A valid final line with no trailing newline parses normally — "torn" means
 * JSON.parse fails, not merely a missing `\n`. A missing file reads as empty.
 */
export interface JsonlMirrorReport {
  /** The records parsed up to (not including) the first unparseable line. */
  readonly records: LedgerRecord[];
  /** True when only the FINAL non-empty line was unparseable (a torn append). */
  readonly tornTail: boolean;
  /** 1-based line number of an unparseable NON-final line, else null. */
  readonly corruptAtLine: number | null;
}

/**
 * Parse a JSONL audit mirror line-by-line, surviving a torn final line and
 * distinguishing it from mid-file corruption — see {@link JsonlMirrorReport}.
 */
export function readJsonlMirrorReport(path: string): JsonlMirrorReport {
  if (!existsSync(path)) return { records: [], tornTail: false, corruptAtLine: null };
  const lines = readFileSync(path, "utf8").split("\n");

  // The last NON-EMPTY line is the only one a torn append can have produced
  // (trailing empty strings after split are just the final newline / EOF).
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length > 0) {
      lastNonEmpty = i;
      break;
    }
  }

  const records: LedgerRecord[] = [];
  for (let i = 0; i <= lastNonEmpty; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue; // interior blank line: nothing to parse
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      return i === lastNonEmpty
        ? { records, tornTail: true, corruptAtLine: null } // torn append: prefix is good
        : { records, tornTail: false, corruptAtLine: i + 1 }; // mid-file: tamper signal
    }
  }
  return { records, tornTail: false, corruptAtLine: null };
}

/**
 * Parse a JSONL audit mirror back into records (the detection side's input).
 * Thin wrapper over {@link readJsonlMirrorReport}: a TORN TAIL is tolerated
 * silently (the intact prefix is returned — still fully comparable via
 * {@link firstDivergence}); MID-FILE corruption throws, naming the line —
 * that is a tamper signal, never a crash artifact.
 */
export function readJsonlMirror(path: string): LedgerRecord[] {
  const report = readJsonlMirrorReport(path);
  if (report.corruptAtLine !== null) {
    throw new Error(
      `readJsonlMirror: mirror corrupted mid-file at line ${report.corruptAtLine} ` +
        `(${JSON.stringify(path)}). A torn append can only damage the FINAL line; ` +
        `an unparseable interior line means the mirror was modified or damaged — ` +
        `treat it as a tamper/corruption signal, not a crash artifact.`,
    );
  }
  return report.records;
}

// ---------------------------------------------------------------------------
// 2. The spool pattern (for network destinations: SIEM / WORM storage)
// ---------------------------------------------------------------------------

/** The active spool file a {@link createSpoolSink} sink appends to. */
const SPOOL_FILE = "audit.spool.jsonl";
/** The rotated file {@link shipSpool} drains from (crash-safe handoff). */
const SHIPPING_FILE = "audit.shipping.jsonl";

/**
 * A sink that appends to a local SPOOL FILE (microseconds, no network on the
 * write path), for a SEPARATE shipper process to drain to the real destination
 * with {@link shipSpool}. `spoolDir` should be owned by the shipper's account
 * with this process granted append access — that ownership IS the segregation
 * boundary (an insider compromising the memory process cannot un-ship what the
 * shipper already drained, and cannot rewrite a spool it does not own).
 */
export function createSpoolSink(spoolDir: string): AppendSink {
  return createJsonlFileSink(join(spoolDir, SPOOL_FILE));
}

/**
 * Drain the spool to the real destination — run this from a SEPARATE process
 * under a DIFFERENT account, on a timer (the async half the synchronous sink
 * deliberately does not do). Crash-safe two-phase drain:
 *
 *   1. Rotate `audit.spool.jsonl` → `audit.shipping.jsonl` (atomic rename; new
 *      records keep landing in a fresh spool with no gap). If a previous drain
 *      crashed mid-ship, the leftover shipping file is retried FIRST — records
 *      are only deleted after `post` succeeds, so a crash re-ships (the
 *      destination may see a duplicate seq, never a hole; dedupe by
 *      `(seq, thisHash)` if the destination cares).
 *   2. Hand the batch of JSON lines to `post` (one HTTP call to a SIEM's HTTP
 *      event collector, one WORM object put, one INSERT batch — the caller's
 *      choice). Only on success is the shipping file removed.
 *
 * Returns the number of records shipped (0 when the spool was empty).
 */
export async function shipSpool(
  spoolDir: string,
  post: (jsonlLines: readonly string[]) => Promise<void>,
): Promise<number> {
  const spool = join(spoolDir, SPOOL_FILE);
  const shipping = join(spoolDir, SHIPPING_FILE);

  // Phase 1 — rotate (unless a crashed previous drain left a batch to retry).
  if (!existsSync(shipping)) {
    if (!existsSync(spool)) return 0;
    renameSync(spool, shipping);
  }

  const lines = readFileSync(shipping, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    rmSync(shipping, { force: true });
    return 0;
  }

  // Phase 2 — ship, then (and only then) drop the batch.
  await post(lines);
  rmSync(shipping, { force: true });
  return lines.length;
}

// ---------------------------------------------------------------------------
// 3. The lenient wrapper (explicit availability-over-coupling choice)
// ---------------------------------------------------------------------------

/**
 * Wrap a sink so its failures are OBSERVED but never block a belief change.
 * This trades the fail-closed guarantee ("no shipped receipt ⇒ no belief
 * change") for availability through a sink outage — an audit GAP the
 * deployment accepts knowingly. `onError` receives every swallowed failure
 * (log it, alert on it); defaulting it to silence would hide exactly the
 * signal the sink exists to provide, so it is REQUIRED.
 */
export function lenient(
  sink: AppendSink,
  onError: (err: unknown, record: LedgerRecord) => void,
): AppendSink {
  return (record: LedgerRecord): void => {
    try {
      sink(record);
    } catch (err) {
      onError(err, record);
    }
  };
}

// ---------------------------------------------------------------------------
// 4. The detection side — compare the shipped copy against the live chain
// ---------------------------------------------------------------------------

/**
 * First seq at which the live chain's record differs from (or is missing
 * against) the shipped copy; null when the live chain cleanly extends the
 * shipped copy. Run this on any schedule from wherever the shipped copy lives:
 * a non-null answer means local history was rewritten at that seq — including
 * rewrites that recomputed every checksum and read `verifyChain(): ok`. A plain
 * hash comparison is the entire algorithm; the strength is WHERE the shipped
 * copy lives, not math.
 */
export function firstDivergence(
  shipped: readonly LedgerRecord[],
  live: readonly LedgerRecord[],
): number | null {
  for (let i = 0; i < shipped.length; i++) {
    const l = live[i];
    if (l === undefined || l.thisHash !== shipped[i]!.thisHash) return i;
  }
  return null;
}
