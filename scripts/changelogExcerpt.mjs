#!/usr/bin/env node
// Extracts the CHANGELOG.md section for a given release version and prints it
// to stdout. Used by .github/workflows/release.yml to populate a GitHub
// release body from the hand-maintained changelog (see
// docs/project-management/RELEASE_PROCESS.md's changelog policy).
//
// Zero runtime dependencies: node:fs + node:path only.
//
// Usage: node scripts/changelogExcerpt.mjs <version>
//   <version> may be given with or without a leading "v" (e.g. "0.1.0" or
//   "v0.1.0") — the release workflow passes the bare package.json version.
//
// Matching rule: a section starts at a top-level ("## ") heading line whose
// text contains the version, optionally bracketed and/or "v"-prefixed
// (e.g. "## [0.1.0] - 2026-08-01", "## v0.1.0", "## 0.1.0 — Title") and ends
// immediately before the next "## " heading (or end of file). This is
// intentionally narrow rather than clever: a version string that doesn't
// appear verbatim in a heading is treated as "no section found" and the
// script exits non-zero (fail closed) rather than emitting an empty or
// wrong release body — a human should fix the changelog or the tag, not
// publish a blank release note.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main() {
  const rawVersion = process.argv[2];
  if (!rawVersion) {
    console.error('usage: node scripts/changelogExcerpt.mjs <version>');
    process.exit(1);
  }
  const version = rawVersion.replace(/^v/, '');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const changelogPath = join(__dirname, '..', 'CHANGELOG.md');
  const text = readFileSync(changelogPath, 'utf8');
  const lines = text.split('\n');

  const versionPattern = new RegExp(
    `^##\\s+\\[?v?${escapeRegExp(version)}\\]?(\\s|$)`,
  );

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (versionPattern.test(lines[i])) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) {
    console.error(
      `no CHANGELOG.md section found for version "${version}" ` +
        `(looked for a "## " heading containing it). Add one before tagging.`,
    );
    process.exit(1);
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const section = lines
    .slice(startIdx, endIdx)
    .join('\n')
    .trim();

  process.stdout.write(section + '\n');
}

main();
