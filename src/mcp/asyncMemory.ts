/**
 * mcp/asyncMemory.ts — THE ASYNC PROJECTION OF THE MCP SURFACE.
 *
 * PHASE3B_MCP_ASYNC_SPEC.md deliverable 1: `handleMcpRequestAsync` (mcp/handler.ts)
 * dispatches against exactly one contract — {@link AsyncAgentMemory} — regardless of
 * whether the memory behind it lives in-process (the permanent default) or across a
 * daemon socket (`daemon/client.ts`'s `createRemoteAgentMemory`). This is the ONLY
 * place that contract is defined; nothing else may declare a competing shape.
 *
 * WHY NARROW: this is the async PROJECTION of {@link AgentMemory} restricted to
 * exactly the five verbs the MCP handler calls (`remember`, `recall`,
 * `pendingQuestions`, `resolvePending`, `explain`) plus `close`. Not the whole
 * ergonomic facade (no `ratify`/`adjudicate`/`disown`/`approve`/`registerSource` —
 * those are trust-MUTATING or advanced-caller verbs the MCP surface never exposes;
 * see mcp/handler.ts's `TOOLS` list and daemon/server.ts's OWNER-gate). A narrower
 * contract is easier to satisfy honestly and impossible to accidentally widen into
 * a mutation path.
 *
 * TWO IMPLEMENTATIONS SATISFY THIS INTERFACE:
 *   1. {@link syncToAsyncMemory} — wraps the in-process, synchronous
 *      {@link AgentMemory} facade. Every call is `async (...) => mem.method(...)`:
 *      a synchronous return becomes a resolved promise for free (Node's event loop
 *      does not block on it — awaiting an already-resolved value costs one
 *      microtask tick, not a socket round trip), and a synchronous throw becomes a
 *      rejected promise (the `async` keyword does this automatically — no manual
 *      try/catch needed). MEMOIZED per {@link AgentMemory} instance (see below).
 *   2. `daemon/client.ts`'s `createRemoteAgentMemory(...)` — its `RemoteAgentMemory`
 *      return type already satisfies {@link AsyncAgentMemory} STRUCTURALLY (every
 *      required method is present with a compatible signature; the extra
 *      `requestId` parameters are all optional, so a caller providing zero args
 *      still type-checks). No adapter needed for the daemon-backed path — the
 *      object daemon/client.ts already builds is handed to
 *      `handleMcpRequestAsync` directly.
 *
 * MEMOIZATION (why {@link syncToAsyncMemory} is NOT a bare `{ ...fresh object... }`
 * factory): mcp/handler.ts's confirmation-token consent binding (Wave 2) keys a
 * `WeakMap` by the memory object identity — a token minted during
 * `list_pending_questions` must be found again when `resolve_pending` is called
 * moments later. If every call to `syncToAsyncMemory(mem)` returned a FRESH wrapper
 * object, two calls against the SAME underlying `mem` (e.g. two dispatches in the
 * same session) would produce two different `WeakMap` keys and the token would
 * never be found — a self-inflicted, silent consent-binding bypass. Memoizing per
 * `mem` instance (a second `WeakMap`, purely an identity cache, no shared mutable
 * state) makes `syncToAsyncMemory` safe to call every time a request needs the
 * adapter, not just once at startup.
 *
 * ZERO new runtime deps.
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`; `verbatimModuleSyntax`.
 */

import type { AgentMemory } from "../agent/agentMemory.js";

/**
 * The async projection of exactly the {@link AgentMemory} methods
 * `mcp/handler.ts`'s `handleMcpRequestAsync` dispatches against. See the module
 * doc for why this is narrow and who implements it.
 */
export interface AsyncAgentMemory {
  remember(
    input: Parameters<AgentMemory["remember"]>[0],
  ): Promise<ReturnType<AgentMemory["remember"]>>;
  recall(cue: Parameters<AgentMemory["recall"]>[0]): Promise<ReturnType<AgentMemory["recall"]>>;
  pendingQuestions(): Promise<ReturnType<AgentMemory["pendingQuestions"]>>;
  resolvePending(
    contradictionSetId: Parameters<AgentMemory["resolvePending"]>[0],
    chosenStrandId: Parameters<AgentMemory["resolvePending"]>[1],
  ): Promise<ReturnType<AgentMemory["resolvePending"]>>;
  explain(target: Parameters<AgentMemory["explain"]>[0]): Promise<ReturnType<AgentMemory["explain"]>>;
  /** Close the underlying memory (store handles, connections, ...). */
  close(): Promise<void>;
}

// Identity cache — see the module doc's MEMOIZATION section for why this exists.
const ASYNC_WRAPPERS = new WeakMap<AgentMemory, AsyncAgentMemory>();

/**
 * Wrap an in-process {@link AgentMemory} facade as an {@link AsyncAgentMemory}.
 * The ONLY glue the in-process (permanent-default) path needs to ride the same
 * async dispatch as the daemon-backed path. Idempotent per `mem` instance — safe
 * to call on every request rather than only once at startup (see the module doc).
 */
export function syncToAsyncMemory(mem: AgentMemory): AsyncAgentMemory {
  const cached = ASYNC_WRAPPERS.get(mem);
  if (cached !== undefined) return cached;
  const wrapper: AsyncAgentMemory = {
    remember: async (input) => mem.remember(input),
    recall: async (cue) => mem.recall(cue),
    pendingQuestions: async () => mem.pendingQuestions(),
    resolvePending: async (contradictionSetId, chosenStrandId) =>
      mem.resolvePending(contradictionSetId, chosenStrandId),
    explain: async (target) => mem.explain(target),
    close: async () => mem.close(),
  };
  ASYNC_WRAPPERS.set(mem, wrapper);
  return wrapper;
}
