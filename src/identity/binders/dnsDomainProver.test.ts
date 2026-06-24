/**
 * dnsDomainProver.test.ts — the REAL DNS-01 prover invariants, HERMETIC.
 *
 * NO real network in the default suite: every test injects a FAKE resolver
 * (in-memory maps), so the suite never touches DNS. Asserts:
 *   - a domain whose TXT record contains the nonce BINDS (signed attestation
 *     issued; ingests into the registry; earns DOMAIN independence 0.35).
 *   - a missing / wrong TXT ⇒ Rejection (fail-closed).
 *   - multi-string TXT chunk handling (chunks joined per record).
 *   - a malformed domain ⇒ Rejection.
 *   - NS-derived operatorClassId COLLAPSES two domains behind the same nameserver
 *     operator (fleet cap) and SEPARATES two behind different operators.
 *   - unknown-NS sentinel collapses (never manufactures independence).
 *
 * Plus ONE opt-in LIVE test (env-gated IDDB_LIVE_DNS=1) that hits real DNS for a
 * well-known existing TXT — SKIPPED by default so CI never flakes.
 */

import { describe, it, expect } from "vitest";

import {
  AnchorClass,
  asEpochMs,
  generatePassport,
  createAnchorRegistry,
  createDnsDomainProofChecker,
  createNodeDnsResolver,
  fakeResolver,
  deriveOperatorClass,
  bindDomainViaDns,
  isRejection,
  UNKNOWN_DNS_OPERATOR,
} from "../../index.js";
import type {
  SourceId,
  EpochMs,
  KeyPair,
  AnchorAttestation,
  ETldResolver,
  DnsResolver,
  DnsDomainBindDeps,
} from "../../index.js";

// --- hermetic fixtures ------------------------------------------------------

const NOW = asEpochMs(1_700_000_000_000);

/** Naive eTLD+1 for tests: the last two labels. */
const etld: ETldResolver = {
  registrableDomain: (d) => d.split(".").slice(-2).join("."),
};

function verifierKey(): KeyPair {
  return generatePassport();
}

/** A resolver whose TXT record at `_iddb-challenge.<domain>` carries `chunks`,
 * and whose NS records are the given hostnames. */
function resolverWith(
  txt: Record<string, string[][]>,
  ns: Record<string, string[]>,
): DnsResolver {
  return fakeResolver(
    new Map(Object.entries(txt)),
    new Map(Object.entries(ns)),
  );
}

function bindDeps(
  verifier: KeyPair,
  resolver: DnsResolver,
): DnsDomainBindDeps {
  return {
    verifier,
    checker: createDnsDomainProofChecker({ resolver }),
    etld,
    anchorSalt: "salt-dns",
    resolver,
  };
}

// ---------------------------------------------------------------------------

describe("DNS-01 prover — checker (fake resolver, no network)", () => {
  it("returns true when the challenge TXT contains the nonce", async () => {
    const resolver = resolverWith(
      { "_iddb-challenge.shop.example.com": [["the-nonce-123"]] },
      {},
    );
    const checker = createDnsDomainProofChecker({ resolver });
    expect(await checker.check("shop.example.com", "the-nonce-123")).toBe(true);
  });

  it("returns false on a wrong nonce, and false (fail-closed) on a missing record", async () => {
    const resolver = resolverWith(
      { "_iddb-challenge.shop.example.com": [["other-token"]] },
      {},
    );
    const checker = createDnsDomainProofChecker({ resolver });
    expect(await checker.check("shop.example.com", "the-nonce-123")).toBe(false);
    // NXDOMAIN-shaped reject ⇒ false, never throws.
    expect(await checker.check("absent.example.com", "anything")).toBe(false);
  });

  it("joins multi-string TXT chunks within ONE record", async () => {
    // DNS split one 8-char string into two ≤255-byte chunks.
    const resolver = resolverWith(
      { "_iddb-challenge.big.example.com": [["pre", "fix-xyz"]] },
      {},
    );
    const checker = createDnsDomainProofChecker({ resolver });
    expect(await checker.check("big.example.com", "prefix-xyz")).toBe(true);
    // Must NOT match a single chunk in isolation.
    expect(await checker.check("big.example.com", "pre")).toBe(false);
  });

  it("does NOT flatten across separate records (each record joined independently)", async () => {
    const resolver = resolverWith(
      { "_iddb-challenge.multi.example.com": [["aaa"], ["bbb"]] },
      {},
    );
    const checker = createDnsDomainProofChecker({ resolver });
    // The concatenation across records ("aaabbb") must not match.
    expect(await checker.check("multi.example.com", "aaabbb")).toBe(false);
    // But either standalone record matches.
    expect(await checker.check("multi.example.com", "aaa")).toBe(true);
    expect(await checker.check("multi.example.com", "bbb")).toBe(true);
  });

  it("honors a configurable challenge prefix", async () => {
    const resolver = resolverWith(
      { "_acme.shop.example.com": [["tok"]] },
      {},
    );
    const checker = createDnsDomainProofChecker({
      resolver,
      challengePrefix: "_acme",
    });
    expect(await checker.check("shop.example.com", "tok")).toBe(true);
  });
});

describe("DNS-01 prover — async binding flow", () => {
  it("a domain with the matching TXT BINDS: attestation issued, ingests, earns DOMAIN 0.35", async () => {
    const verifier = verifierKey();
    const resolver = resolverWith(
      { "_iddb-challenge.shop.example.com": [["nonce-abc"]] },
      { "example.com": ["ns1.cloudns.net", "ns2.cloudns.net"] },
    );
    const sourceId = "src:dns-1" as SourceId;
    const result = await bindDomainViaDns(
      sourceId,
      "shop.example.com",
      "nonce-abc",
      bindDeps(verifier, resolver),
      NOW,
    );

    expect(isRejection(result)).toBe(false);
    const att = result as AnchorAttestation;
    expect(att.anchorType).toBe(AnchorClass.DOMAIN);
    expect(att.weight).toBeCloseTo(0.35, 5);
    expect(att.classId).toBe("example.com");
    expect(att.proofRef).toBe("_iddb-challenge.shop.example.com");
    // anchorId is salted — never the raw domain.
    expect(att.anchorId).not.toContain("example");
    // operatorClassId is the NS apex (cloudns.net).
    expect(att.operatorClassId).toBe("ns:cloudns.net");

    // Flows into the real registry exactly like the mocked path.
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => NOW,
    });
    expect(registry.ingest(att, NOW)).toBe(true);
    const anchors = registry.anchorsOf(sourceId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.anchorClass).toBe(AnchorClass.DOMAIN);
    expect(anchors[0]!.independenceWeight).toBeCloseTo(0.35, 5);
  });

  it("a missing TXT ⇒ Rejection (fail-closed)", async () => {
    const verifier = verifierKey();
    const resolver = resolverWith({}, { "example.com": ["ns1.x.net"] });
    const result = await bindDomainViaDns(
      "src:miss" as SourceId,
      "shop.example.com",
      "nonce-abc",
      bindDeps(verifier, resolver),
      NOW,
    );
    expect(isRejection(result)).toBe(true);
  });

  it("a WRONG TXT token ⇒ Rejection", async () => {
    const verifier = verifierKey();
    const resolver = resolverWith(
      { "_iddb-challenge.shop.example.com": [["WRONG"]] },
      { "example.com": ["ns1.x.net"] },
    );
    const result = await bindDomainViaDns(
      "src:wrong" as SourceId,
      "shop.example.com",
      "nonce-abc",
      bindDeps(verifier, resolver),
      NOW,
    );
    expect(isRejection(result)).toBe(true);
  });

  it("binds via a multi-string TXT record", async () => {
    const verifier = verifierKey();
    const resolver = resolverWith(
      { "_iddb-challenge.big.example.com": [["pre", "fix-xyz"]] },
      { "example.com": ["ns1.x.net"] },
    );
    const result = await bindDomainViaDns(
      "src:multi" as SourceId,
      "big.example.com",
      "prefix-xyz",
      bindDeps(verifier, resolver),
      NOW,
    );
    expect(isRejection(result)).toBe(false);
  });

  it.each(["", "no-dot", "   ", "bad_underscore.com", "-bad.com"])(
    "a malformed domain (%j) ⇒ Rejection",
    async (bad) => {
      const verifier = verifierKey();
      const resolver = resolverWith({}, {});
      const result = await bindDomainViaDns(
        "src:bad" as SourceId,
        bad,
        "nonce",
        bindDeps(verifier, resolver),
        NOW,
      );
      expect(isRejection(result)).toBe(true);
    },
  );
});

describe("NS-derived operator class — the REAL fleet axis", () => {
  it("two domains behind the SAME nameserver operator share an operatorClassId (fleet cap)", async () => {
    const verifier = verifierKey();
    // alpha.com and beta.com are both served by the same DNS operator (bigdns.net).
    const resolver = resolverWith(
      {
        "_iddb-challenge.a.alpha.com": [["n-a"]],
        "_iddb-challenge.b.beta.com": [["n-b"]],
      },
      {
        "alpha.com": ["ns1.bigdns.net", "ns2.bigdns.net"],
        "beta.com": ["ns3.bigdns.net", "ns4.bigdns.net"],
      },
    );

    const attA = (await bindDomainViaDns(
      "src:A" as SourceId,
      "a.alpha.com",
      "n-a",
      bindDeps(verifier, resolver),
      NOW,
    )) as AnchorAttestation;
    const attB = (await bindDomainViaDns(
      "src:B" as SourceId,
      "b.beta.com",
      "n-b",
      bindDeps(verifier, resolver),
      NOW,
    )) as AnchorAttestation;

    expect(attA.operatorClassId).toBe("ns:bigdns.net");
    expect(attB.operatorClassId).toBe("ns:bigdns.net");
    expect(attA.operatorClassId).toBe(attB.operatorClassId);

    // The registry's fleet cap collapses them: same operator ⇒ NOT independent.
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => NOW,
    });
    expect(registry.ingest(attA, NOW)).toBe(true);
    expect(registry.ingest(attB, NOW)).toBe(true);
    expect(
      registry.independentSources!("src:A" as SourceId, "src:B" as SourceId),
    ).toBe(false);
  });

  it("two domains behind DIFFERENT nameserver operators are independent", async () => {
    const verifier = verifierKey();
    const resolver = resolverWith(
      {
        "_iddb-challenge.a.alpha.com": [["n-a"]],
        "_iddb-challenge.b.beta.com": [["n-b"]],
      },
      {
        "alpha.com": ["ns1.dnsone.net", "ns2.dnsone.net"],
        "beta.com": ["ns1.dnstwo.net", "ns2.dnstwo.net"],
      },
    );

    const attA = (await bindDomainViaDns(
      "src:A" as SourceId,
      "a.alpha.com",
      "n-a",
      bindDeps(verifier, resolver),
      NOW,
    )) as AnchorAttestation;
    const attB = (await bindDomainViaDns(
      "src:B" as SourceId,
      "b.beta.com",
      "n-b",
      bindDeps(verifier, resolver),
      NOW,
    )) as AnchorAttestation;

    expect(attA.operatorClassId).toBe("ns:dnsone.net");
    expect(attB.operatorClassId).toBe("ns:dnstwo.net");
    expect(attA.operatorClassId).not.toBe(attB.operatorClassId);

    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => NOW,
    });
    expect(registry.ingest(attA, NOW)).toBe(true);
    expect(registry.ingest(attB, NOW)).toBe(true);
    expect(
      registry.independentSources!("src:A" as SourceId, "src:B" as SourceId),
    ).toBe(true);
  });

  it("an UNKNOWN-NS domain collapses to the shared sentinel (never fakes independence)", async () => {
    // No NS records ⇒ both fall to the same UNKNOWN sentinel.
    const resolver = resolverWith({}, {});
    const opA = await deriveOperatorClass("a.alpha.com", resolver, etld);
    const opB = await deriveOperatorClass("b.beta.com", resolver, etld);
    expect(opA).toBe(UNKNOWN_DNS_OPERATOR);
    expect(opB).toBe(UNKNOWN_DNS_OPERATOR);
    expect(opA).toBe(opB);
  });

  it("an empty NS result also collapses to the sentinel", async () => {
    const resolver = resolverWith({}, { "alpha.com": [] });
    const op = await deriveOperatorClass("a.alpha.com", resolver, etld);
    expect(op).toBe(UNKNOWN_DNS_OPERATOR);
  });
});

// ---------------------------------------------------------------------------
// OPT-IN LIVE test — hits real DNS. SKIPPED unless IDDB_LIVE_DNS=1. Never CI-flaky.
// ---------------------------------------------------------------------------

const LIVE = process.env.IDDB_LIVE_DNS === "1";

(LIVE ? describe : describe.skip)("LIVE DNS (opt-in: IDDB_LIVE_DNS=1)", () => {
  it("resolves a TXT that surely exists on a well-known domain", async () => {
    const resolver = createNodeDnsResolver();
    // _dmarc.google.com publishes a DMARC TXT policy that surely exists.
    const records = await resolver.resolveTxt("_dmarc.google.com");
    const joined = records.map((chunks) => chunks.join("")).join(" ");
    expect(joined.toLowerCase()).toContain("v=dmarc1");
  });

  it("resolves NS for a well-known domain", async () => {
    const resolver = createNodeDnsResolver();
    const ns = await resolver.resolveNs("google.com");
    expect(ns.length).toBeGreaterThan(0);
  });
});
