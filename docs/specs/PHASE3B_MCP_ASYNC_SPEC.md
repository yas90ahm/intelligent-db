# Phase 3b — Wire the daemon client into the MCP server (spec)

Owner: product. Status: APPROVED for implementation. Closes the one architectural
loose end from PHASE3_DAEMON_SPEC.md: the daemon client (`daemon/client.ts`,
`createRemoteAgentMemory`) is built and tested, but `mcp/server.ts` cannot dispatch
real requests through it because `handleMcpRequest` is synchronous while the client
is async. Today the daemon-backed path validates connectivity then throws
`DaemonBackingNotWiredError`. This spec makes it actually work.

## The decision (do not relitigate)

A synchronous bridge over async socket I/O is off the table — the earlier pass
reproduced a real `worker_threads` + `Atomics.wait` stall under genuine socket I/O.
The dispatch becomes **async, as the single source of truth**. The in-process default
path (the common case, permanent) is preserved by wrapping the synchronous facade in
a trivial async adapter; awaiting an already-resolved value is free. No dispatch logic
is duplicated — there is ONE handler, and it is async.

## Design

1. **`AsyncAgentMemory`** (new, in `mcp/` or `core/`): the async projection of exactly
   the methods the MCP handler uses — `remember`, `recall`, `pendingQuestions`,
   `resolvePending`, `explain`, `close` — each returning `Promise<T>`. This is the
   contract the async handler dispatches against. It is a NARROW interface (only the
   MCP surface), not the whole `AgentMemory`.
2. **`createRemoteAgentMemory`** must satisfy `AsyncAgentMemory` for these six methods
   (it already returns async for the wire verbs; confirm each MCP verb has a real wire
   round trip on both client and daemon-server side — `remember`/`recall`/
   `pendingQuestions`/`resolvePending`/`explain`. If the daemon server is missing a
   verb, add it; these are read/dispute verbs, NOT the OWNER-gated trust-mutating verbs,
   so they keep their existing per-verb authorization).
3. **`syncToAsyncMemory(mem: AgentMemory): AsyncAgentMemory`** (new adapter): wraps the
   in-process facade so each call returns `Promise.resolve(mem.method(...))`. Errors
   thrown synchronously become rejected promises. This is the ONLY glue the in-process
   path needs.
4. **`handleMcpRequestAsync(req, memory: AsyncAgentMemory): Promise<McpResponse | null>`**
   becomes the single dispatch implementation — the current `handleMcpRequest` /
   `dispatchToolCall` logic, `await`ing every `memory.*` call. The confirmation-token
   consent-binding logic (Wave 2, WeakMap-keyed by the memory object) is preserved and
   still minted/consumed CLIENT-SIDE in the handler — it is independent of where memory
   lives, so daemon-backed `resolve_pending` still requires a valid, unexpired
   confirmation token.
5. **`handleMcpRequest` (sync) back-compat**: keep a synchronous entry that the existing
   sync tests and any sync caller use, implemented WITHOUT duplicating logic — extract
   the pure request-shaping (parse, validate, tool schema, error mapping) into shared
   helpers used by both, where the only difference is the `await` on the memory call.
   If a clean no-duplication sync shim is not achievable, migrate the sync handler tests
   to `handleMcpRequestAsync` (mechanical `await`) and make async the only handler —
   BUT do not ship two divergent copies of the dispatch switch. Prefer shared helpers.
6. **`mcp/server.ts` transport**: `processLine` becomes async; `main()` awaits each
   response before writing it (this also serializes requests over the single stdio
   connection — the correct behavior, mirroring the daemon FIFO). Remove the
   `DaemonBackingNotWiredError` throw path; when `MEMORY_DAEMON_SOCKET` +
   `MEMORY_DAEMON_TOKEN_FILE` are set, construct `createRemoteAgentMemory(...)` and
   dispatch through `handleMcpRequestAsync` directly. In-process default wraps the sync
   facade via `syncToAsyncMemory`. Keep the connectivity pre-check (fail fast with a
   clear error if the daemon is unreachable or the token is rejected at startup).

## Invariants (must hold — this touches the trust boundary)

- Daemon-backed MCP must preserve EVERY trust invariant the in-process path has: belief
  from provenance not similarity, `resolve_pending` consent-token binding enforced,
  quarantine/PROVISIONAL labeling intact in rendered output, no trust-mutating verb
  reachable from the MCP surface (MCP only exposes remember/recall/pending/resolve/explain).
- The daemon's OWNER-grade gate on trust-mutating verbs (Wave 1) is unaffected — the MCP
  server is a CLIENT and only calls the non-mutating verbs.
- Request ordering: one request fully resolved before the next is dispatched (no
  interleaving), same as today's sync transport and the daemon FIFO.

## Tests (the proof)

1. Unit: `handleMcpRequestAsync` over a `syncToAsyncMemory(createAgentMemory())` produces
   IDENTICAL responses to the current sync handler for every tool (remember/recall/
   pending/resolve/explain, plus error cases and the consent-token flow).
2. **End-to-end (the headline)**: spawn a REAL daemon process, start an MCP server
   pointed at it via `MEMORY_DAEMON_SOCKET`/`MEMORY_DAEMON_TOKEN_FILE`, and drive the
   full stdio JSON-RPC protocol: remember a fact, recall it (correct citation +
   fact_state label over the wire), form a dispute, `list_pending_questions` returns it
   with a confirmation token, `resolve_pending` WITHOUT the token is rejected and WITH it
   succeeds — all through the daemon. Assert the fact actually lives in the daemon's store
   (a second MCP client sees it), proving shared memory works.
3. Migration: every existing MCP handler/server test stays green (sync path unchanged in
   behavior).

## Docs

Update `mcp/server.ts`'s module doc, CLAUDE.md, README, and OPERATIONS.md: daemon-backed
MCP is now WIRED and works end-to-end (remove the "fails fast / not wired" disclosure and
the `DaemonBackingNotWiredError` mention as the terminal state). State the multi-client
shared-memory story plainly.
