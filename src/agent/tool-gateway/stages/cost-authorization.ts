/**
 * G13 / SPEC-125 — Cost authorization stage.
 *
 * Before ANY spend, the gateway reserves the worst-case cost against the G04 Cost
 * Governor budget. A reservation that would exceed the budget returns null → the
 * gateway stops with BUDGET_EXCEEDED and NO tool executes. The reservation id is
 * carried forward so the finalization stage (SPEC-129) can reconcile actual usage
 * (commit) or release it if the call did not happen.
 *
 * Fail-closed (INV-05): a paid call with no budget store / no budget configured
 * cannot be authorized → BUDGET_EXCEEDED. A free call (estimated cost 0) needs no
 * reservation and advances. Deterministic (INV-01): the budget store is in-memory
 * arithmetic, injected as a seam.
 */
import { REASON_CODES } from '@/agent/contracts'
import type { Budget, BudgetStore } from '@/agent/budgets/budget'
import { advance, stop, type GatewayStage } from '../contract'

export const costAuthorizationStage: GatewayStage = (ctx) => {
  const estimated = ctx.estimatedCostNanoUsd
  if (estimated <= 0) return advance(ctx) // free call — no spend to authorize

  const store = ctx.deps.budgetStore as BudgetStore | undefined
  const budget = ctx.deps.budget as Budget | undefined
  // Fail-closed: a paid call with no governor cannot be authorized.
  if (!store || !budget) return stop('BUDGET_EXCEEDED', [REASON_CODES.BUDGET_EXCEEDED])

  const reservation = store.reserve(budget, estimated)
  if (!reservation) return stop('BUDGET_EXCEEDED', [REASON_CODES.BUDGET_EXCEEDED])

  return advance(ctx, { reservation: { id: reservation.id, amountNanoUsd: reservation.amountNanoUsd } })
}
