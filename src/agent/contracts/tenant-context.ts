/**
 * Tenant and business context propagation contract (G01 / SPEC-005).
 *
 * Builds on the execution identity (SPEC-004). Every resource access is checked
 * against the caller's tenant (and optional business) scope. Cross-tenant access
 * fails closed with a CROSS_TENANT reason code — the seed of multi-tenant
 * isolation for the whole request path. Deterministic, no I/O, no LLM.
 */
import { REASON_CODES, failure, type ComponentFailure, type ExecutionIdentity } from './component';
import { deriveChildStep } from './execution-identity';

/** A resource carries the tenant (and optionally business) that owns it. */
export interface ResourceScope {
  tenantId: string;
  businessId?: string;
}

export type ScopeCheck = { ok: true } | { ok: false; failure: ComponentFailure };

/**
 * Fail-closed tenant guard. Access is allowed only when the resource's tenant
 * equals the caller's tenant. If the resource declares a business, the caller's
 * business (when set) must match it too.
 */
export function guardResourceAccess(identity: ExecutionIdentity, resource: ResourceScope): ScopeCheck {
  if (!resource.tenantId || resource.tenantId !== identity.tenantId) {
    return { ok: false, failure: failure('DENIED', [REASON_CODES.CROSS_TENANT]) };
  }
  if (resource.businessId && identity.businessId && resource.businessId !== identity.businessId) {
    return { ok: false, failure: failure('DENIED', [REASON_CODES.CROSS_TENANT]) };
  }
  return { ok: true };
}

/** Narrow an identity to a specific business context for a sub-step. */
export function withBusiness(identity: ExecutionIdentity, businessId: string, stepId?: string): ExecutionIdentity {
  const base = stepId ? deriveChildStep(identity, stepId) : identity;
  return { ...base, businessId };
}

/**
 * Propagate the caller's tenant scope onto an outbound resource that does not
 * yet carry one (e.g. a new row being created). Never widens scope.
 */
export function stampScope(identity: ExecutionIdentity, partial: Partial<ResourceScope> = {}): ResourceScope {
  return {
    tenantId: identity.tenantId,
    ...(identity.businessId ? { businessId: identity.businessId } : {}),
    ...(partial.businessId ? { businessId: partial.businessId } : {}),
  };
}

/**
 * Idempotency key for a (correlation, step, resource) tuple — used so an unknown
 * outcome is reconciled, not blindly retried (INV-06). Deterministic.
 */
export function idempotencyKey(identity: ExecutionIdentity, resourceRef: string): string {
  return `${identity.tenantId}:${identity.correlationId}:${identity.stepId}:${resourceRef}`;
}
