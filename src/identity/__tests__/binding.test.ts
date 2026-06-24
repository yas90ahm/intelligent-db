/**
 * binding.test.ts — the ANCHOR-BINDING PIPELINE invariants (ARCHITECTURE.md §1).
 *
 * Covers the attestation model + binders (DOMAIN, EMAIL) with INJECTED, MOCKED
 * prover ports (no real DNS / email — the seam is mocked). Asserts:
 *   - a passed DOMAIN proof earns a signed attestation; a failed proof is rejected.
 *   - a passed EMAIL proof earns a signed attestation (weight 0.10).
 *   - attestations are SIGNED + verifiable; a forged/tampered one fails; an
 *     expired one fails the window (boundary `now >= notAfter`).
 */

import { describe, it, expect } from "vitest";

import {
  AnchorClass,
  asEpochMs,
  generatePassport,
  createDomainBinder,
  createEmailBinder,
  verifyAttestation,
  signAttestation,
  isRejection,
} from "../../index.js";
import type {
  SourceId,
  EpochMs,
  KeyPair,
  AnchorAttestation,
  DomainProofChecker,
  RegistrarLookup,
  ETldResolver,
  EmailConfirmationPort,
  OperatorClassId,
} from "../../index.js";

// --- mock prover ports (the injected seam; NO real network) ----------------

const passChecker: DomainProofChecker = { check: () => true };
const failChecker: DomainProofChecker = { check: () => false };

function registrar(map: Record<string, string>): RegistrarLookup {
  return {
    operatorOf: (domain) => (map[domain] ?? "registrar:unknown") as OperatorClassId,
  };
}

const etld: ETldResolver = {
  // Naive eTLD+1 for tests: last two labels.
  registrableDomain: (domain) => {
    const labels = domain.split(".");
    return labels.slice(-2).join(".");
  },
};

const passConfirm: EmailConfirmationPort = { confirm: () => true };
const failConfirm: EmailConfirmationPort = { confirm: () => false };

function verifierKey(): KeyPair {
  return generatePassport();
}

const NOW = asEpochMs(1_700_000_000_000);

describe("anchor binding — DOMAIN binder (DNS-01 mock)", () => {
  it("a passed DOMAIN proof earns a signed, verifiable DOMAIN attestation (weight 0.35)", () => {
    const verifier = verifierKey();
    const binder = createDomainBinder({
      verifier,
      checker: passChecker,
      registrar: registrar({ "shop.example.com": "registrar:A" }),
      etld,
      anchorSalt: "salt-1",
    });
    const sourceId = "src:1" as SourceId;
    const challenge = binder.challenge(sourceId, NOW);
    const result = binder.bind(
      sourceId,
      { root: "shop.example.com", nonce: challenge.nonce },
      NOW,
    );

    expect(isRejection(result)).toBe(false);
    const att = result as AnchorAttestation;
    expect(att.anchorType).toBe(AnchorClass.DOMAIN);
    expect(att.weight).toBeCloseTo(0.35, 5);
    expect(att.classId).toBe("example.com"); // eTLD+1
    expect(att.operatorClassId).toBe("registrar:A");
    // anchorId is a salted hash — NEVER the raw domain.
    expect(att.anchorId).not.toContain("example");
    // Signed + verifiable within the window.
    expect(verifyAttestation(att, verifier.publicKeyPem, NOW)).toBe(true);
  });

  it("a FAILED DOMAIN proof is REJECTED — no attestation (fail-closed)", () => {
    const verifier = verifierKey();
    const binder = createDomainBinder({
      verifier,
      checker: failChecker,
      registrar: registrar({}),
      etld,
      anchorSalt: "salt-1",
    });
    const sourceId = "src:bad" as SourceId;
    const challenge = binder.challenge(sourceId, NOW);
    const result = binder.bind(
      sourceId,
      { root: "evil.example.com", nonce: challenge.nonce },
      NOW,
    );
    expect(isRejection(result)).toBe(true);
  });
});

describe("anchor binding — EMAIL binder (round-trip mock)", () => {
  it("a confirmed EMAIL earns a signed EMAIL_OAUTH attestation (weight 0.10)", () => {
    const verifier = verifierKey();
    const binder = createEmailBinder({
      verifier,
      confirmation: passConfirm,
      anchorSalt: "salt-e",
    });
    const sourceId = "src:e" as SourceId;
    const challenge = binder.challenge(sourceId, NOW);
    const result = binder.bind(
      sourceId,
      { root: "Alice@Mail.com", nonce: challenge.nonce },
      NOW,
    );
    expect(isRejection(result)).toBe(false);
    const att = result as AnchorAttestation;
    expect(att.anchorType).toBe(AnchorClass.EMAIL_OAUTH);
    expect(att.weight).toBeCloseTo(0.1, 5);
    expect(att.classId).toBe("alice@mail.com"); // normalized
    expect(att.operatorClassId).toBe("mail.com"); // provider = fleet axis
    expect(verifyAttestation(att, verifier.publicKeyPem, NOW)).toBe(true);
  });

  it("an UNCONFIRMED email is REJECTED (fail-closed)", () => {
    const verifier = verifierKey();
    const binder = createEmailBinder({
      verifier,
      confirmation: failConfirm,
      anchorSalt: "salt-e",
    });
    const result = binder.bind(
      "src:e2" as SourceId,
      { root: "bob@mail.com", nonce: "n" },
      NOW,
    );
    expect(isRejection(result)).toBe(true);
  });
});

describe("anchor binding — signature + expiry", () => {
  it("a FORGED attestation (flipped byte) fails verification", () => {
    const verifier = verifierKey();
    const binder = createDomainBinder({
      verifier,
      checker: passChecker,
      registrar: registrar({ "a.com": "r:1" }),
      etld,
      anchorSalt: "s",
    });
    const att = binder.bind(
      "src:f" as SourceId,
      { root: "a.com", nonce: "n" },
      NOW,
    ) as AnchorAttestation;
    expect(verifyAttestation(att, verifier.publicKeyPem, NOW)).toBe(true);

    // Tamper with a signed field — verification must fail.
    const tampered: AnchorAttestation = { ...att, weight: 0.9 };
    expect(verifyAttestation(tampered, verifier.publicKeyPem, NOW)).toBe(false);

    // A DIFFERENT verifier key must also fail (wrong signer).
    const other = verifierKey();
    expect(verifyAttestation(att, other.publicKeyPem, NOW)).toBe(false);
  });

  it("an EXPIRED attestation fails the window (boundary: now >= notAfter)", () => {
    const verifier = verifierKey();
    const body = {
      sourceId: "src:exp" as SourceId,
      anchorType: AnchorClass.DOMAIN,
      anchorId: "x",
      operatorClassId: "r:1" as OperatorClassId,
      proofRef: "p",
      weight: 0.35,
      classId: "a.com" as unknown as AnchorAttestation["classId"],
      notBefore: NOW,
      notAfter: asEpochMs((NOW as number) + 1000),
    };
    const att = signAttestation(body, verifier);
    // Valid strictly before notAfter.
    expect(
      verifyAttestation(att, verifier.publicKeyPem, asEpochMs((NOW as number) + 999)),
    ).toBe(true);
    // At exactly notAfter it is already expired.
    expect(verifyAttestation(att, verifier.publicKeyPem, att.notAfter)).toBe(
      false,
    );
    // After notAfter, expired.
    expect(
      verifyAttestation(att, verifier.publicKeyPem, asEpochMs((NOW as number) + 2000)),
    ).toBe(false);
    // Before notBefore, not yet valid.
    expect(
      verifyAttestation(att, verifier.publicKeyPem, asEpochMs((NOW as number) - 1)),
    ).toBe(false);
  });
});
