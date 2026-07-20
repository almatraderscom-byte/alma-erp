/**
 * Separation-of-duties enforcement (G12 / SPEC-117).
 *
 * SPEC-112 already forbids the requester approving its own action. This spec
 * makes approver eligibility a first-class, reusable, stricter check: an approver
 * is eligible ONLY if it is a HUMAN in the same tenant, is neither the requesting
 * actor nor the requesting agent, and holds at least one of the configured
 * approver roles. Anyone else — an agent, a peer without an approver role, the
 * requester, a cross-tenant principal — is rejected.
 *
 * Deterministic, pure (INV-01). Fail-closed (INV-05): no eligible-approver proof
 * ⇒ rejected.
 */
import { z } from 'zod';
import type { ComponentResult } from '@/agent/contracts';
import { principalRoles, type Principal } from '@/agent/identity/principals';
import { resolveApproval, type ApprovalRequest, type ApprovalDecisionInput, type ApprovalGrant } from './contract';

export const SOD_REASON_CODES = {
  APPROVER_IS_REQUESTER: 'SOD_APPROVER_IS_REQUESTER',
  APPROVER_IS_REQUESTING_AGENT: 'SOD_APPROVER_IS_REQUESTING_AGENT',
  MISSING_APPROVER_ROLE: 'SOD_MISSING_APPROVER_ROLE',
  NOT_HUMAN: 'SOD_NOT_HUMAN',
  CROSS_TENANT: 'SOD_CROSS_TENANT',
  ELIGIBLE: 'SOD_ELIGIBLE',
} as const;

export interface SodConfig {
  /** The approver must hold at least one of these roles. */
  requiredApproverRoles: string[];
}

const configSchema = z.object({ requiredApproverRoles: z.array(z.string().min(1)).min(1) });

/**
 * Is `approver` eligible to approve `request` under separation-of-duties?
 * Returns a typed reason code list; empty ⇒ eligible.
 */
export function separationViolations(
  request: ApprovalRequest,
  approver: Principal,
  config: SodConfig,
): string[] {
  if (!configSchema.safeParse(config).success) {
    // A misconfigured SoD policy must not silently permit — treat as ineligible.
    return [SOD_REASON_CODES.MISSING_APPROVER_ROLE];
  }
  const violations: string[] = [];
  if (approver.tenantId !== request.identity.tenantId) violations.push(SOD_REASON_CODES.CROSS_TENANT);
  if (approver.kind !== 'human') violations.push(SOD_REASON_CODES.NOT_HUMAN);
  else {
    if (approver.actorId === request.identity.actorId) violations.push(SOD_REASON_CODES.APPROVER_IS_REQUESTER);
    if (request.identity.agentId && approver.actorId === request.identity.agentId) {
      violations.push(SOD_REASON_CODES.APPROVER_IS_REQUESTING_AGENT);
    }
  }
  const roles = principalRoles(approver);
  if (!config.requiredApproverRoles.some((r) => roles.includes(r))) {
    violations.push(SOD_REASON_CODES.MISSING_APPROVER_ROLE);
  }
  return [...new Set(violations)];
}

/** True iff the approver is eligible (no violations). */
export function isEligibleApprover(request: ApprovalRequest, approver: Principal, config: SodConfig): boolean {
  return separationViolations(request, approver, config).length === 0;
}

/**
 * Resolve an approval with separation-of-duties enforced ON TOP of the SPEC-112
 * contract. A grant is APPROVED only if the base resolution approves AND the
 * approver is SoD-eligible. Fail-closed: any SoD violation downgrades an
 * otherwise-valid grant to DENIED.
 */
export function resolveApprovalWithSod(
  request: ApprovalRequest,
  decision: ApprovalDecisionInput | null,
  nowMs: number,
  config: SodConfig,
): ComponentResult<ApprovalGrant> {
  const base = resolveApproval(request, decision, nowMs);
  if (base.status !== 'ALLOWED') return base; // pending/denied passes through unchanged
  // base approved ⇒ there is a decision; enforce SoD on its approver.
  const violations = decision ? separationViolations(request, decision.approver, config) : [SOD_REASON_CODES.MISSING_APPROVER_ROLE];
  if (violations.length > 0) {
    return { status: 'DENIED', reasonCodes: violations, evidenceIds: [] };
  }
  return base;
}
