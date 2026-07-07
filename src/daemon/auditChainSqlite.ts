/**
 * daemon/auditChainSqlite.ts — DURABLE (SQLite-backed) variant of the R8 daemon
 * audit chain (`daemon/auditChain.ts`'s in-memory `createDaemonAuditChain`).
 *
 * FINDING fixed here (adversarial pass, PHASE3_DAEMON_SPEC.md deliverable 4/5):
 * `daemon/auditChain.ts` shipped ONLY an in-memory chain, and `daemon/cli.ts`
 * wired it with no `AppendSink`. R8's own wording — "same ledger code," "the
 * daemon chain is shippable through the same `AppendSink` interface" — takes
 * `ratification/pendingLedger.ts` as its reference, which HAS a durable SQLite
 * implementation precisely so the fact/ratification audit trail survives a
 * restart or crash. The daemon chain had no equivalent: every
 * CONNECTION_ACCEPTED / AUTH_FAILURE / REVOCATION / ADMIN_VERB /
 * SHUTDOWN_MARKER record vanished on process exit — including an unclean
 * SIGKILL exit, the exact moment post-hoc audit matters most (R3's own
 * rationale: "at least POST-HOC detectable" for a compromised-token spree).
 * This module closes that gap the same way `pendingLedger.ts` closes it for
 * the fact chain: one SQLite table (own file — never the memory db, so a
 * `--socket`-only client sees no coupling), same canonical hash primitive
 * (`hashPreimage`/`sha256Hex`, imported from `auditChain.ts` — never
 * re-derived), reopened head recomputed from disk so a fresh process
 * continues the SAME chain rather than starting a new one after every
 * restart or crash.
 *
 * ZERO new runtime dependencies: `node:sqlite` (already used throughout this
 * codebase, e.g. `store/sqliteStore.ts`, `ratification/pendingLedger.ts` — a
 * Node builtin, not an npm package) via the same runtime-`require` pattern
 * (the built-in is newer than the test transformer's static-import allowlist).
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  DAEMON_GENESIS_HASH,
  hashPreimage,
  sha256Hex,
} from "./auditChain.js";
import type {
  AdminVerbPayload,
  AuthFailurePayload,
  ConnectionAcceptedPayload,
  DaemonAppendSink,
  DaemonAuditChain,
  DaemonChainHead,
  DaemonChainVerification,
  DaemonLedgerRecord,
  DaemonPayload,
  DaemonRecordKind,
  RevocationPayload,
  ShutdownMarkerPayload,
} from "./auditChain.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

function asString(v: unknown): string {
  return v as string;
}

export interface SqliteDaemonAuditChain extends DaemonAuditChain {
  /** Close the underlying handle (no-op for a borrowed, shared handle). */
  close(): void;
}

class SqliteDaemonAuditChainImpl implements SqliteDaemonAuditChain {
  readonly #db: DatabaseSyncType;
  readonly #ownsDb: boolean;
  readonly #onAppend: DaemonAppendSink | null;
  readonly #clock: () => number;

  readonly #insertRecord;
  readonly #allRecords;
  readonly #countRecords;
  readonly #lastRecord;

  constructor(opts: {
    db: DatabaseSyncType;
    ownsDb: boolean;
    onAppend: DaemonAppendSink | null;
    clock: () => number;
  }) {
    this.#db = opts.db;
    this.#ownsDb = opts.ownsDb;
    this.#onAppend = opts.onAppend;
    this.#clock = opts.clock;

    if (opts.ownsDb) {
      this.#db.exec("PRAGMA journal_mode=WAL");
      this.#db.exec("PRAGMA synchronous=NORMAL");
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS daemon_audit_records (
         seq  INTEGER PRIMARY KEY,
         json TEXT NOT NULL
       )`,
    );
    this.#insertRecord = this.#db.prepare(
      "INSERT INTO daemon_audit_records (seq, json) VALUES (?, ?)",
    );
    this.#allRecords = this.#db.prepare(
      "SELECT json FROM daemon_audit_records ORDER BY seq",
    );
    this.#countRecords = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM daemon_audit_records",
    );
    this.#lastRecord = this.#db.prepare(
      "SELECT json FROM daemon_audit_records ORDER BY seq DESC LIMIT 1",
    );
  }

  #parse(json: string): DaemonLedgerRecord {
    return JSON.parse(json) as DaemonLedgerRecord;
  }

  #chain(): DaemonLedgerRecord[] {
    return this.#allRecords.all().map((r) => this.#parse(asString((r as { json: unknown }).json)));
  }

  records(): readonly DaemonLedgerRecord[] {
    return this.#chain();
  }

  #append(kind: DaemonRecordKind, payload: DaemonPayload): DaemonLedgerRecord {
    const seq = Number((this.#countRecords.get() as { n: number }).n);
    const tail = this.#lastRecord.get();
    const prevHash =
      seq === 0 ? DAEMON_GENESIS_HASH : this.#parse(asString((tail as { json: unknown }).json)).thisHash;
    const thisHash = sha256Hex(hashPreimage(seq, prevHash, kind, payload));
    const record: DaemonLedgerRecord = { seq, prevHash, kind, payload, thisHash };
    // Ship-before-write (same ordering contract as pendingLedger's AppendSink):
    // a throwing sink aborts the append with nothing inserted.
    this.#onAppend?.(record);
    this.#insertRecord.run(seq, JSON.stringify(record));
    return record;
  }

  recordConnectionAccepted(
    p: Omit<ConnectionAcceptedPayload, "at">,
    now?: number,
  ): DaemonLedgerRecord {
    return this.#append("CONNECTION_ACCEPTED", { ...p, at: now ?? this.#clock() });
  }

  recordAuthFailure(p: Omit<AuthFailurePayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("AUTH_FAILURE", { ...p, at: now ?? this.#clock() });
  }

  recordRevocation(p: Omit<RevocationPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("REVOCATION", { ...p, at: now ?? this.#clock() });
  }

  recordAdminVerb(p: Omit<AdminVerbPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("ADMIN_VERB", { ...p, at: now ?? this.#clock() });
  }

  recordShutdown(p: Omit<ShutdownMarkerPayload, "at">, now?: number): DaemonLedgerRecord {
    return this.#append("SHUTDOWN_MARKER", { ...p, at: now ?? this.#clock() });
  }

  verifyChain(): DaemonChainVerification {
    const chain = this.#chain();
    let expectedPrev = DAEMON_GENESIS_HASH;
    for (let i = 0; i < chain.length; i++) {
      const r = chain[i]!;
      if (r.seq !== i) return { ok: false, firstBrokenSeq: i };
      if (r.prevHash !== expectedPrev) return { ok: false, firstBrokenSeq: i };
      const recomputed = sha256Hex(hashPreimage(r.seq, r.prevHash, r.kind, r.payload));
      if (recomputed !== r.thisHash) return { ok: false, firstBrokenSeq: i };
      expectedPrev = r.thisHash;
    }
    return { ok: true, firstBrokenSeq: null };
  }

  chainHead(): DaemonChainHead {
    const tail = this.#lastRecord.get();
    if (tail === undefined) return { seq: -1, headHash: DAEMON_GENESIS_HASH };
    const rec = this.#parse(asString((tail as { json: unknown }).json));
    return { seq: rec.seq, headHash: rec.thisHash };
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }
}

export interface CreateSqliteDaemonAuditChainOptions {
  readonly onAppend?: DaemonAppendSink;
  readonly clock?: () => number;
}

/**
 * Open (or create) a durable daemon audit chain at `dbPath` — a DEDICATED
 * SQLite file, never the memory-engine's own db (so daemon transport audit
 * events stay decoupled from fact/ratification storage, matching R8's
 * "stays semantically pure" rationale one layer further: not just a separate
 * chain, a separate file). Reopening an existing file continues the SAME
 * chain (seq/prevHash recomputed from the persisted tail) rather than
 * starting a fresh one — the property that makes `verifyChain()` meaningful
 * across a daemon restart or crash (H4).
 */
export function createSqliteDaemonAuditChain(
  dbPath: string,
  opts?: CreateSqliteDaemonAuditChainOptions,
): SqliteDaemonAuditChain {
  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  return new SqliteDaemonAuditChainImpl({
    db,
    ownsDb: true,
    onAppend: opts?.onAppend ?? null,
    clock: opts?.clock ?? Date.now,
  });
}
