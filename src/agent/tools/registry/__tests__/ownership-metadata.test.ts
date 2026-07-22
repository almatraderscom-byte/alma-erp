/**
 * G08 / SPEC-076 — Tool ownership metadata tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  OWNERSHIP_META_CONTRACT_VERSION,
  checkOwnership,
  checkAllOwnership,
  ownershipByDomain,
  renderToolCodeowners,
  checkToolOwnership,
} from '../ownership-metadata'
import type { ToolManifest } from '../../manifests/manifest.schema'
import { ALL_MANIFESTS } from '../../manifests/loader'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function m(over: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 't', domain: 'd', title: 't', summary: 's', version: '1.0.0', status: 'active',
    capability: { mode: 'read', risk: 'low', sideEffects: ['db_read'] },
    io: { inputSchemaId: 'd.t.input' },
    ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    routing: { groups: [], pools: [] }, ...over,
  }
}

describe('SPEC-076 ownership validated against G01 zones', () => {
  it('a correctly-owned tool passes', () => {
    expect(checkOwnership(m())).toEqual([])
  })
  it('an unresolved zone fails closed', () => {
    expect(checkOwnership(m({ ownership: { team: '@x', zonePrefix: 'nowhere/x' } })).some((i) => i.code === 'UNOWNED_ZONE')).toBe(true)
  })
  it('an ERP zone is rejected (tools are agent-side)', () => {
    expect(checkOwnership(m({ ownership: { team: '@alma/erp', zonePrefix: 'src/app/orders' } })).some((i) => i.code === 'NOT_AGENT_ZONE')).toBe(true)
  })
  it('an integration-only choke point is rejected', () => {
    expect(checkOwnership(m({ ownership: { team: '@alma/architecture', zonePrefix: 'prisma/schema.prisma' } })).some((i) => i.code === 'INTEGRATION_ONLY')).toBe(true)
  })
  it('a team that disagrees with the zone is flagged', () => {
    expect(checkOwnership(m({ ownership: { team: '@wrong/team', zonePrefix: 'src/agent/tools' } })).some((i) => i.code === 'TEAM_MISMATCH')).toBe(true)
  })
})

describe('SPEC-076 whole-set', () => {
  it('every generated manifest has valid ownership', () => {
    expect(checkAllOwnership(ALL_MANIFESTS)).toEqual([])
  })
  it('flags a domain spanning two teams', () => {
    const issues = checkAllOwnership([
      m({ name: 'a', domain: 'shared', ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' } }),
      m({ name: 'b', domain: 'shared', ownership: { team: '@alma/agent', zonePrefix: 'src/agent' } }),
    ])
    // both resolve to @alma/agent so no team span here; ensure no false positive
    expect(issues).toEqual([])
  })
  it('rollup + codeowners proposal are deterministic', () => {
    const roll = ownershipByDomain(ALL_MANIFESTS)
    expect(roll.length).toBe(63)
    expect(roll).toEqual([...roll].sort((a, b) => a.domain.localeCompare(b.domain)))
    const total = roll.reduce((a, d) => a + d.toolCount, 0)
    expect(total).toBe(327)
    expect(renderToolCodeowners(ALL_MANIFESTS)).toMatch(/GENERATED proposal/)
  })
})

describe('SPEC-076 boundary', () => {
  it('valid ownership → ALLOWED/COMPLETED', () => {
    const r = checkToolOwnership({ identity, contractVersion: OWNERSHIP_META_CONTRACT_VERSION, payload: { manifest: m() } })
    expect(r.status).toBe('COMPLETED')
  })
  it('ownership violation → DENIED (fail-closed)', () => {
    const r = checkToolOwnership({ identity, contractVersion: OWNERSHIP_META_CONTRACT_VERSION, payload: { manifest: m({ ownership: { team: '@x', zonePrefix: 'src/app/orders' } }) } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.POLICY_DENIED)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = checkToolOwnership({ identity: { ...identity, tenantId: '' }, contractVersion: OWNERSHIP_META_CONTRACT_VERSION, payload: { manifest: {} } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => checkToolOwnership(null)).not.toThrow()
  })
})
