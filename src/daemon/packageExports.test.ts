/**
 * daemon/packageExports.test.ts — regression coverage for
 * `daemon-client-unexported-and-unexportable` (PRODUCTION_READINESS_ASSESSMENT.md,
 * CONFIRMED high): `createRemoteAgentMemory` (`daemon/client.ts`) is heavily
 * documented as the real daemon client (OPERATIONS.md, PHASE3_DAEMON_SPEC.md)
 * and imported internally, but `package.json`'s `exports` map defined only
 * `"."` — once published, `import("intelligent-db/daemon/client")` would
 * throw `ERR_PACKAGE_PATH_NOT_EXPORTED`, silently breaking a documented,
 * spec-approved feature the moment `private: true` is lifted.
 *
 * Reproduces the EXACT failure (Node's real package-exports resolver against
 * a synthetic `node_modules/intelligent-db` sandbox — the same technique the
 * audit itself used) against the pre-fix shape, then proves THIS repo's
 * CURRENT `package.json` (read live, not hand-copied) resolves the subpath.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Build a MINIMAL synthetic package under `<sandbox>/node_modules/intelligent-db`
 * with the given `exports` map, plus stub `dist/index.js` and
 * `dist/daemon/client.js` targets (content is irrelevant — only RESOLUTION is
 * under test here).
 */
function buildSandbox(tag: string, exportsMap: unknown): string {
  const sandbox = mkdtempSync(join(tmpdir(), `iddb-exports-${tag}-`));
  cleanups.push(sandbox);
  const pkgDir = join(sandbox, "node_modules", "intelligent-db");
  mkdirSync(join(pkgDir, "dist", "daemon"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "intelligent-db", version: "0.0.0", type: "module", exports: exportsMap }, null, 2),
    "utf8",
  );
  writeFileSync(join(pkgDir, "dist", "index.js"), "export const stub = true;\n", "utf8");
  writeFileSync(
    join(pkgDir, "dist", "daemon", "client.js"),
    "export const createRemoteAgentMemory = () => ({ stub: true });\n",
    "utf8",
  );
  return sandbox;
}

/**
 * Attempt `import("intelligent-db/daemon/client")` FROM INSIDE the sandbox, in
 * a SEPARATE, plain `node` child process (never vitest's own Vite-backed
 * module loader, which restricts dynamic `import()` of arbitrary filesystem
 * paths to its own project root and would not exercise real Node package-
 * exports resolution at all) — a probe script placed at the sandbox root, so
 * Node's node_modules resolution walk finds
 * `<sandbox>/node_modules/intelligent-db`. Real dynamic `import()`, real Node
 * module resolution, no mocking.
 */
async function tryImportSubpath(sandbox: string): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
  const probePath = join(sandbox, "probe.mjs");
  writeFileSync(
    probePath,
    "import('intelligent-db/daemon/client').then(() => process.exit(0), (err) => { " +
      "process.stderr.write(JSON.stringify({ code: err.code ?? null }) + '\\n'); process.exit(1); });\n",
    "utf8",
  );
  try {
    await execFileAsync(process.execPath, [probePath], { cwd: sandbox });
    return { ok: true };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const line = stderr.trim().split("\n").pop() ?? "";
    try {
      const parsed = JSON.parse(line) as { code: string | null };
      return { ok: false, code: parsed.code ?? undefined };
    } catch {
      return { ok: false, code: undefined };
    }
  }
}

describe("package.json exports map: daemon-client-unexported-and-unexportable", () => {
  it("REPRODUCES ERR_PACKAGE_PATH_NOT_EXPORTED for the pre-fix exports map (root cause confirmation)", async () => {
    // The exact shape package.json had before this fix — "." only.
    const preFixExports = {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    };
    const sandbox = buildSandbox("before", preFixExports);
    const result = await tryImportSubpath(sandbox);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("the REAL, current package.json's exports map resolves 'intelligent-db/daemon/client'", async () => {
    // Read the ACTUAL production config this repo ships — not a hand-copied
    // duplicate — so a future regression to package.json fails THIS test.
    const pkgPath = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports!["./daemon/client"]).toBeDefined();
    const subpath = pkg.exports!["./daemon/client"] as { types?: string; default?: string };
    expect(subpath.types).toBe("./dist/daemon/client.d.ts");
    expect(subpath.default).toBe("./dist/daemon/client.js");

    const sandbox = buildSandbox("after", pkg.exports);
    const result = await tryImportSubpath(sandbox);
    expect(result.ok).toBe(true);
  });
});
