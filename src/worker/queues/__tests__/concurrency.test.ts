import { describe, it, expect } from 'vitest';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import { emptyQueueState } from '../queue';
import {
  inFlight,
  admitDequeue,
  admitEnqueue,
  CONCURRENCY_REASON_CODES,
  type ConcurrencyLimits,
} from '../concurrency';
import type { QueueState, QueueTask } from '../contract';

const id = (tenantId: string): ExecutionIdentity => ({
  tenantId,
  actorId: 'w',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const mk = (taskId: string, tenantId: string, state: QueueTask['state']): QueueTask => ({
  taskId,
  domain: 'orders',
  identity: id(tenantId),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev',
  idempotencyKey: taskId,
  attempts: state === 'LEASED' ? 1 : 0,
  maxAttempts: 3,
  state,
});

const withTasks = (...tasks: QueueTask[]): QueueState => ({ tasks });

const limits: ConcurrencyLimits = {
  maxInFlightPerDomain: 2,
  maxInFlightPerTenant: 1,
  maxDepthPerDomain: 3,
  retryAfterMs: 500,
};

describe('inFlight (SPEC-143)', () => {
  it('counts LEASED tasks by domain and tenant', () => {
    const s = withTasks(mk('a', 't1', 'LEASED'), mk('b', 't2', 'LEASED'), mk('c', 't1', 'PENDING'));
    expect(inFlight(s, 'orders')).toBe(2);
    expect(inFlight(s, 'orders', 't1')).toBe(1);
  });
});

describe('admitDequeue (SPEC-143)', () => {
  it('admits when there is headroom', () => {
    const r = admitDequeue(emptyQueueState(), { domain: 'orders', tenantId: 't1', limits });
    expect(isSuccess(r)).toBe(true);
  });

  it('backpressures at the domain in-flight cap', () => {
    const s = withTasks(mk('a', 't1', 'LEASED'), mk('b', 't2', 'LEASED'));
    const r = admitDequeue(s, { domain: 'orders', tenantId: 't3', limits });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) {
      expect(r.status).toBe('RETRYABLE');
      expect(r.reasonCodes).toContain(CONCURRENCY_REASON_CODES.BACKPRESSURE_DOMAIN);
      expect(r.retryAfterMs).toBe(500);
    }
  });

  it('backpressures at the per-tenant in-flight cap', () => {
    const s = withTasks(mk('a', 't1', 'LEASED'));
    const r = admitDequeue(s, { domain: 'orders', tenantId: 't1', limits });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(CONCURRENCY_REASON_CODES.BACKPRESSURE_TENANT);
  });

  it('rejects malformed limits (fail-closed)', () => {
    const r = admitDequeue(emptyQueueState(), { domain: 'orders', tenantId: 't1', limits: { ...limits, maxInFlightPerDomain: 0 } });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(CONCURRENCY_REASON_CODES.MALFORMED);
  });

  it('rejects missing tenant (fail-closed)', () => {
    const r = admitDequeue(emptyQueueState(), { domain: 'orders', tenantId: '', limits });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(CONCURRENCY_REASON_CODES.MALFORMED);
  });
});

describe('admitEnqueue (SPEC-143)', () => {
  it('admits below the depth ceiling', () => {
    const s = withTasks(mk('a', 't1', 'PENDING'), mk('b', 't1', 'PENDING'));
    const r = admitEnqueue(s, { domain: 'orders', limits });
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) expect(r.value.depth).toBe(2);
  });

  it('refuses at the depth ceiling (QUEUE_FULL) with retry hint', () => {
    const s = withTasks(mk('a', 't1', 'PENDING'), mk('b', 't1', 'PENDING'), mk('c', 't2', 'PENDING'));
    const r = admitEnqueue(s, { domain: 'orders', limits });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) {
      expect(r.reasonCodes).toContain(CONCURRENCY_REASON_CODES.QUEUE_FULL);
      expect(r.retryAfterMs).toBe(500);
    }
  });
});
