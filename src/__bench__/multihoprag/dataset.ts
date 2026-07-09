/**
 * multihoprag/dataset.ts — MultiHop-RAG (Tang & Yang, COLM 2024) loader + chunking.
 *
 * Dataset: https://huggingface.co/datasets/yixuantt/MultiHopRAG
 *   - MultiHopRAG.json : 2556 queries (comparison / inference / temporal / null)
 *   - corpus.json      : 609 news articles with body text
 *
 * Evidence for each query is spread across 2–4 documents. This harness evaluates
 * retrieval+QA over the FULL corpus (not oracle evidence-only), which is the
 * realistic multi-hop RAG setting the paper targets.
 *
 * PURE DATA: no engine / embedder / network.
 */

export interface MhrEvidence {
  readonly title: string;
  readonly source: string;
  readonly fact: string;
  readonly url: string;
}

export interface MhrQuery {
  readonly id: string;
  readonly query: string;
  readonly answer: string;
  readonly questionType: string;
  readonly evidence: readonly MhrEvidence[];
  readonly isNull: boolean;
}

export interface MhrDoc {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly url: string;
  readonly body: string;
}

export interface MhrChunk {
  readonly id: string; // `${docId}#c${i}`
  readonly docId: string;
  readonly title: string;
  readonly source: string;
  readonly text: string;
  readonly order: number;
}

interface RawEvidence {
  title?: unknown;
  source?: unknown;
  fact?: unknown;
  url?: unknown;
}
interface RawQuery {
  query?: unknown;
  answer?: unknown;
  question_type?: unknown;
  evidence_list?: RawEvidence[];
}
interface RawDoc {
  title?: unknown;
  source?: unknown;
  url?: unknown;
  body?: unknown;
}

export function loadMultiHopQueries(json: string): MhrQuery[] {
  const raw = JSON.parse(json) as RawQuery[];
  return raw.map((r, i) => {
    const questionType = String(r.question_type ?? "unknown");
    const evidence = (r.evidence_list ?? []).map((e) => ({
      title: String(e.title ?? ""),
      source: String(e.source ?? ""),
      fact: String(e.fact ?? ""),
      url: String(e.url ?? ""),
    }));
    return {
      id: `mhr${i}`,
      query: String(r.query ?? ""),
      answer: String(r.answer ?? ""),
      questionType,
      evidence,
      isNull: questionType === "null_query",
    };
  });
}

export function loadMultiHopCorpus(json: string): MhrDoc[] {
  const raw = JSON.parse(json) as RawDoc[];
  return raw.map((r, i) => ({
    id: `doc${i}`,
    title: String(r.title ?? ""),
    source: String(r.source ?? ""),
    url: String(r.url ?? ""),
    body: String(r.body ?? ""),
  }));
}

/** Character-window chunker with overlap; keeps title/source as a prefix on every chunk. */
export function chunkDocuments(
  docs: readonly MhrDoc[],
  chunkChars = 900,
  overlap = 120,
): MhrChunk[] {
  const out: MhrChunk[] = [];
  for (const d of docs) {
    const body = d.body.replace(/\s+/g, " ").trim();
    if (body.length === 0) continue;
    const prefix = `[${d.source}] ${d.title}: `;
    if (body.length <= chunkChars) {
      out.push({
        id: `${d.id}#c0`,
        docId: d.id,
        title: d.title,
        source: d.source,
        text: `${prefix}${body}`,
        order: 0,
      });
      continue;
    }
    let start = 0;
    let order = 0;
    while (start < body.length) {
      const end = Math.min(body.length, start + chunkChars);
      out.push({
        id: `${d.id}#c${order}`,
        docId: d.id,
        title: d.title,
        source: d.source,
        text: `${prefix}${body.slice(start, end)}`,
        order,
      });
      if (end >= body.length) break;
      start = Math.max(start + 1, end - overlap);
      order += 1;
    }
  }
  return out;
}

/** Deterministic stratified subsample (same algorithm as LongMemEval). */
export function stratifiedSubsample<T>(
  items: readonly T[],
  n: number,
  catOf: (t: T) => string,
  idOf: (t: T) => string,
): T[] {
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
