/**
 * Fail-closed approval contract (G12 / SPEC-112).
 *
 * When the autonomy engine (SPEC-111) returns NEEDS_APPROVAL, the action is
 * parked as an ApprovalRequest until Boss decides. This module defines that
 * request/decision/resolution contract and the DETERMINISTIC resolver that says
 * whether an action is actually approved.
 *
 * Fail-closed is the whole point (INV-05): the ONLY way to reach "approved" is an
 * explicit `grant` decision that (a) targets this exact request, (b) is made by an
 * authorized HUMAN approver in the same tenant, (c) is not the agent that
 * requested it, and (d) lands before the request expires. Missing decision,
 * expiry, wrong request id, cross-tenant approver, non-human approver, or a `deny`
 * ALL resolve to "not approved". No ambiguous boolean, no thrown errors.
 *
 * Deterministic, pure: no LLM, no I/O, and NO wall clock — `nowMs` is passed in so
 * the resolver is replayable (INV-01). Durable storage of requests lives elsewhere
 * (queue, later group); this is the pure decision surface.
 */
import { z } from 'zod';
import { isSuccess, executionIdentitySchema, type ComponentResult, type ExecutionIdentity } from '@/agent/contracts';
import { principalKey, type Principal } from '@/agent/identity/principals';
import type { ActionDescriptor } from '../autonomy/states';

/** Lifecycle state of an approval request at a given instant. */
export type ApprovalState = 'PENDING' | 'GRANTED' | 'DENIED' | 'EXPIRED';

export const APPROVAL_REASON_CODES = {
  PENDING: 'APPROVAL_PENDING',
  GRANTED: 'APPROVAL_GRANTED',
  DENIED_BY_APPROVER: 'APPROVAL_DENIED_BY_APPROVER',
  EXPIRED: 'APPROVAL_EXPIRED',
  REQUEST_MISMATCH: 'APPROVAL_REQUEST_MISMATCH',
  CROSS_TENANT_APPROVER: 'APPROVAL_CROSS_TENANT_APPROVER',
  UNAUTHORIZED_APPROVER: 'APPROVAL_UNAUTHORIZED_APPROVER',
  SELF_APPROVAL: 'APPROVAL_SELF_APPROVAL',
  MALFORMED: 'APPROVAL_MALFORMED',
  DECIDED_OUT_OF_WINDOW: 'APPROVAL_DECIDED_OUT_OF_WINDOW',
} as const;

export type ApprovalReasonCode =
  (typeof APPROVAL_REASON_CODES)[keyof typeof APPROVAL_REASON_CODES];

/** A parked action awaiting the owner's decision. */
export interface ApprovalRequest {
  approvalRequestId: string;
  identity: ExecutionIdentity;
  action: ActionDescriptor;
  /** Why approval was required (from the autonomy decision). */
  reasonCodes: string[];
  createdAtMs: number;
  /** Fail-closed expiry: a grant at or after this instant does NOT approve. */
  expiresAtMs: number;
}

/** The owner's (or an authorized human's) decision on a request. */
export interface ApprovalDecisionInput {
  approvalRequestId: string;
  decision: 'grant' | 'deny';
  approver: Principal;
  decidedAtMs: number;
  note?: string;
}

/** The record returned when an action is genuinely approved. */
export interface ApprovalGrant {
  approvalRequestId: string;
  approverKey: string;
  decidedAtMs: number;
}

export type ApprovalResolution = ComponentResult<ApprovalGrant>;

// ── Validation ──────────────────────────────────────────────────────────────

const actionSchema = z.object({
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const requestSchema = z.object({
  approvalRequestId: z.string().min(1),
  identity: executionIdentitySchema,
  action: actionSchema,
  reasonCodes: z.array(z.string()),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

function pending(reasonCodes: string[]): ApprovalResolution {
  return { status: 'NEEDS_APPROVAL', reasonCodes, evidenceIds: [] };
}
function denied(reasonCodes: string[]): ApprovalResolution {
  return { status: 'DENIED', reasonCodes, evidenceIds: [] };
}

/** Build a fresh approval request (TTL in ms). Deterministic given `createdAtMs`. */
export function newApprovalRequest(
  approvalRequestId: string,
  identity: ExecutionIdentity,
  action: ActionDescriptor,
  reasonCodes: string[],
  createdAtMs: number,
  ttlMs: number,
): ApprovalRequest {
  const req: ApprovalRequest = {
    approvalRequestId,
    identity,
    action,
    reasonCodes: [...reasonCodes],
    createdAtMs,
    expiresAtMs: createdAtMs + Math.max(0, ttlMs),
  };
  const parsed = requestSchema.safeParse(req);
  if (!parsed.success) throw new Error(`invalid ApprovalRequest: ${parsed.error.issues[0]?.message}`);
  return req;
}

/**
 * Resolve whether an action is approved. Never throws. `decision` is the single
 * decision seen for this request (or null if none yet). `nowMs` is the evaluation
 * instant. Fail-closed: anything other than a fully valid, in-window `grant`
 * resolves to NEEDS_APPROVAL (still parked) or DENIED (terminal).
 */
export function resolveApproval(
  request: ApprovalRequest,
  decision: ApprovalDecisionInput | null,
  nowMs: number,
): ApprovalResolution {
  // 1. Structural validation — malformed request cannot be approved.
  if (!requestSchema.safeParse(request).success) {
    return denied([APPROVAL_REASON_CODES.MALFORMED]);
  }

  // 2. Expiry is checked FIRST and is terminal: an expired request is never
  //    approved, regardless of any decision — the owner must re-issue.
  if (nowMs >= request.expiresAtMs) {
    return denied([APPROVAL_REASON_CODES.EXPIRED]);
  }

  // 3. No decision yet → still parked.
  if (decision === null) {
    return pending([APPROVAL_REASON_CODES.PENDING]);
  }

  // 4. The decision must target THIS request (no cross-request confusion/replay).
  if (decision.approvalRequestId !== request.approvalRequestId) {
    return pending([APPROVAL_REASON_CODES.REQUEST_MISMATCH]);
  }

  // 5. Approver authorization (SPEC-117 hardens separation-of-duties further):
  //    same tenant, a human, and NOT the agent/actor that requested the action.
  if (decision.approver.tenantId !== request.identity.tenantId) {
    return denied([APPROVAL_REASON_CODES.CROSS_TENANT_APPROVER]);
  }
  if (decision.approver.kind !== 'human') {
    return denied([APPROVAL_REASON_CODES.UNAUTHORIZED_APPROVER]);
  }
  if (decision.approver.actorId === request.identity.actorId) {
    return denied([APPROVAL_REASON_CODES.SELF_APPROVAL]);
  }

  // 6. The decision must have been made within the request's live window.
  if (decision.decidedAtMs < request.createdAtMs || decision.decidedAtMs >= request.expiresAtMs) {
    return denied([APPROVAL_REASON_CODES.DECIDED_OUT_OF_WINDOW]);
  }

  // 7. A deny is terminal.
  if (decision.decision === 'deny') {
    return denied([APPROVAL_REASON_CODES.DENIED_BY_APPROVER]);
  }

  // 8. A valid, in-window grant by an authorized human → APPROVED.
  const grant: ApprovalGrant = {
    approvalRequestId: request.approvalRequestId,
    approverKey: principalKey(decision.approver),
    decidedAtMs: decision.decidedAtMs,
  };
  return { status: 'ALLOWED', value: grant, evidenceIds: [], versions: { approval: 'SPEC-112' } };
}

/** The lifecycle state for a request+decision at `nowMs` (for audit/UI). */
export function approvalStateOf(
  request: ApprovalRequest,
  decision: ApprovalDecisionInput | null,
  nowMs: number,
): ApprovalState {
  const r = resolveApproval(request, decision, nowMs);
  if (isSuccess(r)) return 'GRANTED';
  if (r.status === 'NEEDS_APPROVAL') return 'PENDING';
  // DENIED — distinguish expiry from a real denial for display.
  return r.reasonCodes.includes(APPROVAL_REASON_CODES.EXPIRED) ? 'EXPIRED' : 'DENIED';
}
