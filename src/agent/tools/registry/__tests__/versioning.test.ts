/**
 * G08 / SPEC-077 — Tool versioning tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  VERSIONING_CONTRACT_VERSION,
  parseSemver,
  compareSemver,
  isCompatible,
  bumpKind,
  checkTransition,
  resolveToolVersion,
  queryVersioning,
} from '../versioning'
import { ALL_MANIFESTS } from '../../manifests/loader'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-077 semver parse/compare', () => {
  it('parses valid + rejects invalid', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('v1.2.3')).toBeNull()
    expect(parseSemver('01.2.3')).toBeNull()
  })
  it('compares', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })
})

describe('SPEC-077 compatibility', () => {
  it('same major, available >= requested → compatible', () => {
    expect(isCompatible('1.2.0', '1.5.0')).toBe(true)
    expect(isCompatible('1.2.0', '1.2.0')).toBe(true)
  })
  it('older available → incompatible', () => {
    expect(isCompatible('1.5.0', '1.2.0')).toBe(false)
  })
  it('different major → incompatible (breaking)', () => {
    expect(isCompatible('1.9.9', '2.0.0')).toBe(false)
    expect(isCompatible('2.0.0', '1.9.9')).toBe(false)
  })
  it('malformed → fail-closed false', () => {
    expect(isCompatible('bad', '1.0.0')).toBe(false)
  })
})

describe('SPEC-077 bump + transition', () => {
  it('classifies bumps', () => {
    expect(bumpKind('1.0.0', '2.0.0')).toBe('major')
    expect(bumpKind('1.0.0', '1.1.0')).toBe('minor')
    expect(bumpKind('1.0.0', '1.0.1')).toBe('patch')
    expect(bumpKind('1.0.0', '1.0.0')).toBe('none')
    expect(bumpKind('1.1.0', '1.0.0')).toBe('downgrade')
  })
  it('legal forward transition with truthful breakingness', () => {
    expect(checkTransition('1.0.0', '1.1.0', false).legal).toBe(true)
    expect(checkTransition('1.0.0', '2.0.0', true).legal).toBe(true)
  })
  it('downgrade / no-op are illegal', () => {
    expect(checkTransition('1.1.0', '1.0.0', false).legal).toBe(false)
    expect(checkTransition('1.0.0', '1.0.0', false).legal).toBe(false)
  })
  it('lying about breakingness is illegal', () => {
    expect(checkTransition('1.0.0', '2.0.0', false).legal).toBe(false)
    expect(checkTransition('1.0.0', '1.1.0', true).legal).toBe(false)
  })
})

describe('SPEC-077 resolveToolVersion against the live registry', () => {
  it('resolves an existing tool at a compatible pin', () => {
    const r = resolveToolVersion('save_memory', '1.0.0')
    expect(r.found).toBe(true)
    expect(r.compatible).toBe(true)
    expect(r.availableVersion).toBe('1.0.0')
  })
  it('reports incompatible for a higher pinned major', () => {
    const r = resolveToolVersion('save_memory', '2.0.0')
    expect(r.found).toBe(true)
    expect(r.compatible).toBe(false)
  })
  it('reports not-found for an unknown tool', () => {
    expect(resolveToolVersion('__nope__', '1.0.0').found).toBe(false)
  })
  it('every manifest carries a parseable semver', () => {
    for (const m of ALL_MANIFESTS) expect(parseSemver(m.version)).not.toBeNull()
  })
})

describe('SPEC-077 boundary', () => {
  it('resolve via boundary', () => {
    const r = queryVersioning({ identity, contractVersion: VERSIONING_CONTRACT_VERSION, payload: { kind: 'resolve', name: 'save_memory', requested: '1.0.0' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'resolve') expect(r.value.resolution.compatible).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryVersioning({ identity: { ...identity, tenantId: '' }, contractVersion: VERSIONING_CONTRACT_VERSION, payload: { kind: 'compatible', requested: '1.0.0', available: '1.0.0' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryVersioning(null)).not.toThrow()
  })
})
