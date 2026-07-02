/**
 * ratification/disputeRouting.ts — THE ENTERPRISE DISPUTE-ROUTING ADAPTER
 * (PHASE 4, deliverable B): a PURE DECISION LAYER that maps an open deferred
 * dispute ({@link PendingPayload}, the doorbell's plain-data record) to the
 * OWNING GROUP that should adjudicate it (e.g. an IdP group name).
 *
 * DELIBERATELY THIN — and that is the value. A deployment maps IdP groups to
 * dispute categories in ONE config object and gets DETERMINISTIC assignments it
 * can pipe anywhere. There is NO transport here (no Slack, no ServiceNow, no
 * HTTP, no email): delivery is the deployment's job; this module only decides.
 * Zero deps, zero I/O, pure data in → pure data out — so it is trivially
 * testable and can run anywhere (a webhook handler, a cron sweep, a CLI).
 *
 * DETERMINISM CONTRACT: routes are evaluated IN CONFIG ORDER and the FIRST rule
 * whose every stated criterion matches wins (first-match-wins, exactly like a
 * firewall table). No rule matched ⇒ `defaultAssignTo`. Same inputs ⇒ same
 * assignment, always — an auditor can replay any routing decision from the
 * config + the pending record alone.
 *
 * QUARANTINE INTERACTION (Phase 3): the pendings this router sees only ever
 * form among LIVE strands (`adjudicate` admits only LIVE members), so every
 * routed dispute is a genuine believed-fact conflict — a PROVISIONAL
 * (quarantined) flood never reaches the routing table.
 *
 * STACK NOTE: ESM + NodeNext ⇒ relative imports carry `.js`;
 * `verbatimModuleSyntax` ⇒ type-only imports use `import type`.
 */

import type { PendingPayload } from "./pendingLedger.js";

// ---------------------------------------------------------------------------
// Config (plain data — the deployment's routing policy)
// ---------------------------------------------------------------------------

/**
 * The criteria of one routing rule. EVERY stated criterion must match for the
 * rule to fire (logical AND); an EMPTY match (`{}`) matches every dispute (a
 * catch-all rule placed before the implicit default).
 */
export interface DisputeRouteMatch {
  /**
   * Prefix match on the dispute's attribute key (e.g. `"hr#"` routes every
   * `hr#…` attribute to the HR owners). Matched against
   * `String(pending.attribute)`.
   */
  readonly attributePrefix?: string;
  /**
   * Prefix match on the disputed strands' ENTITY id (e.g. `"entity:payroll"`).
   * The {@link PendingPayload} itself carries only member StrandIds — no entity
   * — so this criterion matches against the CALLER-RESOLVED entity supplied in
   * {@link DisputeRouteOptions.entity} (the caller has store access; this
   * module stays pure). FAIL-CLOSED: a rule stating `entityPrefix` does NOT
   * match when no entity evidence was supplied.
   */
  readonly entityPrefix?: string;
}

/** One routing rule: criteria plus the owning group(s) to assign to. */
export interface DisputeRoute {
  /** The criteria (ALL stated ones must match; `{}` = catch-all). */
  readonly match: DisputeRouteMatch;
  /** The owning-group label to assign matched disputes to (e.g. an IdP group). */
  readonly assignTo: string;
  /**
   * OPTIONAL escalation target for HIGH-IMPACT disputes (the same irreversible
   * flag `adjudicate({ highImpact })` takes): when the caller routes with
   * `{ highImpact: true }` and this is set, the dispute is assigned here
   * instead of {@link assignTo}. Absent ⇒ high-impact routes to `assignTo`.
   */
  readonly highImpactAssignTo?: string;
}

/** The deployment's whole routing policy, as plain data. */
export interface DisputeRoutingConfig {
  /** Evaluated in order; FIRST rule whose criteria all match wins. */
  readonly routes: readonly DisputeRoute[];
  /** The owning group for disputes no rule matched (always required — a
   * deferred dispute must never be silently unowned). */
  readonly defaultAssignTo: string;
}

// ---------------------------------------------------------------------------
// Routing inputs / outputs
// ---------------------------------------------------------------------------

/** Per-dispute routing options (caller-supplied evidence + intent). */
export interface DisputeRouteOptions {
  /** Escalate to the matched rule's `highImpactAssignTo` when set (see there). */
  readonly highImpact?: boolean;
  /**
   * The disputed strands' entity id, CALLER-resolved from the store (the
   * payload carries only member ids). Only needed when the config uses
   * `entityPrefix` rules; omitted ⇒ those rules fail closed (do not match).
   */
  readonly entity?: string;
}

/** One deterministic routing decision (pure data — pipe it anywhere). */
export interface RoutedDispute {
  /** The pending dispute, verbatim (the payload the assignee will review). */
  readonly pending: PendingPayload;
  /** The owning-group label this dispute is assigned to. */
  readonly assignTo: string;
  /**
   * WHICH rule matched, human-readable and replayable: `route[i]` + the
   * criteria that fired (or `default` when no rule matched), plus a note when
   * the high-impact escalation target was taken.
   */
  readonly reason: string;
}

/**
 * Anything that can hand over the open pendings — satisfied structurally by the
 * {@link PendingLedger}, the engine (`IntelligentDb`), AND the agent facade
 * (`AgentMemory`), so `routeAll(engine)` / `routeAll(ledger)` both just work.
 */
export interface PendingSource {
  listPending(): readonly PendingPayload[];
}

/** The router: a pure, deterministic decision function over the config. */
export interface DisputeRouter {
  /** Route ONE pending dispute (first-match-wins; see the module contract). */
  route(pending: PendingPayload, opts?: DisputeRouteOptions): RoutedDispute;
  /**
   * Convenience: route EVERY open pending from a {@link PendingSource} (ledger /
   * engine / facade) or a plain array, in listing order, with `opts` applied to
   * each. Per-dispute evidence (e.g. `entity`) differs per dispute, so callers
   * needing entity rules should map `route` themselves.
   */
  routeAll(
    source: PendingSource | readonly PendingPayload[],
    opts?: DisputeRouteOptions,
  ): readonly RoutedDispute[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Does this rule's every stated criterion match (empty match = catch-all)? */
function ruleMatches(
  match: DisputeRouteMatch,
  pending: PendingPayload,
  opts: DisputeRouteOptions | undefined,
): boolean {
  if (
    match.attributePrefix !== undefined &&
    !String(pending.attribute).startsWith(match.attributePrefix)
  ) {
    return false;
  }
  if (match.entityPrefix !== undefined) {
    // FAIL-CLOSED: no caller-resolved entity evidence ⇒ an entity rule cannot
    // match (never guess an entity from ids; the payload carries none).
    const entity = opts?.entity;
    if (entity === undefined || !entity.startsWith(match.entityPrefix)) return false;
  }
  return true;
}

/** Human-readable, replayable description of a rule's fired criteria. */
function describeCriteria(match: DisputeRouteMatch): string {
  const parts: string[] = [];
  if (match.attributePrefix !== undefined) {
    parts.push(`attributePrefix "${match.attributePrefix}"`);
  }
  if (match.entityPrefix !== undefined) {
    parts.push(`entityPrefix "${match.entityPrefix}"`);
  }
  return parts.length === 0 ? "catch-all" : parts.join(" AND ");
}

/**
 * Construct a {@link DisputeRouter} over a {@link DisputeRoutingConfig}.
 * The config is captured as-is (plain data, no validation pass needed beyond
 * TypeScript's shape): an empty `routes` array is legal and routes everything
 * to `defaultAssignTo`.
 */
export function createDisputeRouter(config: DisputeRoutingConfig): DisputeRouter {
  function route(pending: PendingPayload, opts?: DisputeRouteOptions): RoutedDispute {
    for (let i = 0; i < config.routes.length; i++) {
      const rule = config.routes[i]!;
      if (!ruleMatches(rule.match, pending, opts)) continue;

      // FIRST MATCH WINS — the determinism contract. High-impact escalation
      // takes the rule's dedicated target only when both the intent flag and
      // the target are present.
      const escalate = opts?.highImpact === true && rule.highImpactAssignTo !== undefined;
      return {
        pending,
        assignTo: escalate ? rule.highImpactAssignTo! : rule.assignTo,
        reason:
          `route[${i}] matched (${describeCriteria(rule.match)})` +
          (escalate ? "; high-impact ⇒ escalated to highImpactAssignTo" : ""),
      };
    }
    return {
      pending,
      assignTo: config.defaultAssignTo,
      reason: "default: no route matched",
    };
  }

  function routeAll(
    source: PendingSource | readonly PendingPayload[],
    opts?: DisputeRouteOptions,
  ): readonly RoutedDispute[] {
    const pendings = Array.isArray(source)
      ? (source as readonly PendingPayload[])
      : (source as PendingSource).listPending();
    return pendings.map((p) => route(p, opts));
  }

  return { route, routeAll };
}
