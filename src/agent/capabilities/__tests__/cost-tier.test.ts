/**
 * G09 / SPEC-085 — Capability cost & model-tier metadata tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  COST_TIER_CONTRACT_VERSION,
  TIER_HINTS,
  expectedTier,
  expectedClass,
  tierHintFor,
  checkCostMetadata,
  checkAllCostMetadata,
  queryCostTier,
} from '../cost-tier'
import { capabilityStore, CAPABILITIES } from '../store'
import type { Capability } from '../capability.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'cap.x', key: 'x', title: 'x', description: 'x', status: 'active',
    intents: ['query_x'], intentClasses: ['question'], toolNames: ['launch_campaign'],
    permission: { scope: 'owner', minRole: 'owner', defaultDecision: 'deny' },
    cost: { tier: 'standard', class: 'metered' }, runtime: { groups: [], pools: [] },
    owner: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    health: { status: 'healthy', killSwitch: false }, ...over,
  }
}

describe('SPEC-085 tier derivation from real tools', () => {
  it('external tool (launch_campaign) → standard', () => {
    expect(expectedTier(['launch_campaign'])).toBe('standard')
  })
  it('class tracks tier', () => {
    expect(expectedClass('heavy')).toBe('premium')
    expect(expectedClass('standard')).toBe('metered')
    expect(expectedClass('light')).toBe('free')
  })
  it('tier hints never silently upgrade — cheap/mid/premium ordered by USD', () => {
    expect(TIER_HINTS.light.maxUsdPerCall).toBeLessThan(TIER_HINTS.standard.maxUsdPerCall)
    expect(TIER_HINTS.standard.maxUsdPerCall).toBeLessThan(TIER_HINTS.heavy.maxUsdPerCall)
  })
})

describe('SPEC-085 whole-set consistency (SPEC-081 seed vs SPEC-085 authority)', () => {
  it('every capability tier/class matches its tools', () => {
    expect(checkAllCostMetadata()).toEqual([])
  })
})

describe('SPEC-085 mismatch detection', () => {
  it('a wrong tier is flagged', () => {
    const bad = cap({ cost: { tier: 'light', class: 'free' }, toolNames: ['launch_campaign'] })
    expect(checkCostMetadata(bad).some((i) => i.code === 'TIER_MISMATCH')).toBe(true)
  })
  it('a class not tracking the tier is flagged', () => {
    const bad = cap({ cost: { tier: 'standard', class: 'free' } })
    expect(checkCostMetadata(bad).some((i) => i.code === 'CLASS_MISMATCH')).toBe(true)
  })
})

describe('SPEC-085 boundary', () => {
  it('hint returns the tier + Cost Governor hint', () => {
    const key = CAPABILITIES[0].key
    const r = queryCostTier({ identity, contractVersion: COST_TIER_CONTRACT_VERSION, payload: { kind: 'hint', capabilityKey: key } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'hint') expect(r.value.hint).toEqual(tierHintFor(capabilityStore.getByKey(key)!))
  })
  it('check returns [] for a consistent capability', () => {
    const key = CAPABILITIES[0].key
    const r = queryCostTier({ identity, contractVersion: COST_TIER_CONTRACT_VERSION, payload: { kind: 'check', capabilityKey: key } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'check') expect(r.value.issues).toEqual([])
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryCostTier({ identity: { ...identity, tenantId: '' }, contractVersion: COST_TIER_CONTRACT_VERSION, payload: { kind: 'hint', capabilityKey: 'x' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryCostTier(null)).not.toThrow()
  })
})
