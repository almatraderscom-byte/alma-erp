/**
 * G09 / SPEC-082 — Capability-to-intent mapping tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  INTENT_MAP_CONTRACT_VERSION,
  capabilitiesForIntent,
  capabilitiesForClass,
  allIntentKeys,
  checkIntentMapping,
  checkAllIntentMappings,
  queryIntentMap,
} from '../intent-map'
import { CAPABILITIES } from '../store'
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

describe('SPEC-082 intent index (live catalog)', () => {
  it('every capability is reachable by its query_<key> intent', () => {
    for (const c of CAPABILITIES) {
      expect(capabilitiesForIntent(`query_${c.key}`).some((x) => x.key === c.key)).toBe(true)
    }
  })
  it('write-bearing capabilities are reachable by the command class', () => {
    const cmd = capabilitiesForClass('command').map((c) => c.key)
    const finance = CAPABILITIES.find((c) => c.key === 'finance')
    if (finance?.intentClasses.includes('command')) expect(cmd).toContain('finance')
  })
  it('every intent key resolves to at least one capability', () => {
    for (const k of allIntentKeys()) expect(capabilitiesForIntent(k).length).toBeGreaterThan(0)
  })
  it('results are sorted + stable', () => {
    const q = capabilitiesForClass('question').map((c) => c.key)
    expect(q).toEqual([...q].sort())
  })
})

describe('SPEC-082 whole-set consistency', () => {
  it('the generated catalog has no intent-mapping issues', () => {
    expect(checkAllIntentMappings()).toEqual([])
  })
})

describe('SPEC-082 consistency rules', () => {
  it('a manage_ intent without a mutating class is flagged', () => {
    const bad = cap({ intents: ['query_x', 'manage_x'], intentClasses: ['question'] })
    expect(checkIntentMapping(bad).some((i) => i.code === 'MUTATING_INTENT_WITHOUT_CLASS')).toBe(true)
  })
  it('a manage_ intent WITH command class is fine', () => {
    const ok = cap({ intents: ['query_x', 'manage_x'], intentClasses: ['command', 'question'] })
    expect(checkIntentMapping(ok)).toEqual([])
  })
  it('read-only capability with question class is fine', () => {
    expect(checkIntentMapping(cap())).toEqual([])
  })
})

describe('SPEC-082 boundary', () => {
  it('byClass returns capability keys', () => {
    const r = queryIntentMap({ identity, contractVersion: INTENT_MAP_CONTRACT_VERSION, payload: { kind: 'byClass', intentClass: 'question' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'list') expect(r.value.capabilityKeys.length).toBeGreaterThan(0)
  })
  it('byIntent resolves', () => {
    const r = queryIntentMap({ identity, contractVersion: INTENT_MAP_CONTRACT_VERSION, payload: { kind: 'byIntent', intentKey: 'query_finance' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'list') expect(r.value.capabilityKeys).toContain('finance')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryIntentMap({ identity: { ...identity, tenantId: '' }, contractVersion: INTENT_MAP_CONTRACT_VERSION, payload: { kind: 'keys' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryIntentMap(null)).not.toThrow()
  })
})
