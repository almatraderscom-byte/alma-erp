/**
 * G10 / SPEC-100 — Firewall regression gate tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  FIREWALL_GATE_CONTRACT_VERSION,
  evaluateFirewallGate,
  queryFirewallGate,
} from '../regression-gate'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-100 firewall certification', () => {
  const report = evaluateFirewallGate(0)
  it('all firewall checks pass', () => {
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.pass]))
    for (const id of ['SHORTLIST_BOUND', 'SCHEMA_MINIMIZED', 'ARG_FAILCLOSED', 'EVIDENCE_STORED', 'VIEW_BOUNDED', 'SECRET_REDACTED', 'PROVENANCE_TRACEABLE', 'NORMALIZE_BOUNDED'] as const) {
      expect(byId[id]).toBe(true)
    }
  })
  it('certified with no blockers', () => {
    expect(report.certified).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.summary).toMatch(/certified/)
  })
  it('reports 8 checks', () => {
    expect(report.checks.length).toBe(8)
  })
  it('no secret leaks the model view (explicit)', () => {
    const secret = report.checks.find((c) => c.id === 'SECRET_REDACTED')!
    expect(secret.detail).toBe('clean')
  })
  it('is deterministic', () => {
    expect(evaluateFirewallGate(0)).toEqual(evaluateFirewallGate(0))
  })
})

describe('SPEC-100 boundary', () => {
  it('evaluate via boundary → certified', () => {
    const r = queryFirewallGate({ identity, contractVersion: FIREWALL_GATE_CONTRACT_VERSION, payload: { kind: 'evaluate', observedAtMs: 0 } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.certified).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryFirewallGate({ identity: { ...identity, tenantId: '' }, contractVersion: FIREWALL_GATE_CONTRACT_VERSION, payload: { kind: 'evaluate' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryFirewallGate(null)).not.toThrow()
  })
  it('malformed payload rejected', () => {
    const r = queryFirewallGate({ identity, contractVersion: FIREWALL_GATE_CONTRACT_VERSION, payload: { kind: 'bogus' } })
    expect(r.status).toBe('FAILED_FINAL')
  })
})
