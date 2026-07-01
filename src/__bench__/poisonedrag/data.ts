/**
 * poisonedrag/data.ts — loader for the prep-built PoisonedRAG knowledge base + questions.
 *
 * Produced by prep.py from the real PoisonedRAG attack files + a BEIR corpus. Each KB
 * passage carries a provenance label: gold (real corpus passage asserting the CORRECT
 * answer, independent source), poison (one of the 5 adv_texts asserting the INCORRECT
 * answer, all 5 sharing ONE anchor class = a Sybil cluster), or negative (a distractor).
 */

import { readFileSync } from "node:fs";

export type PassageKind = "gold" | "negative" | "poison";

export interface KBPassage {
  readonly id: string;
  readonly text: string;
  readonly kind: PassageKind;
  readonly query_id: string; // "" for negatives
  readonly value: string; // "correct" | "incorrect" | ""
  readonly source: string;
  readonly anchor_class: string;
}

export interface PRQuestion {
  readonly id: string;
  readonly question: string;
  readonly correct: string;
  readonly incorrect: string;
  readonly has_gold: boolean;
}

function loadJsonl<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t.length > 0) out.push(JSON.parse(t) as T);
  }
  return out;
}

export const loadKB = (path: string): KBPassage[] => loadJsonl<KBPassage>(path);
export const loadQuestions = (path: string): PRQuestion[] => loadJsonl<PRQuestion>(path);
