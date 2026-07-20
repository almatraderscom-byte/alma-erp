/**
 * Domain task queues — contract (G15 / SPEC-141).
 *
 * The typed boundary for enqueuing and dequeuing agent work onto per-domain
 * queues (orders, staff/ops, cs, research, marketing, finance, browser). This is
 * the shared vocabulary for the whole G15 queue runtime: fairness (142),
 * concurrency/backpressure (143), priority/deadline (144) and worker lease (145)
 * all schedule over the `QueueTask` shape defined here.
 *
 * Design rules (GLOBAL_AGENT_CONTRACT + G15 invariants):
 *  - INV-01 deterministic: NO clock / RNG / DB / network / LLM. `nowMs` and ids
 *    are injected; state is an immutable value transformed by pure functions.
 *  - INV-02 identity: every task carries a full ExecutionIdentity.
 *  - INV-05 fail-closed: missing identity / unknown domain / oversize ⇒ reject.
 *  - INV-07 bounded views: a task holds a `payloadRef` (evidence pointer), never
 *    the full provider/tool payload — the heavy body stays in evidence storage.
 *  - Every boundary returns the G01 `ComponentResult` union; never a bare boolean
 *    and never a thrown error across the boundary.
 */
import { z } from 'zod';
import {
  REASON_CODES,
  executionIdentitySchema,
  type ComponentResult,
  type ExecutionIdentity,
} from '@/agent/contracts';

/** Contract version stamped onto queue results. */
export const QUEUE_CONTRACT_VERSION = '1.0.0' as const;

/**
 * The finite set of business domains that get their own logical queue. Closed
 * set (fail-closed): an unknown domain is rejected, never silently created.
 */
export const TASK_DOMAINS = [
  'orders',
  'ops',
  'cs',
  'research',
  'marketing',
  'finance',
  'browser',
] as const;
export type TaskDomain = (typeof TASK_DOMAINS)[number];

/** Lifecycle state of a queued task (durable, event-sourced by the queue core). */
export type QueueTaskState = 'PENDING' | 'LEASED' | 'DONE' | 'DEAD';

/**
 * A unit of agent work on a domain queue. `identity` carries tenant/actor/…
 * (INV-02). `payloadRef` is a bounded evidence pointer — NOT the payload body
 * (INV-07). Priority/deadline are consumed by SPEC-144; attempts by SPEC-145.
 */
export interface QueueTask {
  taskId: string;
  domain: TaskDomain;
  identity: ExecutionIdentity;
  /** Higher runs first (SPEC-144). Bounded 0..9. */
  priority: number;
  /** Absolute deadline in epoch millis (SPEC-144 EDF). Optional. */
  deadlineMs?: number;
  enqueuedAtMs: number;
  /** Evidence/bounded reference to the real payload (INV-07). */
  payloadRef: string;
  /** Stable across attempts so downstream dedupes side effects (INV-06). */
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  state: QueueTaskState;
}

/** Immutable queue state: one flat, append-structured log of tasks. */
export interface QueueState {
  readonly tasks: readonly QueueTask[];
}

export function emptyQueueState(): QueueState {
  return { tasks: [] };
}

/** Finite, stable queue reason codes (append-only). */
export const QUEUE_REASON_CODES = {
  MISSING_IDENTITY: 'Q_MISSING_IDENTITY',
  UNKNOWN_DOMAIN: 'Q_UNKNOWN_DOMAIN',
  MALFORMED: 'Q_MALFORMED',
  OVERSIZED: 'Q_OVERSIZED',
  CROSS_TENANT: 'Q_CROSS_TENANT',
  DUPLICATE: 'Q_DUPLICATE',
  EMPTY: 'Q_EMPTY_QUEUE',
  NOT_FOUND: 'Q_TASK_NOT_FOUND',
  BAD_PRIORITY: 'Q_BAD_PRIORITY',
} as const;
export type QueueReasonCode = (typeof QUEUE_REASON_CODES)[keyof typeof QUEUE_REASON_CODES];

/** Re-export the shared cross-tenant code so callers map on one constant. */
export const SHARED_REASON = REASON_CODES;

/** Bound on the evidence ref length (defends against payload smuggling). */
export const MAX_PAYLOAD_REF_BYTES = 1024;
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 9;

/** Payload accepted by `enqueue` — deliberately holds a ref, not a body. */
export interface EnqueuePayload {
  taskId: string;
  domain: TaskDomain;
  taskIdentity: ExecutionIdentity;
  priority: number;
  deadlineMs?: number;
  enqueuedAtMs: number;
  payloadRef: string;
  idempotencyKey: string;
  maxAttempts: number;
}

export const enqueuePayloadSchema = z.object({
  taskId: z.string().min(1),
  domain: z.enum(TASK_DOMAINS),
  taskIdentity: executionIdentitySchema,
  priority: z.number().int().min(MIN_PRIORITY).max(MAX_PRIORITY),
  deadlineMs: z.number().int().nonnegative().optional(),
  enqueuedAtMs: z.number().int().nonnegative(),
  payloadRef: z.string().min(1).max(MAX_PAYLOAD_REF_BYTES),
  idempotencyKey: z.string().min(1),
  maxAttempts: z.number().int().positive(),
});

/** A boundary op result carries the produced value plus the next state. */
export interface QueueOp<T> {
  result: ComponentResult<T>;
  state: QueueState;
}

/** Acknowledgement returned by a successful enqueue. */
export interface EnqueueAck {
  taskId: string;
  domain: TaskDomain;
  deduped: boolean;
  depth: number;
}

/** Audit event fields for a queue operation (identity ids only, no secrets). */
export interface QueueAuditEvent {
  component: 'domain-task-queue';
  op: 'enqueue' | 'dequeue' | 'complete' | 'fail';
  tenantId: string;
  correlationId: string;
  domain: TaskDomain;
  taskId: string;
  status: string;
  reasonCodes: string[];
  observedAtMs: number;
}
