import { describe, it, expect } from 'vitest'
import { annotateEmptyResult, isEmptyResultData } from '@/agent/lib/tool-result-note'

describe('isEmptyResultData', () => {
  it('flags empty array and empty object', () => {
    expect(isEmptyResultData([])).toBe(true)
    expect(isEmptyResultData({})).toBe(true)
  })

  it('does not flag non-empty data', () => {
    expect(isEmptyResultData([1])).toBe(false)
    expect(isEmptyResultData({ a: 1 })).toBe(false)
    expect(isEmptyResultData('hello')).toBe(false)
    expect(isEmptyResultData(0)).toBe(false)
  })

  it('does not flag null/undefined (ambiguous with side-effect actions)', () => {
    expect(isEmptyResultData(null)).toBe(false)
    expect(isEmptyResultData(undefined)).toBe(false)
  })
})

describe('annotateEmptyResult', () => {
  it('annotates a successful-but-empty array result', () => {
    const out = annotateEmptyResult({ success: true, data: [] }) as Record<string, unknown>
    expect(out._empty).toBe(true)
    expect(typeof out._note).toBe('string')
    expect(out.success).toBe(true)
  })

  it('annotates a successful-but-empty object result', () => {
    const out = annotateEmptyResult({ success: true, data: {} }) as Record<string, unknown>
    expect(out._empty).toBe(true)
  })

  it('leaves results with data untouched (same reference)', () => {
    const r = { success: true, data: [{ id: 1 }] }
    expect(annotateEmptyResult(r)).toBe(r)
  })

  it('does not annotate action results with no data payload', () => {
    const r = { success: true }
    const out = annotateEmptyResult(r) as Record<string, unknown>
    expect(out._empty).toBeUndefined()
    expect(out).toBe(r)
  })

  it('does not annotate failures', () => {
    const r = { success: false, error: 'boom', data: [] }
    const out = annotateEmptyResult(r) as Record<string, unknown>
    expect(out._empty).toBeUndefined()
  })

  it('passes through non-object inputs', () => {
    expect(annotateEmptyResult('x')).toBe('x')
    expect(annotateEmptyResult(null)).toBe(null)
  })
})
