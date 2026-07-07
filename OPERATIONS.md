# Operations

This document covers running Intelligent DB's **daemon mode** — the opt-in,
multi-client backing described in
[`docs/specs/PHASE3_DAEMON_PROPOSAL.md`](./docs/specs/PHASE3_DAEMON_PROPOSAL.md)
(design analysis) and
[`docs/specs/PHASE3_DAEMON_SPEC.md`](./docs/specs/PHASE3_DAEMON_SPEC.md) (the
binding, product-owner-approved security spec — rulings R1-R10, hardening
requirements H1-H6). Read the spec before changing anything below; this file
is the runbook, not the design rationale.

**Daemon mode is permanently opt-in (R7).** The in-process `createAgentMemory()`
default — one process, one `AgentMemory`, one SQLite handle — is unchanged and
remains the default forever. Reach for the daemon only when you actually have
multiple client processes (several IDE windows/agent sessions, a CLI, a
background indexer) that need to share ONE memory instead of each opening its
own SQLite file and fighting over the writer lock.

---

## 1. Starting and stopping the daemon

```sh
npm run build
node dist/daemon/cli.js --db /abs/path/to/memory.db [--socket <path>] [--data-dir <path>]
# or, after `npm link` / a local install:
intelligent-db-daemon --db /abs/path/to/memory.db
```

- `--db` (required): the SQLite file the daemon owns exclusively for the life
  of the process (WAL mode, single writer — the same store `createAgentMemory`
  would open in-process).
- `--data-dir` (optional, default: the db's directory): where the daemon
  writes its **own** state — the user-private owner-token file
  (`daemon-token`), the token registry (`daemon-tokens.json`), and the durable
  R8 audit chain (`daemon-audit.db`, a SEPARATE SQLite file from the memory db
  — see §5).
- `--socket` (optional): POSIX — a filesystem path for the Unix domain socket
  (default `<data-dir>/daemon.sock`). Windows — a friendly named-pipe prefix
  (default `intelligent-db-daemon`); the daemon appends a fresh random suffix
  at every start (R9, see §4) — never pass a fixed pipe name expecting it to
  be reusable across restarts.

**Lifecycle is manual and explicit (R6).** There is no auto-start and no OS
service integration shipped — start it yourself, once, and manage it with
whatever supervises long-running processes on your platform:

- **systemd** (Linux): a standard `Type=simple` unit calling the command
  above, `Restart=on-failure`, `KillSignal=SIGTERM` (the daemon's graceful
  shutdown path — see below). `WorkingDirectory`/`--data-dir` should point at
  a writable, user-private location.
- **Windows service wrapper**: use a service-wrapper tool (e.g. NSSM) or a
  Scheduled Task set to "run whether user is logged on or not," pointing at
  `node.exe dist\daemon\cli.js --db ... --data-dir ...`. Node delivers
  `SIGTERM`/`SIGINT` to the process the same way regardless of how it was
  launched, so the graceful-shutdown path below is unaffected.

**Stopping**: send `SIGINT` or `SIGTERM`. The daemon:
1. Stops accepting new connections (an in-flight `net.connect` attempt during
   this window is destroyed immediately, never served — see the adversarial
   findings in §6).
2. Drains the FIFO write queue (every already-dequeued request finishes and
   gets its response; nothing new is admitted).
3. Closes every client connection.
4. Records a `SHUTDOWN_MARKER` (`clean: true`) to the durable R8 audit chain.
5. Closes the memory store and the audit-chain handle, then exits `0`.

A `SIGKILL` (or a genuine crash) skips all of that — see §7 for what survives.

**Stale-socket recovery (POSIX only, R6):** on start, if `--socket`'s path
already exists, the daemon try-connects it first. A refused connection means
the file is stale (the previous owner died without cleaning up) — it is
removed and a fresh socket is bound. A **successful** connect means a live
daemon already owns that path, and the new process refuses to start rather
than stealing the socket. Windows named pipes never leave a stale filesystem
entry (each start mints a fresh random-suffixed name — R9), so there is
nothing to recover there.

---

## 2. Token lifecycle

**Auto-provisioning (R1):** on first start, the daemon mints an OWNER-grade
bearer token into `<data-dir>/daemon-token` (JSON: `{token, fingerprint,
endpoint, mintedAt}`), best-effort `chmod 0600` on POSIX. On Windows, the
file's privacy comes from the user-profile directory's own ACLs (there is no
POSIX permission-bit equivalent to set — a disclosed, not hidden, gap; see
§4). A client reads the token (and, on Windows, the actual bound pipe
endpoint — see §4) from this file. **Connection without a token is never
identity** — every connection must present one, in every preset, including a
single-user PERSONAL deployment (R1's ruling: "any process running as this OS
user" is not an acceptable floor once multiple agents share one memory).

**Issuing a per-agent token** — over an already-authenticated OWNER-grade
connection, the `issueToken` admin verb:

```jsonc
// -> daemon (after a successful auth handshake on this connection)
{"id": 1, "method": "issueToken", "params": {"grade": "EMAIL_OAUTH", "label": "agent-b"}}
// <- daemon (the RAW token is returned exactly once, in this one response —
//    never logged, audited, or persisted anywhere else; R3)
{"id": 1, "ok": true, "result": {"token": "<64-hex-chars>", "fingerprint": "<sha256-hex>", "grade": "EMAIL_OAUTH"}}
```

`grade` is any `AnchorClass` (see `src/core/types.ts`) — it prices the
resulting `SourceId`'s independence/reputation ceiling through the SAME
crypto-free trust registry every other claim producer bottoms out in
(`identity/trustRegistry.ts`'s `registerDaemonClient`), not a parallel trust
root. **Each distinct token is its own independence class and its own fleet by
default** — two different agent tokens issued to the same OS user do NOT
automatically trust or corroborate each other; group them deliberately via
`fleetClassId` only when your deployment's config has decided they genuinely
share a fleet.

**Revocation (R3, immediate, no restart)** — `revokeToken` drops one token by
fingerprint (never the raw value — that never appears outside the one
`issueToken` response and the one-time client bootstrap read):

```jsonc
{"id": 2, "method": "revokeToken", "params": {"fingerprint": "<sha256-hex>"}}
```

Effective immediately: revocation is a plain in-memory `Set` checked on every
subsequent request — no restart required. Every existing connection
authenticated with that token is dropped (an already-dequeued, in-flight
request finishes and gets its response first — it was authorized when
dequeued; anything still queued-but-not-started for that connection is
discarded).

**"Revoke everything, right now"** — `revokeAllTokens` (no params) invalidates
every issued token EXCEPT the calling connection's own, and re-mints the owner
token file at the current endpoint:

```jsonc
{"id": 3, "method": "revokeAllTokens", "params": {}}
// <- {"ok": true, "result": {"revokedCount": N, "ownerToken": "<new-raw>", "ownerFingerprint": "..."}}
```

Use this after a suspected leak: it does **not** require restarting the
daemon (no availability gap), but every OTHER client (including any MCP
server process backed by the old owner token) will need the freshly returned
token to reconnect.

**`reloadTokens`** re-reads the persisted token registry + revocation set from
disk — useful if you hand-edit `daemon-tokens.json` out-of-band (e.g. a config
management tool provisioning tokens).

All four admin verbs (`issueToken`/`revokeToken`/`revokeAllTokens`/
`reloadTokens`) require an already-authenticated **OWNER-grade** connection;
every other grade gets a typed `ADMIN_FORBIDDEN` error, checked before the verb
name is even dispatched.

**Rotation runbook** (no built-in expiry — tokens are valid until revoked):
1. `issueToken` a new token at the desired grade for the agent being rotated.
2. Deploy the new token to that agent's config/token file.
3. Confirm the agent reconnects successfully with the new token.
4. `revokeToken` the OLD fingerprint.

There is deliberately no "auto-expire after N days" — token lifetime
management is the deployment's job (or a future item), consistent with R3's
scope ("provisioning / rotation / revocation... Admin verbs ... exist").

---

## 3. Scale target (R5)

**v1 target: 10 concurrent clients, low hundreds of requests/sec.** A single
in-process FIFO queue serializes every write (R4: no read-only fast path in
v1 — see `PHASE3_DAEMON_SPEC.md` R4/R5) and that is an acceptable v1
bottleneck **only** at this scale; recall is sub-10ms and serialization is not
the throughput-limiting factor here. **If your workload exceeds this target,
that is the documented trigger to revisit R4** (splitting a read-only path out
of the write queue), not a signal to silently push more load through as-is.

Enforced limits (typed errors, never a silent drop or a hang):
- **Connection cap: 32.** A 33rd connection is refused (`CONNECTION_CAP`)
  before it can even authenticate.
- **Queue depth: 1024 (default).** A request submitted when the queue is
  already at capacity gets a typed `BACKPRESSURE` error — delivered ONLY to
  the submitting connection; every other connection is unaffected.
- **Max line length**: reuses the MCP transport's existing `BoundedLineSplitter`
  ceiling (1 MiB) — an oversized line is discarded and reported, the
  connection is not otherwise disturbed (post-handshake) or is dropped
  (pre-handshake, H1).

---

## 4. Windows vs. POSIX: the compensating controls (R9)

POSIX Unix-domain sockets get real OS-level isolation for free: the socket
file has ordinary POSIX permission bits (owner/mode), so "only this OS user's
processes can even open the path" is enforced by the filesystem, before the
daemon's own auth even runs.

**Windows named pipes do not give you this for free** — `node:net` has no way
to set a restrictive security descriptor on a pipe. Daemon mode ships on
Windows anyway, with two compensating controls instead of pretending the gap
doesn't exist:

1. **A high-entropy random suffix** minted fresh at every daemon start
   (`\\.\pipe\<name>-<32 hex chars>`), written ONLY into the user-private
   token file (`daemon-token`'s `endpoint` field) — never advertised anywhere
   else, never reused across restarts. Discovering the pipe therefore
   requires reading that file.
2. **Mandatory handshake auth (R1)** regardless of transport — even a process
   that somehow guesses or observes the pipe name still needs a valid bearer
   token to do anything.

The residual difference vs. POSIX file permissions is real and is documented,
not hidden: an attacker who CAN read the user-private token file (i.e., is
already running as the same OS user) gets both the endpoint and a valid
token from the same read — at that point Windows offers no additional
narrowing POSIX's mode bits would have. This mirrors the PERSONAL preset's
existing ambient-trust assumption ("any process running as this OS user" is
already the baseline trust level of everything else on that machine) rather
than claiming a stronger guarantee than the platform can deliver.

---

## 5. Restart semantics and what survives a crash (H4)

Verified end-to-end by this pass's crash-torture extension
(`src/daemon/__torture__/daemonKillLoop.ts`, 30+ real `SIGKILL` cycles against
the actual compiled daemon binary — see `BENCH_RERUN_2026-07-06.md` for the
run log):

- **The memory store (strands/edges) is fully crash-consistent.** It rides
  the same SQLite/WAL transactional guarantees the in-process engine always
  had (tick-3's atomic-compound-writes hardening) — the daemon adds nothing
  here and takes nothing away. `PRAGMA integrity_check` passes on every
  reopen across every kill cycle tested.
- **The daemon's OWN audit chain (R8: connection/auth/revocation/admin/
  shutdown events) is durable**, in its own SQLite file
  (`<data-dir>/daemon-audit.db`, distinct genesis from the fact/ratification
  chain) — a fix landed in this pass (see KNOWN LIMITATIONS in `CLAUDE.md` for
  what shipped before it and why). `verifyChain()` on this chain passes on
  every reopen across every kill cycle tested, and it CONTINUES the same
  chain across a restart rather than starting over.
- **The fact/ratification checksum chain is NOT durable when backed by the
  ergonomic `createAgentMemory()` facade** (which the daemon uses) —
  `agent/agentMemory.ts` wires its `PendingLedger` in-memory regardless of
  `dbPath` (its own doc comment: "an open pending is RE-DERIVABLE"). This is a
  pre-existing facade characteristic, not something the daemon introduced or
  could fix without rewiring the whole facade's durability model — it applies
  identically to the plain MCP stdio server today. It resets on every daemon
  restart, clean or crashed, not only under `SIGKILL`. See the KNOWN
  LIMITATIONS addition in `CLAUDE.md`.
- **Client outcome for a request in flight when the daemon dies: UNKNOWN,
  never fabricated.** `daemon/client.ts`'s `createRemoteAgentMemory` surfaces
  a typed `DaemonUnknownOutcomeError` for every request that had no response
  yet when the connection drops — the write may have committed, may not have;
  the client is never told it succeeded or failed when it genuinely cannot
  know. A same-content retry is safe-by-accident (same-`content_hash` floods
  collapse to multiplicity 1) but that property was designed for poisoning
  defense, not retry safety — do not rely on it as an idempotency story (H5).
- **Reconnect-with-backoff** is automatic (`daemon/client.ts`, exponential,
  200ms → 10s ceiling by default) — a client does not need its own retry loop
  for the connection itself, only for deciding what to do about an UNKNOWN
  outcome.

---

## 6. Adversarial findings from this pass (found; fixed where noted)

A full attacker-minded pass (pre-auth verbs, oversized/malformed frames,
slowloris, token-fingerprint-vs-raw discipline, admin-verb escalation,
connecting during shutdown drain) ran against a real spawned daemon process
and real socket/pipe transport
(`src/daemon/__e2e__/adversarial.e2e.test.ts`). Two structural findings from
this pass were fixed (not just noted):

1. **The daemon's own R8 audit chain had no durable implementation** —
   `createDaemonAuditChain()` was in-memory only, and `daemon/cli.ts` wired it
   with no `AppendSink`, so the entire connection/auth/revocation/admin/
   shutdown trail vanished on every process exit, including a crash — exactly
   the moment R3's own "at least post-hoc detectable" rationale needs it most.
   **Fixed**: `src/daemon/auditChainSqlite.ts`, a SQLite-backed drop-in (own
   file, `daemon-audit.db`, never the memory db), wired as the default in
   `daemon/cli.ts`.
2. **Test-support code (the E2E harness, the crash-torture driver) leaked into
   the published `dist/` build** — nested `src/daemon/__e2e__/` and
   `src/daemon/__torture__/` directories were not covered by
   `tsconfig.build.json`'s exclude list (which only excluded the top-level
   `src/__torture__`). **Fixed**: both added to the build exclude list.

Everything else probed (pre-auth verb execution, frame handling, slowloris,
fingerprint-never-raw across every serialized surface, admin escalation,
shutdown-drain connection attempts) was already correctly defended — reported
in the verifier's summary as found-and-already-defended, not silently passed
over.

---

## 7. MCP server integration (current scope)

`mcp/server.ts` supports opting a stdio MCP server instance into daemon-backed
memory via `MEMORY_DAEMON_SOCKET` (the daemon's socket/pipe path) +
`MEMORY_DAEMON_TOKEN_FILE` (a file containing the bearer token — never the
token itself in an env var). On startup it performs a REAL handshake round
trip to validate the daemon is reachable and the token is accepted, bounded by
`DAEMON_STARTUP_TIMEOUT_MS` (8s default) — a daemon that is unreachable or
rejects the token fails startup fast with a clear error rather than silently
falling back to in-process memory.

**Disclosed scope boundary**: full per-request dispatch through daemon-backed
memory is NOT wired in this pass. `AgentMemory`'s interface is synchronous;
`daemon/client.ts`'s `createRemoteAgentMemory` is necessarily asynchronous (a
real socket round trip cannot be made to look synchronous without a native
addon or a `worker_threads`+`Atomics.wait` bridge — the latter was attempted
and empirically rejected; see `daemon/client.ts`'s module doc for the
reproduction). Today, opting into `MEMORY_DAEMON_SOCKET` validates
connectivity and then fails fast with a clear, typed
`DaemonBackingNotWiredError` naming this exact gap — it does not silently
proceed in-process. Wiring full dispatch is a named follow-up item, not a
hidden gap.

---

## Quick reference

| Task | Command / verb |
|---|---|
| Start | `intelligent-db-daemon --db <path> [--socket <path>] [--data-dir <path>]` |
| Stop (graceful) | `SIGINT` / `SIGTERM` |
| Find the owner token | `<data-dir>/daemon-token` (JSON) |
| Issue a per-agent token | `issueToken` (OWNER connection only) |
| Revoke one token | `revokeToken` (OWNER connection only) |
| Revoke everything, re-mint owner token | `revokeAllTokens` (OWNER connection only) |
| Reload token registry from disk | `reloadTokens` (OWNER connection only) |
| Connection cap | 32 (typed `CONNECTION_CAP` error beyond it) |
| Queue depth | 1024 default (typed `BACKPRESSURE` error beyond it) |
