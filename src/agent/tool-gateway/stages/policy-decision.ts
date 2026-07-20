/**
 * G13 / SPEC-124 — Policy decision stage.
 *
 * Delegates authorization to the G11 Policy Engine: it builds a
 * PolicyEvaluationInput from the gateway context and calls `decidePolicy`. The
 * decision IS the frozen ComponentResult union — a DENIED decision is returned
 * verbatim and stops the pipeline (fail-closed). On ALLOW, the permitting layers'
 * obligations (redact/mask/audit) are carried forward on the context for the
 * approval/obligation stage (SPEC-126) to apply.
 *
 * Fail-closed (INV-05): a missing principal/resource, or any non-ALLOW policy
 * decision (incl. the engine's own "no applicable permit" default), DENIES.
 * Deterministic: the policy engine is pure (INV-01).
 */
import { isSuccess, REASON_CODES } from '@/agent/contracts'
import { decidePolicy, type PolicyLayer } from '@/agent/policy'
import { advance, stop, type GatewayStage } from '../contract'

export const policyDecisionStage: GatewayStage = (ctx) => {
  const { principal, resource } = ctx
  // Fail-closed: we cannot authorize without a principal and a target resource.
  if (!principal || !resource) return stop('DENIED', [REASON_CODES.POLICY_DENIED])

  const layers = (ctx.deps.policyLayers as PolicyLayer[] | undefined) ?? []
  const decision = decidePolicy(
    { identity: ctx.identity, principal, action: ctx.action, resource, context: ctx.policyContext },
    layers,
  )
  // A denial (or any non-success) propagates unchanged and stops the pipeline.
  if (!isSuccess(decision)) return decision
  return advance(ctx, { obligations: decision.value.obligations })
}
