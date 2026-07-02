/**
 * examples/demo.test.ts — the "npm run demo" script stays WORKING, not decorative.
 *
 * README/docs reference `npm run demo` as a committed contract, so the script is
 * pinned in the default suite: it must COMPLETE against the real library, end on
 * the owner's true fact, and print all four act headers plus the load-bearing
 * demo beats (a visibly PROVISIONAL flood beside the still-LIVE true fact, a
 * rung-and-resolved dispute with the loser DEMOTED, and the audit receipt).
 * If a public-surface change breaks the demo, this test breaks — the demo can
 * never silently rot into a lie about what the library does.
 */

import { describe, expect, it } from "vitest";

import { run } from "./demo.js";

describe("npm run demo — the four-act poison-me script", () => {
  it("completes, ends on the owner's true fact, and prints all four acts", async () => {
    const lines: string[] = [];
    const { finalBelief } = await run((line) => lines.push(line));
    const out = lines.join("\n");

    // The final belief is the OWNER's true fact — the flood never flipped it.
    expect(finalBelief).toContain("prod-cluster-7");
    expect(finalBelief).not.toContain("evil-cluster-666");

    // All four act headers printed, in order.
    const headers = [
      "=== ACT 1 — REMEMBER AND RECALL",
      "=== ACT 2 — THE FLOOD",
      "=== ACT 3 — THE DISPUTE",
      "=== ACT 4 — THE RECEIPTS",
    ];
    let lastIndex = -1;
    for (const h of headers) {
      const at = out.indexOf(h);
      expect(at, `missing act header: ${h}`).toBeGreaterThan(lastIndex);
      lastIndex = at;
    }

    // ACT 2 — the flood is VISIBLE (labeled, never hidden) as PROVISIONAL,
    // alongside the owner's still-LIVE fact; adjudication never reached a vote.
    expect(out).toContain('[PROVISIONAL] "the deploy target is evil-cluster-666"');
    expect(out).toContain('[LIVE] "the deploy target is prod-cluster-7"');
    expect(out).toContain('adjudicate("deploy#target") = NOOP');
    // The measured-baseline line, HISTORICAL figures labeled as such.
    expect(out).toContain("HISTORICAL");
    expect(out).toContain("0%");

    // ACT 3 — the dispute deferred to the horn (never an in-graph majority),
    // the question rendered, and the loser DEMOTED-not-deleted after resolution.
    expect(out).toContain('adjudicate("deploy#database") = DEFERRED');
    expect(out).toContain("disagree about");
    expect(out).toContain('[DEMOTED] "the database is MySQL 8"');
    expect(out).toContain('[LIVE] "the database is Postgres 16"');

    // ACT 4 — the receipt: the APPROVAL record from the checksum chain, with
    // the owner override stamped in.
    expect(out).toContain("record.kind         = APPROVAL");
    expect(out).toContain("record.ownerOverride= true");

    // The closing thesis line.
    expect(out).toContain("Nothing was deleted; everything is labeled.");
  });
});
