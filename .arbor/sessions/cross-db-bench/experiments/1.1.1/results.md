# Cycle-3 optimization (node 1.1.1) — IntelligentDB adapter on-disk write throughput

**Cycle-3 optimization: before/after — ID write_hz 21,284/s → 104,463/s (~4.9x).** poison_correct_rate held at 1.0 (24/24).

## What changed (adapter-only; engine + 252 tests untouched)

The engine's `writeFact` already wraps its single `putStrand` in `withTxn`, which on the
on-disk WAL backend emits one `BEGIN`/`COMMIT` — one fsync-class durability barrier — **per
fact**. A real bulk-ingest user does not pay one commit per row. The adapter now opens ONE
outer `store.beginTxn()` (lazily, on the first buffered write) and commits it in a new
`flush()` method. The engine's per-fact `withTxn` is NESTABLE (sqliteStore `#txnDepth`
guard): inside the open transaction it enrolls instead of issuing its own `BEGIN`/`COMMIT`,
so the whole 5,000-fact batch collapses to **one** durability barrier.

This changes ONLY the commit batching. Every fact still flows through the genuine mint path
(provenance roots, content hash, entity index, trust metadata); recall still consults the
real Source-Identity Layer `independentRootCount` over the in-memory class index — so
adjudication semantics are byte-for-byte identical and the poison rate is unchanged. The
change is confined to `src/__bench__/crossdb/adapters/intelligentDb.ts` (`writeFact` opens
the txn, new `flush()` commits it, `close()` commits any straggler defensively).

API used: `SqliteStrandStore.beginTxn()` (the nestable shared-handle unit-of-work already
shipped in commit 4500c60) + the `MemoryAdapter.flush()` hook the runner already calls after
each write phase.

## Results (N=5000, 250 recalls, 24 attack trials; Node v24.16.0, win32)

| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes_per_fact_disk (FAIR) | footprint source |
|---|---:|---:|---:|---:|:--|
| node:sqlite (builtin) | 1,072,593 | 0.006 | 0.00 (0/24) | 69.2 | on-disk file |
| better-sqlite3 | 866,987 | 0.005 | 0.00 (0/24) | 69.2 | on-disk file |
| lmdb | 9,217 | 0.004 | 0.00 (0/24) | 52.4 | on-disk file |
| duckdb (@duckdb/node-api) | 94,479 | 0.840 | 0.00 (0/24) | 107.3 | on-disk file |
| vector-bruteforce (in-proc) | 6,645,401 | 0.454 | 0.00 (0/24) | n/a | in-memory estimate |
| **IntelligentDB (engine)** | **104,464** | **0.003** | **1.00 (24/24)** | **2,266.0** | on-disk file |
| Qdrant (docker) | 12,397 | 48.087 | 0.00 (0/24) | 124,205.1 | db-reported size |
| Postgres+pgvector (docker) | 71,137 | 0.656 | 0.00 (0/24) | 1,965.9 | db-reported size |
| Redis-Stack (docker) | 145,446 | 0.639 | 0.00 (0/24) | 1,630.5 | db-reported size |

After batching, ID's on-disk write throughput (104k/s) now exceeds lmdb, Qdrant, and is in
the same class as duckdb and Postgres+pgvector, while remaining the ONLY engine that recalls
the TRUE value under the cheap-Sybil attack (poison_correct_rate 1.0).

## Footprint note (inherent cost, NOT a regression)

ID's `bytes_per_fact_disk` (~2,266 B/fact, WAL-inclusive) is the feature, not waste: ID
stores a **provenance DAG + offline-assigned independence classes + audit/trust metadata**
per fact — that is exactly what lets it collapse a Sybil fleet to one independent witness and
recall the truth. The dumb stores (~52–107 B/fact) store a bare row with no provenance and
are poisoned 0/24. The footprint is the price of the trust model and is left unchanged this
cycle by design.

## Remaining bottleneck (honest, for a future engine-level cycle)

Even batched, ID (~104k/s) is ~10x below node:sqlite (~1M/s). The residual is NOT the commit
barrier (now amortized) — it is the per-fact engine work in `makeObservedStrand`: two
`randomUUID()` calls (strand id + provenance root id), a SHA-256 `content_hash`, and a
`JSON.stringify` of the full strand object (provenance/salience/bridge sub-objects) before the
single `putStrand`. That is intrinsic provenance/mint CPU, not I/O.

Recommendation (engine cycle, NOT done here): expose a real `writeFactsBatch(inputs[])` engine
verb that mints under one transaction AND amortizes the per-fact crypto/serialization (e.g. a
single prepared `putStrandsBatch`, cheaper id minting), so bulk ingest pays the provenance cost
once per batch of bookkeeping rather than per fact. This is an engine `src/api.ts` +
`store/sqliteStore.ts` change and was deliberately NOT made (adapter-only cycle).

## Gates

- `npm run typecheck` — exit 0.
- `npm test` — 252 passed, 3 skipped (the gated bench runner + 2 env-gated suites).
- Change confined to `src/__bench__/crossdb/adapters/intelligentDb.ts`. No engine source edited.
