/**
 * identity/binding.ts — THE ANCHOR-BINDING PIPELINE (ARCHITECTURE.md §1).
 *
 * Today every source is BARE_KEY (independence 0) because nothing BINDS a source
 * to a real-world anchor, so the whole Sybil/trust apparatus is structurally real
 * but operationally INERT. This module makes binding real: a source proves control
 * of a scarce external root (a domain, an inbox) and an external VERIFIER signs a
 * short-lived, verifiable {@link AnchorAttestation} that the {@link
 * AnchorRegistry} ingests to grant real independence.
 *
 * Design grounding (ARCHITECTURE.md §1 "Anchor-binding pipeline"):
 *
 *   "A `AnchorBinder` interface yields signed, expiring `AnchorAttestation{
 *    sourceId, anchorType, anchorId (salted hash of the root — never raw PII),
 *    proofRef, weight, classId, notBefore, notAfter, verifierSig }` appended to
 *    the ledger. … The cost table alone prices a *single* anchor but not a
 *    *fleet*; therefore add aggregate-independence caps keyed on deterministic
 *    *operator* classIds — WHOIS registrar + hosting ASN for domains, issuer for
 *    KYC — so 10k cheap domains behind one registrar collapse toward one class
 *    rather than 10k. … Absent any binder a source stays BARE_KEY weight 0."
 *
 * Two governing invariants this module honors:
 *   1. The model is never its own witness — binding is keys/proofs/signatures,
 *      mechanical, never the model. An external proof (DNS TXT, signed email
 *      nonce) is required; the verifier signs only what a PROVER port confirmed.
 *   2. The web is never its own witness about source identity — the proof is
 *      checked OUTSIDE the web by an injected PROVER seam (mockable in tests,
 *      wireable to real DNS / email services in prod), and the attestation is
 *      Ed25519-signed by a verifier key, so it is verifiable + expiring.
 *
 * FAIL-CLOSED everywhere: a failed/expired/forged proof produces a {@link
 * Rejection}, never an attestation; an unbound source contributes 0 independence.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (type-only imports use `import type`); `node:crypto` only, no external deps.
 * Hashes/sigs are carried as base64url STRINGS so an attestation is plain,
 * serializable JSON with a stable canonical form.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  AnchorClass,
  type SourceId,
  type IndependenceClassId,
  type OperatorClassId,
  type EpochMs,
  type Unit,
} from "../core/types.js";
import { ANCHOR_TABLE } from "./anchors.js";
import { sign, verify, type KeyPair } from "./keys.js";

// ---------------------------------------------------------------------------
// The attestation model
// ---------------------------------------------------------------------------

/**
 * A signed, expiring record that a VERIFIER bound `sourceId` to a real-world
 * anchor. This is the unit the {@link AnchorRegistry} stores and validates; while
 * valid (verifierSig checks out AND `notBefore <= now < notAfter`) it grants the
 * source `weight` independence of class `anchorType`. Expired or forged ⇒ dropped
 * ⇒ the source reverts toward BARE_KEY.
 *
 * `anchorId` is a SALTED HASH of the real root (domain / address) — never raw PII
 * or a raw domain — so the attestation is not a dictionary-reversible directory of
 * who holds what. The salt is verifier-held config.
 */
export interface AnchorAttestation {
  /** The source this attestation binds. */
  readonly sourceId: SourceId;
  /** Which anchor class was proven (DOMAIN, EMAIL_OAUTH, …). */
  readonly anchorType: AnchorClass;
  /** `sha256(salt ‖ canonicalRoot)` base64url — salted, never the raw root. */
  readonly anchorId: string;
  /**
   * Deterministic OPERATOR class (registrar / ASN / provider) — the FLEET axis.
   * Two attestations sharing this are NOT independent even with different
   * `classId`s, so a flood behind one operator collapses toward one class.
   */
  readonly operatorClassId: OperatorClassId;
  /** Opaque reference to the proof artifact (TXT record name, email message id). */
  readonly proofRef: string;
  /** Realized independence weight this binding contributes (see anchor table). */
  readonly weight: Unit;
  /**
   * Deterministic INDEPENDENCE class (eTLD+1 for DOMAIN, normalized address for
   * EMAIL) — the per-anchor disjointness axis.
   */
  readonly classId: IndependenceClassId;
  /** Not valid before this instant (epoch ms). */
  readonly notBefore: EpochMs;
  /** Not valid at/after this instant (epoch ms) — expiry, inclusive boundary. */
  readonly notAfter: EpochMs;
  /** Ed25519 signature of the canonical preimage by the verifier key, base64url. */
  readonly verifierSig: string;
}

// ---------------------------------------------------------------------------
// Canonical preimage + verifier signing (mirrors pendingLedger discipline)
// ---------------------------------------------------------------------------

/** Field separator (SOH) — same discipline as the ratification ledger; never
 * appears inside any id/hash component. */
const SEP = "";

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

/**
 * The exact preimage of an attestation's signature: a canonical, hand-ordered
 * serialization over EVERY field except `verifierSig`. NEVER `JSON.stringify`
 * (key order is not contractually stable). Recomputed verbatim in {@link
 * verifyAttestation}, so any flipped/tampered field breaks the signature.
 */
function attestationPreimage(
  att: Omit<AnchorAttestation, "verifierSig">,
): string {
  return [
    "ANCHOR_ATTESTATION",
    String(att.sourceId),
    String(att.anchorType),
    att.anchorId,
    String(att.operatorClassId),
    att.proofRef,
    // Fixed-precision so the float text is byte-identical on re-serialization.
    att.weight.toFixed(6),
    String(att.classId),
    String(att.notBefore),
    String(att.notAfter),
  ].join(SEP);
}

/**
 * Sign an attestation body with a verifier's Ed25519 key, producing the full
 * {@link AnchorAttestation} with `verifierSig`. The signature is over
 * `sha256(preimage)` (utf8), carried base64url — mirroring the ratification
 * ledger's record-signing discipline.
 */
export function signAttestation(
  body: Omit<AnchorAttestation, "verifierSig">,
  verifier: KeyPair,
): AnchorAttestation {
  const digest = createHash("sha256")
    .update(utf8(attestationPreimage(body)))
    .digest();
  const sig = sign(verifier.privateKeyPem, new Uint8Array(digest));
  const verifierSig = Buffer.from(sig).toString("base64url");
  return { ...body, verifierSig };
}

/**
 * Verify an attestation: (1) the verifier signature checks out against the
 * recomputed preimage, AND (2) it is within its validity window
 * (`notBefore <= now < notAfter`). A forged/tampered attestation fails the sig; an
 * expired one fails the window. Pure, total, never throws on a merely-bad sig.
 *
 * EXPIRY is `now >= notAfter ⇒ expired` (the boundary instant is already expired),
 * so a source's anchor reverts toward BARE_KEY exactly at `notAfter`.
 */
export function verifyAttestation(
  att: AnchorAttestation,
  verifierPublicKeyPem: string,
  now: EpochMs,
): boolean {
  // Window first — cheap and independent of crypto.
  if ((now as number) < (att.notBefore as number)) return false;
  if ((now as number) >= (att.notAfter as number)) return false;

  const { verifierSig, ...body } = att;
  const digest = createHash("sha256")
    .update(utf8(attestationPreimage(body)))
    .digest();
  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(verifierSig, "base64url"));
  } catch {
    return false;
  }
  return verify(verifierPublicKeyPem, new Uint8Array(digest), sigBytes);
}

// ---------------------------------------------------------------------------
// Binder seam: Challenge / Rejection / AnchorBinder
// ---------------------------------------------------------------------------

/**
 * A binding challenge: the nonce a source must publish (DNS TXT) or echo (signed
 * email) to prove control of the root. Time-boxed so a stale challenge cannot be
 * replayed indefinitely.
 */
export interface Challenge {
  readonly sourceId: SourceId;
  readonly anchorType: AnchorClass;
  /** Random, single-use nonce the prover must surface at the root. */
  readonly nonce: string;
  readonly issuedAt: EpochMs;
  readonly expiresAt: EpochMs;
}

/** A rejected bind attempt — the fail-closed result. Carries a human-readable
 * reason; NEVER an attestation. */
export interface Rejection {
  readonly ok: false;
  readonly reason: string;
}

/** Narrow a bind result to a {@link Rejection}. */
export function isRejection(
  r: AnchorAttestation | Rejection,
): r is Rejection {
  return (r as Rejection).ok === false;
}

/**
 * The pluggable binder. Each concrete binder owns ONE anchor type and ONE injected
 * PROVER port (the external check). `challenge` mints a nonce; `bind` runs the
 * proof through the prover and, on success, emits a signed {@link
 * AnchorAttestation}; on failure a {@link Rejection}.
 */
export interface AnchorBinder {
  readonly anchorType: AnchorClass;
  /** Mint a fresh, time-boxed challenge nonce for a source. */
  challenge(sourceId: SourceId, now: EpochMs): Challenge;
  /**
   * Attempt to bind, verifying the proof via the injected prover. Returns a signed
   * attestation on success, a {@link Rejection} on any failure (fail-closed).
   */
  bind(
    sourceId: SourceId,
    proof: BindProof,
    now: EpochMs,
  ): AnchorAttestation | Rejection;
}

/**
 * The proof a source presents back. For DOMAIN it names the domain it published
 * the TXT nonce on; for EMAIL the address and the nonce it echoed. The binder
 * re-runs the actual check through its prover port — it never trusts the proof
 * blindly.
 */
export interface BindProof {
  /** The raw root the source claims to control (a domain, an email address). */
  readonly root: string;
  /** The nonce from the challenge the source is answering. */
  readonly nonce: string;
}

// ---------------------------------------------------------------------------
// Shared binder config
// ---------------------------------------------------------------------------

/** How long a freshly issued challenge stays answerable. */
export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 min
/** How long an emitted attestation stays valid before it must re-bind. */
export const DEFAULT_ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Mint a random base64url nonce. */
function mintNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Salt the root then sha256 it → base64url. Never the raw root. */
function saltedAnchorId(salt: string, canonicalRoot: string): string {
  return createHash("sha256")
    .update(utf8(salt + SEP + canonicalRoot))
    .digest("base64url");
}

// ---------------------------------------------------------------------------
// DOMAIN binder (DNS-01 style)
// ---------------------------------------------------------------------------

/**
 * Injected DNS-01 prover port. Prod impl performs a real `node:dns` TXT lookup at
 * `_iddb-challenge.<domain>` and checks the nonce is present; tests inject a mock.
 * NEVER does real network in tests — the port is the seam.
 */
export interface DomainProofChecker {
  /** True iff the challenge nonce is published at the domain's challenge record. */
  check(domain: string, nonce: string): boolean | Promise<boolean>;
}

/**
 * Injected operator lookup: maps a domain to its deterministic OPERATOR class
 * (WHOIS registrar / hosting ASN). Prod wires a real WHOIS/ASN service; tests
 * inject a deterministic map. This is the FLEET axis — many domains behind one
 * registrar share an operatorClassId.
 */
export interface RegistrarLookup {
  /** The deterministic operator class (registrar/ASN) for a domain. */
  operatorOf(domain: string): OperatorClassId;
}

/**
 * Injected eTLD+1 (registrable-domain) resolver. Zero bundled public-suffix list,
 * so the suffix policy is pluggable. Tests inject a deterministic resolver; prod
 * wires a real public-suffix list.
 */
export interface ETldResolver {
  /** The registrable domain (eTLD+1) of `domain`, lowercased. */
  registrableDomain(domain: string): string;
}

export interface DomainBinderDeps {
  /** The verifier keypair that signs emitted attestations. */
  readonly verifier: KeyPair;
  /** The DNS-01 proof checker (mock in tests). */
  readonly checker: DomainProofChecker;
  /** Registrar/ASN operator lookup (the fleet axis). */
  readonly registrar: RegistrarLookup;
  /** eTLD+1 resolver (the independence-class axis). */
  readonly etld: ETldResolver;
  /** Verifier-held salt for the anchorId hash (never logged with the root). */
  readonly anchorSalt: string;
  /** Challenge TTL override (default {@link DEFAULT_CHALLENGE_TTL_MS}). */
  readonly challengeTtlMs?: number;
  /** Attestation TTL override (default {@link DEFAULT_ATTESTATION_TTL_MS}). */
  readonly attestationTtlMs?: number;
}

/**
 * DOMAIN binder. classId = registrable domain (eTLD+1); operatorClassId =
 * registrar/ASN; weight = DOMAIN (0.35). Fail-closed: a failed proof ⇒ Rejection.
 *
 * NOTE: the prover port may be async in prod (real DNS), but `bind` is
 * synchronous; the binder only accepts a SYNCHRONOUS check result here so the
 * registry-facing path stays sync and testable. Wire an async resolution before
 * the binder if the prod checker is async (resolve the TXT lookup, then call
 * `bind` with a sync wrapper).
 */
export function createDomainBinder(deps: DomainBinderDeps): AnchorBinder {
  const challengeTtl = deps.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const attestationTtl = deps.attestationTtlMs ?? DEFAULT_ATTESTATION_TTL_MS;
  const weight = ANCHOR_TABLE[AnchorClass.DOMAIN].independenceWeight;

  return {
    anchorType: AnchorClass.DOMAIN,

    challenge(sourceId: SourceId, now: EpochMs): Challenge {
      return {
        sourceId,
        anchorType: AnchorClass.DOMAIN,
        nonce: mintNonce(),
        issuedAt: now,
        expiresAt: ((now as number) + challengeTtl) as EpochMs,
      };
    },

    bind(
      sourceId: SourceId,
      proof: BindProof,
      now: EpochMs,
    ): AnchorAttestation | Rejection {
      const domain = proof.root.trim().toLowerCase();
      if (domain.length === 0) {
        return { ok: false, reason: "empty domain" };
      }
      // Run the external proof through the injected port. A boolean is required
      // here (sync seam); a Promise is treated as "not yet proven" → fail-closed.
      const passed = deps.checker.check(domain, proof.nonce);
      if (passed !== true) {
        return { ok: false, reason: "DNS-01 proof failed" };
      }
      const registrable = deps.etld.registrableDomain(domain).toLowerCase();
      const classId = registrable as unknown as IndependenceClassId;
      const operatorClassId = deps.registrar.operatorOf(domain);
      const body: Omit<AnchorAttestation, "verifierSig"> = {
        sourceId,
        anchorType: AnchorClass.DOMAIN,
        anchorId: saltedAnchorId(deps.anchorSalt, registrable),
        operatorClassId,
        proofRef: "_iddb-challenge." + domain,
        weight,
        classId,
        notBefore: now,
        notAfter: ((now as number) + attestationTtl) as EpochMs,
      };
      return signAttestation(body, deps.verifier);
    },
  };
}

// ---------------------------------------------------------------------------
// EMAIL binder (signed-nonce round-trip)
// ---------------------------------------------------------------------------

/**
 * Injected email confirmation port: the source must echo the challenge nonce back
 * through the inbox. Prod sends a mail with the nonce and waits for the round-trip;
 * tests inject a mock. NEVER does real I/O in tests.
 */
export interface EmailConfirmationPort {
  /** True iff `address` confirmed (echoed) the challenge `nonce`. */
  confirm(address: string, nonce: string): boolean | Promise<boolean>;
}

export interface EmailBinderDeps {
  readonly verifier: KeyPair;
  readonly confirmation: EmailConfirmationPort;
  readonly anchorSalt: string;
  readonly challengeTtlMs?: number;
  readonly attestationTtlMs?: number;
}

/** Normalize an email address: trim + lowercase. (Provider-specific dot/plus
 * folding is a tuning knob; kept simple + deterministic here.) */
function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

/** The provider/domain part of an email address (the fleet axis). */
function emailDomainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : address;
}

/**
 * EMAIL binder. classId = normalized address; operatorClassId = the email
 * domain/provider (the fleet axis); weight = EMAIL_OAUTH (0.10). Fail-closed.
 */
export function createEmailBinder(deps: EmailBinderDeps): AnchorBinder {
  const challengeTtl = deps.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const attestationTtl = deps.attestationTtlMs ?? DEFAULT_ATTESTATION_TTL_MS;
  const weight = ANCHOR_TABLE[AnchorClass.EMAIL_OAUTH].independenceWeight;

  return {
    anchorType: AnchorClass.EMAIL_OAUTH,

    challenge(sourceId: SourceId, now: EpochMs): Challenge {
      return {
        sourceId,
        anchorType: AnchorClass.EMAIL_OAUTH,
        nonce: mintNonce(),
        issuedAt: now,
        expiresAt: ((now as number) + challengeTtl) as EpochMs,
      };
    },

    bind(
      sourceId: SourceId,
      proof: BindProof,
      now: EpochMs,
    ): AnchorAttestation | Rejection {
      const address = normalizeEmail(proof.root);
      if (address.length === 0 || !address.includes("@")) {
        return { ok: false, reason: "invalid email address" };
      }
      const passed = deps.confirmation.confirm(address, proof.nonce);
      if (passed !== true) {
        return { ok: false, reason: "email confirmation failed" };
      }
      const classId = address as unknown as IndependenceClassId;
      const operatorClassId = emailDomainOf(
        address,
      ) as unknown as OperatorClassId;
      const body: Omit<AnchorAttestation, "verifierSig"> = {
        sourceId,
        anchorType: AnchorClass.EMAIL_OAUTH,
        anchorId: saltedAnchorId(deps.anchorSalt, address),
        operatorClassId,
        proofRef: "email:" + proof.nonce,
        weight,
        classId,
        notBefore: now,
        notAfter: ((now as number) + attestationTtl) as EpochMs,
      };
      return signAttestation(body, deps.verifier);
    },
  };
}
