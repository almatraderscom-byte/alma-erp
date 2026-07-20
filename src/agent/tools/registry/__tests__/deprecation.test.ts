/**
 * G08 / SPEC-078 — Deprecation & migration tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  DEPRECATION_CONTRACT_VERSION,
  callability,
  resolveMigration,
  checkDeprecation,
  checkAllDeprecations,
  queryDeprecation,
} from '../deprecation'
import type { ToolManifest } from '../../manifests/manifest.schema'
import { ALL_MANIFESTS } from '../../manifests/loader'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function m(name: string, over: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name, domain: 'd', title: name, summary: 's', version: '1.0.0', status: 'active',
    capability: { mode: 'read', risk: 'low', sideEffects: ['db_read'] },
    io: { inputSchemaId: `d.${name}.input` },
    ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    routing: { groups: [], pools: [] }, ...over,
  }
}
const dep = (over: Partial<ToolManifest>): ToolManifest => m('old', { status: 'deprecated', deprecation: { since: '1.1.0' }, ...over })

describe('SPEC-078 callability', () => {
  it('active/preview callable', () => {
    expect(callability(m('a')).callable).toBe(true)
    expect(callability(m('a', { status: 'preview' })).callable).toBe(true)
  })
  it('deprecated callable with a warning', () => {
    const c = callability(dep({ deprecation: { since: '1.1.0', replacedBy: 'new' } }))
    expect(c.callable).toBe(true)
    expect(c.warning).toMatch(/deprecated/)
    expect(c.replacedBy).toBe('new')
  })
  it('removed is NOT callable (fail-closed) and points at the replacement', () => {
    const c = callability(m('old', { status: 'removed', deprecation: { since: '1.1.0', replacedBy: 'new' } }))
    expect(c.callable).toBe(false)
    expect(c.replacedBy).toBe('new')
  })
})

describe('SPEC-078 migration chains', () => {
  const set = [
    m('a', { status: 'deprecated', deprecation: { since: '1.1.0', replacedBy: 'b' } }),
    m('b', { status: 'deprecated', deprecation: { since: '1.1.0', replacedBy: 'c' } }),
    m('c'),
  ]
  const lookup = (n: string) => set.find((x) => x.name === n)
  it('follows the chain to the terminal successor', () => {
    const r = resolveMigration('a', lookup)
    expect(r.target).toBe('c')
    expect(r.chain).toEqual(['a', 'b', 'c'])
    expect(r.cycle).toBe(false)
  })
  it('detects a cycle (fail-closed, no infinite loop)', () => {
    const cyc = [
      m('x', { status: 'deprecated', deprecation: { since: '1.1.0', replacedBy: 'y' } }),
      m('y', { status: 'deprecated', deprecation: { since: '1.1.0', replacedBy: 'x' } }),
    ]
    const r = resolveMigration('x', (n) => cyc.find((z) => z.name === n))
    expect(r.cycle).toBe(true)
  })
  it('flags an unresolved replacement target', () => {
    const r = resolveMigration('a', (n) => (n === 'a' ? m('a', { status: 'deprecated', deprecation: { since: '1.1.0', replacedBy: 'ghost' } }) : undefined))
    expect(r.unresolved).toBe(true)
  })
})

describe('SPEC-078 integrity checks', () => {
  it('removeAfter must be after since', () => {
    const issues = checkDeprecation(dep({ deprecation: { since: '2.0.0', removeAfter: '1.5.0' } }), () => undefined)
    expect(issues.some((i) => i.code === 'BAD_REMOVE_ORDER')).toBe(true)
  })
  it('missing replacement flagged', () => {
    const issues = checkDeprecation(dep({ deprecation: { since: '1.1.0', replacedBy: 'ghost' } }), () => undefined)
    expect(issues.some((i) => i.code === 'MISSING_REPLACEMENT')).toBe(true)
  })
  it('the live registry (all active) has no deprecation issues', () => {
    expect(checkAllDeprecations(ALL_MANIFESTS)).toEqual([])
  })
})

describe('SPEC-078 boundary', () => {
  it('callability via boundary', () => {
    const r = queryDeprecation({ identity, contractVersion: DEPRECATION_CONTRACT_VERSION, payload: { kind: 'callability', manifest: m('a', { status: 'removed', deprecation: { since: '1.1.0', replacedBy: 'b' } }) } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'callability') expect(r.value.result.callable).toBe(false)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryDeprecation({ identity: { ...identity, tenantId: '' }, contractVersion: DEPRECATION_CONTRACT_VERSION, payload: { kind: 'resolveMigration', name: 'x' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryDeprecation(null)).not.toThrow()
  })
})
