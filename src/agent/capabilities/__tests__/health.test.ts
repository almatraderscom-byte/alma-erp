/**
 * G09 / SPEC-087 — Capability health model tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  HEALTH_CONTRACT_VERSION,
  nextHealth,
  isAvailable,
  effectiveHealth,
  InMemoryHealthOverrideStore,
  checkAllHealthMetadata,
  queryHealth,
} from '../health'
import { CAPABILITIES } from '../store'
import type { Capability, CapabilityHealth } from '../capability.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const H = (over: Partial<CapabilityHealth> = {}): CapabilityHealth => ({ status: 'healthy', killSwitch: false, ...over })

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'cap.x', key: 'x', title: 'x', description: 'x', status: 'active',
    intents: ['query_x'], intentClasses: ['question'], toolNames: ['t'],
    permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' },
    cost: { tier: 'light', class: 'free' }, runtime: { groups: [], pools: [] },
    owner: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    health: H(), ...over,
  }
}

describe('SPEC-087 availability is fail-closed', () => {
  it('healthy → available', () => expect(isAvailable(H())).toBe(true))
  it('degraded → still available', () => expect(isAvailable(H({ status: 'degraded' }))).toBe(true))
  it('disabled → unavailable', () => expect(isAvailable(H({ status: 'disabled' }))).toBe(false))
  it('kill-switched → unavailable even if healthy', () => expect(isAvailable(H({ killSwitch: true }))).toBe(false))
  it('unknown state → unavailable', () => expect(isAvailable({ status: 'weird' as never, killSwitch: false })).toBe(false))
})

describe('SPEC-087 transitions', () => {
  it('degrade / disable / kill / restore', () => {
    expect(nextHealth(H(), 'degrade').status).toBe('degraded')
    expect(nextHealth(H(), 'disable').status).toBe('disabled')
    expect(nextHealth(H(), 'kill').killSwitch).toBe(true)
    expect(nextHealth(H({ status: 'disabled', killSwitch: true }), 'restore')).toEqual({ status: 'healthy', killSwitch: false })
  })
  it('ok does not clear a kill-switch', () => {
    expect(nextHealth(H({ killSwitch: true, status: 'degraded' }), 'ok').killSwitch).toBe(true)
  })
})

describe('SPEC-087 override store', () => {
  it('override wins over the catalog health', () => {
    const store = new InMemoryHealthOverrideStore()
    const c = cap()
    expect(effectiveHealth(c, store)).toEqual(c.health)
    store.set(c.key, H({ killSwitch: true }))
    expect(isAvailable(effectiveHealth(c, store))).toBe(false)
    store.clear(c.key)
    expect(isAvailable(effectiveHealth(c, store))).toBe(true)
  })
})

describe('SPEC-087 catalog integrity', () => {
  it('every capability has consistent health metadata', () => {
    expect(checkAllHealthMetadata()).toEqual([])
  })
})

describe('SPEC-087 boundary', () => {
  it('isAvailable via boundary', () => {
    const key = CAPABILITIES[0].key
    const r = queryHealth({ identity, contractVersion: HEALTH_CONTRACT_VERSION, payload: { kind: 'isAvailable', capabilityKey: key } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'isAvailable') expect(r.value.available).toBe(true)
  })
  it('transition via boundary', () => {
    const r = queryHealth({ identity, contractVersion: HEALTH_CONTRACT_VERSION, payload: { kind: 'transition', status: 'healthy', killSwitch: false, signal: 'kill' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'transition') expect(r.value.next.killSwitch).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryHealth({ identity: { ...identity, tenantId: '' }, contractVersion: HEALTH_CONTRACT_VERSION, payload: { kind: 'isAvailable', capabilityKey: 'x' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryHealth(null)).not.toThrow()
  })
})
