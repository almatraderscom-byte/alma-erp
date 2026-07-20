/**
 * Unknown-outcome reconciliation (G14 / SPEC-137).
 *
 * The heart of INV-06. When a side effect's outcome is UNKNOWN (a timeout mid-
 * charge, a crash mid-post), the runtime must NOT retry blindly — it must find
 * out what actually happened and converge. Reconciliation asks the provider "did
 * this idempotency key take effect?" and turns the answer into a safe decision:
 *
 *   effect_present     → CONFIRMED_DONE     (mark committed; the step succeeded)
 *   effect_absent      → CONFIRMED_NOT_DONE (safe to retry now — no double effect)
 *   indeterminate      → RECONCILE_AGAIN while attempts remain, else ESCALATE
 *                        (hand to a human via dead-letter — never guess)
 *
 * The probe itself is an adapter SEAM (I/O lives outside); this module is the
 * pure, deterministic decision over the probe's finding (INV-01).
 */
export type ReconcileFinding = 'effect_present' | 'effect_absent' | 'indeterminate';

export type ReconcileDecision =
  | { action: 'CONFIRMED_DONE' }
  | { action: 'CONFIRMED_NOT_DONE' }
  | { action: 'RECONCILE_AGAIN'; nextAttempt: number; backoffMs: number }
  | { action: 'ESCALATE'; reasonCode: string };

export const RECONCILE_REASON_CODES = {
  INDETERMINATE_EXHAUSTED: 'WF_RECONCILE_INDETERMINATE_EXHAUSTED',
  MALFORMED: 'WF_RECONCILE_MALFORMED',
} as const;

/** The seam a real reconciler implements (probes provider/evidence for the effect). */
export interface Reconciler {
  readonly name: string;
  /** Deterministic in tests via a fake; real impls do I/O behind this seam. */
  probe(idempotencyKey: string): ReconcileFinding;
}

export interface ReconcileInput {
  finding: ReconcileFinding;
  attempts: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

function backoff(attempt: number, base: number, max: number): number {
  return Math.min(attempt <= 1 ? base : base * 2 ** (attempt - 1), max);
}

/**
 * Decide from a probe finding. Fail-closed: an indeterminate outcome that has
 * exhausted its reconciliation budget ESCALATES to a human — it is never assumed
 * done or not-done.
 */
export function reconcile(input: ReconcileInput): ReconcileDecision {
  const { finding, attempts, maxAttempts, baseBackoffMs, maxBackoffMs } = input;
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return { action: 'ESCALATE', reasonCode: RECONCILE_REASON_CODES.MALFORMED };
  }
  switch (finding) {
    case 'effect_present':
      return { action: 'CONFIRMED_DONE' };
    case 'effect_absent':
      return { action: 'CONFIRMED_NOT_DONE' };
    case 'indeterminate':
      if (attempts >= maxAttempts) {
        return { action: 'ESCALATE', reasonCode: RECONCILE_REASON_CODES.INDETERMINATE_EXHAUSTED };
      }
      return { action: 'RECONCILE_AGAIN', nextAttempt: attempts + 1, backoffMs: backoff(attempts + 1, baseBackoffMs, maxBackoffMs) };
    default:
      return { action: 'ESCALATE', reasonCode: RECONCILE_REASON_CODES.MALFORMED };
  }
}

/** Run a reconciler probe and decide in one call (probe is the only impure part). */
export function reconcileWith(
  reconciler: Reconciler,
  idempotencyKey: string,
  budget: { attempts: number; maxAttempts: number; baseBackoffMs: number; maxBackoffMs: number },
): ReconcileDecision {
  let finding: ReconcileFinding;
  try {
    finding = reconciler.probe(idempotencyKey);
  } catch {
    // A probe that itself fails is indeterminate — decide under that finding.
    finding = 'indeterminate';
  }
  return reconcile({ finding, ...budget });
}
