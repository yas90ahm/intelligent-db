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

**Scaffold.** Every module has complete, accurate types/interfaces, correct function
signatures, and working implementations of the simple parts (enums, the in-memory store,
the priority queue, the identity stamp shape, the anchor-cost table, decay pressure, echo
collapse, demotion, the staking ledger, ed25519 passports). The hard algorithmic cores —
the activation-walk body, the two-phase halting gates, the tier-eviction permission gates,
contradiction adjudication, and the retroactive disown sweep — are marked
`// TODO(crack-A)` / `// TODO(crack-B)` stubs that **throw or return typed placeholders**.
See [CLAUDE.md](./CLAUDE.md) for the design and the open knobs.

## Module map

| Path | Role | State |
|---|---|---|
| `src/core/types.ts` | The shared contract: strand/edge model, enums, branded ids, identity stamp, walk config. | Complete |
| `src/store/StrandStore.ts` | Pluggable storage contract (no deletion by design; forgetting is downward tier movement). | Complete (interface) |
| `src/store/memoryStore.ts` | Default in-memory adjacency-map backend + share-normalization bookkeeping. | Complete |
| `src/traversal/walk.ts` | `MaxPriorityQueue` (complete) + `activationWalk` body. | Walk body: crack-A |
| `src/traversal/halting.ts` | Two-phase stop controller; counters/budgets/stamp complete. | Phase gates: crack-B |
| `src/forgetting/tiers.ts` | Tier stepping + `decayPressure` (complete) + eviction permission gates. | Hard gates: crack-A/B |
| `src/forgetting/consolidation.ts` | Echo collapse, demotion (complete) + contradiction adjudication. | Adjudication: crack-B |
| `src/identity/keys.ts` | Passport pillar: ed25519 keypairs, sign/verify, deterministic `SourceId`. | Complete |
| `src/identity/anchors.ts` | Anchor-cost table + independence (set-disjointness) + rep_cap rules. | Complete (self-stack cap: crack-B) |
| `src/identity/reputation.ts` | Credit-score pillar: up-slow/down-fast rule (complete) + disown sweep. | Sweep: crack-A |
| `src/identity/stake.ts` | Security-deposit pillar: staking ledger + stake-scaled weight. | Complete |
| `src/identity/index.ts` | Source-Identity Layer facade composing the four pillars into a stamp. | Complete (Stage-2 disjointness: crack-A) |
| `src/api.ts` | The three-verb engine: `writeFact` / `recall` / `ratify`. | Wiring complete; drives the cracked cores |
| `src/index.ts` | Public barrel re-exporting the API above. | Complete |

## Install / build / test

Requires Node `>=20`.

```sh
npm install        # install dev deps (typescript, vitest, @types/node)
npm run typecheck  # tsc --noEmit (strict, NodeNext, ESM)
npm run build      # tsc -p .  -> dist/
npm test           # vitest run  (smoke test: src/__tests__/smoke.test.ts)
```

The smoke test (`src/__tests__/smoke.test.ts`) imports the public barrel, constructs the
in-memory store and the Source-Identity Layer, files a fact through the api, and recalls it
from the shared-entity index. Paths that depend on a crack stub (e.g. `recall()` driving
the activation walk) are asserted to **throw**, so the suite stays green against the
scaffold rather than pretending an unfinished core works.
