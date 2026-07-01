/**
 * generalization/costlyIndependent.generate.ts — the COSTLY-INDEPENDENT failure-mode world.
 *
 * This is the honest-boundary variant of factworld. The thesis of the whole Source-Identity
 * Layer is "identity is PRICED, not PREVENTED": the web converts an unbounded, free Sybil
 * attack into a bounded, PRICED, visible one — it does NOT make Sybil impossible. This world
 * is built to EXHIBIT that boundary as a clean curve rather than hide it.
 *
 * In factworld the poison cluster is a CHEAP Sybil: K sources that all share ONE anchor
 * class, so the engine's #R (max-independent-set over the backing roots) collapses them to a
 * SINGLE witness (R=1) and the corroborated true value (R=2) demotes them — ASR ≈ 0.
 *
 * Here we let the attacker PAY. The K poison sources hold GENUINELY-INDEPENDENT, DISJOINT
 * anchor classes (each poison source a DIFFERENT real anchor class, exactly like the gold
 * side), and we SWEEP an "independence level" L = 1..K = how many distinct anchor classes the
 * poison sources spread across:
 *
 *   - L = 1  → all K poison sources share one class → #R(poison) = 1 → the cheap Sybil → ID
 *              demotes the cluster (the factworld result; ASR ≈ 0).
 *   - L = 2  → poison reaches #R = 2, matching the true value's depth → the engine can no
 *              longer call a DECISIVE depth winner → it DEFERS (the poison value survives LIVE
 *              alongside the truth → contamination).
 *   - L ≥ 3  → poison out-DEPTHS the true value AND (when the attacker ALSO buys an earned
 *              reputation track record) out-RANKS it → the engine RESOLVES *for the poison*,
 *              demoting the truth → full capture.
 *
 * So as the attacker pays for more independent anchors (and optionally reputation), ID's
 * defense DEGRADES and its ASR rises toward an undefended retriever's. That degradation is
 * the POINT: it is the priced-not-prevented residual made into a measurable curve.
 *
 * This file generates only the abstract per-item facts (fictional entity/attribute/values).
 * The *anchor wiring* — how many disjoint classes the poison spreads across at a given
 * independence level, and whether the poison earns reputation — lives in the ARM
 * (costlyIndependent.arm.ts), so the same world can be replayed across the whole sweep.
 *
 * Deterministic (seeded PRNG), fictional tokens, ZERO external deps.
 */

/** One attacked (entity, attribute): a true value vs the attacker's target poison value. */
export interface CIItem {
  readonly entity: string;
  readonly attribute: string; // bare attribute key, e.g. "headquarters"
  readonly gold: string; // the CURRENT true value (backed by 2 disjoint anchor classes)
  readonly poison: string; // the attacker's target value (backed by the poison cluster)
}

export interface CIWorldOptions {
  /** Number of attacked (entity, attribute) items to generate. */
  readonly items: number;
  readonly seed?: number;
}

// ---- deterministic PRNG + fictional-token generator (mirrors factworld) ------

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

const ATTRIBUTES: readonly string[] = ["headquarters", "ceo", "flagship_product", "parent_org"];

/**
 * Build the abstract world: `items` attacked (entity, attribute) pairs with fictional gold +
 * poison values. Every item is structurally identical (one gold value backed by 2 disjoint
 * classes; one poison value backed by the cluster) so the resulting ASR curve isolates the
 * ONE variable we sweep — the poison's independence level — rather than per-item noise.
 */
export function generateCostlyWorld(opts: CIWorldOptions): readonly CIItem[] {
  const rng = mulberry32(opts.seed ?? 1);
  const tok = tokenFactory(rng);
  const out: CIItem[] = [];
  for (let i = 0; i < opts.items; i++) {
    const entity = tok(3);
    const attribute = ATTRIBUTES[i % ATTRIBUTES.length]!;
    const gold = tok(2);
    const poison = tok(2);
    out.push({ entity, attribute, gold, poison });
  }
  return out;
}
