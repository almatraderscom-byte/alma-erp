/**
 * G10 / SPEC-097 — Large result summarization tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  SUMMARIZE_CONTRACT_VERSION,
  DEFAULT_SUMMARIZE,
  summarize,
  summarizeResult,
} from '../summarize'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-097 deterministic summarization', () => {
  it('arrays keep head + omitted count', () => {
    const r = summarize(Array.from({ length: 100 }, (_, i) => ({ i })), { maxItems: 3 })
    const s = r.summary as any
    expect(s._items.length).toBe(3)
    expect(s._omitted).toBe(97)
    expect(s._total).toBe(100)
    expect(r.meta.truncatedArrays).toBe(1)
  })
  it('numeric arrays get a digest', () => {
    const s = summarize([1, 2, 3, 4, 5, 6], { maxItems: 2 }).summary as any
    expect(s._digest).toEqual({ count: 6, min: 1, max: 6, sum: 21 })
  })
  it('long strings truncate with length noted', () => {
    const s = summarize('x'.repeat(500), { maxStringChars: 100 }).summary as any
    expect(s._len).toBe(500)
    expect(s._str.length).toBeLessThanOrEqual(101)
  })
  it('depth is clipped', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    const r = summarize(deep, { maxDepth: 2 })
    expect(r.meta.depthClipped).toBeGreaterThan(0)
  })
  it('objects clip excess keys', () => {
    const obj: Record<string, number> = {}
    for (let i = 0; i < 60; i++) obj['k' + i] = i
    const s = summarize(obj, { maxKeys: 10 }).summary as any
    expect(s._omittedKeys).toBe(50)
  })
  it('is deterministic + no explicit undefined clobber', () => {
    const a = summarize([1, 2, 3], {})
    const b = summarize([1, 2, 3], { maxItems: undefined })
    expect(a).toEqual(b)
    expect(DEFAULT_SUMMARIZE.maxItems).toBe(5)
  })
  it('small values pass through unchanged', () => {
    expect(summarize({ ok: true, n: 3 }).summary).toEqual({ ok: true, n: 3 })
  })
})

describe('SPEC-097 boundary', () => {
  it('summarizes via boundary', () => {
    const r = summarizeResult({ identity, contractVersion: SUMMARIZE_CONTRACT_VERSION, payload: { payload: Array.from({ length: 50 }, (_, i) => i), maxItems: 4 } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect((r.value.summary as any)._omitted).toBe(46)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = summarizeResult({ identity: { ...identity, tenantId: '' }, contractVersion: SUMMARIZE_CONTRACT_VERSION, payload: { payload: [1, 2, 3] } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => summarizeResult(null)).not.toThrow()
  })
})
