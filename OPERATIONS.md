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

§8 (backup, restore, chain verification) is the exception to the daemon-only
scope above — it applies to any SQLite-backed deployment, in-process or
daemon.

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
§4). A raw daemon client reads the `token` field (and, on Windows, the actual
bound pipe `endpoint` — see §4) from this JSON file. **Do not point MCP at
this JSON file** — see §7: `MEMORY_DAEMON_TOKEN_FILE` must contain the raw
bearer token only. **Connection without a token is never identity** — every
connection must present one, in every preset, including a single-user PERSONAL
deployment (R1's ruling: "any process running as this OS user" is not an
acceptable floor once multiple agents share one memory).

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
- **The fact/ratification checksum chain IS durable when the daemon (or MCP)
  uses `createAgentMemory({ dbPath })`.** The facade shares one SQLite handle
  across the strand store, reputation ledger, and `createSqlitePendingLedger`
  (Wave-1 `approve-desync-default-facade` fix — see `agent/agentMemory.ts`).
  Open disputes and the audit checksum chain survive a clean or crashed
  restart with the memory db. The in-memory pending ledger remains only when
  `dbPath` is omitted (the fast non-durable default; an open pending is
  RE-DERIVABLE by re-running `adjudicate` over the same LIVE members).
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

## 7. MCP server integration — daemon-backed, WIRED end-to-end (PHASE3B_MCP_ASYNC_SPEC.md)

`mcp/server.ts` supports opting a stdio MCP server instance into daemon-backed
memory via `MEMORY_DAEMON_SOCKET` (the daemon's socket/pipe path) +
`MEMORY_DAEMON_TOKEN_FILE` (a file whose entire contents are the raw bearer
token — trimmed; never the token itself in an env var). **Do not point
`MEMORY_DAEMON_TOKEN_FILE` at the auto-provisioned `<data-dir>/daemon-token`
JSON** (`{token, fingerprint, endpoint, mintedAt}`): `resolveDaemonConfig`
reads the file as the bearer string verbatim (`src/mcp/server.ts`), so a JSON
blob fails auth. Extract the `token` field into a separate raw-token file
(the e2e harness writes exactly that shape as `mcp-daemon-token` in
`src/daemon/__e2e__/support.ts`). On Windows, set `MEMORY_DAEMON_SOCKET` to
the `endpoint` field from that same JSON (the random-suffixed named pipe —
§4), not a guessed `\\.\pipe\...` prefix. On startup the server performs a
REAL handshake round trip to validate the daemon is reachable and the token
is accepted, bounded by `DAEMON_STARTUP_TIMEOUT_MS` (8s default) — a daemon
that is unreachable or rejects the token fails startup fast with a clear
error rather than silently falling back to in-process memory.

**Full per-request dispatch is wired.** The binding design decision
(`docs/specs/PHASE3B_MCP_ASYNC_SPEC.md`): a synchronous bridge over async
socket I/O stays off the table (a real `worker_threads`+`Atomics.wait` stall
under genuine socket I/O was reproduced and is documented in
`daemon/client.ts`'s module doc) — instead the MCP handler's dispatch went
ASYNC, once, everywhere. `mcp/handler.ts`'s `handleMcpRequestAsync` is the
SINGLE dispatch implementation (no duplicated switch) against a narrow
`AsyncAgentMemory` contract (`mcp/asyncMemory.ts`): the in-process default
path wraps the synchronous facade via the trivial `syncToAsyncMemory` adapter
(awaiting an already-resolved value costs one microtask tick, not a socket
round trip); the daemon-backed path hands `daemon/client.ts`'s
`createRemoteAgentMemory(...)` straight through — its `RemoteAgentMemory`
already satisfies `AsyncAgentMemory` structurally, no bridge, no adapter.
`mcp/server.ts`'s `processLine`/`main()` are `async` and await each response
before writing it and before looking at the next line, serializing requests
over the single stdio connection (mirroring the daemon's own FIFO queue).

Once `MEMORY_DAEMON_SOCKET`/`MEMORY_DAEMON_TOKEN_FILE` validate at startup, a
real `RemoteAgentMemory` connection serves every request for the life of the
MCP server process. Multiple MCP server processes (or MCP clients, or a mix of
MCP + a raw daemon client) pointed at the SAME daemon share the SAME
underlying memory — verified end-to-end (`daemon/__e2e__/mcpDaemonBacked.e2e.test.ts`):
a real daemon process, a real MCP server process driven over its real stdio
JSON-RPC protocol — remember → recall (citation + fact_state over the wire) →
a second identity contradicts it (a genuine multi-class dispute, resolved via
`adjudicate()` over a raw OWNER-grade admin connection — `adjudicate` is a
trust-mutating verb and is deliberately NOT one of the five tools the MCP
surface exposes) → `list_pending_questions` renders it WITH a confirmation
token → `resolve_pending` without the token is REJECTED (the Wave-2
consent-token binding, preserved unchanged and enforced CLIENT-SIDE inside the
MCP server process — a rejected attempt never even reaches the daemon) and
WITH it SUCCEEDS → a SECOND, independent MCP server process (its own daemon
connection, its own identity) sees the resolved fact.

**The five admin-only trust-mutating verbs stay off the MCP surface.** The MCP
tool list only ever exposes `remember`/`recall`/`list_pending_questions`/
`resolve_pending`/`why_do_you_believe_this` — none of `registerSource`/
`disown`/`approve`/`adjudicate`/`ratify`. The daemon's OWNER-grade gate on
those five verbs is unaffected by this wiring: the MCP server is a CLIENT like
any other and only ever calls the non-mutating verbs over the wire.

**`resolve_pending` is the one MCP tool that IS a trust-mutating verb, and is
now gated too.** It drives the daemon's `resolvePending` wire method, which
internally runs an unconditional owner-override `approve()`. A 2026-07-07
re-audit found this verb had been left OUT of `TRUST_MUTATING_VERBS` — the
fix added five verbs to that gate but missed the sixth — so ANY authenticated
connection at ANY grade could force-resolve any open dispute, and the
resulting audit record always misattributed the decision to OWNER regardless
of who actually called. Fixed the same day: `resolvePending` is now gated
identically to the other five (`src/daemon/__tests__/trustMutationGate.test.ts`).
**Practical effect for MCP deployments:** a daemon-backed MCP server only
retains `resolve_pending`'s owner-override power if the token it was started
with is itself OWNER-grade — exactly the shape §1/§2 above describe (the
auto-provisioned owner token, or a token you deliberately issued at OWNER
grade). An MCP server started with a lower-grade per-agent token now gets a
`DAEMON_ERR_INSUFFICIENT_GRADE` rejection on `resolve_pending` instead of
silently succeeding with borrowed owner authority.

---

## 8. Backup, restore, and chain verification

This section applies to any SQLite-backed deployment, daemon or in-process — backup and restore
live in `store/backup.ts`, underneath the daemon, not inside it. It also covers the two
chain-verification surfaces the daemon adds on top: mandatory startup self-verification and the
on-demand `verifyChains` admin verb.

### 8.1 What there is to back up

A running deployment has up to two durable SQLite files:
- **The memory db** (`--db`) — strands, edges, indexes, and, when the default
  `createAgentMemory({ dbPath })` facade wires it onto the same handle, the fact/ratification
  checksum chain (`ratification_records`).
- **The daemon's own audit chain** (`--data-dir`'s `daemon-audit.db`, daemon mode only) —
  connection/auth/revocation/admin/shutdown events, a separate genesis from the fact chain.

Back up both if you run the daemon. A pure in-process deployment only has the first.

### 8.2 Snapshot cadence

`snapshotDb(db, destPath, { chainHead })` (`store/backup.ts`) takes an online, consistent copy via
`VACUUM INTO` plus a fsynced sidecar manifest (`<destPath>.manifest.json`: `createdAt`,
`chainHead`, `userVersion`, `schemaHash`). It does not block writers beyond the time the copy
itself takes, so it is safe to run against a live handle.

There is no built-in scheduler — call it from cron / a systemd timer / Windows Task Scheduler.
A reasonable starting cadence for a single-owner or small-team deployment is one snapshot a day
(off-peak) plus WAL archiving running continuously in between (§8.3), so point-in-time restore
never has to replay more than a day of segments. Tighten it if your tolerance for lost history is
smaller than that, or if the memory db grows large enough that a day of WAL segments would be
slow to replay.

Copy the resulting file and its `.manifest.json` off-host. A snapshot that never leaves the
machine it was taken on protects against corruption, not against losing the machine.

### 8.3 WAL-archive layout

`createWalArchiver(db, { dir, intervalMs? })` maintains a directory that looks like this:

```
<dir>/
  base.db              # plain byte copy of the live file, taken once, at first activation
  base.meta.json        # { createdAt, userVersion }
  seg-000001.wal         # archived WAL segment, oldest first
  seg-000001.meta.json    # { seq, walFile, checkpointedAt, userVersion, chainHead }
  seg-000002.wal
  seg-000002.meta.json
  ...
```

`base.db` is a plain copy, deliberately never a `VACUUM INTO` output — see the module doc in
`store/backup.ts` for the empirical reason a defragmented base can't safely take a spliced-on WAL
segment. Segments are copied out before each checkpoint truncates the live `-wal` file, so nothing
committed is ever lost between one archive cycle and the next.

Call `.checkpoint()` on a timer (`intervalMs`) or after N writes, whichever cadence fits your
write volume — every call either archives one segment or is a no-op if nothing is pending.
`.listSegments()` gives you the full ordered history; `.close()` stops the timer, if one is
running, without touching anything already archived.

### 8.4 Restore runbook

1. Locate the most recent snapshot (`destPath` + its `.manifest.json`) and the WAL-archive
   directory that has been running since before that snapshot was taken.
2. Pick the target timestamp `t` (usually "now," for disaster recovery; an earlier point for
   "undo a bad write").
3. Call `restoreToTimestamp(snapshotPath, walArchiveDir, t, outputPath, { chainVerifier })`.
   - `chainVerifier` is a `(restoredDb) => { ok, firstBrokenSeq, chainHead }` callback — wire it
     to a `PendingLedger`'s `verifyChain()`/`chainHead()` against the just-restored file. Pass one
     whenever the source deployment ever carried ratification history: if the reconstructed
     database has any `ratification_records` rows and no verifier was supplied, the restore
     throws `UnverifiedLedgerRestoreError` rather than handing back an unverified chain silently.
   - The call reconstructs from the archive directory's own `base.db` plus every segment up to
     `t`, cross-checks the snapshot's manifest (`userVersion`, and — if the snapshot predates `t`
     — that the reconstruction can reach at least the snapshot's recorded `chainHead`), and runs
     `PRAGMA integrity_check`.
4. On any verification failure, the partially-written output is deleted before the error is
   thrown — never leave a half-restored file that could be mistaken for a good one.
5. On success, point `--db` at `outputPath` (daemon mode) or your app's `dbPath` (in-process) and
   start normally.

Restoring the daemon's own audit chain (`daemon-audit.db`) is the identical recipe against that
file, if you archive it separately; most deployments treat it as replaceable operational history
rather than something to restore bit-for-bit, since it records the daemon's own connection/admin
trail, not user data.

### 8.5 Chain verification: startup and on-demand

Every daemon start self-verifies **both** checksum chains — its own audit chain and the shared
memory db's fact/ratification chain — before opening the listener (`cli.ts`'s
`verifyChainsAtStartup`). A broken chain refuses to start the daemon at all
(`ChainVerificationFailedError`, naming which chain and the first broken seq), on the reasoning
that serving from a database that already failed its own integrity check is worse than refusing
to serve. If you hit this on a real deployment, that is the signal to restore from the most recent
snapshot + WAL archive (§8.4), not to work around the refusal.

For on-demand re-verification without a restart, any OWNER-grade connection can call the
`verifyChains` admin verb:

```jsonc
{"id": 1, "method": "verifyChains", "params": {}}
// <- {"id": 1, "ok": true, "result": {
//      "daemonChain": {"ok": true, "firstBrokenSeq": null, "chainHead": {...}},
//      "factChain": {"ok": true, "firstBrokenSeq": null, "chainHead": {...}}
//    }}
```

Both verb calls are recorded as an admin-verb event in the daemon's own audit chain, so a
scheduled `verifyChains` sweep is itself part of the audit trail.

### 8.6 Health and status

Any authenticated connection, at any grade, can call `status` (or its alias `ping`) — this verb
bypasses the FIFO write queue entirely, so a slow or stuck write never blocks a health check.

**Fixed 2026-07-07 (Wave 4): `status`/`ping` itself used to be able to stall the daemon**, despite
bypassing the write queue. `factChainHead()` — one of the fields in the response below — used to be
called inline on every poll, and that callback opens a fresh `SqlitePendingLedger` connection whose
constructor synchronously rebuilds the whole ratification-ledger open-dispute index; polling
`status` frequently (which is what this section recommends) re-triggered that rebuild on every
poll, blocking every other connected client's I/O for its duration. Fixed: `factChainHead()` is now
read from an in-memory cache, refreshed once at daemon startup and then on a background timer
(`factChainHeadRefreshMs`, default 5000ms) — `status`/`ping` never calls the slow path inline again.
Regression coverage: `src/daemon/__tests__/server.test.ts`'s `"DaemonServer: factChainHead caching"`
block. The `factChainHead` value in a `status` response can therefore lag a just-completed write by
up to the refresh interval; `daemonChainHead` (the daemon's own audit chain) is unaffected and stays
live. If you need a guaranteed-fresh chain head rather than the cached one, use the `verifyChains`
admin verb (§8.5 above), which always reads live instead of from this cache.

```jsonc
{"id": 1, "method": "status", "params": {}}
// <- {"id": 1, "ok": true, "result": {
//      "connectionCount": 3,
//      "queueDepth": 0,
//      "uptimeMs": 184203,
//      "daemonChainHead": {"seq": 41, "headHash": "..."},
//      "factChainHead": {"seq": 128, "headHash": "..."}
//    }}
```

Poll this from whatever monitors the daemon process. A climbing `queueDepth` that never drains is
the signal to look at R4 (§3) — the single serialized write queue is a known v1 bottleneck, not a
bug, but it is one your monitoring should be watching for.

---

## Quick reference

| Task | Command / verb |
|---|---|
| Start | `intelligent-db-daemon --db <path> [--socket <path>] [--data-dir <path>]` |
| Stop (graceful) | `SIGINT` / `SIGTERM` |
| Find the owner token | `<data-dir>/daemon-token` (JSON: use `token`; on Windows also `endpoint`) |
| MCP daemon token file | Separate file with raw bearer only — not the JSON `daemon-token` (§7) |
| Issue a per-agent token | `issueToken` (OWNER connection only) |
| Revoke one token | `revokeToken` (OWNER connection only) |
| Revoke everything, re-mint owner token | `revokeAllTokens` (OWNER connection only) |
| Reload token registry from disk | `reloadTokens` (OWNER connection only) |
| Health check | `status` / `ping` (any authenticated grade, bypasses the write queue) |
| Re-verify both chains on demand | `verifyChains` (OWNER connection only) |
| Snapshot the memory db | `snapshotDb(db, destPath, opts)` (`store/backup.ts`) |
| Archive WAL segments continuously | `createWalArchiver(db, { dir, intervalMs? })` (`store/backup.ts`) |
| Point-in-time restore | `restoreToTimestamp(snapshotPath, walArchiveDir, t, outputPath, opts)` (`store/backup.ts`, §8) |
| Connection cap | 32 (typed `CONNECTION_CAP` error beyond it) |
| Queue depth | 1024 default (typed `BACKPRESSURE` error beyond it) |
