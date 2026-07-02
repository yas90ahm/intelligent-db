/**
 * trustRegistry.test.ts — the crypto-free TRUST REGISTRY, tested per invariant.
 *
 * What must hold (design doc §4.1 + the owner's two-tier amendments):
 *  - OWNER registration yields a well-formed, external-authority-grade stamp.
 *  - SSO FLEET COLLAPSE: two members of ONE tenant are NOT independent; members
 *    of two DIFFERENT (bare) tenants ARE class-disjoint but weight-capped at
 *    the deliberately email-grade 0.12.
 *  - PUBLISHER COLLAPSE: N URLs under one eTLD+1 are ONE source, ONE class.
 *  - trackedPublishers upgrades to PUBLISHER_TRACKED (0.18/0.35), never higher.
 *  - A registry-CONFIGURED verified custom domain earns the tenant's members a
 *    DOMAIN binding; a caller-supplied hint alone (or a contradicting hint)
 *    grants nothing (fail-closed).
 *  - SYSTEM_OF_RECORD binds at authority grade, keyed by configured name.
 *  - `sourceIdFor` is deterministic and unambiguous over the (issuer, subject)
 *    pair.
 *  - A bare registration (no claim producer) fails CLOSED in independence.
 */

import { describe, it, expect } from "vitest";

import { AnchorClass } from "../../core/types.js";
import type { SourceId } from "../../core/types.js";
import { createTrustRegistry } from "../trustRegistry.js";
import { sourceIdFor } from "../sources.js";
import { createSourceIdentityLayer } from "../index.js";
import type { SourceIdentityLayer } from "../index.js";
import { ANCHOR_TABLE, repCapFor } from "../anchors.js";

/** A facade over one registry, with the zero reputation/stake defaults. */
function layerOver(registry: ReturnType<typeof createTrustRegistry>): SourceIdentityLayer {
  return createSourceIdentityLayer({
    sources: registry,
    anchors: registry,
    reputation: { scoreOf: () => 0 },
    // stake omitted: the retired pillar defaults to the constant-zero port.
  });
}

// ---------------------------------------------------------------------------
// sourceIdFor determinism
// ---------------------------------------------------------------------------

describe("sourceIdFor", () => {
  it("is deterministic: same issuer+subject ⇒ same id, always", () => {
    expect(sourceIdFor("idp:acme", "alice")).toBe(sourceIdFor("idp:acme", "alice"));
  });

  it("namespaces by issuer: same subject under two issuers ⇒ distinct ids", () => {
    expect(sourceIdFor("idp:acme", "alice")).not.toBe(sourceIdFor("idp:globex", "alice"));
  });

  it("is unambiguous over the pair (no concatenation collision)", () => {
    // Without a separator these two pairs would concatenate identically.
    expect(sourceIdFor("ab", "c")).not.toBe(sourceIdFor("a", "bc"));
  });
});

// ---------------------------------------------------------------------------
// OWNER — the personal tier's ground truth
// ---------------------------------------------------------------------------

describe("registerOwner", () => {
  it("registers the owner and stamps at external-authority grade", () => {
    const registry = createTrustRegistry();
    const identity = layerOver(registry);

    const owner = registry.registerOwner();
    expect(owner.kind).toBe("OWNER");
    expect(registry.has(owner.sourceId)).toBe(true);

    const stamp = identity.stampFor(owner.sourceId);
    expect(stamp.source_id).toBe(owner.sourceId);
    expect(stamp.anchor_set).toHaveLength(1);
    expect(stamp.anchor_set[0]!.anchorClass).toBe(AnchorClass.OWNER);
    expect(stamp.anchor_set[0]!.independenceWeight).toBe(0.9);
    expect(stamp.anchor_cost).toBe(0.9);
    expect(stamp.reputation).toBe(0); // earned, never born
    expect(stamp.stake_posted).toBe(0); // retired pillar: constant zero
    expect(repCapFor([...stamp.anchor_set])).toBe(0.98);
  });

  it("is idempotent: re-registering the owner never stacks anchors", () => {
    const registry = createTrustRegistry();
    const a = registry.registerOwner();
    const b = registry.registerOwner();
    expect(a.sourceId).toBe(b.sourceId);
    expect(registry.anchorsOf(a.sourceId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SSO — fleet collapse + the §4.1 calibration
// ---------------------------------------------------------------------------

describe("registerSsoMember", () => {
  it("FLEET COLLAPSE: two members of ONE tenant are NOT independent", () => {
    const registry = createTrustRegistry();
    const alice = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "acme",
    });
    const bob = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "bob",
      tenantId: "acme",
    });

    expect(alice.sourceId).not.toBe(bob.sourceId); // two people (sameness)…
    // …but one tenant: the shared operatorClassId is the fleet cap.
    expect(registry.independentSources(alice.sourceId, bob.sourceId)).toBe(false);
  });

  it("two DIFFERENT bare tenants are class-disjoint but weight-capped at 0.12", () => {
    const registry = createTrustRegistry();
    const acme = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "acme",
    });
    const globex = registry.registerSsoMember({
      issuer: "https://idp.globex.example",
      subject: "gus",
      tenantId: "globex",
    });

    // Class-disjoint (distinct member classes, distinct tenant fleets)…
    expect(registry.independentSources(acme.sourceId, globex.sourceId)).toBe(true);

    // …but a fresh tenant is near-free to mint, so the anchors carry only the
    // deliberately email-grade SSO_TENANT_MEMBER weight/ceiling.
    for (const ref of [acme, globex]) {
      const anchors = registry.anchorsOf(ref.sourceId);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.anchorClass).toBe(AnchorClass.SSO_TENANT_MEMBER);
      expect(anchors[0]!.independenceWeight).toBe(0.12);
      expect(repCapFor([...anchors])).toBe(0.3);
    }
  });

  it("a registry-CONFIGURED verified custom domain earns the DOMAIN binding", () => {
    const registry = createTrustRegistry({
      verifiedTenantDomains: { acme: "acme-corp.com" },
    });
    const alice = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "acme",
    });

    const classes = registry.anchorsOf(alice.sourceId).map((a) => a.anchorClass);
    expect(classes).toContain(AnchorClass.SSO_TENANT_MEMBER);
    expect(classes).toContain(AnchorClass.DOMAIN);

    const domain = registry
      .anchorsOf(alice.sourceId)
      .find((a) => a.anchorClass === AnchorClass.DOMAIN)!;
    expect(domain.independenceWeight).toBe(
      ANCHOR_TABLE[AnchorClass.DOMAIN].independenceWeight,
    );
    // The tenant's ceiling is now DOMAIN's, not bare membership's.
    expect(repCapFor([...registry.anchorsOf(alice.sourceId)])).toBe(0.6);
  });

  it("FAIL-CLOSED: a caller hint without (or contradicting) config grants no DOMAIN", () => {
    // No config entry: the hint alone grants nothing.
    const bare = createTrustRegistry();
    const a = bare.registerSsoMember({
      issuer: "https://idp.evil.example",
      subject: "mallory",
      tenantId: "evil",
      verifiedCustomDomain: "totally-real.com",
    });
    expect(
      bare.anchorsOf(a.sourceId).map((x) => x.anchorClass),
    ).toEqual([AnchorClass.SSO_TENANT_MEMBER]);

    // Config entry present but the hint contradicts it: still nothing.
    const configured = createTrustRegistry({
      verifiedTenantDomains: { acme: "acme-corp.com" },
    });
    const b = configured.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "acme",
      verifiedCustomDomain: "other-domain.com",
    });
    expect(
      configured.anchorsOf(b.sourceId).map((x) => x.anchorClass),
    ).toEqual([AnchorClass.SSO_TENANT_MEMBER]);
  });

  it("same-tenant members stay NOT independent even with a verified custom domain", () => {
    const registry = createTrustRegistry({
      verifiedTenantDomains: { acme: "acme-corp.com" },
    });
    const alice = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "alice",
      tenantId: "acme",
    });
    const bob = registry.registerSsoMember({
      issuer: "https://idp.acme.example",
      subject: "bob",
      tenantId: "acme",
    });
    // Shared tenant fleet AND shared DOMAIN class: collapse on both axes.
    expect(registry.independentSources(alice.sourceId, bob.sourceId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PUBLISHER — collapse by eTLD+1 + the tracked-tenure upgrade
// ---------------------------------------------------------------------------

describe("registerPublisher", () => {
  it("PUBLISHER COLLAPSE: N URLs under one eTLD+1 are ONE source, ONE class", () => {
    const registry = createTrustRegistry();
    const a = registry.registerPublisher("https://news.example.com/story-1");
    const b = registry.registerPublisher("https://blog.example.com/post?id=2");
    const c = registry.registerPublisher("example.com");

    expect(a.sourceId).toBe(b.sourceId);
    expect(b.sourceId).toBe(c.sourceId);
    expect(a.label).toBe("example.com");
    // Idempotent claim dedupe: one binding, not three.
    expect(registry.anchorsOf(a.sourceId)).toHaveLength(1);
  });

  it("defaults to PUBLISHER_UNVERIFIED (0.04/0.10) — 'some page said so'", () => {
    const registry = createTrustRegistry();
    const ref = registry.registerPublisher("https://random-blog.net/claim");
    const anchors = registry.anchorsOf(ref.sourceId);
    expect(anchors[0]!.anchorClass).toBe(AnchorClass.PUBLISHER_UNVERIFIED);
    expect(anchors[0]!.independenceWeight).toBe(0.04);
    expect(repCapFor([...anchors])).toBe(0.1);
  });

  it("upgrades a config-listed eTLD+1 to PUBLISHER_TRACKED (0.18/0.35)", () => {
    const registry = createTrustRegistry({
      // Entries normalize through the PSL resolver, so a URL form works too.
      trackedPublishers: ["https://www.reuters.com"],
    });
    const ref = registry.registerPublisher("https://reuters.com/markets/story");
    const anchors = registry.anchorsOf(ref.sourceId);
    expect(anchors[0]!.anchorClass).toBe(AnchorClass.PUBLISHER_TRACKED);
    expect(anchors[0]!.independenceWeight).toBe(0.18);
    // Deliberately BELOW DOMAIN's 0.60 ceiling.
    expect(repCapFor([...anchors])).toBe(0.35);
  });

  it("fails closed on an unresolvable host", () => {
    const registry = createTrustRegistry();
    expect(() => registry.registerPublisher("")).toThrow(RangeError);
    expect(() => registry.registerPublisher("   ")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_OF_RECORD — the enterprise tier's configured authority
// ---------------------------------------------------------------------------

describe("registerSystemOfRecord", () => {
  it("binds at authority grade, keyed by configured name", () => {
    const registry = createTrustRegistry();
    const workday = registry.registerSystemOfRecord({
      name: "workday-hr",
      authorityLabel: "Workday (HR system of record)",
    });

    expect(workday.kind).toBe("SYSTEM_OF_RECORD");
    expect(workday.label).toBe("Workday (HR system of record)");

    const anchors = registry.anchorsOf(workday.sourceId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.anchorClass).toBe(AnchorClass.SYSTEM_OF_RECORD);
    expect(anchors[0]!.independenceWeight).toBe(0.9);
    expect(repCapFor([...anchors])).toBe(0.98);
  });

  it("two different systems are independent; the same name is one source", () => {
    const registry = createTrustRegistry();
    const hr = registry.registerSystemOfRecord({ name: "workday-hr" });
    const erp = registry.registerSystemOfRecord({ name: "sap-erp" });
    const hrAgain = registry.registerSystemOfRecord({ name: "workday-hr" });

    expect(hr.sourceId).toBe(hrAgain.sourceId);
    expect(registry.anchorsOf(hr.sourceId)).toHaveLength(1); // idempotent
    expect(registry.independentSources(hr.sourceId, erp.sourceId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed independence for claim-less sources
// ---------------------------------------------------------------------------

describe("independence fail-closed", () => {
  it("a bare registration (no claim producer) is never independent of anything", () => {
    const registry = createTrustRegistry();
    const owner = registry.registerOwner();
    const bare = { sourceId: sourceIdFor("manual", "mystery"), kind: "OTHER" } as const;
    registry.register(bare);

    expect(registry.has(bare.sourceId)).toBe(true);
    expect(registry.independentSources(bare.sourceId, owner.sourceId)).toBe(false);
    expect(registry.independentSources(owner.sourceId, bare.sourceId)).toBe(false);
  });

  it("an unregistered source id fails closed at the facade too (RC-5)", () => {
    const registry = createTrustRegistry();
    const identity = layerOver(registry);
    const owner = registry.registerOwner();
    const ghost = sourceIdFor("nowhere", "nobody") as SourceId;

    expect(identity.independentSources(owner.sourceId, ghost)).toBe(false);
  });

  it("owner vs a genuinely different root (system of record) IS independent", () => {
    // Anti-over-strictness (the owner's explicit concern): genuinely disjoint
    // configured roots must still corroborate.
    const registry = createTrustRegistry();
    const owner = registry.registerOwner();
    const sor = registry.registerSystemOfRecord({ name: "workday-hr" });
    expect(registry.independentSources(owner.sourceId, sor.sourceId)).toBe(true);
  });
});
