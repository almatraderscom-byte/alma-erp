/**
 * Idempotency keys (G14 / SPEC-136).
 *
 * A side-effecting step may be attempted more than once — a retry, a reclaimed
 * lease after a crash, a reconciliation. To make the EXTERNAL effect happen at
 * most once, every such step carries a stable idempotency key derived from
 * (instance, step, pinned template) — deliberately NOT the attempt number, so
 * every attempt of the same logical operation shares one key and the downstream
 * (tool gateway / provider) deduplicates.
 *
 * `resolveIdempotency` reads the recorded outcome for a key and decides PROCEED /
 * SKIP / RECONCILE — fail-closed: an in-flight or unknown record for a side
 * effect reconciles, it never re-executes (INV-06).
 *
 * Deterministic (local sha256), no I/O (INV-01).
 */
import { createHash } from 'node:crypto';
import type { TemplatePin } from './versioning';

/** Stable idempotency key for a step of an instance. Same across all attempts. */
export function idempotencyKey(instanceId: string, stepId: string, pin: TemplatePin): string {
  const material = `${instanceId}|${stepId}|${pin.templateId}@${pin.templateVersion}`;
  return 'idem_' + createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export type IdempotencyStatus = 'committed' | 'in_flight' | 'unknown';

/** The recorded outcome for a key (from durable storage). */
export interface IdempotencyRecord {
  key: string;
  status: IdempotencyStatus;
  /** evidence/result reference of the committed effect, when committed. */
  resultRef?: string;
}

export type IdempotencyDecision =
  | { action: 'PROCEED' }
  | { action: 'SKIP'; resultRef?: string }
  | { action: 'RECONCILE'; reasonCode: string };

export const IDEMPOTENCY_REASON_CODES = {
  IN_FLIGHT: 'WF_IDEM_IN_FLIGHT',
  UNKNOWN: 'WF_IDEM_UNKNOWN',
  KEY_MISMATCH: 'WF_IDEM_KEY_MISMATCH',
} as const;

/**
 * Decide what to do for `key` given its recorded outcome (null = never attempted).
 * Fail-closed: an in-flight or unknown record for a side effect reconciles rather
 * than re-running.
 */
export function resolveIdempotency(key: string, record: IdempotencyRecord | null): IdempotencyDecision {
  if (record === null) return { action: 'PROCEED' };
  if (record.key !== key) {
    // A record for a different key must never authorise skipping THIS operation.
    return { action: 'RECONCILE', reasonCode: IDEMPOTENCY_REASON_CODES.KEY_MISMATCH };
  }
  switch (record.status) {
    case 'committed':
      return { action: 'SKIP', resultRef: record.resultRef };
    case 'in_flight':
      return { action: 'RECONCILE', reasonCode: IDEMPOTENCY_REASON_CODES.IN_FLIGHT };
    case 'unknown':
      return { action: 'RECONCILE', reasonCode: IDEMPOTENCY_REASON_CODES.UNKNOWN };
  }
}
