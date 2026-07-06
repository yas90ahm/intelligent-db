/**
 * __torture__/roster.ts — the FIXED, DETERMINISTIC cast of sources / entities /
 * attributes the kill-loop's randomized ops draw from.
 *
 * Deterministic on purpose: every child process (a fresh restart after a SIGKILL)
 * re-derives the SAME source ids (`sourceIdFor` is a pure checksum of issuer+subject)
 * and re-registers them with the SAME anchors, so identity/anchor state — which is
 * NOT persisted (see harness.ts) — reconstructs byte-identically every restart with
 * no cross-process coordination needed.
 */

import { AnchorClass, sourceIdFor } from "../index.js";
import type { AnchorBinding, AttributeKey, EntityId, SourceId, Unit } from "../index.js";

import type { Wired } from "./harness.js";

function anchor(anchorClass: AnchorClass, weight: number): AnchorBinding {
  return {
    anchorClass,
    realizedCost: weight as Unit,
    independenceWeight: weight as Unit,
  };
}

/** Authoring roster: varied anchor strength, so genuine independence + echoes both occur. */
export const AUTHOR_SOURCES: readonly { readonly id: SourceId; readonly anchors: readonly AnchorBinding[] }[] = [
  { id: sourceIdFor("torture", "bare-key"), anchors: [] },
  { id: sourceIdFor("torture", "domain-a"), anchors: [anchor(AnchorClass.DOMAIN, 0.35)] },
  { id: sourceIdFor("torture", "domain-b"), anchors: [anchor(AnchorClass.DOMAIN, 0.35)] },
  { id: sourceIdFor("torture", "verified-human"), anchors: [anchor(AnchorClass.VERIFIED_HUMAN, 0.7)] },
  { id: sourceIdFor("torture", "organization"), anchors: [anchor(AnchorClass.ORGANIZATION, 0.75)] },
];

/** Never authors a fact — reserved so `approve()`/`ratify()` always have a clean, */
/** anchor-independent external voice available (avoids self-approval/self-ratify noise). */
export const APPROVER_SOURCE: SourceId = sourceIdFor("torture", "approver");
export const APPROVER_ANCHORS: readonly AnchorBinding[] = [anchor(AnchorClass.VERIFIED_HUMAN, 0.7)];

/** Periodically disowned (idempotent past the first successful disown). */
export const DISOWNABLE_SOURCE: SourceId = sourceIdFor("torture", "disownable");
export const DISOWNABLE_ANCHORS: readonly AnchorBinding[] = [anchor(AnchorClass.DOMAIN, 0.35)];

/** Every source id the roster ever mints — the set `reconcileLedger` audits. */
export const ALL_ROSTER_SOURCE_IDS: readonly SourceId[] = [
  ...AUTHOR_SOURCES.map((s) => s.id),
  APPROVER_SOURCE,
  DISOWNABLE_SOURCE,
];

export const ENTITIES: readonly EntityId[] = [1, 2, 3, 4].map(
  (i) => `torture:entity:${i}` as EntityId,
);

export function attributesOf(entity: EntityId): readonly AttributeKey[] {
  return ["attrA", "attrB"].map((a) => `${entity}#${a}` as AttributeKey);
}

export const ALL_ATTRIBUTES: readonly AttributeKey[] = ENTITIES.flatMap((e) => attributesOf(e));

/** Re-register the whole roster against a freshly-wired engine. Idempotent (safe to re-run). */
export function registerRoster(w: Wired): void {
  for (const src of AUTHOR_SOURCES) {
    w.sources.register({ sourceId: src.id, kind: "OTHER", label: String(src.id) });
    if (src.anchors.length > 0) w.anchors.bind(src.id, src.anchors);
  }
  w.sources.register({ sourceId: APPROVER_SOURCE, kind: "OTHER", label: "approver" });
  w.anchors.bind(APPROVER_SOURCE, APPROVER_ANCHORS);
  w.sources.register({ sourceId: DISOWNABLE_SOURCE, kind: "OTHER", label: "disownable" });
  w.anchors.bind(DISOWNABLE_SOURCE, DISOWNABLE_ANCHORS);
}
