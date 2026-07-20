/**
 * G13 / SPEC-123 — Identity validation stage tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import { identityValidationStage } from '../stages/identity-validation'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }
const deps: GatewayDeps = { adapter, observedAtMs: 0 }

function ctx(over: Partial<GatewayContext> = {}, id: ExecutionIdentity = identity): GatewayContext {
  return { identity: id, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 't', args: {}, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 0, deps, ...over }
}

describe('SPEC-123 identity validation (INV-02, fail-closed)', () => {
  it('advances with a full identity', () => {
    expect(identityValidationStage(ctx()).status).toBe('COMPLETED')
  })
  it('DENIES missing tenant / actor / workflow / step / correlation', () => {
    const fields: Array<[keyof ExecutionIdentity, string]> = [
      ['tenantId', REASON_CODES.MISSING_TENANT],
      ['actorId', REASON_CODES.MISSING_ACTOR],
      ['workflowId', REASON_CODES.MISSING_WORKFLOW],
      ['stepId', REASON_CODES.MISSING_STEP],
      ['correlationId', REASON_CODES.MISSING_CORRELATION],
    ]
    for (const [f, code] of fields) {
      const r = identityValidationStage(ctx({}, { ...identity, [f]: '' }))
      expect(r.status).toBe('DENIED')
      if (!isSuccess(r)) expect(r.reasonCodes).toContain(code)
    }
  })
  it('DENIES a cross-tenant target (CROSS_TENANT)', () => {
    const r = identityValidationStage(ctx({ resourceTenantId: 'other-tenant' }))
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.CROSS_TENANT)
  })
  it('allows a matching resource tenant', () => {
    expect(identityValidationStage(ctx({ resourceTenantId: 'alma' })).status).toBe('COMPLETED')
  })
  it('never throws', () => {
    expect(() => identityValidationStage(ctx())).not.toThrow()
  })
})
