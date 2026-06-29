/**
 * publicSuffix.bothDirections.test.ts — the PSL eTLD+1 resolver, proven correct in
 * BOTH directions (the over-collapse and the wrong-apex failure modes from the
 * module header), then proven to flow through the binder as a closed seam.
 *
 * A WRONG registrable domain corrupts DOMAIN-axis independence two ways:
 *   - OVER-COLLAPSE: `a.github.io` / `b.github.io` (a PRIVATE multi-tenant host)
 *     must stay DISTINCT owners — a naive "last two labels" rule mis-merges two
 *     independent sources into one phantom echo.
 *   - WRONG APEX: `bbc.co.uk` must apex to `bbc.co.uk` (the real registrant), NOT
 *     to `co.uk` (a public suffix) — the naive rule collapses an entire ccTLD.
 *
 * The unit block asserts both directions on `registrableDomain`; the integration
 * block proves the FIX flows through the DNS binder: two subdomains of ONE ordinary
 * registrable name collapse to the SAME DOMAIN classId (the subdomain seam closed),
 * while two genuinely-distinct registrable names stay DISTINCT (the Registrar
 * Carousel is correctly NOT collapsed — it is the priced-not-prevented residual).
 *
 * Complements (does not duplicate) publicSuffix.test.ts: that file proves the
 * github.io PRIVATE distinctness through the binder; this file proves the
 * COLLAPSE direction and the carousel-stays-distinct direction through the binder.
 */

import { describe, it, expect } from "vitest";

import { registrableDomain, pslResolver } from "./publicSuffix.js";
import { asEpochMs } from "../../core/types.js";
import { generatePassport, sourceIdFromPublicKey, type KeyPair } from "../keys.js";
import { isRejection } from "../binding.js";
import {
  bindDomainViaDns,
  fakeResolver,
  createDnsDomainProofChecker,
  type DnsResolver,
  type DnsDomainBindDeps,
} from "./dnsDomainProver.js";

// ---------------------------------------------------------------------------
// Unit: both directions on registrableDomain
// ---------------------------------------------------------------------------

describe("PSL both-directions correctness", () => {
  it("sub-domain collapse: a/b.evilcorp.com → same registrable evilcorp.com", () => {
    const a = registrableDomain("a.evilcorp.com");
    const b = registrableDomain("b.evilcorp.com");
    expect(a).toBe("evilcorp.com");
    expect(b).toBe("evilcorp.com");
    expect(a).toBe(b); // one owner — an echo, not corroboration
  });

  it("PRIVATE-section distinctness: a/b.github.io → distinct owners", () => {
    const a = registrableDomain("a.github.io");
    const b = registrableDomain("b.github.io");
    expect(a).toBe("a.github.io");
    expect(b).toBe("b.github.io");
    expect(a).not.toBe(b); // two independent GitHub Pages owners
  });

  it("multi-level ccTLD: bbc.co.uk → bbc.co.uk, NOT the co.uk suffix", () => {
    expect(registrableDomain("bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("bbc.co.uk")).not.toBe("co.uk");
  });

  it("plain apex unchanged: evilcorp.com → evilcorp.com", () => {
    expect(registrableDomain("evilcorp.com")).toBe("evilcorp.com");
  });

  it("wildcard + exception pair (*.ck / !www.ck)", () => {
    // `*.ck` makes `foo.ck` itself a public suffix ⇒ registrable = bar.foo.ck.
    expect(registrableDomain("bar.foo.ck")).toBe("bar.foo.ck");
    // `!www.ck` carves www.ck back out as a registrable name.
    expect(registrableDomain("sub.www.ck")).toBe("www.ck");
  });

  it("two genuinely-distinct registrable names stay distinct (carousel)", () => {
    // PSL does NOT collapse a registrar carousel — distinct $/yr names are
    // legitimately independent DOMAIN classes (priced-not-prevented residual).
    expect(registrableDomain("evil1.com")).not.toBe(registrableDomain("evil2.com"));
  });
});

// ---------------------------------------------------------------------------
// Integration: the seam through bindDomainViaDns (classId both directions)
// ---------------------------------------------------------------------------

describe("integration — PSL classId both-directions through bindDomainViaDns", () => {
  const NOW = asEpochMs(1_700_000_000_000);
  const NONCE = "nonce-bothdir";

  function bindDeps(verifier: KeyPair, resolver: DnsResolver): DnsDomainBindDeps {
    return {
      verifier,
      checker: createDnsDomainProofChecker({ resolver }),
      etld: pslResolver,
      anchorSalt: "test-salt",
      resolver,
    };
  }

  async function classIdFor(
    domain: string,
    verifier: KeyPair,
    resolver: DnsResolver,
  ): Promise<string> {
    const src = sourceIdFromPublicKey(generatePassport().publicKeyPem);
    const att = await bindDomainViaDns(src, domain, NONCE, bindDeps(verifier, resolver), NOW);
    expect(isRejection(att)).toBe(false);
    if (isRejection(att)) throw new Error(`unexpected rejection: ${att.reason}`);
    return att.classId as unknown as string;
  }

  it("SEAM CLOSED: two subdomains of one ordinary name share ONE DOMAIN classId", async () => {
    const verifier = generatePassport();
    const resolver = fakeResolver(
      new Map<string, string[][]>([
        ["_iddb-challenge.a.evilcorp.com", [[NONCE]]],
        ["_iddb-challenge.b.evilcorp.com", [[NONCE]]],
      ]),
      new Map<string, string[]>([
        // NS keyed by the registrable apex (deriveOperatorClass resolves the apex).
        ["evilcorp.com", ["ns1.somehost.net"]],
      ]),
    );

    const a = await classIdFor("a.evilcorp.com", verifier, resolver);
    const b = await classIdFor("b.evilcorp.com", verifier, resolver);
    expect(a).toBe("evilcorp.com");
    expect(b).toBe("evilcorp.com");
    expect(a).toBe(b); // subdomain seam closed — not two phantom witnesses
  });

  it("CAROUSEL NOT COLLAPSED: two distinct registrable names get DISTINCT classIds", async () => {
    const verifier = generatePassport();
    const resolver = fakeResolver(
      new Map<string, string[][]>([
        ["_iddb-challenge.evil1.com", [[NONCE]]],
        ["_iddb-challenge.evil2.com", [[NONCE]]],
      ]),
      new Map<string, string[]>([
        ["evil1.com", ["ns1.somehost.net"]],
        ["evil2.com", ["ns1.somehost.net"]],
      ]),
    );

    const a = await classIdFor("evil1.com", verifier, resolver);
    const b = await classIdFor("evil2.com", verifier, resolver);
    expect(a).toBe("evil1.com");
    expect(b).toBe("evil2.com");
    expect(a).not.toBe(b); // PSL leaves the carousel as distinct priced identities
  });
});
