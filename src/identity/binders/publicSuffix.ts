/**
 * identity/binders/publicSuffix.ts — A ZERO-DEP PUBLIC-SUFFIX-LIST eTLD+1 RESOLVER.
 *
 * The DOMAIN independence axis is `classId = registrableDomain(domain)` (the
 * eTLD+1). Two sources are independent on the DOMAIN axis IFF their registrable
 * domains differ, so a WRONG registrable domain corrupts independence in BOTH
 * directions:
 *
 *   - OVER-COLLAPSE: a naive "last two labels" resolver maps `a.github.io` and
 *     `b.github.io` both to `github.io`, merging two genuinely-distinct GitHub
 *     Pages owners (a PRIVATE multi-tenant host) into ONE phantom owner — two
 *     independent sources mis-counted as an echo.
 *   - WRONG APEX: the same naive rule maps `bbc.co.uk` to `co.uk` (a public
 *     suffix, NOT a registrable name), collapsing all of `*.co.uk` to one
 *     suffix and destroying real independence across the whole ccTLD.
 *
 * This module implements the standard Mozilla Public Suffix List algorithm
 * (https://publicsuffix.org/list/) over an EMBEDDED, CURATED subset of the list,
 * parsed once at module load. It honors the ICANN + PRIVATE sections, the `*`
 * wildcard rule, and the `!` exception rule, and returns the registrable domain
 * (longest matching public suffix + one more label).
 *
 * ── HONEST SCOPING (REQUIRED) ────────────────────────────────────────────────
 * The embedded `PSL_DATA` is a CURATED APPROXIMATION of the full Mozilla Public
 * Suffix List (~10k+ rules); this carries only a few dozen — the common gTLDs,
 * the common multi-level ccTLDs (`co.uk`, `com.au`, `co.jp`, …), and the known
 * seam-abused PRIVATE multi-tenant hosts (`github.io`, `herokuapp.com`,
 * `vercel.app`, …), plus a genuine `*`/`!` wildcard+exception pair (`*.ck` /
 * `!www.ck`) so those code paths are exercised. A FULLER list — or a build-time
 * snapshot of the complete Mozilla list — can be bundled later as a pure DATA
 * change WITHOUT touching this algorithm or the {@link ETldResolver} interface.
 *
 * An UNLISTED multi-level ccTLD falls to the single-label default rule: it may
 * UNDER-split (merge into a broader suffix) but NEVER manufactures false
 * independence — the conservative, fail-safe direction.
 *
 * ── WHAT THIS DOES NOT FIX ────────────────────────────────────────────────────
 * PSL fixes ONLY suffix-boundary correctness. It does NOT close the "Registrar
 * Carousel": a patient attacker can still register K genuinely-DISTINCT
 * registrable names (`evil1.com`, `evil2.com`, … each a real $/yr domain) from
 * one wallet, and each is a legitimately-independent DOMAIN class under PSL.
 * That is the "identity is priced, not prevented" residual and is CORRECTLY
 * STILL OPEN; the operator fleet cap (the trust registry's config-injected
 * `operatorOf` hook — same operator collapses a fleet) is the partial
 * mitigation, not PSL.
 *
 * ZERO RUNTIME DEPENDENCIES: the PSL data is embedded static source; no npm
 * package, no network fetch, no filesystem read. The class table / PSL is one
 * swappable trust-policy data root (like a CA set), exactly as the design wants.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (type-only imports use `import type`). ZERO imports beyond the module's own
 * embedded data — this file is pure string logic.
 */

/**
 * Injected eTLD+1 (registrable-domain) resolver seam. The suffix policy is
 * pluggable: tests may inject a deterministic resolver; prod uses the PSL-backed
 * {@link pslResolver} below (or a fuller list, as a pure data swap). This
 * interface HOME is here (pure string logic) — it is consumed by the crypto-free
 * trust registry (identity/trustRegistry.ts) for the publisher / verified-tenant-
 * domain independence axes.
 */
export interface ETldResolver {
  /** The registrable domain (eTLD+1) of `domain`, lowercased. */
  registrableDomain(domain: string): string;
}

// ---------------------------------------------------------------------------
// The embedded, curated PSL subset (newline-delimited, Mozilla PSL file format)
// ---------------------------------------------------------------------------

/**
 * A curated subset of the Mozilla Public Suffix List in the canonical file
 * format: `//` line comments, blank lines ignored, optional section markers,
 * one rule per line. `*` is a wildcard label; a leading `!` marks an exception
 * rule. Parsed ONCE by {@link parsePsl} at module load.
 *
 * See the module header for the honest-scoping note: this is a few-dozen-rule
 * approximation of the ~10k-rule full list, not the complete list.
 */
const PSL_DATA = `
// ===BEGIN ICANN DOMAINS===

// Common single-label gTLDs (the default-single-label rule already covers any
// not listed; these are enumerated for clarity/auditability).
com
org
net
io
co
dev
app
ai
info
biz
me
xyz
tech
cloud

// Common multi-level ccTLD suffixes (.uk)
uk
co.uk
org.uk
gov.uk
ac.uk
me.uk
net.uk

// .au
au
com.au
net.au
org.au
edu.au
gov.au

// .jp
jp
co.jp
ne.jp
or.jp
go.jp
ac.jp

// other common multi-level ccTLDs
co.nz
com.br
co.in
com.cn
co.za
com.mx
co.kr

// A genuine wildcard + exception pair from the real PSL (.ck): every label
// directly under .ck is a public suffix EXCEPT www.ck, which is registrable.
// Exercises the '*' wildcard and '!' exception code paths.
*.ck
!www.ck

// ===BEGIN PRIVATE DOMAINS===

// Multi-tenant hosts the "mega-provider subdomain seam" abuses: each subdomain
// is a DISTINCT owner, so the registrable domain must be sub.host, not host.
github.io
blogspot.com
herokuapp.com
pages.dev
vercel.app
netlify.app
web.app
firebaseapp.com

// A private-section wildcard (AWS S3 regional buckets): demonstrates '*' in a
// non-leftmost position — bucket.s3.<region>.amazonaws.com is its own owner.
s3.amazonaws.com
s3.*.amazonaws.com
`;

// ---------------------------------------------------------------------------
// Parsing — once, at module load
// ---------------------------------------------------------------------------

/** A parsed rule set: three label-array buckets keyed by rule kind. */
interface RuleSet {
  /** Normal rules (e.g. `co.uk` → `["co","uk"]`). */
  readonly normal: ReadonlyArray<readonly string[]>;
  /** Wildcard rules with a `*` label (e.g. `*.ck` → `["*","ck"]`). */
  readonly wildcard: ReadonlyArray<readonly string[]>;
  /** Exception rules (the `!` stripped, e.g. `!www.ck` → `["www","ck"]`). */
  readonly exception: ReadonlyArray<readonly string[]>;
}

/**
 * Parse the PSL file-format text into a {@link RuleSet}. Skips blank lines and
 * `//` comments (including the `===BEGIN …===` section markers, which are
 * comments in the canonical format). Each rule is split into lowercase labels.
 */
function parsePsl(data: string): RuleSet {
  const normal: string[][] = [];
  const wildcard: string[][] = [];
  const exception: string[][] = [];
  for (const rawLine of data.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("//")) continue;
    if (line.startsWith("!")) {
      exception.push(line.slice(1).toLowerCase().split("."));
    } else if (line.includes("*")) {
      wildcard.push(line.toLowerCase().split("."));
    } else {
      normal.push(line.toLowerCase().split("."));
    }
  }
  return { normal, wildcard, exception };
}

/** Parsed ONCE and cached for the module lifetime (zero-dep, in-memory). */
const RULES: RuleSet = parsePsl(PSL_DATA);

// ---------------------------------------------------------------------------
// The standard PSL matching algorithm
// ---------------------------------------------------------------------------

/**
 * Does `rule` match the rightmost labels of `domainLabels`? Label-wise from the
 * right; a `*` rule label matches exactly one arbitrary label. A rule with more
 * labels than the domain cannot match.
 */
function ruleMatches(
  rule: readonly string[],
  domainLabels: readonly string[],
): boolean {
  if (rule.length > domainLabels.length) return false;
  for (let i = 1; i <= rule.length; i++) {
    const ruleLabel = rule[rule.length - i];
    const domainLabel = domainLabels[domainLabels.length - i];
    if (ruleLabel === "*") continue; // wildcard matches any single label
    if (ruleLabel !== domainLabel) return false;
  }
  return true;
}

/**
 * The public suffix of `domainLabels`, returned as a LABEL COUNT (how many of
 * the rightmost labels form the suffix), per the standard PSL algorithm:
 *
 *  1. An EXCEPTION rule, if it matches, wins outright — the suffix is the rule
 *     MINUS its leftmost label (`rule.length - 1`). Among matching exceptions,
 *     the longest prevails.
 *  2. Otherwise the prevailing rule is the matching NORMAL-or-WILDCARD rule with
 *     the MOST labels; the suffix is that rule's label count.
 *  3. If nothing matches, the default rule applies: the suffix is the single
 *     rightmost label.
 */
function publicSuffixLabelCount(domainLabels: readonly string[]): number {
  // (1) Exception rules take absolute priority.
  let bestException = 0;
  for (const rule of RULES.exception) {
    if (ruleMatches(rule, domainLabels) && rule.length > bestException) {
      bestException = rule.length;
    }
  }
  if (bestException > 0) {
    // Suffix = the exception rule minus its leftmost label.
    return bestException - 1;
  }

  // (2) Longest matching normal/wildcard rule.
  let best = 0;
  for (const rule of RULES.normal) {
    if (ruleMatches(rule, domainLabels) && rule.length > best) {
      best = rule.length;
    }
  }
  for (const rule of RULES.wildcard) {
    if (ruleMatches(rule, domainLabels) && rule.length > best) {
      best = rule.length;
    }
  }
  if (best > 0) return best;

  // (3) Default rule: the rightmost single label is the public suffix.
  return 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The public suffix (eTLD) of `domain`, lowercased and normalized. Exposed as a
 * helper for callers/tests that want the suffix directly; the binder uses
 * {@link registrableDomain}. Returns the whole normalized input if the domain
 * consists solely of its public suffix.
 */
export function publicSuffixOf(domain: string): string {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) return normalized;
  const labels = normalized.split(".");
  const count = publicSuffixLabelCount(labels);
  return labels.slice(labels.length - count).join(".");
}

/**
 * Normalize a domain: `trim().toLowerCase()` and strip a SINGLE trailing dot
 * (the FQDN root). Returns `""` for an empty/whitespace input (the callers
 * fail-close on an empty registrable).
 */
function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  return d;
}

/**
 * The registrable domain (eTLD+1) of `domain` — the standard PSL result: the
 * longest matching public suffix plus ONE more label to its left.
 *
 * Fail-safe degenerate cases (documented, deliberate):
 *  - An empty/whitespace input returns `""`.
 *  - If the domain IS exactly a public suffix (no label to the left — e.g.
 *    `co.uk`, `github.io` as bare inputs), there is no registrable domain;
 *    we return the NORMALIZED input unchanged rather than throwing or minting a
 *    phantom apex. The call sites lowercase and use the result directly, so the
 *    normalized input is the safe non-throwing answer.
 */
export function registrableDomain(domain: string): string {
  const normalized = normalizeDomain(domain);
  if (normalized.length === 0) return normalized;

  const labels = normalized.split(".");
  const suffixCount = publicSuffixLabelCount(labels);

  // No label to the left of the suffix → the input is (at most) a bare suffix;
  // return it unchanged (fail-safe — never a phantom apex).
  if (labels.length <= suffixCount) return normalized;

  // Registrable = public suffix + one more label.
  return labels.slice(labels.length - suffixCount - 1).join(".");
}

/**
 * The production {@link ETldResolver}: a PSL-backed registrable-domain resolver,
 * the DEFAULT for the trust registry's publisher / verified-tenant-domain axes.
 * Stateless and pure (the rule set is parsed once at module load), so a single
 * shared instance is safe.
 */
export const pslResolver: ETldResolver = {
  registrableDomain,
};
