/**
 * anchorRegistry.test.ts — the REAL fleet-capped AnchorRegistry invariants.
 *
 * Exercises the registry wired to real binders (with mocked prover ports) and the
 * SourceIdentityLayer / independentRootCount, asserting:
 *   - a DOMAIN-bound source earns DOMAIN independence (0.35) + rep_cap 0.60.
 *   - FLEET CAP: N different-domain / same-registrar sources collapse to ~1;
 *     N different-registrar sources count as N.
 *   - EXPIRY: a past-notAfter attestation stops counting ⇒ BARE_KEY (independence
 *     0, repCap 0.05).
 *   - FAIL-CLOSED: an unbound source is BARE_KEY weight 0.
 *   - a FORGED attestation is rejected on ingest.
 *   - an EMAIL-bound source earns 0.10 / rep_cap 0.30.
 */

import { describe, it, expect } from "vitest";

import {
  AnchorClass,
  asEpochMs,
  generatePassport,
  createAnchorRegistry,
  createDomainBinder,
  createEmailBinder,
  createSourceIdentityLayer,
  createStakeLedger,
  repCapFor,
  signAttestation,
} from "../../index.js";
import type {
  SourceId,
  EpochMs,
  KeyPair,
  Unit,
  Passport,
  AnchorBinding,
  AnchorAttestation,
  ProvenanceRoot,
  DomainProofChecker,
  RegistrarLookup,
  ETldResolver,
  EmailConfirmationPort,
  OperatorClassId,
  KeyRegistryPort,
  ReputationLedgerPort,
  StakeLedgerPort,
  SourceIdentityLayer,
  AnchorRegistry,
} from "../../index.js";

// --- mock prover ports ------------------------------------------------------

const passChecker: DomainProofChecker = { check: () => true };
const etld: ETldResolver = {
  registrableDomain: (d) => d.split(".").slice(-2).join("."),
};
function registrarFor(map: Record<string, string>): RegistrarLookup {
  return {
    operatorOf: (d) => (map[d] ?? ("registrar:" + d)) as OperatorClassId,
  };
}
const passConfirm: EmailConfirmationPort = { confirm: () => true };

// --- pillar ports for the facade --------------------------------------------

function makeKeyRegistry(): KeyRegistryPort {
  const known = new Set<SourceId>();
  return {
    register: (p) => void known.add(p.sourceId),
    sourceIdOf: (s) => (known.has(s) ? s : null),
    has: (s) => known.has(s),
  };
}
const fixedReputation: ReputationLedgerPort = { scoreOf: () => 0 as Unit };
function makeStakePort(): StakeLedgerPort {
  const l = createStakeLedger();
  return { postedFor: (s) => l.posted(s) };
}

/** A mutable clock so tests can advance past expiry. */
function clock(start: number): { now: () => EpochMs; set: (t: number) => void } {
  let t = start;
  return { now: () => asEpochMs(t), set: (x) => (t = x) };
}

function root(idRaw: string, cls: string, sourceId: SourceId): ProvenanceRoot {
  return {
    rootId: idRaw as ProvenanceRoot["rootId"],
    independenceClass: cls as ProvenanceRoot["independenceClass"],
    sourceId,
    establishedAt: asEpochMs(0),
  };
}

/** Wire a layer over the real registry. */
function layerOver(registry: AnchorRegistry): SourceIdentityLayer {
  return createSourceIdentityLayer({
    keys: makeKeyRegistry(),
    anchors: registry,
    reputation: fixedReputation,
    stake: makeStakePort(),
  });
}

const T0 = 1_700_000_000_000;

/** Bind a DOMAIN attestation for `sourceId` and ingest it. */
function bindDomain(
  registry: AnchorRegistry,
  verifier: KeyPair,
  registrar: RegistrarLookup,
  sourceId: SourceId,
  domain: string,
  now: EpochMs,
): void {
  const binder = createDomainBinder({
    verifier,
    checker: passChecker,
    registrar,
    etld,
    anchorSalt: "salt",
  });
  const ch = binder.challenge(sourceId, now);
  const att = binder.bind(sourceId, { root: domain, nonce: ch.nonce }, now);
  const ok = registry.ingest(att as AnchorAttestation, now);
  expect(ok).toBe(true);
}

describe("AnchorRegistry — DOMAIN binding earns independence", () => {
  it("a domain-bound source contributes 0.35 independence and rep_cap 0.60", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const layer = layerOver(registry);

    const a = "src:a" as SourceId;
    const b = "src:b" as SourceId;
    bindDomain(registry, verifier, registrarFor({}), a, "alpha.com", c.now());
    bindDomain(registry, verifier, registrarFor({}), b, "beta.org", c.now());

    // anchorsOf projects a real DOMAIN binding.
    const aAnchors = registry.anchorsOf(a) as AnchorBinding[];
    expect(aAnchors.length).toBe(1);
    expect(aAnchors[0]!.anchorClass).toBe(AnchorClass.DOMAIN);
    expect(repCapFor(aAnchors)).toBeCloseTo(0.6, 5);

    // The list-based anchor-set math cannot distinguish two DOMAIN sources (they
    // share the DOMAIN anchor CLASS), so it reports 0 — which is exactly why the
    // registry exposes the SOURCE-AWARE predicate that sees the per-anchor classId
    // (different domains) + operatorClassId (different registrars) axes.
    const listPair = registry.independenceBetween(aAnchors, registry.anchorsOf(b));
    expect(listPair).toBe(0);

    // The realized per-binding weight a single DOMAIN anchor carries is 0.35.
    expect(aAnchors[0]!.independenceWeight).toBeCloseTo(0.35, 5);

    // Source-aware predicate says independent (different domains + registrars);
    // the count is 2.
    expect(registry.independentSources!(a, b)).toBe(true);
    const cnt = layer.independentRootCount([
      root("r:a", "class:a", a),
      root("r:b", "class:b", b),
    ]);
    expect(cnt).toBe(2);
  });
});

describe("AnchorRegistry — FLEET CAP", () => {
  it("N different-domain sources behind ONE registrar collapse to ~1", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const layer = layerOver(registry);

    // Every domain resolves to the SAME registrar operator class.
    const oneRegistrar: RegistrarLookup = {
      operatorOf: () => "registrar:MEGACORP" as OperatorClassId,
    };
    const N = 6;
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < N; i++) {
      const s = ("src:fleet:" + i) as SourceId;
      bindDomain(registry, verifier, oneRegistrar, s, "d" + i + ".com", c.now());
      roots.push(root("r:" + i, "class:" + i, s));
    }
    // Distinct domains (different classId) but ONE operator ⇒ pairwise correlated.
    expect(registry.independentSources!("src:fleet:0" as SourceId, "src:fleet:1" as SourceId)).toBe(false);
    expect(layer.independentRootCount(roots)).toBe(1);
  });

  it("N sources behind N DIFFERENT registrars count as N", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const layer = layerOver(registry);

    const N = 5;
    const roots: ProvenanceRoot[] = [];
    for (let i = 0; i < N; i++) {
      const s = ("src:ind:" + i) as SourceId;
      // Each domain → its own distinct registrar operator class.
      const reg: RegistrarLookup = {
        operatorOf: () => ("registrar:" + i) as OperatorClassId,
      };
      bindDomain(registry, verifier, reg, s, "site" + i + ".com", c.now());
      roots.push(root("r:" + i, "class:" + i, s));
    }
    expect(layer.independentRootCount(roots)).toBe(N);
  });
});

describe("AnchorRegistry — EXPIRY reverts to BARE_KEY", () => {
  it("a past-notAfter attestation stops counting ⇒ independence 0, repCap 0.05", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });

    const a = "src:a" as SourceId;
    const b = "src:b" as SourceId;
    // Short-TTL attestations.
    const binderA = createDomainBinder({
      verifier,
      checker: passChecker,
      registrar: registrarFor({}),
      etld,
      anchorSalt: "s",
      attestationTtlMs: 1000,
    });
    const chA = binderA.challenge(a, c.now());
    registry.ingest(
      binderA.bind(a, { root: "a.com", nonce: chA.nonce }, c.now()) as AnchorAttestation,
      c.now(),
    );
    bindDomain(registry, verifier, registrarFor({}), b, "b.org", c.now());

    // Before expiry: a has a DOMAIN anchor.
    expect(registry.anchorsOf(a).length).toBe(1);
    expect(registry.independentSources!(a, b)).toBe(true);

    // Advance past A's notAfter.
    c.set(T0 + 2000);
    // A's attestation dropped ⇒ BARE_KEY.
    expect(registry.anchorsOf(a).length).toBe(0);
    expect(repCapFor(registry.anchorsOf(a) as AnchorBinding[])).toBeCloseTo(0.05, 5);
    // Fail-closed: a BARE_KEY side is never independent.
    expect(registry.independentSources!(a, b)).toBe(false);
  });
});

describe("AnchorRegistry — FAIL-CLOSED + forged rejection", () => {
  it("an unbound source is BARE_KEY weight 0 and never independent", () => {
    const verifier: KeyPair = generatePassport();
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => asEpochMs(T0),
    });
    const a = "src:unbound" as SourceId;
    const b = "src:also-unbound" as SourceId;
    expect(registry.anchorsOf(a).length).toBe(0);
    expect(repCapFor(registry.anchorsOf(a) as AnchorBinding[])).toBeCloseTo(0.05, 5);
    expect(registry.independentSources!(a, b)).toBe(false);
  });

  it("a FORGED attestation is rejected on ingest (wrong signer)", () => {
    const verifier: KeyPair = generatePassport();
    const impostor: KeyPair = generatePassport();
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: () => asEpochMs(T0),
    });
    const a = "src:f" as SourceId;
    // Sign with the IMPOSTOR key — not the registry's verifier.
    const forged = signAttestation(
      {
        sourceId: a,
        anchorType: AnchorClass.DOMAIN,
        anchorId: "x",
        operatorClassId: "r:1" as OperatorClassId,
        proofRef: "p",
        weight: 0.35,
        classId: "a.com" as unknown as AnchorAttestation["classId"],
        notBefore: asEpochMs(T0),
        notAfter: asEpochMs(T0 + 1_000_000),
      },
      impostor,
    );
    expect(registry.ingest(forged, asEpochMs(T0))).toBe(false);
    expect(registry.anchorsOf(a).length).toBe(0);

    // A TAMPERED genuine attestation is also rejected.
    const genuine = signAttestation(
      {
        sourceId: a,
        anchorType: AnchorClass.DOMAIN,
        anchorId: "x",
        operatorClassId: "r:1" as OperatorClassId,
        proofRef: "p",
        weight: 0.35,
        classId: "a.com" as unknown as AnchorAttestation["classId"],
        notBefore: asEpochMs(T0),
        notAfter: asEpochMs(T0 + 1_000_000),
      },
      verifier,
    );
    const tampered: AnchorAttestation = { ...genuine, weight: 0.9 };
    expect(registry.ingest(tampered, asEpochMs(T0))).toBe(false);
  });
});

describe("AnchorRegistry — EMAIL binding", () => {
  it("an email-bound source earns 0.10 / rep_cap 0.30", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const binder = createEmailBinder({
      verifier,
      confirmation: passConfirm,
      anchorSalt: "s",
    });
    const a = "src:e" as SourceId;
    const ch = binder.challenge(a, c.now());
    registry.ingest(
      binder.bind(a, { root: "a@mail.com", nonce: ch.nonce }, c.now()) as AnchorAttestation,
      c.now(),
    );
    const anchors = registry.anchorsOf(a) as AnchorBinding[];
    expect(anchors.length).toBe(1);
    expect(anchors[0]!.anchorClass).toBe(AnchorClass.EMAIL_OAUTH);
    expect(anchors[0]!.independenceWeight).toBeCloseTo(0.1, 5);
    expect(repCapFor(anchors)).toBeCloseTo(0.3, 5);
  });

  it("qualifiesForHighRepCap requires ≥2 distinct anchor types on one source", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const a = "src:multi" as SourceId;
    // One DOMAIN only ⇒ does not qualify.
    bindDomain(registry, verifier, registrarFor({}), a, "a.com", c.now());
    expect(registry.qualifiesForHighRepCap(a)).toBe(false);
    // Add an EMAIL ⇒ now ≥2 distinct types.
    const eb = createEmailBinder({ verifier, confirmation: passConfirm, anchorSalt: "s" });
    const ch = eb.challenge(a, c.now());
    registry.ingest(
      eb.bind(a, { root: "a@mail.com", nonce: ch.nonce }, c.now()) as AnchorAttestation,
      c.now(),
    );
    expect(registry.qualifiesForHighRepCap(a)).toBe(true);
  });

  it("the source layer stampFor reflects the bound anchor cost (not BARE_KEY)", () => {
    const verifier: KeyPair = generatePassport();
    const c = clock(T0);
    const registry = createAnchorRegistry({
      verifierPublicKeyPem: verifier.publicKeyPem,
      now: c.now,
    });
    const layer = layerOver(registry);
    const a = "src:stamp" as SourceId;
    const passport: Passport = { sourceId: a, publicKeyPem: "pem:" + a };
    layer.register(passport, []); // registers + no direct anchors
    bindDomain(registry, verifier, registrarFor({}), a, "a.com", c.now());
    const stamp = layer.stampFor(a);
    expect(stamp.anchor_set.length).toBe(1);
    expect(stamp.anchor_cost).toBeCloseTo(0.35, 5);
  });
});
