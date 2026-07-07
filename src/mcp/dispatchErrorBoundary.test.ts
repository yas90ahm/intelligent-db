/**
 * mcp/dispatchErrorBoundary.test.ts — regression coverage for
 * `mcp-dispatch-unguarded-promise-chain` (a hostile re-audit finding,
 * 2026-07-07): `mcp/server.ts`'s `main()` chains every request batch onto ONE
 * serial promise (`queue = queue.then(() => handleBatch(batch))`) with no
 * `.catch()` anywhere. Before this fix, a REJECTED `processLine(...)` call —
 * concretely reproducible today via a well-formed JSON line that is not a
 * well-formed REQUEST OBJECT (a bare scalar/array/`null`, or an object with
 * neither `id` nor `method` — `handleMcpRequestAsync`'s own notification check
 * `req.id === undefined && req.method.startsWith(...)` throws a TypeError when
 * `req`/`req.method` isn't there to call `.startsWith` on) — propagated
 * straight into that shared `queue`. A `.then(onFulfilled)` attached to an
 * ALREADY-REJECTED promise skips `onFulfilled` and itself re-rejects, so EVERY
 * batch enqueued after the failure would silently stop running its
 * `handleBatch` body at all: the process answers NO further request, ever,
 * without crashing or exiting, plus a genuine process-level
 * `unhandledRejection` once stdin closes.
 *
 * These tests exercise `dispatchLineSafely` — the REAL function `main()` now
 * calls for every line — directly, over a REALISTIC RANGE of malformed input
 * shapes (not one magic value), and reproduce `main()`'s own serial-queue
 * chaining pattern to prove a failing line never wedges it.
 */

import { describe, it, expect } from "vitest";

import { dispatchLineSafely } from "./server.js";
import type { AsyncAgentMemory } from "./asyncMemory.js";
import type { McpResponse } from "./handler.js";
import { JSONRPC_INTERNAL_ERROR } from "./handler.js";

/** A memory stub that fails loudly if any of these tests accidentally invoke it —
 *  every case here is expected to crash before ever touching `memory`. */
function unusedMemory(): AsyncAgentMemory {
  const boom = (name: string) => () => {
    throw new Error(`unusedMemory.${name} should never be called by these tests.`);
  };
  return {
    remember: boom("remember"),
    recall: boom("recall"),
    pendingQuestions: boom("pendingQuestions"),
    resolvePending: boom("resolvePending"),
    explain: boom("explain"),
    close: boom("close"),
  } as unknown as AsyncAgentMemory;
}

const MALFORMED_LINES: ReadonlyArray<[string, string]> = [
  ["{}", "an object with neither id nor method"],
  ["null", "a bare JSON null"],
  ["42", "a bare JSON number"],
  ["[]", "a bare JSON array"],
  ['"just a string"', "a bare JSON string"],
  ["true", "a bare JSON boolean"],
];

describe("mcp/server.ts dispatchLineSafely (mcp-dispatch-unguarded-promise-chain fix)", () => {
  it.each(MALFORMED_LINES)(
    "a malformed request (%s — %s) that crashes handleMcpRequestAsync yields a typed error response, never a thrown/rejected promise",
    async (line) => {
      const response = await dispatchLineSafely(line, unusedMemory());
      expect(response).not.toBeNull();
      expect(response!.error).toBeDefined();
      expect(response!.error!.code).toBe(JSONRPC_INTERNAL_ERROR);
      expect(response!.id).toBeNull();
    },
  );

  it("does not produce a process-level unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      await dispatchLineSafely("{}", unusedMemory());
      // Give the event loop a couple of ticks so anything that WOULD have
      // fired asynchronously has a chance to.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("a well-formed request still dispatches normally through the same boundary (no false positives)", async () => {
    const response = await dispatchLineSafely(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      unusedMemory(),
    );
    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("a request with a defined id but a non-string method does NOT crash (short-circuits before .startsWith) — confirms the crash precondition precisely", async () => {
    // Documents exactly WHERE the boundary between "handled gracefully by
    // handler.ts itself" and "needs dispatchLineSafely's catch" falls: a
    // defined `id` short-circuits the notification check (`req.id ===
    // undefined && ...`) before `.startsWith` is ever reached, so this
    // reaches `handleMcpRequestAsync`'s own `default:` branch and resolves
    // normally (METHOD_NOT_FOUND) — it is NOT one of the crashing shapes
    // above. Every crashing shape in `MALFORMED_LINES` is, by construction,
    // one where `id` is absent — that's why `bestEffortRequestId` falling
    // back to `null` for all of them (asserted above) is the correct, not
    // merely convenient, behavior.
    const response = await dispatchLineSafely(JSON.stringify({ id: 7, method: 12345 }), unusedMemory());
    expect(response).not.toBeNull();
    expect(response!.id).toBe(7);
    expect(response!.error?.message).toMatch(/Unknown method/);
  });

  it(
    "a failing line never wedges the shared serial queue: a batch enqueued AFTER a crash still runs " +
      "(reproduces main()'s own `queue = queue.then(...)` chaining pattern directly)",
    async () => {
      let queue: Promise<void> = Promise.resolve();
      const results: Array<McpResponse | null> = [];
      const enqueue = (line: string): void => {
        queue = queue.then(async () => {
          results.push(await dispatchLineSafely(line, unusedMemory()));
        });
      };

      enqueue("{}"); // the crashing line
      enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })); // AFTER it
      enqueue(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })); // and another

      // Before this fix, `queue` would become permanently rejected on the
      // FIRST enqueue above: this await would throw, and `results` would stay
      // empty — neither later line would ever run its body.
      await expect(queue).resolves.toBeUndefined();

      expect(results).toHaveLength(3);
      expect(results[0]!.error).toBeDefined(); // the crash, contained
      expect(results[1]).toEqual({ jsonrpc: "2.0", id: 1, result: {} }); // ping still ran
      expect((results[2] as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0); // tools/list still ran
    },
  );
});
