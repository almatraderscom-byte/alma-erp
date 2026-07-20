/**
 * Approval expiry and revocation (G12 / SPEC-118).
 *
 * SPEC-112 decides whether a grant is valid; this spec governs whether a valid
 * grant is still USABLE right now. Three ways a grant stops being usable:
 *   - expiry     — now ≥ the request's expiry (already terminal in SPEC-112)
 *   - revocation — the owner revoked it before it was used
 *   - consumption — it was already used once (single-use; no replay)
 *
 * `resolveUsable` layers these on top of the SPEC-112 resolution, fail-closed:
 * anything other than a live, un-revoked, un-consumed, valid grant is not usable.
 *
 * Deterministic, pure (INV-01), `nowMs` injected. Durable persistence of the
 * revocation/consumption facts lives in a later group; here they are inputs.
 */
import type { ComponentResult } from '@/agent/contracts';
import { resolveApproval, type ApprovalRequest, type ApprovalDecisionInput, type ApprovalGrant } from './contract';

export const LIFECYCLE_REASON_CODES = {
  REVOKED: 'APPROVAL_REVOKED',
  ALREADY_CONSUMED: 'APPROVAL_ALREADY_CONSUMED',
  USABLE: 'APPROVAL_USABLE',
} as const;

/** A recorded revocation of an approval. */
export interface ApprovalRevocation {
  approvalRequestId: string;
  revokedAtMs: number;
  /** principalKey of who revoked (for audit). */
  byKey: string;
}

/** Recorded single-use consumption. */
export interface ApprovalConsumption {
  approvalRequestId: string;
  consumedAtMs: number;
}

export interface ApprovalLifecycleState {
  request: ApprovalRequest;
  decision: ApprovalDecisionInput | null;
  revocation?: ApprovalRevocation | null;
  consumption?: ApprovalConsumption | null;
}

/**
 * Is the approval usable at `nowMs`? Fail-closed: only a live, un-revoked,
 * un-consumed, valid grant returns ALLOWED. Never throws.
 */
export function resolveUsable(state: ApprovalLifecycleState, nowMs: number): ComponentResult<ApprovalGrant> {
  const base = resolveApproval(state.request, state.decision, nowMs);
  if (base.status !== 'ALLOWED') return base; // pending / denied / expired

  // Revoked before or at now, and matching this request → not usable.
  const rev = state.revocation;
  if (rev && rev.approvalRequestId === state.request.approvalRequestId && rev.revokedAtMs <= nowMs) {
    return { status: 'DENIED', reasonCodes: [LIFECYCLE_REASON_CODES.REVOKED], evidenceIds: [] };
  }

  // Already consumed → single-use, no replay.
  const con = state.consumption;
  if (con && con.approvalRequestId === state.request.approvalRequestId) {
    return { status: 'DENIED', reasonCodes: [LIFECYCLE_REASON_CODES.ALREADY_CONSUMED], evidenceIds: [] };
  }

  return base; // still usable (the base ALLOWED grant)
}

/** True iff the approval is usable right now. */
export function isUsable(state: ApprovalLifecycleState, nowMs: number): boolean {
  return resolveUsable(state, nowMs).status === 'ALLOWED';
}

/**
 * Attempt to consume the approval. Returns the consumption record ONLY if it is
 * usable at `nowMs`; otherwise returns the DENIED/PENDING resolution and no
 * consumption. This is the single point that mints a consumption fact.
 */
export function consumeApproval(
  state: ApprovalLifecycleState,
  nowMs: number,
): { ok: true; consumption: ApprovalConsumption } | { ok: false; result: ComponentResult<ApprovalGrant> } {
  const r = resolveUsable(state, nowMs);
  if (r.status !== 'ALLOWED') return { ok: false, result: r };
  return { ok: true, consumption: { approvalRequestId: state.request.approvalRequestId, consumedAtMs: nowMs } };
}

/** Build a revocation record. */
export function revoke(approvalRequestId: string, revokedAtMs: number, byKey: string): ApprovalRevocation {
  return { approvalRequestId, revokedAtMs, byKey };
}
