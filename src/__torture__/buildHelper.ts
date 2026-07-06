/**
 * __torture__/buildHelper.ts — shared "make sure the compiled torture bundle
 * exists" helper for the vitest-visible torture tests (`killLoop.test.ts`,
 * `tornWrite.test.ts`). Not a `.test.ts` file itself — plain support code.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const TORTURE_BUILD_DIR = join(process.cwd(), "node_modules", ".torture-build");
export const WORKER_PATH = join(TORTURE_BUILD_DIR, "__torture__", "killWorker.js");

/** Build the torture bundle (`npm run torture:build`) unless it already exists. */
export function ensureTortureBuilt(): void {
  if (existsSync(WORKER_PATH)) return;
  execFileSync("npm", ["run", "torture:build"], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
