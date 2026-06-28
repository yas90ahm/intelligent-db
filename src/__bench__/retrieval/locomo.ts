/**
 * retrieval/locomo.ts — REAL LoCoMo dataset loader + per-conversation shared graph.
 *
 * Cycle B extends cycle A's retrieval-quality harness from the synthetic corpus to the
 * REAL LoCoMo benchmark (snap-research/locomo, `locomo10.json`): ~10 multi-session
 * conversations, each with QA pairs that carry EVIDENCE turn-ids (the dialog turns that
 * support the answer) and a CATEGORY label.
 *
 * This module is PURE DATA + GRAPH BUILD: it registers zero tests and never touches the
 * engine, the store, or the embedder. It reuses graph.ts's `SharedGraph` *interface*
 * (so the cycle-A seeding protocol `sharedSeed`/`graphExpand`/`cosineRanking` and the
 * RRF hybrid consume a LoCoMo conversation graph unchanged) and metrics.ts as-is.
 *
 * CORPUS (per conversation): every dialog turn across all sessions is one retrievable
 * unit { id, speaker, session, order, text }. GROUND TRUTH for a question = its evidence
 * turn-id set.
 *
 * GRAPH (per conversation), nodes = turns, two typed relations:
 *   - CONFIRMED_LINK  — same-session temporal adjacency (turn i <-> turn i+1).
 *   - SHARED_ENTITY   — (a) SAME SPEAKER (every pair of a speaker's turns; carried by the
 *                       engine's bounded entity-index sibling fan and by this graph's
 *                       lazy speaker adjacency), and (b) SHARED MENTION — two turns that
 *                       name the same extracted proper-noun entity.
 *
 * ENTITY-EXTRACTION RULE (deterministic, auditable — see `extractEntities`):
 *   tokenize text; an entity TOKEN matches /^[A-Z][a-z]{2,}$/ (Title-case, length>=3,
 *   not ALL-CAPS) and is not in STOPWORDS; CONSECUTIVE entity tokens merge into one
 *   phrase ("New York" -> "new york"); the entity KEY is the lowercased phrase. The two
 *   conversation speaker names are EXCLUDED as mention keys/cues (they appear in nearly
 *   every turn, so they are non-discriminative; same-speaker connectivity is modeled
 *   separately). Mention SHARED_ENTITY edges are built only for keys with document
 *   frequency 2..MAX_MENTION_DF (singletons connect nothing; ultra-common keys would
 *   form a useless near-clique). This rule is identical for turns and for question cues.
 */

import type { SharedGraph } from "./graph.js";

// ---------------------------------------------------------------------------
// LoCoMo category labels (the integer `category` field in locomo10.json).
// ---------------------------------------------------------------------------

export type LocomoCategory =
  | "multi-hop"
  | "temporal"
  | "open-domain"
  | "single-hop"
  | "adversarial"
  | "other";

/** LoCoMo's documented category integers -> human labels. */
export function categoryLabel(cat: number): LocomoCategory {
  switch (cat) {
    case 1:
      return "multi-hop";
    case 2:
      return "temporal";
    case 3:
      return "open-domain";
    case 4:
      return "single-hop";
    case 5:
      return "adversarial";
    default:
      return "other";
  }
}

export const LOCOMO_CATEGORIES: readonly LocomoCategory[] = [
  "single-hop",
  "multi-hop",
  "temporal",
  "open-domain",
  "adversarial",
];

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One dialog turn = one retrievable corpus unit. `id` is the global (conv-scoped) id. */
export interface LocomoTurn {
  readonly id: string; // `${convId}|${dia_id}`
  readonly diaId: string; // raw LoCoMo dia_id, e.g. "D1:3"
  readonly convId: string;
  readonly speaker: string;
  readonly session: number;
  readonly order: number; // global chronological index within the conversation
  readonly text: string;
}

/** One evaluation question with its resolved ground-truth evidence-turn set. */
export interface LocomoQuestion {
  readonly id: string; // `${convId}|q${index}`
  readonly convId: string;
  readonly category: LocomoCategory;
  readonly categoryInt: number;
  readonly cueText: string;
  /** Discriminative proper-noun entity keys in the question (speakers excluded). */
  readonly cueEntities: readonly string[];
  /** Ground truth: the resolved evidence turn ids that exist in the corpus. */
  readonly relevant: readonly string[];
  readonly answer: string;
}

export interface LocomoConversation {
  readonly convId: string;
  readonly speakers: readonly [string, string];
  readonly turns: readonly LocomoTurn[];
  readonly questions: readonly LocomoQuestion[];
  /** Directed edges to materialize in the engine store (both directions emitted). */
  readonly edges: readonly LocomoEdge[];
  /** entityKey -> turn ids (mention index, incl. speaker keys) for seeding. */
  readonly entityIndex: ReadonlyMap<string, readonly string[]>;
  /** speaker -> that speaker's turn ids (for same-speaker adjacency). */
  readonly speakerTurns: ReadonlyMap<string, readonly string[]>;
}

export interface LocomoEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "SHARED_ENTITY" | "CONFIRMED_LINK";
}

export interface LocomoStats {
  readonly conversations: number;
  readonly totalTurns: number;
  readonly totalQuestionsRaw: number;
  readonly questionsKept: number;
  readonly questionsDropped: number;
  readonly evidenceTokensTotal: number;
  readonly evidenceTokensResolved: number;
  readonly byCategoryKept: Record<string, number>;
}

export interface LocomoDataset {
  readonly conversations: readonly LocomoConversation[];
  readonly stats: LocomoStats;
}

// ---------------------------------------------------------------------------
// Entity extraction (deterministic)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  "The", "And", "But", "For", "Not", "You", "Are", "Was", "Has", "Had", "Did", "Why",
  "How", "What", "When", "Where", "Who", "Which", "That", "This", "These", "Those",
  "Hey", "Hello", "Yeah", "Yes", "Oh", "Okay", "Sure", "Maybe", "Well", "Just", "Now",
  "Then", "Today", "Tomorrow", "Yesterday", "Also", "Thanks", "Thank", "Good", "Great",
  "Wow", "Haha", "Hmm", "Let", "Get", "Got", "Have", "Been", "Your", "Our", "Their",
  "His", "Her", "Its", "She", "They", "Them", "Him", "Are", "Can", "Could", "Would",
  "Should", "Will", "May", "Might", "Must", "Some", "Any", "All", "One", "Two", "Three",
  "About", "After", "Before", "With", "From", "Into", "Over", "Under", "Such", "Like",
  "Here", "There", "Very", "Really", "More", "Most", "Last", "Next", "Still", "Even",
  "Right", "Left", "Sorry", "Please", "Congrats", "Awesome", "Amazing", "Nice",
]);

/**
 * Extract lowercased proper-noun entity KEYS from `text`. Title-case tokens
 * (`/^[A-Z][a-z]{2,}$/`, not in STOPWORDS) are kept; consecutive kept tokens merge into
 * one phrase. `exclude` (the two speaker names, lowercased) is removed. Deterministic.
 */
export function extractEntities(text: string, exclude: ReadonlySet<string>): string[] {
  const tokens = text.split(/[^A-Za-z]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  let phrase: string[] = [];
  const flush = (): void => {
    if (phrase.length === 0) return;
    const key = phrase.join(" ").toLowerCase();
    phrase = [];
    if (exclude.has(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  for (const tok of tokens) {
    if (/^[A-Z][a-z]{2,}$/.test(tok) && !STOPWORDS.has(tok)) {
      phrase.push(tok);
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Raw JSON shapes (only the fields we consume)
// ---------------------------------------------------------------------------

interface RawTurn {
  speaker: string;
  dia_id: string;
  text: string;
}
interface RawQA {
  question: string;
  answer?: unknown;
  adversarial_answer?: unknown;
  evidence?: unknown;
  category: number;
}
interface RawConversationBlock {
  speaker_a: string;
  speaker_b: string;
  [k: string]: unknown;
}
interface RawConversation {
  qa: RawQA[];
  conversation: RawConversationBlock;
  sample_id?: string;
}

const MAX_MENTION_DF = 25;

/** Parse an evidence array into normalized dia-id tokens (handles malformed separators). */
export function parseEvidence(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string") continue;
    const m = s.match(/D\s*\d+\s*:\s*\d+/g);
    if (m) for (const t of m) out.push(t.replace(/\s+/g, ""));
  }
  return out;
}

function sessionKeysInOrder(block: RawConversationBlock): Array<{ key: string; n: number }> {
  const ks: Array<{ key: string; n: number }> = [];
  for (const key of Object.keys(block)) {
    const mm = /^session_(\d+)$/.exec(key);
    if (mm) ks.push({ key, n: Number(mm[1]) });
  }
  ks.sort((a, b) => a.n - b.n);
  return ks;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadLocomo(json: string): LocomoDataset {
  const raw = JSON.parse(json) as RawConversation[];
  const conversations: LocomoConversation[] = [];

  let totalTurns = 0;
  let totalQuestionsRaw = 0;
  let questionsKept = 0;
  let evTok = 0;
  let evTokResolved = 0;
  const byCategoryKept: Record<string, number> = {};

  raw.forEach((conv, ci) => {
    const convId = conv.sample_id ?? `conv${ci}`;
    const block = conv.conversation;
    const speakerA = String(block.speaker_a);
    const speakerB = String(block.speaker_b);
    const speakerExclude = new Set<string>([speakerA.toLowerCase(), speakerB.toLowerCase()]);

    // ---- turns -----------------------------------------------------------
    const turns: LocomoTurn[] = [];
    const diaToId = new Map<string, string>();
    let order = 0;
    for (const { key, n } of sessionKeysInOrder(block)) {
      const arr = block[key] as RawTurn[] | undefined;
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (t === null || typeof t !== "object" || typeof t.dia_id !== "string") continue;
        const id = `${convId}|${t.dia_id}`;
        const turn: LocomoTurn = {
          id,
          diaId: t.dia_id,
          convId,
          speaker: String(t.speaker),
          session: n,
          order: order++,
          text: String(t.text ?? ""),
        };
        turns.push(turn);
        diaToId.set(t.dia_id, id);
      }
    }
    totalTurns += turns.length;

    // ---- entity / speaker indexes ---------------------------------------
    const entityIndex = new Map<string, string[]>();
    const speakerTurns = new Map<string, string[]>();
    const turnEntities = new Map<string, string[]>();
    for (const t of turns) {
      (speakerTurns.get(t.speaker) ?? speakerTurns.set(t.speaker, []).get(t.speaker)!).push(t.id);
      const ents = extractEntities(t.text, speakerExclude);
      turnEntities.set(t.id, ents);
      for (const e of ents) {
        (entityIndex.get(e) ?? entityIndex.set(e, []).get(e)!).push(t.id);
      }
    }

    // ---- edges -----------------------------------------------------------
    const edges: LocomoEdge[] = [];
    // CONFIRMED_LINK: same-session temporal adjacency.
    for (let i = 1; i < turns.length; i++) {
      const a = turns[i - 1]!;
      const b = turns[i]!;
      if (a.session === b.session) edges.push({ from: a.id, to: b.id, type: "CONFIRMED_LINK" });
    }
    // SHARED_ENTITY (mention): connect turns sharing a key with DF in [2, MAX_MENTION_DF].
    for (const [, ids] of entityIndex) {
      if (ids.length < 2 || ids.length > MAX_MENTION_DF) continue;
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          edges.push({ from: ids[a]!, to: ids[b]!, type: "SHARED_ENTITY" });
        }
      }
    }

    // ---- questions -------------------------------------------------------
    const questions: LocomoQuestion[] = [];
    conv.qa.forEach((qa, qi) => {
      totalQuestionsRaw += 1;
      const ev = parseEvidence(qa.evidence);
      evTok += ev.length;
      const relevant = ev.map((e) => diaToId.get(e)).filter((x): x is string => x !== undefined);
      evTokResolved += relevant.length;
      if (relevant.length === 0) return; // drop questions with no resolvable evidence
      const cueText = String(qa.question ?? "");
      const cueEntities = extractEntities(cueText, speakerExclude);
      const cat = categoryLabel(qa.category);
      const answer =
        qa.answer !== undefined && qa.answer !== null
          ? String(qa.answer)
          : qa.adversarial_answer !== undefined && qa.adversarial_answer !== null
            ? String(qa.adversarial_answer)
            : "";
      questions.push({
        id: `${convId}|q${qi}`,
        convId,
        category: cat,
        categoryInt: qa.category,
        cueText,
        cueEntities,
        relevant,
        answer,
      });
      questionsKept += 1;
      byCategoryKept[cat] = (byCategoryKept[cat] ?? 0) + 1;
    });

    conversations.push({
      convId,
      speakers: [speakerA, speakerB],
      turns,
      questions,
      edges,
      entityIndex,
      speakerTurns,
    });
  });

  const stats: LocomoStats = {
    conversations: conversations.length,
    totalTurns,
    totalQuestionsRaw,
    questionsKept,
    questionsDropped: totalQuestionsRaw - questionsKept,
    evidenceTokensTotal: evTok,
    evidenceTokensResolved: evTokResolved,
    byCategoryKept,
  };

  return { conversations, stats };
}

// ---------------------------------------------------------------------------
// Per-conversation SharedGraph (reuses graph.ts's interface verbatim)
// ---------------------------------------------------------------------------

/**
 * Build a `SharedGraph` for one conversation. `vectorOf` is supplied by the caller
 * (turn id -> embedding). Adjacency = materialized mention/session edges UNION the lazy
 * same-speaker set; `entityFacts` = the mention/speaker index. Same shape both cycle-A
 * retrievers consume, so `sharedSeed`/`graphExpand`/`cosineRanking` work unchanged.
 */
export function buildLocomoGraph(
  conv: LocomoConversation,
  vectorOf: (id: string) => Float32Array,
): SharedGraph {
  // facts shaped to the minimal { id, entity, text } the SharedGraph consumers read.
  const facts = conv.turns.map((t) => ({
    id: t.id,
    entity: t.speaker,
    attribute: `${t.id}#text`,
    value: t.text,
    text: t.text,
    sourceClass: `spk:${t.speaker}`,
    sourceId: `src:${t.speaker}`,
  }));
  const idIndex = new Map<string, number>();
  facts.forEach((f, i) => idIndex.set(f.id, i));

  // Materialized adjacency (mention + session), undirected.
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = adj.get(id);
    if (s === undefined) {
      s = new Set<string>();
      adj.set(id, s);
    }
    return s;
  };
  for (const e of conv.edges) {
    ensure(e.from).add(e.to);
    ensure(e.to).add(e.from);
  }
  const speakerOf = new Map<string, string>();
  for (const t of conv.turns) speakerOf.set(t.id, t.speaker);

  return {
    facts,
    idIndex,
    vectorOf: (id) => vectorOf(id),
    neighborsOf: (id) => {
      const out = new Set<string>(adj.get(id) ?? []);
      const spk = speakerOf.get(id);
      if (spk !== undefined) {
        for (const sib of conv.speakerTurns.get(spk) ?? []) if (sib !== id) out.add(sib);
      }
      return [...out];
    },
    entityFacts: (entity) => conv.entityIndex.get(entity) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Deterministic dev/test split (30% dev / 70% test), stratified by category.
// ---------------------------------------------------------------------------

export interface LocomoSplit {
  readonly dev: readonly LocomoQuestion[];
  readonly test: readonly LocomoQuestion[];
}

/** Split 30% DEV / 70% TEST, stratified by category, stable (sort by id, stride). */
export function splitLocomo(questions: readonly LocomoQuestion[], devFraction = 0.3): LocomoSplit {
  const byCat = new Map<string, LocomoQuestion[]>();
  for (const q of questions) {
    const arr = byCat.get(q.category) ?? [];
    arr.push(q);
    byCat.set(q.category, arr);
  }
  const dev: LocomoQuestion[] = [];
  const test: LocomoQuestion[] = [];
  const stride = Math.max(2, Math.round(1 / devFraction));
  for (const cat of [...byCat.keys()].sort()) {
    const arr = byCat.get(cat)!.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    arr.forEach((q, idx) => {
      if (idx % stride === 0) dev.push(q);
      else test.push(q);
    });
  }
  return { dev, test };
}
