/**
 * attack.ts — the PHASE-2 Sybil / memory-poisoning scenario, reused for the cross-DB
 * comparison (mirrors src/__bench__/capability/sybilPoisoning.capability.test.ts).
 *
 * For ONE (entity, attribute):
 *   - H honest sources each assert the TRUE value, each with a DISTINCT independence
 *     class (genuinely independent witnesses).
 *   - A "cheap Sybil" sources assert a FALSE value, all sharing ONE independence class
 *     (a fleet behind a single registrar/ASN/anchor) but with DISTINCT keys.
 *
 * A trust-aware engine (IntelligentDB) collapses the fleet to ONE independent witness
 * and recalls TRUE. A trust-blind engine (SQL majority/latest, KV majority, vector
 * nearest-neighbour) sees A copies out-number H and recalls FALSE once A >= H.
 *
 * Modeling note (load-bearing, stated honestly): the attacker controls KEYS (source ids)
 * freely but NOT independence-CLASS assignment — that is the external anchor layer's
 * output. So the cheap fleet is DISTINCT keys sharing ONE class; honest witnesses are
 * distinct classes. Sources are left unresolvable (null in the engine) so the identity
 * layer's documented fallback — class-disjointness — is the signal under test.
 *
 * Determinism: every id/value is derived from indices and the scenario seed; there is
 * NO Math.random and NO wall-clock dependence anywhere here.
 */

import type { Fact, Cue } from "./adapter.js";
import { embed } from "./embeddings.js";

/** A fully-built poisoning scenario for one (entity, attribute). */
export interface AttackScenario {
  /** Every asserted fact (H honest TRUE + A cheap-Sybil FALSE), interleaved. */
  readonly facts: readonly Fact[];
  /** The recall cue for the contested (entity, attribute). */
  readonly cue: Cue;
  /** The value an honest, trust-aware engine should recall. */
  readonly trueValue: string;
  /** The value the cheap fleet is trying to install. */
  readonly falseValue: string;
  readonly entity: string;
  readonly attribute: string;
  readonly H: number;
  readonly A: number;
}

/** Build one fact with its deterministic embedding (text = "entity attribute value"). */
function makeFact(
  entity: string,
  attribute: string,
  value: string,
  sourceId: string,
  independenceClass: string,
): Fact {
  return {
    entity,
    attribute,
    value,
    sourceId,
    independenceClass,
    embedding: embed(`${entity} ${attribute} ${value}`),
  };
}

/**
 * Build a cheap-Sybil poisoning scenario. `tag` makes every id/value unique per trial
 * so repeated trials over distinct (entity, attribute) targets do not interfere.
 *
 * Facts are INTERLEAVED honest/sybil (deterministically) so that a "latest wins" store
 * does not get a free pass from ordering — the attacker is assumed to control arrival
 * order, so we end on a Sybil assertion when A > 0.
 */
export function buildCheapSybilAttack(tag: string, H: number, A: number): AttackScenario {
  const entity = `entity:${tag}`;
  const attribute = `attr:${tag}`;
  const trueValue = `TRUE:${tag}`;
  const falseValue = `FALSE:${tag}`;

  const honest: Fact[] = [];
  for (let i = 0; i < H; i++) {
    honest.push(
      makeFact(entity, attribute, trueValue, `honest:${tag}:${i}`, `cls:honest:${tag}:${i}`),
    );
  }
  const sybil: Fact[] = [];
  for (let i = 0; i < A; i++) {
    // DISTINCT keys, ONE SHARED class (the fleet behind a single anchor).
    sybil.push(
      makeFact(entity, attribute, falseValue, `sybil:${tag}:${i}`, `cls:sybil:${tag}:SHARED`),
    );
  }

  // Interleave deterministically; honest first then sybil tail (attacker writes last).
  const facts: Fact[] = [];
  const maxLen = Math.max(honest.length, sybil.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < honest.length) facts.push(honest[i]!);
    if (i < sybil.length) facts.push(sybil[i]!);
  }

  const cue: Cue = { entity, attribute, embedding: embed(`${entity} ${attribute}`) };
  return { facts, cue, trueValue, falseValue, entity, attribute, H, A };
}
