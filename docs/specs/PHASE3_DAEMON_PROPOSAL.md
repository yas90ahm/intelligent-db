# Phase 3 — Daemon Mode (design proposal, NOT approved)

Status: **PROPOSAL ONLY. Zero code shipped with this document.** This is a design
analysis for a future capability, written to be reviewed and argued with, not a
spec ready for implementation. Nothing here is gated, flagged, or wired — there is
no code change in this commit. See the closing section for the explicit
implementation moratorium.

Owner of the underlying question: today's engine is single-process
(`CLAUDE.md`, ACCEPTABLE limitations: "Cross-process / concurrent writers: ...
a second writer is rejected by SQLite's lock, not coordinated"). Multiple client
processes — several MCP stdio server instances (one per IDE window / agent
session), a future HTTP API, a CLI, a background indexer — all want ONE shared
memory. Today each of those would have to open its own `AgentMemory` over the
same SQLite file and fight over the writer lock. A **daemon**: one long-lived
process owns the single `AgentMemory` (and the single writer handle); every
client process becomes a thin transport client of that daemon instead of an
in-process owner.

This document covers: transport, authentication, write serialization, crash
semantics, how the existing MCP stdio server becomes a client, and — the load-
bearing part — the NEW attack surface each transport option opens, enumerated
concretely rather than asserted.

---

## 1. Why this is a security question, not just a plumbing question

The single most important sentence in `CLAUDE.md`'s KNOWN LIMITATIONS is this
one, about the crypto-free rebuild's asserted-attribution trade-off:

> Inside one process consuming a configured IdP/registry this changes nothing
> (the process was always the trust boundary ... ); what is GONE is third-party
> non-repudiation.

**"The process was always the trust boundary" is the sentence a daemon deletes.**
Today, `signerSourceId` / caller identity is asserted rather than proven, but
that assertion happens ONCE, inside a single OS process that a single OS user
started, with a single call stack. There is no second party inside that process
to lie to it. A daemon serving N client processes reintroduces exactly the
problem the crypto-free rebuild set aside as "not our problem, the process
boundary covers it": **the daemon must now decide, for every inbound request,
which caller sent it** — a question the single-process design never had to ask.

This is not a new category of problem for this codebase. It is the SAME
"identity is asserted, not proven, and must come from outside the graph"
problem the Source-Identity Layer already solves for *fact* provenance,
recurring one layer down, for *transport* provenance. The design principle
this document tries to honor is: **do not invent a second, ungoverned trust
root for daemon callers that runs parallel to `identity/trustRegistry.ts`.**
Whatever mechanism identifies a daemon caller should terminate in the SAME
swappable trust registry that already prices OWNER / SSO_TENANT_MEMBER /
SYSTEM_OF_RECORD / etc., not a bespoke "connection = trusted" shortcut that
bypasses it.

---

## 2. Transport options (node builtins only — zero new runtime deps)

Two realistic families, both buildable from `node:net` / `node:http` alone.

### 2a. Named pipe (Windows) / Unix domain socket (POSIX) — via `node:net`

`net.createServer().listen(path)` already speaks both: a filesystem path on
POSIX (a Unix domain socket, a real inode) and a `\\.\pipe\name` path on
Windows (a named pipe) — same Node API, platform-appropriate address. The
existing `BoundedLineSplitter` + line-delimited JSON-RPC framing from
`src/mcp/server.ts` is transport-agnostic and drops in unchanged: a socket
connection is just another duplex stream to feed chunks into.

Properties:
- **No wire protocol to design or parse** beyond what already exists (reuse
  the JSON-RPC line framing verbatim).
- **Default isolation comes from the filesystem/OS**, not from the app: a Unix
  socket file has normal POSIX permission bits (owner/group/mode), so "only
  this OS user's processes can even open the path" is the OS's job, for free,
  on POSIX. Windows named pipes carry a security descriptor too, but Node's
  `net` module does not expose a way to SET one (see §5 — this is a concrete
  gap, not a strength, on Windows).
- **Not reachable from a browser.** No web page, no `fetch`, no XHR can open a
  Unix socket or a Windows named pipe. This closes off an entire attacker
  class (see §5) that loopback HTTP cannot close off by construction.
- **Not exposed by typical container/VM port-forwarding.** `docker run -p` and
  SSH `-L` tunnel TCP ports; they do not, by default, forward a named pipe or
  a bind-mounted socket path unless someone deliberately shares the directory.

### 2b. Localhost HTTP — via `node:http`

`http.createServer().listen(port, "127.0.0.1")`. Familiar tooling (curl,
browser devtools, any HTTP client), easy to add a REST-ish surface later.

Properties:
- **TCP loopback has no per-user ACL.** Any local process — including one
  running as a *different* OS user on a shared/multi-user box — can connect
  to `127.0.0.1:PORT`. A Unix socket file's mode bits give you free per-user
  isolation; a loopback TCP port does not, unless the app adds its own
  authentication (see §3) to compensate — the transport gives you strictly
  less isolation for free.
- **Reachable from a browser.** Any web page open in a browser on the same
  machine can issue a "simple request" (`fetch`/`XHR`/`<form>` POST with a
  content-type CORS treats as simple, e.g. `text/plain` or
  `application/x-www-form-urlencoded`) to `http://127.0.0.1:PORT/...`.
  Same-origin policy blocks the PAGE from *reading* the response, but it does
  **not** block the request's *side effect* from happening — the write still
  lands. This is the classic "attack against localhost services" pattern
  (real-world instances: Zoom's 2019 local web server, many localhost dev-tool
  CVEs). A Unix socket/named-pipe transport is immune to this by construction;
  HTTP is not, and mitigating it (Origin/Referer checks, CSRF tokens,
  same-site cookies) is extra app-level work this project would have to build
  and maintain.
- **One fat-finger from remote exposure.** `listen(port, "127.0.0.1")` vs
  `listen(port)` (which defaults to all interfaces) is a one-character-adjacent
  mistake with a totally different blast radius: the former is local-only,
  the latter is reachable from the whole network. This is a systemic risk
  *of choosing HTTP as the base*, independent of how carefully v1 is coded —
  it is the shape of mistake that keeps recurring industry-wide for exactly
  this class of "localhost API" service.
- **No free encryption.** `node:https` exists, but a localhost daemon
  presenting a self-signed cert has no CA to anchor trust in without either
  shipping a fixed keypair (a supply-chain artifact to manage) or generating
  one at first run and having every client pin it out-of-band — real
  operational weight for a property (confidentiality against another process
  on the SAME machine) the Unix-socket/named-pipe path gets from OS-level
  transport isolation without any of this machinery. (To be fair: plaintext
  Unix-socket traffic is also readable by anything that can attach a debugger
  or read `/proc`/kernel memory as root — HTTP-without-TLS is not uniquely
  bad here, it's just that HTTP's ecosystem creates an expectation of "add
  TLS later" that has real cost.)

**Conclusion for this section:** the socket/pipe family is smaller attack
surface by construction (no browser reachability, no accidental network
exposure, native per-user isolation on POSIX) at the cost of being less
familiar/tooling-friendly. See §7 for the recommendation.

---

## 3. Authentication — the process trust boundary dissolves

This is the crux. Once N client processes share one daemon, "which process
is this" and "what is that process allowed to do" become the daemon's job.
Node builtins give us **less** than intuition suggests here:

- **True OS-level peer credentials are NOT available from node builtins.**
  On Linux, `SO_PEERCRED` on a Unix domain socket gives the kernel-verified
  uid/gid/pid of the connecting process — this WOULD be a real, unforgeable
  identity signal — but `node:net` does not expose it; obtaining it requires
  a native addon (`getsockopt`) or shelling out to something like `lsof`/
  `/proc/net/unix` correlation (fragile, racy, and still not exposed as a
  clean API). Windows named pipes have an equivalent
  (`GetNamedPipeClientProcessId` / `ImpersonateNamedPipeClient`), also not
  exposed by `node:net`. **Under the zero-new-runtime-dependencies constraint,
  this project cannot cryptographically identify the OS process on the other
  end of the pipe.** This is worth stating plainly because it is the single
  biggest reason daemon-mode auth is weaker than it sounds: we are choosing
  between "OS filesystem permission on the socket path" and "an asserted
  bearer credential," never "verified peer process identity," unless a future
  change accepts a native-addon dependency exception (an explicit open
  question in §8).

- **Option A — path permission is the entire gate ("whoever can open the
  socket is in").** On POSIX, chmod the socket 0600 owned by the daemon's OS
  user; any process running as that user can connect, nothing else can. This
  maps naturally onto the PERSONAL preset (the deployment owner IS the trust
  root, and on a single-user machine "any process running as me" is already
  the ambient trust level of literally everything else on that machine —
  no weaker than today). It maps poorly onto multi-tenant/ENTERPRISE or onto
  "I want two different AI agents running as my own OS user to NOT
  automatically trust each other with OWNER-grade write access" — a real
  scenario once agents are commonplace, and Windows named pipes don't even
  give you this much for free (see §5).

- **Option B — bearer credential, resolved through the EXISTING trust
  registry.** Each client presents a token (config-provisioned, e.g. a file
  only the OS user can read, analogous to how `~/.ssh` keys or `~/.netrc`
  are conventionally protected) on connect. The daemon maps
  `token → SourceId` through a registry entry that is **just another claim
  producer bound into `identity/trustRegistry.ts`** — conceptually
  `registerDaemonClient(token) → SourceRef` sitting alongside
  `registerOwner`/`registerSsoMember`/`registerSystemOfRecord`, priced at
  whatever anchor grade the deployment's config decides (a personal-tier
  daemon might price every locally-issued token at OWNER grade if the
  deployment owner is the only human involved; an enterprise daemon would
  price a token minted from a verified SSO session at SSO_TENANT_MEMBER,
  exactly like today). This is the option that avoids creating a second,
  parallel trust root: caller identity still bottoms out in the one
  registry CLAUDE.md already calls the swappable trust root, not in an
  ad hoc "the daemon trusts connections" rule.

  The trade-off is explicit and should be named exactly like the existing
  asserted-attribution one: **a bearer token, once issued, IS the caller's
  identity for daemon purposes — asserted, not proven** (identical shape to
  `signerSourceId` in the audit chain). A leaked token lets any local process
  fully impersonate that caller's registered `SourceId` and inherit its
  reputation/anchor weight — which is a **larger** blast radius than the
  existing asserted-attribution trade-off, because it doesn't just let an
  attacker mis-attribute one write to a checksum chain (detectable via
  `chainHead()`/`AppendSink` divergence, per the existing mitigation) — it
  lets them ACT as a trusted source going forward, minting new facts that
  quarantine or bypass depending on that source's ingest tier. Mitigation
  should mirror what already exists for the audit chain rather than invent
  something new: log every accepted daemon connection (claimed token /
  resolved SourceId / timestamp / peer transport info the OS DOES give us —
  e.g. the connecting file descriptor's local address) into the SAME
  tamper-evident ledger machinery (`AppendSink`/`chainHead()`), so a
  compromised-token spree is at least POST-HOC detectable and attributable
  to a time window, even though it cannot be prevented outright. Detection-
  not-prevention, consistent with how this project already treats the
  identity-is-priced-not-prevented theorem.

- **What NOT to do:** treat "it connected to the socket" as identity by
  itself with no token layered on top, in any preset broader than a
  single-user PERSONAL deployment — that degrades to Option A's ambient-trust
  model silently, without it being a documented, deliberate choice.

---

## 4. Write serialization

Today, a compound operation (`writeFact`, `adjudicate`, `approve`,
`downstreamDisownSweep`, `ratify`) runs inside one `withTxn` over the SQLite
`DatabaseSync` handle — and `node:sqlite`'s `DatabaseSync` API is
**synchronous**. That single fact is what makes serialization tractable
without a lock library: as long as a request's entire compound operation runs
from start to commit with no `await` in between (true today, since it's a
straight synchronous call chain), Node's single-threaded event loop cannot
interleave a second request's writes into the middle of it — there is no
tick boundary for another callback to run.

The daemon's obligation is narrower than "implement a mutex": it is **"never
let two client requests' handling code interleave a synchronous compound
operation with an `await` in between."** Concretely:
- A single **in-process FIFO request queue**, fed by all client connections'
  incoming lines. The daemon pulls one request, runs it to full completion
  (response computed, response written back to the OWNING connection), THEN
  pulls the next. No `Promise.all`/concurrent dispatch across requests.
- This is strictly ordering, not locking — no new primitive needed, no new
  dependency. The risk to actively guard against in review is a well-meaning
  future change that makes some request handler `async` and awaits something
  (a network call, a timer) BEFORE its SQLite writes are done — that would
  reopen a real interleaving window that doesn't exist today.
- **Fairness / starvation is an open question, not solved here**: a single
  FIFO queue serializes READS behind WRITES too, even though SQLite's WAL
  mode supports concurrent readers. Splitting a read-only fast path out of
  the write queue is a legitimate future optimization but changes the
  concurrency model and needs its own review — flagged in §8, not decided
  here.

---

## 5. Crash semantics for in-flight client requests

Two failure moments to reason about separately:

1. **Crash mid-transaction (inside a compound op).** Unchanged from today:
   the write is inside one SQLite transaction; a crash before `COMMIT`
   leaves nothing durable (WAL recovery on reopen restores to the last
   committed state — this is exactly tick-3's atomic-compound-writes
   guarantee, and the daemon doesn't touch it). The NEW wrinkle is purely
   about the **client's knowledge**: the requesting client process is a
   separate OS process talking over a socket; if the daemon dies before
   sending the response, the client sees "connection closed with no
   response" and cannot locally distinguish "the write never started,"
   "the write committed and only the response was lost," and "the write
   was rolled back." All three are real possibilities and the daemon
   cannot resolve the ambiguity for a dead connection.
   - **Guidance for clients, not solved by this document:** treat a
     response-not-received-before-disconnect as UNKNOWN, not FAILURE.
     Blind retry of a `remember`-shaped call is not automatically safe
     (it is not naturally idempotent) UNLESS the caller supplies a
     stable content-derived key the write path already partially gives
     for free — same-root/same-`content_hash` floods already collapse to
     multiplicity 1 in today's engine, which happens to make a same-payload
     retry safe-by-accident for `writeFact`, but that property was designed
     for a different reason (poisoning-flood defense) and should not be
     silently relied upon as THE retry-safety story without an explicit
     idempotency-key design (open question, §8).
2. **Crash while requests are queued but not yet started.** The FIFO queue
   from §4 is in-process memory, not durable. Anything queued-but-unstarted
   at crash time is simply gone — no different in kind from today's
   single-process story (a crashed MCP stdio process had nothing queued
   either, because it had no concurrent callers), but different in **blast
   radius**: today, one client process crashing/misbehaving affects only
   that client's own session. In daemon mode, if the DAEMON itself crashes
   (not a client), **every connected client loses its in-flight work
   simultaneously** — a shared-fate change worth naming explicitly to
   whoever signs off on this, since it turns "one client's bug" into
   "N clients' outage" for the first time in this project's history.

Nothing here weakens the existing durability guarantees at rest (SQLite
transaction atomicity, `verifyChain()`, `integrityCheck()` are all unaffected
— the daemon is purely a NEW layer of client-facing uncertainty sitting in
front of guarantees that don't change).

---

## 6. How the MCP stdio server becomes a client

Today (`src/mcp/server.ts`): one OS process reads stdio, constructs a real
`AgentMemory` via `createAgentMemory()`, and calls the pure
`handleMcpRequest(req, memory)` directly — the transport is described in its
own header as "the thin stdio transport," and the module explicitly separates
"pure handler" from "I/O seam" for exactly this reason (testability).

That separation is what makes this migration cheap in shape (not proposing
to write it here, just noting the seam already exists): `handleMcpRequest`
takes an `AgentMemory`-shaped object and never reaches into transport
details. Daemon mode would introduce a `RemoteAgentMemory` that implements
the SAME `AgentMemory` interface but proxies each method
(`remember`/`recall`/`listPendingQuestions`/`resolvePending`/etc.) as one
request/response round trip over the daemon socket/pipe, instead of calling
straight into `createIntelligentDb`. `mcp/server.ts` would then choose, at
startup (env var or config, mirroring the existing `MEMORY_DB` env-var
pattern), between `createAgentMemory({ dbPath })` (today's in-process owner,
default, unchanged) and `createRemoteAgentMemory({ socketPath, token })`
(new, opt-in) — with `handleMcpRequest` itself needing ZERO changes either
way, because it only ever depended on the `AgentMemory` interface, never on
how it's backed.

This also means: multiple MCP stdio server PROCESSES (one per IDE window,
one per agent session — the actual motivating scenario for wanting a daemon
at all) become concurrent daemon clients, each with its own token/identity
resolved through §3's registry-backed auth, each still speaking the exact
same JSON-RPC-over-newlines protocol to its own stdin/stdout that agent
clients already expect — the daemon's existence is invisible above the
`mcp/server.ts` seam.

---

## 7. Recommendation

**Unix domain socket / Windows named pipe transport, bearer-token
authentication resolved through the existing trust registry, single
in-process FIFO write-serialization queue, no new runtime dependencies.**

Reasoning, briefly: §2's enumeration shows the socket/pipe family closes off
an entire attacker class (browser-reachable localhost HTTP) and gets
free per-OS-user isolation on POSIX that a TCP port cannot match without
extra app-level auth anyway — so even in the localhost-HTTP world you would
need to build the SAME token-auth layer §3 already requires, but you'd
ALSO inherit HTTP's browser-reachability and network-exposure risks on top
of it for no offsetting benefit at this stage (no external/remote client is
in scope). §3 already establishes that real OS-level peer-identity
verification isn't available from builtins either way, so the auth story is
bearer-token-based regardless of transport choice; picking the socket/pipe
family is strictly the smaller-surface option for the SAME auth cost.
Concretely this means: reuse the JSON-RPC line framing and
`BoundedLineSplitter` already shipped; add a registry-backed token→SourceId
claim producer next to the existing ones rather than a parallel auth system;
keep the daemon a pure ordering queue in front of the unchanged
`withTxn`-guarded compound operations; ship a `RemoteAgentMemory` adapter so
`mcp/server.ts` and `handleMcpRequest` need no logic changes, only a new
backing implementation choice.

This recommendation is a starting POSITION for review, not a decision — see
below.

---

## 8. Open questions — AWAITING PRODUCT-OWNER SECURITY REVIEW — do not implement

The following must be explicitly resolved by a product-owner security review
before any of this is built. None of them have a default answer in this
document; several have real tension between usability and the "no ungoverned
second trust root" principle in §1.

1. **Is "any process running as this OS user" (Option A, §3) an acceptable
   authentication floor for the PERSONAL preset, or does even a single-user
   deployment need per-agent tokens** (e.g., two different AI agent
   processes running as the same OS user, that should NOT automatically
   trust each other with OWNER-grade write access to shared memory)?
2. **Is a native-addon dependency exception ever acceptable** to obtain real
   OS-level peer-credential verification (`SO_PEERCRED` / named-pipe client
   process identity), given the project's zero-new-runtime-dependency rule —
   or must daemon auth remain asserted-bearer-token-only permanently, with
   that trade-off documented and accepted the way `signerSourceId` already
   is?
3. **Token provisioning, rotation, and revocation UX** — who/what manages the
   token file, how are tokens rotated without an availability gap, and is
   there a fast "revoke everything, right now" path if a token leaks (does
   that require a daemon restart, and what happens to that restart's
   in-flight requests per §5)?
4. **Should read-only requests bypass the single write-serialization queue**
   for latency, given SQLite WAL permits concurrent readers — and if so, how
   do we prove that doesn't reopen a torn-read window against an in-flight
   compound write (this document deliberately did NOT design that split;
   §4 keeps everything serialized as the conservative default)?
5. **What's the target concurrent-client count and throughput**, and is a
   naive single FIFO queue an acceptable v1 bottleneck, or does that number
   change the transport/serialization recommendation above?
6. **Daemon lifecycle** — who starts/stops it (manual, auto-start on first
   client connection, OS service manager integration — systemd unit /
   Windows service), and what happens to already-connected clients across a
   deliberate restart (upgrade, config change)? Out of scope for this
   document but blocks any real rollout.
7. **Should this ship as an opt-in flag with today's single-process,
   single-owner-`AgentMemory` behavior remaining the permanent default**
   (mirroring the `ingest?: IngestPolicy` / `quarantineThreshold: 0`
   escape-hatch pattern already used elsewhere in this codebase), or is
   there a deployment shape where daemon mode should eventually become the
   default?
8. **How should daemon connection/auth events relate to the existing audit
   ledger** — appended to the SAME hash chain as fact/ratification records
   (co-mingled), a separate chain with its own `chainHead()`, or routed
   through the same `AppendSink` mechanism as a distinct record kind? This
   affects both the tamper-evidence story in §3 and the operational cost of
   shipping/monitoring it.
9. **Cross-platform parity** — given §2a's finding that Node's `net` module
   cannot set a restrictive security descriptor on a Windows named pipe
   (unlike POSIX socket file permissions), is a Windows-specific
   compensating control required (e.g., an application-level ACL check using
   only builtins, if one exists) before daemon mode can be considered
   equally safe on both platforms, or is Windows daemon mode gated on
   resolving this?
10. **Is localhost HTTP ever justified as an ADDITIONAL, later transport**
    (e.g., because some future client genuinely cannot open a named
    pipe/socket — a browser extension, a sandboxed environment) — and if so,
    what compensating controls (Origin/Host header allowlisting, a CSRF-style
    per-request token distinct from the bearer credential, binding
    strictly to `127.0.0.1` with an explicit refusal to bind any other
    interface) would be mandatory rather than optional?

**No implementation, flag, config surface, or code change should proceed
until this section is explicitly reviewed and these questions are answered
or formally deferred by the product owner responsible for security
sign-off.**
