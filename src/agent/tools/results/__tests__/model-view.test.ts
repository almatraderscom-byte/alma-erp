/**
 * G10 / SPEC-096 — Compact model-view contract tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  MODEL_VIEW_CONTRACT_VERSION,
  MODEL_VIEW_BYTES,
  buildModelView,
  compactModelView,
} from '../model-view'
import { InMemoryEvidenceStore } from '../evidence-store'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'corr-x' }

describe('SPEC-096 bounded + sanitized view', () => {
  it('small payload passes through, evidence stored', () => {
    const s = new InMemoryEvidenceStore()
    const mv = buildModelView({ toolName: 't', payload: { ok: true, n: 2 }, correlationId: 'c', observedAtMs: 1 }, s)
    expect(mv.truncated).toBe(false)
    expect(mv.view).toEqual({ ok: true, n: 2 })
    expect(s.has(mv.evidenceId)).toBe(true)
  })
  it('redacts secret-looking keys', () => {
    const s = new InMemoryEvidenceStore()
    const mv = buildModelView({ toolName: 't', payload: { api_key: 'sk-1', data: { token: 'abc', ok: 1 } }, correlationId: 'c', observedAtMs: 1 }, s)
    expect(mv.redactedKeys.sort()).toEqual(['api_key', 'token'])
    expect(JSON.stringify(mv.view)).not.toContain('sk-1')
    expect(JSON.stringify(mv.view)).not.toContain('abc')
  })
  it('fails closed on oversize: truncates + references evidence', () => {
    const s = new InMemoryEvidenceStore()
    const big = { blob: 'x'.repeat(MODEL_VIEW_BYTES * 2) }
    const mv = buildModelView({ toolName: 't', payload: big, correlationId: 'c', observedAtMs: 1 }, s)
    expect(mv.truncated).toBe(true)
    expect(mv.viewBytes).toBeLessThanOrEqual(MODEL_VIEW_BYTES + 512)
    expect(mv.originalBytes).toBeGreaterThan(MODEL_VIEW_BYTES)
    expect(JSON.stringify(mv.view)).toContain(mv.evidenceId)
    // full payload retained
    expect(s.get(mv.evidenceId)?.payload).toEqual(big)
  })
})

describe('SPEC-096 boundary', () => {
  it('returns a bounded view referencing evidence', () => {
    const s = new InMemoryEvidenceStore()
    const r = compactModelView({ identity, contractVersion: MODEL_VIEW_CONTRACT_VERSION, payload: { toolName: 'search_web', payload: { title: 'x' }, observedAtMs: 3 } }, s)
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.evidenceId).toMatch(/^ev_/)
      expect(r.evidenceIds).toContain(r.value.evidenceId)
    }
  })
  it('missing tenant fails closed; never throws', () => {
    const r = compactModelView({ identity: { ...identity, tenantId: '' }, contractVersion: MODEL_VIEW_CONTRACT_VERSION, payload: { toolName: 't', payload: 1, observedAtMs: 0 } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => compactModelView(null)).not.toThrow()
  })
})
