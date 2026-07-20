/**
 * Dead-letter and manual recovery (G14 / SPEC-139).
 *
 * When a workflow can no longer make safe automatic progress — retries exhausted,
 * reconciliation escalated, a committed side effect with no compensator — it does
 * NOT keep churning and it does NOT silently drop. It goes to a DEAD-LETTER for a
 * human to resolve. This module builds the dead-letter entry and enumerates the
 * recovery actions that are legal for each reason (fail-closed: an uncompensatable
 * state never offers an automatic retry).
 *
 * Recovery is a human action — it must be initiated by a human operator; an agent
 * cannot self-recover a dead-lettered workflow. Pure, deterministic (INV-01).
 */
import type { ExecutionIdentity } from '@/agent/contracts';
import type { Principal } from '@/agent/identity/principals';
import type { WorkflowInstanceState } from './state';

export type DeadLetterReason =
  | 'retry_exhausted'
  | 'reconcile_escalated'
  | 'uncompensatable'
  | 'terminal_failure';

export type RecoveryAction = 'retry_step' | 'skip_step' | 'compensate' | 'cancel';

export interface DeadLetterEntry {
  instanceId: string;
  identity: ExecutionIdentity;
  reason: DeadLetterReason;
  failedStepId?: string;
  /** Committed side effects with no compensator (need manual undo). */
  uncompensated: string[];
  enqueuedAtMs: number;
}

export const DEAD_LETTER_REASON_CODES = {
  NOT_HUMAN_OPERATOR: 'WF_DL_NOT_HUMAN_OPERATOR',
  ACTION_NOT_ALLOWED: 'WF_DL_ACTION_NOT_ALLOWED',
  CROSS_TENANT_OPERATOR: 'WF_DL_CROSS_TENANT_OPERATOR',
} as const;

/** Build a dead-letter entry from a stalled instance. */
export function toDeadLetter(
  state: WorkflowInstanceState,
  reason: DeadLetterReason,
  opts: { failedStepId?: string; uncompensated?: string[]; enqueuedAtMs: number },
): DeadLetterEntry {
  return {
    instanceId: state.instanceId,
    identity: state.identity,
    reason,
    failedStepId: opts.failedStepId,
    uncompensated: opts.uncompensated ?? [],
    enqueuedAtMs: opts.enqueuedAtMs,
  };
}

/**
 * The recovery actions a human may take for a given entry. Fail-closed:
 * - uncompensatable → NO automatic retry/skip (a human must undo the effect):
 *   only `cancel` (accept & close) or `compensate` (if a manual compensator is
 *   supplied out-of-band) — never `retry_step`/`skip_step`.
 * - retry_exhausted → retry (after fixing) or skip or cancel.
 * - reconcile_escalated → compensate or cancel (never blind retry of an unknown effect).
 * - terminal_failure → skip or cancel.
 */
export function allowedRecoveryActions(entry: DeadLetterEntry): RecoveryAction[] {
  switch (entry.reason) {
    case 'uncompensatable':
      return ['compensate', 'cancel'];
    case 'reconcile_escalated':
      return ['compensate', 'cancel'];
    case 'retry_exhausted':
      return ['retry_step', 'skip_step', 'cancel'];
    case 'terminal_failure':
      return ['skip_step', 'cancel'];
  }
}

/**
 * Authorize a manual recovery: the operator must be a HUMAN in the same tenant,
 * and the chosen action must be allowed for this entry. Returns [] if authorized
 * or reason codes otherwise (fail-closed).
 */
export function authorizeRecovery(
  entry: DeadLetterEntry,
  operator: Principal,
  action: RecoveryAction,
): string[] {
  const errs: string[] = [];
  if (operator.kind !== 'human') errs.push(DEAD_LETTER_REASON_CODES.NOT_HUMAN_OPERATOR);
  if (operator.tenantId !== entry.identity.tenantId) errs.push(DEAD_LETTER_REASON_CODES.CROSS_TENANT_OPERATOR);
  if (!allowedRecoveryActions(entry).includes(action)) errs.push(DEAD_LETTER_REASON_CODES.ACTION_NOT_ALLOWED);
  return errs;
}
