/**
 * G08 / SPEC-080 — Monolithic registry removal gate tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  REMOVAL_GATE_CONTRACT_VERSION,
  PROPOSED_REMOVAL_PLAN,
  evaluateRemovalGate,
  queryRemovalGate,
} from '../removal-gate'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

describe('SPEC-080 metadata preconditions all pass', () => {
  const report = evaluateRemovalGate()
  it('parity, schema, classify, ownership, deprecation, io, buildable all PASS', () => {
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.pass]))
    for (const id of ['PARITY', 'SCHEMA', 'CLASSIFY', 'OWNERSHIP', 'DEPRECATION', 'IO', 'BUILDABLE'] as const) {
      expect(byId[id]).toBe(true)
    }
  })
})

describe('SPEC-080 fail-closed on cutover', () => {
  it('defaults to NOT removable — cutover is the sole blocker (INV-09)', () => {
    const report = evaluateRemovalGate()
    expect(report.canRemove).toBe(false)
    expect(report.blockers).toEqual(['CUTOVER'])
    expect(report.summary).toMatch(/BLOCKED/)
  })
  it('removable only once the operational cutover is signed off', () => {
    const report = evaluateRemovalGate({ enforceCutoverDone: true })
    expect(report.canRemove).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.summary).toMatch(/safe to remove/)
  })
})

describe('SPEC-080 proposed plan is documented, not executed', () => {
  it('exposes an explicit non-applied removal plan', () => {
    expect(PROPOSED_REMOVAL_PLAN.length).toBeGreaterThanOrEqual(4)
    expect(PROPOSED_REMOVAL_PLAN.join(' ')).toMatch(/enforce/)
    expect(PROPOSED_REMOVAL_PLAN.join(' ')).toMatch(/registry\.ts/)
  })
})

describe('SPEC-080 boundary', () => {
  it('evaluate via boundary (default → blocked)', () => {
    const r = queryRemovalGate({ identity, contractVersion: REMOVAL_GATE_CONTRACT_VERSION, payload: { kind: 'evaluate' } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.canRemove).toBe(false)
  })
  it('evaluate via boundary with cutover → removable', () => {
    const r = queryRemovalGate({ identity, contractVersion: REMOVAL_GATE_CONTRACT_VERSION, payload: { kind: 'evaluate', enforceCutoverDone: true } })
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.canRemove).toBe(true)
  })
  it('missing tenant fails closed; never throws', () => {
    const r = queryRemovalGate({ identity: { ...identity, tenantId: '' }, contractVersion: REMOVAL_GATE_CONTRACT_VERSION, payload: { kind: 'evaluate' } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => queryRemovalGate(null)).not.toThrow()
  })
})
