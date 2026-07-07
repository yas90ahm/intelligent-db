/**
 * daemon/log.ts — minimal, dependency-free, structured stderr logging for the
 * daemon.
 *
 * Originally added for FAILURE CONTAINMENT only
 * (`daemon-auditchain-write-crashes-process`, PRODUCTION_READINESS_ASSESSMENT.md)
 * — a caught audit-chain/queue/handshake failure leaves a parseable, timestamped
 * trace on stderr instead of either (a) crashing the process (the bug) or (b) a
 * silent, untraceable swallow.
 *
 * EXPANDED (`zero-structured-logging`, PRODUCTION_READINESS_ASSESSMENT.md): every
 * operationally-interesting daemon event now goes through this SAME function —
 * connection accepted, connection/handshake rejected, admin-verb invoked
 * (success and forbidden), a per-request handler error, and shutdown — not only
 * the failure-containment call sites above. See `server.ts`'s call sites for the
 * full event catalog. Every record: `{ts, level, event, ...context}`; `context`
 * NEVER carries a raw bearer token — only `fingerprint` (sha256 hex,
 * `tokens.ts#fingerprintToken`) and, once resolved, `resolvedSourceId`.
 *
 * ZERO new runtime deps: `process.stderr` + `JSON.stringify` only.
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

export interface DaemonLogEvent {
  /** Short, stable, machine-greppable event tag (e.g. "audit_chain_write_failed"). */
  readonly event: string;
  /**
   * Human-readable detail — typically the caught error's message. OPTIONAL:
   * many lifecycle events (a successful connect, an admin verb, a shutdown)
   * are fully described by `event` plus their own typed context fields
   * (`reason`, `verb`, `fingerprint`, `resolvedSourceId`, ...) with nothing to
   * say in prose.
   */
  readonly message?: string;
  readonly level?: "error" | "warn" | "info";
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
