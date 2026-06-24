/**
 * identity/binders/dnsDomainProver.ts — THE REAL DNS-01 DOMAIN PROVER.
 *
 * ARCHITECTURE.md §1 roadmap residual: "no REAL external services." The DOMAIN
 * binder (identity/binding.ts) verifies domain control through an INJECTED
 * {@link DomainProofChecker} whose only implementation was a TEST MOCK. This
 * module ships the FIRST real external prover, backed by `node:dns/promises`,
 * while keeping the codebase HERMETICALLY TESTABLE: every byte of I/O goes
 * through ONE injected seam — the {@link DnsResolver} port — so the default test
 * suite injects a FAKE resolver (a map of name → records) and NEVER hits the
 * network.
 *
 * What this module provides:
 *
 *   (1) {@link createDnsDomainProofChecker} — a REAL DNS-01 {@link
 *       DomainProofChecker}. Verification resolves the TXT record at
 *       `<challengePrefix>.<domain>` (default prefix `_iddb-challenge`) and
 *       confirms the issued nonce token is present among the TXT strings, JOINING
 *       the per-record chunks (DNS splits a TXT string into ≤255-byte segments) and
 *       comparing constant-time-ish. DNS is ASYNC ⇒ `check` returns a Promise.
 *
 *   (2) {@link createNodeDnsResolver} — the PROD {@link DnsResolver}, a thin
 *       wrapper over `node:dns/promises` (`resolveTxt` / `resolveNs`). Tests pass
 *       {@link fakeResolver} instead.
 *
 *   (3) {@link bindDomainViaDns} — the ASYNC binding flow. The existing
 *       `DomainBinder.bind` is SYNC and treats a Promise as "not yet proven"; this
 *       additive async path AWAITS the DNS check and, on success, builds + signs
 *       the attestation EXACTLY as the existing binder does, reusing
 *       {@link signAttestation} (no forked crypto). A failed/absent TXT ⇒
 *       {@link Rejection} (fail-closed).
 *
 *   (4) {@link deriveOperatorClass} — the REAL fleet axis. operatorClassId is
 *       derived from the domain's authoritative NS records (`resolveNs` → the
 *       registrable apex of each nameserver hostname = the DNS operator). NS-operator
 *       apex is a network-derivable PROXY for registrar/ASN. FAIL-CLOSED-ISH: if NS
 *       lookup fails, ALL unknowns COLLAPSE to one shared sentinel — an unknown
 *       operator must NEVER manufacture false independence.
 *
 * Two governing invariants honored: the model is never its own witness (proof is a
 * real DNS TXT record, checked outside the web); the web is never its own witness
 * about identity (the check + NS-operator derivation happen through an external
 * injected resolver seam). Everything fails closed.
 *
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`
 * (`import type`); `node:dns/promises` + `node:crypto` only — no external deps.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  AnchorClass,
  type SourceId,
  type IndependenceClassId,
  type OperatorClassId,
  type EpochMs,
} from "../../core/types.js";
import { ANCHOR_TABLE } from "../anchors.js";
import type { KeyPair } from "../keys.js";
import {
  signAttestation,
  type AnchorAttestation,
  type DomainProofChecker,
  type ETldResolver,
  type Rejection,
} from "../binding.js";

/** Field separator (SOH/U+0001) — same discipline as the sync DOMAIN binder's
 * `saltedAnchorId`, so the anchorId byte-matches for the same salt + root. */
const SEP = "";

// ---------------------------------------------------------------------------
// The injected resolver seam — the ONLY I/O boundary
// ---------------------------------------------------------------------------

/**
 * The DNS resolver port. The PROD impl ({@link createNodeDnsResolver}) thin-wraps
 * `node:dns/promises`; tests inject a {@link fakeResolver} reading in-memory maps,
 * so the default suite never touches the network. This is the SINGLE seam through
 * which all DNS I/O in this module flows.
 */
export interface DnsResolver {
  /**
   * Resolve the TXT records at `name`. Mirrors `node:dns/promises` `resolveTxt`
   * EXACTLY: each record is an ARRAY of string chunks (DNS splits a TXT string at
   * ≤255-byte boundaries), so the return is `string[][]`. Rejects on NXDOMAIN /
   * no-data (e.g. an `ENOTFOUND`/`ENODATA`-shaped error).
   */
  resolveTxt(name: string): Promise<string[][]>;
  /**
   * Resolve the authoritative nameserver hostnames for `domain`. Mirrors
   * `node:dns/promises` `resolveNs`. Rejects on NXDOMAIN / no NS data.
   */
  resolveNs(domain: string): Promise<string[]>;
}

/**
 * The PROD resolver: a thin wrapper over `node:dns/promises`. Imported lazily
 * (dynamic `import`) so merely loading this module — e.g. in a hermetic test that
 * only uses {@link fakeResolver} — does not pull in `node:dns`. Real network I/O
 * happens ONLY when one of its methods is awaited.
 */
export function createNodeDnsResolver(): DnsResolver {
  return {
    async resolveTxt(name: string): Promise<string[][]> {
      const dns = await import("node:dns/promises");
      return dns.resolveTxt(name);
    },
    async resolveNs(domain: string): Promise<string[]> {
      const dns = await import("node:dns/promises");
      return dns.resolveNs(domain);
    },
  };
}

/**
 * A hermetic FAKE resolver for tests: reads two in-memory maps and rejects on a
 * miss (NXDOMAIN-shaped) so it behaves like a real resolver without any network.
 * `txt`/`ns` keys are the exact lookup names (TXT keyed by the full
 * `<prefix>.<domain>` record name; NS keyed by the domain apex).
 */
export function fakeResolver(
  txt: ReadonlyMap<string, string[][]>,
  ns: ReadonlyMap<string, string[]>,
): DnsResolver {
  return {
    resolveTxt(name: string): Promise<string[][]> {
      const recs = txt.get(name);
      if (recs === undefined) {
        return Promise.reject(notFound(name));
      }
      return Promise.resolve(recs);
    },
    resolveNs(domain: string): Promise<string[]> {
      const recs = ns.get(domain);
      if (recs === undefined) {
        return Promise.reject(notFound(domain));
      }
      return Promise.resolve(recs);
    },
  };
}

/** An NXDOMAIN-shaped error, matching the prod resolver's failure mode. */
function notFound(name: string): Error & { code: string } {
  const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
  err.code = "ENOTFOUND";
  return err;
}

// ---------------------------------------------------------------------------
// (1) The REAL DNS-01 DomainProofChecker
// ---------------------------------------------------------------------------

/** Default challenge record prefix; record name is `<prefix>.<domain>`. */
export const DEFAULT_CHALLENGE_PREFIX = "_iddb-challenge";

/** Options for {@link createDnsDomainProofChecker}. */
export interface DnsDomainProofCheckerOpts {
  /** The resolver seam (default: {@link createNodeDnsResolver}). */
  readonly resolver?: DnsResolver;
  /** Challenge record prefix (default: {@link DEFAULT_CHALLENGE_PREFIX}). */
  readonly challengePrefix?: string;
}

/**
 * Build a REAL DNS-01 {@link DomainProofChecker}. `check(domain, nonce)` resolves
 * the TXT record at `<prefix>.<domain>` and returns `true` iff the issued `nonce`
 * is present among the records. Each record's chunks are JOINED (`chunks.join("")`)
 * to reconstruct the full TXT string before comparison (handles the 255-byte
 * multi-string split), and the compare is constant-time-ish (length-guarded
 * `timingSafeEqual`). FAIL-CLOSED: a resolver throw / empty result ⇒ `false`.
 */
export function createDnsDomainProofChecker(
  opts?: DnsDomainProofCheckerOpts,
): DomainProofChecker {
  const resolver = opts?.resolver ?? createNodeDnsResolver();
  const prefix = opts?.challengePrefix ?? DEFAULT_CHALLENGE_PREFIX;

  return {
    async check(domain: string, nonce: string): Promise<boolean> {
      const normalized = domain.trim().toLowerCase();
      if (normalized.length === 0) return false;
      const recordName = `${prefix}.${normalized}`;
      let records: string[][];
      try {
        records = await resolver.resolveTxt(recordName);
      } catch {
        // NXDOMAIN / no-data / network error ⇒ not proven (fail-closed).
        return false;
      }
      for (const chunks of records) {
        // Join THIS record's chunks: DNS splits one TXT string into ≤255-byte
        // segments, so the full string is the concatenation of this record's
        // chunks (NEVER a flatten across separate records).
        const joined = chunks.join("");
        if (constantTimeEqual(joined, nonce)) return true;
      }
      return false;
    },
  };
}

/**
 * Constant-time-ish string equality over utf8 bytes. A length mismatch returns
 * `false` immediately (lengths are not secret), guarding `timingSafeEqual` which
 * throws on unequal-length buffers. Wrapped in try/catch so a degenerate input
 * never throws out of the check. An empty nonce never matches (fail-closed).
 */
function constantTimeEqual(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length === 0 || bb.length === 0) return false;
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// (4) NS-derived operator class — the REAL fleet axis
// ---------------------------------------------------------------------------

/**
 * Shared sentinel for an UNKNOWN DNS operator. ALL domains whose NS lookup fails
 * collapse to this ONE id, so unknowns are treated as correlated (never as
 * independent). Manufacturing a per-domain fallback id would fake independence —
 * deliberately rejected.
 */
export const UNKNOWN_DNS_OPERATOR = "__unknown-dns-operator__" as OperatorClassId;

/** Separator joining sorted NS apexes into the operator class id. */
const NS_SEP = "|";

/**
 * Derive a domain's OPERATOR class (the fleet axis) from its authoritative NS
 * records: `resolveNs(registrableDomain(domain))` → take the registrable apex of
 * each nameserver hostname (the DNS operator), lowercase, dedupe, sort, join. The
 * NS-operator apex is a network-derivable PROXY for registrar/ASN — many domains
 * served by the same nameserver operator (e.g. all on one DNS provider) collapse
 * to ONE operatorClassId, driving the registry's fleet cap from a REAL signal.
 *
 * FAIL-CLOSED-ISH: an NS-lookup throw / empty result returns the shared
 * {@link UNKNOWN_DNS_OPERATOR} sentinel so unknowns collapse together rather than
 * manufacturing false independence.
 */
export async function deriveOperatorClass(
  domain: string,
  resolver: DnsResolver,
  etld: ETldResolver,
): Promise<OperatorClassId> {
  const apex = etld.registrableDomain(domain.trim().toLowerCase()).toLowerCase();
  let nsHosts: string[];
  try {
    nsHosts = await resolver.resolveNs(apex);
  } catch {
    return UNKNOWN_DNS_OPERATOR;
  }
  if (nsHosts.length === 0) return UNKNOWN_DNS_OPERATOR;

  const operatorApexes = new Set<string>();
  for (const host of nsHosts) {
    const cleaned = host.trim().toLowerCase().replace(/\.$/, "");
    if (cleaned.length === 0) continue;
    operatorApexes.add(etld.registrableDomain(cleaned).toLowerCase());
  }
  if (operatorApexes.size === 0) return UNKNOWN_DNS_OPERATOR;

  const joined = [...operatorApexes].sort().join(NS_SEP);
  return ("ns:" + joined) as OperatorClassId;
}

// ---------------------------------------------------------------------------
// (3) The ASYNC binding flow
// ---------------------------------------------------------------------------

/** A rough hostname/domain validity check: ≥2 labels, each label using only
 * [a-z0-9-], no leading/trailing hyphen, bounded length. */
function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  if (!domain.includes(".")) return false;
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return true;
}

/**
 * Salt+sha256 the canonical root → base64url. Never the raw root. Mirrors the
 * sync DOMAIN binder's `saltedAnchorId` discipline (SOH separator), so the
 * anchorId byte-matches for the same salt + registrable root.
 */
function saltedAnchorId(salt: string, canonicalRoot: string): string {
  return createHash("sha256")
    .update(Buffer.from(salt + SEP + canonicalRoot, "utf8"))
    .digest("base64url");
}

/** How long an emitted attestation stays valid before it must re-bind (30 days),
 * matching the sync binder's default. */
export const DEFAULT_ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Dependencies for {@link bindDomainViaDns}. Mirrors the sync binder's deps but
 * with the async DNS checker + resolver seam. */
export interface DnsDomainBindDeps {
  /** The verifier keypair that signs emitted attestations. */
  readonly verifier: KeyPair;
  /** The REAL (async) DNS-01 proof checker (build via {@link createDnsDomainProofChecker}). */
  readonly checker: DomainProofChecker;
  /** eTLD+1 resolver (the independence-class axis + NS-apex collapse). */
  readonly etld: ETldResolver;
  /** Verifier-held salt for the anchorId hash (never logged with the root). */
  readonly anchorSalt: string;
  /** The resolver seam used for NS-operator derivation (the fleet axis). */
  readonly resolver: DnsResolver;
  /** Attestation TTL override (default {@link DEFAULT_ATTESTATION_TTL_MS}). */
  readonly attestationTtlMs?: number;
}

/**
 * ASYNC DOMAIN binding via REAL DNS-01. Normalizes + validates the domain
 * (fail-closed on malformed), AWAITS the injected DNS check, and on success builds
 * the SAME attestation body the sync `createDomainBinder.bind` builds — classId =
 * registrable domain (eTLD+1), anchorId = salted hash, proofRef =
 * `_iddb-challenge.<domain>`, weight = DOMAIN (0.35), `notBefore`/`notAfter` window
 * — with the operatorClassId derived from REAL NS records ({@link
 * deriveOperatorClass}), then signs via the shared {@link signAttestation}. A
 * failed/absent TXT (or malformed domain) ⇒ {@link Rejection} (fail-closed).
 */
export async function bindDomainViaDns(
  sourceId: SourceId,
  domain: string,
  nonce: string,
  deps: DnsDomainBindDeps,
  now: EpochMs,
): Promise<AnchorAttestation | Rejection> {
  const normalized = domain.trim().toLowerCase();
  if (!isValidDomain(normalized)) {
    return { ok: false, reason: "malformed domain" };
  }

  let passed: boolean;
  try {
    passed = (await deps.checker.check(normalized, nonce)) === true;
  } catch {
    // A throwing checker is fail-closed too.
    passed = false;
  }
  if (!passed) {
    return { ok: false, reason: "DNS-01 proof failed" };
  }

  const registrable = deps.etld.registrableDomain(normalized).toLowerCase();
  const classId = registrable as unknown as IndependenceClassId;
  const operatorClassId = await deriveOperatorClass(
    normalized,
    deps.resolver,
    deps.etld,
  );
  const attestationTtl = deps.attestationTtlMs ?? DEFAULT_ATTESTATION_TTL_MS;
  const weight = ANCHOR_TABLE[AnchorClass.DOMAIN].independenceWeight;

  const body: Omit<AnchorAttestation, "verifierSig"> = {
    sourceId,
    anchorType: AnchorClass.DOMAIN,
    anchorId: saltedAnchorId(deps.anchorSalt, registrable),
    operatorClassId,
    proofRef: "_iddb-challenge." + normalized,
    weight,
    classId,
    notBefore: now,
    notAfter: ((now as number) + attestationTtl) as EpochMs,
  };
  return signAttestation(body, deps.verifier);
}
