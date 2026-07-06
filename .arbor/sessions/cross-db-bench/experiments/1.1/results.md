# Cross-DB Baseline — Intelligent DB vs dumb stores under cheap-Sybil poisoning

Workload: N=5000 facts written, 250 recalls (median latency), 24 attack trials (H=3 honest, A in {5, 50, 200}). Node v24.16.0 on win32.

`poison_correct_rate` = fraction of cheap-Sybil trials where the engine recalled the TRUE value. A trust-blind store (SQL/KV majority, vector nearest-neighbour) is EXPECTED to score 0 (it speaks the FALSE majority); the IntelligentDB engine collapses the fleet to one independent witness and scores 1.

| Engine | write_hz | recall_ms (median) | poison_correct_rate | bytes_per_fact_disk (FAIR) | bytes_per_fact_heap | footprint source |
|---|---:|---:|---:|---:|---:|:--|
| node:sqlite (builtin) | 966,445 | 0.006 | 0 (0/24) | 69.2 | 333.7 | on-disk file |
| better-sqlite3 | 876,516 | 0.005 | 0 (0/24) | 69.2 | 345.3 | on-disk file |
| lmdb | 9,084 | 0.004 | 0 (0/24) | 52.4 | 0 | on-disk file |
| duckdb (@duckdb/node-api) | 91,785 | 0.862 | 0 (0/24) | 107.3 | 775.1 | on-disk file |
| vector-bruteforce (in-proc) | 7,702,973 | 0.46 | 0 (0/24) | n/a | 351.7 | in-memory estimate |
| IntelligentDB (engine) | 89,258 | 0.004 | 1 (24/24) | 2,266 | 2,336.8 | on-disk file |
| Qdrant (docker) | 11,447 | 48.162 | 0 (0/24) | 124,205.1 | 1,673.4 | db-reported size |
| Postgres+pgvector (docker) | 74,091 | 0.673 | 0 (0/24) | 1,965.9 | 0 | db-reported size |
| Redis-Stack (docker) | 123,633 | 0.657 | 0 (0/24) | 1,630.5 | 2,289.4 | db-reported size |

`bytes_per_fact_disk` is the FAIR, apples-to-apples column: on-disk file size (sqlite/lmdb/duckdb/IntelligentDB) or the DB's own reported size (Qdrant/Postgres/Redis), divided by N. `n/a` = the engine is purely in-memory (vector-bruteforce) so no on-disk figure exists. `bytes_per_fact_heap` is the cycle-1 heap-delta proxy, kept for continuity but NOT comparable across engines (it only reflects what stayed on the JS heap).

## SKIPPED adapters

- **hnswlib-node** — No prebuilt binary for win32-x64 / Node 24; npm install falls back to `node-gyp rebuild`, which needs an MSVC toolchain (absent on this box) — the native module never built (Cannot find module 'hnswlib-node').
- **faiss-node** — Not attempted by directive (requires MSVC to build) — would fail identically to hnswlib-node.

## BLOCKED adapters

- **Mem0 (mem0ai, Python)** — mem0ai 2.0.10 installs and the local sentence-transformers embedder works, but Memory.from_config eagerly builds an LLM at init: default ⇒ OpenAIError 'Missing credentials' (no OPENAI_API_KEY); llm.provider=ollama ⇒ needs the `ollama` package + a running local LLM server. No way to run with NO LLM / NO key, and no key was supplied.

## Notes

- **Footprint method, per engine** (how `bytes_per_fact_disk` was measured): node:sqlite / better-sqlite3 / lmdb / duckdb / **IntelligentDB** = on-disk file size (data + WAL/sidecars) after flush; **Qdrant** = `du -sb /qdrant/storage` inside the container (actual segment + WAL bytes); **Postgres+pgvector** = `pg_database_size(current_database())`; **Redis-Stack** = `INFO memory` `used_memory` (Redis is IN-MEMORY, so this is resident dataset RAM, not on-disk bytes — the directive's sanctioned best-effort; flagged here so it is not read as a disk figure); **vector-bruteforce** = in-memory only ⇒ `n/a` for disk. `bytes_per_fact_heap` is the `process.memoryUsage().heapUsed` delta across the write loop (approximate; GC nudged only under `--expose-gc`).
- **Cycle-2 fairness fix**: cycle-1 mixed ID's heap delta with the stores' on-disk sizes. ID now writes through the real durable `createSqliteStore(<temp file>)` (WAL) backend, so its footprint is on-disk-vs-on-disk with sqlite/lmdb/duckdb. The heap column is retained for continuity but is explicitly NOT cross-comparable.
- **Dumb-store recall**: SQL/KV engines return the MAJORITY value for the (entity, attribute) (ties broken by most-recent); the vector engines (vector-bruteforce, Qdrant, Postgres+pgvector, Redis-Stack) return the MAJORITY value among the top-256 nearest neighbours of the cue embedding FILTERED to the cued entity (Qdrant payload filter / pg `WHERE entity=` / RediSearch `@entity` TAG). None has a provenance/independence model, so all are poisoned once the cheap fleet out-copies the truth — the honest, expected result (poison_correct_rate = 0).
- **Docker vector-DB mapping**: every engine embeds the SAME deterministic 64-d hashed vector (`embeddings.ts`) for an (entity, attribute, value) fact, upserts it with a {entity, attribute, value} payload, and answers a recall by entity-filtered vector KNN + majority value. Containers are started in `setup()` (stale same-name container force-removed first), polled for readiness (port + a real client handshake), and force-removed in `close()` so nothing leaks; an image-pull / start / connect failure marks that adapter SKIPPED and the run continues.
- **IntelligentDB recall**: groups the asserted facts by value and ranks each value by the REAL Source-Identity Layer `independentRootCount` (maximum-independent-set over anchor-class disjointness). Writes go through the genuine engine `writeFact`. The attacker controls keys, not class assignment (the external anchor layer's output), exactly as the Phase-2 capability test models.
- **hnswlib-node** (the intended native vector engine) has no win32-x64/Node-24 prebuilt and needs MSVC to build, so the zero-dep `vector-bruteforce` index stands in for the vector-DB class.