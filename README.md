# Intelligent DB

AI agents forget things. Sometimes they remember the claim and lose where it came from, which may be worse.

I wanted the source to stay attached to the fact. Intelligent DB keeps contradictory claims visible too. And when two claims came from the same root, it does not count them as two independent votes.

This is a TypeScript research prototype. The package is private and still at version `0.0.0`. That is probably the most honest description of where it is.

[![CI](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml/badge.svg)](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)

## What it does

- stores facts with their source and citation
- recalls related facts through an activation walk
- keeps disputes open until something resolves them
- checks whether repeated claims are actually independent
- persists to SQLite with migrations and restore support
- runs as an in-process library, an MCP server or an optional shared daemon

Vectors can help find a starting point and change the order of the result. They do not decide whether a source should be believed.

## Where it stops

Intelligent DB makes cheap repetition less useful. It cannot stop an attacker who controls genuinely independent and trusted identities.

The identity layer accepts trust information from the surrounding system. It does not prove that a person or device is honest. The local hash chain can show internal consistency, but someone with enough filesystem access can rewrite the data and recompute an unsigned chain.

The daemon also has an intermittent shutdown race under review. A connection has sometimes completed authentication after shutdown began.

## Start it

Use Node.js 22.13 or newer.

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

Run the narrated example with `npm run demo`.

## MCP

Build first, then register the local server:

```bash
npm run build
claude mcp add intelligent-db -- node /absolute/path/to/dist/mcp/server.js
```

Set `MEMORY_DB` if you want a durable SQLite file. The MCP surface can remember and recall a fact. It can explain one too. Open disputes can be listed or resolved after confirmation.

Administrative trust changes are kept outside the MCP surface.

## Shared daemon

The normal library runs inside the caller's process. Daemon mode is optional and gives several clients one memory store.

```bash
npm run build
node dist/daemon/cli.js --data-dir ./idb-data
```

Read [`OPERATIONS.md`](./OPERATIONS.md) before using it. On Windows, use the endpoint written to the daemon JSON file. `MEMORY_DAEMON_TOKEN_FILE` points to the raw bearer-token file.

## Storage

SQLite mode uses WAL and schema migrations. It can make an online snapshot and archive the WAL. Restoring to a timestamp is supported too. An optional AES-256-GCM adapter encrypts the stored fact payload.

The caller supplies the encryption key. Rotation and backup handling remain outside this package.

## Benchmarks

I included the weak results because they matter as much as the good ones.

- the cheap-Sybil harness passed 24 of 24 trials for Intelligent DB in the committed configuration
- the PoisonedRAG NQ run measured 6% attack success; mem0 measured 96% in the same repository harness
- the 601-question FactWorld run measured 0.0% attack success with 99.8% clean accuracy
- the first LoCoMo setup missed its target; the later blended setup reached recall@20 of 0.481 against the cited mem0 result of 0.484

These are my tests of this repository. They are not independent production validation. The harnesses and concise reports remain in `src/__bench__/`, with the architecture notes under `docs/`.

Start with [`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md) and [`docs/INTEGRITY_AUDIT.md`](./docs/INTEGRITY_AUDIT.md).

## Check it

```bash
npm run typecheck
npm test
npm run build
```

Benchmarks and torture tests have separate flags. Some also need native tools or local models, so they are outside the normal build.

There is no lint or formatting command yet.

## Repository map

```text
src/            library, tests and benchmark harnesses
docs/           current architecture and design notes
figures/        benchmark figures and their generator
scripts/        demos and benchmark helpers
OPERATIONS.md   daemon and MCP runbook
CLAUDE.md       long technical record and known limits
```

Raw benchmark output belongs in `.arbor/` and is ignored. I kept the harness and the shorter evidence that explains the claims.

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before changing behaviour. Security reports go through [`SECURITY.md`](./SECURITY.md).

Apache 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
