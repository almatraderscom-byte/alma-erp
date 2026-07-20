/**
 * G13 / SPEC-128 — Evidence capture stage tests (INV-07).
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import { InMemoryEvidenceStore } from '@/agent/tools/results'
import { evidenceCaptureStage } from '../stages/evidence-capture'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'corr-e' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }

function ctx(store: InMemoryEvidenceStore, over: Partial<GatewayContext> = {}): GatewayContext {
  const deps: GatewayDeps = { adapter, observedAtMs: 5, evidenceStore: store }
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 'search_web', args: {}, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 5, deps, obligations: [], rawPayload: { ok: true }, ...over }
}

describe('SPEC-128 evidence capture (INV-07)', () => {
  it('stores the FULL payload and returns a bounded provenanced view', () => {
    const store = new InMemoryEvidenceStore()
    const r = evidenceCaptureStage(ctx(store, { rawPayload: { big: 'data', n: 1 } }))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.evidenceId).toMatch(/^ev_/)
      expect(store.get(r.value.evidenceId!)?.payload).toEqual({ big: 'data', n: 1 }) // full retained
      const view = r.value.view as any
      expect(view.provenance.evidenceId).toBe(r.value.evidenceId)
      expect(view.provenance.tenantId).toBe('alma')
      expect(view.provenance.source).toBe('tool')
    }
  })
  it('applies obligations (redact) to the view before bounding', () => {
    const store = new InMemoryEvidenceStore()
    const r = evidenceCaptureStage(ctx(store, { rawPayload: { customer: { phone: '01700', name: 'A' } }, obligations: ['redact:customer.phone'] }))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      const view = r.value.view as any
      expect(JSON.stringify(view.view)).not.toContain('01700')
      expect(JSON.stringify(view.view)).toContain('[REDACTED]')
      // evidence retains the full unredacted payload for audit
      expect((store.get(r.value.evidenceId!)?.payload as any).customer.phone).toBe('01700')
    }
  })
  it('secret keys are redacted in the model view', () => {
    const store = new InMemoryEvidenceStore()
    const r = evidenceCaptureStage(ctx(store, { rawPayload: { api_key: 'sk-XYZ' } }))
    if (isSuccess(r)) expect(JSON.stringify((r.value.view as any).view)).not.toContain('sk-XYZ')
  })
  it('no execution payload → FAILED_FINAL (fail-closed)', () => {
    const store = new InMemoryEvidenceStore()
    const base = ctx(store)
    const { rawPayload, ...noPayload } = base
    void rawPayload
    const r = evidenceCaptureStage(noPayload as GatewayContext)
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.DEPENDENCY_FINAL)
  })
  it('never throws', () => {
    expect(() => evidenceCaptureStage(ctx(new InMemoryEvidenceStore()))).not.toThrow()
  })
})
