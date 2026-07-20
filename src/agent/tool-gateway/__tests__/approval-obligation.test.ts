/**
 * G13 / SPEC-126 — Approval / obligation stage tests (against the frozen G12 seam).
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  approvalObligationStage,
  applyViewObligations,
  type AutonomyEngine,
  type AutonomyState,
} from '../stages/approval-obligation'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }

function engineOf(state: AutonomyState, approvalRequestId?: string): AutonomyEngine {
  return { decide: () => ({ status: 'COMPLETED', value: { state, approvalRequestId }, evidenceIds: [], versions: {} }) }
}
const denyingEngine: AutonomyEngine = { decide: () => ({ status: 'DENIED', reasonCodes: [REASON_CODES.POLICY_DENIED], evidenceIds: [] }) }

function ctx(deps: GatewayDeps, over: Partial<GatewayContext> = {}): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 't', args: {}, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 0, deps, obligations: [], ...over }
}
const deps = (over: Partial<GatewayDeps> = {}): GatewayDeps => ({ adapter, observedAtMs: 0, ...over })

describe('SPEC-126 autonomy decision', () => {
  it('AUTONOMOUS → advance', () => {
    expect(approvalObligationStage(ctx(deps({ autonomyEngine: engineOf('AUTONOMOUS') }))).status).toBe('COMPLETED')
  })
  it('NEEDS_APPROVAL → returns NEEDS_APPROVAL, does NOT execute', () => {
    const r = approvalObligationStage(ctx(deps({ autonomyEngine: engineOf('NEEDS_APPROVAL', 'appr_1') })))
    expect(r.status).toBe('NEEDS_APPROVAL')
    if (!isSuccess(r)) {
      expect(r.reasonCodes).toContain(REASON_CODES.APPROVAL_REQUIRED)
      expect(r.approvalRequestId).toBe('appr_1')
    }
  })
  it('DENIED decision propagates verbatim', () => {
    expect(approvalObligationStage(ctx(deps({ autonomyEngine: denyingEngine }))).status).toBe('DENIED')
  })
  it('no engine ⇒ NEEDS_APPROVAL (fail-closed)', () => {
    expect(approvalObligationStage(ctx(deps())).status).toBe('NEEDS_APPROVAL')
  })
  it('never throws', () => {
    expect(() => approvalObligationStage(ctx(deps({ autonomyEngine: engineOf('AUTONOMOUS') })))).not.toThrow()
  })
})

describe('SPEC-126 obligation application (G11 redact/mask)', () => {
  it('redacts a path in the view', () => {
    const view = applyViewObligations({ customer: { phone: '01700', name: 'X' } }, ['redact:customer.phone'])
    expect((view as any).customer.phone).toBe('[REDACTED]')
    expect((view as any).customer.name).toBe('X')
  })
  it('masks a path keeping last chars', () => {
    const view = applyViewObligations({ card: '4111111111111111' }, ['mask:card:4'])
    expect((view as any).card.endsWith('1111')).toBe(true)
    expect((view as any).card).not.toBe('4111111111111111')
  })
  it('no obligations → view unchanged', () => {
    const v = { a: 1 }
    expect(applyViewObligations(v, [])).toEqual(v)
  })
})
