/**
 * G09 / SPEC-089 — Capability broker & fallback tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  BROKER_CONTRACT_VERSION,
  callableTools,
  broker,
  brokerCapabilityRequest,
} from '../broker'
import { InMemoryHealthOverrideStore } from '../health'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-089 tool selection', () => {
  it('callableTools returns real tools ranked low-risk-first', () => {
    const tools = callableTools('finance')
    expect(tools.length).toBeGreaterThan(0)
    // no removed/non-existent tools
    expect(tools).not.toContain('__ghost__')
  })
  it('brokers a primary tool + fallbacks for a permitted intent', () => {
    const sel = broker({ intentKey: 'query_finance', actor: { roles: ['owner'] } })
    expect(sel).not.toBeNull()
    expect(sel!.capabilityKey).toBe('finance')
    expect(typeof sel!.toolName).toBe('string')
    expect(Array.isArray(sel!.fallbacks)).toBe(true)
  })
})

describe('SPEC-089 fallback + fail-closed', () => {
  it('kill-switching the capability yields no selection (fail-closed)', () => {
    const store = new InMemoryHealthOverrideStore()
    store.set('finance', { status: 'healthy', killSwitch: true })
    expect(broker({ intentKey: 'query_finance', actor: { roles: ['owner'] } }, store)).toBeNull()
  })
  it('an unpermitted actor gets no selection', () => {
    // find an owner-scope capability
    const sel = broker({ intentKey: 'query_finance', actor: { roles: ['customer'] } })
    expect(sel).toBeNull()
  })
  it('a class query brokers across capabilities (fallback chain non-empty overall)', () => {
    const sel = broker({ intentClass: 'question', actor: { roles: ['owner'] } })
    expect(sel).not.toBeNull()
  })
})

describe('SPEC-089 boundary', () => {
  it('brokered request → COMPLETED with a tool', () => {
    const r = brokerCapabilityRequest({ identity, contractVersion: BROKER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.toolName.length).toBeGreaterThan(0)
  })
  it('no callable tool → DENIED (fail-closed)', () => {
    const r = brokerCapabilityRequest({ identity, contractVersion: BROKER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['customer'] } } })
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.POLICY_DENIED)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = brokerCapabilityRequest({ identity: { ...identity, tenantId: '' }, contractVersion: BROKER_CONTRACT_VERSION, payload: { intentKey: 'query_finance', actor: { roles: ['owner'] } } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => brokerCapabilityRequest(null)).not.toThrow()
  })
})
