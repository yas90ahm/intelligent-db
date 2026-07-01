/**
 * poisonedrag/mem0Arm.ts — the mem0 arm over the PoisonedRAG KB (its own embedder + Qdrant).
 * Ingests every passage (incl. poison; no provenance defense) and answers by text search.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { Mem0Sidecar } from "../reasoning/mem0Arm.js";
import type { Mem0Options } from "../reasoning/mem0Arm.js";
import { ollamaHost } from "../retrieval/qa/ollama.js";
import type { PrArm } from "./arms.js";
import type { KBPassage, PRQuestion } from "./data.js";

export interface PrMem0Options {
  readonly pythonBin: string;
  readonly embed: string;
  readonly embedDims: number;
  readonly llm: string;
  readonly k: number;
}

export async function createPrMem0Arm(passages: readonly KBPassage[], opts: PrMem0Options): Promise<PrArm> {
  const sidecarOpts: Mem0Options = {
    pythonBin: opts.pythonBin, llm: opts.llm, embed: opts.embed, embedDims: opts.embedDims,
    qdrantPath: join(tmpdir(), `idb-pr-mem0-${process.pid}`), ollamaHost: ollamaHost(),
  };
  const sc = new Mem0Sidecar(sidecarOpts);
  await sc.ready();
  await sc.build(passages.map((p, i) => ({ idx: i, text: p.text })));

  return {
    id: "mem0",
    async contextFor(q: PRQuestion): Promise<string[]> {
      const hits = await sc.search(q.question, opts.k);
      return hits.map((h) => passages[h.idx]?.text).filter((s): s is string => typeof s === "string");
    },
    async close(): Promise<void> {
      await sc.close();
    },
  };
}
