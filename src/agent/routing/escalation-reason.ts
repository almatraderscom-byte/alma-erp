/**
 * Explicit escalation reason contract (G17 / SPEC-165).
 *
 * Escalating a task to a higher (costlier) tier is never implicit. It requires an
 * explicit, finite reason code, and it must actually move UP the tier rank. This
 * is the only sanctioned path toward the frontier tier (T4) — the measured router
 * (SPEC-164) refuses frontier as a default, so the sole way to reach it is a
 * validated escalation, and only with a *frontier-eligible* reason (casual
 * "low confidence" cannot buy a frontier call).
 *
 * Pure, deterministic, fail-closed: a missing/unknown reason, a non-upward move,
 * or a frontier request without an eligible reason is a typed failure. No provider
 * call, no clock (INV-01). Budget enforcement is layered on top in SPEC-166.
 */
import { executionIdentitySchema, completed, type ComponentFailure, type ComponentResult, type ExecutionIdentity } from '@/agent/contracts';
import { isModelTier, tierRank, type ModelTier } from '@/agent/models';

export const ESCALATION_REASONS = [
  'LOW_CONFIDENCE',
  'REPEATED_FAILURE',
  'HIGH_RISK_DECISION',
  'BIG_MONEY',
  'PLANNING_REQUIRED',
  'OWNER_OVERRIDE',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** Only these reasons can justify reaching the frontier tier (T4). */
export const FRONTIER_ELIGIBLE_REASONS: EscalationReason[] = ['HIGH_RISK_DECISION', 'BIG_MONEY', 'PLANNING_REQUIRED', 'OWNER_OVERRIDE'];

export const ESCALATION_REASON_CODES = {
  REASON_REQUIRED: 'ESCALATION_REASON_REQUIRED',
  NOT_UPWARD: 'ESCALATION_NOT_UPWARD',
  TIER_UNKNOWN: 'ESCALATION_TIER_UNKNOWN',
  FRONTIER_REASON_REQUIRED: 'ESCALATION_FRONTIER_REASON_REQUIRED',
  MISSING_IDENTITY: 'ESCALATION_MISSING_IDENTITY',
} as const;

export interface EscalationRequest {
  identity: ExecutionIdentity;
  fromTier: ModelTier;
  toTier: ModelTier;
  reason: EscalationReason;
  evidenceIds?: string[];
}

export interface EscalationGrant {
  fromTier: ModelTier;
  toTier: ModelTier;
  reason: EscalationReason;
  toFrontier: boolean;
}

export function isEscalationReason(x: unknown): x is EscalationReason {
  return typeof x === 'string' && (ESCALATION_REASONS as readonly string[]).includes(x);
}

function fail(status: ComponentFailure['status'], codes: string[]): ComponentFailure {
  return { status, reasonCodes: codes, evidenceIds: [] };
}

/** Validate an escalation. Returns a typed grant or a typed failure — never throws. */
export function validateEscalation(req: EscalationRequest): ComponentResult<EscalationGrant> {
  if (!executionIdentitySchema.safeParse(req.identity).success) {
    return fail('FAILED_FINAL', [ESCALATION_REASON_CODES.MISSING_IDENTITY]);
  }
  if (!isModelTier(req.fromTier) || !isModelTier(req.toTier)) {
    return fail('FAILED_FINAL', [ESCALATION_REASON_CODES.TIER_UNKNOWN]);
  }
  if (!isEscalationReason(req.reason)) {
    return fail('DENIED', [ESCALATION_REASON_CODES.REASON_REQUIRED]);
  }
  // must move strictly UP the tier rank (equal / downward is not an escalation)
  if (tierRank(req.toTier) <= tierRank(req.fromTier)) {
    return fail('DENIED', [ESCALATION_REASON_CODES.NOT_UPWARD]);
  }
  const toFrontier = req.toTier === 'T4';
  if (toFrontier && !FRONTIER_ELIGIBLE_REASONS.includes(req.reason)) {
    // frontier cannot be reached on a low-stakes reason
    return fail('DENIED', [ESCALATION_REASON_CODES.FRONTIER_REASON_REQUIRED]);
  }
  return completed<EscalationGrant>(
    { fromTier: req.fromTier, toTier: req.toTier, reason: req.reason, toFrontier },
    [`escalation:${req.identity.correlationId}`, `reason:${req.reason}`, ...(req.evidenceIds ?? [])],
    { escalation: '1.0.0' },
  );
}
