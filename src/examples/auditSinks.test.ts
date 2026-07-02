/**
 * examples/auditSinks.test.ts — the reference sinks stay WORKING, not decorative.
 *
 * Each case exercises one example end-to-end against a real ledger:
 *   1. JSONL FILE SINK — records round-trip through the file byte-equal, and the
 *      strict sink fails CLOSED on an unwritable path (the belief change aborts).
 *   2. SPOOL + SHIP — the sink never touches the network; shipSpool drains the
 *      rotated batch exactly once, retries a crashed batch first, and reports 0
 *      on an empty spool.
 *   3. LENIENT WRAPPER — failures are swallowed but OBSERVED; the belief change
 *      proceeds; the audit gap is visible in what the mirror is missing.
 *   4. END-TO-END DETECTION — the file mirror catches a local rewrite via
 *      firstDivergence, same comparator the auditShipping suite proves against
 *      a verifyChain-clean forgery.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { asEpochMs, createPendingLedger, mutationReceipt } from "../index.js";
import type { LedgerRecord, MutationPayload, SourceId } from "../index.js";

import {
  createJsonlFileSink,
  createSpoolSink,
  firstDivergence,
  lenient,
  readJsonlMirror,
  readJsonlMirrorReport,
  shipSpool,
} from "./auditSinks.js";

const NOW = asEpochMs(1_700_000_000_000);
const SYSTEM = "source:test-system" as SourceId;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best-effort */
    }
  }
});

function freshDir(tag: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = join(tmpdir(), `idb-sinks-${tag}-${unique}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mutation(n: number): MutationPayload {
  return mutationReceipt("DEMOTE", `strand:s-${n}`, `h-${n}`, `b-${n}`, `a-${n}`, NOW);
}

describe("1. JSONL file sink — round-trip fidelity + strict fail-closed", () => {
  it("records round-trip through the mirror byte-equal, in chain order", () => {
    const mirror = join(freshDir("jsonl"), "audit.jsonl");
    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(mirror) });

    for (let i = 0; i < 4; i++) ledger.appendMutation(mutation(i), SYSTEM);

    expect(readJsonlMirror(mirror)).toEqual([...ledger.records()]);
  });

  it("an unwritable path aborts the belief change (fail-closed), chain unchanged", () => {
    const dir = freshDir("strict");
    // A DIRECTORY at the sink's file path makes appendFileSync throw reliably
    // cross-platform — the simplest stand-in for "destination unavailable".
    const blocked = join(dir, "blocked.jsonl");
    mkdirSync(blocked);

    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(blocked) });
    expect(() => ledger.appendMutation(mutation(0), SYSTEM)).toThrow();
    expect(ledger.records().length).toBe(0); // no shipped receipt ⇒ no belief change
  });
});

describe("2. Spool + shipSpool — no network on the write path; crash-safe drain", () => {
  it("drains the batch exactly once and reports 0 on an empty spool", async () => {
    const spoolDir = freshDir("spool");
    const ledger = createPendingLedger({ onAppend: createSpoolSink(spoolDir) });
    for (let i = 0; i < 3; i++) ledger.appendMutation(mutation(i), SYSTEM);

    const batches: string[][] = [];
    const post = async (lines: readonly string[]): Promise<void> => {
      batches.push([...lines]);
    };

    expect(await shipSpool(spoolDir, post)).toBe(3);
    expect(batches.length).toBe(1);
    expect(batches[0]!.map((l) => (JSON.parse(l) as LedgerRecord).seq)).toEqual([0, 1, 2]);

    // Nothing left: a second drain ships nothing and posts nothing.
    expect(await shipSpool(spoolDir, post)).toBe(0);
    expect(batches.length).toBe(1);

    // New records after a drain land in a fresh spool and ship on the next run.
    ledger.appendMutation(mutation(3), SYSTEM);
    expect(await shipSpool(spoolDir, post)).toBe(1);
    expect((JSON.parse(batches[1]![0]!) as LedgerRecord).seq).toBe(3);
  });

  it("a crashed previous drain (post threw) is retried FIRST — never a hole", async () => {
    const spoolDir = freshDir("retry");
    const sink = createSpoolSink(spoolDir);
    const ledger = createPendingLedger({ onAppend: sink });
    ledger.appendMutation(mutation(0), SYSTEM);

    // First drain crashes mid-ship: the batch stays in the shipping file.
    await expect(
      shipSpool(spoolDir, async () => {
        throw new Error("SIEM down");
      }),
    ).rejects.toThrow("SIEM down");

    // A new record lands in a FRESH spool meanwhile (the rename left no gap).
    ledger.appendMutation(mutation(1), SYSTEM);

    // Next drain retries the crashed batch first, then the fresh spool.
    const shipped: number[] = [];
    const post = async (lines: readonly string[]): Promise<void> => {
      for (const l of lines) shipped.push((JSON.parse(l) as LedgerRecord).seq);
    };
    expect(await shipSpool(spoolDir, post)).toBe(1); // the crashed batch (seq 0)
    expect(await shipSpool(spoolDir, post)).toBe(1); // the fresh spool (seq 1)
    expect(shipped).toEqual([0, 1]); // in order, no hole, no loss
  });
});

describe("3. Lenient wrapper — availability through an outage, gap observed", () => {
  it("swallows the failure, surfaces it to onError, and the belief change proceeds", () => {
    const failures: LedgerRecord[] = [];
    let down = false;
    const flaky: ReturnType<typeof createJsonlFileSink> = () => {
      if (down) throw new Error("sink outage");
    };
    const ledger = createPendingLedger({
      onAppend: lenient(flaky, (_err, record) => failures.push(record)),
    });

    ledger.appendMutation(mutation(0), SYSTEM);
    down = true;
    ledger.appendMutation(mutation(1), SYSTEM); // proceeds despite the outage
    down = false;
    ledger.appendMutation(mutation(2), SYSTEM);

    expect(ledger.records().length).toBe(3); // availability kept
    expect(failures.map((r) => r.seq)).toEqual([1]); // the gap is OBSERVED, not silent
  });
});

describe("4. End-to-end detection — the mirror catches a local rewrite", () => {
  it("firstDivergence names the rewritten seq against the file mirror", () => {
    const mirror = join(freshDir("detect"), "audit.jsonl");
    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(mirror) });
    for (let i = 0; i < 5; i++) ledger.appendMutation(mutation(i), SYSTEM);

    // The "insider": a rewritten live chain diverging at seq 2 (hash swapped —
    // auditShipping.test.ts proves the same catch against a full recomputed,
    // verifyChain-clean forgery; here we pin the example comparator + mirror).
    const rewritten = [...ledger.records()].map((r) =>
      r.seq >= 2 ? { ...r, thisHash: "FORGED-" + r.thisHash } : r,
    );

    expect(firstDivergence(readJsonlMirror(mirror), ledger.records())).toBe(null);
    expect(firstDivergence(readJsonlMirror(mirror), rewritten)).toBe(2);

    // A TRUNCATED local chain (records deleted from the tail) is also caught.
    expect(firstDivergence(readJsonlMirror(mirror), ledger.records().slice(0, 3))).toBe(3);

    // Corrupting the MIRROR itself is visible too (it simply stops matching).
    writeFileSync(mirror, "", { flag: "w" });
    expect(readJsonlMirror(mirror)).toEqual([]);
  });
});

describe("5. Torn writes — the mirror reader survives exactly the crash it exists to investigate", () => {
  it("a torn FINAL line yields the intact prefix (tornTail true) and firstDivergence still runs", () => {
    const mirror = join(freshDir("torn"), "audit.jsonl");
    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(mirror) });
    for (let i = 0; i < 3; i++) ledger.appendMutation(mutation(i), SYSTEM);

    // The process died mid-appendFileSync: half a record, no closing brace/newline.
    writeFileSync(mirror, '{"seq":3,"kind":"MUT', { flag: "a" });

    // The lenient wrapper path: readJsonlMirror tolerates the torn tail silently…
    const prefix = readJsonlMirror(mirror);
    expect(prefix).toEqual([...ledger.records()].slice(0, 3));

    // …the report names the condition explicitly…
    const report = readJsonlMirrorReport(mirror);
    expect(report.tornTail).toBe(true);
    expect(report.corruptAtLine).toBeNull();
    expect(report.records.length).toBe(3);

    // …and the DETECTION FLOW still works on the shipped prefix: the live chain
    // cleanly extends it (null), and a rewrite inside the prefix is still caught.
    expect(firstDivergence(prefix, ledger.records())).toBe(null);
    const rewritten = [...ledger.records()].map((r) =>
      r.seq >= 1 ? { ...r, thisHash: "FORGED-" + r.thisHash } : r,
    );
    expect(firstDivergence(prefix, rewritten)).toBe(1);
  });

  it("garbage injected MID-FILE throws naming the line — a tamper signal, never tolerated", () => {
    const mirror = join(freshDir("midfile"), "audit.jsonl");
    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(mirror) });
    for (let i = 0; i < 4; i++) ledger.appendMutation(mutation(i), SYSTEM);

    // Rewrite line 2 (a NON-final line) into garbage: a torn append cannot do
    // this — only modification/damage can.
    const lines = [...ledger.records()].map((r) => JSON.stringify(r));
    lines[1] = "GARBAGE-NOT-JSON";
    writeFileSync(mirror, lines.join("\n") + "\n", { flag: "w" });

    const report = readJsonlMirrorReport(mirror);
    expect(report.corruptAtLine).toBe(2); // 1-based
    expect(report.tornTail).toBe(false);
    expect(report.records.length).toBe(1); // the parsed prefix before the damage

    expect(() => readJsonlMirror(mirror)).toThrow(/corrupted mid-file at line 2/);
  });

  it("a VALID final line without a trailing newline parses fully (torn = parse failure, not a missing \\n)", () => {
    const mirror = join(freshDir("no-newline"), "audit.jsonl");
    const ledger = createPendingLedger({ onAppend: createJsonlFileSink(mirror) });
    for (let i = 0; i < 3; i++) ledger.appendMutation(mutation(i), SYSTEM);

    // Rewrite the file WITHOUT the trailing newline — a complete, valid record
    // whose newline just never made it to disk.
    const lines = [...ledger.records()].map((r) => JSON.stringify(r));
    writeFileSync(mirror, lines.join("\n"), { flag: "w" });

    const report = readJsonlMirrorReport(mirror);
    expect(report.tornTail).toBe(false);
    expect(report.corruptAtLine).toBeNull();
    expect(report.records).toEqual([...ledger.records()]);
    expect(readJsonlMirror(mirror)).toEqual([...ledger.records()]);
  });
});
