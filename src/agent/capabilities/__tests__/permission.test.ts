/**
 * G09 / SPEC-084 — Capability permission metadata tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  PERMISSION_CONTRACT_VERSION,
  evaluatePermission,
  checkPermissionMetadata,
  checkAllPermissionMetadata,
  authorizeCapability,
} from '../permission'
import { capabilityStore, CAPABILITIES } from '../store'
import type { Capability } from '../capability.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'cap.x', key: 'x', title: 'x', description: 'x', status: 'active',
    intents: ['query_x'], intentClasses: ['question'], toolNames: ['t'],
    permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' },
    cost: { tier: 'light', class: 'free' }, runtime: { groups: [], pools: [] },
    owner: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    health: { status: 'healthy', killSwitch: false }, ...over,
  }
}

describe('SPEC-084 privilege lattice', () => {
  it('owner may invoke an owner-scope capability', () => {
    expect(evaluatePermission(cap({ permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' } }), { roles: ['owner'] }).decision).toBe('allow')
  })
  it('owner may invoke a customer-scope capability (higher privilege)', () => {
    expect(evaluatePermission(cap({ permission: { scope: 'customer', minRole: 'customer', defaultDecision: 'deny' } }), { roles: ['owner'] }).decision).toBe('allow')
  })
  it('customer may NOT invoke an owner-scope capability', () => {
    expect(evaluatePermission(cap(), { roles: ['customer'] }).decision).toBe('deny')
  })
  it('staff may invoke staff + customer, not owner', () => {
    expect(evaluatePermission(cap({ permission: { scope: 'staff', minRole: 'staff', defaultDecision: 'deny' } }), { roles: ['staff'] }).decision).toBe('allow')
    expect(evaluatePermission(cap({ permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' } }), { roles: ['staff'] }).decision).toBe('deny')
  })
})

describe('SPEC-084 fail-closed', () => {
  it('no roles → deny', () => {
    expect(evaluatePermission(cap(), { roles: [] }).decision).toBe('deny')
  })
  it('disabled capability → deny even for owner', () => {
    expect(evaluatePermission(cap({ status: 'disabled', health: { status: 'disabled', killSwitch: false } }), { roles: ['owner'] }).decision).toBe('deny')
  })
  it('kill-switched capability → deny even for owner', () => {
    expect(evaluatePermission(cap({ health: { status: 'degraded', killSwitch: true } }), { roles: ['owner'] }).decision).toBe('deny')
  })
})

describe('SPEC-084 metadata integrity (live catalog)', () => {
  it('every capability declares defaultDecision deny + minRole==scope', () => {
    expect(checkAllPermissionMetadata()).toEqual([])
  })
  it('a non-deny default is flagged', () => {
    const bad = { ...cap(), permission: { scope: 'owner' as const, minRole: 'owner' as const, defaultDecision: 'allow' as unknown as 'deny' } }
    expect(checkPermissionMetadata(bad).some((i) => i.code === 'DEFAULT_NOT_DENY')).toBe(true)
  })
})

describe('SPEC-084 boundary', () => {
  it('owner authorized on a real capability → ALLOWED', () => {
    const key = CAPABILITIES[0].key
    const r = authorizeCapability({ identity, contractVersion: PERMISSION_CONTRACT_VERSION, payload: { capabilityKey: key, actor: { roles: ['owner'] } } })
    expect(r.status).toBe('ALLOWED')
  })
  it('unknown capability → DENIED (fail-closed)', () => {
    const r = authorizeCapability({ identity, contractVersion: PERMISSION_CONTRACT_VERSION, payload: { capabilityKey: '__nope__', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.POLICY_DENIED)
  })
  it('customer on an owner capability → DENIED', () => {
    const owned = capabilityStore.list().find((c) => c.permission.scope === 'owner')!
    const r = authorizeCapability({ identity, contractVersion: PERMISSION_CONTRACT_VERSION, payload: { capabilityKey: owned.key, actor: { roles: ['customer'] } } })
    expect(r.status).toBe('DENIED')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = authorizeCapability({ identity: { ...identity, tenantId: '' }, contractVersion: PERMISSION_CONTRACT_VERSION, payload: { capabilityKey: 'x', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => authorizeCapability(null)).not.toThrow()
  })
})
