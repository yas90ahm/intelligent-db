/**
 * retrieval/qa/qaPrompt.ts — the ONE fixed reader prompt template.
 *
 * Identical for every arm and every model so the only variable across arms is the
 * retrieved memory set (the thing under test). A grounded-QA instruction + the top-K
 * memory texts as a numbered list + the question. Deterministic string build.
 */

export const QA_SYSTEM_INSTRUCTION =
  "Answer the question using ONLY the memories. Be concise; if unknown, say 'unknown'.";

/**
 * Build the reader prompt: fixed system instruction, the memories as a numbered list,
 * then the question. Empty memories degrade to an explicit "(no memories retrieved)" line
 * so the template shape is constant.
 */
export function buildQaPrompt(question: string, memories: readonly string[]): string {
  const lines: string[] = [];
  lines.push(QA_SYSTEM_INSTRUCTION);
  lines.push("");
  lines.push("Memories:");
  if (memories.length === 0) {
    lines.push("(no memories retrieved)");
  } else {
    memories.forEach((m, i) => {
      // single-line each memory so the numbered list stays unambiguous
      lines.push(`${i + 1}. ${m.replace(/\s+/g, " ").trim()}`);
    });
  }
  lines.push("");
  lines.push(`Question: ${question}`);
  lines.push("Answer:");
  return lines.join("\n");
}
