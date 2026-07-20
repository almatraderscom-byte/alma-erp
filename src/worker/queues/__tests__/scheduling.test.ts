import { describe, it, expect } from 'vitest';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import {
  compareTasks,
  prioritizedFor,
  isOverdue,
  overdueTasks,
  nextByPriority,
  nextByPriorityStrict,
  SCHEDULING_REASON_CODES,
} from '../scheduling';
import type { QueueState, QueueTask } from '../contract';

const id = (tenantId = 't1'): ExecutionIdentity => ({
  tenantId,
  actorId: 'w',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const mk = (o: Partial<QueueTask> & { taskId: string }): QueueTask => ({
  domain: 'orders',
  identity: id(),
  priority: 5,
  enqueuedAtMs: 1000,
  payloadRef: 'ev',
  idempotencyKey: o.taskId,
  attempts: 0,
  maxAttempts: 3,
  state: 'PENDING',
  ...o,
});

const withTasks = (...tasks: QueueTask[]): QueueState => ({ tasks });

describe('compareTasks (SPEC-144)', () => {
  it('orders by priority desc, then EDF, then FIFO, then id', () => {
    const hi = mk({ taskId: 'hi', priority: 9 });
    const lo = mk({ taskId: 'lo', priority: 1 });
    expect(compareTasks(hi, lo)).toBeLessThan(0);

    const early = mk({ taskId: 'early', priority: 5, deadlineMs: 100 });
    const late = mk({ taskId: 'late', priority: 5, deadlineMs: 200 });
    expect(compareTasks(early, late)).toBeLessThan(0);

    const noDeadline = mk({ taskId: 'nd', priority: 5 });
    expect(compareTasks(early, noDeadline)).toBeLessThan(0); // deadline beats no-deadline
  });
});

describe('prioritizedFor (SPEC-144)', () => {
  it('returns a deterministic priority/EDF/FIFO order', () => {
    const s = withTasks(
      mk({ taskId: 'a', priority: 5, enqueuedAtMs: 2000 }),
      mk({ taskId: 'b', priority: 9, enqueuedAtMs: 3000 }),
      mk({ taskId: 'c', priority: 5, deadlineMs: 500, enqueuedAtMs: 1500 }),
    );
    expect(prioritizedFor(s, 'orders', 't1').map((t) => t.taskId)).toEqual(['b', 'c', 'a']);
  });

  it('is tenant-scoped', () => {
    const s = withTasks(mk({ taskId: 'a', identity: id('t1') }), mk({ taskId: 'b', identity: id('t2') }));
    expect(prioritizedFor(s, 'orders', 't1').map((t) => t.taskId)).toEqual(['a']);
  });
});

describe('overdue detection (SPEC-144)', () => {
  it('isOverdue true only for past deadlines', () => {
    expect(isOverdue(mk({ taskId: 'x', deadlineMs: 100 }), 200)).toBe(true);
    expect(isOverdue(mk({ taskId: 'y', deadlineMs: 300 }), 200)).toBe(false);
    expect(isOverdue(mk({ taskId: 'z' }), 200)).toBe(false);
  });

  it('overdueTasks lists past-deadline pending tasks', () => {
    const s = withTasks(
      mk({ taskId: 'stale', deadlineMs: 100 }),
      mk({ taskId: 'fresh', deadlineMs: 500 }),
      mk({ taskId: 'done', deadlineMs: 100, state: 'DONE' }),
    );
    expect(overdueTasks(s, 'orders', 300).map((t) => t.taskId)).toEqual(['stale']);
  });
});

describe('nextByPriority (SPEC-144)', () => {
  it('selects the head and surfaces overdue', () => {
    const s = withTasks(mk({ taskId: 'a', priority: 9, deadlineMs: 100 }));
    const r = nextByPriority(s, { domain: 'orders', tenantId: 't1', nowMs: 300 });
    expect(isSuccess(r)).toBe(true);
    if (isSuccess(r)) {
      expect(r.value.task.taskId).toBe('a');
      expect(r.value.overdue).toBe(true);
    }
  });

  it('fail-closed on empty', () => {
    const r = nextByPriority(withTasks(), { domain: 'cs', tenantId: 't1', nowMs: 1 });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(SCHEDULING_REASON_CODES.EMPTY);
  });

  it('fail-closed on malformed nowMs', () => {
    const r = nextByPriority(withTasks(mk({ taskId: 'a' })), { domain: 'orders', tenantId: 't1', nowMs: -1 });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(SCHEDULING_REASON_CODES.MALFORMED);
  });
});

describe('nextByPriorityStrict (SPEC-144)', () => {
  it('denies a past-deadline head', () => {
    const s = withTasks(mk({ taskId: 'a', deadlineMs: 100 }));
    const r = nextByPriorityStrict(s, { domain: 'orders', tenantId: 't1', nowMs: 300 });
    expect(isSuccess(r)).toBe(false);
    if (!isSuccess(r)) {
      expect(r.status).toBe('DENIED');
      expect(r.reasonCodes).toContain(SCHEDULING_REASON_CODES.DEADLINE_MISSED);
    }
  });

  it('allows a fresh head', () => {
    const s = withTasks(mk({ taskId: 'a', deadlineMs: 500 }));
    const r = nextByPriorityStrict(s, { domain: 'orders', tenantId: 't1', nowMs: 300 });
    expect(isSuccess(r)).toBe(true);
  });
});
