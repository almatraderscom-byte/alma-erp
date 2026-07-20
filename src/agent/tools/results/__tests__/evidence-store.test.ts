/**
 * G10 / SPEC-095 — Full evidence payload storage tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  EVIDENCE_CONTRACT_VERSION,
  evidenceIdFor,
  InMemoryEvidenceStore,
  storeEvidence,
} from '../evidence-store'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'corr-9' }

describe('SPEC-095 content-addressed ids', () => {
  it('identical (tool,payload) → identical deterministic id', () => {
    const a = evidenceIdFor('t', { x: 1 })
    const b = evidenceIdFor('t', { x: 1 })
    expect(a).toBe(b)
    expect(a).toMatch(/^ev_[0-9a-f]{40}$/)
  })
  it('different payloads → different ids', () => {
    expect(evidenceIdFor('t', { x: 1 })).not.toBe(evidenceIdFor('t', { x: 2 }))
  })
})

describe('SPEC-095 store', () => {
  it('stores the full payload + metadata and dedupes', () => {
    const s = new InMemoryEvidenceStore()
    const r1 = s.put({ toolName: 't', payload: { big: 'data' }, correlationId: 'c', observedAtMs: 1000 })
    const r2 = s.put({ toolName: 't', payload: { big: 'data' }, correlationId: 'c', observedAtMs: 2000 })
    expect(r1.evidenceId).toBe(r2.evidenceId)
    expect(s.size()).toBe(1)
    expect(s.get(r1.evidenceId)?.payload).toEqual({ big: 'data' })
    expect(r1.sizeBytes).toBeGreaterThan(0)
    expect(r1.storedAtMs).toBe(1000)
  })
  it('has/get behave', () => {
    const s = new InMemoryEvidenceStore()
    const r = s.put({ toolName: 't', payload: 1, correlationId: 'c', observedAtMs: 0 })
    expect(s.has(r.evidenceId)).toBe(true)
    expect(s.has('ev_missing')).toBe(false)
  })
})

describe('SPEC-095 boundary (INV-07: payload never echoed)', () => {
  it('returns only id + size, not the payload', () => {
    const s = new InMemoryEvidenceStore()
    const r = storeEvidence({ identity, contractVersion: EVIDENCE_CONTRACT_VERSION, payload: { toolName: 'search_web', payload: { secret_body: 'xyz' }, observedAtMs: 5 } }, s)
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.evidenceId).toMatch(/^ev_/)
      expect(r.evidenceIds).toContain(r.value.evidenceId)
      expect(JSON.stringify(r.value)).not.toContain('secret_body')
      expect(JSON.stringify(r.value)).not.toContain('xyz')
    }
    // full payload is retained in the store for audit
    if (isSuccess(r)) expect(s.get(r.value.evidenceId)?.payload).toEqual({ secret_body: 'xyz' })
  })
  it('missing tenant fails closed; never throws', () => {
    const r = storeEvidence({ identity: { ...identity, tenantId: '' }, contractVersion: EVIDENCE_CONTRACT_VERSION, payload: { toolName: 't', payload: 1, observedAtMs: 0 } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => storeEvidence(null)).not.toThrow()
  })
})
