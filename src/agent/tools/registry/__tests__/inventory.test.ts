/**
 * G08 / SPEC-071 — Inventory contract + snapshot tests.
 */
import { describe, it, expect } from 'vitest'
import { COMPONENT_CONTRACT_VERSION, REASON_CODES, isSuccess, type ExecutionIdentity } from '@/agent/contracts'
import {
  INVENTORY_CONTRACT_VERSION,
  TOOL_INVENTORY,
  getTool,
  hasTool,
  toolsByDomain,
  toolsByMode,
  toolsByRisk,
  toolsByGroup,
  toolsByPool,
  distinctDomains,
  summarize,
  queryInventory,
} from '../inventory'
import { inventoryRowSchema } from '../inventory.schema'

const identity: ExecutionIdentity = {
  tenantId: 'alma',
  actorId: 'owner',
  workflowId: 'wf-1',
  stepId: 'step-1',
  correlationId: 'corr-1',
}

function req(payload: unknown, overrides: Partial<Record<string, unknown>> = {}) {
  return { identity, contractVersion: INVENTORY_CONTRACT_VERSION, payload, ...overrides }
}

describe('SPEC-071 inventory snapshot integrity', () => {
  it('captured the full monolith surface (326 tools, all classified + pooled)', () => {
    expect(TOOL_INVENTORY.length).toBe(326)
    const s = summarize()
    expect(s.total).toBe(326)
    expect(s.unclassified).toEqual([])
    expect(s.unpooled).toEqual([])
    // Mode/risk partitions sum to the whole.
    const modeSum = Object.values(s.byMode).reduce((a, b) => a + b, 0)
    const riskSum = Object.values(s.byRisk).reduce((a, b) => a + b, 0)
    expect(modeSum).toBe(326)
    expect(riskSum).toBe(326)
    // Known-good shape from the baseline measurement.
    expect(s.byMode).toEqual({ read: 178, stage: 61, write: 87 })
    expect(s.byRisk).toEqual({ low: 240, medium: 56, high: 30 })
  })

  it('every row validates against the row schema', () => {
    for (const r of TOOL_INVENTORY) expect(() => inventoryRowSchema.parse(r)).not.toThrow()
  })

  it('names are unique and sorted', () => {
    const names = TOOL_INVENTORY.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([...names].sort())
  })

  it('exposes the 63 distinct domains', () => {
    expect(distinctDomains()).toContain('finance')
    expect(distinctDomains().length).toBeGreaterThanOrEqual(60)
  })
})

describe('SPEC-071 plain query helpers', () => {
  it('get / has resolve a known tool', () => {
    expect(hasTool('save_memory')).toBe(true)
    expect(getTool('save_memory')?.mode).toBe('write')
    expect(getTool('__nope__')).toBeUndefined()
  })

  it('partition helpers are consistent with the snapshot', () => {
    expect(toolsByMode('read').length).toBe(178)
    expect(toolsByRisk('high').length).toBe(30)
    expect(toolsByDomain('finance').every((r) => r.domain === 'finance')).toBe(true)
    expect(toolsByGroup('base').every((r) => r.groups.includes('base'))).toBe(true)
    expect(toolsByPool('customer').every((r) => r.pools.includes('customer'))).toBe(true)
  })
})

describe('SPEC-071 identity-enforced boundary', () => {
  it('returns COMPLETED for a valid get', () => {
    const r = queryInventory(req({ kind: 'get', name: 'save_memory' }))
    expect(r.status).toBe('COMPLETED')
    if (r.status === 'COMPLETED' && r.value.kind === 'get') {
      expect(r.value.row?.name).toBe('save_memory')
      expect(r.versions.inventory).toBe(INVENTORY_CONTRACT_VERSION)
    }
  })

  it('summary query rolls up deterministically', () => {
    const r = queryInventory(req({ kind: 'summary' }))
    expect(r.status).toBe('COMPLETED')
    if (r.status === 'COMPLETED' && r.value.kind === 'summary') {
      expect(r.value.summary.total).toBe(326)
    }
  })

  it('missing tenant fails closed with MISSING_TENANT', () => {
    const bad = { ...req({ kind: 'summary' }), identity: { ...identity, tenantId: '' } }
    const r = queryInventory(bad)
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) {
      expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    }
  })

  it('missing actor fails closed with MISSING_ACTOR', () => {
    const bad = { ...req({ kind: 'summary' }), identity: { ...identity, actorId: '' } }
    const r = queryInventory(bad)
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) {
      expect(r.reasonCodes).toContain(REASON_CODES.MISSING_ACTOR)
    }
  })

  it('malformed payload fails closed', () => {
    const r = queryInventory(req({ kind: 'not_a_kind' }))
    expect(r.status).toBe('FAILED_FINAL')
  })

  it('contract-version mismatch is rejected', () => {
    const r = queryInventory(req({ kind: 'summary' }, { contractVersion: '9.9.9' }))
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) {
      expect(r.reasonCodes).toContain(REASON_CODES.CONTRACT_VERSION_MISMATCH)
    }
  })

  it('never throws across the boundary (null / garbage input)', () => {
    expect(() => queryInventory(null)).not.toThrow()
    expect(() => queryInventory(42)).not.toThrow()
    expect(queryInventory(null).status).toBe('FAILED_FINAL')
  })

  it('the inventory contract version matches the frozen component version', () => {
    expect(INVENTORY_CONTRACT_VERSION).toBe(COMPONENT_CONTRACT_VERSION)
  })
})
