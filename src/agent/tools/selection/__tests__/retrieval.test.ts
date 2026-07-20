/**
 * G10 / SPEC-091 — Domain-first tool retrieval tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  RETRIEVAL_CONTRACT_VERSION,
  retrieveByDomain,
  retrieveForIntent,
  isRetrievableTool,
  knownDomains,
  retrieveTools,
} from '../retrieval'
import { ALL_MANIFESTS } from '@/agent/tools/manifests'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-091 domain-first narrowing', () => {
  it('retrieveByDomain returns only that domain, sorted', () => {
    const tools = retrieveByDomain('finance')
    expect(tools.length).toBeGreaterThan(0)
    expect(tools).toEqual([...tools].sort())
  })
  it('retrieval for an intent narrows well below the full 326 surface', () => {
    const r = retrieveForIntent({ intentKey: 'query_finance', actor: { roles: ['owner'] } })
    expect(r.resolved).toBe(true)
    expect(r.toolNames.length).toBeGreaterThan(0)
    expect(r.toolNames.length).toBeLessThan(ALL_MANIFESTS.length)
    expect(r.domains).toContain('finance')
  })
  it('permission-scopes retrieval (customer cannot retrieve owner tools)', () => {
    const r = retrieveForIntent({ intentKey: 'query_finance', actor: { roles: ['customer'] } })
    expect(r.resolved).toBe(false)
    expect(r.toolNames).toEqual([])
  })
})

describe('SPEC-091 guards', () => {
  it('isRetrievableTool only true for real tools', () => {
    expect(isRetrievableTool(ALL_MANIFESTS[0].name)).toBe(true)
    expect(isRetrievableTool('__ghost__')).toBe(false)
  })
  it('knownDomains lists the G08 domains', () => {
    expect(knownDomains()).toContain('finance')
    expect(knownDomains().length).toBe(63)
  })
})

describe('SPEC-091 boundary', () => {
  it('intent retrieval → COMPLETED', () => {
    const r = retrieveTools({ identity, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.domains).toContain('finance')
  })
  it('direct domain retrieval → COMPLETED', () => {
    const r = retrieveTools({ identity, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { domain: 'finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.toolNames.length).toBeGreaterThan(0)
  })
  it('unresolved intent → DENIED (fail-closed, no full-surface fallback)', () => {
    const r = retrieveTools({ identity, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['customer'] } } })
    expect(r.status).toBe('DENIED')
  })
  it('unknown domain → FAILED_FINAL', () => {
    const r = retrieveTools({ identity, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { domain: '__nope__', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('no selector → rejected', () => {
    const r = retrieveTools({ identity, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = retrieveTools({ identity: { ...identity, tenantId: '' }, contractVersion: RETRIEVAL_CONTRACT_VERSION, payload: { domain: 'finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => retrieveTools(null)).not.toThrow()
  })
})
