/**
 * G09 / SPEC-081 — Capability data model tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  CAPABILITY_CONTRACT_VERSION,
  capabilitySchema,
  parseCapability,
  type Capability,
} from '../capability.schema'
import { InMemoryCapabilityStore, capabilityStore, CAPABILITIES } from '../store'
import { queryCapabilities } from '../capability-model'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function base(): Capability {
  return {
    id: 'cap.finance', key: 'finance', title: 'finance', description: 'finance tools', status: 'active',
    intents: ['query_finance', 'manage_finance'], intentClasses: ['command', 'task', 'question'],
    toolNames: ['get_wallet_balance'],
    permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' },
    cost: { tier: 'standard', class: 'metered' },
    runtime: { groups: ['finance'], pools: ['lifestyle'] },
    owner: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    health: { status: 'healthy', killSwitch: false },
  }
}

describe('SPEC-081 catalog integrity', () => {
  it('63 capabilities, all valid, keys unique + sorted', () => {
    expect(CAPABILITIES.length).toBe(63)
    for (const c of CAPABILITIES) expect(() => capabilitySchema.parse(c)).not.toThrow()
    const keys = CAPABILITIES.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([...keys].sort())
  })
  it('every capability id equals cap.<key> and has >=1 tool/intent/class', () => {
    for (const c of CAPABILITIES) {
      expect(c.id).toBe(`cap.${c.key}`)
      expect(c.toolNames.length).toBeGreaterThan(0)
      expect(c.intents.length).toBeGreaterThan(0)
      expect(c.intentClasses.length).toBeGreaterThan(0)
    }
  })
  it('store resolves by id and key', () => {
    expect(capabilityStore.getByKey('finance')?.id).toBe('cap.finance')
    expect(capabilityStore.get('cap.finance')?.key).toBe('finance')
    expect(capabilityStore.get('cap.__nope__')).toBeUndefined()
  })
})

describe('SPEC-081 schema validation', () => {
  it('accepts a well-formed capability', () => {
    expect(() => parseCapability(base())).not.toThrow()
  })
  it('rejects id/key mismatch', () => {
    expect(capabilitySchema.safeParse({ ...base(), id: 'cap.wrong' }).success).toBe(false)
  })
  it('rejects empty tools/intents', () => {
    expect(capabilitySchema.safeParse({ ...base(), toolNames: [] }).success).toBe(false)
    expect(capabilitySchema.safeParse({ ...base(), intents: [] }).success).toBe(false)
  })
  it('rejects a disabled capability that still reports healthy', () => {
    expect(capabilitySchema.safeParse({ ...base(), status: 'disabled' }).success).toBe(false)
  })
  it('rejects duplicate tool names', () => {
    expect(capabilitySchema.safeParse({ ...base(), toolNames: ['a', 'a'] }).success).toBe(false)
  })
  it('rejects an unknown intent class', () => {
    expect(capabilitySchema.safeParse({ ...base(), intentClasses: ['telepathy'] }).success).toBe(false)
  })
})

describe('SPEC-081 store fails closed on corruption', () => {
  it('throws on a duplicate id/key', () => {
    expect(() => new InMemoryCapabilityStore([base(), base()])).toThrow()
  })
  it('throws on a schema-invalid capability', () => {
    expect(() => new InMemoryCapabilityStore([{ id: 'x' }])).toThrow()
  })
})

describe('SPEC-081 identity-enforced boundary', () => {
  it('count returns 63', () => {
    const r = queryCapabilities({ identity, contractVersion: CAPABILITY_CONTRACT_VERSION, payload: { kind: 'count' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'count') expect(r.value.count).toBe(63)
  })
  it('getByKey resolves a capability', () => {
    const r = queryCapabilities({ identity, contractVersion: CAPABILITY_CONTRACT_VERSION, payload: { kind: 'getByKey', key: 'finance' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'get') expect(r.value.capability?.id).toBe('cap.finance')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryCapabilities({ identity: { ...identity, tenantId: '' }, contractVersion: CAPABILITY_CONTRACT_VERSION, payload: { kind: 'count' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryCapabilities(null)).not.toThrow()
  })
  it('contract-version mismatch rejected', () => {
    const r = queryCapabilities({ identity, contractVersion: '9.9.9', payload: { kind: 'count' } })
    expect(r.status).toBe('FAILED_FINAL')
  })
})
