/**
 * __tests__/phase2CryptoFreeSweep.test.ts — PHASE-2 CLOSE-OUT REGRESSION SWEEP.
 *
 * The Phase-2 rebuild removed every piece of OWNED cryptographic machinery (keypairs,
 * signing, attestations, Merkle trees, staking) and replaced the identity layer's
 * crypto anchors with the crypto-free trust registry. The close-out review then found
 * three regressions-in-waiting, each of which this file pins permanently:
 *
 *   1. STAKING MUST STAY RETIRED (review finding: the public barrel still exported a
 *      working stake ledger). "Attribution replaces stake" is only true if no consumer
 *      can import the machinery: the barrel must expose NO staking factory/helpers.
 *      (`StakeLedgerPort`/`ZERO_STAKE_PORT` deliberately survive — they exist only so
 *      the stamp's `stake_posted: 0` SHAPE stays stable, and the port is constant-zero.)
 *
 *   2. SOURCE MUST NOT RE-GROW CRYPTO VOCABULARY (review finding: stale "passport
 *      key" / signature-gate comments survived in shipped source). Rule of record:
 *      comments must not advertise cryptographic identity machinery; the retained
 *      hash chain is a "tamper-evident checksum chain". This sweep greps every .ts
 *      under src/ for the deleted machinery's names — a re-introduction (code OR
 *      comment) fails loudly with the file and the token.
 *
 *   3. THE TWO CANONICAL DOCS MUST NOT RESURRECT DELETED MODULES (review finding:
 *      CLAUDE.md/README.md still documented identity/keys.ts, binding.ts,
 *      anchorRegistry.ts and the Merkle log as present). Docs drift silently; this
 *      makes the check executable.
 *
 * Pure sweep infrastructure — node:fs walks only; no engine behavior is exercised
 * here (behavioral coverage lives in cryptoFreeTrust.test.ts and the suite at large).
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as barrel from "../index.js";

// This file names the banned tokens as literals, so it excludes ITSELF from the walk.
const SELF = basename(fileURLToPath(import.meta.url)).replace(/\.js$/, ".ts");
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_DIR, "..");

/** Recursively collect every .ts file under `dir` (skipping this sweep itself). */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (name.endsWith(".ts") && name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe("phase-2 crypto-free close-out sweep", () => {
  it("the public barrel exports no staking machinery (retired: attribution replaces stake)", () => {
    const surface = barrel as Record<string, unknown>;
    // The retired pillar's whole value surface, plus the deleted crypto factories —
    // none may ever reappear on the public barrel.
    const banned = [
      "createStakeLedger",
      "stakeMultiplier",
      "financialStakeWeight",
      "STAKE_ANCHOR_CLASS",
      "FINANCIAL_STAKE_WEIGHT_MIN",
      "FINANCIAL_STAKE_WEIGHT_MAX",
      "generatePassport",
      "signAttestation",
      "createMerkleLog",
      "createAnchorRegistry",
    ];
    for (const name of banned) {
      expect(surface[name], `public barrel must not export ${name}`).toBeUndefined();
    }
    // Positive controls: the crypto-free replacements ARE the public surface, and the
    // surviving stake port is shape-only (constant zero, no producer behind it).
    expect(typeof barrel.createTrustRegistry).toBe("function");
    expect(typeof barrel.sourceIdFor).toBe("function");
    expect(barrel.ZERO_STAKE_PORT.postedFor("src:any" as never)).toBe(0);
  });

  it("shipped source names none of the deleted crypto machinery (rule 4)", () => {
    // Case-sensitive where the deleted identifier was CamelCase so that honest
    // HISTORICAL prose ("removed keypairs/signing") stays legal while a re-introduced
    // identifier (or a comment advertising one) fails.
    const banned: readonly RegExp[] = [
      /\bKeyPair\b/,
      /\bed25519\b/i,
      /generatePassport/,
      /signAttestation/,
      /verifyAttestation/,
      /createMerkleLog/,
      /sourceIdFromPublicKey/,
      /createAnchorRegistry/,
      /createStakeLedger/,
      /passport key/i,
      /identity\/keys/,
      /identity\/binding/,
      /identity\/anchorRegistry/,
      /identity\/stake/,
      /merkleLog/,
    ];
    const offenses: string[] = [];
    for (const file of tsFilesUnder(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      for (const re of banned) {
        if (re.test(text)) offenses.push(`${file} matches ${String(re)}`);
      }
    }
    expect(offenses, offenses.join("\n")).toEqual([]);
  });

  it("CLAUDE.md and README.md do not reference the deleted crypto modules", () => {
    const banned: readonly RegExp[] = [
      /identity\/keys\.ts/,
      /identity\/binding\.ts/,
      /identity\/anchorRegistry\.ts/,
      /merkleLog/,
      /dnsDomainProver/,
      /\bed25519\b/i,
      /RFC-6962/,
      /Signed Tree Head/,
    ];
    const offenses: string[] = [];
    for (const doc of ["CLAUDE.md", "README.md"]) {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      for (const re of banned) {
        if (re.test(text)) offenses.push(`${doc} matches ${String(re)}`);
      }
    }
    expect(offenses, offenses.join("\n")).toEqual([]);
  });
});
