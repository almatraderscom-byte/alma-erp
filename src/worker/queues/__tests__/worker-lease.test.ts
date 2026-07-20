import { describe, it, expect } from 'vitest';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import { acquireLease, type StepLease } from '@/agent/workflows/lease';
import { recoverCrashedTask, WORKER_LEASE_REASON_CODES, type RecoveryBudget } from '../worker-lease';
import type { QueueState, QueueTask } from '../contract';

const id = (tenantId = 't1'): ExecutionIdentity => ({
  tenantId,
  actorId: 'w',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const mk = (state: QueueTask['state']): QueueTask => ({
  taskId: 'task-1',
  domain: 'orders',
  identity: id(),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev',
  idempotencyKey: 'task-1',
  attempts: 1,
  maxAttempts: 3,
  state,
});

const withTask = (t: QueueTask): QueueState => ({ tasks: [t] });

const lease = (nowMs: number, ttlMs: number): StepLease => {
  const r = acquireLease(null, { instanceId: 'wf', stepId: 'task-1', workerId: 'worker-A', nowMs, ttlMs });
  if (!r.ok) throw new Error('lease setup failed');
  return r.lease;
};

const budget: RecoveryBudget = { attempts: 1, maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 };

describe('recoverCrashedTask (SPEC-145)', () => {
  it('effect_present ⇒ task marked DONE (no re-run)', () => {
    const t = mk('LEASED');
    const { result, state } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'effect_present', budget, nowMs: 200 });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value.action).toBe('COMPLETED');
    expect(state.tasks[0].state).toBe('DONE');
  });

  it('effect_absent ⇒ task requeued PENDING (safe retry)', () => {
    const t = mk('LEASED');
    const { result, state } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'effect_absent', budget, nowMs: 200 });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value.action).toBe('REQUEUED');
    expect(state.tasks[0].state).toBe('PENDING');
    expect(state.tasks[0].attempts).toBe(1); // preserved, not reset
  });

  it('indeterminate with budget left ⇒ UNKNOWN_OUTCOME, never blind-retry', () => {
    const t = mk('LEASED');
    const { result, state } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'indeterminate', budget, nowMs: 200 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.status).toBe('UNKNOWN_OUTCOME');
      expect(result.reasonCodes).toContain(WORKER_LEASE_REASON_CODES.RECONCILE_AGAIN);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
    expect(state.tasks[0].state).toBe('LEASED'); // unchanged — no blind requeue
  });

  it('indeterminate exhausted ⇒ dead-lettered (DEAD), escalated', () => {
    const t = mk('LEASED');
    const exhausted: RecoveryBudget = { ...budget, attempts: 3, maxAttempts: 3 };
    const { result, state } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'indeterminate', budget: exhausted, nowMs: 200 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.status).toBe('FAILED_FINAL');
      expect(result.reasonCodes).toContain(WORKER_LEASE_REASON_CODES.ESCALATED);
    }
    expect(state.tasks[0].state).toBe('DEAD');
  });

  it('refuses to recover a still-LIVE lease (fail-closed)', () => {
    const t = mk('LEASED');
    const { result, state } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 1000), finding: 'effect_absent', budget, nowMs: 200 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(WORKER_LEASE_REASON_CODES.LEASE_LIVE);
    expect(state.tasks[0].state).toBe('LEASED');
  });

  it('refuses a task that is not LEASED', () => {
    const t = mk('PENDING');
    const { result } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'effect_absent', budget, nowMs: 200 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(WORKER_LEASE_REASON_CODES.NOT_LEASED);
  });

  it('rejects malformed nowMs (fail-closed)', () => {
    const t = mk('LEASED');
    const { result } = recoverCrashedTask(withTask(t), { task: t, lease: lease(0, 100), finding: 'effect_absent', budget, nowMs: -5 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(WORKER_LEASE_REASON_CODES.MALFORMED);
  });
});
