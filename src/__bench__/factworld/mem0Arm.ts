/**
 * factworld/mem0Arm.ts — the mem0 arm for entity-attribute QA.
 *
 * Reuses the persistent mem0 sidecar (its own Ollama embedder + Qdrant). Ingests every
 * assertion statement (including the Sybil cluster — mem0 has no provenance defense), then
 * answers a query by mem0's own text search. Returns the top-K statements as memory context.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mem0Sidecar } from "../reasoning/mem0Arm.js";
import type { Mem0Options } from "../reasoning/mem0Arm.js";
import { ollamaHost } from "../retrieval/qa/ollama.js";
import type { FwArm } from "./arms.js";
import type { Assertion, FWQuestion } from "./generate.js";
import { labelOf } from "./generate.js";

export interface FwMem0Options {
  readonly pythonBin: string;
  readonly embed: string;
  readonly embedDims: number;
  readonly llm: string;
  readonly k: number;
}

/** Build the mem0 arm: spawn the sidecar, ingest all statements, search by query text. */
export async function createFwMem0Arm(assertions: readonly Assertion[], opts: FwMem0Options): Promise<FwArm> {
  const sidecarOpts: Mem0Options = {
    pythonBin: opts.pythonBin,
    llm: opts.llm,
    embed: opts.embed,
    embedDims: opts.embedDims,
    qdrantPath: join(tmpdir(), `idb-fw-mem0-${process.pid}`),
    ollamaHost: ollamaHost(),
  };
  const sc = new Mem0Sidecar(sidecarOpts);
  await sc.ready();
  await sc.build(assertions.map((a, i) => ({ idx: i, text: a.statement })));

  return {
    id: "mem0",
    async contextFor(q: FWQuestion): Promise<string[]> {
      const query = `What is ${q.entity}'s ${labelOf(q.attribute)}?`;
      const hits = await sc.search(query, opts.k);
      return hits
        .map((h) => assertions[h.idx]?.statement)
        .filter((s): s is string => typeof s === "string");
    },
    async close(): Promise<void> {
      await sc.close();
    },
  };
}
