/**
 * retrieval/qa/ollama.ts — a tiny local-LLM client for the cycle-F end-task QA harness.
 *
 * POSTs a single non-streaming completion to a local Ollama server
 * (`http://localhost:11434/api/generate`) and returns the raw `response` string.
 * Deterministic by construction: temperature 0, a bounded `num_predict`. The model name
 * defaults to the QA_MODEL env var; the host to OLLAMA_HOST (so the same harness can point
 * at a remote box). Uses Node's global `fetch` (Node 20+/24) — zero new dependencies.
 *
 * ADDITIVE: lives entirely under retrieval/qa/; no engine source is touched.
 */

/** Default Ollama base URL; overridable with OLLAMA_HOST. */
export function ollamaHost(): string {
  return process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
}

/** The model name the harness drives, from QA_MODEL (no silent default — fail loud). */
export function qaModel(): string {
  const m = process.env["QA_MODEL"];
  if (m === undefined || m.trim() === "") {
    throw new Error("QA_MODEL is not set (e.g. QA_MODEL=qwen2.5:7b)");
  }
  return m.trim();
}

export interface OllamaGenOptions {
  /** Sampling temperature (default 0 — deterministic). */
  readonly temperature?: number;
  /** Max tokens to generate (default 64 — short-answer reader). */
  readonly num_predict?: number;
  /** Override the model (default: QA_MODEL env). */
  readonly model?: string;
  /** Request timeout in ms (default 120_000). */
  readonly timeoutMs?: number;
  /** RNG seed (for reproducible multi-sample avg@k; omit for the server default). */
  readonly seed?: number;
}

interface OllamaGenerateResponse {
  readonly response?: unknown;
  /** Reasoning models (qwen3, etc.) put chain-of-thought here; `response` is post-think. */
  readonly thinking?: unknown;
}

/**
 * Generate a single completion for `prompt`. Returns the `response` string (trimmed).
 * Throws on a non-200 status, a network error, or a malformed body — a QA reader that
 * silently returns "" would poison the metrics, so failures are LOUD.
 */
export async function ollamaGenerate(prompt: string, opts: OllamaGenOptions = {}): Promise<string> {
  const model = opts.model ?? qaModel();
  const temperature = opts.temperature ?? 0;
  const num_predict = opts.num_predict ?? 64;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const genOptions: Record<string, number> = { temperature, num_predict };
  if (opts.seed !== undefined) genOptions["seed"] = opts.seed;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollamaHost()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: genOptions,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as OllamaGenerateResponse;
    const response = typeof json.response === "string" ? json.response : "";
    const thinking = typeof json.thinking === "string" ? json.thinking : "";
    // Prefer the post-think answer; if it was truncated to empty (thinking ran past
    // num_predict), fall back to the reasoning text so the answer extractor still has
    // something to parse instead of scoring a guaranteed miss.
    const out = response.trim().length > 0 ? response : thinking;
    if (out.trim().length === 0) {
      throw new Error("ollama returned neither a `response` nor `thinking` string");
    }
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness probe: true iff the Ollama server answers `/api/tags` with a 200. */
export async function ollamaReachable(timeoutMs = 5_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
