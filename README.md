# Intelligent DB

**Memory for AI agents that a crowd of liars can't poison.**

AI agents fail two ways: they **forget** (context evaporates across sessions) and they
**hallucinate** (they invent facts and can't tell recall from invention). Intelligent DB is
a zero-dependency TypeScript memory substrate built against both — and the poisoning-resistance
claim is **measured, not argued**.

Every security claim traces to a benchmark, a regression test, or a documented limitation —
including the project's own review history: [Review Findings](./docs/launch/REVIEW_FINDINGS.md)
records each adversarial-review finding, its fix, and the test that guards it.

## Measured results

| What was measured | Undefended | Intelligent DB | Source |
|---|---|---|---|
| **FactWorld memory poisoning** (601 attacked questions): attack success rate | flat RAG **98.7%** · mem0 **79.4%** | **0.0%** (99.8% accuracy) | [`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md) §9 |
| **Sybil fleet collapse**: a cheap fake-source fleet of 1→500 identities | RAG & sameness-only arms flip the fact at **3** fakes | fleet collapses to **one** witness — **0%** attack success at every fleet size | `ARCHITECTURE_BENCHMARKS.md` §10.3 |
| **Red-team trajectory** (97 attack specs, real engine) | — | **59 → 25 → 18** breaches across three hardening generations, **zero new breaches** after the crypto-free rebuild | [`docs/launch/REBUILD_SUMMARY.md`](./docs/launch/REBUILD_SUMMARY.md) §4 |

> **Footnote — what's fresh and what's historical:** the LLM-scored rows (FactWorld's
> RAG/mem0 comparison, the PoisonedRAG suite) are **HISTORICAL** — measured pre-rebuild and
> pending re-run, per [`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md)
> §9–§10. The locally-runnable poisoning arms **were re-measured at 0% attack success on the
> current tree** ([`REBUILD_SUMMARY.md`](./docs/launch/REBUILD_SUMMARY.md) §4).

The disclosed failure boundary, stated up front: an attacker who **buys genuinely
independent, expensive anchors can win** — Sybil resistance here is *priced, not prevented*,
and the degradation curve is published, not hidden
([`docs/marketing/COMPARISON.md`](./docs/marketing/COMPARISON.md) §2.4).

## Quickstart

```sh
git clone <this-repo> && cd intelligent-db
npm install
npm run build
```

```js
import { createAgentMemory } from "./dist/index.js";

const memory = createAgentMemory(); // in-memory; see below for durable

memory.remember({ text: "Yasir's favourite database is SQLite." });
const { facts } = memory.recall("what is Yasir's favourite database?");

console.log(facts[0].text);                          // "Yasir's favourite database is SQLite."
console.log(facts[0].citation, facts[0].fact_state); // who said it + LIVE/PROVISIONAL/DEMOTED
```

Durable memory is one option: `createAgentMemory({ dbPath: "memory.db" })` (SQLite/WAL,
crash-consistent) — or watch the attack fail: `npm run demo`.

### Attach to Claude via MCP

The MCP server is a zero-dependency stdio binary (`src/mcp/server.ts`). Build first
(`npm run build`), then:

```sh
claude mcp add intelligent-db -- node /abs/path/to/dist/mcp/server.js
# set a durable store with:  -e MEMORY_DB=/abs/path/to/memory.db
```

Or a client `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "intelligent-db": {
      "command": "node",
      "args": ["/abs/path/to/dist/mcp/server.js"],
      "env": { "MEMORY_DB": "/abs/path/to/memory.db" }
    }
  }
}
```

Or via the package bin: `npx intelligent-db-mcp` (after `npm link` / install). The server
exposes **four tools**: `remember`, `recall` (its parameter is `query`),
`list_pending_questions`, and `resolve_pending` — the last two are the dispute horn: when
two independent sources genuinely disagree, the agent asks the user instead of guessing.

## How it works, in 5 lines

1. Facts are **latent strands** in a spider-web graph — nothing sits in a readable list.
2. A cue energizes a seed; **spreading activation** propagates until relevant facts "light up" — only lit strands are spoken.
3. **Provenance is first-class**: two facts from the same root are an echo, never corroboration; independence is *priced* against external anchors.
4. Contradiction **demotes, never deletes** — and genuinely independent disputes defer to a human instead of being resolved by headcount.
5. The model files and speaks memories but **never confirms them** — no provenance, no voice.

## Why this exists

Agents forget, and they hallucinate — and the worse failure is that they can't tell the
difference. The obvious fix, a vector database, makes poisoning *easier*: similarity search
ranks by density, so whoever injects the most near-duplicates wins. Worse, an adversarial
review of this project proved a **hard theorem** (see [CLAUDE.md](./CLAUDE.md)): no rule
*inside* a memory graph can both let one true witness overturn a planted lie and stop two
fake witnesses from overturning the truth.

So identity has to be witnessed from **outside** the graph. The first build did that with
self-minted cryptography — a signing key per source, a Merkle audit tree, staking —
machinery this project built, operated, and trusted itself.

Then the twist: real deployments **already have a trust root**. One person's agent trusts
its owner; a company's fleet trusts its SSO; the web has registered domains. The rebuild
deleted every line of home-built crypto, consumed identity from configuration instead — and
the red-team breach count went **down**, 25 to 18, with zero new breaches.

The deletion was the upgrade.


## Project docs

- [**CLAUDE.md**](./CLAUDE.md) — the canonical design + status document (full mechanics, known limitations).
- [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) — the current engine architecture, module by module.
- [**CONTRIBUTING.md**](./CONTRIBUTING.md) — dev setup, required checks, code philosophy.
- [**SECURITY.md**](./SECURITY.md) — supported versions, private vulnerability reporting, threat model.
- [`docs/launch/`](./docs/launch/) — the rebuild summary, review findings, code-review reports.
- [`docs/marketing/`](./docs/marketing/) — positioning and comparison-vs-alternatives docs.
- [`docs/product/`](./docs/product/) — roadmap and use cases.
- [`docs/project-management/`](./docs/project-management/) — governance and release process.
- [`docs/history/`](./docs/history/) — the pre-rebuild (crypto-era) design docs, preserved with banners.

## Status

**Production-grade single-process prototype.** All four roadmap pillars are implemented,
adversarially tested, and wired end-to-end; the `// TODO(crack-A/B)` stub era is over. The
activation walk, two-phase halting, eviction gates, contradiction adjudication, the
retroactive disown sweep, the exact maximum-independent-set independence count
(Bron–Kerbosch/Tomita), the Beta(α,β)-LCB reputation ledger, and the tamper-evident
checksum-chain audit ledger (with exported `chainHead` checkpoints and real-time
`AppendSink` shipping) all ship complete.
Ingest is **trust-tiered**: a fact filed by a low-trust source (anonymous, unverified
publisher) lands as a visible `PROVISIONAL` superposition — stored and recallable but
unable to displace a believed fact — and is promoted to `LIVE` only when an
anchor-independent source ratifies it (or a human approves the dispute).
The **dispute horn is surfaced per tier**: when two independent sources genuinely
disagree, the personal tier turns the deferred dispute into a question to the owner
(`pendingQuestions()` / `resolvePending()` on the agent facade, plus the MCP tools
`list_pending_questions` / `resolve_pending`), with the owner's answer receipted as an
auditable `ownerOverride` approval; the enterprise tier gets a pure, deterministic
dispute-routing adapter (`createDisputeRouter`) that maps open disputes to owning
groups (e.g. IdP groups) from config — no transport, just replayable decisions.
The codebase builds and owns **zero cryptographic machinery** — no keypairs, no signing,
no attestations, no staking; plain SHA-256 is used only as a checksum (content hashes,
hash-chained audit records, deterministic ids). Persistence is SQLite/WAL with atomic,
crash-consistent compound writes. The library is **zero runtime dependency** (`dependencies: {}` — only `node:`
builtins; the heavy packages in `devDependencies` serve the benchmark harness only).

`npm test` runs the full Vitest suite (see [CLAUDE.md](./CLAUDE.md) for the current count);
`npm run typecheck` is clean under a strict config
(NodeNext, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
The remaining gaps are deliberately out-of-scope operational/social items — cross-process
concurrency, encryption-at-rest, access-segregated checkpoint storage, and the
asserted-attribution trade-off (audit attribution is asserted, not signed; an exported
checkpoint is the insider-tamper detector) — enumerated in **Known Limitations** in
[CLAUDE.md](./CLAUDE.md), which is the canonical status document.

## Module map

| Path | Role | State |
|---|---|---|
| `src/core/types.ts` | The shared contract: strand/edge model, enums, branded ids, identity stamp, walk config. | Implemented |
| `src/store/StrandStore.ts` | Pluggable storage contract (no deletion by design; forgetting is downward tier movement). | Implemented |
| `src/store/memoryStore.ts` · `sqliteStore.ts` | In-memory backend + durable SQLite/WAL backend (batch writes, nestable txns, integrity check). | Implemented |
| `src/traversal/walk.ts` | `MaxPriorityQueue` + share-normalized `activationWalk` body. | Implemented |
| `src/traversal/halting.ts` | Two-phase stop controller (local saturation + mandatory bridge sweep + hard backstop). | Implemented |
| `src/forgetting/tiers.ts` | Tier stepping + `decayPressure` + fail-closed eviction permission gates. | Implemented |
| `src/forgetting/consolidation.ts` | Echo collapse, demotion, decisive-or-defer contradiction adjudication. | Implemented |
| `src/identity/sources.ts` · `trustRegistry.ts` | Crypto-free identity: deterministic source ids (sameness) + the trust registry's claim producers (owner / SSO member / publisher / system-of-record). | Implemented |
| `src/identity/anchors.ts` | Anchor-cost table + independence (set-disjointness) + sublinear self-stack cap + rep_cap. | Implemented |
| `src/identity/reputation.ts` | Credit-score pillar: Beta(α,β), decay-on-read, LCB readout, exact credit reversal. | Implemented |
| `src/identity/index.ts` | Source-Identity Layer facade; exact MIS independence count (Bron–Kerbosch/Tomita). | Implemented |
| `src/ratification/` | Tamper-evident checksum-chain audit ledger (exported checkpoints), disown taint-closure, corroboration ledger, enterprise dispute-routing adapter. | Implemented |
| `src/agent/agentMemory.ts` · `src/mcp/` | Agent facade (`remember`/`recall`/`pendingQuestions`/`resolvePending`) + the zero-dep MCP server (tools: `remember`, `recall`, `list_pending_questions`, `resolve_pending`). | Implemented |
| `src/api.ts` | The engine verbs: `writeFact` / `writeFactsBatch` / `recall` / `ratify` / `adjudicate` / `disown` / `approve`; trust-tiered ingest (quarantine gate). | Implemented |
| `src/index.ts` | Public barrel re-exporting the API above. | Implemented |

## Install / build / test

Requires Node `>=22.13` — the first release line with `node:sqlite` unflagged, which the durable store uses (developed and tested on Node 24).

```sh
npm install        # install dev deps (typescript, vitest, @types/node, + bench-only DB clients)
npm run typecheck  # tsc --noEmit (strict, NodeNext, ESM)
npm run build      # tsc -p .  -> dist/
npm test           # vitest run  (the full Vitest suite — see CLAUDE.md for the current count; benchmark suites are env-gated and skipped)
```

The suite spans adversarial security tests (Sybil-fleet collapse, contradiction-bomb
defusal, audit byte-flip detection, checkpoint divergence after a full history rewrite,
demote-never-delete,
mid-op crash rollback) and one end-to-end integration test (`systemCoherence.test.ts`) that
wires the whole pipeline over a shared SQLite handle. The competitive benchmark suites
(cross-DB, deployment, retrieval, QA) live under `src/__bench__/` and are gated behind env
flags (`CROSSDB_BENCH`, `DEPLOY_BENCH`, `RETRIEVAL_BENCH`, `QA_BENCH`) so `npm test` stays
fast; see [`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md) for the
methodology + measured tables and [`docs/history/PAPER.md`](./docs/history/PAPER.md) for the
(pre-rebuild) synthesis.
