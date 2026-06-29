/**
 * ratification/mutationReceipt.ts — A1 content-addressing helpers for MUTATION receipts.
 *
 * A tiny, PURE module (`node:crypto` only, ZERO store/identity imports) shared by
 * `api.ts` and `ratification/disown.ts` so the four compound ops content-address their
 * subjects identically (no api.ts↔disown.ts duplication).
 *
 * The hashes commit to the FACT of a state transition (governing invariant 1: a receipt
 * witnesses that an EVENT happened, never a claim's truth). The exact field set is an
 * AUDIT choice, not a security gate — but it MUST include the field a hidden-mutation
 * attack would flip: a demotion's `fact_state` / `outranked_by`; a reputation crater's
 * `alpha` / `beta` / `scarBeta`. Those are included below.
 *
 * STACK NOTE: ESM + NodeNext (relative imports carry `.js`); `verbatimModuleSyntax`
 * (every type-only import uses `import type`). The `\x01` field separator matches the
 * ratification ledger's canonical-form convention (a char no id/hash/number contains).
 */

import { createHash } from "node:crypto";

import type { EpochMs, Strand } from "../core/types.js";
import type { ReputationState } from "../identity/reputation.js";
import type { MutationOp, MutationPayload } from "./pendingLedger.js";
import { EMPTY_STATE_HASH } from "./pendingLedger.js";

/** sha256 of a UTF-8 string, hex. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Content-address a SOURCE id's identity (the `subjectHash` for a reputation receipt):
 * a domain-separated digest of the source id string. Stable across runs.
 */
export function hashSubjectId(id: string): string {
  return sha256Hex(["ID", id].join("\x01"));
}

/**
 * Content-address a strand's AUDITABLE STATE: a digest over the canonical subset an
 * attacker would have to flip to hide a demotion — `id`, `content_hash`, `fact_state`,
 * and the single `outranked_by` edge that explains a demotion. Pure; never reads the
 * store.
 */
export function hashStrandState(s: Strand): string {
  return sha256Hex(
    [
      "STRAND",
      String(s.id),
      String(s.content_hash),
      String(s.fact_state),
      s.outranked_by === null ? "" : String(s.outranked_by),
    ].join("\x01"),
  );
}

/**
 * Content-address a REPUTATION state: a digest over the trust mass an attacker would
 * have to flip to hide a crater / contradiction / ratify — `alpha`, `beta`, `scarBeta`,
 * `corroborationDepth`, the audit counts, and the last-contradiction clock. A `null`
 * state (never-before-seen source) maps to the stable {@link EMPTY_STATE_HASH} sentinel.
 */
export function hashReputationState(st: ReputationState | null): string {
  if (st === null) return EMPTY_STATE_HASH;
  return sha256Hex(
    [
      "REP",
      String(st.sourceId),
      String(st.alpha),
      String(st.beta),
      String(st.scarBeta),
      String(st.corroborationDepth),
      String(st.ratifiedCount),
      String(st.contradictedCount),
      st.lastContradictionAt === null ? "" : String(st.lastContradictionAt),
    ].join("\x01"),
  );
}

/**
 * Build a {@link MutationPayload} (convenience). `refEventId` is OMITTED when undefined
 * (exactOptionalPropertyTypes — never assign `undefined`), so a receipt without a
 * driving-artifact link hashes stably via the canonical form's emit-only-if-present arm.
 */
export function mutationReceipt(
  op: MutationOp,
  subjectId: string,
  subjectHash: string,
  beforeHash: string,
  afterHash: string,
  at: EpochMs,
  refEventId?: string,
): MutationPayload {
  return refEventId === undefined
    ? { op, subjectId, subjectHash, beforeHash, afterHash, at }
    : { op, subjectId, subjectHash, beforeHash, afterHash, at, refEventId };
}
