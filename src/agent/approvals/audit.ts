/**
 * Approval evidence and audit (G12 / SPEC-119).
 *
 * Every approval decision must be reconstructable: who asked, for what, who
 * decided, when, and why. This module derives a structured, identity-correlated
 * audit event from an approval lifecycle state — the single source the owner and
 * any later observability layer read. It also emits a G01-compatible AuditEvent
 * so approvals slot into the shared audit stream.
 *
 * Deterministic, pure (INV-01): `observedAtMs` is injected, never read from a
 * clock, so an audit record is replayable.
 */
import { isSuccess, type AuditEvent } from '@/agent/contracts';
import { principalKey } from '@/agent/identity/principals';
import { resolveUsable, LIFECYCLE_REASON_CODES, type ApprovalLifecycleState } from './lifecycle';
import { APPROVAL_REASON_CODES } from './contract';

export type ApprovalEventKind =
  | 'pending' | 'granted' | 'denied' | 'expired' | 'revoked' | 'consumed';

export interface ApprovalAuditEvent {
  approvalRequestId: string;
  tenantId: string;
  actorId: string;
  workflowId: string;
  correlationId: string;
  kind: ApprovalEventKind;
  action: string;
  reasonCodes: string[];
  /** principalKey of the approver, when a decision exists. */
  approverKey?: string;
  observedAtMs: number;
}

/** Derive the current lifecycle event kind + reason codes at `nowMs`. */
export function deriveApprovalEvent(
  state: ApprovalLifecycleState,
  nowMs: number,
): { kind: ApprovalEventKind; reasonCodes: string[] } {
  const r = resolveUsable(state, nowMs);
  if (isSuccess(r)) return { kind: 'granted', reasonCodes: [APPROVAL_REASON_CODES.GRANTED] };
  if (r.status === 'NEEDS_APPROVAL') return { kind: 'pending', reasonCodes: r.reasonCodes };
  // DENIED — classify by the winning reason.
  const codes = r.reasonCodes;
  if (codes.includes(LIFECYCLE_REASON_CODES.ALREADY_CONSUMED)) return { kind: 'consumed', reasonCodes: codes };
  if (codes.includes(LIFECYCLE_REASON_CODES.REVOKED)) return { kind: 'revoked', reasonCodes: codes };
  if (codes.includes(APPROVAL_REASON_CODES.EXPIRED)) return { kind: 'expired', reasonCodes: codes };
  return { kind: 'denied', reasonCodes: codes };
}

/** Build the full approval audit event (identity-correlated). Never throws. */
export function approvalAuditEvent(state: ApprovalLifecycleState, observedAtMs: number): ApprovalAuditEvent {
  const { kind, reasonCodes } = deriveApprovalEvent(state, observedAtMs);
  const id = state.request.identity;
  const evt: ApprovalAuditEvent = {
    approvalRequestId: state.request.approvalRequestId,
    tenantId: id.tenantId,
    actorId: id.actorId,
    workflowId: id.workflowId,
    correlationId: id.correlationId,
    kind,
    action: state.request.action.action,
    reasonCodes,
    observedAtMs,
  };
  if (state.decision) evt.approverKey = principalKey(state.decision.approver);
  return evt;
}

/** Project an approval audit event onto the shared G01 AuditEvent stream. */
export function toG01AuditEvent(evt: ApprovalAuditEvent): AuditEvent {
  const status = evt.kind === 'granted' ? 'ALLOWED' : evt.kind === 'pending' ? 'NEEDS_APPROVAL' : 'DENIED';
  return {
    identity: {
      tenantId: evt.tenantId,
      actorId: evt.actorId,
      workflowId: evt.workflowId,
      stepId: evt.approvalRequestId,
      correlationId: evt.correlationId,
    },
    component: 'approvals',
    status,
    reasonCodes: evt.reasonCodes,
    evidenceIds: [evt.approvalRequestId],
    contractVersion: 'SPEC-119',
    observedAtMs: evt.observedAtMs,
  };
}
