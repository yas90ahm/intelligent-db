/**
 * factworld/generate.ts — synthetic closed-book entity-attribute QA with Sybil poison.
 *
 * The council's design: ~600 FICTIONAL entities, each with attributes whose value lives
 * ONLY in injected memory (so a no-memory model floors at chance — the construct-validity
 * floor). Each queried attribute has an assertion stream: an OLD value (single source) and
 * a CURRENT TRUE value asserted by TWO sources holding DISJOINT anchor classes (so ID sees
 * ≥2 independent roots backing it). The question asks the CURRENT value (exact-match).
 *
 * POISON variant: for a fraction of attributes, inject a SYBIL CLUSTER — K contradictory
 * wrong-value assertions on the EXACT queried attribute, all sharing ONE anchor class
 * (collapses to a single witness under ID), recency held constant vs the true fact. This
 * exercises ID's headcount-denial / anchor-disjointness — NOT recency. Undefended arms
 * (rag/mem0) see K dense near-duplicate poison statements that dominate similarity/headcount
 * and flip the answer; ID demotes the cluster and keeps the corroborated true value.
 *
 * Deterministic (seeded PRNG) so clean and poison banks are paired for a McNemar test.
 */

export type Condition = "clean" | "poison";

/** One asserted fact, with the provenance the ID arm needs + the text the rag/mem0 arms index. */
export interface Assertion {
  readonly entity: string;
  readonly attribute: string; // bare attribute key, e.g. "headquarters"
  readonly value: string; // the asserted (fictional) value
  readonly statement: string; // natural-language form indexed by rag/mem0
  readonly sourceId: string;
  readonly anchorClass: string; // the independence class this source's anchor belongs to
  readonly kind: "old" | "current" | "poison";
}

export interface FWQuestion {
  readonly entity: string;
  readonly attribute: string;
  readonly gold: string; // the CURRENT true value
  readonly poisoned: boolean; // whether a Sybil cluster targets this (entity,attribute)
  readonly poisonValue: string; // the attacker's target value (for an ASR readout)
}

export interface FactWorld {
  readonly assertions: Assertion[];
  readonly questions: FWQuestion[];
}

export interface FactWorldOptions {
  readonly entities: number;
  readonly condition: Condition;
  /** Fraction of queried attributes that receive a Sybil cluster (poison condition only). */
  readonly poisonRate: number;
  /** Sybil cluster size K (number of contradictory wrong-value assertions). */
  readonly sybilK: number;
  readonly seed?: number;
}

/** The attributes each entity carries; the label is what the question/statement uses. */
const ATTRIBUTES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "headquarters", label: "headquarters" },
  { key: "ceo", label: "CEO" },
  { key: "flagship_product", label: "flagship product" },
  { key: "parent_org", label: "parent organization" },
];

/** The human-readable label for an attribute key (for question/prompt text). */
export function labelOf(attrKey: string): string {
  return ATTRIBUTES.find((a) => a.key === attrKey)?.label ?? attrKey;
}

// ---- deterministic PRNG + fictional-token generator -------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONS = "bdfgklmnprstvz".split("");
const VOWELS = "aeiou".split("");

function makeToken(rng: () => number, syllables: number): string {
  let s = "";
  for (let i = 0; i < syllables; i++) {
    s += CONS[Math.floor(rng() * CONS.length)]!;
    s += VOWELS[Math.floor(rng() * VOWELS.length)]!;
    if (rng() < 0.4) s += CONS[Math.floor(rng() * CONS.length)]!;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A generator of UNIQUE fictional tokens (so values never collide / leak). */
function tokenFactory(rng: () => number): (syllables: number) => string {
  const used = new Set<string>();
  return (syllables: number): string => {
    for (let tries = 0; tries < 50; tries++) {
      const t = makeToken(rng, syllables);
      if (!used.has(t)) {
        used.add(t);
        return t;
      }
    }
    const t = makeToken(rng, syllables) + used.size;
    used.add(t);
    return t;
  };
}

function statementOf(entity: string, label: string, value: string): string {
  return `${entity}'s ${label} is ${value}.`;
}

/**
 * Build a FactWorld. Entities + values are fictional tokens; the CURRENT value carries two
 * disjoint anchor classes; the poison cluster shares one class. Same seed ⇒ identical clean
 * and poison banks (only the Sybil assertions differ), so the two conditions are paired.
 */
export function generateFactWorld(opts: FactWorldOptions): FactWorld {
  const rng = mulberry32(opts.seed ?? 1);
  const tok = tokenFactory(rng);

  const assertions: Assertion[] = [];
  const questions: FWQuestion[] = [];

  for (let e = 0; e < opts.entities; e++) {
    const entity = tok(3); // 3-syllable entity name
    for (const attr of ATTRIBUTES) {
      const oldValue = tok(2);
      const currentValue = tok(2);

      // OLD value — single source, its own class (a superseded distractor).
      assertions.push({
        entity, attribute: attr.key, value: oldValue,
        statement: statementOf(entity, `former ${attr.label}`, oldValue),
        sourceId: `src:old:${e}:${attr.key}`, anchorClass: `cls:old:${e}:${attr.key}`, kind: "old",
      });

      // CURRENT TRUE value — TWO sources, DISJOINT anchor classes (≥2 independent roots).
      for (const w of [1, 2]) {
        assertions.push({
          entity, attribute: attr.key, value: currentValue,
          statement: statementOf(entity, attr.label, currentValue),
          sourceId: `src:true${w}:${e}:${attr.key}`, anchorClass: `cls:true${w}:${e}:${attr.key}`, kind: "current",
        });
      }

      // POISON — a Sybil cluster on the EXACT attribute, all sharing ONE class.
      // ALWAYS draw the selection roll + poison token so clean and poison banks consume the
      // PRNG identically (⇒ same entities/values/questions ⇒ paired for McNemar). Only the
      // EMISSION of the Sybil assertions is condition-gated.
      const poisonRoll = rng();
      const poisonValue = tok(2);
      const poisoned = opts.condition === "poison" && poisonRoll < opts.poisonRate;
      if (poisoned) {
        const sharedClass = `cls:sybil:${e}:${attr.key}`;
        for (let k = 0; k < opts.sybilK; k++) {
          assertions.push({
            entity, attribute: attr.key, value: poisonValue,
            statement: statementOf(entity, attr.label, poisonValue),
            sourceId: `src:sybil:${e}:${attr.key}:${k}`, anchorClass: sharedClass, kind: "poison",
          });
        }
      }

      questions.push({ entity, attribute: attr.key, gold: currentValue, poisoned, poisonValue });
    }
  }

  return { assertions, questions };
}
