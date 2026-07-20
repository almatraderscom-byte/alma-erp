/**
 * Priority and deadline scheduling (G15 / SPEC-144).
 *
 * SPEC-141 records `priority` (0..9) and an optional `deadlineMs` on every task
 * but dequeues strict FIFO. This module orders pending work by a total,
 * deterministic comparator:
 *
 *    priority DESC  →  earliest deadline first (EDF)  →  FIFO (enqueuedAt)  →  taskId
 *
 * so the most important, most urgent task runs next, and ties never depend on map
 * iteration order. It also detects deadline MISSES (a pending task whose deadline
 * is already in the past) so the runtime can escalate stale work rather than run
 * it silently.
 *
 * Pure + deterministic (INV-01): `nowMs` injected, no clock/RNG/IO. Selection is
 * tenant-scoped (INV-02). Fail-closed (INV-05): no pending work ⇒ RETRYABLE.
 * Returns G01 `ComponentResult`; overdue status is surfaced, never hidden.
 */
import { allowed, type ComponentFailure, type ComponentResult, type FailureStatus } from '@/agent/contracts';
import type { QueueState, QueueTask, TaskDomain } from './contract';

export const SCHEDULING_REASON_CODES = {
  EMPTY: 'D_EMPTY',
  MALFORMED: 'D_MALFORMED',
  DEADLINE_MISSED: 'D_DEADLINE_MISSED',
} as const;
export type SchedulingReasonCode =
  (typeof SCHEDULING_REASON_CODES)[keyof typeof SCHEDULING_REASON_CODES];

function dfail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

const deadlineKey = (t: QueueTask): number => (t.deadlineMs === undefined ? Number.POSITIVE_INFINITY : t.deadlineMs);

/**
 * Total deterministic order: higher priority first, then earliest deadline, then
 * earliest enqueue, then taskId. Returns <0 if `a` should run before `b`.
 */
export function compareTasks(a: QueueTask, b: QueueTask): number {
  if (a.priority !== b.priority) return b.priority - a.priority; // higher priority first
  const da = deadlineKey(a);
  const db = deadlineKey(b);
  if (da !== db) return da - db; // earliest deadline first
  if (a.enqueuedAtMs !== b.enqueuedAtMs) return a.enqueuedAtMs - b.enqueuedAtMs; // FIFO
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** Pending tasks for (domain, tenant) in priority→EDF→FIFO order. */
export function prioritizedFor(state: QueueState, domain: TaskDomain, tenantId: string): QueueTask[] {
  return state.tasks
    .filter((t) => t.domain === domain && t.state === 'PENDING' && t.identity.tenantId === tenantId)
    .slice()
    .sort(compareTasks);
}

/** True iff a task has a deadline already in the past at `nowMs`. */
export function isOverdue(task: QueueTask, nowMs: number): boolean {
  return task.deadlineMs !== undefined && task.deadlineMs < nowMs;
}

/** All pending, past-deadline tasks in a domain (for escalation/monitoring). */
export function overdueTasks(state: QueueState, domain: TaskDomain, nowMs: number): QueueTask[] {
  return state.tasks
    .filter((t) => t.domain === domain && t.state === 'PENDING' && isOverdue(t, nowMs))
    .slice()
    .sort(compareTasks);
}

/**
 * Select the next task by priority/EDF for (domain, tenant). Returns the chosen
 * task and whether it is already overdue (surfaced, not hidden). Fail-closed:
 * no pending work ⇒ RETRYABLE / EMPTY; a non-integer `nowMs` ⇒ FAILED_FINAL.
 */
export function nextByPriority(
  state: QueueState,
  args: { domain: TaskDomain; tenantId: string; nowMs: number },
): ComponentResult<{ task: QueueTask; overdue: boolean }> {
  const { domain, tenantId, nowMs } = args;
  if (!Number.isInteger(nowMs) || nowMs < 0 || !tenantId) {
    return dfail('FAILED_FINAL', [SCHEDULING_REASON_CODES.MALFORMED]);
  }
  const head = prioritizedFor(state, domain, tenantId)[0];
  if (!head) return dfail('RETRYABLE', [SCHEDULING_REASON_CODES.EMPTY]);
  return allowed({ task: head, overdue: isOverdue(head, nowMs) }, [], { scheduling: '1.0.0' });
}

/**
 * Strict variant: if the highest-priority task is already past its deadline, DENY
 * with DEADLINE_MISSED (for callers that must not execute stale work and instead
 * escalate). Otherwise identical to `nextByPriority`.
 */
export function nextByPriorityStrict(
  state: QueueState,
  args: { domain: TaskDomain; tenantId: string; nowMs: number },
): ComponentResult<{ task: QueueTask; overdue: false }> {
  const r = nextByPriority(state, args);
  if (r.status !== 'ALLOWED') return r as ComponentFailure;
  if (r.value.overdue) return dfail('DENIED', [SCHEDULING_REASON_CODES.DEADLINE_MISSED]);
  return allowed({ task: r.value.task, overdue: false }, [], { scheduling: '1.0.0' });
}
