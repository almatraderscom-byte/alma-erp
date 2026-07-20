/**
 * Worker lease and crash recovery (G15 / SPEC-145).
 *
 * A task becomes LEASED when a worker dequeues it (SPEC-141). If that worker
 * crashes, the task must not stay stuck LEASED forever, and it must not be blindly
 * requeued either — a blind requeue of a side-effecting task risks DOUBLE effects.
 *
 * This module binds the G14 durable-runtime primitives to queue tasks WITHOUT
 * reimplementing them (INV-06):
 *   - `@/agent/workflows/lease`     → time-bounded worker leases + heartbeats.
 *   - `@/agent/workflows/reconcile` → decide, from a probe FINDING, whether the
 *     effect happened, so recovery converges instead of guessing.
 *
 * Recovery of a crashed (expired-lease) task ALWAYS routes through reconciliation:
 *   effect_present            → CONFIRMED_DONE       → mark the task DONE
 *   effect_absent             → CONFIRMED_NOT_DONE   → requeue PENDING (safe retry)
 *   indeterminate (budget left)→ RECONCILE_AGAIN     → UNKNOWN_OUTCOME (probe again)
 *   indeterminate (exhausted) → ESCALATE             → mark DEAD (dead-letter)
 *
 * Pure + deterministic (INV-01): `nowMs`/ttl/finding injected, the probe I/O lives
 * behind the G14 seam. Returns a G01 `ComponentResult`. Fail-closed (INV-05): a
 * still-LIVE lease cannot be recovered; a malformed request denies.
 */
import { completed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';
import { isExpired, type StepLease } from '@/agent/workflows/lease';
import { reconcile, type ReconcileFinding } from '@/agent/workflows/reconcile';
import type { QueueState, QueueTask } from './contract';

export const WORKER_LEASE_REASON_CODES = {
  LEASE_LIVE: 'WL_LEASE_STILL_LIVE',
  MALFORMED: 'WL_MALFORMED',
  NOT_LEASED: 'WL_TASK_NOT_LEASED',
  ESCALATED: 'WL_ESCALATED_DEAD_LETTER',
  RECONCILE_AGAIN: 'WL_RECONCILE_AGAIN',
} as const;
export type WorkerLeaseReasonCode =
  (typeof WORKER_LEASE_REASON_CODES)[keyof typeof WORKER_LEASE_REASON_CODES];

/** Reconciliation budget for a crashed-task recovery probe loop. */
export interface RecoveryBudget {
  attempts: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export type RecoveryAction = 'COMPLETED' | 'REQUEUED' | 'RECONCILE_AGAIN' | 'DEAD_LETTERED';

export interface RecoveryOutcome {
  action: RecoveryAction;
  task: QueueTask;
}

function wfail(status: FailureStatus, reasonCodes: string[], retryAfterMs?: number): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [], ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function setState(state: QueueState, taskId: string, next: QueueTask['state']): { state: QueueState; task: QueueTask } {
  let updated: QueueTask | null = null;
  const tasks = state.tasks.map((t) => {
    if (t.taskId === taskId) {
      updated = { ...t, state: next };
      return updated;
    }
    return t;
  });
  return { state: { tasks }, task: updated as unknown as QueueTask };
}

/**
 * Recover a crashed task whose worker lease has EXPIRED, converging via
 * reconciliation over an injected probe `finding`. Never blindly requeues.
 * Returns the recovery action + next queue state.
 *
 * Fail-closed: the task must be LEASED and the lease must be expired at `nowMs`;
 * otherwise the recovery is DENIED (a live lease is still someone's to run).
 */
export function recoverCrashedTask(
  state: QueueState,
  args: {
    task: QueueTask;
    lease: StepLease;
    finding: ReconcileFinding;
    budget: RecoveryBudget;
    nowMs: number;
  },
): { result: ComponentResult<RecoveryOutcome>; state: QueueState } {
  const { task, lease, finding, budget, nowMs } = args;

  if (!Number.isInteger(nowMs) || nowMs < 0 || !task || !lease) {
    return { result: wfail('FAILED_FINAL', [WORKER_LEASE_REASON_CODES.MALFORMED]), state };
  }
  if (task.state !== 'LEASED') {
    return { result: wfail('DENIED', [WORKER_LEASE_REASON_CODES.NOT_LEASED]), state };
  }
  // A still-live lease belongs to a (possibly slow) worker — do not steal it.
  if (!isExpired(lease, nowMs)) {
    return { result: wfail('DENIED', [WORKER_LEASE_REASON_CODES.LEASE_LIVE]), state };
  }

  const decision = reconcile({
    finding,
    attempts: budget.attempts,
    maxAttempts: budget.maxAttempts,
    baseBackoffMs: budget.baseBackoffMs,
    maxBackoffMs: budget.maxBackoffMs,
  });

  switch (decision.action) {
    case 'CONFIRMED_DONE': {
      const { state: s, task: t } = setState(state, task.taskId, 'DONE');
      return { result: completed({ action: 'COMPLETED', task: t }, [], { workerLease: '1.0.0' }), state: s };
    }
    case 'CONFIRMED_NOT_DONE': {
      // Effect verified absent ⇒ safe to requeue (attempts preserved for retry cap).
      const { state: s, task: t } = setState(state, task.taskId, 'PENDING');
      return { result: completed({ action: 'REQUEUED', task: t }, [], { workerLease: '1.0.0' }), state: s };
    }
    case 'RECONCILE_AGAIN':
      // Unknown outcome, budget remains — probe again later, do NOT retry now.
      return {
        result: wfail('UNKNOWN_OUTCOME', [WORKER_LEASE_REASON_CODES.RECONCILE_AGAIN], decision.backoffMs),
        state,
      };
    case 'ESCALATE': {
      // Indeterminate outcome exhausted its budget ⇒ dead-letter for a human;
      // never guess done/not-done. The DEAD task stays in state for handling.
      const { state: s } = setState(state, task.taskId, 'DEAD');
      return {
        result: wfail('FAILED_FINAL', [WORKER_LEASE_REASON_CODES.ESCALATED, decision.reasonCode]),
        state: s,
      };
    }
  }
}
