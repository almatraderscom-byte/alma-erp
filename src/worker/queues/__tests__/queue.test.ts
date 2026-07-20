import { describe, it, expect } from 'vitest';
import { isSuccess, type ComponentRequest, type ExecutionIdentity } from '@/agent/contracts';
import {
  emptyQueueState,
  enqueue,
  dequeue,
  complete,
  depth,
  pendingFor,
  queueAuditEvent,
} from '../queue';
import { QUEUE_REASON_CODES, QUEUE_CONTRACT_VERSION, type EnqueuePayload, type TaskDomain } from '../contract';

const identity = (over: Partial<ExecutionIdentity> = {}): ExecutionIdentity => ({
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf',
  stepId: 's1',
  correlationId: 'corr-1',
  ...over,
});

const req = (payload: EnqueuePayload, id = identity()): ComponentRequest<EnqueuePayload> => ({
  identity: id,
  contractVersion: QUEUE_CONTRACT_VERSION,
  payload,
});

const task = (over: Partial<EnqueuePayload> = {}): EnqueuePayload => ({
  taskId: 't1',
  domain: 'orders',
  taskIdentity: identity(),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev:abc',
  idempotencyKey: 'idem-1',
  maxAttempts: 3,
  ...over,
});

describe('enqueue (SPEC-141)', () => {
  it('accepts a valid task and reports depth', () => {
    const { result, state } = enqueue(emptyQueueState(), req(task()));
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) expect(result.value).toMatchObject({ taskId: 't1', deduped: false, depth: 1 });
    expect(depth(state, 'orders')).toBe(1);
  });

  it('rejects malformed payload (fail-closed)', () => {
    const { result } = enqueue(emptyQueueState(), req({ ...task(), taskId: '' } as EnqueuePayload));
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.MALFORMED);
  });

  it('rejects unknown domain via schema', () => {
    const { result } = enqueue(emptyQueueState(), req({ ...task(), domain: 'nope' as TaskDomain }));
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.MALFORMED);
  });

  it('rejects out-of-range priority', () => {
    const { result } = enqueue(emptyQueueState(), req({ ...task(), priority: 99 }));
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.MALFORMED);
  });

  it('rejects a cross-tenant enqueue (INV-02)', () => {
    const r = req({ ...task(), taskIdentity: identity({ tenantId: 'other' }) }, identity({ tenantId: 'alma' }));
    const { result } = enqueue(emptyQueueState(), r);
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.status).toBe('DENIED');
      expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.CROSS_TENANT);
    }
  });

  it('rejects missing identity (fail-closed)', () => {
    const bad = { ...req(task()), identity: { ...identity(), actorId: '' } };
    const { result } = enqueue(emptyQueueState(), bad);
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.MISSING_IDENTITY);
  });

  it('dedupes a repeat idempotency key (replay-safe)', () => {
    const s1 = enqueue(emptyQueueState(), req(task()));
    const s2 = enqueue(s1.state, req({ ...task(), taskId: 't2' }));
    expect(isSuccess(s2.result)).toBe(true);
    if (isSuccess(s2.result)) expect(s2.result.value.deduped).toBe(true);
    expect(depth(s2.state, 'orders')).toBe(1);
  });
});

describe('dequeue (SPEC-141)', () => {
  it('pops FIFO and marks the task LEASED', () => {
    let s = emptyQueueState();
    s = enqueue(s, req(task({ taskId: 't1', idempotencyKey: 'a', enqueuedAtMs: 1000 }))).state;
    s = enqueue(s, req(task({ taskId: 't2', idempotencyKey: 'b', enqueuedAtMs: 2000 }))).state;
    const { result, state } = dequeue(s, { identity: identity(), contractVersion: QUEUE_CONTRACT_VERSION, payload: { domain: 'orders', nowMs: 3000 } });
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      expect(result.value.taskId).toBe('t1');
      expect(result.value.state).toBe('LEASED');
      expect(result.value.attempts).toBe(1);
    }
    expect(depth(state, 'orders')).toBe(1); // t2 still pending
  });

  it('returns RETRYABLE/EMPTY on an empty queue (fail-closed, no throw)', () => {
    const { result } = dequeue(emptyQueueState(), { identity: identity(), contractVersion: QUEUE_CONTRACT_VERSION, payload: { domain: 'cs', nowMs: 1 } });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) {
      expect(result.status).toBe('RETRYABLE');
      expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.EMPTY);
    }
  });

  it('never returns another tenant\'s task', () => {
    let s = emptyQueueState();
    s = enqueue(s, req(task({ taskIdentity: identity({ tenantId: 'alma' }) }), identity({ tenantId: 'alma' }))).state;
    const { result } = dequeue(s, { identity: identity({ tenantId: 'other' }), contractVersion: QUEUE_CONTRACT_VERSION, payload: { domain: 'orders', nowMs: 2000 } });
    expect(isSuccess(result)).toBe(false); // tenant 'other' sees an empty queue
  });

  it('rejects a dequeue with missing identity', () => {
    const { result } = dequeue(emptyQueueState(), { identity: { ...identity(), tenantId: '' }, contractVersion: QUEUE_CONTRACT_VERSION, payload: { domain: 'orders', nowMs: 1 } });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.MISSING_IDENTITY);
  });
});

describe('complete (SPEC-141)', () => {
  it('marks a task DONE and is idempotent', () => {
    const s = enqueue(emptyQueueState(), req(task())).state;
    const c1 = complete(s, { taskId: 't1', tenantId: 'alma' });
    expect(isSuccess(c1.result)).toBe(true);
    const c2 = complete(c1.state, { taskId: 't1', tenantId: 'alma' });
    expect(isSuccess(c2.result)).toBe(true);
  });

  it('returns NOT_FOUND for an unknown task', () => {
    const { result } = complete(emptyQueueState(), { taskId: 'zzz', tenantId: 'alma' });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(QUEUE_REASON_CODES.NOT_FOUND);
  });
});

describe('audit + selection helpers', () => {
  it('audit event carries identity ids and no payload', () => {
    const ev = queueAuditEvent('enqueue', identity(), 'orders', 't1', 'COMPLETED', [], 1234);
    expect(ev).toMatchObject({ component: 'domain-task-queue', tenantId: 'alma', correlationId: 'corr-1', domain: 'orders' });
    expect(JSON.stringify(ev)).not.toContain('ev:abc');
  });

  it('pendingFor is deterministic FIFO', () => {
    let s = emptyQueueState();
    s = enqueue(s, req(task({ taskId: 'b', idempotencyKey: 'b', enqueuedAtMs: 2000 }))).state;
    s = enqueue(s, req(task({ taskId: 'a', idempotencyKey: 'a', enqueuedAtMs: 1000 }))).state;
    expect(pendingFor(s, 'orders', 'alma').map((t) => t.taskId)).toEqual(['a', 'b']);
  });
});
