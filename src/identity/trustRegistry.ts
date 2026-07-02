/**
 * identity/trustRegistry.ts — THE CRYPTO-FREE TRUST REGISTRY (the claim producers
 * behind the Source-Identity Layer, replacing the key registry AND the anchor
 * registry of the attestation era).
 *
 * Design of record: docs/launch/CRYPTO_FREE_IDENTITY_DESIGN.md (§3 "what is
 * removed and why it's safe", §4.1 the tier lattice, §5 operational reality),
 * amended by the owner's two-tier deployment model:
 *
 *   PERSONAL (mom-and-pop): the OWNER is the trust root. `registerOwner()` is
 *   the whole identity story — no accounts, no IdP, nothing to configure.
 *
 *   ENTERPRISE: identity is CONSUMED from the company's IdP/SSO and a configured
 *   source-of-truth registry. `registerSsoMember` maps an already-verified IdP
 *   claim (the OIDC `sub` / SAML `NameID` an auth middleware checked before this
 *   code runs) onto anchors; `registerSystemOfRecord` maps a configured
 *   authoritative system (Workday-for-HR, the ERP, …). This codebase
 *   MANUFACTURES nothing — it prices claims supplied by infrastructure it does
 *   not own.
 *
 * ── THE SWAPPABLE TRUST ROOT ─────────────────────────────────────────────────
 * {@link TrustRegistryConfig} IS the deployment's security policy — the same
 * "one swappable trust root" role CLAUDE.md assigns the anchor-cost table.
 * Which publishers count as tenured (`trackedPublishers`), which SSO tenants
 * have earned DOMAIN-grade weight (`verifiedTenantDomains`), and how publisher
 * fleets collapse (`operatorOf`) are all plain configured data. Changing this
 * config IS changing the security policy; that is the intended knob, not a wall.
 *
 * What each producer prices (weights pinned in identity/anchors.ts's table):
 *   - `registerOwner`            → OWNER (0.90/0.98) — the personal tier's
 *     ground truth, external-authority grade.
 *   - `registerSsoMember`        → SSO_TENANT_MEMBER (0.12/0.30) — DELIBERATELY
 *     email-grade: a fresh SSO tenant is a five-minute, near-free, self-service
 *     mint (design doc §4.1's calibration correction), so bare membership must
 *     never approach ORGANIZATION weight. A tenant with a registry-CONFIGURED
 *     verified custom domain ADDITIONALLY binds DOMAIN (0.35/0.60) — the
 *     config asserts the claim; this codebase no longer proves it.
 *   - `registerPublisher`        → PUBLISHER_TRACKED (0.18/0.35) when the
 *     eTLD+1 is config-listed as tenured, else PUBLISHER_UNVERIFIED (0.04/0.10).
 *     N URLs under one eTLD+1 collapse to ONE source and ONE class.
 *   - `registerSystemOfRecord`   → SYSTEM_OF_RECORD (0.90/0.98) — the
 *     enterprise tier's configured authoritative system.
 *
 * ── FLEET CAP PRESERVED EXACTLY ──────────────────────────────────────────────
 * `independentSources(a, b)` keeps the attestation-era registry's semantics
 * verbatim, minus signatures/expiry: two sources sharing ANY per-anchor
 * `classId` (same eTLD+1 / same owner / same system) are not independent on
 * that axis, and two sources sharing ANY `operatorClassId` (same SSO tenant,
 * same publisher operator cluster) are NOT independent even with different
 * class ids — so one tenant's N members/agents, or one operator's N syndicated
 * domains, collapse toward ONE independence class. FAIL-CLOSED: a source with
 * no producer-minted claim (a bare registration, or one bound only via the raw
 * port `bind`) is BARE-equivalent and never independent of anything.
 *
 * Attribution replaces stake: facts are permanently attributed to the named
 * source a claim producer registered — that attribution (plus the disown sweep)
 * IS the deterrent; no deposit machinery exists here.
 *
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`
 * (`import type`); zero runtime deps (node: builtins only, via sources.ts).
 */

import {
  AnchorClass,
  type SourceId,
  type AnchorBinding,
  type IndependenceClassId,
  type OperatorClassId,
  type Unit,
} from "../core/types.js";
import {
  ANCHOR_TABLE,
  aggregateAnchorCost,
  independenceBetween as anchorsIndependenceBetween,
} from "./anchors.js";
import { pslResolver } from "./binders/publicSuffix.js";
import { sourceIdFor, type SourceRef } from "./sources.js";
import type {
  SourceRegistryPort,
  AnchorRegistryPort,
} from "./index.js";

// ---------------------------------------------------------------------------
// Config — the swappable trust root
// ---------------------------------------------------------------------------

/**
 * The deployment's trust policy, as plain data. THIS is the swappable trust
 * root (see the module header): what the deployment trusts, and how much, is
 * configured here — never proven, signed, or manufactured by this codebase.
 *
 * All fields optional: the empty config is the PERSONAL preset (owner-only
 * ground truth; every publisher unverified; no verified tenant domains).
 */
export interface TrustRegistryConfig {
  /**
   * eTLD+1s (or URLs/hosts — normalized through the PSL resolver) of publishers
   * with earned tenure. A `registerPublisher` URL whose eTLD+1 is listed binds
   * PUBLISHER_TRACKED (0.18/0.35); anything else binds PUBLISHER_UNVERIFIED
   * (0.04/0.10). Deliberately capped BELOW DOMAIN's 0.60 repCap: a publisher,
   * however tenured, stays structurally weaker than a controlled domain.
   */
  readonly trackedPublishers?: readonly string[];
  /**
   * tenantId → the tenant's VERIFIED custom domain. An SSO member of a listed
   * tenant additionally binds DOMAIN with `classId = eTLD+1(domain)` — the
   * config-asserted claim that lifts a tenant above bare (email-grade)
   * membership. FAIL-CLOSED: a caller-supplied `verifiedCustomDomain` that is
   * absent from — or contradicts — this map grants nothing.
   */
  readonly verifiedTenantDomains?: Readonly<Record<string, string>>;
  /**
   * Operator-cluster hook (the FLEET axis for publishers): maps an eTLD+1 to
   * its operator class (ownership cluster / syndication network), so N domains
   * behind one operator collapse toward one independence class. Defaults to
   * identity (each eTLD+1 is its own operator).
   */
  readonly operatorOf?: (etld1: string) => string;
}

// ---------------------------------------------------------------------------
// Producer inputs + the registry surface
// ---------------------------------------------------------------------------

/** Input to {@link TrustRegistry.registerSsoMember}. */
export interface SsoMemberInput {
  /** The IdP issuer (OIDC `iss` / SAML entity id) — namespaces the subject. */
  readonly issuer: string;
  /** The already-verified subject claim (OIDC `sub` / SAML `NameID`). */
  readonly subject: string;
  /** The IdP tenant/org id — the FLEET axis one tenant's members collapse on. */
  readonly tenantId: string;
  /**
   * Optional caller-supplied hint of the tenant's verified custom domain.
   * NEVER load-bearing on its own: the DOMAIN binding is granted only when the
   * registry config's `verifiedTenantDomains` lists this tenant, and a hint
   * that contradicts the configured domain grants nothing (fail-closed).
   */
  readonly verifiedCustomDomain?: string;
  /** Optional human-readable label for citations / audit trails. */
  readonly label?: string;
}

/** Input to {@link TrustRegistry.registerSystemOfRecord}. */
export interface SystemOfRecordInput {
  /** The configured system's stable name (e.g. "workday-hr"). */
  readonly name: string;
  /** Optional human-readable label (defaults to `name`). */
  readonly authorityLabel?: string;
}

/**
 * The crypto-free trust registry: ONE object satisfying both facade ports —
 * the source registry (sameness: register/has) AND the anchor registry
 * (independence: anchorsOf / independenceBetween / the fleet-capped
 * `independentSources`) — plus the four claim producers described in the
 * module header. Wire a single instance into BOTH
 * `SourceIdentityLayerDeps.sources` and `.anchors`.
 */
export interface TrustRegistry extends SourceRegistryPort, AnchorRegistryPort {
  /** PERSONAL tier: register the deployment OWNER — the configured ground truth. */
  registerOwner(label?: string): SourceRef;
  /** ENTERPRISE tier: register an IdP-verified SSO tenant member (or agent). */
  registerSsoMember(input: SsoMemberInput): SourceRef;
  /** Research tier: register fetched web content by its publisher eTLD+1. */
  registerPublisher(url: string): SourceRef;
  /** ENTERPRISE tier: register a configured authoritative system of record. */
  registerSystemOfRecord(input: SystemOfRecordInput): SourceRef;
  /** The source-aware fleet-cap independence predicate (REQUIRED here). */
  independentSources(a: SourceId, b: SourceId): boolean;
  /**
   * The {@link SourceRef} a registered source presented at the door, or `null` if
   * the id was never registered. PURELY DESCRIPTIVE metadata (kind + label) for
   * citations, audit trails, and the PHASE-4 pending-question rendering — trust
   * NEVER derives from it (trust derives from the anchors the producers bound).
   */
  refOf(sourceId: SourceId): SourceRef | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** One producer-minted claim: an anchor plus its two independence axes. */
interface ClaimAxis {
  readonly anchorClass: AnchorClass;
  /** The per-anchor disjointness axis (eTLD+1 / owner id / system name / member). */
  readonly classId: IndependenceClassId;
  /** The FLEET axis (SSO tenant / operator cluster / same-as-classId). */
  readonly operatorClassId: OperatorClassId;
  /** Realized independence weight (the anchor table's row weight). */
  readonly weight: Unit;
}

class CryptoFreeTrustRegistry implements TrustRegistry {
  readonly #config: TrustRegistryConfig;
  /** Normalized (eTLD+1, lowercased) tenured-publisher set from the config. */
  readonly #tracked: ReadonlySet<string>;
  /** sourceId → the SourceRef presented at the border (has() ⇒ registered). */
  readonly #known = new Map<SourceId, SourceRef>();
  /** sourceId → producer-minted claims (the ONLY feed of `independentSources`). */
  readonly #claims = new Map<SourceId, ClaimAxis[]>();
  /** sourceId → bindings injected via the raw port `bind` (legacy/manual path).
   * Deliberately axis-less: they contribute to the stamp (anchorsOf/cost) but
   * NEVER to the source-aware independence predicate — same fail-closed
   * semantics the attestation-era registry gave its direct-bind path. */
  readonly #directBindings = new Map<SourceId, AnchorBinding[]>();

  constructor(config?: TrustRegistryConfig) {
    this.#config = config ?? {};
    const tracked = new Set<string>();
    for (const entry of this.#config.trackedPublishers ?? []) {
      const etld1 = publisherEtld1(entry);
      if (etld1.length > 0) tracked.add(etld1);
    }
    this.#tracked = tracked;
  }

  // ---- SourceRegistryPort (sameness) ---------------------------------------

  register(source: SourceRef): void {
    // Idempotent on sourceId; the first-presented ref wins (a re-register can
    // never silently relabel an existing source).
    if (!this.#known.has(source.sourceId)) {
      this.#known.set(source.sourceId, source);
    }
  }

  sourceIdOf(sourceId: SourceId): SourceId | null {
    return this.#known.has(sourceId) ? sourceId : null;
  }

  has(sourceId: SourceId): boolean {
    return this.#known.has(sourceId);
  }

  refOf(sourceId: SourceId): SourceRef | null {
    return this.#known.get(sourceId) ?? null;
  }

  // ---- claim producers ------------------------------------------------------

  registerOwner(label?: string): SourceRef {
    const subject = label ?? "owner";
    const sourceId = sourceIdFor("iddb:owner", subject);
    const ref: SourceRef = { sourceId, kind: "OWNER", label: subject };
    this.register(ref);
    // The owner IS its own independence class and its own fleet: classId and
    // operatorClassId are both the owner source id.
    this.#addClaim(sourceId, {
      anchorClass: AnchorClass.OWNER,
      classId: String(sourceId) as IndependenceClassId,
      operatorClassId: String(sourceId) as OperatorClassId,
      weight: ANCHOR_TABLE[AnchorClass.OWNER].independenceWeight,
    });
    return this.#known.get(sourceId) ?? ref;
  }

  registerSsoMember(input: SsoMemberInput): SourceRef {
    const sourceId = sourceIdFor(input.issuer, input.subject);
    const ref: SourceRef = {
      sourceId,
      kind: "SSO",
      label: input.label ?? input.subject,
    };
    this.register(ref);

    // Bare membership: classId per SUBJECT (two members are class-disjoint),
    // operatorClassId per TENANT (…but one tenant's members/agents collapse on
    // the fleet axis — the owner's "normal everyday folks are within the same
    // SSO" framing, and the §4.1 calibration: email-grade weight, nothing more).
    this.#addClaim(sourceId, {
      anchorClass: AnchorClass.SSO_TENANT_MEMBER,
      classId: ("sso-member:" + String(sourceId)) as IndependenceClassId,
      operatorClassId: ("sso-tenant:" + input.tenantId) as OperatorClassId,
      weight: ANCHOR_TABLE[AnchorClass.SSO_TENANT_MEMBER].independenceWeight,
    });

    // Verified-custom-domain lift: granted ONLY when the registry CONFIG lists
    // the tenant (the config asserts the claim; a caller-supplied hint that is
    // unconfigured or contradicts the config grants nothing — fail-closed).
    const configured = this.#config.verifiedTenantDomains?.[input.tenantId];
    if (configured !== undefined) {
      const etld1 = publisherEtld1(configured);
      const hint =
        input.verifiedCustomDomain !== undefined
          ? publisherEtld1(input.verifiedCustomDomain)
          : etld1;
      if (etld1.length > 0 && hint === etld1) {
        this.#addClaim(sourceId, {
          anchorClass: AnchorClass.DOMAIN,
          classId: etld1 as IndependenceClassId,
          operatorClassId: this.#operatorOf(etld1),
          weight: ANCHOR_TABLE[AnchorClass.DOMAIN].independenceWeight,
        });
      }
    }
    return this.#known.get(sourceId) ?? ref;
  }

  registerPublisher(url: string): SourceRef {
    const etld1 = publisherEtld1(url);
    if (etld1.length === 0) {
      // Fail-closed: an unresolvable host must never mint a source.
      throw new RangeError(
        `TrustRegistry.registerPublisher: no registrable domain in ${JSON.stringify(url)}`,
      );
    }
    // ONE source per eTLD+1: N URLs under one publisher collapse to one witness.
    const sourceId = sourceIdFor("publisher", etld1);
    const ref: SourceRef = { sourceId, kind: "PUBLISHER", label: etld1 };
    this.register(ref);

    const tracked = this.#tracked.has(etld1);
    const anchorClass = tracked
      ? AnchorClass.PUBLISHER_TRACKED
      : AnchorClass.PUBLISHER_UNVERIFIED;
    this.#addClaim(sourceId, {
      anchorClass,
      classId: etld1 as IndependenceClassId,
      operatorClassId: this.#operatorOf(etld1),
      weight: ANCHOR_TABLE[anchorClass].independenceWeight,
    });
    return this.#known.get(sourceId) ?? ref;
  }

  registerSystemOfRecord(input: SystemOfRecordInput): SourceRef {
    const sourceId = sourceIdFor("system-of-record", input.name);
    const ref: SourceRef = {
      sourceId,
      kind: "SYSTEM_OF_RECORD",
      label: input.authorityLabel ?? input.name,
    };
    this.register(ref);
    // The configured system is its own class and its own fleet, keyed by name.
    this.#addClaim(sourceId, {
      anchorClass: AnchorClass.SYSTEM_OF_RECORD,
      classId: input.name as IndependenceClassId,
      operatorClassId: input.name as OperatorClassId,
      weight: ANCHOR_TABLE[AnchorClass.SYSTEM_OF_RECORD].independenceWeight,
    });
    return this.#known.get(sourceId) ?? ref;
  }

  // ---- AnchorRegistryPort (independence) -------------------------------------

  /**
   * Direct bind path (legacy/manual bindings, and registering a source with no
   * claim yet). Additive; the production path is the claim producers above.
   */
  bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void {
    if (anchors.length === 0) {
      if (!this.#directBindings.has(sourceId)) {
        this.#directBindings.set(sourceId, []);
      }
      return;
    }
    const prev = this.#directBindings.get(sourceId) ?? [];
    this.#directBindings.set(sourceId, [...prev, ...anchors]);
  }

  /**
   * The CLEAN projected anchor set: one {@link AnchorBinding} per producer
   * claim (plus any directly-bound bindings). NO synthetic fleet axis leaks
   * here, so `aggregateCost` / `repCapFor` / the stamp see only real anchors.
   */
  anchorsOf(sourceId: SourceId): readonly AnchorBinding[] {
    const out: AnchorBinding[] = [];
    for (const claim of this.#claims.get(sourceId) ?? []) {
      out.push({
        anchorClass: claim.anchorClass,
        realizedCost: claim.weight,
        independenceWeight: claim.weight,
      });
    }
    const direct = this.#directBindings.get(sourceId);
    if (direct !== undefined) out.push(...direct);
    return out;
  }

  aggregateCost(anchors: readonly AnchorBinding[]): Unit {
    return aggregateAnchorCost(anchors);
  }

  independenceBetween(
    a: readonly AnchorBinding[],
    b: readonly AnchorBinding[],
  ): Unit {
    // Reuse the anchor-cost disjointness math verbatim (identity/anchors.ts).
    return anchorsIndependenceBetween([...a], [...b]);
  }

  // ---- the FLEET CAP ---------------------------------------------------------

  /**
   * Source-aware independence (preferred by `independentRootCount` and RC-5).
   * Semantics preserved EXACTLY from the attestation-era registry, minus
   * signatures/expiry:
   *
   *  - A source with no producer-minted claim is BARE-equivalent ⇒ never
   *    independent (fail-closed; weight 0).
   *  - Sharing ANY `operatorClassId` (same SSO tenant, same publisher operator
   *    cluster) ⇒ NOT independent — a flood of N sources behind one operator is
   *    pairwise-correlated, so the max-independent-set collapses to 1.
   *  - Otherwise independence requires a per-anchor `classId` on each side the
   *    other does not share, carrying positive weight (a genuinely disjoint
   *    costly root on BOTH sides).
   */
  independentSources(a: SourceId, b: SourceId): boolean {
    const aw = this.#claims.get(a) ?? [];
    const bw = this.#claims.get(b) ?? [];
    // Fail-closed: a claim-less (bare) side is never independent.
    if (aw.length === 0 || bw.length === 0) return false;

    const aOperators = new Set(aw.map((x) => x.operatorClassId));
    const bOperators = new Set(bw.map((x) => x.operatorClassId));
    const aClasses = new Set(aw.map((x) => x.classId));
    const bClasses = new Set(bw.map((x) => x.classId));

    // FLEET CAP: any shared operator class ⇒ correlated on that axis ⇒ not
    // independent. This is what collapses a same-tenant/same-operator fleet.
    for (const op of aOperators) {
      if (bOperators.has(op)) return false;
    }

    // Independence then requires a disjoint classId pair carrying weight —
    // at least one such disjoint anchor with positive weight on EACH side.
    const aDisjoint = aw.filter((x) => !bClasses.has(x.classId));
    const bDisjoint = bw.filter((x) => !aClasses.has(x.classId));
    if (aDisjoint.length === 0 || bDisjoint.length === 0) return false;
    const aHasWeight = aDisjoint.some((x) => x.weight > 0);
    const bHasWeight = bDisjoint.some((x) => x.weight > 0);
    return aHasWeight && bHasWeight;
  }

  // ---- internals --------------------------------------------------------------

  /** The configured operator cluster for an eTLD+1 (identity by default). */
  #operatorOf(etld1: string): OperatorClassId {
    const mapped = this.#config.operatorOf?.(etld1) ?? etld1;
    return mapped as OperatorClassId;
  }

  /** Add a claim, idempotently on (anchorClass, classId) — re-registering the
   * same identity never stacks duplicate anchors. */
  #addClaim(sourceId: SourceId, claim: ClaimAxis): void {
    const list = this.#claims.get(sourceId);
    if (list === undefined) {
      this.#claims.set(sourceId, [claim]);
      return;
    }
    const dup = list.some(
      (c) => c.anchorClass === claim.anchorClass && c.classId === claim.classId,
    );
    if (!dup) list.push(claim);
  }
}

/**
 * Normalize a URL / host / domain string to its registrable eTLD+1 (lowercased)
 * via the PSL resolver. Accepts full URLs (`https://a.example.com/p?q`), bare
 * hosts (`a.example.com`), and registrable names (`example.com`). Returns `""`
 * when no usable host can be extracted (the caller fails closed on that).
 */
function publisherEtld1(url: string): string {
  const raw = url.trim();
  if (raw.length === 0) return "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "";
  }
  if (host.length === 0) {
    // A bare host ("a.example.com") or host:port has no scheme — retry with one.
    // (An input like "host:8080" PARSES as a URL with scheme "host" and an empty
    // hostname, so the empty-hostname check — not only the catch — must fall
    // through to this retry.)
    try {
      host = new URL("http://" + raw).hostname;
    } catch {
      host = "";
    }
  }
  if (host.length === 0) return "";
  return pslResolver.registrableDomain(host).toLowerCase();
}

/**
 * Build the crypto-free {@link TrustRegistry}. Pass the deployment's
 * {@link TrustRegistryConfig} (the swappable trust root); omit it entirely for
 * the PERSONAL preset. Wire the ONE returned instance into BOTH
 * `SourceIdentityLayerDeps.sources` and `.anchors` so sameness and independence
 * read from the same book.
 */
export function createTrustRegistry(
  config?: TrustRegistryConfig,
): TrustRegistry {
  return new CryptoFreeTrustRegistry(config);
}
