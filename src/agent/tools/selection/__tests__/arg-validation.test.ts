/**
 * G10 / SPEC-094 — Tool argument validation tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  ARG_VALIDATION_CONTRACT_VERSION,
  MAX_ARG_BYTES,
  validateToolArgs,
  admitToolCall,
} from '../arg-validation'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-094 argument validation (fail-closed)', () => {
  it('accepts valid args for a curated-schema tool', () => {
    expect(validateToolArgs('save_memory', { scope: 'personal', content: 'hi' }).ok).toBe(true)
  })
  it('rejects missing required args', () => {
    const v = validateToolArgs('save_memory', { scope: 'personal' })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('invalid_args')
  })
  it('rejects unknown fields', () => {
    const v = validateToolArgs('save_memory', { scope: 'personal', content: 'x', bogus: 1 })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('invalid_args')
  })
  it('rejects an unknown tool (fail-closed)', () => {
    expect(validateToolArgs('__ghost__', {}).code).toBe('unknown_tool')
  })
  it('rejects oversized arguments', () => {
    const big = { blob: 'x'.repeat(MAX_ARG_BYTES + 10) }
    expect(validateToolArgs('save_memory', big).code).toBe('oversized_args')
  })
  it('never throws', () => {
    expect(() => validateToolArgs('save_memory', {} as never)).not.toThrow()
  })
})

describe('SPEC-094 boundary', () => {
  it('valid call → ALLOWED', () => {
    const r = admitToolCall({ identity, contractVersion: ARG_VALIDATION_CONTRACT_VERSION, payload: { toolName: 'save_memory', args: { scope: 'personal', content: 'x' } } })
    expect(r.status).toBe('ALLOWED')
  })
  it('invalid args → DENIED (MALFORMED_INPUT)', () => {
    const r = admitToolCall({ identity, contractVersion: ARG_VALIDATION_CONTRACT_VERSION, payload: { toolName: 'save_memory', args: { scope: 'personal' } } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MALFORMED_INPUT)
  })
  it('unknown tool → DENIED', () => {
    const r = admitToolCall({ identity, contractVersion: ARG_VALIDATION_CONTRACT_VERSION, payload: { toolName: '__ghost__', args: {} } })
    expect(r.status).toBe('DENIED')
  })
  it('oversized args → DENIED (OVERSIZED_INPUT)', () => {
    const r = admitToolCall({ identity, contractVersion: ARG_VALIDATION_CONTRACT_VERSION, payload: { toolName: 'save_memory', args: { blob: 'x'.repeat(MAX_ARG_BYTES + 10) } } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.OVERSIZED_INPUT)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = admitToolCall({ identity: { ...identity, tenantId: '' }, contractVersion: ARG_VALIDATION_CONTRACT_VERSION, payload: { toolName: 'save_memory', args: { scope: 'personal', content: 'x' } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => admitToolCall(null)).not.toThrow()
  })
})
