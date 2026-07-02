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
 * block proves the FIX flows through the trust registry's publisher producer: two
 * URLs under ONE ordinary registrable name collapse to the SAME publisher source
 * (the subdomain seam closed), while two genuinely-distinct registrable names stay
 * DISTINCT (the Registrar Carousel is correctly NOT collapsed — it is the
 * priced-not-prevented residual; the config-injected `operatorOf` fleet hook is
 * the partial mitigation, also exercised here).
 *
 * Complements (does not duplicate) publicSuffix.test.ts: that file proves the
 * github.io PRIVATE distinctness through the producer; this file proves the
 * COLLAPSE direction and the carousel-stays-distinct direction through it.
 */

import { describe, it, expect } from "vitest";

import { registrableDomain } from "./publicSuffix.js";
import { createTrustRegistry } from "../trustRegistry.js";

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

  it("REGRESSION (red-team ce-c3-02): K same-owner subdomains collapse to ONE class; K PRIVATE-section tenants stay K", () => {
    // The exact Mega-Provider Subdomain Seam scenario the cycle-3 red-team spec
    // now routes through this SAME shipped resolver: 5 subdomains of one $9
    // registrable parent must yield ONE independence class (one witness)…
    const subs = Array.from({ length: 5 }, (_, i) => registrableDomain(`sub${i}.evilcorp.com`));
    expect(new Set(subs).size).toBe(1);
    expect(subs[0]).toBe("evilcorp.com");
    // …while 5 genuinely-distinct GitHub Pages owners (PSL PRIVATE section)
    // must NOT be over-collapsed into a phantom single owner.
    const tenants = Array.from({ length: 5 }, (_, i) => registrableDomain(`owner${i}.github.io`));
    expect(new Set(tenants).size).toBe(5);
  });

  it("two genuinely-distinct registrable names stay distinct (carousel)", () => {
    // PSL does NOT collapse a registrar carousel — distinct $/yr names are
    // legitimately independent DOMAIN classes (priced-not-prevented residual).
    expect(registrableDomain("evil1.com")).not.toBe(registrableDomain("evil2.com"));
  });
});

// ---------------------------------------------------------------------------
// Integration: the seam through registerPublisher (both directions)
// ---------------------------------------------------------------------------

describe("integration — PSL both-directions through registerPublisher", () => {
  it("SEAM CLOSED: two subdomain URLs of one ordinary name collapse to ONE publisher", () => {
    const registry = createTrustRegistry();

    const a = registry.registerPublisher("https://a.evilcorp.com/page-1");
    const b = registry.registerPublisher("https://b.evilcorp.com/page-2");

    // One registrable name ⇒ ONE publisher source ⇒ an echo, never two witnesses.
    expect(a.label).toBe("evilcorp.com");
    expect(b.label).toBe("evilcorp.com");
    expect(a.sourceId).toBe(b.sourceId); // subdomain seam closed
  });

  it("CAROUSEL NOT COLLAPSED: two distinct registrable names stay DISTINCT publishers", () => {
    const registry = createTrustRegistry();

    const a = registry.registerPublisher("https://evil1.com/x");
    const b = registry.registerPublisher("https://evil2.com/y");

    expect(a.label).toBe("evil1.com");
    expect(b.label).toBe("evil2.com");
    expect(a.sourceId).not.toBe(b.sourceId);
    // PSL leaves the carousel as distinct priced identities…
    expect(registry.independentSources(a.sourceId, b.sourceId)).toBe(true);
  });

  it("…but the operatorOf FLEET hook is the partial mitigation: one operator collapses the carousel", () => {
    // A configured ownership-cluster lookup maps both names to one operator.
    const registry = createTrustRegistry({
      operatorOf: (etld1) =>
        etld1 === "evil1.com" || etld1 === "evil2.com" ? "op:evil-cluster" : etld1,
    });

    const a = registry.registerPublisher("https://evil1.com/x");
    const b = registry.registerPublisher("https://evil2.com/y");

    expect(a.sourceId).not.toBe(b.sourceId); // still two sources (sameness)…
    // …but NOT independent: the shared operator class is the fleet cap.
    expect(registry.independentSources(a.sourceId, b.sourceId)).toBe(false);
  });
});
