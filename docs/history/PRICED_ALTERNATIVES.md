> **HISTORICAL (pre crypto-free rebuild, superseded 2026-07).** Describes deleted machinery (Ed25519/Merkle/staking);
> the current design is [CLAUDE.md](../../CLAUDE.md) + [docs/ARCHITECTURE_ENGINE.md](../ARCHITECTURE_ENGINE.md).

# Priced-identity alternatives (move away from cryptography)

> **Target: none specified.** This is a standalone analysis for the user to place at their
> discretion (it now lives at `docs/launch/PRICED_ALTERNATIVES.md`). SUGGESTIONS ONLY — no
> code was changed, and nothing under `src/` was touched, per this pass's task constraints.

Grounded by reading `src/identity/anchors.ts`, `src/identity/keys.ts`,
`src/identity/reputation.ts`, `src/identity/index.ts`, `src/identity/anchorRegistry.ts`,
`src/ratification/pendingLedger.ts`, CLAUDE.md's "Source-Identity Layer" / "Anchor-cost
table" sections, and ARCHITECTURE.md's identity roadmap (§1 "Anchor-binding pipeline", §3
"Merkle tree + published root"). This revision also cross-checks against this same
launch-prep pass's parallel code-review workstream ("Code review: identity + ratification"),
which independently read the same five identity/ratification files plus
`ratification/{corroboration,weakInfluence,adjudicationProvenance,reconcile,merkleLog,mutationReceipt}.ts`
and the `api.ts` / `agentMemory.ts` call sites — its top finding is directly relevant here and
is folded into [§4](#4-same-reasoning-applies-to-ratificationpendingledgerts--with-one-confirmed-correctness-bug-that-any-redesign-must-not-carry-forward)
below with line-level confirmation.

## 1. First, an important structural fact this reading surfaced

The three originally-read files are **not equally cryptographic**, and that asymmetry matters
for where a crypto-free redesign is cheap vs. costly:

- **`identity/anchors.ts`** (the independence-math pillar: `independenceBetween`,
  `combineSublinear`, `applySelfStackCap`, `repCapFor`, `stakeIndependenceWeight`) imports
  **nothing but `core/types.ts`**. It is pure arithmetic over `AnchorBinding[]` objects
  (`{anchorClass, anchorId, independenceWeight, realizedCost}`). It does not know or care
  whether an `AnchorBinding` was produced by a DNS-01 challenge, an OAuth API call, a human
  moderator's manual entry, or a Stripe webhook. **This file already needs zero changes to go
  crypto-free** — it is the load-bearing "identity is priced, not prevented" logic, and it is
  mechanism-agnostic by construction.
- **`identity/reputation.ts`** (the Beta(α,β) trust model) imports only `node:sqlite` for the
  durable variant and never touches keys or signatures. It consumes an independence weight
  `w` and a `repCapOf(sourceId)` accessor, both injected. **Also already crypto-free.**
- **`identity/keys.ts`** is where the actual cryptography lives (Ed25519 keypair generation,
  `sign`/`verify`, `sourceIdFromPublicKey = sha256(DER(pubkey))`). Per its own doc comment,
  its *entire job* is "prove sameness... cheap to mint, so necessary but NOT sufficient for
  independence" — and a bare key sits at `AnchorClass.BARE_KEY`, `independenceWeight = 0.00`.
  In other words: **the passport layer, as designed, contributes zero independence value on
  its own.** It is pure echo-collapse plumbing. That makes it the lowest-regret place to
  remove asymmetric crypto, because removing it doesn't touch the part of the design that
  actually does the Sybil-pricing work.

Two more crypto-bearing components exist beyond the three read files, described in
CLAUDE.md / ARCHITECTURE.md and worth naming since the same substitution logic applies to
them: the **anchor-binding pipeline** (`identity/binding.ts`, DNS-01 / email-round-trip
binders emitting Ed25519-signed, expiring `AnchorAttestation`s) and the **Merkle audit log**
(`ratification/merkleLog.ts`, RFC-6962 leaf/node hashing + signed epoch STHs + ≥2-sink
publication) plus the structurally similar **ratification ledger**
(`ratification/pendingLedger.ts`, an Ed25519-signed hash-chained "vault and doorbell").

## 2. The principle to preserve vs. the mechanism to swap

Keep, unconditionally (this is the hard-theorem-derived, non-negotiable part):
**independence must remain a function of disjoint, externally-rooted, costly-to-fake
anchors, weighted by an anchor-cost table with sublinear self-stacking and a `rep_cap`
ceiling.** Nothing below proposes touching that. What's on the table is only *how a binding
to an anchor is proved* and *how the audit trail's integrity is evidenced* — i.e. the
plumbing around `AnchorBinding` production and log tamper-evidence, not the math that
consumes them.

## 3. Alternatives

Each is scored against: what it keeps / what it gives up / the new trust assumption it
introduces / an honest crypto-elimination verdict.

### A. Passport replacement: federated OAuth/SSO subject-id instead of a locally-generated Ed25519 keypair

- **Mechanism:** `sourceId` = a stable hash of `(issuer, subject-claim)` from an OAuth/OIDC ID
  token (Google/GitHub/Microsoft account), verified once at binding time by calling the
  provider, not by this app minting or storing any keypair.
- **Keeps:** echo-collapse (same account ⇒ same source_id); the "cheap to mint but 0
  independence" framing (a fresh throwaway OAuth account is exactly BARE_KEY-equivalent); the
  "necessary but not sufficient" role passports already play.
- **Gives up:** self-sovereignty and offline verifiability. An Ed25519 signature can be
  checked by *anyone* holding the public key, forever, with no network call. An
  OAuth-based sameness claim can only be re-verified by calling (or trusting a cached,
  short-lived token from) the IdP — verification becomes "trust this app's point-in-time
  record," not an independently reproducible cryptographic fact. This also removes the
  option of a fully anonymous BARE_KEY tier (every source now needs at least one real
  platform account), which changes the accessibility/access-control posture, not just the
  crypto.
- **New trust assumption:** the OAuth IdP is honest, uncompromised, and its own
  account-creation friction is a genuine anti-Sybil cost (this is *also* an assumption the
  current `EMAIL_OAUTH` anchor row already implicitly makes about "an email/OAuth account" —
  so this mostly collapses the passport layer into the anchor layer rather than inventing a
  new assumption).
- **Honest verdict:** genuinely removes this codebase's own key-generation/custody/signing/
  verification code and the entire "what if the private key is lost" problem — a real
  complexity and operational-risk reduction. It does **not** remove cryptography from the
  system: it relocates it to the IdP's OIDC/JWT stack (RS256 over TLS), which you now trust
  wholesale and cannot audit. This is the textbook "moved, not eliminated" case — but moving
  it to an entity that already runs a professional PKI (Google/Microsoft) rather than
  building a bespoke one in-house is arguably a legitimate simplification, not just
  crypto-laundering, *provided the team is honest that it's delegation, not elimination.*

### B. Passport replacement: opaque symmetric bearer token (no asymmetric keys at all)

- **Mechanism:** issue each source a random 256-bit API key at registration (like a GitHub
  PAT or Stripe secret key); `sourceId` = a stored mapping or `hash(key)`; every write is
  authenticated by presenting the bearer key over TLS, checked against a server-side table.
- **Keeps:** echo-collapse (same key ⇒ same source).
- **Gives up:** non-repudiation. An Ed25519 signature lets a THIRD PARTY verify "source X
  really authored this specific message" without trusting the server's word for it — this
  matters for the Merkle/audit-log story ("a witness can independently confirm authorship").
  A bearer-token check is only verifiable by whoever holds the secret table — i.e. your own
  server. This quietly downgrades "cryptographically provable authorship, verifiable by
  anyone" to "the operator's internal database says so," which is a real (if often
  acceptable) loss for an append-only, tamper-evidence-oriented system. It also loses
  signature-per-message forward security: leaking one bearer token is instant full
  impersonation, versus a leaked signature only ever proving one already-made statement.
- **New trust assumption:** trust the app operator's own secret generation/storage/comparison
  (a CSPRNG and probably an HMAC or hash — still "cryptography" in the narrow primitive
  sense, but not a PKI).
- **Honest verdict:** this is the most literal "less crypto" option (no public-key
  infrastructure, no signature verification code) but it is a straight downgrade in the
  specific guarantee (third-party-verifiable authorship) the current design uses signatures
  for elsewhere (the pendingLedger "vault," the Merkle STHs). It also doesn't eliminate
  crypto — TLS plus a random secret is still the unavoidable floor for any networked identity
  claim; it just avoids asymmetric-key machinery specifically.

### C. Anchor binding: platform account age/standing as evidence, verified via API call instead of a self-signed DNS-01/email attestation

- **Mechanism:** for DOMAIN/EMAIL_OAUTH-tier anchors, call the platform's API at bind time
  ("this GitHub account is 3 years old, has N contributions"; "this Google Workspace domain
  is verified") and record the result as the anchor, rather than running your own DNS-01
  challenge or email round-trip and signing your own `AnchorAttestation`.
- **Keeps:** the "anchor = a costly/rate-limited real-world signal" framing; the
  anchor-cost table's weights/rep_caps are untouched (only the binder changes, not the policy
  numbers).
- **Gives up:** the durable, independently re-verifiable attestation artifact. The current
  design's signed `AnchorAttestation{..., notBefore, notAfter, verifierSig}` can be checked
  by anyone holding your verifier's public key for as long as it's retained — a
  self-contained proof object. An "I called the API and got this answer" record is a
  point-in-time claim only your own server can vouch for; it can't be re-verified later
  without re-querying a (possibly rate-limited, ToS-restricted, or since-changed) third-party
  API, and no outside party can ever check it independently.
- **New trust assumption:** you now trust each platform's account-standing signal as a
  genuine friction proxy — but "aged account" is a known, purchasable commodity on secondary
  markets, arguably making this a *weaker*, less-tunable Sybil price than domain registration
  or KYC, and one your own system can no longer see or adjust (whereas the anchor-cost table
  today is an explicit, swappable, in-house policy knob).
- **Honest verdict:** this doesn't eliminate crypto (OAuth/TLS is still underneath); it
  trades "you audit and maintain ~200 lines of signing/attestation code" for "you trust a
  platform's fraud practices as a black box," which is operationally lighter but
  epistemically murkier and potentially *cheaper for an attacker to game* than the mechanism
  it replaces. Best used as a cost-only anchor for the cheap tiers (`EMAIL_OAUTH`/
  `PHONE_SIM`), not as a substitute for `VERIFIED_HUMAN`/`ORGANIZATION`-grade binding.

### D. Anchor binding: human-moderator attestation network (no attestation cryptography at all)

- **Mechanism:** a panel of trusted moderators manually reviews evidence (WHOIS printout,
  video call, notarized document, employer letter) and appends a plain row
  `{sourceId, anchorClass, moderatorId, decidedAt}` to a database via an ordinary
  authenticated admin dashboard — no per-attestation signature.
- **Keeps:** the "external, costly-to-fake root" spirit arguably *more faithfully* than any
  automated binder — a human reviewer is about as external a witness as exists, directly
  matching the design's second governing invariant ("the web is never its own witness about
  source identity"). This is a strong fit specifically for the `VERIFIED_HUMAN` /
  `ORGANIZATION` rows, which already assume a real-world KYC-style process; a moderator panel
  could literally *be* that process instead of an automated OIDC4VC verifiable credential,
  with zero change to `ANCHOR_TABLE`'s weights/caps.
- **Gives up:** unattended scale (DNS-01/email binders run themselves for free, 24/7; a human
  panel is a standing per-binding labor cost and a throughput ceiling) and — this is the
  sharp edge — **the tamper-evident attestation artifact itself**. A plain DB row is editable
  by anyone with write access unless separately protected, which means you either (a) accept
  a materially weaker "trust our access logs and backups" guarantee than the current
  signed-attestation + Merkle story, or (b) re-introduce *some* integrity mechanism
  (append-only table, hash chain) to protect the moderators' decisions — which is crypto
  again, just a lighter form (see §5 below on hash-chaining vs. signing vs. Merkle-proofs as
  separable weights).
- **New trust assumption:** the moderators' honesty, competence, and non-collusion. This is
  the theorem's "identity is priced, not prevented" pattern recurring one level up: the
  attacker's new target is "the cost to corrupt/social-engineer a moderator" rather than "the
  cost to forge a DNS record" — which may be *cheaper* (bribery, insider threat) or *more
  expensive* (background-checked staff) depending on how the panel is run. Worth being
  explicit that this is a genuinely different, not obviously weaker, threat model — but it is
  a *centralization* of trust into a small human group, which is exactly the kind of
  single-point-of-failure the anchor-cost table's fleet-cap logic was designed to price
  against for automated Sybils, and needs its own analogous defense (e.g. requiring 2-of-N
  independent moderators, rotating panels, moderator-collusion audits) that this codebase
  does not currently have any machinery for.

### E. Financial-stake anchor via a payment processor / escrow, no on-chain or cryptographic settlement

- **Mechanism:** `FINANCIAL_STAKE` becomes a real hold/charge via Stripe/PayPal/a bank escrow
  account, refunded on good behavior and forfeited (transferred to the operator, or simply
  not refunded) on adjudicated bad behavior — no smart contract, no on-chain proof, no
  bespoke signature scheme.
- **Keeps:** the pricing curve untouched — `stakeIndependenceWeight`'s linear-to-saturation
  mapping from deposit size to independence weight (`anchors.ts`, feeding
  `combineSublinear`/`applySelfStackCap` below it) requires **zero code changes**; only the
  settlement/enforcement layer swaps.
- **Gives up:** independent third-party verifiability of the stake itself (an on-chain escrow
  is checkable by anyone; a Stripe hold is only checkable via your dashboard and your own
  ledger) and instant/atomic forfeiture (chargebacks/ACH reversals have real-world latency
  and dispute windows that a "burn it now" on-chain action doesn't).
- **New trust assumption:** trust the payment processor to honor hold/forfeit instructions
  and trust your own bookkeeping of who staked what — an assumption essentially every
  business already accepts implicitly by taking payment at all.
- **Honest verdict:** **this is the cleanest win in this whole analysis.** It removes
  essentially none of the identity/reputation math (the anchor-cost table's stake row is
  already pure arithmetic), and the "new trust assumption" (trusting a payment processor) is
  one the team almost certainly already carries elsewhere in the product. Card/ACH rails are
  themselves built on cryptography (EMV, TLS, tokenization) — but that is Stripe's and the
  card networks' engineering problem, not this codebase's, and nobody would seriously expect
  an app to reimplement EMV in-house. This is a case where "crypto is hidden, not eliminated"
  is true and completely fine to say out loud, because it was never this project's crypto to
  build in the first place.

### F. Audit-log replacement: a plain trusted third-party log/WORM-storage service instead of a self-hosted RFC-6962 Merkle tree + signed STHs

- **Mechanism:** replace `ratification/merkleLog.ts`'s Merkle tree + Ed25519-signed epoch
  Signed Tree Heads + ≥2-sink publication with: append every record to an external audit-log
  SaaS (e.g. a managed logging/observability vendor with retention lock) or a WORM
  object-storage bucket (e.g. object-lock in compliance mode) at ≥2 independent providers,
  and rely on their access-control/immutability guarantees instead of building
  inclusion/consistency-proof math yourself.
- **Keeps:** the goal — detect deletion, rollback, and split-view equivocation by an operator
  who cannot silently rewrite what ≥2 independent, non-colluding parties already received.
  Worth noting explicitly: real-world RFC 6962 Certificate Transparency *witnesses* are
  themselves ordinary servers run by Google/Cloudflare/DigiCert, not smart contracts or magic
  — so "a plain trusted third-party log service" is not actually a step outside the CT
  ecosystem's real trust model, just a step *below* re-implementing its Merkle-proof math
  yourself.
- **Gives up:** the specific mathematical properties of a Merkle STH — O(log n) **inclusion
  proofs** ("prove record X was in a tree of size N without downloading the whole log") and
  **consistency proofs** ("prove tree N2 is a superset-preserving extension of tree N1") are
  cryptographic guarantees any independent verifier can check unassisted. A WORM bucket or
  log SaaS instead gives you an *operational/contractual* guarantee ("the vendor swears
  nothing was altered, and their access logs would show it if it was") — you lose the
  ability for a cheap, purely mathematical spot-check and gain reliance on the vendor's word
  plus whatever audit access they grant you.
- **New trust assumption:** the third-party log/storage provider's own access controls,
  retention-lock enforcement, and non-compromise/non-coercion — the *same class* of
  assumption CT witnesses already rest on today, just without the Merkle math layered on
  top.
- **Honest verdict — the layered nuance worth flagging explicitly:** there are really
  **three separable weights of "cryptographic machinery"** in the current design, and they
  are not equally removable:
  1. **Hash-chaining** (`thisHash = sha256(prev ‖ record)`) — a bare SHA-256 checksum linking
     records. This requires no keys, no signing, no verification infrastructure; it is
     arguably *beneath* the threshold of "cryptography" the author is objecting to (closer to
     a checksum/CRC than a security protocol) and can stay in a "crypto-free" redesign at
     near-zero cost, since it needs no key-custody story at all.
  2. **Signing** (Ed25519 over each record / each epoch STH) — this is the actual
     asymmetric-crypto layer with a real key-custody problem (who holds the log-signing key,
     how is it rotated/recovered). This is squarely what OAuth-delegation (A), bearer tokens
     (B), or "just use a SaaS's authenticated API" (F) can replace.
  3. **Merkle proof math** (RFC 6962 tree construction + inclusion/consistency proofs) — the
     most substitutable of the three, since its entire value (independent spot-checking
     without full-log trust) is exactly what a third-party WORM/log SaaS trades away in
     exchange for "trust the vendor instead."

  A crypto-averse redesign could reasonably keep (1), drop (2) in favor of an
  authenticated-API-call model, and drop (3) in favor of dual-vendor WORM publication — which
  is a coherent, honestly-described middle ground rather than an all-or-nothing choice.

## 4. Same reasoning applies to `ratification/pendingLedger.ts` — with one CONFIRMED correctness bug that any redesign must not carry forward

The "vault and doorbell" ratification ledger is *also* an Ed25519-signed, hash-chained log
with a distinct-approver gate enforced by signature-identity checks. If the identity layer
moves off local keypairs (A/B above), this ledger's "approver must not be the disputed
member's author" and "forged/unknown signers rejected" checks would need to become
session/account-identity checks against whatever the new sameness mechanism is (an OAuth
subject, a bearer-token owner) rather than a public-key comparison — mechanically
straightforward once (A) or (B) is chosen.

**However**, this same launch-prep pass's parallel code-review workstream ("Code review:
identity + ratification") independently surfaced a HIGH-severity bug that sits directly
underneath that approver gate, and it was re-verified while revising this draft (reading
`src/identity/index.ts` lines ~513–534 against `src/identity/anchorRegistry.ts` lines
~201–229 and the two call sites in `src/ratification/pendingLedger.ts` lines 745 and 1149):
the standalone facade's `independentSources(a, b)` — which `approve()`'s distinct-approver /
anchor-disjointness gate (RC-5) calls via `ctx.independentSources` — returns `true`
(independent) whenever *either* side was never `identity.register()`-ed, i.e. it **fails
open** for an unregistered source:

```ts
if (keys.has(a) && keys.has(b)) { /* … consult anchors … */ }
return true;   // <-- reached whenever either side isn't a registered key
```

This is inconsistent with the *other* implementation of the identical predicate,
`RealAnchorRegistry.independentSources` in `anchorRegistry.ts`, whose own comment states
"Fail-closed: a BARE_KEY (no valid anchor) side is never independent" and which returns
`false` in the analogous case (`aw.length === 0 ⇒ false`). Since `WriteFactInput.stamp` /
`SourceRef.sourceId` are sanctioned escape hatches that don't require prior
`identity.register()`, an unregistered or never-anchored approver can pass the "independent
from the author" check purely because the fail-open branch is reached — the opposite of the
"no anchor → no independent voice" guarantee CLAUDE.md's pillar 4 and ARCHITECTURE.md's RC-5
both claim.

**Why this belongs in a crypto-alternatives essay, not just the code-review track:** it's
tempting to read the current Ed25519-signature-based approver check as a clean,
already-correct baseline that any of (A)/(B) merely need to "re-implement in a different
identity substrate." That framing is not quite right — the bug lives one layer below the
signature check, in the anchor-disjointness predicate the signature-verified `sourceId` is
handed to. **Swapping crypto mechanisms (A/B) does not fix this, and must not be assumed to;
whatever sameness mechanism is chosen, the fail-open-for-unregistered-source branch in
`identity/index.ts`'s `independentSources` needs the same fail-closed treatment
`anchorRegistry.ts` already has, independently of which passport scheme sits above it.** This
is a correctness fix that stands on its own merits (see the code-review workstream for the
fix recommendation) and should not be deferred on the theory that "we're redoing identity
anyway."

## 5. Net read: is this "simpler" or "crypto moved elsewhere"?

Honestly, per-pillar:

- **Passport/sameness (`keys.ts`):** since a bare key already contributes 0 independence by
  design, swapping it for OAuth-delegated or bearer-token sameness removes real local
  complexity (key generation/custody/loss) for essentially no loss of the property the design
  actually prices — a genuine, low-regret simplification, with the honest caveat that OAuth
  still relies on the IdP's own crypto (moved, not eliminated) while a bearer token only
  reduces to a lighter crypto primitive (reduced, not eliminated).
- **Anchor binding (`binding.ts`, not directly read but described in CLAUDE.md /
  ARCHITECTURE.md):** platform-account-signal binding (C) is a real simplification but a
  fuzzier, less-tunable Sybil price than the current signed-attestation approach and loses
  independent re-verifiability; human-moderator binding (D) is arguably the most
  design-faithful ("witnessed from outside") but reintroduces a *different*, less-automatable
  trust concentration (the moderator panel) that the codebase has no analogous fleet-cap
  defense for today; financial-stake-via-payment-processor (E) is the standout — it requires
  zero changes to the actual pricing math and delegates to infrastructure (payment rails)
  nobody would expect this project to build anyway.
- **Audit tamper-evidence (`merkleLog.ts`):** a third-party WORM/log-SaaS approach (F) is not
  a downgrade "in kind" (real CT witnesses are plain servers too) but is a downgrade in
  mathematical tightness (no independent inclusion/consistency proofs) in exchange for
  dropping the Merkle-math implementation and STH-signing key-custody burden; keeping the
  cheap hash-chain while dropping the signature and the Merkle math is a defensible middle
  path.
- **Ratification ledger (`pendingLedger.ts`):** the crypto-substitution question is
  mechanically simple ([§4](#4-same-reasoning-applies-to-ratificationpendingledgerts--with-one-confirmed-correctness-bug-that-any-redesign-must-not-carry-forward)),
  but it must not be conflated with — or used as cover to defer — the pre-existing,
  crypto-independent fail-open bug in the anchor-disjointness predicate it depends on. Fix
  that bug regardless of which passport scheme wins.

**Overall:** every one of these alternatives is a real simplification of *this codebase's*
engineering and key-custody burden. None of them makes cryptography disappear from the
end-to-end system — TLS, and usually someone else's PKI (an IdP's, a payment processor's, a
log vendor's), is still underneath every option. The honest framing to give the author is:
*the goal isn't "zero cryptography anywhere," it's "stop being the party that has to build,
own, and be the single point of failure for a bespoke PKI/CT stack"* — and on that framing,
the financial-stake-via-processor swap (E) is the cleanest, the passport-layer swap (A/B) is
the next cleanest and lowest-regret, and the anchor-binding and audit-log swaps (C/D/F) are
real options but each trades away a specific, nameable guarantee (offline re-verifiability,
mathematical spot-checking, or automated scale) that the team should decide it's willing to
give up with eyes open. Separately, and regardless of that decision: the fail-open
`independentSources` gap in `identity/index.ts` ([§4](#4-same-reasoning-applies-to-ratificationpendingledgerts--with-one-confirmed-correctness-bug-that-any-redesign-must-not-carry-forward))
is a live correctness bug in the current system, not a crypto-choice tradeoff, and should be
fixed on its own timeline.

---

## 6. A second, deeper objection: price the ATTACKER, not the LEGITIMATE OPERATOR

Follow-up author feedback sharpened the ask beyond "remove crypto": **no legitimate
participant should have to pay money to be trusted inside a shared memory they themselves
operate or contribute to in good faith.** This is a different, and arguably more fundamental,
complaint than §1–5 above — it's not about *which* mechanism proves independence, it's about
*who gets charged*.

The hard theorem (CLAUDE.md, "the hard theorem") only requires that **minting a new
independent-looking identity cost an attacker something non-negligible.** It never requires
that the something be *currency*, and it never requires that the cost be charged to everyone
uniformly — including sources that were never adversarial to begin with. Money is simply the
unit the current `ANCHOR_TABLE` happened to price every row in (domain $/yr, KYC fee, hardware
purchase, posted stake). The theorem survives fine if the unit changes, or if the cost is
waived entirely for a class of source that structurally cannot be the attacker the theorem
worries about.

**Four non-monetary substitutes, each pricing a different resource instead of cash:**

- **Time / quarantine (patience as price).** A new source starts at `rep_cap`-ceilinged zero
  influence (this is *already* how `identity/reputation.ts`'s Beta(α,β) ledger works) and only
  earns weight by being repeatedly, independently corroborated over a waiting window — no
  anchor purchase required at all, ever. This is the mechanism already doing the real work in
  the current design; the anchor table's `rep_cap` column is arguably a second, redundant price
  layered on top of it. A shared multi-agent memory could run on reputation-earned-through-time
  alone for every source, monetary anchors optional/absent.
- **Compute (proof-of-work).** Mint a new identity by spending CPU cycles on a puzzle whose
  difficulty is tuned to the threat model. Denominated in electricity, not currency, and paid
  directly to the network rather than to "this app" — closest to a literal transliteration of
  the theorem's own mechanism. Honest caveat: this is still a *price* (an attacker with more
  compute still gets more identities, just slower), and it has a real environmental cost the
  monetary version doesn't externalize as visibly — worth being explicit about that rather than
  presenting it as costless.
- **Vouching / reputation-spend (a web of trust).** An already-trusted source stakes *its own*
  earned reputation to vouch for a new one; if the vouched-for source later misbehaves, the
  voucher's reputation is docked too (not just the new source's). Nobody pays cash — the price
  is paid in social capital that only existing, already-earned-trust participants have to
  spend, and it's spent voluntarily rather than charged at the door. Needs a bounded fan-out and
  decay-per-hop (a voucher shouldn't be able to vouch for 500 sock-puppets at zero marginal
  cost) to resist the same fleet-collapse the anchor table's `operatorClassId` cap defends
  against today.
- **Same-operator structural exemption (zero price, by topology not economics).** If two
  sources in a "multi-agent" shared memory are both run by one operator who already trusts
  both, they are not adversarial to each other by construction — there is no attacker there to
  price. The right treatment is to tag them as a single trust domain (an `operatorId`, exactly
  the same primitive the anchor table already uses for the ISP/registrar *fleet cap* — just
  applied as an explicit allowlist rather than inferred from anchor metadata) and charge
  **nothing** for their mutual "independence," because none is claimed. Pricing only needs to
  apply at the boundary where memory accepts input from a party the operator does *not*
  already control — another org's agent, a public contributor, scraped third-party content.
  This is the single biggest lever for "no one should pay for their own memory": most of what
  the current design prices probably shouldn't be priced at all, because it was never crossing
  a trust boundary in the first place.

**Net recommendation for a shared multi-agent memory where the author's objection is
specifically to charging money:** make TENURE (time-earned reputation) and the SAME-OPERATOR
exemption the default, free path for anything inside the operator's own trust domain; keep
VOUCH available as an opt-in mechanism for admitting a new *external* contributor without
requiring them to buy an anchor; reserve the priced/monetary anchor rows (`DOMAIN`,
`HARDWARE`, `VERIFIED_HUMAN`, `FINANCIAL_STAKE`) strictly for the boundary case — a genuinely
external, not-yet-trusted party who wants in — rather than applying them uniformly to every
source in the system. `FINANCIAL_STAKE` specifically (the one row that is literally "pay us to
be believed") is the most defensible row to drop entirely if the deployment never expects
truly adversarial external contributors; it costs the least to remove (§ per Alternative E
above, its math is already fully decoupled from the rest of the pipeline) and it's the row
closest to the author's actual complaint.

This does not change §1–5's crypto analysis — it composes with it. A crypto-free passport
(A/B) plus a same-operator exemption plus tenure-based reputation would mean **no cryptography
and no money** anywhere in the identity layer for a single-operator multi-agent deployment,
with priced anchors held in reserve only for the day external, less-trusted contributors are
admitted.

---

*No files were modified; this is analysis only, per the task's constraints (no changes under
`src/`).*
