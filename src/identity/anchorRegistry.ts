/**
 * identity/anchorRegistry.ts — THE REAL, FLEET-CAPPED ANCHOR REGISTRY.
 *
 * The concrete {@link AnchorRegistryPort} the facade and the forgetting layer ask
 * (replacing the test mock). It stores signed {@link AnchorAttestation}s per source
 * and turns VALID ones into real independence:
 *
 *  - `anchorsOf(sourceId)` projects only VALID (non-expired, sig-verified)
 *    attestations to {@link AnchorBinding}s. Expired ⇒ dropped ⇒ the source
 *    reverts toward BARE_KEY (independence 0, disputes defer). FAIL-CLOSED: an
 *    unbound source returns `[]`.
 *
 *  - `independentSources(a, b)` is the FLEET CAP (ARCHITECTURE.md §1, the
 *    red-team's key point): two sources that share an `operatorClassId` (same
 *    registrar / ASN / issuer / provider) are NOT independent on that axis EVEN
 *    with different domains, so a flood of N sources behind ONE operator collapses
 *    toward ONE class — `independentRootCount` (which prefers this predicate)
 *    counts the fleet as ~1, not N. N sources behind N DIFFERENT operators count
 *    as N. The per-anchor `classId` (eTLD+1 / normalized address) is the second
 *    axis: two DOMAIN sources with DIFFERENT domains and DIFFERENT operators are
 *    genuinely independent (the list-based `independenceBetween` could not see
 *    this, since they share the DOMAIN anchor CLASS).
 *
 *  - `aggregateCost` / `independenceBetween` reuse identity/anchors.ts math
 *    verbatim (no reimplementation) over the CLEAN projected bindings, so the
 *    self-stack cap + sublinear combine still hold and the synthetic fleet axis
 *    never leaks into the stamp's cost or rep_cap.
 *
 * High `rep_cap` (ARCHITECTURE.md §1 "≥2 disjoint anchor types proven to bind the
 * same subject") is DETECTABLE here (`distinctAnchorTypes(sourceId) >= 2`) and
 * exposed; full enforcement is left optional per the roadmap.
 *
 * STACK NOTE: ESM + NodeNext (`.js` specifiers); `verbatimModuleSyntax`
 * (`import type`); no external deps.
 */

import {
  type SourceId,
  type AnchorBinding,
  type IndependenceClassId,
  type OperatorClassId,
  type EpochMs,
  type Unit,
} from "../core/types.js";
import {
  aggregateAnchorCost,
  independenceBetween as anchorsIndependenceBetween,
} from "./anchors.js";
import type { AnchorRegistryPort } from "./index.js";
import {
  verifyAttestation,
  type AnchorAttestation,
} from "./binding.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The real registry. Extends {@link AnchorRegistryPort} with attestation ingest +
 * the source-aware fleet-cap predicate the facade prefers.
 */
export interface AnchorRegistry extends AnchorRegistryPort {
  /**
   * Ingest a signed attestation. REJECTS (returns false, stores nothing) if the
   * verifier signature does not check out OR the attestation is already expired at
   * `now` — a forged/expired attestation never grants independence (fail-closed).
   * On success it is stored for `att.sourceId` and contributes its `weight`
   * independence of class `att.anchorType` while valid.
   */
  ingest(att: AnchorAttestation, now: EpochMs): boolean;

  /** All currently-VALID attestations for a source (non-expired, sig-verified). */
  validAttestationsOf(sourceId: SourceId): readonly AnchorAttestation[];

  /**
   * Whether the source has ≥2 DISTINCT valid anchor TYPES (the precondition the
   * design names for a HIGH rep_cap — "≥2 disjoint anchor types … binding the
   * same subject"). Detection only; full enforcement is optional.
   */
  qualifiesForHighRepCap(sourceId: SourceId): boolean;
}

/** Dependencies for the real registry. */
export interface AnchorRegistryDeps {
  /** SPKI PEM of the verifier whose signature every ingested attestation must
   * carry. A forged attestation (wrong/missing sig) is rejected on ingest. */
  readonly verifierPublicKeyPem: string;
  /** Clock the registry validates expiry against. Inject for testability. */
  readonly now: () => EpochMs;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class RealAnchorRegistry implements AnchorRegistry {
  readonly #verifierPub: string;
  readonly #now: () => EpochMs;
  /** sourceId → its attestations (valid + possibly-expired; filtered on read). */
  readonly #book = new Map<SourceId, AnchorAttestation[]>();
  /** sourceId → bindings injected directly via the port `bind` (mock/legacy path). */
  readonly #directBindings = new Map<SourceId, AnchorBinding[]>();

  constructor(deps: AnchorRegistryDeps) {
    this.#verifierPub = deps.verifierPublicKeyPem;
    this.#now = deps.now;
  }

  // ---- attestation ingest --------------------------------------------------

  ingest(att: AnchorAttestation, now: EpochMs): boolean {
    // Fail-closed: never store a forged or already-expired attestation.
    if (!verifyAttestation(att, this.#verifierPub, now)) return false;
    const list = this.#book.get(att.sourceId);
    if (list === undefined) {
      this.#book.set(att.sourceId, [att]);
    } else {
      list.push(att);
    }
    return true;
  }

  validAttestationsOf(sourceId: SourceId): readonly AnchorAttestation[] {
    const now = this.#now();
    const list = this.#book.get(sourceId);
    if (list === undefined) return [];
    return list.filter((att) =>
      verifyAttestation(att, this.#verifierPub, now),
    );
  }

  // ---- AnchorRegistryPort --------------------------------------------------

  /**
   * Direct bind path (mostly for legacy/manual bindings and registering a source
   * with no attestation yet). Additive; the production path is {@link ingest}.
   */
  bind(sourceId: SourceId, anchors: readonly AnchorBinding[]): void {
    if (anchors.length === 0) {
      if (!this.#directBindings.has(sourceId)) {
        this.#directBindings.set(sourceId, []);
      }
      return;
    }
    const prev = this.#directBindings.get(sourceId) ?? [];
    this.#directBindings.set(sourceId, [...prev, ...anchors]);
  }

  /**
   * The CLEAN projected anchor set: one {@link AnchorBinding} per valid
   * attestation (plus any directly-bound bindings). NO synthetic operator binding
   * leaks here, so `aggregateCost` / `repCapFor` / the stamp see only real anchors.
   * Expired attestations are dropped ⇒ an all-expired source projects to `[]` ⇒
   * BARE_KEY behavior.
   */
  anchorsOf(sourceId: SourceId): readonly AnchorBinding[] {
    const out: AnchorBinding[] = [];
    for (const att of this.validAttestationsOf(sourceId)) {
      out.push({
        anchorClass: att.anchorType,
        realizedCost: att.weight,
        independenceWeight: att.weight,
      });
    }
    const direct = this.#directBindings.get(sourceId);
    if (direct !== undefined) out.push(...direct);
    return out;
  }

  aggregateCost(anchors: readonly AnchorBinding[]): Unit {
    return aggregateAnchorCost(anchors);
  }

  independenceBetween(
    a: readonly AnchorBinding[],
    b: readonly AnchorBinding[],
  ): Unit {
    // Reuse the anchor-cost disjointness math verbatim.
    return anchorsIndependenceBetween([...a], [...b]);
  }

  // ---- the FLEET CAP -------------------------------------------------------

  /**
   * Source-aware independence (preferred by `independentRootCount`).
   *
   * Two sources are independent iff there is a pair of anchors — one from each
   * source — that are disjoint on BOTH the per-anchor `classId` axis (different
   * eTLD+1 / address) AND the `operatorClassId` FLEET axis (different
   * registrar/ASN/provider), with positive weight. Concretely:
   *
   *  - A source with no valid attestation is BARE_KEY ⇒ never independent
   *    (fail-closed; weight 0).
   *  - If EVERY operator class of A is also an operator class of B (and vice
   *    versa for at least the shared-operator case), the sources are on the same
   *    fleet ⇒ NOT independent. A flood of N sources behind one operator is
   *    pairwise-correlated ⇒ the max-independent-set collapses to 1.
   *  - Otherwise, independence requires a disjoint `classId` pair carrying weight.
   */
  independentSources(a: SourceId, b: SourceId): boolean {
    const aw = this.#weightedAnchors(a);
    const bw = this.#weightedAnchors(b);
    // Fail-closed: a BARE_KEY (no valid anchor) side is never independent.
    if (aw.length === 0 || bw.length === 0) return false;

    const aOperators = new Set(aw.map((x) => x.operatorClassId));
    const bOperators = new Set(bw.map((x) => x.operatorClassId));
    const aClasses = new Set(aw.map((x) => x.classId));
    const bClasses = new Set(bw.map((x) => x.classId));

    // FLEET CAP: if the two sources share ANY operator class, they are not
    // independent on that axis. With single-anchor sources (the common fleet
    // shape) a shared operator means same registrar/ASN ⇒ correlated. This is the
    // mechanism that collapses a same-operator fleet toward one class.
    for (const op of aOperators) {
      if (bOperators.has(op)) return false;
    }

    // Independence then requires a per-anchor classId on each side that the other
    // does not share (a genuinely disjoint costly root) — and at least one such
    // disjoint anchor carrying positive weight on each side.
    const aDisjoint = aw.filter((x) => !bClasses.has(x.classId));
    const bDisjoint = bw.filter((x) => !aClasses.has(x.classId));
    if (aDisjoint.length === 0 || bDisjoint.length === 0) return false;
    const aHasWeight = aDisjoint.some((x) => x.weight > 0);
    const bHasWeight = bDisjoint.some((x) => x.weight > 0);
    return aHasWeight && bHasWeight;
  }

  qualifiesForHighRepCap(sourceId: SourceId): boolean {
    const types = new Set(
      this.validAttestationsOf(sourceId).map((att) => att.anchorType),
    );
    return types.size >= 2;
  }

  // ---- internals -----------------------------------------------------------

  /** Valid attestations projected with their fleet + class axes for the cap. */
  #weightedAnchors(sourceId: SourceId): Array<{
    classId: IndependenceClassId;
    operatorClassId: OperatorClassId;
    weight: number;
  }> {
    return this.validAttestationsOf(sourceId).map((att) => ({
      classId: att.classId,
      operatorClassId: att.operatorClassId,
      weight: att.weight,
    }));
  }
}

/**
 * Build the real, fleet-capped {@link AnchorRegistry}. Wire its `verifierPublicKeyPem`
 * to the same verifier key whose private half the binders sign with, and its `now`
 * to the host clock (inject a fake clock in tests to exercise expiry).
 */
export function createAnchorRegistry(
  deps: AnchorRegistryDeps,
): AnchorRegistry {
  return new RealAnchorRegistry(deps);
}
