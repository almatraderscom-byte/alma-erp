/**
 * G08 / SPEC-079 — Generated runtime registry tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  RUNTIME_CONTRACT_VERSION,
  buildRuntimeRegistry,
  toolDefinitions,
  shadowCompare,
  queryRuntimeRegistry,
} from '../runtime-registry'
import type { ToolManifest } from '../../manifests/manifest.schema'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

function m(name: string, over: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name, domain: 'd', title: name, summary: `desc ${name}`, version: '1.0.0', status: 'active',
    capability: { mode: 'read', risk: 'low', sideEffects: ['db_read'] },
    io: { inputSchemaId: `d.${name}.input` },
    ownership: { team: '@alma/agent', zonePrefix: 'src/agent/tools' },
    routing: { groups: [], pools: [] }, ...over,
  }
}

describe('SPEC-079 feature-flag authority', () => {
  it('legacy authoritative under off/shadow/warn/rollback', () => {
    for (const mode of ['off', 'shadow', 'warn', 'rollback'] as const) {
      expect(buildRuntimeRegistry(mode).authoritative).toBe('legacy')
    }
  })
  it('new authoritative only under enforce', () => {
    expect(buildRuntimeRegistry('enforce').authoritative).toBe('new')
  })
})

describe('SPEC-079 registry assembly (live manifests)', () => {
  it('builds all 327 tools under a legacy mode', () => {
    const r = buildRuntimeRegistry('shadow')
    expect(r.toolCount).toBe(327)
    expect(r.entries).toEqual([...r.entries].sort((a, b) => a.name.localeCompare(b.name)))
  })
  it('entries carry assembled facets (risk profile + schema + callability)', () => {
    const r = buildRuntimeRegistry('shadow')
    const e = r.byName.get('launch_campaign')!
    expect(e.risk.requiresGateway).toBe(true) // external_api_write
    expect(e.callable).toBe(true)
    expect(e.description).toBeTruthy()
  })
  it('toolDefinitions produce a model-facing name/description/input_schema array', () => {
    const defs = toolDefinitions(buildRuntimeRegistry('shadow'))
    expect(defs.length).toBe(327)
    for (const d of defs.slice(0, 5)) {
      expect(typeof d.name).toBe('string')
      expect(d.input_schema).toBeDefined()
    }
  })
})

describe('SPEC-079 enforce drops removed tools (fail-closed)', () => {
  it('a removed tool is excluded when the new path is authoritative', () => {
    const set = [m('keep'), m('gone', { status: 'removed', deprecation: { since: '1.1.0', replacedBy: 'keep' } })]
    const enforced = buildRuntimeRegistry('enforce', set)
    expect(enforced.byName.has('gone')).toBe(false)
    expect(enforced.byName.has('keep')).toBe(true)
    // under shadow (legacy authoritative) the full set is still built for comparison
    expect(buildRuntimeRegistry('shadow', set).toolCount).toBe(2)
  })
})

describe('SPEC-079 shadow comparison (migration evidence)', () => {
  it('the new registry has full parity with the SPEC-071 inventory', () => {
    const c = shadowCompare()
    expect(c.parity).toBe(true)
    expect(c.onlyInNew).toEqual([])
    expect(c.onlyInInventory).toEqual([])
    expect(c.matched).toBe(327)
  })
  it('detects drift', () => {
    const c = shadowCompare([m('only_new_tool')])
    expect(c.parity).toBe(false)
    expect(c.onlyInNew).toContain('only_new_tool')
    expect(c.onlyInInventory.length).toBeGreaterThan(0)
  })
})

describe('SPEC-079 boundary', () => {
  it('build via boundary', () => {
    const r = queryRuntimeRegistry({ identity, contractVersion: RUNTIME_CONTRACT_VERSION, payload: { kind: 'build', mode: 'enforce' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'build') expect(r.value.authoritative).toBe('new')
  })
  it('shadowCompare via boundary', () => {
    const r = queryRuntimeRegistry({ identity, contractVersion: RUNTIME_CONTRACT_VERSION, payload: { kind: 'shadowCompare' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'shadowCompare') expect(r.value.comparison.parity).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryRuntimeRegistry({ identity: { ...identity, tenantId: '' }, contractVersion: RUNTIME_CONTRACT_VERSION, payload: { kind: 'build', mode: 'off' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryRuntimeRegistry(null)).not.toThrow()
  })
})
