/**
 * identity/keys.ts — PASSPORT KEYS (Pillar 1 of the Source-Identity Layer).
 *
 * Design grounding (CLAUDE.md, "Source-Identity Layer" -> "1. Passport"):
 *
 *   "Passport — cryptographic key per source. Proves *sameness*: same key = same
 *    source, unforgeably. Lets the web collapse echoes (two facts from one key are
 *    never corroboration). Cheap to mint, so necessary but NOT sufficient for
 *    independence."
 *
 * This module implements the *whole* of that one job — and nothing more:
 *
 *   - Mint an Ed25519 keypair (`generatePassport`).
 *   - Sign / verify byte messages with that key (`sign` / `verify`).
 *   - Derive a deterministic {@link SourceId} from a public key
 *     (`sourceIdFromPublicKey`) so that the SAME key always maps to the SAME
 *     source id. This determinism is what lets the web collapse echoes: two
 *     strands signed by one key resolve to one `source_id` and therefore count as
 *     ONE witness, never as corroboration.
 *
 * What this module deliberately does NOT do (per the design's "priced, not
 * prevented" thesis): it does not establish *independence*. A bare key is the
 * `AnchorClass.BARE_KEY` row of the anchor-cost table — `independence_weight =
 * 0.00`, `rep_cap = 0.05`, "Echo-collapse only; carries no independence." Binding
 * a key to scarce real-world anchors, scoring reputation, and posting stake are
 * the jobs of the OTHER three pillars (identity/anchors, identity/reputation,
 * identity/stake). A passport is *necessary but not sufficient* for being treated
 * as a distinct, independent witness.
 *
 * Crypto choice (per scaffold notes):
 *   - `node:crypto` `generateKeyPairSync('ed25519')`. Ed25519 is a pure signature
 *     scheme: `sign`/`verify` take `algorithm = null` (no separate digest).
 *   - Keys are carried as PEM (SPKI for public, PKCS#8 for private) so a passport
 *     is a plain, serializable, transport-friendly string.
 *   - The {@link SourceId} is `sha256` over the canonical DER (SPKI) bytes of the
 *     public key, encoded base64url. Hashing the DER (not the PEM text) makes the
 *     id robust to cosmetic PEM whitespace/line-wrap differences: the same key
 *     always yields the same id.
 *
 * No external dependencies — Node standard library only.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  createPublicKey,
} from "node:crypto";

import type { SourceId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A passport: the PUBLIC half of a source's cryptographic identity, plus the
 * deterministic {@link SourceId} derived from it. This is what travels with a
 * source across the system; it proves *sameness* (same key => same `sourceId`)
 * without revealing the signing secret.
 *
 * Holding a passport lets the web VERIFY signatures attributed to this source and
 * COLLAPSE echoes (everything under one `sourceId` is a single witness). It does
 * NOT let the holder forge that source's signatures — that requires the private
 * key in {@link KeyPair}.
 */
export interface Passport {
  /** Deterministic id of this source; `sha256(DER(publicKey))` base64url. */
  readonly sourceId: SourceId;
  /** SPKI PEM ("-----BEGIN PUBLIC KEY-----") encoding of the Ed25519 public key. */
  readonly publicKeyPem: string;
}

/**
 * A full keypair: a {@link Passport} plus the PRIVATE key that mints signatures
 * for it. The private PEM is the secret a source must guard; possession of it IS
 * the source's authority to assert. Never share or persist it alongside untrusted
 * data, and never put it in an {@link IdentityStamp} — only the public
 * `sourceId` crosses into the web.
 */
export interface KeyPair extends Passport {
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") encoding of the Ed25519 private key. */
  readonly privateKeyPem: string;
}

// ---------------------------------------------------------------------------
// SourceId derivation (the determinism that powers echo-collapse)
// ---------------------------------------------------------------------------

/**
 * Derive the canonical, deterministic {@link SourceId} for a public key.
 *
 * The id is `sha256` over the key's canonical DER (SPKI) bytes, encoded
 * base64url. Two facts arriving under the same public key therefore resolve to
 * the same `sourceId`, which is exactly what lets the web treat them as ONE
 * witness (echo-collapse) rather than two corroborating sources.
 *
 * Hashing the DER rather than the raw PEM text normalizes away cosmetic PEM
 * differences (header casing, line-wrap width, trailing newlines): any valid PEM
 * encoding of the same key yields the same id.
 *
 * @param publicKeyPem SPKI PEM of an Ed25519 public key.
 * @returns The deterministic {@link SourceId} (base64url, no padding).
 * @throws If `publicKeyPem` is not a parseable public key.
 */
export function sourceIdFromPublicKey(publicKeyPem: string): SourceId {
  // Re-parse and re-export to canonical DER so cosmetic PEM differences (and the
  // SPKI-vs-other encodings) collapse to one stable byte string before hashing.
  const der = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  const digest = createHash("sha256").update(der).digest("base64url");
  return digest as SourceId;
}

// ---------------------------------------------------------------------------
// Key minting
// ---------------------------------------------------------------------------

/**
 * Mint a fresh Ed25519 passport (keypair).
 *
 * This is "cheap to mint" by design (CLAUDE.md): minting a bare key costs ~nothing
 * and proves only sameness, not independence. The freshly minted key corresponds
 * to the `AnchorClass.BARE_KEY` row of the anchor-cost table until it is bound to
 * scarce anchors elsewhere in the identity layer.
 *
 * @returns A {@link KeyPair} with public/private PEMs and the derived
 *   {@link SourceId}.
 */
export function generatePassport(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  return {
    sourceId: sourceIdFromPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign a message with an Ed25519 private key.
 *
 * Ed25519 is a *pure* signature scheme, so the digest algorithm is `null`: the
 * raw message bytes are signed directly (no pre-hash step the caller must mirror).
 *
 * Signing is how a source AUTHORS an assertion; a verifiable signature is the
 * mechanical proof that a strand really came from the key behind a given
 * {@link SourceId}. (It proves *who signed*, not *whether the claim is true* —
 * truth is the web's job; identity is this layer's.)
 *
 * @param privateKeyPem PKCS#8 PEM of an Ed25519 private key.
 * @param message Raw message bytes to sign.
 * @returns The detached Ed25519 signature bytes (64 bytes).
 * @throws If `privateKeyPem` is not a usable Ed25519 private key.
 */
export function sign(privateKeyPem: string, message: Uint8Array): Uint8Array {
  // `algorithm = null` => Ed25519 signs the message directly (no separate digest).
  const sig = cryptoSign(null, message, privateKeyPem);
  return new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
}

/**
 * Verify an Ed25519 signature against a message and public key.
 *
 * Returns a boolean (never throws on a merely-bad signature): a `false` result is
 * a legitimate, expected outcome the caller must handle — an unverifiable
 * assertion carries no identity and therefore, per the invariant "no provenance
 * => no voice", must not be admitted as a witness.
 *
 * @param publicKeyPem SPKI PEM of the Ed25519 public key.
 * @param message The raw message bytes that were signed.
 * @param signature The detached signature bytes to check.
 * @returns `true` iff `signature` is a valid Ed25519 signature of `message` by
 *   the key in `publicKeyPem`; `false` otherwise.
 * @throws If `publicKeyPem` is not a parseable Ed25519 public key (a malformed
 *   KEY is a programming error, distinct from a merely-invalid signature).
 */
export function verify(
  publicKeyPem: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  // `algorithm = null` => Ed25519 verifies against the message directly.
  return cryptoVerify(null, message, publicKeyPem, signature);
}
