# Intelligent DB

**A memory substrate for AI agents, not a vector database: a deliberate inversion of one.**

[![CI](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml/badge.svg)](https://github.com/yas90ahm/intelligent-db/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)

AI agents fail two ways: they **forget** (context evaporates within and across sessions),
and they **hallucinate**. Worse, they can't tell their own recall from their own
invention. The standard fix, a vector database, quietly makes the second failure *easier*:
cosine similarity ranks by density, so whoever floods the most near-duplicate claims wins
the retrieval. There is no concept of "this came from a trustworthy, independent source"
versus "this is a plausible-sounding plant."

Intelligent DB is a zero-runtime-dependency TypeScript memory substrate built against both
failures at once. Facts are latent **strands** in a spider-web graph, surfaced only by
**spreading activation** from a cue, never a flat nearest-neighbor scan. Recall is
**provenance-first**: every fact carries its citation, and two facts from the same root are
an echo, never corroboration. And the graph is protected by an **immune system** external
to it: **priced identity** (independence costs something real: a domain, a device, a
verified human), **earned reputation** (trust accrues slowly and craters fast on
contradiction), and a **tamper-evident, checksum-chained audit ledger**. An adversarial
council proved no rule living *inside* a memory graph can both let one true witness overturn
a planted lie and stop two fake witnesses from overturning the truth (see
[`CLAUDE.md`](./CLAUDE.md) §"The hard theorem"). Contradiction **demotes, never
deletes**; genuinely independent disputes defer to a human instead of being settled by
headcount.

---

## Why not a vector database?

A vector store has no notion of *who* asserted a fact or whether two assertions are
*independent*: it only has distance. That is exactly the property a poisoning attack
exploits: inject enough near-duplicate fabrications and they out-rank the truth. Intelligent
DB inverts the model: identity is priced and independence is measured before a fact is
ever allowed to out-rank another. The result, **re-verified 2026-07-06 against the current
(crypto-free) engine**, full report: [`BENCH_RERUN_2026-07-06.md`](./BENCH_RERUN_2026-07-06.md):

- **Cheap-Sybil poisoning, cross-store comparison** (`src/__bench__/crossdb/`): every
  trust-blind store benchmarked (8 in total, including **Qdrant**, **Postgres+pgvector**,
  and **Redis-Stack** alongside five embedded/on-disk backends) scored **0/24** against a
  24-trial cheap-Sybil attack (an attacker who mints throwaway identities for free). The
  IntelligentDB engine, the 9th arm in the same run, scored **24/24**.
- **mem0 comparison** (PoisonedRAG-nq, n=100, real BEIR corpus + the paper's own attack
  files): mem0, a genuine external memory framework with its own embedder and vector store,
  suffers **96% attack-success rate**; the substrate scores **6%**.
- **FactWorld** (601 poisoned closed-book questions, exact-match scoring, no LLM judge):
  flat RAG scores **98.7% attack-success**; the substrate scores **0.0% attack-success at
  99.8% accuracy**.

This does **not** claim Sybil resistance is impossible to beat; it converts an unbounded,
free attack into a *priced, visible, self-limiting* one. An attacker who buys genuinely
independent, expensive anchors (real domains, real devices, real reputations) **can** still
win; the degradation curve as an attacker pays more is measured and published, not hidden
(`docs/ARCHITECTURE_BENCHMARKS.md` §2.5, "costly-independent boundary"). The known,
deliberate limitations of the current single-process prototype (cross-process
concurrency, encryption-at-rest, the asserted-attribution trade-off) are enumerated in
**Known Limitations** in [`CLAUDE.md`](./CLAUDE.md), not swept under the rug.

Full methodology, the arms, the fidelity notes, and every reproduction command:
[`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md).

---

## Quickstart

The package is not yet published to npm (`private: true` in `package.json`); install from
source:

```sh
git clone https://github.com/yas90ahm/intelligent-db.git
cd intelligent-db
npm install
npm run build
```

```js
import { createAgentMemory } from "./dist/index.js";

// Zero configuration: the owner is the trust root. Pass { dbPath } for a durable
// SQLite/WAL store instead of the in-memory default.
const memory = createAgentMemory();

// Remember: files a provenance-rooted strand, not a row in a table.
const { id: ownerFactId } = memory.remember({
  text: "the deploy target is prod-cluster-7",
  entity: "entity:deploy",
  attribute: "deploy#target",
});

// Recall: spreading activation from the cue, never a fuzzy nearest-neighbor scan.
// Every fact carries a citation and a belief-state label — no provenance, no voice.
const { facts } = memory.recall("what is the deploy target?");
for (const f of facts) {
  console.log(`[${f.fact_state}] "${f.text}" — ${f.citation}`);
}

// A rival, low-trust source contradicts it (e.g. a fetched web page). It lands
// PROVISIONAL — visible, weightless, unable to displace the believed fact.
memory.remember({
  text: "the deploy target is evil-cluster-666",
  entity: "entity:deploy",
  attribute: "deploy#target",
  origin: { kind: "web", resourceId: "https://untrusted.example/post" },
});

// A genuinely independent, trusted source disputes it instead: two LIVE, independent
// claims. The engine refuses to pick a winner by majority or arrival order — it
// defers to a human. The dispute horn surfaces as plain data:
const disputes = memory.pendingQuestions();
if (disputes.length > 0) {
  const [question] = disputes;
  // ... show question.options to the user, then record their answer:
  memory.resolvePending(question.contradictionSetId, ownerFactId);
}

memory.close();
```

Or run the narrated, four-act demo end-to-end against a real in-memory instance (a 50-fake-source
flood, a real dispute, and the receipts from the audit ledger):

```sh
npm run demo
```

See [`src/examples/demo.ts`](./src/examples/demo.ts) for the full annotated walkthrough.

---

## MCP server (Claude Code / Claude Desktop)

Intelligent DB ships a zero-dependency stdio MCP server (`src/mcp/server.ts`) exposing five
tools: `remember`, `recall`, `list_pending_questions`, `resolve_pending` (the personal-tier
dispute horn — when two independent sources genuinely disagree, the agent asks the user and
records their answer), and `why_do_you_believe_this` (a belief dossier: sources, anchors,
independence count, demotion cause, dispute status, audit receipts).

Build first, then register it:

```sh
npm run build

# Claude Code CLI:
claude mcp add intelligent-db -- node /abs/path/to/dist/mcp/server.js
# set a durable store with:  -e MEMORY_DB=/abs/path/to/memory.db
```

Or a `mcpServers` JSON block (Claude Desktop and compatible clients):

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

Or via the package bin: `npx intelligent-db-mcp` (after `npm link` / a local install). Omit
`MEMORY_DB` for an in-memory (non-durable) store — useful for a quick trial.

---

## Architecture overview

One engine, layered so every load-bearing decision (when to stop walking, what's
canonical, who is independent) is a gate or an external signal, never a model judgment:

| Layer | What it does | Docs |
|---|---|---|
| **Storage** (`src/store/`) | Pluggable `StrandStore`: in-memory + durable SQLite/WAL, no delete operation (forgetting is downward tier movement). | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §4 |
| **Traversal** (`src/traversal/`, `src/recall/`) | Cue → seeds → share-normalized best-first spreading activation → two-phase halting (local saturation + mandatory bridge sweep). | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §5 |
| **Forgetting** (`src/forgetting/`) | Tier decay (`HOT→WARM→COLD→ARCHIVE_STUB`, never delete) + fail-closed eviction gates; echo collapse and decisive-or-defer contradiction adjudication. | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §6 |
| **Source-Identity Layer** (`src/identity/`) | Crypto-free trust registry, anchor-cost table + independence math, Beta(α,β) reputation, exact max-independent-set count. | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §7 |
| **Ratification** (`src/ratification/`) | Tamper-evident checksum-chain audit ledger, the dispute doorbell, the retroactive disown/undo sweep, enterprise dispute routing. | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §9 |
| **Engine verbs** (`src/api.ts`) | `writeFact` / `recall` / `ratify` / `adjudicate` / `disown` / `explain` / `beliefTimeline` — the composed `IntelligentDb` surface. | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §10 |
| **Agent facade + MCP** (`src/agent/`, `src/mcp/`) | `remember` / `recall` / `pendingQuestions` / `resolvePending` for a zero-config personal deployment, plus the stdio MCP server. | [`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md) §11 |

The full module-by-module reference, including the hard theorem that makes the
Source-Identity Layer mandatory, lives in
[`docs/ARCHITECTURE_ENGINE.md`](./docs/ARCHITECTURE_ENGINE.md); the canonical
design-and-status document (test counts, known limitations) is [`CLAUDE.md`](./CLAUDE.md).

---

## Benchmarks

| Benchmark | bare | RAG | mem0 | IntelligentDB |
|---|---|---|---|---|
| Cheap-Sybil poisoning, 9-store comparison (24 trials/store) | — | 0/24 on all 8 trust-blind stores (incl. Qdrant, Postgres+pgvector, Redis-Stack) | not measured (config gap, see below) | **24/24** |
| FactWorld (n=1200, 601 poisoned) — attack-success / accuracy | 0.0% / 0.0% | 98.7% / 50.3% | 78.9% / 60.2% | **0.0% / 99.8%** |
| PoisonedRAG-nq (n=100, real attack files) — attack-success / accuracy | 4.0% / 50.0% | 93.0% / 22.0% | 96.0% / 22.0% | **6.0% / 86.0%** |
| PoisonedRAG-hotpotqa (n=100) — attack-success / accuracy | 21.0% / 54.0% | 99.0% / 13.0% | 97.0% / 14.0% | **18.0% / 81–82%** |
| PoisonedRAG-msmarco (n=100) — attack-success / accuracy | 12.0% / 63.0% | 93–94% / 15–16% | 93.0% / 21.0% | **6–7% / 84–85%** |

Every row above, including the full mem0 column, is **re-verified 2026-07-06** against the
current crypto-free engine — no historical or pre-rebuild figures remain in this table.
mem0 tracks RAG's vulnerability almost exactly on the three PoisonedRAG datasets (its
embedder+vector-store retrieval carries no provenance/independence model); on FactWorld it
lands meaningfully between RAG's near-total collapse and IntelligentDB's clean defense,
some internal dedup in mem0 partially resisting a near-duplicate Sybil cluster it doesn't
resist on the PoisonedRAG attack shape. IntelligentDB is the only arm defended on every
dataset. The crossdb mem0 adapter is not yet wired (`Memory.from_config` needs either an
OpenAI key or explicit Ollama LLM config the harness doesn't pass) — a configuration gap,
not a result. Full methodology, the label-free (non-oracle) structural defense, the
disclosed costly-independent degradation boundary, and every reproduction command:
[`docs/ARCHITECTURE_BENCHMARKS.md`](./docs/ARCHITECTURE_BENCHMARKS.md). The complete
re-run log for this pass: [`BENCH_RERUN_2026-07-06.md`](./BENCH_RERUN_2026-07-06.md).

---

## Development

Requires Node `>=22.13` (the first release line with `node:sqlite` unflagged, which the
durable store uses; developed and tested on Node 24).

```sh
npm install        # dev deps only — the library itself has zero runtime dependencies
npm run typecheck  # tsc --noEmit (strict, NodeNext, verbatimModuleSyntax, exactOptionalPropertyTypes)
npm run build      # tsc -p tsconfig.build.json -> dist/
npm test           # vitest run — the full suite (benchmark suites are env-gated and skipped)
```

CI (`.github/workflows/ci.yml`) runs typecheck + test + build on Node 22.x and 24.x for
every push and pull request to `main`.

## Contributing, security, and license

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, required checks, code philosophy.
- [`SECURITY.md`](./SECURITY.md) — supported versions, private vulnerability reporting, threat model.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — community standards.
- Licensed under [Apache-2.0](./LICENSE); see [`NOTICE`](./NOTICE) for attribution requirements.
- Full documentation index: [`docs/README.md`](./docs/README.md).
