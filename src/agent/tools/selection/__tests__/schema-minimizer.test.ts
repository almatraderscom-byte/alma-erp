/**
 * G10 / SPEC-093 — Tool schema token minimization tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  MINIMIZER_CONTRACT_VERSION,
  MAX_DESCRIPTION_CHARS,
  MAX_PROP_DESCRIPTION_CHARS,
  minimizeSchema,
  minimizeToolSchema,
  minimizeShortlist,
  minimizeToolSchemas,
} from '../schema-minimizer'
import { ALL_MANIFESTS } from '@/agent/tools/manifests'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-093 schema minimization', () => {
  it('drops annotation keys and trims property descriptions', () => {
    const verbose = {
      type: 'object',
      title: 'Verbose Tool',
      $comment: 'internal note',
      properties: {
        q: { type: 'string', description: 'x'.repeat(300), examples: ['a', 'b'], default: 'z' },
      },
      required: ['q'],
    }
    const min = minimizeSchema(verbose) as Record<string, any>
    expect(min.title).toBeUndefined()
    expect(min.$comment).toBeUndefined()
    expect(min.type).toBe('object')
    expect(min.required).toEqual(['q'])
    expect(min.properties.q.examples).toBeUndefined()
    expect(min.properties.q.default).toBeUndefined()
    expect((min.properties.q.description as string).length).toBeLessThanOrEqual(MAX_PROP_DESCRIPTION_CHARS)
    expect(min.properties.q.type).toBe('string')
  })
  it('never adds tokens (after <= before) for real tools', () => {
    for (const m of ALL_MANIFESTS.slice(0, 40)) {
      const mt = minimizeToolSchema(m.name)!
      expect(mt.tokensAfter).toBeLessThanOrEqual(mt.tokensBefore)
    }
  })
  it('caps the root description', () => {
    const long = ALL_MANIFESTS[0]
    const mt = minimizeToolSchema(long.name)!
    expect(mt.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS)
  })
  it('unknown tool → null', () => {
    expect(minimizeToolSchema('__ghost__')).toBeNull()
  })
})

describe('SPEC-093 shortlist aggregate', () => {
  it('tokensSaved is non-negative and consistent', () => {
    const names = ALL_MANIFESTS.slice(0, 12).map((m) => m.name)
    const agg = minimizeShortlist(names)
    expect(agg.tools.length).toBe(12)
    expect(agg.tokensSaved).toBe(Math.max(0, agg.tokensBefore - agg.tokensAfter))
    expect(agg.tokensSaved).toBeGreaterThanOrEqual(0)
  })
})

describe('SPEC-093 boundary', () => {
  it('minimizes a set → COMPLETED', () => {
    const names = ALL_MANIFESTS.slice(0, 5).map((m) => m.name)
    const r = minimizeToolSchemas({ identity, contractVersion: MINIMIZER_CONTRACT_VERSION, payload: { toolNames: names } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.tokensAfter).toBeLessThanOrEqual(r.value.tokensBefore)
  })
  it('all-unknown tools → FAILED_FINAL', () => {
    const r = minimizeToolSchemas({ identity, contractVersion: MINIMIZER_CONTRACT_VERSION, payload: { toolNames: ['__ghost__'] } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = minimizeToolSchemas({ identity: { ...identity, tenantId: '' }, contractVersion: MINIMIZER_CONTRACT_VERSION, payload: { toolNames: ['save_memory'] } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => minimizeToolSchemas(null)).not.toThrow()
  })
})
