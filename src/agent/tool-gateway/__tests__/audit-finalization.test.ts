/**
 * G13 / SPEC-129 — Audit + cost finalization tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type AuditEvent, type ExecutionIdentity } from '@/agent/contracts'
import { InMemoryBudgetStore, type Budget } from '@/agent/budgets/budget'
import { auditFinalizationStage, type AuditSink } from '../stages/audit-finalization'
import { runPipeline, advance, stop, GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps, type GatewayStage } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'corr-a' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }
const budget: Budget = { scope: 'turn', key: 'turn:corr-a', limitNanoUsd: 1_000_000 }

function mkCtx(deps: GatewayDeps, over: Partial<GatewayContext> = {}): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 't', args: {}, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 9, deps, evidenceId: 'ev_1', ...over }
}

describe('SPEC-129 cost finalization', () => {
  it('commits actual cost (clamped to reserved) to the ledger', () => {
    const store = new InMemoryBudgetStore()
    const reservation = store.reserve(budget, 500_000)!
    const ctx = mkCtx({ adapter, observedAtMs: 9, budgetStore: store }, { reservation: { id: reservation.id, amountNanoUsd: 500_000 }, actualCostNanoUsd: 300_000 })
    const r = auditFinalizationStage(ctx)
    expect(r.status).toBe('COMPLETED')
    // spent 300k, reservation released → available back to limit - 300k
    expect(store.available(budget)).toBe(700_000)
  })
  it('clamps an over-actual to the reserved amount', () => {
    const store = new InMemoryBudgetStore()
    const reservation = store.reserve(budget, 100_000)!
    const ctx = mkCtx({ adapter, observedAtMs: 9, budgetStore: store }, { reservation: { id: reservation.id, amountNanoUsd: 100_000 }, actualCostNanoUsd: 999_999 })
    auditFinalizationStage(ctx)
    expect(store.available(budget)).toBe(900_000) // committed 100k (clamped), not 999_999
  })
})

describe('SPEC-129 audit event', () => {
  it('emits exactly one audit event with exact identity correlation', () => {
    const events: AuditEvent[] = []
    const sink: AuditSink = (e) => events.push(e)
    const r = auditFinalizationStage(mkCtx({ adapter, observedAtMs: 9, auditSink: sink }))
    expect(events.length).toBe(1)
    expect(events[0].identity).toEqual(identity)
    expect(events[0].component).toBe('tool-gateway')
    expect(events[0].evidenceIds).toContain('ev_1')
    expect(events[0].observedAtMs).toBe(9)
    if (isSuccess(r)) expect((r.value.audit as any).component).toBe('tool-gateway')
  })
})

describe('SPEC-129 reservation release safety-net (abort path)', () => {
  it('releases a reservation when a later stage aborts (no leak)', () => {
    const store = new InMemoryBudgetStore()
    const reserveStage: GatewayStage = (c) => {
      const res = store.reserve(budget, 400_000)!
      return advance(c, { reservation: { id: res.id, amountNanoUsd: 400_000 } })
    }
    const failStage: GatewayStage = () => stop('DENIED', [REASON_CODES.POLICY_DENIED])
    const ctx = mkCtx({ adapter, observedAtMs: 9, budgetStore: store })
    expect(store.available(budget)).toBe(1_000_000)
    const r = runPipeline(ctx, [reserveStage, failStage])
    expect(r.status).toBe('DENIED')
    expect(store.available(budget)).toBe(1_000_000) // reservation released, not leaked
  })
})
