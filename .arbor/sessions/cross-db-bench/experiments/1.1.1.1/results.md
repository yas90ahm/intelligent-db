# Cycle-4 optimization (node 1.1.1.1) — a real ENGINE `writeFactsBatch` bulk-ingest verb

**Cycle-4: ID write_hz 104,464/s (cycle 3) → ~100,054/s (cycle 4 mean of 5 samples; range 98,271–103,759).** poison_correct_rate held at 1.0 (24/24).

**Honest headline: the speedup is ~0 (flat, within run-to-run noise).** This is the EXPECTED result and it CONFIRMS cycle-3's recorded prediction — see "Why the gain is marginal" below.

## What changed (a production ENGINE change this time, not adapter-only)

Cycle 3 batched the *commit* at the adapter by holding one outer `beginTxn()` open. This cycle adds the public engine verb cycle-3 recommended:

```ts
writeFactsBatch(inputs: readonly WriteFactInput[]): StrandId[] {
  const fresh = inputs.map((input) => makeObservedStrand(input, now()));
  withTxn(this.#store, () => { this.#store.putStrandsBatch(fresh); });
  return fresh.map((s) => s.id);
}
```

It mirrors `writeFact` EXACTLY per fact (per-fact `now()` + `makeObservedStrand` — same content hash, provenance-from-stamp, WARM grace pin, entity index), differing only in that the puts are batched: one `putStrandsBatch` under one `withTxn`, so the whole ingest pays ONE durability barrier and the store maintains the SAME entity index N `putStrand` calls would.

Files touched (engine + store, not just the bench):
- `src/api.ts` — `writeFactsBatch` on the `IntelligentDb` interface (JSDoc'd) + the impl.
- `src/store/StrandStore.ts` — `putStrandsBatch(strands)` lifted onto the BASE `StrandStore` interface (it previously existed only on the `SqliteStrandStore` widening, so `this.#store` — typed `StrandStore` — could not call it).
- `src/store/memoryStore.ts` — `MemoryStrandStore.putStrandsBatch` implemented as the per-strand `putStrand` loop (already atomic-per-call; index/replace semantics identical).
- `src/__bench__/crossdb/adapters/intelligentDb.ts` — `writeFact` now buffers the engine `WriteFactInput`; `flush()` drains the buffer through `engine.writeFactsBatch(buffer)` (replacing the cycle-3 manual `beginTxn`+`commit` hack). Recall / `poison_correct_rate` path UNCHANGED.

## Results (N=5000, 250 recalls, 24 attack trials; Node v24.16.0, win32)

| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes_per_fact_disk (FAIR) | footprint source |
|---|---:|---:|---:|---:|:--|
| node:sqlite (builtin) | 1,006,522 | 0.006 | 0.00 (0/24) | 69.2 | on-disk file |
| better-sqlite3 | 832,515 | 0.005 | 0.00 (0/24) | 69.2 | on-disk file |
| lmdb | 8,091 | 0.005 | 0.00 (0/24) | 52.4 | on-disk file |
| duckdb (@duckdb/node-api) | 88,264 | 0.907 | 0.00 (0/24) | 107.3 | on-disk file |
| vector-bruteforce (in-proc) | 6,777,823 | 0.449 | 0.00 (0/24) | n/a | in-memory estimate |
| **IntelligentDB (engine)** | **98,911** (mean ~100,054) | **0.003** | **1.00 (24/24)** | **2,267.6** | on-disk file |
| Qdrant (docker) | 12,216 | 48.052 | 0.00 (0/24) | 124,205.1 | db-reported size |
| Postgres+pgvector (docker) | 75,430 | 0.616 | 0.00 (0/24) | 1,965.9 | db-reported size |
| Redis-Stack (docker) | 137,032 | 0.650 | 0.00 (0/24) | 1,630.6 | db-reported size |

(The `IntelligentDB` row above is a single representative run, 98,911/s; the 5-sample mean is ~100,054/s with range 98,271–103,759. cycle-3 recorded 104,464/s.) ID remains the ONLY engine that recalls the TRUE value under the cheap-Sybil attack (poison_correct_rate 1.0); every dumb store is poisoned 0/24.

## Why the gain is marginal (the honest finding)

Cycle 3 already collapsed the 5,000 per-fact commits into one outer transaction, so the durability barrier was NOT the residual bottleneck. `writeFactsBatch` swaps cycle-3's "outer txn + per-fact `putStrand` (reusing one prepared INSERT)" for "outer txn + one `putStrandsBatch` (reusing the SAME prepared INSERT)" — the I/O path is essentially identical, so it should be, and is, a wash.

The dominant per-fact cost is the **mint CPU in `makeObservedStrand`**, which `writeFactsBatch` deliberately does NOT change (it must mint semantically-identical strands): two `randomUUID()` calls (strand id + provenance root id), a SHA-256 `content_hash`, and a `JSON.stringify` of the full strand (provenance / salience / bridge sub-objects). That is intrinsic provenance/trust CPU, not I/O — exactly the residual cycle-3's results.md flagged. A genuine bulk speedup would require amortizing that crypto/serialization (cheaper id minting, batched hashing), a separate and riskier change not made here.

**The deliverable of this cycle is therefore the VERB, not a number:** a clean, public, semantically-proven-equivalent, atomic bulk-ingest API — not a throughput win the per-fact mint cost forbids.

## Correctness (the verb is proven, not just benched)

New `src/__tests__/writeFactsBatch.test.ts` (7 tests, over BOTH the memory and SQLite backends):
- **Equivalence** — K=25 facts via `writeFactsBatch` produce content-identical stored strands (entity/attribute/payload/origin/fact_state/tier/content_hash/provenance shape), index-for-index, to the same K inputs via individual `writeFact` on a separate db; the entity index agrees on both.
- **Return contract** — K distinct ids in input order, each retrievable and matching its input's entity/attribute/payload.
- **Atomicity (SQLite)** — a forced throw mid-`putStrandsBatch` (after one durable write inside the open `withTxn`) rolls the WHOLE batch back: nothing persisted, `integrity_check` still true, and the store is cleanly reusable (the op then genuinely lands all rows).
- **Empty input** — `writeFactsBatch([])` returns `[]`, writes nothing, no throw.

## Gates

- `npm run typecheck` — exit 0.
- `npm test` — **259 passed, 3 skipped** (was 252 passed / 3 skipped; +7 new `writeFactsBatch` tests). No previously-passing test changed or weakened.
- Engine change is production code (`api.ts`, `StrandStore.ts`, `memoryStore.ts`) + the bench adapter; all prior suites (atomicCompound, systemCoherence, sqliteStore, smoke, durableLedgers, …) still green.
