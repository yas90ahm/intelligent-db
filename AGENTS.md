# AGENTS.md

Fast path for coding agents working in this repo. Product quickstart and architecture live in [`README.md`](./README.md); design status and known limitations in [`CLAUDE.md`](./CLAUDE.md); daemon/MCP ops in [`OPERATIONS.md`](./OPERATIONS.md).

## Node

Requires **Node `>=22.13`** (`engines` in `package.json`; pin files: `.nvmrc` / `.node-version`). Developed and tested on Node 24; CI covers 22.x and 24.x.

## Verify loop

Prefer the smallest check that covers your change:

```sh
npm run typecheck              # tsc --noEmit — must stay green
npx vitest run <path>          # scoped: one file or directory (fast feedback)
npm test                       # full suite (vitest run); gated benches stay skipped
npm run build                  # tsc -p tsconfig.build.json → dist/
```

There is no separate ESLint/Prettier stack — validation is **typecheck + tests**.

## Gated benches / native deps

Competitive benches under `src/__bench__/` and torture need env flags (`CROSSDB_BENCH`, `RETRIEVAL_BENCH`, `TORTURE=1`, etc.) and optional native `devDependencies`. They are **not** required for the in-process library, `npm run demo`, typecheck, or the default test suite. `npm install` allow-scripts / native-build warnings for those packages are safe to ignore unless you are running a gated bench.

## Recommended recall (PERSONAL)

Default recall is the activation walk (spider-web rule): only lit strands speak, ordered by activation. Pass an `embedder` into `createAgentMemory({ embedder })` to **seed** that walk (cosine proposes candidates; belief never reads similarity). Blend/RRF presentation (Phase 1c frozen config, recall@20 ≈ 0.481 vs mem0 0.484) is **opt-in** via `rankMode: "blend"` (requires an embedder for the cosine side). Reference embedders live in `src/examples/embedders.ts` (not a barrel default).

## Daemon-backed MCP (gotcha)

`MEMORY_DAEMON_TOKEN_FILE` must be a file containing the **raw bearer token only**. Do not point it at the auto-provisioned JSON `<data-dir>/daemon-token`. On Windows, set `MEMORY_DAEMON_SOCKET` from that JSON's `endpoint` field. Details: [`OPERATIONS.md`](./OPERATIONS.md) §7.
