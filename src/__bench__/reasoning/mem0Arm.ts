/**
 * reasoning/mem0Arm.ts — the `mem0` arm: a GENUINE external memory substrate.
 *
 * Drives a persistent Python sidecar (mem0_sidecar.py) over a JSON-lines protocol. mem0 is
 * configured fully local (Ollama LLM + embedder, embedded Qdrant) and uses its OWN
 * embedder/store/ranking — so this is a fair "different memory system", not ours wearing a
 * mem0 hat. The bank's problems are added once; each unseen query is searched by text and
 * mem0's top-k studied problems (by its own similarity) become the recalled exemplars.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Arm, QueryCtx } from "./arms.js";
import type { BankEntry } from "./poison.js";

const SENTINEL = "@@MEM0@@ ";

interface Resp {
  readonly ok: boolean;
  readonly error?: string;
  readonly added?: number;
  readonly hits?: ReadonlyArray<{ idx: number; score: number }>;
  readonly event?: string;
}

export interface Mem0Options {
  /** Python interpreter (the mem0 venv). */
  readonly pythonBin: string;
  /** mem0's LLM model tag (Ollama). */
  readonly llm: string;
  /** mem0's embedding model tag (Ollama). */
  readonly embed: string;
  /** embedding dimensionality (must match the embed model: nomic-embed-text = 768). */
  readonly embedDims: number;
  /** embedded-Qdrant storage path (removed on close). */
  readonly qdrantPath: string;
  /** Ollama base URL. */
  readonly ollamaHost: string;
}

export class Mem0Sidecar {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #pending: Array<(o: Resp) => void> = [];
  readonly #ready: Promise<Resp>;
  #gotReady = false;
  #closed = false;

  constructor(opts: Mem0Options) {
    const sidecar = join(dirname(fileURLToPath(import.meta.url)), "mem0_sidecar.py");
    // mem0's telemetry path defaults to a FIXED global directory (`~/.mem0/migrations_qdrant`)
    // regardless of the configured `vector_store.path`, which collides with ANY other
    // concurrently-running mem0 process on the box (RuntimeError: storage folder already
    // accessed by another Qdrant client instance). Disabling telemetry (mem0's own documented
    // env knob) skips that shared path entirely — same fix already applied in
    // crossdb/adapters/mem0.ts and retrieval/locomoMem0Runner.test.ts.
    const mem0Telemetry = process.env["MEM0_TELEMETRY"] ?? "False";
    this.#proc = spawn(opts.pythonBin, [sidecar], {
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        MEM0_TELEMETRY: mem0Telemetry,
        MEM0_LLM: opts.llm,
        MEM0_EMBED: opts.embed,
        MEM0_EMBED_DIMS: String(opts.embedDims),
        MEM0_QDRANT_PATH: opts.qdrantPath,
        OLLAMA_HOST: opts.ollamaHost,
      },
      windowsHide: true,
    });

    let resolveReady!: (o: Resp) => void;
    this.#ready = new Promise<Resp>((res) => (resolveReady = res));

    const rl = createInterface({ input: this.#proc.stdout });
    rl.on("line", (line) => {
      if (!line.startsWith(SENTINEL)) return; // ignore any non-protocol stdout
      let obj: Resp;
      try {
        obj = JSON.parse(line.slice(SENTINEL.length)) as Resp;
      } catch {
        return;
      }
      if (!this.#gotReady) {
        this.#gotReady = true;
        resolveReady(obj);
        return;
      }
      const r = this.#pending.shift();
      if (r) r(obj);
    });

    this.#proc.stderr.on("data", () => {}); // drain (mem0/posthog chatter) — keep quiet
    this.#proc.on("error", (e) => {
      const o: Resp = { ok: false, error: `spawn failed: ${e.message}` };
      if (!this.#gotReady) {
        this.#gotReady = true;
        resolveReady(o);
      }
      while (this.#pending.length) this.#pending.shift()!(o);
    });
    this.#proc.on("exit", () => {
      const o: Resp = { ok: false, error: "sidecar exited" };
      if (!this.#gotReady) {
        this.#gotReady = true;
        resolveReady(o);
      }
      while (this.#pending.length) this.#pending.shift()!(o);
    });
  }

  async ready(): Promise<void> {
    const o = await this.#ready;
    if (!o.ok) throw new Error(`mem0 sidecar init failed: ${o.error ?? "unknown"}`);
  }

  #send(req: unknown): Promise<Resp> {
    return new Promise<Resp>((res) => {
      this.#pending.push(res);
      this.#proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async build(items: ReadonlyArray<{ idx: number; text: string }>): Promise<number> {
    const o = await this.#send({ cmd: "build", items });
    if (!o.ok) throw new Error(`mem0 build failed: ${o.error ?? "unknown"}`);
    return o.added ?? 0;
  }

  async search(query: string, k: number): Promise<ReadonlyArray<{ idx: number; score: number }>> {
    const o = await this.#send({ cmd: "search", query, k });
    if (!o.ok) throw new Error(`mem0 search failed: ${o.error ?? "unknown"}`);
    return o.hits ?? [];
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#send({ cmd: "close" });
    } catch {
      /* ignore */
    }
    try {
      this.#proc.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build the mem0 arm over the study BANK: spawn the sidecar, add every studied problem
 * (text = its problem statement, metadata.idx = bank index), and answer each unseen query
 * by mem0's own text search. Throws if the sidecar cannot initialise (the caller asked for
 * mem0 explicitly, so a missing venv / mem0 install is a LOUD failure, not a silent skip).
 */
export async function createMem0Arm(bank: readonly BankEntry[], opts: Mem0Options): Promise<Arm> {
  const sc = new Mem0Sidecar(opts);
  await sc.ready();
  await sc.build(bank.map((e, i) => ({ idx: i, text: e.item.retrieval_text })));

  return {
    id: "mem0",
    async exemplars(query: QueryCtx, k: number): Promise<number[]> {
      const hits = await sc.search(query.item.retrieval_text, k);
      return hits.map((h) => h.idx).filter((i) => i >= 0 && i < bank.length).slice(0, k);
    },
    async close(): Promise<void> {
      await sc.close();
      try {
        rmSync(opts.qdrantPath, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}
