import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude nested git worktrees (e.g. idb-rt/, a linked worktree that lives inside
    // this repo's own directory tree) so `npm test` only ever collects this repo's own
    // suite, never a stale duplicate copy from a sibling checkout.
    exclude: ['**/node_modules/**', '**/dist/**', 'idb-rt/**'],
  },
});
