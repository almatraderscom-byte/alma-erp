/**
 * G08 / SPEC-075 — Risk & side-effect classification tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  RISK_CONTRACT_VERSION,
  SIDE_EFFECT_POLICY,
  classifyManifest,
  checkClassification,
  checkAllClassifications,
  classifyToolRisk,
} from '../risk-classification'
import { SIDE_EFFECT_KINDS, type ToolManifest } from '../../manifests/manifest.schema'
import { ALL_MANIFESTS } from '../../manifests/loader'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function m(over: Partial<ToolManifest> & { capability: ToolManifest['capability'] }): ToolManifest {
  return {
    name: 't', domain: 'd', title: 't', summary: 's', version: '1.0.0', status: 'active',
    io: { inputSchemaId: 'd.t.input' }, ownership: { team: '@x', zonePrefix: 'src/agent/tools' },
    routing: { groups: [], pools: [] }, ...over,
  }
}

describe('SPEC-075 policy table', () => {
  it('covers every side-effect kind', () => {
    for (const k of SIDE_EFFECT_KINDS) expect(SIDE_EFFECT_POLICY[k]).toBeDefined()
  })
  it('external effects require the gateway (INV-04)', () => {
    expect(SIDE_EFFECT_POLICY.external_message.requiresGateway).toBe(true)
    expect(SIDE_EFFECT_POLICY.external_api_write.requiresGateway).toBe(true)
    expect(SIDE_EFFECT_POLICY.money_movement.requiresGateway).toBe(true)
    expect(SIDE_EFFECT_POLICY.browser_action.requiresGateway).toBe(true)
  })
  it('model invocation requires cost authorization (INV-03)', () => {
    expect(SIDE_EFFECT_POLICY.model_invocation.requiresCostAuth).toBe(true)
  })
  it('internal effects need neither gateway nor cost auth', () => {
    for (const k of ['none', 'db_read', 'db_write', 'file_write', 'schedule'] as const) {
      expect(SIDE_EFFECT_POLICY[k].requiresGateway).toBe(false)
      expect(SIDE_EFFECT_POLICY[k].requiresCostAuth).toBe(false)
    }
  })
})

describe('SPEC-075 classifyManifest', () => {
  it('read tool: no approval, no gateway', () => {
    const p = classifyManifest(m({ capability: { mode: 'read', risk: 'low', sideEffects: ['db_read'] } }))
    expect(p.requiresApproval).toBe(false)
    expect(p.requiresGateway).toBe(false)
    expect(p.external).toBe(false)
  })
  it('staged tool always requires approval (INV-05)', () => {
    const p = classifyManifest(m({ capability: { mode: 'stage', risk: 'low', sideEffects: ['db_write'] } }))
    expect(p.requiresApproval).toBe(true)
  })
  it('money movement forces high risk + gateway + reconciliation', () => {
    const p = classifyManifest(m({ capability: { mode: 'write', risk: 'high', sideEffects: ['db_write', 'money_movement'] } }))
    expect(p.effectiveRisk).toBe('high')
    expect(p.requiresGateway).toBe(true)
    expect(p.requiresReconciliation).toBe(true)
    expect(p.requiresApproval).toBe(true)
  })
  it('external message → reconciliation (INV-06)', () => {
    const p = classifyManifest(m({ capability: { mode: 'write', risk: 'medium', sideEffects: ['db_write', 'external_message'] } }))
    expect(p.requiresReconciliation).toBe(true)
    expect(p.external).toBe(true)
  })
  it('low-risk write needs no approval', () => {
    const p = classifyManifest(m({ capability: { mode: 'write', risk: 'low', sideEffects: ['db_write'] } }))
    expect(p.requiresApproval).toBe(false)
  })
})

describe('SPEC-075 consistency enforcement', () => {
  it('read with a write effect is flagged', () => {
    const issues = checkClassification(m({ capability: { mode: 'read', risk: 'low', sideEffects: ['db_write'] } }))
    expect(issues.some((i) => i.code === 'READ_HAS_WRITE_EFFECT')).toBe(true)
  })
  it('write with only read effect is flagged', () => {
    const issues = checkClassification(m({ capability: { mode: 'write', risk: 'low', sideEffects: ['db_read'] } }))
    expect(issues.some((i) => i.code === 'WRITE_HAS_NO_EFFECT')).toBe(true)
  })
  it('money movement not high is flagged', () => {
    const issues = checkClassification(m({ capability: { mode: 'write', risk: 'medium', sideEffects: ['money_movement'] } }))
    expect(issues.some((i) => i.code === 'MONEY_NOT_HIGH')).toBe(true)
  })
})

describe('SPEC-075 whole-set integration (SPEC-073 seeds are consistent)', () => {
  it('every generated manifest passes classification consistency', () => {
    const issues = checkAllClassifications(ALL_MANIFESTS)
    expect(issues).toEqual([])
  })
})

describe('SPEC-075 boundary', () => {
  it('classifies through the identity boundary', () => {
    const r = classifyToolRisk({ identity, contractVersion: RISK_CONTRACT_VERSION, payload: { manifest: m({ capability: { mode: 'stage', risk: 'high', sideEffects: ['db_write', 'external_api_write'] } }) } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.requiresApproval && r.value.requiresGateway).toBe(true)
  })
  it('inconsistent manifest fails closed', () => {
    const r = classifyToolRisk({ identity, contractVersion: RISK_CONTRACT_VERSION, payload: { manifest: m({ capability: { mode: 'read', risk: 'low', sideEffects: ['money_movement'] } }) } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = classifyToolRisk({ identity: { ...identity, tenantId: '' }, contractVersion: RISK_CONTRACT_VERSION, payload: { manifest: {} } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => classifyToolRisk(null)).not.toThrow()
  })
})
