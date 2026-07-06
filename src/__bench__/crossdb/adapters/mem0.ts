/**
 * adapters/mem0.ts — the Mem0 (mem0ai, Python) adapter, a GENUINE external memory
 * substrate driven over a persistent sidecar process (its OWN embedder + vector store,
 * not ours wearing a mem0 hat).
 *
 * UNBLOCKED: the prior wall (`Memory.from_config` eagerly constructs an LLM client at
 * init and defaults to OpenAI ⇒ `OpenAIError: Missing credentials`, no `OPENAI_API_KEY`
 * supplied) is resolved by routing BOTH the LLM and the embedder through LOCAL Ollama —
 * `reasoning/mem0_sidecar.py` already does exactly this (`llm.provider`/`embedder.provider`
 * = `"ollama"`, embedded/local Qdrant vector store) and is reused HERE UNMODIFIED via the
 * shared `Mem0Sidecar` driver (`reasoning/mem0Arm.ts`) — no new Python, no new protocol.
 * `add(..., infer=False)` (already baked into the sidecar) skips LLM fact-extraction, so
 * the LLM config only avoids the eager `OpenAIError` at construction time; ingest is
 * embedder-bound (Ollama `nomic-embed-text`), not LLM-bound.
 *
 * DUMB / trust-blind store: NO entity filter — mem0's own `search()` is a plain text/
 * semantic query, not a per-field filter API a real caller would reach for, so this
 * mirrors the `vector-bruteforce` / `faiss-node` / `hnswlib-node` global-top-K convention
 * rather than the Docker vector-DBs' payload-filtered one. The cue text
 * (`"<entity> <attribute>"`) is distinctive enough per trial that mem0's own ranking
 * naturally surfaces only that (entity, attribute)'s own asserted facts; identical
 * cheap-Sybil copies rank identically to each other, so the fleet's FALSE value fills the
 * top-K and wins once A > H — the same expected, honest trust-blind result every other
 * adapter in this table produces. mem0 has no provenance/independence model.
 *
 * LIFECYCLE: `setup()` spawns the persistent sidecar once (embedded Qdrant at a fresh temp
 * path + Ollama LLM/embedder); `writeFact` ingests one fact at a time through the sidecar's
 * existing `build([...])` protocol (the runner calls `writeFact` per fact — no protocol
 * change needed, a length-1 batch); `recall` searches by the cue text and majority-votes
 * the value among the returned hits (copies count as evidence — trust-blind by design);
 * `close()` tears down the sidecar process and its embedded-Qdrant temp directory.
 *
 * FOOTPRINT: on-disk byte size of the sidecar's embedded-Qdrant storage directory (the
 * same on-disk-file convention as sqlite/lmdb/duckdb/IntelligentDB/hnswlib-node).
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Fact, Cue, RankedFact, MemoryAdapter } from "../adapter.js";
import { Mem0Sidecar } from "../../reasoning/mem0Arm.js";
import type { Mem0Options } from "../../reasoning/mem0Arm.js";
import { cleanupPath } from "../util.js";

/** Top-K hits retrieved per recall (large vs H so copy-count, not tie order, decides). */
const TOP_K = 128;

// mem0 arm (external substrate) config — its OWN local pipeline (Ollama + embedded Qdrant),
// same env-overridable defaults as reasoning/runner.test.ts's mem0 wiring.
const MEM0_PYTHON =
  process.env["MEM0_PYTHON"] ?? "D:\\Intelligent DB\\.arbor\\venv-mem0\\Scripts\\python.exe";
const MEM0_LLM = process.env["MEM0_LLM"] ?? "qwen2.5:7b";
const MEM0_EMBED = process.env["MEM0_EMBED"] ?? "nomic-embed-text";
const MEM0_EMBED_DIMS = Number(process.env["MEM0_EMBED_DIMS"] ?? "768");
const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "http://localhost:11434";

/** Recursive on-disk byte size of a directory (embedded Qdrant writes many small files). */
function dirBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const p = stack.pop()!;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(p);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(join(p, e));
    } else {
      total += st.size;
    }
  }
  return total;
}

export function createMem0Adapter(): MemoryAdapter {
  let sc: Mem0Sidecar | null = null;
  let qdrantPath = "";
  const values: string[] = [];

  return {
    name: "Mem0 (mem0ai, Python)",

    async setup(): Promise<void> {
      // mem0's telemetry path defaults to a FIXED global directory
      // (`~/.mem0/migrations_qdrant`) shared by every mem0 process on the machine — an
      // embedded-Qdrant client only allows one process to open a given storage folder at
      // a time, so a concurrent mem0 sidecar elsewhere (e.g. another bench lane) throws
      // "already accessed by another instance of Qdrant client" at construction. Disabling
      // telemetry (mem0's own documented env knob) skips that shared path entirely — this
      // adapter's OWN per-process `qdrantPath` below was never the colliding resource.
      if (process.env["MEM0_TELEMETRY"] === undefined) process.env["MEM0_TELEMETRY"] = "False";
      qdrantPath = join(tmpdir(), `idb-crossdb-mem0-${process.pid}`);
      const opts: Mem0Options = {
        pythonBin: MEM0_PYTHON,
        llm: MEM0_LLM,
        embed: MEM0_EMBED,
        embedDims: MEM0_EMBED_DIMS,
        qdrantPath,
        ollamaHost: OLLAMA_HOST,
      };
      const sidecar = new Mem0Sidecar(opts);
      await sidecar.ready();
      sc = sidecar;
      values.length = 0;
    },

    async writeFact(f: Fact): Promise<void> {
      if (sc === null) return;
      const idx = values.length;
      values.push(f.value);
      await sc.build([{ idx, text: `${f.entity} ${f.attribute} ${f.value}` }]);
    },

    async recall(cue: Cue): Promise<RankedFact[]> {
      if (sc === null) return [];
      const hits = await sc.search(`${cue.entity} ${cue.attribute}`, TOP_K);
      // Trust-blind majority vote among the retrieved hits (copies count as evidence).
      const tally = new Map<string, number>();
      for (const h of hits) {
        const v = values[h.idx];
        if (v !== undefined) tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      const out: RankedFact[] = [];
      for (const [value, count] of tally) out.push({ value, score: count });
      out.sort((a, b) => b.score - a.score);
      return out;
    },

    footprintBytes(): number {
      return dirBytes(qdrantPath);
    },

    async close(): Promise<void> {
      if (sc !== null) {
        await sc.close();
        sc = null;
      }
      cleanupPath(qdrantPath);
      values.length = 0;
    },
  };
}
