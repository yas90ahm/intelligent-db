# Phase 2 — Extreme Durability (spec)

Owner: product. Status: approved for implementation. Gate: 1,000 kill-cycles with
zero half-states; restore-to-timestamp verified byte-exact; encrypted DB passes the
full suite; upgrade-from-old-fixture test green.

Constraint: zero runtime dependencies stands. `node:sqlite` + `node:crypto` +
`node:fs` only. Nothing here may weaken the audit chain's guarantees.

## 1. Schema migration ladder

- `PRAGMA user_version` as the schema version. Current schema (as shipped today)
  is retroactively **v1**; a fresh DB is stamped at creation.
- `store/migrations.ts`: ordered list `MIGRATIONS: Array<{ to: number,
  up: (db) => void }>`. On open: if `user_version < latest`, run pending
  migrations inside ONE transaction, then stamp. If `user_version > latest`,
  REFUSE to open (never let old code write a newer schema) with a clear error.
- Phase 1's `strand_vectors` table lands as migration v2 — the two phases meet here.
- Test: commit a v1 fixture DB (small, checked in under `src/__tests__/fixtures/`),
  open it with current code, assert migration runs once, data intact, audit chain
  still verifies, reopen idempotent.

## 2. Online backup + point-in-time recovery

- `db.snapshot(destPath)`: online snapshot via `VACUUM INTO` (works on a live WAL
  database, produces a compact consistent copy). If `node:sqlite` exposes the
  backup API in the running Node version, prefer it; VACUUM INTO is the portable
  floor. Snapshot includes a sidecar manifest `{ createdAt, chainHead, userVersion,
  schemaHash }` written AFTER the snapshot and fsynced.
- WAL archiving: `createIntelligentDb(..., { walArchive?: { dir } })` — on each
  checkpoint, the WAL segment is copied to `dir` with a monotonically-named file
  before SQLite truncates it (use `PRAGMA wal_checkpoint(TRUNCATE)` under our
  control on a timer/threshold; disable auto-checkpoint when archiving is on).
- `restoreToTimestamp(snapshotPath, walArchiveDir, t)`: copy snapshot, replay
  archived WAL segments up to `t`, verify: `PRAGMA integrity_check` ok AND
  `verifyChain()` ok AND chainHead seq consistent with the manifest. Restore
  REFUSES to complete if the chain doesn't verify — a restore that can't prove
  its own integrity is a failure, not a warning.
- Test: write facts across N checkpoints, snapshot mid-way, keep writing, restore
  to a timestamp between two later checkpoints, assert exactly the facts written
  before `t` are present and the chain verifies to its recorded head at `t`.

## 3. Encryption at rest (value-level AES-256-GCM)

- Adapter around the SQLite store: `createEncryptedStore(inner, keyProvider)`.
  `keyProvider: () => Buffer` (32 bytes) — sourcing (env, OS keychain, KMS) is the
  deployment's job; ship an env-var reference provider in examples only.
- Encrypt: strand payload JSON, edge annotations, ledger record payloads. Each
  value: random 12-byte IV, GCM tag stored alongside (`iv || tag || ciphertext`).
  AAD = the row's stable identity (strand id / ledger seq) so ciphertexts cannot
  be swapped between rows without detection.
- Stays PLAINTEXT by design (document loudly): ids, content_hash, entity index
  keys, provenance class ids, tier/state enums, chain hashes — the graph shape is
  metadata needed for indexing; the CONTENT is what's protected. This is
  value-level encryption, not full-file (full-file = OS FDE/SQLCipher territory,
  out of scope, stated in KNOWN LIMITATIONS).
- The audit chain hashes the CIPHERTEXT (chain remains verifiable without the key);
  `verifyChain()` works on an encrypted DB without decrypting.
- Test: full default suite runs green under the encrypted store (parametrize the
  existing store test matrix); wrong key => clean typed error, no crash, no
  partial reads; a flipped ciphertext byte => GCM auth failure surfaced as a
  named integrity error naming the row.

## 4. Torture suite (`src/__torture__/`, env-gated TORTURE=1, plus CI smoke at 50 cycles)

a. **Kill-loop**: child process performs randomized compound ops (writeFact batches,
   adjudicate, approve, disown, ratify) in a tight loop; parent SIGKILLs it at a
   random 5–50ms delay; reopen, assert `integrity_check` ok, `verifyChain()` ok,
   reconcileLedger ok, and INVARIANT SCAN: no loser demoted without its OUTRANKS
   edge, no APPROVAL record without its demotions, no half-applied disown
   (write a dedicated invariant checker — this is the heart of the suite).
   1,000 cycles nightly; 50 in CI.
b. **Disk-full**: wrap the store's file handle dir on a tiny tmpfs-like quota
   (Windows: a small VHDX is overkill — simulate by injecting fs errors via a
   fault-injection shim on the archive/snapshot paths); assert typed errors, no
   corruption, writes resume after space clears.
c. **Torn-write simulation**: corrupt the last N bytes of WAL/db after kill;
   assert SQLite recovery + our verifiers converge to the last durable txn.
d. **Soak**: 2-hour continuous mixed load at ~1k ops/s with hourly snapshot +
   archive + a live restore drill; memory RSS must plateau (no leak), p99 recall
   < 10ms throughout.

## 5. Deliverable docs

Update KNOWN LIMITATIONS: cross out backup/PITR, migrations, encryption-at-rest
(with the value-level scope honestly stated). Add `docs/OPERATIONS.md`: snapshot
cadence guidance, archive layout, restore runbook, key rotation note (re-encrypt
offline via snapshot round-trip).
