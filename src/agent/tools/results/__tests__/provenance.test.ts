/**
 * G10 / SPEC-099 — Tool result provenance tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  PROVENANCE_CONTRACT_VERSION,
  buildProvenancedView,
  checkProvenance,
  isTraceable,
  provenancedResult,
} from '../provenance'
import { InMemoryEvidenceStore } from '../evidence-store'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'corr-p' }

describe('SPEC-099 provenance stamping', () => {
  it('stamps a traceable envelope tied to evidence + identity', () => {
    const s = new InMemoryEvidenceStore()
    const pv = buildProvenancedView({ toolName: 'search_web', payload: { title: 'x' }, identity, source: 'search', observedAtMs: 7 }, s)
    expect(pv.provenance.toolName).toBe('search_web')
    expect(pv.provenance.tenantId).toBe('alma')
    expect(pv.provenance.correlationId).toBe('corr-p')
    expect(pv.provenance.source).toBe('search')
    expect(pv.provenance.evidenceId).toMatch(/^ev_/)
    expect(s.has(pv.provenance.evidenceId)).toBe(true)
    expect(isTraceable(pv.provenance)).toBe(true)
  })
  it('propagates truncation into provenance', () => {
    const s = new InMemoryEvidenceStore()
    const pv = buildProvenancedView({ toolName: 't', payload: { blob: 'x'.repeat(50_000) }, identity, source: 'tool', observedAtMs: 1 }, s)
    expect(pv.provenance.truncated).toBe(true)
  })
})

describe('SPEC-099 completeness check (fail-closed)', () => {
  it('missing fields are flagged', () => {
    expect(checkProvenance(null).length).toBeGreaterThan(0)
    expect(checkProvenance({ toolName: 't' }).some((i) => i.code === 'MISSING_EVIDENCE')).toBe(true)
    expect(isTraceable({ toolName: 't' })).toBe(false)
  })
  it('bad source flagged', () => {
    expect(checkProvenance({ toolName: 't', evidenceId: 'ev_1', tenantId: 'a', correlationId: 'c', source: 'nope' as never }).some((i) => i.code === 'BAD_SOURCE')).toBe(true)
  })
})

describe('SPEC-099 boundary', () => {
  it('emits a provenanced view', () => {
    const s = new InMemoryEvidenceStore()
    const r = provenancedResult({ identity, contractVersion: PROVENANCE_CONTRACT_VERSION, payload: { toolName: 'search_web', payload: { title: 'x' }, source: 'search', observedAtMs: 2 } }, s)
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.provenance.evidenceId).toMatch(/^ev_/)
      expect(r.evidenceIds).toContain(r.value.provenance.evidenceId)
    }
  })
  it('missing tenant fails closed; never throws', () => {
    const r = provenancedResult({ identity: { ...identity, tenantId: '' }, contractVersion: PROVENANCE_CONTRACT_VERSION, payload: { toolName: 't', payload: 1, source: 'tool', observedAtMs: 0 } })
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
    expect(() => provenancedResult(null)).not.toThrow()
  })
})
