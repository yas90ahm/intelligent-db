/**
 * retrieval/qa/sybilScenarios.ts — DETERMINISTIC SYBIL-FLOOD CONTRADICTION CORPUS.
 *
 * A hardened replacement for the cycle-A "1 true text + 1 false text" contradiction
 * E2E. Each scenario is an (entity, attribute) with:
 *
 *   - a TRUE value asserted by exactly ONE independent, high-trust source
 *     (`src:authority`, a DISTINCT independence class per scenario), and
 *   - a PLAUSIBLE-FALSE value (a believable alternative number/word/date — NO
 *     "unverified"/"blog"/"rumor" tells) asserted by K CHEAP-SYBIL sources that each
 *     carry a DISTINCT passport key but SHARE ONE independence class (a fleet behind
 *     one anchor — the Source-Identity layer treats them as a single witness).
 *
 * The K Sybils are the MAJORITY of the raw memory set, so a reader that counts heads
 * is fooled. The point of the test is that the engine's REAL adjudication (the same
 * `createIdRetriever` → `engine.adjudicate` path the cycle-F runner already uses)
 * keeps the TRUE strand LIVE and DEMOTES every Sybil: headcount is never consulted;
 * the lone high-reputation independent source outranks the cheap shared-class fleet.
 *
 * Every text uses a NEUTRAL phrasing template (rotated deterministically) so the true
 * and false statements look equally credible — the ONLY differences are the value and
 * the (hidden) source identity. No RNG: the scenario table is fixed data and all ids,
 * classes, and phrasings are index-derived, so the corpus is byte-identical every run.
 *
 * PURE DATA: registers zero tests; never touches the engine, store, or embedder. The
 * runner (`contradictionRunner.test.ts`) materializes these as real engine strands.
 */

import type {
  ContradictionPair,
  Dataset,
  FactRecord,
  QueryRecord,
  RelationEdge,
} from "../dataset.js";

/** Number of cheap Sybil sources behind the FALSE value per scenario (the flood size). */
export const SYBIL_K = 5;

/** The single high-trust source that asserts every TRUE value (pre-earns reputation). */
export const AUTHORITY_SOURCE = "src:authority";

/**
 * One scenario specification: a real-world subject, the attribute question, and the
 * TRUE vs PLAUSIBLE-FALSE values. Values are BARE tokens (no units) so containment
 * scoring matches them inside a verbose reader answer; the unit lives only in the
 * surrounding prose. The false value is a believable alternative, never an obvious fake.
 */
interface ScenarioSpec {
  /** Stable short key (drives the entity id). */
  readonly key: string;
  /** The real-world subject named in every memory text. */
  readonly subject: string;
  /** Short attribute noun-phrase used in the prose ("elevation", "population", ...). */
  readonly attrPhrase: string;
  /** Unit suffix for the prose ("meters", "" for bare words/years). */
  readonly unit: string;
  /** The grounded-QA question (identical across the raw and adjudicated arms). */
  readonly question: string;
  /** The planted-TRUE value (scored target). */
  readonly trueVal: string;
  /** The plausible-FALSE value the Sybil fleet floods. */
  readonly falseVal: string;
}

/**
 * 20 fixed scenarios. Plausible alternatives only (a different believable number,
 * city, language, or year) — nothing that telegraphs which is fake. Subjects are
 * synthetic so no LLM world-knowledge prior can shortcut the contradiction.
 */
const SCENARIOS: readonly ScenarioSpec[] = [
  { key: "caldera-elev", subject: "Mount Caldera", attrPhrase: "elevation", unit: "meters",
    question: "What is the elevation of Mount Caldera, in meters?", trueVal: "3120", falseVal: "4860" },
  { key: "velvae-len", subject: "the Velvae River", attrPhrase: "length", unit: "kilometers",
    question: "How long is the Velvae River, in kilometers?", trueVal: "1740", falseVal: "2310" },
  { key: "pellgrave-pop", subject: "Pellgrave", attrPhrase: "population", unit: "",
    question: "What is the population of Pellgrave?", trueVal: "248000", falseVal: "612000" },
  { key: "oranta-cap", subject: "Oranta province", attrPhrase: "capital", unit: "",
    question: "What is the capital of Oranta province?", trueVal: "Khelm", falseVal: "Drovia" },
  { key: "tarsis-lang", subject: "Tarsis", attrPhrase: "official language", unit: "",
    question: "What is the official language of Tarsis?", trueVal: "Veltic", falseVal: "Mendish" },
  { key: "nimbus-founded", subject: "Nimbus Labs", attrPhrase: "founding year", unit: "",
    question: "In what year was Nimbus Labs founded?", trueVal: "1962", falseVal: "1928" },
  { key: "esterhold-area", subject: "Esterhold", attrPhrase: "land area", unit: "square kilometers",
    question: "What is the land area of Esterhold, in square kilometers?", trueVal: "5400", falseVal: "8900" },
  { key: "galmont-temp", subject: "Galmont", attrPhrase: "record high temperature", unit: "degrees Celsius",
    question: "What is the record high temperature of Galmont, in degrees Celsius?", trueVal: "39", falseVal: "47" },
  { key: "rookwell-depth", subject: "Lake Rookwell", attrPhrase: "maximum depth", unit: "meters",
    question: "What is the maximum depth of Lake Rookwell, in meters?", trueVal: "84", falseVal: "152" },
  { key: "suthby-built", subject: "the Suthby Bridge", attrPhrase: "completion year", unit: "",
    question: "In what year was the Suthby Bridge completed?", trueVal: "1971", falseVal: "1994" },
  { key: "norvelt-pop", subject: "Norvelt", attrPhrase: "population", unit: "",
    question: "What is the population of Norvelt?", trueVal: "94000", falseVal: "310000" },
  { key: "calderon-rain", subject: "Calderon", attrPhrase: "annual rainfall", unit: "millimeters",
    question: "What is the annual rainfall of Calderon, in millimeters?", trueVal: "840", falseVal: "1320" },
  { key: "ashfen-curr", subject: "Ashfen", attrPhrase: "national currency", unit: "",
    question: "What is the national currency of Ashfen?", trueVal: "drael", falseVal: "marc" },
  { key: "tindrel-alt", subject: "Tindrel", attrPhrase: "altitude", unit: "meters",
    question: "What is the altitude of Tindrel, in meters?", trueVal: "1280", falseVal: "2050" },
  { key: "morwick-est", subject: "Morwick University", attrPhrase: "year established", unit: "",
    question: "In what year was Morwick University established?", trueVal: "1887", falseVal: "1845" },
  { key: "beldon-span", subject: "the Beldon Tunnel", attrPhrase: "length", unit: "meters",
    question: "What is the length of the Beldon Tunnel, in meters?", trueVal: "7300", falseVal: "11200" },
  { key: "ravenna-pop", subject: "Ravenna Harbor", attrPhrase: "population", unit: "",
    question: "What is the population of Ravenna Harbor?", trueVal: "172000", falseVal: "455000" },
  { key: "strand-port", subject: "Strand", attrPhrase: "number of berths", unit: "",
    question: "How many berths does the port of Strand have?", trueVal: "46", falseVal: "118" },
  { key: "holloway-year", subject: "Holloway Observatory", attrPhrase: "opening year", unit: "",
    question: "In what year did Holloway Observatory open?", trueVal: "1953", falseVal: "1979" },
  { key: "veldoria-cap", subject: "Veldoria", attrPhrase: "administrative capital", unit: "",
    question: "What is the administrative capital of Veldoria?", trueVal: "Castermel", falseVal: "Wyndmoor" },
];

/** Neutral phrasings (rotated deterministically) — equally credible for true & false. */
const PHRASINGS: ReadonlyArray<(subject: string, attr: string, valued: string) => string> = [
  (s, a, v) => `The ${a} of ${s} is ${v}.`,
  (s, a, v) => `Records list the ${a} of ${s} as ${v}.`,
  (s, a, v) => `${s} has a ${a} of ${v}.`,
  (s, a, v) => `According to municipal documentation, the ${a} of ${s} is ${v}.`,
  (s, a, v) => `Surveys give the ${a} of ${s} as ${v}.`,
  (s, a, v) => `For ${s}, the ${a} is recorded as ${v}.`,
];

/** Stitch a value with its unit into the prose ("3120 meters"; bare "Khelm"). */
function valued(val: string, unit: string): string {
  return unit.length > 0 ? `${val} ${unit}` : val;
}

/** Per-scenario materialized view the runner needs (questions + the planted ids). */
export interface SybilScenario {
  readonly key: string;
  readonly entity: string;
  /** Human-readable real-world subject named in the memory texts (for sample reporting). */
  readonly subject: string;
  readonly attribute: string;
  readonly question: string;
  readonly trueVal: string;
  readonly falseVal: string;
  readonly trueFactId: string;
  readonly sybilFactIds: readonly string[];
}

export interface SybilCorpus {
  /** A real {@link Dataset} the engine retriever ingests + adjudicates. */
  readonly dataset: Dataset;
  /** Per-scenario question + planted ids for the runner. */
  readonly scenarios: readonly SybilScenario[];
  /** factId -> memory text (for assembling reader contexts). */
  readonly factText: ReadonlyMap<string, string>;
  /** Sybils-per-scenario (the flood size K). */
  readonly k: number;
}

/**
 * Build the Sybil-flood corpus deterministically. Produces, per scenario:
 *   - ONE true {@link FactRecord} (source `src:authority`, a distinct class), and
 *   - K Sybil {@link FactRecord}s (distinct keys, ONE shared class), all with the SAME
 *     (entity, attribute) so the engine's attribute index collects them into a single
 *     contradiction set the real adjudicator resolves.
 * The contradiction set therefore spans exactly TWO independence classes (true vs the
 * shared Sybil class) — the multi-class decisive-or-defer path — and the authority's
 * pre-earned reputation gives the decisive, earned margin that keeps it LIVE while the
 * weightless Sybil fleet (reputation 0, any headcount) is demoted.
 */
export function buildSybilCorpus(): SybilCorpus {
  const facts: FactRecord[] = [];
  const edges: RelationEdge[] = []; // none needed: shared-entity join is the store's index
  const queries: QueryRecord[] = [];
  const contradictions: ContradictionPair[] = [];
  const scenarios: SybilScenario[] = [];
  const factText = new Map<string, string>();

  SCENARIOS.forEach((spec, i) => {
    const entity = `SYB${i}`;
    const attribute = `${entity}#${spec.key}`;
    const trueFactId = `f:syb-true:${i}`;
    const trueText = PHRASINGS[0]!(spec.subject, spec.attrPhrase, valued(spec.trueVal, spec.unit));

    facts.push({
      id: trueFactId, entity, attribute, value: spec.trueVal, text: trueText,
      sourceClass: `class:syb-true:${i}`, sourceId: AUTHORITY_SOURCE,
    });
    factText.set(trueFactId, trueText);

    const sybilFactIds: string[] = [];
    for (let k = 0; k < SYBIL_K; k++) {
      const id = `f:syb-false:${i}:${k}`;
      // Rotate a NEUTRAL phrasing (offset so it differs from the true text's template),
      // so the K Sybils read as distinct sources stating the same value — not one
      // sentence pasted K times — yet carry no credibility tell vs the true statement.
      const phrase = PHRASINGS[(k + 1) % PHRASINGS.length]!;
      const text = phrase(spec.subject, spec.attrPhrase, valued(spec.falseVal, spec.unit));
      facts.push({
        id, entity, attribute, value: spec.falseVal, text,
        // DISTINCT key per Sybil, but ONE SHARED independence class (the fleet/anchor).
        sourceClass: `class:syb-false:${i}`, sourceId: `src:sybil:${i}:${k}`,
      });
      factText.set(id, text);
      sybilFactIds.push(id);
    }

    const pair: ContradictionPair = {
      attribute, entity, trueFactId, falseFactId: sybilFactIds[0]!,
    };
    contradictions.push(pair);
    queries.push({
      id: `q:sybil:${i}`,
      category: "CONTRADICTION",
      cueText: spec.question,
      cueEntities: [entity],
      relevant: [trueFactId],
      contradiction: pair,
    });
    scenarios.push({
      key: spec.key, entity, subject: spec.subject, attribute, question: spec.question,
      trueVal: spec.trueVal, falseVal: spec.falseVal, trueFactId, sybilFactIds,
    });
  });

  const dataset: Dataset = {
    facts, edges, queries, contradictions, trustedSources: [AUTHORITY_SOURCE],
  };
  return { dataset, scenarios, factText, k: SYBIL_K };
}

/**
 * Deterministic context shuffle: order memory texts by an FNV-1a hash of the fact id so
 * the true text is not pinned to a fixed slot, yet the order is identical every run
 * (temperature-0 determinism end to end). No RNG.
 */
export function deterministicOrder(ids: readonly string[]): string[] {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return [...ids].sort((a, b) => (fnv(a) - fnv(b)) || (a < b ? -1 : 1));
}
