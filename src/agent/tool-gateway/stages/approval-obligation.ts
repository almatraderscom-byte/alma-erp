/**
 * G13 / SPEC-126 — Approval / obligation stage.
 *
 * Consults the G12 autonomy engine to decide whether the (already policy-approved,
 * cost-authorized) action may run autonomously or must pause for owner approval:
 *   - NEEDS_APPROVAL → the gateway returns NEEDS_APPROVAL and DOES NOT execute
 *     (no side effect happens; the caller surfaces an approval card),
 *   - DENIED         → propagated verbatim (stops the pipeline),
 *   - AUTONOMOUS     → advance; the policy obligations carried from SPEC-124 are
 *     applied to the RESULT view later (SPEC-128) via `applyViewObligations`.
 *
 * G12 (`@/agent/autonomy`) is not yet folded into the wave, so the engine is a
 * SEAM injected via `deps.autonomyEngine`, matching G12's FROZEN interface
 * `AutonomyEngine.decide(input): ComponentResult<AutonomyDecisionValue>` with
 * states AUTONOMOUS | NEEDS_APPROVAL | DENIED. When G12 lands, a real engine
 * instance satisfies this structural type with no gateway change.
 *
 * Fail-closed (INV-05): NO autonomy engine ⇒ NEEDS_APPROVAL (never auto-execute an
 * unconfirmed action). Deterministic (INV-01): the engine is a pure seam.
 */
import { type ComponentResult, isSuccess, REASON_CODES } from '@/agent/contracts'
import { applyObligations } from '@/agent/policy'
import { advance, stop, type GatewayContext, type GatewayStage } from '../contract'

// ── Frozen G12 autonomy seam (see module doc) ───────────────────────────────
export type AutonomyState = 'AUTONOMOUS' | 'NEEDS_APPROVAL' | 'DENIED'
export interface AutonomyDecisionValue {
  state: AutonomyState
  approvalRequestId?: string
}
export interface AutonomyDecideInput {
  identity: GatewayContext['identity']
  action: string
  toolName: string
  args: Record<string, unknown>
  estimatedCostNanoUsd: number
  obligations: string[]
}
export interface AutonomyEngine {
  decide(input: AutonomyDecideInput): ComponentResult<AutonomyDecisionValue>
}

/** Apply carried policy obligations (redact/mask) to a result view (used by SPEC-128). */
export function applyViewObligations(view: unknown, obligations: readonly string[]): unknown {
  if (!obligations || obligations.length === 0) return view
  return applyObligations(view, [...obligations]).value
}

export const approvalObligationStage: GatewayStage = (ctx) => {
  const engine = ctx.deps.autonomyEngine as AutonomyEngine | undefined
  // Fail-closed: without an autonomy engine we cannot confirm autonomy → approval.
  if (!engine) return stop('NEEDS_APPROVAL', [REASON_CODES.APPROVAL_REQUIRED])

  const decision = engine.decide({
    identity: ctx.identity,
    action: ctx.action,
    toolName: ctx.toolName,
    args: ctx.args,
    estimatedCostNanoUsd: ctx.estimatedCostNanoUsd,
    obligations: ctx.obligations ?? [],
  })
  if (!isSuccess(decision)) return decision // DENIED (or other non-success) propagates

  const value = decision.value
  if (value.state === 'NEEDS_APPROVAL') {
    return stop('NEEDS_APPROVAL', [REASON_CODES.APPROVAL_REQUIRED], value.approvalRequestId ? { approvalRequestId: value.approvalRequestId } : {})
  }
  if (value.state !== 'AUTONOMOUS') {
    // Unknown state ⇒ fail-closed.
    return stop('DENIED', [REASON_CODES.POLICY_DENIED])
  }
  return advance(ctx)
}
