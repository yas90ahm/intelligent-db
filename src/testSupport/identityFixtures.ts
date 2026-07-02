/**
 * testSupport/identityFixtures.ts — shared TEST/BENCH source fixtures.
 *
 * The crypto-free replacement for the old per-test passport mint: a test source
 * is now a plain {@link SourceRef} carrying a unique, per-call source id (a
 * SHA-256 checksum over a random label — an id derivation, not identity
 * machinery). Mirrors the old fixture's one guarantee exactly: every call
 * yields a DISTINCT source, so echo-collapse / distinct-approver / independence
 * assertions exercise real distinct ids.
 *
 * NOT exported from the public barrel — test/bench substrate only.
 *
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`.
 */

import { randomUUID } from "node:crypto";

import type { SourceRef } from "../identity/sources.js";
import { sourceIdFor } from "../identity/sources.js";

let seq = 0;

/**
 * Mint a fresh, unique test {@link SourceRef}. Same contract the old keypair
 * fixture gave tests (a new distinct source per call), minus the key material:
 * `sourceId` is unique per call; `label` is human-readable for assertions.
 */
export function freshSource(label?: string): SourceRef {
  const name = label ?? `gen-${++seq}`;
  return {
    sourceId: sourceIdFor("test-fixture", `${name}:${randomUUID()}`),
    kind: "OTHER",
    label: name,
  };
}
