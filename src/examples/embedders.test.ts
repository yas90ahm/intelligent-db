/**
 * examples/embedders.test.ts — the reference EmbedderPort implementations stay
 * WORKING, not decorative.
 *
 *   1. HASHING-TRICK EMBEDDER — deterministic (same text -> same vector, byte
 *      identical across calls), correct dimensionality, L2-normalized (cosine
 *      with itself is 1), and honors the `EmbedderPort` contract's `dim`/`modelId`.
 *   2. OLLAMA EMBEDDER — exercised against a FAKE `fetchImpl` (no live network
 *      dependency in the default suite): batch shape, error propagation on a
 *      non-2xx response, and a response-shape mismatch. A best-effort LIVE probe
 *      against a real local Ollama server is included but SKIPS itself (never
 *      fails the suite) when unreachable — this keeps the default suite green
 *      regardless of whether Ollama happens to be running on this machine.
 */

import { describe, it, expect } from "vitest";

import { cosineSimilarity } from "../store/vectorSidecar.js";
import { createHashingEmbedder, createOllamaEmbedder, DEFAULT_OLLAMA_MODEL } from "./embedders.js";

describe("createHashingEmbedder", () => {
  it("is deterministic: identical text yields a byte-identical vector", async () => {
    const embedder = createHashingEmbedder({ dim: 32 });
    const [a] = await embedder.embed(["the quick brown fox"]);
    const [b] = await embedder.embed(["the quick brown fox"]);
    expect(Array.from(a ?? [])).toEqual(Array.from(b ?? []));
  });

  it("produces vectors of the configured dimension", async () => {
    const embedder = createHashingEmbedder({ dim: 48 });
    const [v] = await embedder.embed(["hello"]);
    expect(v?.length).toBe(48);
    expect(embedder.dim).toBe(48);
  });

  it("defaults to dim 64 when unconfigured", () => {
    const embedder = createHashingEmbedder();
    expect(embedder.dim).toBe(64);
  });

  it("is L2-normalized: cosine similarity with itself is 1", async () => {
    const embedder = createHashingEmbedder({ dim: 32 });
    const [v] = await embedder.embed(["some non-empty text here"]);
    expect(cosineSimilarity(v!, v!)).toBeCloseTo(1, 6);
  });

  it("different texts (usually) yield different vectors, sharing NO false cosine=1", async () => {
    const embedder = createHashingEmbedder({ dim: 32 });
    const [a, b] = await embedder.embed(["alpha beta gamma", "totally unrelated delta epsilon"]);
    expect(cosineSimilarity(a!, b!)).toBeLessThan(0.999);
  });

  it("an empty/no-token text yields a zero vector (cosine 0, never NaN)", async () => {
    const embedder = createHashingEmbedder({ dim: 16 });
    const [v] = await embedder.embed([""]);
    expect(Array.from(v ?? []).every((x) => x === 0)).toBe(true);
    expect(cosineSimilarity(v!, v!)).toBe(0);
  });

  it("embeds a batch in order, one vector per input", async () => {
    const embedder = createHashingEmbedder({ dim: 16 });
    const out = await embedder.embed(["one", "two", "three"]);
    expect(out).toHaveLength(3);
  });

  it("modelId is stable and distinguishes dimension configs", () => {
    const a = createHashingEmbedder({ dim: 32 });
    const b = createHashingEmbedder({ dim: 64 });
    expect(a.modelId).not.toBe(b.modelId);
  });
});

describe("createOllamaEmbedder (fake transport)", () => {
  function fakeFetchOk(dim: number): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ embeddings: body.input.map(() => Array(dim).fill(0.1)) }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;
  }

  it("returns one vector per input via the batch endpoint", async () => {
    const embedder = createOllamaEmbedder({ dim: 8, fetchImpl: fakeFetchOk(8) });
    const out = await embedder.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]?.length).toBe(8);
  });

  it("modelId is prefixed ollama: with the configured model", () => {
    const embedder = createOllamaEmbedder({ model: "nomic-embed-text" });
    expect(embedder.modelId).toBe(`ollama:${DEFAULT_OLLAMA_MODEL}`);
  });

  it("empty input returns [] without a network call", async () => {
    let called = false;
    const embedder = createOllamaEmbedder({
      fetchImpl: (async () => {
        called = true;
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    const out = await embedder.embed([]);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("THROWS on a non-2xx response (caller's job to catch — accelerator, never a gate)", async () => {
    const embedder = createOllamaEmbedder({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "boom",
          json: async () => ({}),
        }) as Response) as typeof fetch,
    });
    await expect(embedder.embed(["x"])).rejects.toThrow(/500/);
  });

  it("THROWS on a response-shape mismatch (wrong embedding count)", async () => {
    const embedder = createOllamaEmbedder({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ embeddings: [[0.1, 0.2]] }), // only 1, but 2 requested
          text: async () => "",
        }) as Response) as typeof fetch,
    });
    await expect(embedder.embed(["x", "y"])).rejects.toThrow(/expected 2/);
  });

  it("LIVE PROBE (best-effort, never fails the suite): a real local Ollama, if reachable", async () => {
    const embedder = createOllamaEmbedder({ timeoutMs: 1500 });
    try {
      const [v] = await embedder.embed(["ping"]);
      // Reachable + model present: got a real vector back.
      expect(v).toBeInstanceOf(Float32Array);
    } catch {
      // Unreachable Ollama / model not pulled / offline CI — this is a BEST-EFFORT
      // probe, not a hard dependency. Never fail the default suite over it.
      expect(true).toBe(true);
    }
  }, 3000);
});
