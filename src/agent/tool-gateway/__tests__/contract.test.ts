/**
 * G13 / SPEC-121 — Gateway contract + pipeline composer tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import {
  GATEWAY_CONTRACT_VERSION,
  advance,
  stop,
  runPipeline,
  invokeTool,
  type ExecutionAdapter,
  type GatewayContext,
  type GatewayDeps,
  type GatewayStage,
} from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }

const fakeAdapter: ExecutionAdapter = {
  execute: () => ({ status: 'COMPLETED', value: { payload: { ok: true } }, evidenceIds: [], versions: {} }),
}
const deps: GatewayDeps = { adapter: fakeAdapter, observedAtMs: 1000 }

function ctx(over: Partial<GatewayContext> = {}): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 't', args: {}, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 1000, deps, ...over }
}

function req(payload: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, payload, ...over }
}

describe('SPEC-121 pipeline composer (fail-closed short-circuit)', () => {
  it('runs all stages when each succeeds', () => {
    const s1: GatewayStage = (c) => advance(c, { obligations: ['audit'] })
    const s2: GatewayStage = (c) => advance(c, { view: { done: true } })
    const r = runPipeline(ctx(), [s1, s2])
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.obligations).toEqual(['audit'])
      expect(r.value.view).toEqual({ done: true })
    }
  })
  it('short-circuits on the first non-success and returns it unchanged', () => {
    const order: string[] = []
    const s1: GatewayStage = (c) => { order.push('s1'); return advance(c) }
    const s2: GatewayStage = () => { order.push('s2'); return stop('DENIED', [REASON_CODES.POLICY_DENIED]) }
    const s3: GatewayStage = (c) => { order.push('s3'); return advance(c) }
    const r = runPipeline(ctx(), [s1, s2, s3])
    expect(r.status).toBe('DENIED')
    expect(order).toEqual(['s1', 's2']) // s3 never runs
  })
  it('propagates NEEDS_APPROVAL / BUDGET_EXCEEDED verbatim', () => {
    expect(runPipeline(ctx(), [() => stop('NEEDS_APPROVAL', [REASON_CODES.APPROVAL_REQUIRED])]).status).toBe('NEEDS_APPROVAL')
    expect(runPipeline(ctx(), [() => stop('BUDGET_EXCEEDED', [REASON_CODES.BUDGET_EXCEEDED])]).status).toBe('BUDGET_EXCEEDED')
  })
  it('empty pipeline completes (no stage, no side effect)', () => {
    expect(runPipeline(ctx(), []).status).toBe('COMPLETED')
  })
})

describe('SPEC-121 invokeTool boundary', () => {
  it('validates the envelope and runs the pipeline', () => {
    const stage: GatewayStage = (c) => advance(c, { evidenceId: 'ev_1', view: { r: 1 } })
    const r = invokeTool(req({ toolName: 'send', args: { x: 1 }, action: 'msg.send' }), deps, [stage])
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) {
      expect(r.value.toolName).toBe('send')
      expect(r.value.evidenceId).toBe('ev_1')
      expect(r.evidenceIds).toContain('ev_1')
    }
  })
  it('missing tenant fails closed', () => {
    const r = invokeTool(req({ toolName: 't', args: {}, action: 'a.b' }, { identity: { ...identity, tenantId: '' } }), deps, [])
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MISSING_TENANT)
  })
  it('malformed payload fails closed; never throws', () => {
    expect(invokeTool(req({ toolName: '' }), deps, []).status).toBe('FAILED_FINAL')
    expect(() => invokeTool(null, deps, [])).not.toThrow()
    expect(invokeTool(null, deps, []).status).toBe('FAILED_FINAL')
  })
  it('contract-version mismatch rejected', () => {
    const r = invokeTool(req({ toolName: 't', args: {}, action: 'a.b' }, { contractVersion: '9.9.9' }), deps, [])
    expect(r.status).toBe('FAILED_FINAL')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.CONTRACT_VERSION_MISMATCH)
  })
})
