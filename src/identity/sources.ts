/**
 * identity/sources.ts — PLAIN SOURCE IDENTITY (the crypto-free "sameness" pillar).
 *
 * Design grounding (CLAUDE.md "Source-Identity Layer", pillar 1, as rebuilt by the
 * crypto-free redesign — docs/launch/CRYPTO_FREE_IDENTITY_DESIGN.md §3/§4.1):
 * pillar 1's ONE job was ever only *sameness* — same source id ⇒ same source ⇒
 * never corroboration (echo-collapse). Sameness never priced independence (a bare
 * identity contributes `independence_weight = 0.00` by design), so it needs no
 * key machinery at all: the caller's auth layer (an IdP login, an owner session,
 * a fetched URL) already established WHO this is before this code runs. This
 * module just derives a stable, deterministic id from that established identity.
 *
 * What proves sameness now:
 *   - `sourceIdFor(issuer, subject)` — a SHA-256 CHECKSUM (base64url) over the
 *     (issuer, subject) pair. Same issuer+subject ⇒ same id, always. That is ALL
 *     "sameness" ever needed; the checksum is a deterministic id derivation, not
 *     identity machinery of its own.
 *   - `SourceRef` — the plain, serializable descriptor a source presents at the
 *     border (identity/index.ts's `register`). It carries the id, what KIND of
 *     source this is, and an optional human-readable label.
 *
 * What this module deliberately does NOT do: establish *independence*. Binding a
 * source to anchors (owner authority, SSO tenant, publisher eTLD+1, system of
 * record) is the trust registry's job (identity/trustRegistry.ts); scoring
 * reputation is identity/reputation.ts's. A SourceRef is *necessary but not
 * sufficient* for being treated as a distinct, independent witness.
 *
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`
 * (`import type`); `node:crypto` for the hash only — no other deps.
 */

import { createHash } from "node:crypto";

import type { SourceId } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * What KIND of source a {@link SourceRef} describes. Purely descriptive metadata
 * for audit trails and routing — trust NEVER derives from the kind string itself
 * (it derives from the anchors the trust registry's claim producers bind).
 */
export type SourceKind =
  | "OWNER"
  | "SSO"
  | "PUBLISHER"
  | "SYSTEM_OF_RECORD"
  | "AGENT"
  | "OTHER";

/**
 * A plain source descriptor — the crypto-free unit of "sameness" that travels
 * with a source across the system. Serializable JSON; carries no secrets and no
 * verification machinery. Everything filed under one `sourceId` is ONE witness
 * (echo-collapse); nothing about a SourceRef alone makes two sources independent.
 */
export interface SourceRef {
  /** Deterministic id of this source (see {@link sourceIdFor}). */
  readonly sourceId: SourceId;
  /** What kind of source this is (descriptive; never load-bearing for trust). */
  readonly kind: SourceKind;
  /** Optional human-readable label for citations / audit trails. */
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Deterministic source-id derivation (the determinism that powers echo-collapse)
// ---------------------------------------------------------------------------

/**
 * Field separator (SOH) between the issuer and subject in the id preimage — the
 * same discipline the audit ledger's checksum chain uses. Guarantees the pair is
 * unambiguous: ("a", "b|c") and ("a|b", "c") can never collide, because SOH
 * never appears inside a legitimate issuer/subject string the way printable
 * separators can.
 */
const SEP = "";

/**
 * Derive the canonical, deterministic {@link SourceId} for an (issuer, subject)
 * pair: a SHA-256 checksum over `issuer ␁ subject`, encoded base64url.
 *
 * Same issuer+subject ALWAYS yields the same id — that determinism is what lets
 * the web collapse echoes (two facts from one identity resolve to one
 * `source_id` and count as ONE witness, never as corroboration). The issuer
 * namespaces the subject so `("idp:acme", "alice")` and `("idp:globex",
 * "alice")` are distinct sources.
 *
 * The caller's auth layer already proved WHO the subject is (an OIDC `sub` a
 * middleware verified, an owner session, a canonicalized publisher domain);
 * this function only makes that established identity stable and collision-safe.
 * Pure and total.
 *
 * @param issuer  Namespace of the identity (IdP issuer URL, `"publisher"`, …).
 * @param subject The identity within that namespace (OIDC sub, eTLD+1, name, …).
 * @returns The deterministic {@link SourceId} (base64url, no padding).
 */
export function sourceIdFor(issuer: string, subject: string): SourceId {
  const digest = createHash("sha256")
    .update(issuer + SEP + subject, "utf8")
    .digest("base64url");
  return digest as SourceId;
}
