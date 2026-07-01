/**
 * factworld/prompt.ts — the ONE closed-book reader prompt.
 *
 * The model must answer the CURRENT value of an (entity, attribute) using ONLY the injected
 * memory. Identical across arms; the only variable is which memory each arm retrieved.
 * The answer is a single fictional token → reply is short, EM-scored (no LLM judge).
 */

export function buildFwPrompt(entity: string, label: string, memory: readonly string[]): string {
  const lines: string[] = [
    "Answer the question using ONLY the memory below. Reply with ONLY the value — a single word, nothing else.",
    "",
    "Memory:",
  ];
  if (memory.length === 0) lines.push("(no memory available)");
  else for (const m of memory) lines.push(`- ${m}`);
  lines.push("", `Question: What is ${entity}'s ${label}?`, "Answer:");
  return lines.join("\n");
}
