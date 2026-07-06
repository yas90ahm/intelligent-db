/**
 * retrieval/dataset.ts — SYNTHETIC CORPUS + PLANTED GROUND TRUTH.
 *
 * Deterministic (seeded LCG, no unseeded Math.random): the exact same corpus,
 * queries, and ground-truth relevant sets are produced on every run and machine.
 *
 * The corpus is a small synthetic knowledge graph of PEOPLE -> COMPANIES -> CITIES,
 * plus disconnected PARAPHRASE rings and CONTRADICTION pairs. It is organized so that
 * for each query we KNOW the relevant fact-id set and which retrieval CATEGORY it
 * exercises:
 *
 *   DIRECT       — the fact literally stating the answer (shares the cue's entity).
 *   MULTIHOP     — relevant facts reachable ONLY by following relations (A->B->C),
 *                  about a DIFFERENT entity with DIFFERENT vocabulary than the cue
 *                  (structure-reachable, semantically distant).
 *   PARAPHRASE   — relevant facts with NO shared entity and NO edge to the seed, only
 *                  semantic similarity (a synonym ring; vector-reachable, structure-
 *                  invisible).
 *   CONTRADICTION— an (entity,attribute) with two conflicting values from DIFFERENT
 *                  independence classes/sources (one planted-true, one planted-false).
 *
 * DISTRACTOR traps are woven in globally: every cluster reuses the same sentence
 * templates, so facts about OTHER people/companies are strong semantic near-misses
 * that a vector retriever is tempted to pull but that are NOT in any ground-truth set.
 *
 * This module is PURE DATA: it registers zero tests and never touches the engine,
 * the store, or the embedder.
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — every draw derives from the seed only.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type Category = "DIRECT" | "MULTIHOP" | "PARAPHRASE" | "CONTRADICTION";

/** One synthetic fact record. `text` is what gets embedded. */
export interface FactRecord {
  readonly id: string;
  readonly entity: string;
  readonly attribute: string;
  readonly value: string;
  readonly text: string;
  /** Offline-assigned independence class for this fact's single provenance root. */
  readonly sourceClass: string;
  /**
   * The source (registered source id) that asserted this fact, or `null` for an
   * anonymous/unresolvable corroborating witness (the NULL-SOURCE FALLBACK the real
   * identity layer treats as independent-by-default once its independence class
   * differs from the compared root — see `identity/index.ts`'s `independent(a,b)`).
   */
  readonly sourceId: string | null;
  /**
   * OPTIONAL: when set, `createIdRetriever` mints this fact's strand `content_hash`
   * from THIS key instead of the fact's own `id` — the mechanism a genuinely SEPARATE
   * corroborating witness (its own fact id, so its own strand) needs to be counted as
   * "agreeing" by the engine's `#deriveAgreementSet`/`#R` (same entity + same
   * content_hash + LIVE, `api.ts:1494-1529`). Set this to the PRIMARY fact's `id` to
   * make a second fact corroborate it (same VALUE fingerprint, distinct strand,
   * distinct provenance root/class) without colliding strand ids.
   */
  readonly contentHashKey?: string;
}

/** A directed, typed relation between two facts (the shared graph's edges). */
export interface RelationEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "SHARED_ENTITY" | "CONFIRMED_LINK";
}

/** A planted contradiction over one (entity, attribute): two conflicting facts. */
export interface ContradictionPair {
  readonly attribute: string;
  readonly entity: string;
  /** The fact id whose value is planted-TRUE (the source pre-earns reputation). */
  readonly trueFactId: string;
  /** The fact id whose value is planted-FALSE. */
  readonly falseFactId: string;
}

/** One evaluation query with its planted ground-truth relevant set. */
export interface QueryRecord {
  readonly id: string;
  readonly category: Category;
  readonly cueText: string;
  /** Entities the cue explicitly names (drive the shared entity-match seed). */
  readonly cueEntities: readonly string[];
  /** The planted set of relevant fact ids. */
  readonly relevant: readonly string[];
  /** For CONTRADICTION queries: which pair this targets. */
  readonly contradiction?: ContradictionPair;
}

export interface Dataset {
  readonly facts: readonly FactRecord[];
  readonly edges: readonly RelationEdge[];
  readonly queries: readonly QueryRecord[];
  readonly contradictions: readonly ContradictionPair[];
  /** Source ids that must pre-earn reputation (the planted-true contradiction sources). */
  readonly trustedSources: readonly string[];
}

// ---------------------------------------------------------------------------
// Vocabulary pools (indexed deterministically; suffixed for uniqueness)
// ---------------------------------------------------------------------------

const FIRST = [
  "Alice", "Bruno", "Carmen", "Diego", "Elena", "Farid", "Greta", "Hassan",
  "Ingrid", "Jonas", "Kira", "Liam", "Mara", "Nikolai", "Olga", "Pavel",
  "Quinn", "Rosa", "Sven", "Tara", "Umar", "Vera", "Wendy", "Xavier",
  "Yara", "Zane", "Anya", "Bilal", "Cora", "Dmitri",
];
const LAST = [
  "Vance", "Okafor", "Rivera", "Sato", "Novak", "Haddad", "Lindqvist", "Mbeki",
  "Larsen", "Costa", "Petrov", "Nguyen", "Khan", "Romano", "Fischer", "Tanaka",
  "Cohen", "Adeyemi", "Wirth", "Bauer", "Sorokin", "Mendez", "Park", "Olsson",
];
const COMPANY_ROOT = [
  "Helix", "Aurora", "Nimbus", "Vertex", "Quanta", "Solace", "Meridian", "Cobalt",
  "Lumen", "Forge", "Cypress", "Orbit", "Tessera", "Granite", "Halcyon", "Verdant",
  "Ironwood", "Skylark", "Drift", "Pinnacle", "Cinder", "Mosaic", "Talon", "Zephyr",
];
const COMPANY_SUFFIX = ["Systems", "Labs", "Works", "Dynamics", "Industries", "Group"];
const CITY = [
  "Marisburg", "Khelm", "Stonereach", "Veldoria", "Brackton", "Ourenne", "Tallhaven",
  "Castermel", "Drovia", "Pellgrave", "Wyndmoor", "Esterhold", "Galmont", "Rookwell",
  "Suthby", "Norvelt", "Calderon", "Ashfen", "Tindrel", "Morwick", "Beldon", "Ravenna",
  "Strand", "Holloway",
];
const COUNTRY = [
  "Velanthia", "Karst", "Oranta", "Druvia", "Mellany", "Tarsis", "Eskeland", "Nuvora",
];
const CONTINENT = [
  "Aethyr", "Borealis", "Cendara", "Drakmoor", "Estavia", "Fennland",
];
const ROLE = [
  "structural engineer", "logistics coordinator", "data analyst", "pharmacologist",
  "marine biologist", "tax auditor", "set designer", "wind-turbine technician",
  "archivist", "soil scientist", "patent attorney", "ceramics restorer",
];
const PRODUCT = [
  "hydraulic valves", "lattice antennas", "thermal sensors", "ceramic bearings",
  "optical filters", "carbon panels", "polymer gaskets", "torsion springs",
  "vacuum pumps", "alloy fasteners", "circuit boards", "drive shafts",
];
const ROLE_CONCEPT = [
  "competitive sailor", "amateur astronomer", "marathon runner", "jazz pianist",
  "beekeeper", "chess champion", "rock climber", "documentary filmmaker",
  "wildlife photographer", "long-distance cyclist", "antique-clock collector",
  "volunteer firefighter", "orchid grower", "glassblower", "falconer",
  "cave diver", "vintage-radio restorer",
];
const RING_VERB = ["is a", "works as a", "serves as a", "is known as a", "is a dedicated"];

function pick<T>(pool: readonly T[], i: number): T {
  return pool[i % pool.length]!;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const NUM_CLUSTERS = 24;
const NUM_RINGS = 17;
const RING_SIZE = 3;
const NUM_CONTRADICTIONS = 15;
const TARGET_FACTS = 320;

export interface BuildOptions {
  readonly seed?: number;
}

export function buildDataset(opts: BuildOptions = {}): Dataset {
  const seed = opts.seed ?? 0xc0ffee;
  const rnd = mulberry32(seed);
  const facts: FactRecord[] = [];
  const edges: RelationEdge[] = [];
  const queries: QueryRecord[] = [];
  const contradictions: ContradictionPair[] = [];

  let nameCursor = 0;
  const uniqName = (): { first: string; last: string; full: string } => {
    const f = pick(FIRST, nameCursor);
    const l = pick(LAST, Math.floor(nameCursor / FIRST.length) + nameCursor);
    nameCursor += 1;
    return { first: f, last: l, full: `${f} ${l}` };
  };
  const companyName = (i: number): string =>
    `${pick(COMPANY_ROOT, i)} ${pick(COMPANY_SUFFIX, Math.floor(i / 3) + i)}`;

  const addFact = (f: FactRecord): void => {
    facts.push(f);
  };
  const link = (from: string, to: string): void => {
    edges.push({ from, to, type: "CONFIRMED_LINK" });
  };
  const sharedEntityClique = (ids: readonly string[]): void => {
    for (let a = 0; a < ids.length; a++) {
      for (let b = 0; b < ids.length; b++) {
        if (a === b) continue;
        edges.push({ from: ids[a]!, to: ids[b]!, type: "SHARED_ENTITY" });
      }
    }
  };

  // === 1) PERSON -> COMPANY -> CITY clusters ================================
  interface Cluster {
    i: number;
    personName: string;
    personEntity: string;
    companyEntity: string;
    hqEntity: string;
    company: string;
    city: string;
    role: string;
    hqCity: string;
    product: string;
    year: string;
    country: string;
    continent: string;
    f: Record<string, string>; // role -> factId
  }
  const clusters: Cluster[] = [];

  for (let i = 0; i < NUM_CLUSTERS; i++) {
    const person = uniqName();
    const personEntity = `P${i}`;
    const companyEntity = `C${i}`;
    const hqEntity = `H${i}`;
    const company = companyName(i);
    const city = pick(CITY, i);
    const role = pick(ROLE, i + (seed & 7));
    const hqCity = pick(CITY, i + 7); // HQ city differs from residence
    const product = pick(PRODUCT, i + 2);
    const year = String(1950 + ((Math.floor(rnd() * 70) + i) % 70));
    const country = pick(COUNTRY, i);
    const continent = pick(CONTINENT, i);

    const idEmp = `f:emp:${i}`;
    const idRes = `f:res:${i}`;
    const idRole = `f:role:${i}`;
    const idHq = `f:hq:${i}`;
    const idProd = `f:prod:${i}`;
    const idFound = `f:found:${i}`;
    const idPop = `f:pop:${i}`;
    const idCountry = `f:country:${i}`;
    const idRegion = `f:region:${i}`; // 3 hops from the person (emp->hq->country->region)

    const src = `src:cluster:${i}`;

    addFact({ id: idEmp, entity: personEntity, attribute: `${personEntity}#employer`, value: company,
      text: `${person.full} works at ${company}.`, sourceClass: `class:emp:${i}`, sourceId: src });
    addFact({ id: idRes, entity: personEntity, attribute: `${personEntity}#city`, value: city,
      text: `${person.full} lives in ${city}.`, sourceClass: `class:res:${i}`, sourceId: src });
    addFact({ id: idRole, entity: personEntity, attribute: `${personEntity}#role`, value: role,
      text: `${person.full} works as a ${role}.`, sourceClass: `class:role:${i}`, sourceId: src });
    addFact({ id: idHq, entity: companyEntity, attribute: `${companyEntity}#hq`, value: hqCity,
      text: `${company} is headquartered in ${hqCity}.`, sourceClass: `class:hq:${i}`, sourceId: src });
    addFact({ id: idProd, entity: companyEntity, attribute: `${companyEntity}#product`, value: product,
      text: `${company} manufactures ${product}.`, sourceClass: `class:prod:${i}`, sourceId: src });
    addFact({ id: idFound, entity: companyEntity, attribute: `${companyEntity}#founded`, value: year,
      text: `${company} was founded in ${year}.`, sourceClass: `class:found:${i}`, sourceId: src });
    addFact({ id: idPop, entity: hqEntity, attribute: `${hqEntity}#population`, value: "n/a",
      text: `${hqCity} has a large industrial harbor and rail yard.`, sourceClass: `class:pop:${i}`, sourceId: src });
    addFact({ id: idCountry, entity: hqEntity, attribute: `${hqEntity}#country`, value: country,
      text: `${hqCity} is located in the nation of ${country}.`, sourceClass: `class:country:${i}`, sourceId: src });
    addFact({ id: idRegion, entity: `G${i}`, attribute: `G${i}#continent`, value: continent,
      text: `The territory of ${country} forms part of the ${continent} landmass.`, sourceClass: `class:region:${i}`, sourceId: src });

    // SHARED_ENTITY cliques per entity.
    sharedEntityClique([idEmp, idRes, idRole]);
    sharedEntityClique([idHq, idProd, idFound]);
    sharedEntityClique([idPop, idCountry]);
    // CONFIRMED_LINK chains: person -> company facts -> city facts -> region.
    link(idEmp, idHq);
    link(idEmp, idProd);
    link(idEmp, idFound);
    link(idHq, idPop);
    link(idHq, idCountry);
    link(idCountry, idRegion); // deepens the chain to 3 hops from the person

    clusters.push({
      i, personName: person.full, personEntity, companyEntity, hqEntity,
      company, city, role, hqCity, product, year, country, continent,
      f: { emp: idEmp, res: idRes, role: idRole, hq: idHq, prod: idProd, found: idFound, pop: idPop, country: idCountry, region: idRegion },
    });
  }

  // === 2) DIRECT + MULTIHOP queries over the clusters ======================
  // DIRECT: literal answer, shares cue entity. MULTIHOP: structure-only, distant.
  let q = 0;
  const directAttrs: Array<["emp" | "res" | "role", (c: Cluster) => string]> = [
    ["emp", (c) => `Who is the employer of ${c.personName}?`],
    ["res", (c) => `In which city does ${c.personName} reside?`],
    ["role", (c) => `What is the profession of ${c.personName}?`],
  ];
  for (let i = 0; i < NUM_CLUSTERS; i++) {
    const c = clusters[i]!;
    const [attr, phrase] = directAttrs[i % directAttrs.length]!;
    queries.push({
      id: `q:direct:${q++}`,
      category: "DIRECT",
      cueText: phrase(c),
      cueEntities: [c.personEntity],
      relevant: [c.f[attr]!],
    });
  }

  // MULTIHOP: ground truth is the company/city fact reached only by relations and
  // phrased with vocabulary disjoint from the (person-centric) cue.
  // Three SHALLOW (1-2 hop) variants the tuned h=2 hybrid can also reach, plus one
  // DEEP (3-hop) variant beyond the h<=2 grid: it is reachable ONLY by the unbounded
  // activation walk (the hybrid's graph channel stops at 2 hops, and the cue names no
  // country so the vector channel cannot pick the correct region among 24 similar ones).
  const multiVariants: Array<[(c: Cluster) => string, (c: Cluster) => string[]]> = [
    [(c) => `Which country is the firm that employs ${c.personName} based in?`, (c) => [c.f["country"]!]],
    [(c) => `What goods are produced by the organization ${c.personName} is employed by?`, (c) => [c.f["prod"]!]],
    [(c) => `In what city is the workplace of ${c.personName} headquartered?`, (c) => [c.f["hq"]!]],
    [(c) => `On which continent does the parent nation of ${c.personName}'s employer sit?`, (c) => [c.f["region"]!]],
  ];
  for (let i = 0; i < NUM_CLUSTERS; i++) {
    const c = clusters[i]!;
    const [phrase, rel] = multiVariants[i % multiVariants.length]!;
    queries.push({
      id: `q:multihop:${q++}`,
      category: "MULTIHOP",
      cueText: phrase(c),
      cueEntities: [c.personEntity],
      relevant: rel(c),
    });
  }

  // === 3) PARAPHRASE rings (disconnected synonym clusters) =================
  // Each ring: RING_SIZE facts about DISTINCT, unconnected entities, all stating the
  // same concept in different words. No edges between them. The cue names NO corpus
  // entity, so the only structural seed is vector-top-1 -> a structure-only retriever
  // can reach at most that one; a semantic retriever reaches the whole ring.
  for (let r = 0; r < NUM_RINGS; r++) {
    const concept = pick(ROLE_CONCEPT, r);
    const ringIds: string[] = [];
    for (let j = 0; j < RING_SIZE; j++) {
      const person = uniqName();
      const id = `f:ring:${r}:${j}`;
      const verb = pick(RING_VERB, r + j);
      ringIds.push(id);
      addFact({
        id,
        entity: `R${r}_${j}`, // distinct entity per ring member => no shared-entity join
        attribute: `R${r}_${j}#hobby`,
        value: concept,
        text: `${person.full} ${verb} ${concept}.`,
        sourceClass: `class:ring:${r}:${j}`,
        sourceId: `src:ring:${r}:${j}`,
      });
    }
    queries.push({
      id: `q:paraphrase:${q++}`,
      category: "PARAPHRASE",
      cueText: `Find people who are described as a ${concept}.`,
      cueEntities: [], // names no corpus entity
      relevant: ringIds,
    });
  }

  // === 4) CONTRADICTION pairs ==============================================
  // Two conflicting values for one (entity, attribute) from DIFFERENT independence
  // classes/sources. The planted-true source pre-earns reputation so the engine's
  // adjudicator keeps the true value LIVE and DEMOTES the false one.
  //
  // F4a ("second independent lock", `forgetting/consolidation.ts`) REQUIRES the
  // winning value to be backed by >= multiClassMinRoots (2) mutually-independent
  // roots (the engine's own `#R` / `agreementRootCountOf`) before a multi-class
  // dispute may even be CONSIDERED for auto-resolution — a lone true witness is
  // R=1 and DEFERS unconditionally (never RESOLVES), regardless of its reputation
  // margin. A SECOND, genuinely independent corroborating witness for the TRUE
  // value is planted below (`f:ctr-true-corrob:${i}`) so #R(true) = 2 and the
  // decisive-margin/reputation logic this bench actually intends to exercise runs.
  // The corroborator shares the true fact's `content_hash` via `contentHashKey`
  // (so `#deriveAgreementSet` counts it as agreeing on the SAME value) but carries
  // its OWN independence class and a null (anonymous/unresolvable) sourceId — the
  // NULL-SOURCE FALLBACK `identity/index.ts`'s `independent(a,b)` treats as
  // independent-by-default once the class differs, exactly like the `null`-source
  // roots `fixtures.ts`'s own `independentRoots()` helper uses for the same reason.
  const TRUE_SRC = "src:authority"; // pre-earns reputation
  const trustedSources = [TRUE_SRC];
  for (let i = 0; i < NUM_CONTRADICTIONS; i++) {
    const entity = `CTR${i}`;
    const attribute = `${entity}#population`;
    const city = pick(CITY, i + 3);
    const trueVal = String(120_000 + i * 5000);
    const falseVal = String(900_000 + i * 5000);
    const trueId = `f:ctr-true:${i}`;
    const corrobId = `f:ctr-true-corrob:${i}`;
    const falseId = `f:ctr-false:${i}`;
    addFact({
      id: trueId, entity, attribute, value: trueVal,
      text: `According to the national census, the population of ${city} is ${trueVal}.`,
      sourceClass: `class:ctr-true:${i}`, sourceId: TRUE_SRC,
    });
    addFact({
      id: corrobId, entity, attribute, value: trueVal,
      text: `An independent municipal audit corroborates the population of ${city} as ${trueVal}.`,
      sourceClass: `class:ctr-true-corrob:${i}`, sourceId: null,
      contentHashKey: trueId, // SAME value fingerprint as the primary true fact
    });
    addFact({
      id: falseId, entity, attribute, value: falseVal,
      text: `An unverified blog post claims the population of ${city} is ${falseVal}.`,
      sourceClass: `class:ctr-false:${i}`, sourceId: `src:rumor:${i}`,
    });
    sharedEntityClique([trueId, corrobId, falseId]);
    const pair: ContradictionPair = { attribute, entity, trueFactId: trueId, falseFactId: falseId };
    contradictions.push(pair);
    queries.push({
      id: `q:contradiction:${q++}`,
      category: "CONTRADICTION",
      cueText: `What is the population of ${city}?`,
      cueEntities: [entity],
      relevant: [trueId], // the believed answer is the planted-true value
      contradiction: pair,
    });
  }

  // === 5) FILLER / DISTRACTOR facts to reach ~TARGET_FACTS ==================
  // Extra cluster-template facts about NEW people/companies, unconnected to any
  // query. They are pure semantic near-misses (same templates) that pad the corpus
  // and tempt the vector channel.
  let filler = 0;
  while (facts.length < TARGET_FACTS) {
    const person = uniqName();
    const i = NUM_CLUSTERS + filler;
    const company = companyName(i);
    const id = `f:filler:${filler}`;
    const kind = filler % 3;
    const entity = `F${filler}`;
    if (kind === 0) {
      addFact({ id, entity, attribute: `${entity}#employer`, value: company,
        text: `${person.full} works at ${company}.`, sourceClass: `class:filler:${filler}`, sourceId: `src:filler:${filler}` });
    } else if (kind === 1) {
      addFact({ id, entity, attribute: `${entity}#city`, value: pick(CITY, i),
        text: `${person.full} lives in ${pick(CITY, i)}.`, sourceClass: `class:filler:${filler}`, sourceId: `src:filler:${filler}` });
    } else {
      addFact({ id, entity, attribute: `${entity}#product`, value: pick(PRODUCT, i),
        text: `${company} manufactures ${pick(PRODUCT, i)}.`, sourceClass: `class:filler:${filler}`, sourceId: `src:filler:${filler}` });
    }
    filler += 1;
  }

  return { facts, edges, queries, contradictions, trustedSources };
}

// ---------------------------------------------------------------------------
// Deterministic dev/test split (30% dev / 70% test), stratified by category.
// ---------------------------------------------------------------------------

export interface Split {
  readonly dev: readonly QueryRecord[];
  readonly test: readonly QueryRecord[];
}

/**
 * Split queries 30% DEV / 70% TEST, deterministically and STRATIFIED by category so
 * every category appears in both splits. Stable: sorts by id, then assigns every
 * (1/devFraction)-th query within a category to dev.
 */
export function splitQueries(queries: readonly QueryRecord[], devFraction = 0.3): Split {
  const byCat = new Map<Category, QueryRecord[]>();
  for (const query of queries) {
    const arr = byCat.get(query.category) ?? [];
    arr.push(query);
    byCat.set(query.category, arr);
  }
  const dev: QueryRecord[] = [];
  const test: QueryRecord[] = [];
  const stride = Math.max(2, Math.round(1 / devFraction)); // ~every 3rd -> dev
  for (const cat of [...byCat.keys()].sort()) {
    const arr = byCat.get(cat)!.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    arr.forEach((query, idx) => {
      if (idx % stride === 0) dev.push(query);
      else test.push(query);
    });
  }
  return { dev, test };
}
