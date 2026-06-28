# Intelligent DB

**Intelligent DB** is a memory substrate for AI agents, built to counter the two ways
agents fail: they **forget** (stateless models lose context within and across sessions)
and they **hallucinate** (they invent facts and can't tell their own recall from
invention). It is **not** a vector database — it is a deliberate inversion of one. Memory
is modeled as a **memory palace / spider-web**: facts are latent by default and surface
only via **spreading activation** along structural threads. Nothing sits in a readable
list; a cue energizes a seed strand, activation propagates across connected strands until
a cluster of relevant facts "lights up," and only lit strands are assembled into an
answer. Provenance is first-class on every strand, contradiction **demotes** rather than
deletes, and — because the web can judge *what* a fact is but never *who* is really behind
it — source identity is witnessed from **outside** by a cryptographic Source-Identity
Layer ("passport control at the border of the memory").

For the full design — the resolved traversal-halting mechanics, the forgetting floor, the
hard theorem that makes the external identity layer mandatory, the anchor-cost table, and
the open tuning knobs — see [**CLAUDE.md**](./CLAUDE.md). This README does not duplicate
it.

## Status

**Production-grade single-process prototype.** All four roadmap pillars are implemented,
adversarially tested, and wired end-to-end; the `// TODO(crack-A/B)` stub era is over. The
activation walk, two-phase halting, eviction gates, contradiction adjudication, the
retroactive disown sweep, the exact maximum-independent-set independence count
(Bron–Kerbosch/Tomita), the Beta(α,β)-LCB reputation ledger, and the RFC-6962 Merkle audit
layer all ship complete. Persistence is SQLite/WAL with atomic, crash-consistent compound
writes. The library is **zero runtime dependency** (`dependencies: {}` — only `node:`
builtins; the heavy packages in `devDependencies` serve the benchmark harness only).

`npm test` runs **~259 tests** (Vitest); `npm run typecheck` is clean under a strict config
(NodeNext, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
The remaining gaps are deliberately out-of-scope operational/social items — cross-process
concurrency, real external anchor/witness services, encryption-at-rest, and the unbuilt
HARDWARE/KYC/STAKE binders — enumerated honestly in the **GAP LIST** in
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
| `src/identity/keys.ts` | Passport pillar: ed25519 keypairs, sign/verify, deterministic `SourceId`. | Implemented |
| `src/identity/anchors.ts` | Anchor-cost table + independence (set-disjointness) + sublinear self-stack cap + rep_cap. | Implemented |
| `src/identity/reputation.ts` | Credit-score pillar: Beta(α,β), decay-on-read, LCB readout, exact credit reversal. | Implemented |
| `src/identity/index.ts` | Source-Identity Layer facade; exact MIS independence count (Bron–Kerbosch/Tomita). | Implemented |
| `src/ratification/` | Merkle/STH audit log, hash-chained pending ledger, disown taint-closure, corroboration ledger. | Implemented |
| `src/api.ts` | The engine verbs: `writeFact` / `writeFactsBatch` / `recall` / `ratify` / `adjudicate` / `disown` / `approve`. | Implemented |
| `src/index.ts` | Public barrel re-exporting the API above. | Implemented |

## Install / build / test

Requires Node `>=20` (developed and tested on Node 24).

```sh
npm install        # install dev deps (typescript, vitest, @types/node, + bench-only DB clients)
npm run typecheck  # tsc --noEmit (strict, NodeNext, ESM)
npm run build      # tsc -p .  -> dist/
npm test           # vitest run  (~259 tests; benchmark suites are env-gated and skipped)
```

The suite spans adversarial security tests (Sybil-fleet collapse, contradiction-bomb
defusal, audit byte-flip detection, Merkle rollback/fork rejection, demote-never-delete,
mid-op crash rollback) and one end-to-end integration test (`systemCoherence.test.ts`) that
wires the whole pipeline over a shared SQLite handle. The competitive benchmark suites
(cross-DB, deployment, retrieval, QA) live under `src/__bench__/` and are gated behind env
flags (`CROSSDB_BENCH`, `DEPLOY_BENCH`, `RETRIEVAL_BENCH`, `QA_BENCH`) so `npm test` stays
fast; see `.arbor/sessions/` for their result artifacts and `PAPER.md` for the synthesis.
