/**
 * G13 / SPEC-123 — Identity validation stage.
 *
 * Enforces INV-02 inside the pipeline: every authoritative operation carries a
 * FULL ExecutionIdentity (tenant, actor, workflow, step, correlation). This is
 * defense-in-depth over the boundary's envelope check — even a caller that invokes
 * `runPipeline` directly cannot proceed without a complete identity. It also
 * enforces tenant isolation: if the tool targets a different tenant than the
 * caller's identity, the call is DENIED (CROSS_TENANT).
 *
 * Fail-closed (INV-05): any missing field or tenant mismatch DENIES. Deterministic.
 */
import { REASON_CODES } from '@/agent/contracts'
import { advance, stop, type GatewayStage } from '../contract'

export const identityValidationStage: GatewayStage = (ctx) => {
  const id = ctx.identity
  if (!id.tenantId) return stop('DENIED', [REASON_CODES.MISSING_TENANT])
  if (!id.actorId) return stop('DENIED', [REASON_CODES.MISSING_ACTOR])
  if (!id.workflowId) return stop('DENIED', [REASON_CODES.MISSING_WORKFLOW])
  if (!id.stepId) return stop('DENIED', [REASON_CODES.MISSING_STEP])
  if (!id.correlationId) return stop('DENIED', [REASON_CODES.MISSING_CORRELATION])
  if (ctx.resourceTenantId && ctx.resourceTenantId !== id.tenantId) {
    return stop('DENIED', [REASON_CODES.CROSS_TENANT])
  }
  return advance(ctx)
}
