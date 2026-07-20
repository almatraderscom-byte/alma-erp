/**
 * G09 / SPEC-088 — Capability resolver tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  RESOLVER_CONTRACT_VERSION,
  resolveCapabilities,
  resolveCapabilityRequest,
} from '../resolver'
import { InMemoryHealthOverrideStore } from '../health'
import { CAPABILITIES } from '../store'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-088 resolution', () => {
  it('resolves a business intent for a permitted, available capability', () => {
    const r = resolveCapabilities({ intentKey: 'query_finance', actor: { roles: ['owner'] } })
    expect(r.resolved).toBe(true)
    expect(r.candidates.map((c) => c.key)).toContain('finance')
  })
  it('candidates are ranked cheaper-tier first then key', () => {
    const r = resolveCapabilities({ intentClass: 'question', actor: { roles: ['owner'] } })
    const ranks = r.candidates.map((c) => ({ light: 0, standard: 1, heavy: 2 } as Record<string, number>)[c.tier])
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
  })
})

describe('SPEC-088 fail-closed filters', () => {
  it('excludes capabilities the actor is not permitted for', () => {
    const owned = CAPABILITIES.find((c) => c.permission.scope === 'owner')!
    const r = resolveCapabilities({ intentKey: `query_${owned.key}`, actor: { roles: ['customer'] } })
    expect(r.candidates.map((c) => c.key)).not.toContain(owned.key)
    expect(r.deniedByPermission).toBeGreaterThan(0)
  })
  it('excludes kill-switched capabilities', () => {
    const store = new InMemoryHealthOverrideStore()
    store.set('finance', { status: 'healthy', killSwitch: true })
    const r = resolveCapabilities({ intentKey: 'query_finance', actor: { roles: ['owner'] } }, store)
    expect(r.candidates.map((c) => c.key)).not.toContain('finance')
    expect(r.unavailable).toBeGreaterThan(0)
  })
  it('no matching intent → resolved false', () => {
    expect(resolveCapabilities({ intentKey: 'query_nonexistent_domain', actor: { roles: ['owner'] } }).resolved).toBe(false)
  })
})

describe('SPEC-088 boundary', () => {
  it('resolved request → COMPLETED', () => {
    const r = resolveCapabilityRequest({ identity, contractVersion: RESOLVER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.resolved).toBe(true)
  })
  it('no capability resolves → DENIED (fail-closed)', () => {
    const r = resolveCapabilityRequest({ identity, contractVersion: RESOLVER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['customer'] } } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.POLICY_DENIED)
  })
  it('request without intentKey/class is rejected', () => {
    const r = resolveCapabilityRequest({ identity, contractVersion: RESOLVER_CONTRACT_VERSION, payload: { actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
  })
  it('missing tenant fails closed; never throws', () => {
    const r = resolveCapabilityRequest({ identity: { ...identity, tenantId: '' }, contractVersion: RESOLVER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => resolveCapabilityRequest(null)).not.toThrow()
  })
})
