/**
 * Concurrency and backpressure (G15 / SPEC-143).
 *
 * Two deterministic guards over the SPEC-141 queue state:
 *
 *  1. Concurrency admission — cap the number of simultaneously in-flight (LEASED)
 *     tasks per domain and per (domain, tenant). A dequeue is admitted only if
 *     both caps have headroom; otherwise it is BACKPRESSURE'd (RETRYABLE with a
 *     deterministic `retryAfterMs`), never silently over-committed.
 *  2. Backpressure ceiling — cap the PENDING depth per domain. When the backlog
 *     is at the ceiling a new enqueue is refused (RETRYABLE / QUEUE_FULL), so the
 *     system sheds load at the edge instead of growing an unbounded queue.
 *
 * Pure + deterministic (INV-01): limits / `nowMs` / `retryAfterMs` injected, no
 * clock/RNG/IO. Fail-closed (INV-05): a malformed limit or an at-capacity state
 * denies rather than proceeds. Per-tenant counting preserves isolation (INV-02).
 */
import { allowed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';
import { depth } from './queue';
import type { QueueState, TaskDomain } from './contract';

export const CONCURRENCY_REASON_CODES = {
  BACKPRESSURE_DOMAIN: 'C_BACKPRESSURE_DOMAIN',
  BACKPRESSURE_TENANT: 'C_BACKPRESSURE_TENANT',
  QUEUE_FULL: 'C_QUEUE_FULL',
  MALFORMED: 'C_MALFORMED',
} as const;
export type ConcurrencyReasonCode =
  (typeof CONCURRENCY_REASON_CODES)[keyof typeof CONCURRENCY_REASON_CODES];

/** Deterministic limits (all counts are positive integers). */
export interface ConcurrencyLimits {
  /** Max simultaneously in-flight (LEASED) tasks per domain. */
  maxInFlightPerDomain: number;
  /** Max simultaneously in-flight tasks per (domain, tenant). */
  maxInFlightPerTenant: number;
  /** Max PENDING depth per domain before enqueue is refused. */
  maxDepthPerDomain: number;
  /** Deterministic hint returned to the caller on a backpressure denial. */
  retryAfterMs: number;
}

function cfail(status: FailureStatus, reasonCodes: string[], retryAfterMs?: number): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [], ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/** Count in-flight (LEASED) tasks for a domain (optionally scoped to a tenant). */
export function inFlight(state: QueueState, domain: TaskDomain, tenantId?: string): number {
  return state.tasks.filter(
    (t) =>
      t.domain === domain &&
      t.state === 'LEASED' &&
      (tenantId === undefined || t.identity.tenantId === tenantId),
  ).length;
}

function limitsValid(l: ConcurrencyLimits): boolean {
  return (
    Number.isInteger(l.maxInFlightPerDomain) && l.maxInFlightPerDomain > 0 &&
    Number.isInteger(l.maxInFlightPerTenant) && l.maxInFlightPerTenant > 0 &&
    Number.isInteger(l.maxDepthPerDomain) && l.maxDepthPerDomain > 0 &&
    Number.isInteger(l.retryAfterMs) && l.retryAfterMs >= 0
  );
}

/**
 * Admit (or backpressure) a dequeue/execution for (domain, tenant). ALLOWED when
 * both the domain and the tenant have in-flight headroom; otherwise RETRYABLE
 * with the specific backpressure reason and a deterministic retry hint.
 */
export function admitDequeue(
  state: QueueState,
  args: { domain: TaskDomain; tenantId: string; limits: ConcurrencyLimits },
): ComponentResult<{ domain: TaskDomain; tenantId: string }> {
  const { domain, tenantId, limits } = args;
  if (!limitsValid(limits) || !tenantId) {
    return cfail('FAILED_FINAL', [CONCURRENCY_REASON_CODES.MALFORMED]);
  }
  if (inFlight(state, domain) >= limits.maxInFlightPerDomain) {
    return cfail('RETRYABLE', [CONCURRENCY_REASON_CODES.BACKPRESSURE_DOMAIN], limits.retryAfterMs);
  }
  if (inFlight(state, domain, tenantId) >= limits.maxInFlightPerTenant) {
    return cfail('RETRYABLE', [CONCURRENCY_REASON_CODES.BACKPRESSURE_TENANT], limits.retryAfterMs);
  }
  return allowed({ domain, tenantId }, [], { concurrency: '1.0.0' });
}

/**
 * Admit (or refuse) a new enqueue for a domain based on the PENDING depth ceiling.
 * ALLOWED with headroom; RETRYABLE / QUEUE_FULL at/over the ceiling (shed at edge).
 */
export function admitEnqueue(
  state: QueueState,
  args: { domain: TaskDomain; limits: ConcurrencyLimits },
): ComponentResult<{ domain: TaskDomain; depth: number }> {
  const { domain, limits } = args;
  if (!limitsValid(limits)) {
    return cfail('FAILED_FINAL', [CONCURRENCY_REASON_CODES.MALFORMED]);
  }
  const d = depth(state, domain);
  if (d >= limits.maxDepthPerDomain) {
    return cfail('RETRYABLE', [CONCURRENCY_REASON_CODES.QUEUE_FULL], limits.retryAfterMs);
  }
  return allowed({ domain, depth: d }, [], { concurrency: '1.0.0' });
}
