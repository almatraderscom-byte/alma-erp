/**
 * Domain task queues — deterministic core (G15 / SPEC-141).
 *
 * Pure, event-sourced enqueue/dequeue over an immutable `QueueState`. No clock,
 * RNG, DB or network — `nowMs` and ids are injected (INV-01). Every authoritative
 * op returns a G01 `ComponentResult`; failures carry finite reason codes and are
 * fail-closed (INV-05). Identity is mandatory and cross-tenant enqueues/dequeues
 * are rejected (INV-02). Duplicate idempotency keys dedupe rather than double-
 * insert (replay-safe, seeds INV-06).
 */
import {
  allowed,
  completed,
  type ComponentFailure,
  type FailureStatus,
  type ComponentRequest,
  type ExecutionIdentity,
} from '@/agent/contracts';
import {
  QUEUE_REASON_CODES,
  MAX_PRIORITY,
  MIN_PRIORITY,
  enqueuePayloadSchema,
  emptyQueueState,
  type EnqueueAck,
  type EnqueuePayload,
  type QueueAuditEvent,
  type QueueOp,
  type QueueState,
  type QueueTask,
  type TaskDomain,
} from './contract';

/**
 * Build a typed failure with queue-specific (string) reason codes. The shared
 * `failure()` helper narrows to the closed G01 `ReasonCode` union; queue codes
 * live in their own namespace, so we construct the union member directly — still
 * the exact `ComponentFailure` shape (no boolean, no throw across the boundary).
 */
function qFailure(status: FailureStatus, reasonCodes: string[], retryAfterMs?: number): ComponentFailure {
  return {
    status,
    reasonCodes,
    evidenceIds: [],
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Count pending tasks for a domain (optionally scoped to a tenant). */
export function depth(state: QueueState, domain: TaskDomain, tenantId?: string): number {
  return state.tasks.filter(
    (t) =>
      t.domain === domain &&
      t.state === 'PENDING' &&
      (tenantId === undefined || t.identity.tenantId === tenantId),
  ).length;
}

/** Pending tasks for (domain, tenant) in FIFO order (stable by enqueuedAtMs, then taskId). */
export function pendingFor(state: QueueState, domain: TaskDomain, tenantId: string): QueueTask[] {
  return state.tasks
    .filter((t) => t.domain === domain && t.state === 'PENDING' && t.identity.tenantId === tenantId)
    .slice()
    .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}

function fail<T>(state: QueueState, f: ComponentFailure): QueueOp<T> {
  return { result: f, state };
}

/**
 * Enqueue a task. Fail-closed on malformed payload, unknown domain, out-of-range
 * priority, or a cross-tenant attempt (the request identity's tenant must own the
 * task). A repeat idempotency key returns COMPLETED with `deduped: true` and does
 * NOT insert a second task.
 */
export function enqueue(
  state: QueueState,
  request: ComponentRequest<EnqueuePayload>,
): QueueOp<EnqueueAck> {
  const parsed = enqueuePayloadSchema.safeParse(request.payload);
  if (!parsed.success) {
    return fail(state, qFailure('FAILED_FINAL', [QUEUE_REASON_CODES.MALFORMED]));
  }
  const p = parsed.data;

  // Identity present on the request (INV-02) — a queue op is authoritative.
  if (!request.identity || !request.identity.tenantId || !request.identity.actorId) {
    return fail(state, qFailure('DENIED', [QUEUE_REASON_CODES.MISSING_IDENTITY]));
  }

  // Cross-tenant guard (INV-02): the request cannot enqueue for another tenant.
  if (p.taskIdentity.tenantId !== request.identity.tenantId) {
    return fail(state, qFailure('DENIED', [QUEUE_REASON_CODES.CROSS_TENANT]));
  }

  if (p.priority < MIN_PRIORITY || p.priority > MAX_PRIORITY) {
    return fail(state, qFailure('FAILED_FINAL', [QUEUE_REASON_CODES.BAD_PRIORITY]));
  }

  // Idempotent replay: an identical key already present ⇒ dedupe (never double).
  const existing = state.tasks.find(
    (t) => t.idempotencyKey === p.idempotencyKey && t.identity.tenantId === p.taskIdentity.tenantId,
  );
  if (existing) {
    return {
      result: completed(
        { taskId: existing.taskId, domain: existing.domain, deduped: true, depth: depth(state, existing.domain, p.taskIdentity.tenantId) },
        [],
        { queue: '1.0.0' },
      ),
      state,
    };
  }

  const task: QueueTask = {
    taskId: p.taskId,
    domain: p.domain,
    identity: p.taskIdentity,
    priority: p.priority,
    ...(p.deadlineMs !== undefined ? { deadlineMs: p.deadlineMs } : {}),
    enqueuedAtMs: p.enqueuedAtMs,
    payloadRef: p.payloadRef,
    idempotencyKey: p.idempotencyKey,
    attempts: 0,
    maxAttempts: p.maxAttempts,
    state: 'PENDING',
  };
  const next: QueueState = { tasks: [...state.tasks, task] };
  return {
    result: completed(
      { taskId: task.taskId, domain: task.domain, deduped: false, depth: depth(next, task.domain, p.taskIdentity.tenantId) },
      [],
      { queue: '1.0.0' },
    ),
    state: next,
  };
}

/**
 * Dequeue the next FIFO pending task for (domain, tenant), marking it LEASED.
 * Requires a tenant on the request (INV-02) — a dequeue never crosses tenants.
 * Empty queue ⇒ RETRYABLE with EMPTY reason (fail-closed, not an exception).
 */
export function dequeue(
  state: QueueState,
  request: ComponentRequest<{ domain: TaskDomain; nowMs: number }>,
): QueueOp<QueueTask> {
  const id = request.identity;
  if (!id || !id.tenantId || !id.actorId) {
    return fail(state, qFailure('DENIED', [QUEUE_REASON_CODES.MISSING_IDENTITY]));
  }
  const { domain } = request.payload;
  const queue = pendingFor(state, domain, id.tenantId);
  const head = queue[0];
  if (!head) {
    return fail(state, qFailure('RETRYABLE', [QUEUE_REASON_CODES.EMPTY]));
  }
  const leased: QueueTask = { ...head, state: 'LEASED', attempts: head.attempts + 1 };
  const next: QueueState = {
    tasks: state.tasks.map((t) => (t.taskId === head.taskId ? leased : t)),
  };
  return { result: allowed(leased, [], { queue: '1.0.0' }), state: next };
}

/** Mark a leased task DONE (idempotent: a DONE task stays DONE). */
export function complete(
  state: QueueState,
  args: { taskId: string; tenantId: string },
): QueueOp<QueueTask> {
  const task = state.tasks.find((t) => t.taskId === args.taskId && t.identity.tenantId === args.tenantId);
  if (!task) return fail(state, qFailure('FAILED_FINAL', [QUEUE_REASON_CODES.NOT_FOUND]));
  if (task.state === 'DONE') return { result: completed(task, [], { queue: '1.0.0' }), state };
  const done: QueueTask = { ...task, state: 'DONE' };
  return {
    result: completed(done, [], { queue: '1.0.0' }),
    state: { tasks: state.tasks.map((t) => (t.taskId === task.taskId ? done : t)) },
  };
}

/** Build a deterministic audit event for a queue op (identity ids only). */
export function queueAuditEvent(
  op: QueueAuditEvent['op'],
  identity: ExecutionIdentity,
  domain: TaskDomain,
  taskId: string,
  status: string,
  reasonCodes: string[],
  observedAtMs: number,
): QueueAuditEvent {
  return {
    component: 'domain-task-queue',
    op,
    tenantId: identity.tenantId,
    correlationId: identity.correlationId,
    domain,
    taskId,
    status,
    reasonCodes,
    observedAtMs,
  };
}

export { emptyQueueState };
