/**
 * G08 / SPEC-072 — Tool manifest schema tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  MANIFEST_CONTRACT_VERSION,
  SIDE_EFFECT_KINDS,
  toolManifestSchema,
  parseManifest,
  safeParseManifest,
  isDeprecated,
  validateManifest,
  type ToolManifest,
} from '../manifest.schema'

const identity: ExecutionIdentity = {
  tenantId: 'alma',
  actorId: 'owner',
  workflowId: 'wf',
  stepId: 'st',
  correlationId: 'corr',
}

function base(): ToolManifest {
  return {
    name: 'save_memory',
    domain: 'memory',
    title: 'Save memory',
    summary: 'Persist a durable fact.',
    version: '1.0.0',
    status: 'active',
    capability: { mode: 'write', risk: 'low', sideEffects: ['db_write'] },
    io: { inputSchemaId: 'memory.save_memory.input' },
    ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    routing: { groups: ['base'], pools: ['lifestyle', 'trading'] },
  }
}

describe('SPEC-072 valid manifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => parseManifest(base())).not.toThrow()
  })
  it('accepts a deprecated manifest with a record', () => {
    const m = { ...base(), status: 'deprecated' as const, deprecation: { since: '1.2.0', replacedBy: 'store_fact', removeAfter: '2.0.0' } }
    expect(safeParseManifest(m).success).toBe(true)
    expect(isDeprecated(parseManifest(m))).toBe(true)
  })
})

describe('SPEC-072 rejects malformed manifests', () => {
  it('missing required field', () => {
    const { name, ...noName } = base()
    void name
    expect(toolManifestSchema.safeParse(noName).success).toBe(false)
  })
  it('non-snake_case name', () => {
    expect(toolManifestSchema.safeParse({ ...base(), name: 'SaveMemory' }).success).toBe(false)
  })
  it('bad semver', () => {
    expect(toolManifestSchema.safeParse({ ...base(), version: '1.0' }).success).toBe(false)
    expect(toolManifestSchema.safeParse({ ...base(), version: 'v1.0.0' }).success).toBe(false)
  })
  it('unknown mode / risk', () => {
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'delete', risk: 'low', sideEffects: ['db_write'] } }).success).toBe(false)
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'read', risk: 'critical', sideEffects: ['db_read'] } }).success).toBe(false)
  })
  it('unknown side-effect kind', () => {
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'write', risk: 'low', sideEffects: ['telepathy'] } }).success).toBe(false)
  })
  it('empty side-effects array', () => {
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'write', risk: 'low', sideEffects: [] } }).success).toBe(false)
  })
  it("'none' cannot combine with other effects", () => {
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'read', risk: 'low', sideEffects: ['none', 'db_read'] } }).success).toBe(false)
  })
  it('duplicate side-effects rejected', () => {
    expect(toolManifestSchema.safeParse({ ...base(), capability: { mode: 'write', risk: 'low', sideEffects: ['db_write', 'db_write'] } }).success).toBe(false)
  })
})

describe('SPEC-072 lifecycle/deprecation consistency', () => {
  it('deprecated status without a record is rejected', () => {
    expect(toolManifestSchema.safeParse({ ...base(), status: 'deprecated' }).success).toBe(false)
  })
  it('active status with a deprecation record is rejected', () => {
    expect(toolManifestSchema.safeParse({ ...base(), deprecation: { since: '1.0.0' } }).success).toBe(false)
  })
  it('a tool cannot be replaced by itself', () => {
    const m = { ...base(), status: 'deprecated' as const, deprecation: { since: '1.1.0', replacedBy: 'save_memory' } }
    expect(toolManifestSchema.safeParse(m).success).toBe(false)
  })
})

describe('SPEC-072 identity-enforced boundary', () => {
  it('validates a manifest through the G01 boundary', () => {
    const r = validateManifest({ identity, contractVersion: MANIFEST_CONTRACT_VERSION, payload: { manifest: base() } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.name).toBe('save_memory')
  })
  it('missing tenant fails closed', () => {
    const r = validateManifest({ identity: { ...identity, tenantId: '' }, contractVersion: MANIFEST_CONTRACT_VERSION, payload: { manifest: base() } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
  })
  it('malformed manifest fails closed with MALFORMED_INPUT', () => {
    const r = validateManifest({ identity, contractVersion: MANIFEST_CONTRACT_VERSION, payload: { manifest: { name: 'x' } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MALFORMED_INPUT)
  })
  it('never throws on garbage', () => {
    expect(() => validateManifest(null)).not.toThrow()
    expect(validateManifest(null).status).toBe('FAILED_FINAL')
  })
})

describe('SPEC-072 taxonomy is closed', () => {
  it('side-effect kinds are the frozen set', () => {
    expect(SIDE_EFFECT_KINDS).toContain('money_movement')
    expect(SIDE_EFFECT_KINDS).toContain('none')
    expect(new Set(SIDE_EFFECT_KINDS).size).toBe(SIDE_EFFECT_KINDS.length)
  })
})
