/**
 * G09 / SPEC-083 — Capability-to-tool mapping tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  TOOL_MAP_CONTRACT_VERSION,
  toolsForCapability,
  capabilitiesForTool,
  checkToolMapping,
  checkAllToolMappings,
  coverage,
  queryToolMap,
} from '../tool-map'
import { ALL_MANIFESTS } from '@/agent/tools/manifests'
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

describe('SPEC-083 tool mapping (live catalog vs G08)', () => {
  it('every capability tool resolves to a real manifest', () => {
    for (const c of CAPABILITIES) expect(checkToolMapping(c)).toEqual([])
  })
  it('the catalog covers every G08 tool exactly once (partition)', () => {
    const cov = coverage()
    expect(cov.totalTools).toBe(326)
    expect(cov.routedTools).toBe(326)
    expect(cov.uncovered).toEqual([])
    expect(cov.duplicated).toEqual([])
  })
  it('whole-set check is clean', () => {
    expect(checkAllToolMappings()).toEqual([])
  })
  it('toolsForCapability returns real manifests', () => {
    const tools = toolsForCapability('ads')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.map((m) => m.name)).toContain('launch_campaign')
  })
  it('capabilitiesForTool reverse-resolves', () => {
    expect(capabilitiesForTool('launch_campaign')).toContain('ads')
  })
})

describe('SPEC-083 fail-closed on phantom tools', () => {
  it('a capability with a non-existent tool is flagged MISSING_TOOL', () => {
    expect(checkToolMapping(cap({ toolNames: ['__ghost_tool__'] })).some((i) => i.code === 'MISSING_TOOL')).toBe(true)
  })
  it('duplicate routing across capabilities is flagged', () => {
    const real = ALL_MANIFESTS[0].name
    const issues = checkAllToolMappings([cap({ key: 'a', id: 'cap.a', toolNames: [real] }), cap({ key: 'b', id: 'cap.b', toolNames: [real] })])
    expect(issues.some((i) => i.code === 'DUPLICATE_ROUTING')).toBe(true)
    expect(issues.some((i) => i.code === 'UNCOVERED_TOOL')).toBe(true)
  })
})

describe('SPEC-083 boundary', () => {
  it('coverage via boundary', () => {
    const r = queryToolMap({ identity, contractVersion: TOOL_MAP_CONTRACT_VERSION, payload: { kind: 'coverage' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'coverage') expect(r.value.report.uncovered).toEqual([])
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryToolMap({ identity: { ...identity, tenantId: '' }, contractVersion: TOOL_MAP_CONTRACT_VERSION, payload: { kind: 'coverage' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryToolMap(null)).not.toThrow()
  })
})
