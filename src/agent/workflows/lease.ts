/**
 * Step leases and heartbeats (G14 / SPEC-134).
 *
 * A durable step may be picked up by a worker that then crashes. To guarantee at
 * most one LIVE worker per step, a worker must hold a time-bounded LEASE to
 * execute it. The worker heartbeats to extend the lease; if it dies, the lease
 * expires and another worker may reclaim the step. Combined with idempotency
 * (SPEC-136), this makes duplicate side effects impossible even across crashes.
 *
 * Pure, deterministic — `nowMs` is injected, never read from a clock (INV-01).
 * Fail-closed: no live lease ⇒ no execution.
 */
import { z } from 'zod';

export interface StepLease {
  instanceId: string;
  stepId: string;
  workerId: string;
  leasedAtMs: number;
  expiresAtMs: number;
  /** Last heartbeat instant (for observability). */
  heartbeatAtMs: number;
}

export const LEASE_REASON_CODES = {
  HELD_BY_OTHER: 'WF_LEASE_HELD_BY_OTHER',
  NOT_LEASE_HOLDER: 'WF_LEASE_NOT_HOLDER',
  LEASE_EXPIRED: 'WF_LEASE_EXPIRED',
  MALFORMED: 'WF_LEASE_MALFORMED',
} as const;

const acquireSchema = z.object({
  instanceId: z.string().min(1),
  stepId: z.string().min(1),
  workerId: z.string().min(1),
  nowMs: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive(),
});

export function isExpired(lease: StepLease, nowMs: number): boolean {
  return nowMs >= lease.expiresAtMs;
}

/** True iff `workerId` currently holds a LIVE lease. */
export function isHeldBy(lease: StepLease | null, workerId: string, nowMs: number): boolean {
  return !!lease && lease.workerId === workerId && !isExpired(lease, nowMs);
}

export type LeaseResult =
  | { ok: true; lease: StepLease }
  | { ok: false; reasonCodes: string[] };

/**
 * Acquire (or reclaim) a lease. Succeeds when there is no current lease, or the
 * current lease has expired, or it is already held by this same worker (renew).
 * Fails when another worker holds a LIVE lease.
 */
export function acquireLease(
  current: StepLease | null,
  args: { instanceId: string; stepId: string; workerId: string; nowMs: number; ttlMs: number },
): LeaseResult {
  const parsed = acquireSchema.safeParse(args);
  if (!parsed.success) return { ok: false, reasonCodes: [LEASE_REASON_CODES.MALFORMED] };
  const { instanceId, stepId, workerId, nowMs, ttlMs } = args;

  if (current && !isExpired(current, nowMs) && current.workerId !== workerId) {
    return { ok: false, reasonCodes: [LEASE_REASON_CODES.HELD_BY_OTHER] };
  }
  const lease: StepLease = {
    instanceId,
    stepId,
    workerId,
    leasedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    heartbeatAtMs: nowMs,
  };
  return { ok: true, lease };
}

/**
 * Extend a lease via heartbeat. Only the current holder may heartbeat, and only
 * while the lease is still live — a lapsed lease cannot be resurrected (the step
 * must be re-acquired, which re-checks ownership).
 */
export function heartbeat(
  current: StepLease,
  workerId: string,
  nowMs: number,
  ttlMs: number,
): LeaseResult {
  if (current.workerId !== workerId) return { ok: false, reasonCodes: [LEASE_REASON_CODES.NOT_LEASE_HOLDER] };
  if (isExpired(current, nowMs)) return { ok: false, reasonCodes: [LEASE_REASON_CODES.LEASE_EXPIRED] };
  return {
    ok: true,
    lease: { ...current, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttlMs },
  };
}

/**
 * Guard an execution attempt: the worker must hold a live lease. Returns the
 * empty array if authorized, or reason codes otherwise (fail-closed).
 */
export function assertLeaseHeld(lease: StepLease | null, workerId: string, nowMs: number): string[] {
  if (!lease) return [LEASE_REASON_CODES.NOT_LEASE_HOLDER];
  if (lease.workerId !== workerId) return [LEASE_REASON_CODES.NOT_LEASE_HOLDER];
  if (isExpired(lease, nowMs)) return [LEASE_REASON_CODES.LEASE_EXPIRED];
  return [];
}
