/**
 * daemon/log.ts — minimal, dependency-free, structured stderr logging for
 * daemon-side FAILURE CONTAINMENT (`daemon-auditchain-write-crashes-process`,
 * PRODUCTION_READINESS_ASSESSMENT.md). This is deliberately NOT a general
 * observability solution (see the separate `zero-structured-logging` finding,
 * out of scope for this fix) — it exists so a caught audit-chain/queue/handshake
 * failure leaves a parseable, timestamped trace on stderr instead of either (a)
 * crashing the process (the bug) or (b) a silent, untraceable swallow.
 *
 * ZERO new runtime deps: `process.stderr` + `JSON.stringify` only.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

export interface DaemonLogEvent {
  /** Short, stable, machine-greppable event tag (e.g. "audit_chain_write_failed"). */
  readonly event: string;
  /** Human-readable detail — typically the caught error's message. */
  readonly message: string;
  readonly level?: "error" | "warn";
  /** Additional plain-data context (method name, phase, ownerId, ...). */
  readonly [key: string]: unknown;
}

/**
 * Best-effort structured log line to stderr. NEVER throws — a logging failure
 * (e.g. a broken stderr pipe) must never itself become a second crash on top of
 * the one this module exists to contain.
 */
export function daemonLog(e: DaemonLogEvent): void {
  try {
    const record = {
      ts: new Date().toISOString(),
      level: e.level ?? "error",
      ...e,
    };
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // best-effort — logging itself must never throw.
  }
}
