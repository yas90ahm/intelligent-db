# Deployment Profile — Intelligent DB on-disk SQLite/WAL

Engine-only (no Docker/external clients). `createIntelligentDb` over a durable `createSqliteStore(<tempfile>)` (WAL, synchronous=NORMAL). Node v24.16.0, win32/x64. Generated 2026-07-06T16:01:41.030Z.

## Scaling table (the headline)

| size | write p50 (µs) | write p99 (µs) | recall p50 (ms) | recall p99 (ms) | bytes/fact | recall lit (mean) | seed (s) |
|---|---|---|---|---|---|---|---|
| 1k | 29.4 | 378.6 | 2.032 | 2.892 | 967 | 77 | 0 |
| 10k | 26.3 | 116.4 | 1.973 | 2.278 | 913 | 77 | 0.1 |
| 100k | 26 | 311.7 | 1.972 | 2.301 | 915 | 77 | 0.6 |
| 1M | 28.7 | 92.9 | 2.093 | 3.544 | 922 | 77 | 6.4 |

## Deployment verdict

Recall is essentially FLAT across 1k/10k/100k/1M (p50 spread 1.06× over a 1,000× data-size increase): it is O(local web), not O(total facts), because the activation walk is pop-cap/energy-decay bounded. Recall p50 crosses 1 ms at N=1k but never 10 ms (max 2.09 ms). Single writes stay around p99 379 µs. Under a sustained 95/5 mixed load at 100k the engine sustains ~39 ops/s with no significant checkpoint stall. Cold-start is cheap: reopening the 1M file takes 1.4 ms and the first recall 5.21 ms (WAL recovery is near-free). Concurrent readers scale 3.57× at K=8 (WAL many-reader).

## 2. Recall flatness

Across 1k → 10k → 100k → 1M (a 1,000× growth in total facts), recall p50 ranges 1.972–2.093 ms (1.06× spread) and recall p99 ranges 2.278–3.544 ms. The mean lit-set size is ~77 strands and the mean pops ~77 at every size — the activation walk is bounded by its pop-cap / energy-decay backstop, so recall touches the LOCAL web, not the whole store.

> **Verdict:** recall is **FLAT** as total web size grows (p50 spread 1.06× over a 1,000× data-size increase). It stays under 10 ms but crosses 1 ms.

## 3. Mixed sustained workload (95% read / 5% write, ~30s)

_Reads here use VARIED cues rotating over a bounded hot working set (so a WAL-checkpoint stall shows as max≫p99), which costs more per recall than the scaling table's single fixed warm seed — both are honest, they characterize different access patterns._

- web size: **100k**, duration 30 s
- **aggregate 39 ops/s** (1180 ops: 1113 reads, 67 writes)
- read p50 / p99: **26.431 / 33.039 ms**
- write p50 / p99: **0.1481 / 0.2882 ms**
- max latency **38.94 ms** vs all-ops p99 **33.039 ms** (max/p99 = 1.2×) — no significant checkpoint stall (max not ≫ p99).

## 4. Cold-start (reopen + first recall after close)

| size | reopen (ms) | first recall (ms) |
|---|---|---|
| 100k | 2.44 | 4.737 |
| 1M | 1.39 | 5.206 |

## 5. Concurrent readers (worker_threads, same file, read-only)

Each worker opens the SAME db file with its own read-only `node:sqlite` connection and runs the EXACT read queries the activation walk issues (getStrand + strandsByEntity + outEdges over a 200-hub sweep). This measures the WAL read-path concurrency of the single-process embedded design. (It is the SQLite read substrate, not the full TypeScript walk — a raw worker cannot load the engine's enum-bearing barrel without a build; documented honestly.)

| K (readers) | reads/s | scale vs K=1 |
|---|---|---|
| 1 | 3,609,358 | 1.00× |
| 2 | 4,739,543 | 1.31× |
| 4 | 8,119,161 | 2.25× |
| 8 | 12,876,428 | 3.57× |

WAL many-reader scaling: at K=8 aggregate read throughput is 3.57× the single-reader baseline. Concurrent reads DO scale on this design.

---
Largest N that completed end-to-end: **1M**.
