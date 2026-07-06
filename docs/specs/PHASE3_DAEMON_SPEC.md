# Phase 3 — Daemon mode (security review + binding implementation spec)

Owner: product. Status: **APPROVED for implementation** per this document.
Supersedes the open-questions moratorium in PHASE3_DAEMON_PROPOSAL.md — that
document's §1-§7 analysis is ACCEPTED (transport: unix socket / named pipe;
auth: bearer token through the existing trust registry; write serialization:
single in-process FIFO; MCP via RemoteAgentMemory behind the existing seam).
This document records the security rulings that resolve its §8 and adds
binding v1 hardening requirements. Deviations from this spec require a new
product-owner review.

## Rulings on the proposal's ten open questions

R1. **Tokens are mandatory in every preset, including PERSONAL.** "Any process
    running as this OS user" is not an acceptable floor once multiple agents
    run as one user. Ergonomics preserved by auto-provisioning: on first start
    the daemon mints an OWNER-grade token into a user-private file
    (`<dataDir>/daemon-token`, best-effort 0600 on POSIX; on Windows it lives
    under the user profile which is user-private by default) and clients read
    it from there. Additional per-agent tokens are issuable (see R3) at
    config-priced grades. Connection-without-token is never identity.

R2. **No native-addon exception.** Zero runtime dependencies is a product
    promise. Daemon caller identity is an ASSERTED bearer credential,
    permanently, documented in KNOWN LIMITATIONS in the same register as the
    `signerSourceId` trade-off: a leaked token lets a local process act as
    that SourceId until revoked; mitigation is detection (R8) plus revocation
    (R3), not prevention. Revisit only on a real deployment's demand, and then
    only as an optional peer dependency.

R3. **Provisioning / rotation / revocation.** Tokens are opaque 32-byte
    random values; the daemon stores only SHA-256 fingerprints in memory and
    in audit records — the raw token never appears in logs, errors, or the
    ledger. Auth happens at connection handshake; a revocation set is checked
    per-request (Set lookup) so revocation takes effect immediately without a
    restart: revoking a token drops its existing connections (in-flight
    request completes — it was authorized when dequeued; queued-not-started
    requests from that connection are rejected with a typed error).
    Admin verbs `issueToken`, `revokeToken`, `revokeAllTokens`, `reloadTokens`
    exist ONLY over an already-authenticated OWNER-grade connection.
    `revokeAllTokens` spares the invoking connection and re-mints the owner
    token file.

R4. **No read-only fast path in v1.** Everything through the single FIFO.
    Recall is sub-10ms; serialization is not the bottleneck at v1 scale.
    Splitting readers is a future change requiring its own torn-read review.

R5. **v1 scale target: 10 concurrent clients, low hundreds of requests/sec.**
    FIFO is acceptable at that target; state the target in OPERATIONS.md so
    exceeding it is a known trigger for the R4 revisit. Connection cap 32,
    enforced; over-cap connections refused with a typed error.

R6. **Lifecycle: manual, explicit.** A CLI entrypoint
    (`intelligent-db-daemon --db <path> [--socket <path>]`) starts it; SIGINT/
    SIGTERM triggers graceful shutdown (stop accepting, drain the queue, close
    connections, close the db). Stale-socket handling on start: try-connect;
    if connection is refused, remove the stale file and bind (POSIX). No
    auto-start or OS service integration in v1; OPERATIONS.md documents
    systemd/Windows-service wrappers as deployment recipes. Client adapters
    must implement reconnect-with-backoff and surface disconnect-during-request
    as UNKNOWN (see R-idempotency below).

R7. **Opt-in permanently.** In-process `createAgentMemory` remains the default
    forever. Daemon mode is selected explicitly (env/config in mcp/server.ts,
    constructor choice in code). Mirrors the quarantine escape-hatch pattern.

R8. **Audit: same AppendSink machinery, SEPARATE chain.** Daemon events —
    connection accepted (token fingerprint, resolved SourceId, timestamp),
    auth failure, revocation, admin verb, graceful/unclean shutdown marker —
    go to a dedicated hash chain (distinct genesis, own `chainHead()`,
    same ledger code) so the fact/ratification chain stays semantically pure.
    The daemon chain is shippable through the same `AppendSink` interface.
    Rationale: co-mingling transport noise into the dispute-audit chain
    inflates what verifiers must scan and couples unrelated retention needs.

R9. **Windows ships in v1 with compensating controls** for the
    named-pipe-ACL gap: (a) the pipe name carries a high-entropy random
    suffix minted at daemon start and written only into the user-private
    token file — discovering the endpoint requires reading that file;
    (b) mandatory handshake auth (R1) with the fail-fast rules below. The
    residual difference vs POSIX file permissions is documented, not hidden.

R10. **Localhost HTTP: deferred indefinitely.** Not in v1, not planned. If a
     future client genuinely cannot open a pipe/socket, HTTP requires its own
     review with these written-in-advance preconditions: hard-coded refusal to
     bind any interface but 127.0.0.1, deny-by-default Origin/Host allowlist,
     and a per-request CSRF token distinct from the bearer credential.

## Binding v1 hardening requirements (additions to the proposal)

H1. **Handshake-first protocol.** The first line on a connection MUST be
    `{"method":"auth","token":"..."}`. Any other first line, malformed JSON,
    oversized line (reuse BoundedLineSplitter limits), or 5 seconds of
    handshake silence → connection dropped. One failed auth attempt → drop
    (no retries on a connection); repeated failures from new connections are
    rate-limited (fixed 1s delay before the failure response) and audited.

H2. **Identity binding.** The connection's resolved SourceId (via a
    `registerDaemonClient`-style claim producer in `identity/trustRegistry.ts`,
    grade from config) is THE acting identity for every request on that
    connection. Client-supplied source ids in request payloads are never
    trusted as the actor. Delegation is out of scope for v1.

H3. **Serialization invariant is tested, not assumed.** A test drives N
    concurrent client connections issuing interleaved compound writes and
    proves (via an op-span hook or write-ordering assertions) that no two
    compound operations interleave, and that a handler that introduces an
    `await` before its writes would be caught (lint rule or a runtime guard
    asserting the queue depth is 1 while a request executes).

H4. **Crash semantics tested.** A kill-the-daemon-mid-request test (torture
    suite extension): client observes disconnect, DB reopens clean
    (integrity + both chains verify), and the committed/uncommitted outcome
    matches WAL semantics. Client adapter surfaces UNKNOWN, never fabricates
    success/failure.

H5. **Idempotency: documented UNKNOWN in v1.** Requests MAY carry a client
    `requestId`; v1 logs it in the daemon audit record for post-hoc
    reconciliation but does not deduplicate. Full idempotency keys are a
    named future item; the accidental same-content_hash retry safety is NOT
    to be documented as the retry story.

H6. **Resource limits.** Max line length (existing splitter), max 32
    connections, max queue depth (default 1024, over → typed backpressure
    error to the submitting connection). No unbounded buffers per connection.

## Deliverables

1. `src/daemon/server.ts` (transport + handshake + FIFO + admin verbs),
   `src/daemon/tokens.ts` (mint/fingerprint/revoke/reload),
   `src/daemon/auditChain.ts` (separate chain, R8),
   `src/daemon/client.ts` (`createRemoteAgentMemory` — full AgentMemory
   interface over one socket, reconnect-with-backoff, UNKNOWN semantics).
2. `mcp/server.ts` startup switch (in-process default / remote opt-in),
   zero changes to `handleMcpRequest`.
3. CLI entrypoint wired into package bin (daemon start).
4. Tests: handshake/auth matrix (H1), identity binding (H2), serialization
   (H3), crash (H4), revocation immediacy (R3), connection cap + queue
   backpressure (H6), Windows pipe-suffix + POSIX socket-perms paths (R9),
   full default suite green.
5. Docs: OPERATIONS.md daemon section (start/stop, tokens, rotation, revoke,
   scale target, restart semantics), KNOWN LIMITATIONS addition (R2 trade-off,
   shared-fate blast radius from proposal §5.2), README one-paragraph mention.
