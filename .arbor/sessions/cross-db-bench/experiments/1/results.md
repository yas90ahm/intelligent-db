# Cross-DB Baseline — Intelligent DB vs dumb stores under cheap-Sybil poisoning

Workload: N=5000 facts written, 250 recalls (median latency), 24 attack trials (H=3 honest, A in {5, 50, 200}). Node v24.16.0 on win32.

`poison_correct_rate` = fraction of cheap-Sybil trials where the engine recalled the TRUE value. A trust-blind store (SQL/KV majority, vector nearest-neighbour) is EXPECTED to score 0 (it speaks the FALSE majority); the IntelligentDB engine collapses the fleet to one independent witness and scores 1.

| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes_per_fact | footprint source |
|---|---:|---:|---:|---:|:--|
| node:sqlite (builtin) | 1,062,541 | 0.006 | 0 (0/24) | 69.2 | on-disk file |
| better-sqlite3 | 845,552 | 0.005 | 0 (0/24) | 69.2 | on-disk file |
| lmdb | 9,147 | 0.005 | 0 (0/24) | 52.4 | on-disk file |
| duckdb (@duckdb/node-api) | 92,691 | 0.863 | 0 (0/24) | 107.3 | on-disk file |
| vector-bruteforce (in-proc) | 7,905,138 | 0.454 | 0 (0/24) | 269.8 | in-memory estimate |
| IntelligentDB (engine) | 306,007 | 0.003 | 1 (24/24) | 1,445.4 | heap delta |

## SKIPPED adapters

- **hnswlib-node** — No prebuilt binary for win32-x64 / Node 24; npm install falls back to `node-gyp rebuild`, which needs an MSVC toolchain (absent on this box) — the native module never built (Cannot find module 'hnswlib-node').
- **faiss-node** — Not attempted by directive (requires MSVC to build) — would fail identically to hnswlib-node.

## Notes

- **Footprint source**: on-disk file = data + WAL file size after flush; in-memory estimate = dense embedding bytes (N x 64 x 4) + value strings; heap delta = `process.memoryUsage().heapUsed` before/after the write loop (approximate — GC was nudged only if `--expose-gc` was passed).
- **Dumb-store recall**: SQL/KV engines return the MAJORITY value for the (entity, attribute) (ties broken by most-recent); the vector engine returns the majority value among the top-128 nearest neighbours of the cue embedding. None has a provenance/independence model, so all are poisoned once the cheap fleet out-copies the truth — the honest, expected result.
- **IntelligentDB recall**: groups the asserted facts by value and ranks each value by the REAL Source-Identity Layer `independentRootCount` (maximum-independent-set over anchor-class disjointness). Writes go through the genuine engine `writeFact`. The attacker controls keys, not class assignment (the external anchor layer's output), exactly as the Phase-2 capability test models.
- **hnswlib-node** (the intended native vector engine) has no win32-x64/Node-24 prebuilt and needs MSVC to build, so the zero-dep `vector-bruteforce` index stands in for the vector-DB class.