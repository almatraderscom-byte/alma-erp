/**
 * Retry classification (G14 / SPEC-135).
 *
 * When a step fails, the runtime must decide ONE of three things — never guess:
 *   RETRY      — a transient failure, within the attempt budget → back off & retry
 *   RECONCILE  — a side effect whose outcome is UNKNOWN → go find out, don't retry
 *                (INV-06: unknown external outcomes are reconciled, never blindly
 *                 retried — a blind retry could double-charge / double-post)
 *   TERMINAL   — a permanent failure, or the attempt budget is exhausted → stop
 *
 * Backoff is deterministic exponential (no random jitter — Math.random is banned
 * for replayability, INV-01). Pure, no I/O.
 */
import { z } from 'zod';

/** How the failure was categorised by the caller (from the G01 error taxonomy). */
export type FailureKind = 'transient' | 'permanent' | 'unknown';

export type RetryDecision =
  | { action: 'RETRY'; backoffMs: number; attempt: number }
  | { action: 'RECONCILE'; reasonCode: string }
  | { action: 'TERMINAL'; reasonCode: string };

export const RETRY_REASON_CODES = {
  UNKNOWN_SIDE_EFFECT: 'WF_RETRY_UNKNOWN_SIDE_EFFECT',
  PERMANENT: 'WF_RETRY_PERMANENT',
  EXHAUSTED: 'WF_RETRY_EXHAUSTED',
  MALFORMED: 'WF_RETRY_MALFORMED',
} as const;

export interface RetryInput {
  failureKind: FailureKind;
  /** Does the failed step cause an external side effect? */
  sideEffect: boolean;
  /** Attempts already made (>=1 after the first try). */
  attempts: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

const inputSchema = z.object({
  failureKind: z.enum(['transient', 'permanent', 'unknown']),
  sideEffect: z.boolean(),
  attempts: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  baseBackoffMs: z.number().int().nonnegative(),
  maxBackoffMs: z.number().int().nonnegative(),
});

/** Deterministic exponential backoff: base * 2^(attempt-1), capped. */
export function backoffFor(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt <= 1) return Math.min(baseMs, maxMs);
  const raw = baseMs * 2 ** (attempt - 1);
  return Math.min(raw, maxMs);
}

/**
 * Classify a step failure into RETRY / RECONCILE / TERMINAL. Fail-closed toward
 * safety: an unknown outcome of a side effect ALWAYS reconciles (never retries);
 * a malformed input is TERMINAL (never a blind retry).
 */
export function classifyFailure(input: RetryInput): RetryDecision {
  if (!inputSchema.safeParse(input).success) {
    return { action: 'TERMINAL', reasonCode: RETRY_REASON_CODES.MALFORMED };
  }
  const { failureKind, sideEffect, attempts, maxAttempts, baseBackoffMs, maxBackoffMs } = input;

  // INV-06: an unknown outcome of a SIDE EFFECT must be reconciled, not retried.
  if (failureKind === 'unknown' && sideEffect) {
    return { action: 'RECONCILE', reasonCode: RETRY_REASON_CODES.UNKNOWN_SIDE_EFFECT };
  }
  // A permanent failure is terminal.
  if (failureKind === 'permanent') {
    return { action: 'TERMINAL', reasonCode: RETRY_REASON_CODES.PERMANENT };
  }
  // Budget exhausted → terminal.
  if (attempts >= maxAttempts) {
    return { action: 'TERMINAL', reasonCode: RETRY_REASON_CODES.EXHAUSTED };
  }
  // Transient, or an unknown outcome with NO side effect (safe to retry) → retry.
  const nextAttempt = attempts + 1;
  return { action: 'RETRY', attempt: nextAttempt, backoffMs: backoffFor(nextAttempt, baseBackoffMs, maxBackoffMs) };
}
