/**
 * __torture__/killWorker.ts — the CHILD PROCESS entry point for the kill-loop
 * (docs/specs/PHASE2_DURABILITY_SPEC.md §4a).
 *
 * Invoked as `node <built>/__torture__/killWorker.js <dbPath> <seed>`. Opens (or
 * resumes) the db at `dbPath`, re-registers the deterministic roster, then loops
 * FOREVER performing randomized compound ops (writeFact / writeFactsBatch /
 * adjudicate / approve / disown / ratify) against the live engine until the parent
 * SIGKILLs it — there is deliberately no graceful shutdown path here: an unclean,
 * mid-operation kill is the entire point of this harness. Any op that throws
 * (a legitimate domain rejection — e.g. approve() on an empty pending queue, or a
 * ratify gate failing) is swallowed and the loop continues; this process is never
 * expected to exit on its own.
 */

import { asEpochMs } from "../index.js";
import type { IdentityStamp, SourceId, StrandId } from "../index.js";

import { wireEngine } from "./harness.js";
import {
  ALL_ATTRIBUTES,
  APPROVER_SOURCE,
  AUTHOR_SOURCES,
  DISOWNABLE_SOURCE,
  ENTITIES,
  attributesOf,
  registerRoster,
} from "./roster.js";

const dbPath = process.argv[2];
const seedArg = process.argv[3];
if (dbPath === undefined) {
  throw new Error("killWorker: missing required argv[2] dbPath");
}
const seed = seedArg !== undefined ? Number(seedArg) : Date.now();

// Small deterministic PRNG (mulberry32) — reproducible op sequences per seed, no
// dependency on Math.random()'s non-reproducibility (useful for replaying a cycle
// that found a violation).
function mulberry32(a: number): () => number {
  let state = a >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const randInt = (n: number): number => Math.floor(rand() * n);
const pick = <T>(arr: readonly T[]): T => {
  const v = arr[randInt(arr.length)];
  if (v === undefined) throw new Error("killWorker: pick() from an empty array");
  return v;
};

const w = wireEngine(dbPath);
registerRoster(w);

function stampOf(sourceId: SourceId): IdentityStamp {
  return w.identity.stampFor(sourceId);
}

/** In-process cache of strand ids this worker has written, for ratify targets. Bounded. */
const recentStrandIds: StrandId[] = [];
function rememberStrand(id: StrandId): void {
  recentStrandIds.push(id);
  if (recentStrandIds.length > 200) recentStrandIds.shift();
}

// Deliberately LOW-CARDINALITY payload values (not a huge random range): with only
// a handful of distinct values per (entity, attribute), independent writers land on
// the SAME `content_hash` often, so genuine same-value agreement (the engine's
// `#deriveAgreementSet`: same entity + content_hash + LIVE) — and therefore a real,
// corroboration-event-tracked reputation gain on ratify — actually occurs. With a
// huge random range every payload would be content-unique and every ratify would be
// an "ordinary, no-named-corroborators" gain (a real, DOCUMENTED, non-reversible-by-
// disown residual per `api.ts`'s `#ratifyImpl` — not a bug), which would make
// `reconcileLedger` report a drift that is expected-by-design rather than a genuine
// atomicity break — exactly the false-positive this suite must not manufacture.
const PAYLOAD_CARDINALITY = 6;

function doWriteFact(): void {
  const entity = pick(ENTITIES);
  const attribute = pick(attributesOf(entity));
  const author = pick(AUTHOR_SOURCES);
  const id = w.engine.writeFact({
    entity,
    attribute,
    payload: { v: randInt(PAYLOAD_CARDINALITY), tag: "torture-write" },
    stamp: stampOf(author.id),
  });
  rememberStrand(id);
}

function doWriteFactsBatch(): void {
  const n = 2 + randInt(3);
  const inputs = Array.from({ length: n }, () => {
    const entity = pick(ENTITIES);
    const attribute = pick(attributesOf(entity));
    const author = pick(AUTHOR_SOURCES);
    return {
      entity,
      attribute,
      payload: { v: randInt(PAYLOAD_CARDINALITY), tag: "torture-batch" },
      stamp: stampOf(author.id),
    };
  });
  const ids = w.engine.writeFactsBatch(inputs);
  for (const id of ids) rememberStrand(id);
}

function doAdjudicate(): void {
  const attribute = pick(ALL_ATTRIBUTES);
  w.engine.adjudicate(attribute, { highImpact: randInt(10) === 0 });
}

function doApprove(): void {
  const open = w.engine.listPending();
  if (open.length === 0) return;
  const dispute = pick(open);
  const winner = pick(dispute.members);
  w.engine.approve(dispute.contradictionSetId, winner, APPROVER_SOURCE, asEpochMs(Date.now()));
}

function doDisown(): void {
  w.engine.disown(DISOWNABLE_SOURCE);
}

/**
 * Ratify a strand that ALREADY has a genuine same-value agreement (another LIVE
 * strand sharing its `content_hash`) — so the gain is corroboration-event-tracked
 * (`#deriveAgreementSet` non-empty), matching what the low-cardinality payloads
 * above make routine. A strand with no live sibling is skipped rather than forced:
 * ratifying it would still be a LEGITIMATE, engine-correct "ordinary ratify, no
 * named corroborators" — just not a case `reconcileLedger` is meant to bless (see
 * the constant's doc above), so exercising ONLY the corroborated case keeps the
 * kill-loop's reconcile assertion meaningful (a drift it DOES catch is a genuine
 * atomicity break, not routine documented behavior).
 */
function doRatify(): void {
  const attempts = Math.min(recentStrandIds.length, 8);
  for (let i = 0; i < attempts; i++) {
    const strandId = pick(recentStrandIds);
    const explained = w.engine.explain(strandId);
    if (explained !== null && explained.agreementStrandIds.length > 0) {
      w.engine.ratify({ strandId, externalStamp: stampOf(APPROVER_SOURCE) });
      return;
    }
  }
}

// Weighted so writeFact dominates (the common case) with the compound/rarer ops
// (adjudicate/approve/disown/ratify) interleaved often enough to be torturable.
const OPS: readonly (() => void)[] = [
  doWriteFact,
  doWriteFact,
  doWriteFact,
  doWriteFactsBatch,
  doAdjudicate,
  doAdjudicate,
  doApprove,
  doRatify,
  doRatify,
  doDisown,
];

// Signal READY once wiring + roster registration is done and the op loop is about
// to start: Node process cold-start (module load, SQLite open, migrations) can
// itself eat the whole 5-50ms kill window, so the parent times its kill delay from
// THIS line, not from spawn — otherwise most cycles would kill the process before
// it ever performs a single op, defeating the point of the suite.
console.log("TORTURE_READY");

// A safety backstop only — the parent is expected to SIGKILL well before this many
// ops run; it exists so a torture worker started outside the kill-loop (e.g. ad hoc
// manual testing) does not spin forever.
const MAX_OPS = 5_000_000;
let opCount = 0;
while (opCount < MAX_OPS) {
  opCount++;
  try {
    pick(OPS)();
  } catch {
    // Expected: many randomized ops legitimately reject (self-approval, unknown
    // dispute, empty pending queue, gate failures). The point of this loop is
    // real engine activity to be interrupted mid-flight, not op success.
  }
}
