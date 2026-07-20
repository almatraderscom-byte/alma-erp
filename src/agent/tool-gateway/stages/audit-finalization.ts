/**
 * G13 / SPEC-129 — Audit and cost finalization.
 *
 * The last stage on the SUCCESS path. It reconciles the cost reservation made in
 * SPEC-125 against ACTUAL usage — committing the real spend (clamped to the
 * reserved worst-case) to the G04 ledger — and emits exactly ONE audit event with
 * the exact ExecutionIdentity correlation. The audit sink is an injected seam
 * (deterministic; default is a no-op), so this stage stays pure (INV-01).
 *
 * The abort path (a stage failing AFTER a reservation was made) is handled by the
 * gateway runner's reservation RELEASE safety-net in `invokeTool` — so a reserved
 * budget is never leaked whether the call completes or aborts.
 */
import type { AuditEvent } from '@/agent/contracts'
import type { BudgetStore } from '@/agent/budgets/budget'
import { advance, GATEWAY_CONTRACT_VERSION, type GatewayStage } from '../contract'

export type AuditSink = (event: AuditEvent) => void

export const auditFinalizationStage: GatewayStage = (ctx) => {
  let actual = ctx.actualCostNanoUsd
  // Reconcile the reservation to actual spend (clamped to reserved).
  if (ctx.reservation) {
    const store = ctx.deps.budgetStore as BudgetStore | undefined
    actual = Math.min(ctx.actualCostNanoUsd ?? ctx.reservation.amountNanoUsd, ctx.reservation.amountNanoUsd)
    if (store) store.commit(ctx.reservation.id, actual)
  }

  const event: AuditEvent = {
    identity: ctx.identity,
    component: 'tool-gateway',
    status: 'COMPLETED',
    reasonCodes: [],
    evidenceIds: ctx.evidenceId ? [ctx.evidenceId] : [],
    contractVersion: GATEWAY_CONTRACT_VERSION,
    observedAtMs: ctx.observedAtMs,
  }
  const sink = ctx.deps.auditSink as AuditSink | undefined
  if (sink) sink(event)

  return advance(ctx, { audit: event as unknown as Record<string, unknown>, ...(actual !== undefined ? { actualCostNanoUsd: actual } : {}) })
}
