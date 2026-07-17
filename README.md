# Intelligent DB

AI agents forget things. More awkwardly, they can remember a claim without remembering where it came from.

I wanted a memory store where the source is part of the fact, not a footnote added later. So intelligent-db stores provenance, keeps contradictory claims visible and treats two copies from the same root as one source rather than two votes.

It is a TypeScript research prototype. The package is private and still version `0.0.0`, which is a better description of its maturity than some of the older documents in this repository.

[![CI](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml/badge.svg)](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)

## What it does

- stores facts as graph strands with source and citation data
- recalls from a cue through spreading activation
- keeps disputed facts visible instead of deleting the losing side
- measures source independence before treating repetition as corroboration
- persists to SQLite with migrations, snapshots and restore support
- exposes an in-process API, MCP server and optional shared daemon

Vectors can help seed recall and reorder presentation. They do not decide belief or source independence.

## What it does not prove

This project does not make poisoning impossible. A patient attacker who controls genuinely independent, expensive identities can still win. The system tries to make cheap coordinated repetition visible and less useful.

The identity layer consumes trust signals supplied by configuration and surrounding infrastructure. It does not prove that a domain, device or person is honest.

The local hash chains show internal consistency. Someone with enough filesystem access can rewrite data and recompute an unsigned chain. External immutable storage is still needed if that threat matters.

And the current daemon test matrix has an intermittent shutdown race: a connection has sometimes completed authentication after shutdown began. One Node version may pass while the other fails. Treat daemon shutdown as under review until that is resolved.

## Quickstart

Node 22.13 or newer is required.

```bash
git clone https://github.com/yas90ahm/intelligent-db.git
cd intelligent-db
npm install
npm run build
```

The package is not published to npm. Use it from source.

```ts
import { createAgentMemory } from "./dist/index.js";

const memory = createAgentMemory({
  dbPath: "./memory.db",
});

memory.remember({
  text: "the deployment window is Friday at 8pm",
  entity: "entity:deployment",
  attribute: "deployment#window",
  origin: {
    kind: "file",
    resourceId: "change-record-1842",
  },
});

const result = memory.recall("when is the deployment window?");

for (const fact of result.facts) {
  console.log(fact.text, fact.citation, fact.fact_state);
}

memory.close();
```

Run the narrated example:

```bash
npm run demo
```

## MCP server

Build first, then register the local server:

```bash
npm run build
claude mcp add intelligent-db -- node /absolute/path/to/dist/mcp/server.js
```

Set `MEMORY_DB` if you want a durable SQLite file.

The MCP surface exposes five memory actions:

- remember
- recall
- list pending questions
- resolve a pending dispute with confirmation
- explain why a fact is believed

Administrative trust mutations are not MCP tools.

## Optional daemon

The normal library runs in-process. Daemon mode is a separate, opt-in process for clients that need one shared memory store.

```bash
npm run build
node dist/daemon/cli.js --data-dir ./idb-data
```

Read [`OPERATIONS.md`](./OPERATIONS.md) before using it. On Windows, take the endpoint from the generated daemon JSON. `MEMORY_DAEMON_TOKEN_FILE` must point to a file containing the raw bearer token, not the JSON file itself.

## How recall is ordered

The default is the activation walk. A cue lights the graph and the strongest related strands surface.

An optional embedder can propose additional seeds:

```ts
const memory = createAgentMemory({ embedder });
```

Blended vector/graph presentation is opt-in:

```ts
const memory = createAgentMemory({
  embedder,
  rankMode: "blend",
});
```

Similarity changes which eligible facts appear first. It does not change their belief state.

## Persistence and encryption

SQLite mode includes WAL use, schema migrations, online snapshots, WAL archiving and point-in-time restore. An optional AES-256-GCM adapter encrypts strand payload values.

Encryption needs a key provider supplied by the caller. Key rotation and backup handling remain the caller's job. Read the known limitations in [`CLAUDE.md`](./CLAUDE.md) and the runbook in [`OPERATIONS.md`](./OPERATIONS.md).

## Benchmarks

The repository includes poisoning, retrieval and cross-store benchmarks. The July 2026 rerun measured:

- 24/24 cheap-Sybil trials passed for intelligent-db; the ten trust-blind comparison stores scored 0/24 in that harness
- 6% attack success for intelligent-db versus 96% for mem0 on the repository's PoisonedRAG-nq run
- 0.0% attack success with 99.8% accuracy on the 601-question FactWorld run; flat RAG measured 98.7% attack success

These are results from the committed harness, not independent production validation. The poor results are kept too. For example, the first seeded LoCoMo configuration missed its target, and the later blended configuration reached recall@20 of 0.481 against the cited mem0 value of 0.484.

Start with:

- [`BENCH_RERUN_2026-07-06.md`](./BENCH_RERUN_2026-07-06.md)
- [`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md)
- [`docs/INTEGRITY_AUDIT.md`](./docs/INTEGRITY_AUDIT.md)

## Development

```bash
npm run typecheck
npm test
npm run build
```

Run one test while working:

```bash
npx vitest run src/path/to/file.test.ts
```

Benchmarks and torture tests use separate environment flags and may need native development dependencies. They are not required for the normal library build.

There is no lint or formatting command yet. Typecheck and tests are the current code gate.

## Repository map

```text
src/                    runtime, tests and benchmark harnesses
.arbor/sessions/        committed benchmark evidence
docs/                   current architecture, product and operations documents
docs/history/           superseded designs and dated launch records
figures/                benchmark figures and their generator
scripts/                demos and benchmark helpers
```

The repository has a lot of evidence in it. Some of it should eventually move out of the source tree, but only after every published number has a manifest and a stable citation. Deleting first would make the claims cleaner and the evidence worse.

## Contributing and security

Read [`AGENTS.md`](./AGENTS.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md) before changing code. Report security issues through [`SECURITY.md`](./SECURITY.md).

Apache 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
