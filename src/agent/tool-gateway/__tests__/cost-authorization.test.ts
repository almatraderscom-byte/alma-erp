/**
 * G13 / SPEC-125 — Cost authorization stage tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import { InMemoryBudgetStore, type Budget } from '@/agent/budgets/budget'
import { costAuthorizationStage } from '../stages/cost-authorization'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }
const budget: Budget = { scope: 'turn', key: 'turn:c', limitNanoUsd: 1_000_000 }

function deps(over: Partial<GatewayDeps> = {}): GatewayDeps {
  return { adapter, observedAtMs: 0, ...over }
}
function ctx(d: GatewayDeps, estimatedCostNanoUsd: number): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 'send', args: {}, action: 'a.b', estimatedCostNanoUsd, observedAtMs: 0, deps: d }
}

describe('SPEC-125 cost authorization (reserve before spend)', () => {
  it('free call (cost 0) advances with no reservation', () => {
    const r = costAuthorizationStage(ctx(deps(), 0))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.reservation).toBeUndefined()
  })
  it('paid call within budget reserves + carries the reservation forward', () => {
    const store = new InMemoryBudgetStore()
    const r = costAuthorizationStage(ctx(deps({ budgetStore: store, budget }), 500_000))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.reservation?.amountNanoUsd).toBe(500_000)
      expect(store.available(budget)).toBe(500_000) // reserved
    }
  })
  it('over-budget call → BUDGET_EXCEEDED (no reservation)', () => {
    const store = new InMemoryBudgetStore()
    const r = costAuthorizationStage(ctx(deps({ budgetStore: store, budget }), 2_000_000))
    expect(r.status).toBe('BUDGET_EXCEEDED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.BUDGET_EXCEEDED)
  })
  it('paid call with no governor → BUDGET_EXCEEDED (fail-closed)', () => {
    const r = costAuthorizationStage(ctx(deps(), 100))
    expect(r.status).toBe('BUDGET_EXCEEDED')
  })
  it('never throws', () => {
    expect(() => costAuthorizationStage(ctx(deps(), 100))).not.toThrow()
  })
})
