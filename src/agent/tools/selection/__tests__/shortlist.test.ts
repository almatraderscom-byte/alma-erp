/**
 * G10 / SPEC-092 — Exact tool shortlist tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  SHORTLIST_CONTRACT_VERSION,
  MAX_SHORTLIST,
  selectShortlist,
  shortlistForIntent,
  selectToolShortlist,
} from '../shortlist'
import { retrieveForIntent } from '../retrieval'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-092 bounding + ranking', () => {
  it('never exceeds the requested cap or MAX_SHORTLIST', () => {
    const many = retrieveForIntent({ intentClass: 'question', actor: { roles: ['owner'] } }).toolNames
    expect(many.length).toBeGreaterThan(MAX_SHORTLIST)
    expect(selectShortlist(many, 5).toolNames.length).toBe(5)
    expect(selectShortlist(many, 999).toolNames.length).toBe(MAX_SHORTLIST)
    expect(selectShortlist(many, 5).truncated).toBe(true)
  })
  it('ranks read tools before write tools (safest first)', () => {
    // save_memory is write, search_memory is read — read should sort earlier
    const sl = selectShortlist(['save_memory', 'search_memory'], 10)
    expect(sl.toolNames.indexOf('search_memory')).toBeLessThan(sl.toolNames.indexOf('save_memory'))
  })
  it('is deterministic + de-dupes', () => {
    const a = selectShortlist(['save_memory', 'save_memory', 'search_memory'], 10)
    expect(a.total).toBe(2)
    expect(selectShortlist(['b', 'a'], 10).toolNames).toEqual(selectShortlist(['b', 'a'], 10).toolNames)
  })
  it('clamps a zero/negative cap to at least 1', () => {
    expect(selectShortlist(['a', 'b'], 0).toolNames.length).toBe(1)
  })
})

describe('SPEC-092 shortlistForIntent', () => {
  it('produces a bounded shortlist for a real intent', () => {
    const sl = shortlistForIntent({ intentKey: 'query_finance', actor: { roles: ['owner'] } }, 6)
    expect(sl.resolved).toBe(true)
    expect(sl.toolNames.length).toBeLessThanOrEqual(6)
  })
})

describe('SPEC-092 boundary', () => {
  it('resolved intent → COMPLETED bounded shortlist', () => {
    const r = selectToolShortlist({ identity, contractVersion: SHORTLIST_CONTRACT_VERSION, payload: { intentClass: 'question', actor: { roles: ['owner'] }, max: 8 } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.toolNames.length).toBeLessThanOrEqual(8)
      expect(r.value.truncated).toBe(true)
    }
  })
  it('unresolved intent → DENIED', () => {
    const r = selectToolShortlist({ identity, contractVersion: SHORTLIST_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['customer'] } } })
    expect(r.status).toBe('DENIED')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = selectToolShortlist({ identity: { ...identity, tenantId: '' }, contractVersion: SHORTLIST_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => selectToolShortlist(null)).not.toThrow()
  })
})
