/**
 * Queue runtime chaos certification (G15 / SPEC-150, queue half).
 *
 * The red-team gate for the queue zone. It composes the WHOLE queue stack —
 * domain queues (141), tenant fairness (142), concurrency/backpressure (143),
 * priority/deadline (144), worker lease + crash recovery (145) — and injects the
 * failures a real system suffers, asserting each invariant holds by actually
 * DRIVING the stack (INV-10). Deterministic + self-contained (INV-01): every
 * timestamp / id / reconcile finding is a constant.
 */
import { isSuccess, type ComponentRequest, type ExecutionIdentity } from '@/agent/contracts';
import { acquireLease } from '@/agent/workflows/lease';
import { emptyQueueState, enqueue, dequeue } from './queue';
import { emptyFairnessState, scheduleFair } from './fairness';
import { admitDequeue, admitEnqueue, type ConcurrencyLimits } from './concurrency';
import { nextByPriorityStrict } from './scheduling';
import { recoverCrashedTask, type RecoveryBudget } from './worker-lease';
import { QUEUE_REASON_CODES, type EnqueuePayload, type QueueState, type QueueTask } from './contract';

const leasedTask = (taskId: string, tenantId: string): QueueTask => ({
  taskId,
  domain: 'orders',
  identity: id(tenantId),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev',
  idempotencyKey: taskId,
  attempts: 1,
  maxAttempts: 3,
  state: 'LEASED',
});

const id = (tenantId: string, actorId = 'w'): ExecutionIdentity => ({
  tenantId,
  actorId,
  workflowId: 'wf',
  stepId: 's',
  correlationId: `c-${tenantId}`,
});

const payload = (over: Partial<EnqueuePayload> & { taskId: string; tenantId: string }): EnqueuePayload => ({
  domain: 'orders',
  taskIdentity: id(over.tenantId),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev:' + over.taskId,
  idempotencyKey: over.taskId,
  maxAttempts: 3,
  ...over,
});

const req = (p: EnqueuePayload, tenantId = p.taskIdentity.tenantId): ComponentRequest<EnqueuePayload> => ({
  identity: id(tenantId),
  contractVersion: '1.0.0',
  payload: p,
});

const enq = (s: QueueState, p: EnqueuePayload, reqTenant?: string): QueueState =>
  enqueue(s, req(p, reqTenant)).state;

const limits: ConcurrencyLimits = { maxInFlightPerDomain: 1, maxInFlightPerTenant: 1, maxDepthPerDomain: 2, retryAfterMs: 100 };
const budget: RecoveryBudget = { attempts: 1, maxAttempts: 2, baseBackoffMs: 10, maxBackoffMs: 100 };

export interface ChaosResult {
  invariant: string;
  ok: boolean;
}

export function runQueueChaosSuite(): ChaosResult[] {
  const checks: Array<[string, () => boolean]> = [
    ['duplicate delivery enqueues the task only once', () => {
      let s = enq(emptyQueueState(), payload({ taskId: 't1', tenantId: 'a', idempotencyKey: 'k' }));
      s = enq(s, payload({ taskId: 't2', tenantId: 'a', idempotencyKey: 'k' }));
      return s.tasks.length === 1;
    }],
    ['cross-tenant enqueue is rejected', () => {
      const r = enqueue(emptyQueueState(), req(payload({ taskId: 't', tenantId: 'other' }), 'alma'));
      return !isSuccess(r.result) && r.result.reasonCodes.includes(QUEUE_REASON_CODES.CROSS_TENANT);
    }],
    ['dequeue on an empty queue is RETRYABLE (fail-closed, no throw)', () => {
      const r = dequeue(emptyQueueState(), { identity: id('a'), contractVersion: '1.0.0', payload: { domain: 'cs', nowMs: 1 } });
      return !isSuccess(r.result) && r.result.status === 'RETRYABLE';
    }],
    ['concurrency backpressures a second in-flight task at the domain cap', () => {
      const s: QueueState = { tasks: [leasedTask('x', 'a')] };
      const r = admitDequeue(s, { domain: 'orders', tenantId: 'b', limits });
      return !isSuccess(r) && r.reasonCodes.includes('C_BACKPRESSURE_DOMAIN');
    }],
    ['enqueue is refused at the depth ceiling (QUEUE_FULL)', () => {
      let s = enq(emptyQueueState(), payload({ taskId: 'q1', tenantId: 'a', idempotencyKey: 'q1' }));
      s = enq(s, payload({ taskId: 'q2', tenantId: 'a', idempotencyKey: 'q2' }));
      const r = admitEnqueue(s, { domain: 'orders', limits });
      return !isSuccess(r) && r.reasonCodes.includes('C_QUEUE_FULL');
    }],
    ['fairness serves two tenants in turn (no starvation)', () => {
      let s = emptyQueueState();
      s = enq(s, payload({ taskId: 'a1', tenantId: 'a', idempotencyKey: 'a1', enqueuedAtMs: 1000 }));
      s = enq(s, payload({ taskId: 'a2', tenantId: 'a', idempotencyKey: 'a2', enqueuedAtMs: 1001 }));
      s = enq(s, payload({ taskId: 'b1', tenantId: 'b', idempotencyKey: 'b1', enqueuedAtMs: 1000 }));
      let f = emptyFairnessState();
      const served: string[] = [];
      for (let i = 0; i < 2; i++) {
        const r = scheduleFair(s, f, { domain: 'orders', actorId: 'w', weights: {}, nowMs: 2000 + i });
        if (isSuccess(r.result)) served.push(r.result.value.identity.tenantId);
        s = r.state;
        f = r.fairness;
      }
      return served[0] === 'a' && served[1] === 'b'; // b not starved behind a's backlog
    }],
    ['strict scheduling denies a past-deadline head (stale work escalated)', () => {
      let s = enq(emptyQueueState(), payload({ taskId: 'd', tenantId: 'a', deadlineMs: 100 }));
      const r = nextByPriorityStrict(s, { domain: 'orders', tenantId: 'a', nowMs: 500 });
      return !isSuccess(r) && r.reasonCodes.includes('D_DEADLINE_MISSED');
    }],
    ['crash + unknown outcome reconciles, never blind-retries', () => {
      const task = { taskId: 'c', domain: 'orders' as const, identity: id('a'), priority: 5, enqueuedAtMs: 1000, payloadRef: 'ev', idempotencyKey: 'c', attempts: 1, maxAttempts: 3, state: 'LEASED' as const };
      const lease = acquireLease(null, { instanceId: 'wf', stepId: 'c', workerId: 'w1', nowMs: 0, ttlMs: 100 });
      if (!lease.ok) return false;
      const r = recoverCrashedTask({ tasks: [task] }, { task, lease: lease.lease, finding: 'indeterminate', budget, nowMs: 500 });
      // unknown outcome ⇒ UNKNOWN_OUTCOME, task stays LEASED (not requeued)
      return !isSuccess(r.result) && r.result.status === 'UNKNOWN_OUTCOME' && r.state.tasks[0].state === 'LEASED';
    }],
    ['crash + verified effect-absent requeues safely', () => {
      const task = { taskId: 'c', domain: 'orders' as const, identity: id('a'), priority: 5, enqueuedAtMs: 1000, payloadRef: 'ev', idempotencyKey: 'c', attempts: 1, maxAttempts: 3, state: 'LEASED' as const };
      const lease = acquireLease(null, { instanceId: 'wf', stepId: 'c', workerId: 'w1', nowMs: 0, ttlMs: 100 });
      if (!lease.ok) return false;
      const r = recoverCrashedTask({ tasks: [task] }, { task, lease: lease.lease, finding: 'effect_absent', budget, nowMs: 500 });
      return isSuccess(r.result) && r.state.tasks[0].state === 'PENDING';
    }],
    ['crash + exhausted indeterminate is dead-lettered (never guessed)', () => {
      const task = { taskId: 'c', domain: 'orders' as const, identity: id('a'), priority: 5, enqueuedAtMs: 1000, payloadRef: 'ev', idempotencyKey: 'c', attempts: 2, maxAttempts: 2, state: 'LEASED' as const };
      const lease = acquireLease(null, { instanceId: 'wf', stepId: 'c', workerId: 'w1', nowMs: 0, ttlMs: 100 });
      if (!lease.ok) return false;
      const exhausted: RecoveryBudget = { attempts: 2, maxAttempts: 2, baseBackoffMs: 10, maxBackoffMs: 100 };
      const r = recoverCrashedTask({ tasks: [task] }, { task, lease: lease.lease, finding: 'indeterminate', budget: exhausted, nowMs: 500 });
      return !isSuccess(r.result) && r.state.tasks[0].state === 'DEAD';
    }],
  ];
  return checks.map(([invariant, run]) => {
    let ok = false;
    try {
      ok = run();
    } catch {
      ok = false;
    }
    return { invariant, ok };
  });
}
