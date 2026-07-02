/**
 * publicSuffix.test.ts — the PSL-backed eTLD+1 resolver (V2.1 subdomain-seam fix).
 *
 * Covers the acceptance cases (subdomain collapse, PRIVATE-section both-directions
 * fix, multi-level ccTLD apex) plus the algorithm edges (deep subdomains, bare
 * suffix fail-safe, unknown-TLD default, normalization, `*`/`!` rule paths), and an
 * integration assertion that the seam fix flows through the trust registry's
 * publisher producer (the crypto-free consumer of this resolver).
 */

import { describe, it, expect } from "vitest";

import {
  registrableDomain,
  publicSuffixOf,
  pslResolver,
} from "./publicSuffix.js";
import { createTrustRegistry } from "../trustRegistry.js";

// ---------------------------------------------------------------------------
// Acceptance cases (SPEC §5)
// ---------------------------------------------------------------------------

describe("registrableDomain — acceptance", () => {
  it("collapses subdomains of one registrable name to one owner", () => {
    expect(registrableDomain("a.evilcorp.com")).toBe("evilcorp.com");
  });

  it("returns a plain registrable name unchanged", () => {
    expect(registrableDomain("evilcorp.com")).toBe("evilcorp.com");
  });

  it("keeps PRIVATE multi-tenant subdomains DISTINCT (github.io both directions)", () => {
    const a = registrableDomain("a.github.io");
    const b = registrableDomain("b.github.io");
    expect(a).toBe("a.github.io");
    expect(b).toBe("b.github.io");
    expect(a).not.toBe(b);
  });

  it("apexes a multi-level ccTLD to the real registrant, not the suffix", () => {
    expect(registrableDomain("bbc.co.uk")).toBe("bbc.co.uk");
  });
});

// ---------------------------------------------------------------------------
// Algorithm edges
// ---------------------------------------------------------------------------

describe("registrableDomain — edges", () => {
  it("collapses a deep subdomain chain to the registrable name", () => {
    expect(registrableDomain("x.y.z.evilcorp.com")).toBe("evilcorp.com");
  });

  it("apexes a deep subdomain under a multi-level ccTLD", () => {
    expect(registrableDomain("www.foo.co.uk")).toBe("foo.co.uk");
  });

  it("returns a bare public suffix unchanged (fail-safe, no phantom apex)", () => {
    expect(registrableDomain("co.uk")).toBe("co.uk");
    expect(registrableDomain("github.io")).toBe("github.io");
    expect(registrableDomain("com")).toBe("com");
  });

  it("falls to the single-label default for an unknown TLD", () => {
    expect(registrableDomain("foo.bar.zzfake")).toBe("bar.zzfake");
  });

  it("normalizes case and a trailing FQDN dot", () => {
    expect(registrableDomain("A.GitHub.IO.")).toBe("a.github.io");
    expect(registrableDomain("WWW.BBC.CO.UK")).toBe("bbc.co.uk");
  });

  it("returns empty for an empty / whitespace input", () => {
    expect(registrableDomain("")).toBe("");
    expect(registrableDomain("   ")).toBe("");
  });

  it("keeps a second multi-tenant PRIVATE host's subdomains distinct (herokuapp)", () => {
    expect(registrableDomain("app1.herokuapp.com")).not.toBe(
      registrableDomain("app2.herokuapp.com"),
    );
    expect(registrableDomain("app1.herokuapp.com")).toBe("app1.herokuapp.com");
  });

  it("treats other PRIVATE multi-tenant hosts the same way (vercel.app)", () => {
    expect(registrableDomain("proj.vercel.app")).toBe("proj.vercel.app");
    expect(registrableDomain("vercel.app")).toBe("vercel.app");
  });
});

// ---------------------------------------------------------------------------
// Wildcard (*) and exception (!) rule paths
// ---------------------------------------------------------------------------

describe("registrableDomain — wildcard & exception rules", () => {
  it("treats a wildcard rule label as a public suffix (*.ck)", () => {
    // `*.ck` ⇒ `foo.ck` is itself a public suffix ⇒ registrable = bar.foo.ck.
    expect(registrableDomain("bar.foo.ck")).toBe("bar.foo.ck");
    // bare `foo.ck` is exactly a public suffix ⇒ unchanged (fail-safe).
    expect(registrableDomain("foo.ck")).toBe("foo.ck");
  });

  it("honors an exception rule that carves a registrable name out (!www.ck)", () => {
    // `!www.ck` exception ⇒ public suffix is `ck`, so `www.ck` is registrable.
    expect(registrableDomain("www.ck")).toBe("www.ck");
    expect(registrableDomain("sub.www.ck")).toBe("www.ck");
  });

  it("handles a non-leftmost wildcard in the PRIVATE section (s3.*.amazonaws.com)", () => {
    // bucket.s3.<region>.amazonaws.com is its own owner under the wildcard.
    expect(registrableDomain("bucket.s3.us-east-1.amazonaws.com")).toBe(
      "bucket.s3.us-east-1.amazonaws.com",
    );
  });
});

// ---------------------------------------------------------------------------
// publicSuffixOf helper + resolver object
// ---------------------------------------------------------------------------

describe("publicSuffixOf + pslResolver", () => {
  it("returns the correct public suffix", () => {
    expect(publicSuffixOf("a.evilcorp.com")).toBe("com");
    expect(publicSuffixOf("bbc.co.uk")).toBe("co.uk");
    expect(publicSuffixOf("a.github.io")).toBe("github.io");
  });

  it("pslResolver.registrableDomain matches the bare function", () => {
    expect(pslResolver.registrableDomain("a.github.io")).toBe("a.github.io");
    expect(pslResolver.registrableDomain("bbc.co.uk")).toBe("bbc.co.uk");
  });
});

// ---------------------------------------------------------------------------
// Integration: the seam fix flows through the trust registry's publisher
// producer → distinct publisher classes for PRIVATE multi-tenant subdomains
// ---------------------------------------------------------------------------

describe("integration — pslResolver through registerPublisher", () => {
  it("mints DISTINCT publisher sources for a.github.io vs b.github.io", () => {
    const registry = createTrustRegistry();

    const a = registry.registerPublisher("https://a.github.io/some/page");
    const b = registry.registerPublisher("https://b.github.io/other/page");

    // The PRIVATE-section fix flows through: two GitHub Pages owners are two
    // distinct publishers (labels are the resolved eTLD+1s), not one phantom.
    expect(a.label).toBe("a.github.io");
    expect(b.label).toBe("b.github.io");
    expect(a.sourceId).not.toBe(b.sourceId);
    expect(registry.independentSources(a.sourceId, b.sourceId)).toBe(true);
  });
});
