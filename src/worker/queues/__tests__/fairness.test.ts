import { describe, it, expect } from 'vitest';
import { isSuccess, type ComponentRequest, type ExecutionIdentity } from '@/agent/contracts';
import { emptyQueueState, enqueue } from '../queue';
import {
  emptyFairnessState,
  pickFairTenant,
  scheduleFair,
  weightOf,
  FAIRNESS_REASON_CODES,
} from '../fairness';
import { QUEUE_CONTRACT_VERSION, type EnqueuePayload, type QueueState } from '../contract';

const id = (tenantId: string): ExecutionIdentity => ({
  tenantId,
  actorId: 'sched',
  workflowId: 'wf',
  stepId: 's',
  correlationId: `c-${tenantId}`,
});

const enq = (state: QueueState, tenantId: string, taskId: string, atMs: number): QueueState => {
  const payload: EnqueuePayload = {
    taskId,
    domain: 'orders',
    taskIdentity: id(tenantId),
    priority: 5,
    enqueuedAtMs: atMs,
    payloadRef: 'ev:' + taskId,
    idempotencyKey: taskId,
    maxAttempts: 3,
  };
  const req: ComponentRequest<EnqueuePayload> = { identity: id(tenantId), contractVersion: QUEUE_CONTRACT_VERSION, payload };
  return enqueue(state, req).state;
};

describe('pickFairTenant (SPEC-142)', () => {
  it('returns null when no pending work', () => {
    expect(pickFairTenant(emptyQueueState(), emptyFairnessState(), 'orders', {})).toBeNull();
  });

  it('picks the least-served tenant, tie-broken by ascending id', () => {
    let s = emptyQueueState();
    s = enq(s, 'b', 'b1', 1000);
    s = enq(s, 'a', 'a1', 1000);
    // equal service ⇒ ascending id wins
    expect(pickFairTenant(s, emptyFairnessState(), 'orders', {})).toBe('a');
    // a already served once ⇒ b is now the min deficit
    const f = { served: { a: 1 } };
    expect(pickFairTenant(s, f, 'orders', {})).toBe('b');
  });

  it('weights favour the higher-weight tenant', () => {
    let s = emptyQueueState();
    s = enq(s, 'big', 'x', 1000);
    s = enq(s, 'small', 'y', 1000);
    // big served 2, small served 1; big weight 4 ⇒ deficit 0.5 < small 1 ⇒ big picked
    const f = { served: { big: 2, small: 1 } };
    expect(pickFairTenant(s, f, 'orders', { big: 4, small: 1 })).toBe('big');
  });
});

describe('scheduleFair (SPEC-142)', () => {
  it('serves tenants round-robin under equal weight', () => {
    let s = emptyQueueState();
    s = enq(s, 'a', 'a1', 1000);
    s = enq(s, 'a', 'a2', 1001);
    s = enq(s, 'b', 'b1', 1000);
    let f = emptyFairnessState();
    const served: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = scheduleFair(s, f, { domain: 'orders', actorId: 'sched', weights: {}, nowMs: 2000 + i });
      expect(isSuccess(r.result)).toBe(true);
      if (isSuccess(r.result)) served.push(r.result.value.identity.tenantId);
      s = r.state;
      f = r.fairness;
    }
    // a, b, a — b (1 task) served before a's second, then a's remaining
    expect(served).toEqual(['a', 'b', 'a']);
  });

  it('returns a task belonging only to the picked tenant (no cross-tenant leak)', () => {
    let s = emptyQueueState();
    s = enq(s, 'a', 'a1', 1000);
    s = enq(s, 'b', 'b1', 1000);
    const r = scheduleFair(s, emptyFairnessState(), { domain: 'orders', actorId: 'sched', weights: {}, nowMs: 2000 });
    expect(isSuccess(r.result)).toBe(true);
    if (isSuccess(r.result)) expect(r.result.value.identity.tenantId).toBe('a');
  });

  it('fail-closed on no pending work', () => {
    const r = scheduleFair(emptyQueueState(), emptyFairnessState(), { domain: 'cs', actorId: 'sched', weights: {}, nowMs: 1 });
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) {
      expect(r.result.status).toBe('RETRYABLE');
      expect(r.result.reasonCodes).toContain(FAIRNESS_REASON_CODES.NO_PENDING);
    }
  });

  it('rejects a non-positive weight (fail-closed)', () => {
    let s = enq(emptyQueueState(), 'a', 'a1', 1000);
    const r = scheduleFair(s, emptyFairnessState(), { domain: 'orders', actorId: 'sched', weights: { a: 0 }, nowMs: 2000 });
    expect(isSuccess(r.result)).toBe(false);
    if (!isSuccess(r.result)) expect(r.result.reasonCodes).toContain(FAIRNESS_REASON_CODES.NON_POSITIVE_WEIGHT);
  });
});

describe('weightOf', () => {
  it('defaults absent tenant to weight 1', () => {
    expect(weightOf({}, 'x')).toBe(1);
    expect(weightOf({ x: 3 }, 'x')).toBe(3);
  });
});
