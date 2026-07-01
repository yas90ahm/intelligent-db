/**
 * reasoning/codeExec.ts — HumanEval pass@1 grader.
 *
 * Extracts the python from a model reply, assembles a self-contained program
 * (generous import preamble + candidate + the benchmark's hidden test + a `check(entry)`
 * call), and runs it in a `python` subprocess with a hard timeout. Pass == exit 0.
 *
 * NOTE: this EXECUTES model-generated code locally. It is bounded by a wall-clock timeout
 * and run from a temp file, but is NOT sandboxed against filesystem/network — acceptable
 * for a local benchmark on the operator's own machine, not for untrusted input.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Generous preamble so a candidate that omits a common import still grades fairly. */
const PREAMBLE = [
  "from typing import *",
  "import math, re, collections, itertools, functools, heapq, bisect, string",
  "from collections import *",
  "from itertools import *",
  "from functools import *",
  "",
].join("\n");

/** Pull the python out of a reply: first ```python (or bare ```) fenced block, else whole reply. */
export function extractPython(reply: string): string {
  const fenced = reply.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  return reply.trim();
}

export interface CodeResult {
  readonly passed: boolean;
  /** "ok" | "fail" | "timeout" | "error:<msg>" */
  readonly status: string;
}

/**
 * Grade one HumanEval candidate. `test` is the benchmark's check-function source and
 * `entryPoint` the function name the test calls.
 */
export function runHumanEval(
  reply: string,
  test: string,
  entryPoint: string,
  timeoutMs = 10_000,
  pythonBin = process.env["PYTHON_BIN"] ?? "python",
): CodeResult {
  const candidate = extractPython(reply);
  const program = `${PREAMBLE}\n${candidate}\n\n${test}\n\ncheck(${entryPoint})\nprint("__PASS__")\n`;

  const dir = mkdtempSync(join(tmpdir(), "idb-he-"));
  const file = join(dir, "prog.py");
  try {
    writeFileSync(file, program, "utf8");
    const res = spawnSync(pythonBin, [file], {
      timeout: timeoutMs,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { passed: false, status: "timeout" };
    }
    if (res.error) return { passed: false, status: `error:${res.error.message.slice(0, 80)}` };
    if (res.status === 0 && (res.stdout ?? "").includes("__PASS__")) {
      return { passed: true, status: "ok" };
    }
    return { passed: false, status: "fail" };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
