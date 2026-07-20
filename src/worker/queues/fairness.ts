/**
 * Tenant fairness scheduling (G15 / SPEC-142).
 *
 * SPEC-141 dequeues strict FIFO within one (domain, tenant). Across tenants that
 * is unfair: a tenant flooding a domain would starve everyone else. This module
 * arbitrates BETWEEN tenants with weighted deficit round-robin (WDRR): among the
 * tenants that currently have pending work in a domain, serve the one with the
 * lowest weighted service deficit (`served / weight`), breaking ties by ascending
 * tenantId. High-weight tenants get proportionally more turns; no tenant starves.
 *
 * Pure + deterministic (INV-01): `nowMs`/weights injected, no clock/RNG/IO. The
 * chosen tenant is only ever served its OWN FIFO head (INV-02 — no cross-tenant
 * leakage). Returns a G01 `ComponentResult`; fail-closed on no pending work.
 */
import { type ComponentFailure, type FailureStatus } from '@/agent/contracts';
import { pendingFor, dequeue } from './queue';
import type { QueueOp, QueueState, QueueTask, TaskDomain } from './contract';

export const FAIRNESS_REASON_CODES = {
  NO_PENDING: 'F_NO_PENDING',
  MALFORMED: 'F_MALFORMED',
  NON_POSITIVE_WEIGHT: 'F_NON_POSITIVE_WEIGHT',
} as const;
export type FairnessReasonCode = (typeof FAIRNESS_REASON_CODES)[keyof typeof FAIRNESS_REASON_CODES];

/** Per-tenant cumulative (weighted) service counters. Immutable value (INV-01). */
export interface FairnessState {
  /** tenantId → cumulative served count (unweighted; weighting applied at pick). */
  readonly served: Readonly<Record<string, number>>;
}

export function emptyFairnessState(): FairnessState {
  return { served: {} };
}

/** Positive integer weight per tenant; a tenant absent here defaults to weight 1. */
export type TenantWeights = Readonly<Record<string, number>>;

function ffail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

/** Weight for a tenant (default 1). */
export function weightOf(weights: TenantWeights, tenantId: string): number {
  const w = weights[tenantId];
  return w === undefined ? 1 : w;
}

/**
 * Deterministically pick the next tenant to serve in a domain: among tenants with
 * pending work, the minimum `served/weight` deficit, tie-broken by ascending
 * tenantId. Returns null when no tenant has pending work.
 */
export function pickFairTenant(
  state: QueueState,
  fairness: FairnessState,
  domain: TaskDomain,
  weights: TenantWeights,
): string | null {
  // Distinct tenants with at least one pending task in this domain.
  const tenants = new Set<string>();
  for (const t of state.tasks) {
    if (t.domain === domain && t.state === 'PENDING') tenants.add(t.identity.tenantId);
  }
  if (tenants.size === 0) return null;

  let best: string | null = null;
  let bestDeficit = Number.POSITIVE_INFINITY;
  for (const tenantId of [...tenants].sort()) {
    const served = fairness.served[tenantId] ?? 0;
    const deficit = served / weightOf(weights, tenantId);
    if (deficit < bestDeficit) {
      bestDeficit = deficit;
      best = tenantId;
    }
  }
  return best;
}

/**
 * Schedule the next task in a domain fairly across tenants. Picks the fair tenant,
 * dequeues its FIFO head (SPEC-141), and advances that tenant's service counter.
 * Fail-closed: no pending work in the domain ⇒ RETRYABLE / NO_PENDING.
 */
export function scheduleFair(
  state: QueueState,
  fairness: FairnessState,
  args: { domain: TaskDomain; actorId: string; weights: TenantWeights; nowMs: number },
): QueueOp<QueueTask> & { fairness: FairnessState } {
  const { domain, actorId, weights, nowMs } = args;

  // Reject non-positive weights explicitly (fail-closed): a zero/negative weight
  // is an undecidable priority, not "infinite priority".
  for (const [tenantId, w] of Object.entries(weights)) {
    if (!Number.isFinite(w) || w <= 0) {
      return {
        result: ffail('FAILED_FINAL', [FAIRNESS_REASON_CODES.NON_POSITIVE_WEIGHT]),
        state,
        fairness,
      };
    }
    void tenantId;
  }

  const tenantId = pickFairTenant(state, fairness, domain, weights);
  if (tenantId === null) {
    return { result: ffail('RETRYABLE', [FAIRNESS_REASON_CODES.NO_PENDING]), state, fairness };
  }

  // Confirm this tenant actually has a pending head (defensive; pick guarantees it).
  const head = pendingFor(state, domain, tenantId)[0];
  if (!head) {
    return { result: ffail('RETRYABLE', [FAIRNESS_REASON_CODES.NO_PENDING]), state, fairness };
  }

  const op = dequeue(state, {
    identity: { ...head.identity, actorId },
    contractVersion: '1.0.0',
    payload: { domain, nowMs },
  });

  const nextFairness: FairnessState = {
    served: { ...fairness.served, [tenantId]: (fairness.served[tenantId] ?? 0) + 1 },
  };
  return { result: op.result, state: op.state, fairness: nextFairness };
}
