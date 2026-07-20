/**
 * Canonical execution identity contract (G01 / SPEC-004).
 *
 * Invariant INV-02: every authoritative operation carries tenant, actor, agent,
 * workflow, step and correlation identities. This module is the single builder /
 * validator / propagator for that identity. Deterministic: no time, no RNG —
 * correlation ids are derived by hashing caller-supplied seed parts, so the same
 * inputs always yield the same id (replayable, test-stable).
 */
import { createHash } from 'node:crypto';
import {
  REASON_CODES,
  executionIdentitySchema,
  failure,
  type ComponentFailure,
  type ExecutionIdentity,
  type ReasonCode,
} from './component';

export type { ExecutionIdentity } from './component';

export interface IdentityInput {
  tenantId: string;
  actorId: string;
  workflowId: string;
  stepId: string;
  businessId?: string;
  agentId?: string;
  /** if omitted, a correlation id is derived deterministically from the seed */
  correlationId?: string;
}

export type IdentityResult =
  | { ok: true; identity: ExecutionIdentity }
  | { ok: false; failure: ComponentFailure };

/** Deterministic correlation id from seed parts (sha256, 32 hex chars). */
export function deriveCorrelationId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `corr_${h.slice(0, 32)}`;
}

/**
 * Build + validate a canonical identity. Fail-closed: missing tenant/actor/etc.
 * return a typed ComponentFailure with a specific reason code, never a throw.
 */
export function createExecutionIdentity(input: IdentityInput): IdentityResult {
  const correlationId =
    input.correlationId ?? deriveCorrelationId(input.tenantId, input.workflowId, input.stepId, input.actorId);

  const candidate: ExecutionIdentity = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    workflowId: input.workflowId,
    stepId: input.stepId,
    correlationId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };

  const parsed = executionIdentitySchema.safeParse(candidate);
  if (!parsed.success) {
    const codes = new Set<ReasonCode>();
    for (const issue of parsed.error.issues) {
      const f = issue.path[0];
      if (f === 'tenantId') codes.add(REASON_CODES.MISSING_TENANT);
      else if (f === 'actorId') codes.add(REASON_CODES.MISSING_ACTOR);
      else if (f === 'workflowId') codes.add(REASON_CODES.MISSING_WORKFLOW);
      else if (f === 'stepId') codes.add(REASON_CODES.MISSING_STEP);
      else if (f === 'correlationId') codes.add(REASON_CODES.MISSING_CORRELATION);
      else codes.add(REASON_CODES.MALFORMED_INPUT);
    }
    return { ok: false, failure: failure('FAILED_FINAL', [...codes]) };
  }
  return { ok: true, identity: parsed.data as ExecutionIdentity };
}

/**
 * Derive a child-step identity: same tenant/business/actor/agent/workflow and
 * the SAME correlation id (a run is one correlation), with a new stepId. This is
 * how identity propagates down the request path (Admission → Cost → … → Gateway).
 */
export function deriveChildStep(parent: ExecutionIdentity, stepId: string): ExecutionIdentity {
  return { ...parent, stepId };
}

/** True iff two identities belong to the same tenant (cross-tenant guard seed). */
export function sameTenant(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return a.tenantId === b.tenantId;
}

/** Flat record for audit/metrics rows. Identity fields are ids, not secrets. */
export function identityAuditFields(id: ExecutionIdentity): Record<string, string> {
  return {
    tenantId: id.tenantId,
    businessId: id.businessId ?? '',
    actorId: id.actorId,
    agentId: id.agentId ?? '',
    workflowId: id.workflowId,
    stepId: id.stepId,
    correlationId: id.correlationId,
  };
}
