/**
 * G13 / SPEC-127 — Execution adapter stage tests (deterministic fake adapter).
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ComponentResult, type ExecutionIdentity } from '@/agent/contracts'
import { executionAdapterStage } from '../stages/execution-adapter'
import { GATEWAY_CONTRACT_VERSION, type AdapterResult, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

const okAdapter: ExecutionAdapter = {
  execute: ({ toolName, args }) => ({ status: 'COMPLETED', value: { payload: { echoed: { toolName, args } }, actualCostNanoUsd: 42 }, evidenceIds: [], versions: {} }),
}
const retryableAdapter: ExecutionAdapter = { execute: (): ComponentResult<AdapterResult> => ({ status: 'RETRYABLE', reasonCodes: [REASON_CODES.DEPENDENCY_RETRYABLE], evidenceIds: [], retryAfterMs: 1000 }) }
const unknownAdapter: ExecutionAdapter = { execute: (): ComponentResult<AdapterResult> => ({ status: 'UNKNOWN_OUTCOME', reasonCodes: [REASON_CODES.UNKNOWN_OUTCOME], evidenceIds: [] }) }

function ctx(deps: GatewayDeps): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 'send', args: { x: 1 }, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 0, deps }
}

describe('SPEC-127 execution behind the adapter seam', () => {
  it('success carries the raw payload + actual cost forward', () => {
    const r = executionAdapterStage(ctx({ adapter: okAdapter, observedAtMs: 0 }))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.rawPayload).toEqual({ echoed: { toolName: 'send', args: { x: 1 } } })
      expect(r.value.actualCostNanoUsd).toBe(42)
    }
  })
  it('RETRYABLE propagates verbatim (no blind retry, INV-06)', () => {
    const r = executionAdapterStage(ctx({ adapter: retryableAdapter, observedAtMs: 0 }))
    expect(r.status).toBe('RETRYABLE')
    if (!isSuccess(r)) expect(r.retryAfterMs).toBe(1000)
  })
  it('UNKNOWN_OUTCOME propagates verbatim (reconciliation, INV-06)', () => {
    expect(executionAdapterStage(ctx({ adapter: unknownAdapter, observedAtMs: 0 })).status).toBe('UNKNOWN_OUTCOME')
  })
  it('missing adapter → FAILED_FINAL (fail-closed)', () => {
    const r = executionAdapterStage(ctx({ observedAtMs: 0 } as unknown as GatewayDeps))
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.DEPENDENCY_FINAL)
  })
  it('never throws', () => {
    expect(() => executionAdapterStage(ctx({ adapter: okAdapter, observedAtMs: 0 }))).not.toThrow()
  })
})
