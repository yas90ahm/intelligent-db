/**
 * longmemeval/dataset.ts — LongMemEval (ORACLE variant) loader + per-question graph.
 *
 * LongMemEval (Wu et al., ICLR 2025 — https://github.com/xiaowu0162/LongMemEval) probes
 * five memory abilities (information extraction, multi-session reasoning, temporal
 * reasoning, knowledge updates, abstention) via 500 questions, each paired with its OWN
 * "haystack" of chat sessions the answer is (or is not) grounded in.
 *
 * This harness adopts the **oracle** release (`longmemeval_oracle.json`, ~15MB — every
 * haystack session already IS evidence-relevant, no synthetic filler sessions), NOT the
 * full `_s`/`_m` releases (115k-token / ~500-session full haystacks, 277MB/2.7GB) — the
 * oracle keeps the "does memory retrieve+use the right prior turns" test intact while
 * making the per-question corpus small enough for a per-question in-memory engine
 * instance. Documented limitation: this is a weaker "needle in a small, all-relevant
 * haystack" test than the full-scale "needle in 500 sessions of mostly-irrelevant chatter"
 * release — see the harness README.
 *
 * Raw JSON shape (one object per question), fields consumed here:
 *   question_id, question_type, question, answer, question_date,
 *   haystack_session_ids, haystack_dates, haystack_sessions (array of session turn-arrays,
 *   each turn `{role: "user"|"assistant", content, has_answer?}`), answer_session_ids.
 * Questions whose `question_id` ends in `_abs` are ABSTENTION questions: the gold answer
 * states that the available history is insufficient (tests that the assistant should NOT
 * confabulate an answer from adjacent-but-irrelevant evidence).
 *
 * PER-QUESTION GRAPH: each question's haystack sessions become ONE small conversation
 * graph, structurally identical to the LoCoMo per-conversation graph (`retrieval/locomo.ts`)
 * so the same activation-walk retriever + rerank/multi-seed machinery
 * (`retrieval/retrievers.ts`) can be reused verbatim (structural typing, not inheritance):
 *   - CONFIRMED_LINK: same-session temporal adjacency (turn i <-> turn i+1).
 *   - SHARED_ENTITY : two turns naming the same extracted proper-noun entity (DF 2..25).
 *   - entity = the turn's role ("user"/"assistant") — same convention `locomo.ts` uses
 *     (speaker identity), giving the engine's bounded entity-index sibling fan a
 *     same-speaker relation exactly as the real `writeFact` path would see it.
 *
 * This module is PURE DATA + GRAPH BUILD: it registers zero tests and never touches the
 * engine, the store, or the embedder.
 */

import { extractEntities } from "../retrieval/locomo.js";
import type { SharedGraph } from "../retrieval/graph.js";

// ---------------------------------------------------------------------------
// Raw JSON shapes (only the fields we consume)
// ---------------------------------------------------------------------------

export type LmeQuestionType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "temporal-reasoning"
  | "knowledge-update"
  | "multi-session"
  | string; // fail-open: an unrecognized label is kept verbatim, never dropped

interface RawTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}
interface RawItem {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date?: string;
  haystack_session_ids?: unknown;
  haystack_dates?: unknown;
  haystack_sessions: RawTurn[][];
  answer_session_ids?: unknown;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface LmeTurn {
  readonly id: string; // `${questionId}|s{session}|t{index}`
  readonly role: string; // "user" | "assistant" (kept as-is; not enum-constrained)
  readonly session: number; // index into haystack_sessions
  readonly order: number; // global chronological index across all sessions
  readonly text: string;
  readonly hasAnswer: boolean;
}

export interface LmeItem {
  readonly questionId: string;
  readonly questionType: LmeQuestionType;
  readonly isAbstention: boolean;
  readonly question: string;
  readonly answer: string;
  readonly cueEntities: readonly string[];
  readonly turns: readonly LmeTurn[];
}

export interface LmeEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "SHARED_ENTITY" | "CONFIRMED_LINK";
}

/** A per-question conversation graph, structurally parallel to `LocomoConversation`. */
export interface LmeConversation {
  readonly questionId: string;
  readonly turns: readonly LmeTurn[];
  readonly edges: readonly LmeEdge[];
  readonly entityIndex: ReadonlyMap<string, readonly string[]>;
  readonly speakerTurns: ReadonlyMap<string, readonly string[]>;
}

const MAX_MENTION_DF = 25;
const ROLE_EXCLUDE = new Set<string>(["user", "assistant", "system"]);

/** Parse `longmemeval_oracle.json` (or `_s`/`_m`, same per-item schema) into `LmeItem[]`. */
export function loadLongMemEval(json: string): LmeItem[] {
  const raw = JSON.parse(json) as RawItem[];
  const out: LmeItem[] = [];
  raw.forEach((r, qi) => {
    const questionId = r.question_id ?? `q${qi}`;
    const isAbstention = questionId.endsWith("_abs");
    const answer =
      typeof r.answer === "string"
        ? r.answer
        : r.answer !== undefined && r.answer !== null
          ? String(r.answer)
          : "";
    const turns: LmeTurn[] = [];
    let order = 0;
    r.haystack_sessions.forEach((session, si) => {
      if (!Array.isArray(session)) return;
      session.forEach((t, ti) => {
        if (t === null || typeof t !== "object" || typeof t.content !== "string") return;
        turns.push({
          id: `${questionId}|s${si}|t${ti}`,
          role: String(t.role ?? "user"),
          session: si,
          order: order++,
          text: t.content,
          hasAnswer: t.has_answer === true,
        });
      });
    });
    const cueEntities = extractEntities(r.question, ROLE_EXCLUDE);
    out.push({
      questionId,
      questionType: r.question_type,
      isAbstention,
      question: r.question,
      answer,
      cueEntities,
      turns,
    });
  });
  return out;
}

/** Build the per-question conversation graph (edges + entity/speaker indexes). */
export function toConversation(item: LmeItem): LmeConversation {
  const turns = item.turns;
  const entityIndex = new Map<string, string[]>();
  const speakerTurns = new Map<string, string[]>();
  for (const t of turns) {
    (speakerTurns.get(t.role) ?? speakerTurns.set(t.role, []).get(t.role)!).push(t.id);
    for (const e of extractEntities(t.text, ROLE_EXCLUDE)) {
      (entityIndex.get(e) ?? entityIndex.set(e, []).get(e)!).push(t.id);
    }
  }

  const edges: LmeEdge[] = [];
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

  return { questionId: item.questionId, turns, edges, entityIndex, speakerTurns };
}

/**
 * Build a `SharedGraph` for one question's conversation. Structurally identical to
 * `retrieval/locomo.ts`'s `buildLocomoGraph` (same `SharedGraph` interface consumers).
 */
export function buildLmeGraph(conv: LmeConversation, vectorOf: (id: string) => Float32Array): SharedGraph {
  const facts = conv.turns.map((t) => ({
    id: t.id,
    entity: t.role,
    attribute: `${t.id}#text`,
    value: t.text,
    text: t.text,
    sourceClass: `spk:${t.role}`,
    sourceId: `src:${t.role}`,
  }));
  const idIndex = new Map<string, number>();
  facts.forEach((f, i) => idIndex.set(f.id, i));

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
  const roleOf = new Map<string, string>();
  for (const t of conv.turns) roleOf.set(t.id, t.role);

  return {
    facts,
    idIndex,
    vectorOf: (id) => vectorOf(id),
    neighborsOf: (id) => {
      const out = new Set<string>(adj.get(id) ?? []);
      const role = roleOf.get(id);
      if (role !== undefined) {
        for (const sib of conv.speakerTurns.get(role) ?? []) if (sib !== id) out.add(sib);
      }
      return [...out];
    },
    entityFacts: (entity) => conv.entityIndex.get(entity) ?? [],
  };
}

/**
 * Deterministic, stratified (by `catOf`) subsample of size `n`: per-category quota
 * proportional to the category's pool share, items sorted by id and picked at even
 * strides (index-derived — no RNG), so the same n yields the same set every run.
 * Mirrors `retrieval/qa/qaRunner.test.ts`'s `stratifiedSubsample`.
 */
export function stratifiedSubsample<T>(items: readonly T[], n: number, catOf: (t: T) => string, idOf: (t: T) => string): T[] {
  const byCat = new Map<string, T[]>();
  for (const it of items) {
    const arr = byCat.get(catOf(it)) ?? [];
    arr.push(it);
    byCat.set(catOf(it), arr);
  }
  const cats = [...byCat.keys()].sort();
  for (const c of cats) byCat.get(c)!.sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));

  const total = items.length;
  const target = Math.min(n, total);
  const alloc = new Map<string, number>();
  let assigned = 0;
  for (const c of cats) {
    const cap = byCat.get(c)!.length;
    const k = Math.min(cap, Math.floor((cap / total) * target));
    alloc.set(c, k);
    assigned += k;
  }
  let rem = target - assigned;
  while (rem > 0) {
    let progressed = false;
    for (const c of cats) {
      if (rem === 0) break;
      if (alloc.get(c)! < byCat.get(c)!.length) {
        alloc.set(c, alloc.get(c)! + 1);
        rem -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const out: T[] = [];
  for (const c of cats) {
    const arr = byCat.get(c)!;
    const k = alloc.get(c)!;
    if (k <= 0) continue;
    if (k >= arr.length) {
      out.push(...arr);
      continue;
    }
    const stride = arr.length / k;
    for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * stride)]!);
  }
  out.sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  return out;
}
