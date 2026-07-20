/**
 * G13 / SPEC-127 — Execution adapter stage.
 *
 * The ONE place a tool / provider / network is invoked — and only via the
 * `ExecutionAdapter` seam. The gateway core never calls a provider directly; a
 * real adapter reaches the network, while tests inject a deterministic FAKE. This
 * keeps the gateway logic deterministic (INV-01) and is the single choke point the
 * bypass gate (SPEC-130) enforces.
 *
 * The adapter returns the frozen `ComponentResult` union: a RETRYABLE / FAILED_FINAL
 * / UNKNOWN_OUTCOME result propagates VERBATIM — an unknown external outcome is
 * never blindly retried here (INV-06); it flows out for reconciliation. On success
 * the raw payload is carried forward for evidence capture (SPEC-128) and the actual
 * cost for finalization (SPEC-129).
 *
 * Fail-closed (INV-05): a missing adapter is a FAILED_FINAL, never a silent skip.
 */
import { isSuccess, REASON_CODES } from '@/agent/contracts'
import { advance, stop, type ExecutionAdapter, type GatewayStage } from '../contract'

export const executionAdapterStage: GatewayStage = (ctx) => {
  const adapter = ctx.deps.adapter as ExecutionAdapter | undefined
  if (!adapter) return stop('FAILED_FINAL', [REASON_CODES.DEPENDENCY_FINAL])

  const result = adapter.execute({ toolName: ctx.toolName, args: ctx.args, identity: ctx.identity })
  // Propagate any non-success verbatim (RETRYABLE / UNKNOWN_OUTCOME / FAILED_FINAL).
  if (!isSuccess(result)) return result

  return advance(ctx, {
    rawPayload: result.value.payload,
    ...(result.value.actualCostNanoUsd !== undefined ? { actualCostNanoUsd: result.value.actualCostNanoUsd } : {}),
  })
}
