/**
 * G08 / SPEC-074 — IO schema registry tests.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  IO_CONTRACT_VERSION,
  DEFAULT_VIEW_BYTES,
  hasSchema,
  getSchema,
  schemaIds,
  schemaCount,
  strictenSchema,
  validateInput,
  boundedOutputView,
  validateToolIo,
  clearIoValidatorCache,
} from '../io-schema'
import { ALL_MANIFESTS } from '../../manifests/loader'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

beforeEach(() => clearIoValidatorCache())

describe('SPEC-074 coverage: every manifest inputSchemaId resolves', () => {
  it('one schema per manifest (326)', () => {
    expect(schemaCount()).toBe(326)
    for (const m of ALL_MANIFESTS) expect(hasSchema(m.io.inputSchemaId)).toBe(true)
  })
  it('schemaIds are sorted + unique', () => {
    const ids = schemaIds()
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('SPEC-074 strictenSchema', () => {
  it('adds additionalProperties:false to the root object', () => {
    const s = strictenSchema({ type: 'object', properties: { a: { type: 'string' } } })
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual([])
  })
  it('preserves an explicit permissive root', () => {
    const s = strictenSchema({ type: 'object', additionalProperties: true })
    expect(s.additionalProperties).toBe(true)
  })
})

describe('SPEC-074 strict validation path (curated schema)', () => {
  it('accepts valid input', () => {
    const r = validateInput('memory.save_memory.input', { scope: 'personal', content: 'hi' })
    expect(r.ok).toBe(true)
  })
  it('rejects a missing required field', () => {
    const r = validateInput('memory.save_memory.input', { scope: 'personal' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/content/)
  })
  it('rejects an unknown root field', () => {
    const r = validateInput('memory.save_memory.input', { scope: 'personal', content: 'x', bogus: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown field "bogus"/)
  })
  it('rejects an out-of-enum value', () => {
    const r = validateInput('memory.save_memory.input', { scope: 'nope', content: 'x' })
    expect(r.ok).toBe(false)
  })
})

describe('SPEC-074 permissive default path', () => {
  it('accepts arbitrary input for an uncurated tool', () => {
    const r = validateInput('ads.launch_campaign.input', { anything: true, n: 5 })
    expect(r.ok).toBe(true)
  })
})

describe('SPEC-074 unknown schema fails CLOSED', () => {
  it('unknown schema id is a hard error (not fail-open)', () => {
    const r = validateInput('does.not.exist', { a: 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown schema id/)
  })
})

describe('SPEC-074 bounded output view (INV-07)', () => {
  it('passes a small payload through', () => {
    const r = boundedOutputView({ ok: true, n: 3 })
    expect(r.truncated).toBe(false)
    expect(r.view).toEqual({ ok: true, n: 3 })
  })
  it('redacts secret-looking keys', () => {
    const r = boundedOutputView({ api_key: 'sk-123', data: { token: 'abc', safe: 1 } })
    expect(r.redactedKeys.sort()).toEqual(['api_key', 'token'])
    expect(JSON.stringify(r.view)).not.toContain('sk-123')
    expect(JSON.stringify(r.view)).not.toContain('abc')
  })
  it('truncates an oversized payload and flags evidence', () => {
    const big = { blob: 'x'.repeat(DEFAULT_VIEW_BYTES + 100) }
    const r = boundedOutputView(big)
    expect(r.truncated).toBe(true)
    expect(r.originalBytes).toBeGreaterThan(DEFAULT_VIEW_BYTES)
    expect(JSON.stringify(r.view)).toMatch(/evidence/)
  })
})

describe('SPEC-074 identity-enforced boundary', () => {
  it('validateInput via boundary', () => {
    const r = validateToolIo({ identity, contractVersion: IO_CONTRACT_VERSION, payload: { kind: 'validateInput', schemaId: 'memory.save_memory.input', input: { scope: 'personal', content: 'x' } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r) && r.value.kind === 'validateInput') expect(r.value.ok).toBe(true)
  })
  it('missing actor fails closed', () => {
    const r = validateToolIo({ identity: { ...identity, actorId: '' }, contractVersion: IO_CONTRACT_VERSION, payload: { kind: 'count' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_ACTOR)
  })
  it('never throws on garbage', () => {
    expect(() => validateToolIo(null)).not.toThrow()
    expect(validateToolIo(null).status).toBe('FAILED_FINAL')
  })
})

describe('SPEC-074 schema shape', () => {
  it('curated schema is strict', () => {
    expect((getSchema('memory.save_memory.input') as { additionalProperties?: unknown }).additionalProperties).toBe(false)
  })
})
