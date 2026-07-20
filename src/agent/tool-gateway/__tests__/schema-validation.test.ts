/**
 * G13 / SPEC-122 — Schema validation stage tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, REASON_CODES, type ExecutionIdentity } from '@/agent/contracts'
import { schemaValidationStage } from '../stages/schema-validation'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'
import { MAX_ARG_BYTES } from '@/agent/tools/selection/arg-validation'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }
const deps: GatewayDeps = { adapter, observedAtMs: 0 }

function ctx(toolName: string, args: Record<string, unknown>): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName, args, action: 'a.b', estimatedCostNanoUsd: 0, observedAtMs: 0, deps }
}

describe('SPEC-122 schema validation stage (fail-closed)', () => {
  it('advances on valid args (curated-schema tool)', () => {
    const r = schemaValidationStage(ctx('save_memory', { scope: 'personal', content: 'x' }))
    expect(r.status).toBe('COMPLETED')
  })
  it('DENIES an unknown tool', () => {
    const r = schemaValidationStage(ctx('__ghost__', {}))
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.MALFORMED_INPUT)
  })
  it('DENIES invalid args (missing required)', () => {
    expect(schemaValidationStage(ctx('save_memory', { scope: 'personal' })).status).toBe('DENIED')
  })
  it('DENIES oversized args with OVERSIZED_INPUT', () => {
    const r = schemaValidationStage(ctx('save_memory', { blob: 'x'.repeat(MAX_ARG_BYTES + 10) }))
    expect(r.status).toBe('DENIED')
    if (!isSuccess(r)) expect(r.reasonCodes).toContain(REASON_CODES.OVERSIZED_INPUT)
  })
  it('never throws', () => {
    expect(() => schemaValidationStage(ctx('save_memory', {}))).not.toThrow()
  })
})
