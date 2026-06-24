/**
 * adjudication.bench.ts — CONTRADICTION ADJUDICATION (tryConsolidate).
 *
 * Two shapes the pure adjudicator must handle:
 *   - SINGLE-CLASS echo dispute (the safe case): all members share one independence
 *     class ⇒ resolved by external-signal tiebreak; a fresh same-class flood falls to
 *     the deterministic id tiebreak (one survives, the rest demote). This is the
 *     contradiction-bomb surface — we bench a 50-member flood.
 *   - MULTI-CLASS independent dispute: members span >1 class ⇒ the decisive-or-defer
 *     gate runs; a weightless flood DEFERS (demotes nothing). Benched at 50 members.
 *
 * tryConsolidate is PURE and mutates the member objects in place on a RESOLVED
 * outcome, so each iteration rebuilds the members (cheap, scoped to the bench) to keep
 * the input pristine. We also bench the engine's `adjudicate` over a memory store for
 * the wired path.
 */

import { bench, describe } from "vitest";

import {
  FactState,
  buildContradictionSet,
  createIntelligentDb,
  createMemoryStore,
  tryConsolidate,
} from "../index.js";
import type {
  AttributeKey,
  EntityId,
  IdentityStamp,
  IntelligentDb,
  ProvenanceRootId,
  SourceId,
  Strand,
} from "../index.js";

import { bareStamp, makeIdentity, makeStrand } from "./fixtures.js";

const ENTITY = "entity:adj" as EntityId;
const ATTR = "adj#attr" as AttributeKey;
const FLOOD = 50;

/** Build `n` disputing members. `multiClass` gives each its own class (independent). */
function buildMembers(n: number, multiClass: boolean): Strand[] {
  const out: Strand[] = [];
  for (let i = 0; i < n; i++) {
    const cls = multiClass ? `cls:adj:${i}` : "cls:adj:shared";
    // Distinct payloads so they genuinely DISAGREE (distinct claims).
    out.push(makeStrand(`adj:${multiClass ? "mc" : "sc"}:${i}`, ENTITY, (`src:adj:${i}` as SourceId), cls, { v: i }, ATTR));
  }
  return out;
}

/** Per-root identity stamps (all fresh/weightless ⇒ reputation 0). */
function stampsFor(members: Strand[]): Map<ProvenanceRootId, IdentityStamp> {
  const m = new Map<ProvenanceRootId, IdentityStamp>();
  for (const s of members) {
    for (const root of s.provenance) {
      if (root.sourceId === null) continue;
      m.set(root.rootId, bareStamp(root.sourceId));
    }
  }
  return m;
}

const NOW = makeStrand("dummy", ENTITY, null, "c", {}).observedAt;

describe("ADJUDICATION · tryConsolidate (pure)", () => {
  bench(`single-class flood (${FLOOD} echoes)`, () => {
    const members = buildMembers(FLOOD, false);
    const set = buildContradictionSet(members);
    tryConsolidate(set, members, stampsFor(members), NOW);
  });

  bench(`multi-class flood (${FLOOD} independents ⇒ DEFER)`, () => {
    const members = buildMembers(FLOOD, true);
    const set = buildContradictionSet(members);
    tryConsolidate(set, members, stampsFor(members), NOW);
  });
});

describe("ADJUDICATION · engine.adjudicate (single-class, wired)", () => {
  bench(`engine resolve (${FLOOD} members over memory store)`, () => {
    const store = createMemoryStore();
    for (const s of buildMembers(FLOOD, false)) store.putStrand({ ...s, fact_state: FactState.LIVE });
    const db: IntelligentDb = createIntelligentDb(store, makeIdentity().identity);
    db.adjudicate(ATTR);
  });
});
