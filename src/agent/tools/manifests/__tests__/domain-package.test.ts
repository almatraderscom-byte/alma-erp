/**
 * G08 / SPEC-073 — Domain package structure + loader tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import { validateDomainPackage, defineDomainPackage, type DomainPackage } from '../domain-package'
import { deriveSideEffects } from '../derive-side-effects'
import {
  ALL_MANIFESTS,
  ALL_PACKAGES,
  LOADER_CONTRACT_VERSION,
  validateAll,
  getManifest,
  manifestsForDomain,
  domains,
  manifestCount,
  queryManifests,
} from '../loader'
import type { ToolManifest } from '../manifest.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function m(name: string, domain: string, over: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name, domain, title: name, summary: 's', version: '1.0.0', status: 'active',
    capability: { mode: 'read', risk: 'low', sideEffects: ['db_read'] },
    io: { inputSchemaId: `${domain}.${name}.input` },
    ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    routing: { groups: [], pools: ['lifestyle'] },
    ...over,
  }
}

describe('SPEC-073 generated packages', () => {
  it('partitions the full monolith surface (327 manifests, 63 domains)', () => {
    expect(manifestCount()).toBe(327)
    expect(ALL_MANIFESTS.length).toBe(327)
    expect(domains().length).toBe(63)
  })
  it('the aggregate is globally valid (loader would throw otherwise)', () => {
    expect(validateAll(ALL_PACKAGES)).toEqual([])
  })
  it('tool names are globally unique across domains', () => {
    const names = ALL_MANIFESTS.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('every manifest.domain matches its package', () => {
    for (const p of ALL_PACKAGES) for (const man of p.manifests) expect(man.domain).toBe(p.domain)
  })
  it('resolves a known tool with derived side-effects', () => {
    const launch = getManifest('launch_campaign')
    expect(launch?.domain).toBe('ads')
    expect(launch?.capability.sideEffects).toContain('external_api_write')
  })
  it('manifestsForDomain returns only that domain', () => {
    const fin = manifestsForDomain('finance')
    expect(fin.length).toBeGreaterThan(0)
    expect(fin.every((x) => x.domain === 'finance')).toBe(true)
  })
})

describe('SPEC-073 deriveSideEffects', () => {
  it('reads → db_read', () => {
    expect(deriveSideEffects('read', 'finance', 'high')).toEqual(['db_read'])
  })
  it('messaging write → external_message', () => {
    expect(deriveSideEffects('write', 'wa', 'low')).toContain('external_message')
  })
  it('high-risk money domain write → money_movement', () => {
    expect(deriveSideEffects('write', 'finance', 'high')).toContain('money_movement')
  })
  it('is deterministic + frozen-order', () => {
    expect(deriveSideEffects('stage', 'ads', 'high')).toEqual(deriveSideEffects('stage', 'ads', 'high'))
  })
})

describe('SPEC-073 package validation catches corruption', () => {
  it('empty package', () => {
    expect(validateDomainPackage({ domain: 'x', manifests: [] }).some((i) => i.code === 'EMPTY_PACKAGE')).toBe(true)
  })
  it('domain mismatch', () => {
    const pkg: DomainPackage = { domain: 'a', manifests: [m('t', 'b')] }
    expect(validateDomainPackage(pkg).some((i) => i.code === 'DOMAIN_MISMATCH')).toBe(true)
  })
  it('duplicate name within a package', () => {
    const pkg: DomainPackage = { domain: 'a', manifests: [m('t', 'a'), m('t', 'a')] }
    expect(validateDomainPackage(pkg).some((i) => i.code === 'DUPLICATE_NAME')).toBe(true)
  })
  it('unsorted package', () => {
    const pkg: DomainPackage = { domain: 'a', manifests: [m('z', 'a'), m('a', 'a')] }
    expect(validateDomainPackage(pkg).some((i) => i.code === 'UNSORTED')).toBe(true)
  })
  it('defineDomainPackage throws on invalid input', () => {
    expect(() => defineDomainPackage('a', [m('t', 'b')])).toThrow()
  })
  it('validateAll catches a cross-domain duplicate name', () => {
    const issues = validateAll([
      { domain: 'a', manifests: [m('dup', 'a')] },
      { domain: 'b', manifests: [m('dup', 'b')] },
    ])
    expect(issues.some((i) => i.code === 'DUPLICATE_NAME')).toBe(true)
  })
})

describe('SPEC-073 loader boundary', () => {
  it('count query returns 327', () => {
    const r = queryManifests({ identity, contractVersion: LOADER_CONTRACT_VERSION, payload: { kind: 'count' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'count') expect(r.value.count).toBe(327)
  })
  it('missing tenant fails closed', () => {
    const r = queryManifests({ identity: { ...identity, tenantId: '' }, contractVersion: LOADER_CONTRACT_VERSION, payload: { kind: 'count' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
  })
  it('malformed payload fails closed; never throws', () => {
    expect(() => queryManifests(null)).not.toThrow()
    const r = queryManifests({ identity, contractVersion: LOADER_CONTRACT_VERSION, payload: { kind: 'bogus' } })
    expect(r.status).toBe('FAILED_FINAL')
  })
})
