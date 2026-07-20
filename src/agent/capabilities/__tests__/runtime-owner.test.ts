/**
 * G09 / SPEC-086 — Capability runtime & owner metadata tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  RUNTIME_OWNER_CONTRACT_VERSION,
  expectedRuntime,
  checkRuntimeOwner,
  checkAllRuntimeOwner,
  queryRuntimeOwner,
} from '../runtime-owner'
import { CAPABILITIES } from '../store'
import type { Capability } from '../capability.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'cap.ads', key: 'ads', title: 'ads', description: 'ads', status: 'active',
    intents: ['query_ads'], intentClasses: ['question'], toolNames: ['launch_campaign'],
    permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' },
    cost: { tier: 'standard', class: 'metered' },
    runtime: { groups: ['growth'], pools: ['lifestyle'] },
    owner: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    health: { status: 'healthy', killSwitch: false }, ...over,
  }
}

describe('SPEC-086 runtime derived from tools', () => {
  it('expectedRuntime unions tool routing', () => {
    const r = expectedRuntime(['launch_campaign'])
    expect(r.groups).toContain('growth')
    expect(r.pools).toContain('lifestyle')
  })
  it('every capability runtime matches its tools + owner is a valid agent zone', () => {
    expect(checkAllRuntimeOwner()).toEqual([])
  })
})

describe('SPEC-086 mismatch + owner integrity', () => {
  it('a fabricated group is flagged', () => {
    expect(checkRuntimeOwner(cap({ runtime: { groups: ['ghost_group'], pools: ['lifestyle'] } })).some((i) => i.code === 'RUNTIME_GROUPS_MISMATCH')).toBe(true)
  })
  it('a pool not backed by tools is flagged', () => {
    expect(checkRuntimeOwner(cap({ runtime: { groups: ['growth'], pools: ['customer'] } })).some((i) => i.code === 'RUNTIME_POOLS_MISMATCH')).toBe(true)
  })
  it('an ERP owner zone is rejected', () => {
    expect(checkRuntimeOwner(cap({ owner: { team: '@alma/erp', zonePrefix: 'src/app/orders' } })).some((i) => i.code === 'NOT_AGENT_ZONE')).toBe(true)
  })
  it('a wrong team is flagged', () => {
    expect(checkRuntimeOwner(cap({ owner: { team: '@wrong', zonePrefix: 'src/agent/tools' } })).some((i) => i.code === 'TEAM_MISMATCH')).toBe(true)
  })
  it('an integration-only zone is rejected', () => {
    expect(checkRuntimeOwner(cap({ owner: { team: '@alma/architecture', zonePrefix: 'prisma/schema.prisma' } })).some((i) => i.code === 'INTEGRATION_ONLY')).toBe(true)
  })
})

describe('SPEC-086 boundary', () => {
  it('valid capability → COMPLETED', () => {
    const key = CAPABILITIES[0].key
    const r = queryRuntimeOwner({ identity, contractVersion: RUNTIME_OWNER_CONTRACT_VERSION, payload: { capabilityKey: key } })
    expect(r.status).toBe('COMPLETED')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryRuntimeOwner({ identity: { ...identity, tenantId: '' }, contractVersion: RUNTIME_OWNER_CONTRACT_VERSION, payload: { capabilityKey: 'ads' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryRuntimeOwner(null)).not.toThrow()
  })
})
