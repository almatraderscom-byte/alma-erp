/**
 * G09 / SPEC-090 — Capability certification gate tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  CERTIFICATION_CONTRACT_VERSION,
  evaluateCertification,
  queryCertificationGate,
} from '../certification-gate'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-090 certification of the live plane', () => {
  const report = evaluateCertification()
  it('all facet checks pass', () => {
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.pass]))
    for (const id of ['INTENT', 'TOOLS', 'COVERAGE', 'PERMISSION', 'COST', 'RUNTIME_OWNER', 'HEALTH', 'BROKERABLE'] as const) {
      expect(byId[id]).toBe(true)
    }
  })
  it('the plane is certified with no blockers', () => {
    expect(report.certified).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.summary).toMatch(/certified/)
  })
  it('reports one check per facet (8)', () => {
    expect(report.checks.length).toBe(8)
  })
})

describe('SPEC-090 boundary', () => {
  it('evaluate via boundary → certified', () => {
    const r = queryCertificationGate({ identity, contractVersion: CERTIFICATION_CONTRACT_VERSION, payload: { kind: 'evaluate' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.certified).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryCertificationGate({ identity: { ...identity, tenantId: '' }, contractVersion: CERTIFICATION_CONTRACT_VERSION, payload: { kind: 'evaluate' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryCertificationGate(null)).not.toThrow()
  })
  it('malformed payload rejected', () => {
    const r = queryCertificationGate({ identity, contractVersion: CERTIFICATION_CONTRACT_VERSION, payload: { kind: 'bogus' } })
    expect(r.status).toBe('FAILED_FINAL')
  })
})
