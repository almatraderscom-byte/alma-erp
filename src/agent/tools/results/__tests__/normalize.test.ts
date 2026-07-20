/**
 * G10 / SPEC-098 — Search/browser result normalization tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  NORMALIZE_CONTRACT_VERSION,
  MAX_ITEMS,
  MAX_SNIPPET_CHARS,
  normalizeSearchResults,
  normalizeResults,
} from '../normalize'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-098 shape detection', () => {
  it('normalizes {results:[{title,link,snippet}]}', () => {
    const r = normalizeSearchResults({ results: [{ title: 'A', link: 'https://a.com', snippet: 'hi' }] })
    expect(r.items[0]).toEqual({ title: 'A', url: 'https://a.com', snippet: 'hi' })
  })
  it('normalizes {organic:[{name,url,description}]}', () => {
    const r = normalizeSearchResults({ organic: [{ name: 'B', url: 'https://b.com', description: 'd' }] })
    expect(r.items[0].title).toBe('B')
    expect(r.items[0].url).toBe('https://b.com')
  })
  it('normalizes a bare array + string rows', () => {
    const r = normalizeSearchResults(['first result', { title: 'C', href: 'https://c.com' }])
    expect(r.items.length).toBe(2)
    expect(r.items[0].title).toBe('first result')
  })
})

describe('SPEC-098 sanitisation + bounds', () => {
  it('drops non-http(s) urls (javascript:, data:)', () => {
    const r = normalizeSearchResults([{ title: 'X', url: 'javascript:alert(1)' }, { title: 'Y', url: 'data:text/html,x' }])
    expect(r.items[0].url).toBeUndefined()
    expect(r.items[1].url).toBeUndefined()
  })
  it('caps snippet length', () => {
    const r = normalizeSearchResults([{ title: 'X', snippet: 'y'.repeat(1000) }])
    expect(r.items[0].snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS)
  })
  it('bounds item count', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: 't' + i }))
    const r = normalizeSearchResults(many, 3)
    expect(r.items.length).toBe(3)
    expect(r.truncated).toBe(true)
    expect(normalizeSearchResults(many, 999).items.length).toBe(MAX_ITEMS)
  })
  it('skips empty rows', () => {
    const r = normalizeSearchResults([{}, { title: 'ok' }])
    expect(r.total).toBe(1)
  })
})

describe('SPEC-098 boundary', () => {
  it('normalizes via boundary', () => {
    const r = normalizeResults({ identity, contractVersion: NORMALIZE_CONTRACT_VERSION, payload: { payload: { results: [{ title: 'A', link: 'https://a.com' }] } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.items[0].title).toBe('A')
  })
  it('empty/unrecognized payload → FAILED_FINAL', () => {
    const r = normalizeResults({ identity, contractVersion: NORMALIZE_CONTRACT_VERSION, payload: { payload: { nothing: true } } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = normalizeResults({ identity: { ...identity, tenantId: '' }, contractVersion: NORMALIZE_CONTRACT_VERSION, payload: { payload: [] } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => normalizeResults(null)).not.toThrow()
  })
})
