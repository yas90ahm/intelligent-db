/**
 * examples/demo.ts — THE 60-SECOND POISON-ME DEMO ("npm run demo").
 *
 * Four narrated acts that walk the whole thesis end-to-end against a REAL
 * in-memory instance — nothing mocked, nothing staged, no file writes:
 *
 *   ACT 1 — the owner remembers facts; recall returns them CITED and LABELED.
 *   ACT 2 — a 50-identity fake-publisher fleet floods a contradicting claim;
 *           every flood fact lands PROVISIONAL (quarantined at the door) while
 *           the owner's fact stays LIVE — labeled, never hidden, never flipped.
 *   ACT 3 — ONE genuinely independent trusted source disputes a real owner
 *           fact; the horn rings (a deferred question, never an in-graph
 *           majority vote); the owner answers; the loser is DEMOTED-not-deleted.
 *   ACT 4 — the receipts: the APPROVAL record appended to the checksum-chained
 *           audit ledger, returned verbatim by resolvePending.
 *
 * PURE LIBRARY CONSUMER: imports ONLY the public barrel (src/index.ts), zero
 * new dependencies, in-memory backend, deterministic flow (wall-clock
 * timestamps in citations are the only varying bytes). The narration lives in
 * the comments so this file doubles as a tutorial; demo.test.ts pins the
 * output against rot.
 */

import { pathToFileURL } from "node:url";

import { FactState, createAgentMemory } from "../index.js";
import type { AttributeKey, CitedFact } from "../index.js";

const DEPLOY_TARGET = "deploy#target" as AttributeKey;
const DEPLOY_DATABASE = "deploy#database" as AttributeKey;
const FLEET_SIZE = 50;

/** One compact line per recalled fact: the state label IS the demo. */
function factLine(f: CitedFact): string {
  return `  [${f.fact_state}] "${f.text}" — ${f.citation}`;
}

export async function run(
  log: (line: string) => void = console.log,
): Promise<{ finalBelief: string }> {
  // The trust config is the SWAPPABLE TRUST ROOT: here the deployment asserts
  // that SSO tenant "tenant:acme" has a verified custom domain, so a member of
  // that tenant carries DOMAIN-grade weight (0.35) — a genuinely independent
  // witness that clears the 0.10 quarantine gate. Everything else (the fake
  // fleet below) is unconfigured and therefore priced near zero.
  const mem = createAgentMemory({
    trust: { verifiedTenantDomains: { "tenant:acme": "acme.example" } },
  });

  // ==========================================================================
  log("=== ACT 1 — REMEMBER AND RECALL (cited, labeled, grounded) ===");
  // ==========================================================================
  // The owner (the personal tier's ground truth, weight 0.90) files three
  // facts. Facts are strands in a spiderweb: latent until a cue lights them.
  const { id: ownerTargetId } = mem.remember({
    text: "the deploy target is prod-cluster-7",
    entity: "entity:deploy",
    attribute: "deploy#target",
  });
  const { id: ownerDbId } = mem.remember({
    text: "the database is Postgres 16",
    entity: "entity:deploy",
    attribute: "deploy#database",
  });
  mem.remember({ text: "the on-call rotation starts monday", entity: "entity:oncall" });

  // Recall = spreading activation from the cue, never a fuzzy nearest-neighbor
  // lookup. Every returned fact carries a citation (no provenance → no voice)
  // and a belief-state label.
  const first = mem.recall("what is the deploy target?");
  const firstFact = first.facts.find((f) => f.text.includes("prod-cluster-7"));
  if (firstFact === undefined) throw new Error("demo: ACT 1 recall lost the owner's fact");
  log(factLine(firstFact));
  void ownerTargetId;

  // ==========================================================================
  log("=== ACT 2 — THE FLOOD (50 fake publishers, one wrong claim) ===");
  // ==========================================================================
  // A Sybil fleet: 50 DISTINCT unconfigured web domains all asserting the same
  // contradicting claim. Minting a domain is cheap, so the trust registry
  // prices each at PUBLISHER_UNVERIFIED (0.04) — below the quarantine gate —
  // and every flood fact lands PROVISIONAL: visible, labeled, weightless.
  for (let i = 0; i < FLEET_SIZE; i++) {
    mem.remember({
      text: "the deploy target is evil-cluster-666",
      entity: "entity:deploy",
      attribute: "deploy#target",
      origin: { kind: "web", resourceId: `https://breaking-devops-news-${i}.example/scoop` },
    });
  }

  // Recall shows EVERYTHING that lit — the superposition is shown BY DESIGN
  // (fail-open recall: label, never hide), so the caller can tell a held claim
  // from a believed one by its fact_state.
  const flooded = mem.recall("what is the deploy target?");
  for (const f of flooded.facts) log(factLine(f));
  const liveCount = flooded.facts.filter((f) => f.fact_state === FactState.LIVE).length;
  const quarantined = flooded.facts.filter(
    (f) => f.fact_state === FactState.PROVISIONAL,
  ).length;
  log(`  → ${quarantined} flood claims PROVISIONAL (quarantined), ${liveCount} LIVE.`);
  log("  → Labeled, not hidden: the flood is visible but structurally weightless.");

  // The flood cannot even ENTER a contradiction set: adjudication admits only
  // LIVE members, so 50 quarantined claims against 1 believed fact is a NOOP —
  // no vote happened, because headcount is never a signal here.
  const floodOutcome = mem.adjudicate(DEPLOY_TARGET);
  log(`  → adjudicate("deploy#target") = ${floodOutcome.kind}: the flood never reaches a vote.`);

  // The measured baseline this act re-enacts (figures from
  // docs/launch/REBUILD_SUMMARY.md): locally re-run poisoning benches scored
  // 0% attack success — a cheap fake-source fleet of up to 500 identities
  // collapses to a single witness and never flips a true fact. HISTORICAL
  // (pre-rebuild, LLM-scored, quoted as such): Intelligent DB 0% vs RAG 98.7%
  // / mem0 79.4%.
  log(
    "  → Measured: 0% attack success locally (fleets up to 500 collapse to one witness); " +
      "HISTORICAL (pre-rebuild): Intelligent DB 0% vs RAG 98.7% / mem0 79.4%.",
  );

  // ==========================================================================
  log("=== ACT 3 — THE DISPUTE (one real independent witness; the horn rings) ===");
  // ==========================================================================
  // alice@acme is a member of the CONFIGURED tenant: SSO membership plus the
  // config-verified DOMAIN lift — a genuinely independent witness, so her
  // contradiction of a real owner fact clears quarantine and lands LIVE.
  const alice = mem.trust.registerSsoMember({
    issuer: "https://idp.acme.example",
    subject: "alice",
    tenantId: "tenant:acme",
    verifiedCustomDomain: "acme.example",
    label: "alice@acme",
  });
  mem.remember({
    text: "the database is MySQL 8",
    entity: "entity:deploy",
    attribute: "deploy#database",
    source: { sourceId: alice.sourceId },
  });

  // TWO LIVE claims from genuinely independent sources: the web must never
  // pick a winner by majority or arrival order (the hard theorem), and with
  // neither side holding an earned reputation margin it DEFERS to a human.
  const disputeOutcome = mem.adjudicate(DEPLOY_DATABASE);
  log(`  → adjudicate("deploy#database") = ${disputeOutcome.kind}: deferred to the human horn.`);

  // The horn ringing — pendingQuestions() verbatim: plain data an agent can
  // phrase to the owner ("which is correct?").
  const questions = mem.pendingQuestions();
  for (const line of JSON.stringify(questions, null, 2).split("\n")) log("  " + line);
  const question = questions[0];
  if (question === undefined) throw new Error("demo: ACT 3 expected an open question");

  // The owner answers with their own fact. Demote-never-delete: the loser
  // becomes DEMOTED history with an OUTRANKS edge explaining why.
  const resolved = mem.resolvePending(question.contradictionSetId, ownerDbId);
  const after = mem.recall("what is the database?");
  // Activation lights the whole connected web (ACT 2's flood shares the
  // entity), so print just the two disputed claims here — ACT 2 already showed
  // the full labeled superposition.
  for (const f of after.facts) {
    if (f.text.includes("database")) log(factLine(f));
  }
  log("  → Winner LIVE; loser DEMOTED — kept as history, never deleted.");

  // ==========================================================================
  log("=== ACT 4 — THE RECEIPTS (the checksum-chained audit record) ===");
  // ==========================================================================
  // The engine exposes no raw ledger accessor (deliberately); the resolution
  // receipt IS the appended record: the APPROVAL in the tamper-evident
  // checksum chain, with the owner-override stamped in forever.
  const record = resolved.record;
  log(`  record.seq          = ${record.seq}`);
  log(`  record.kind         = ${record.kind}`);
  log(`  record.prevHash     = ${record.prevHash.slice(0, 16)}…`);
  log(`  record.thisHash     = ${record.thisHash.slice(0, 16)}…`);
  log(`  record.signer       = ${String(record.signerSourceId).slice(0, 24)}…`);
  const ownerOverride = (record.payload as { ownerOverride?: boolean }).ownerOverride;
  log(`  record.ownerOverride= ${String(ownerOverride)}`);
  for (const d of resolved.demotions) {
    log(`  demotion: ${String(d.demoted).slice(0, 24)}… → ${d.newState} (outranked, not erased)`);
  }

  // The final belief about the flooded attribute: still the owner's truth.
  const finalRecall = mem.recall("what is the deploy target?");
  const finalLive = finalRecall.facts.find(
    (f) => f.fact_state === FactState.LIVE && f.text.includes("prod-cluster-7"),
  );
  if (finalLive === undefined) throw new Error("demo: the owner's fact did not survive LIVE");

  log("");
  log(
    "The 50-identity fleet collapsed to quarantined noise. Nothing was deleted; " +
      "everything is labeled.",
  );

  mem.close();
  return { finalBelief: finalLive.text };
}

// Direct-execution guard: `node dist/examples/demo.js` runs the demo;
// importing it (demo.test.ts) does not.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
