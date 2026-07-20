/**
 * G13 / SPEC-124 — Policy decision stage tests.
 */
import { describe, it, expect } from 'vitest'
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts'
import { humanPrincipal } from '@/agent/identity/principals'
import type { PolicyLayer, PolicyEvaluationInput, LayerVerdict, PolicyResource } from '@/agent/policy'
import { policyDecisionStage } from '../stages/policy-decision'
import { GATEWAY_CONTRACT_VERSION, type ExecutionAdapter, type GatewayContext, type GatewayDeps } from '../contract'

const identity: ExecutionIdentity = { tenantId: 'alma', actorId: 'owner', workflowId: 'wf', stepId: 'st', correlationId: 'c' }
const adapter: ExecutionAdapter = { execute: () => ({ status: 'COMPLETED', value: { payload: {} }, evidenceIds: [], versions: {} }) }
const principal = humanPrincipal(identity, ['owner'])
const resource: PolicyResource = { type: 'message', tenantId: 'alma' }

/** A layer that permits `action` (optionally with obligations), else abstains. */
function permitLayer(action: string, obligations: string[] = []): PolicyLayer {
  return {
    name: 'test-permit',
    evaluate: (input: PolicyEvaluationInput): LayerVerdict =>
      input.action === action
        ? { layer: 'test-permit', effect: 'permit', reasonCodes: ['TEST_GRANT'], obligations }
        : { layer: 'test-permit', effect: 'abstain', reasonCodes: [] },
  }
}

function deps(layers: PolicyLayer[]): GatewayDeps {
  return { adapter, observedAtMs: 0, policyLayers: layers }
}
function ctx(d: GatewayDeps, over: Partial<GatewayContext> = {}): GatewayContext {
  return { identity, contractVersion: GATEWAY_CONTRACT_VERSION, toolName: 'send', args: {}, action: 'message.send', estimatedCostNanoUsd: 0, observedAtMs: 0, deps: d, principal, resource, ...over }
}

describe('SPEC-124 policy decision stage', () => {
  it('advances on ALLOW and carries obligations forward', () => {
    const r = policyDecisionStage(ctx(deps([permitLayer('message.send', ['redact:customer.phone'])])))
    expect(r.status).toBe('COMPLETED')
    if (isSuccess(r)) expect(r.value.obligations).toContain('redact:customer.phone')
  })
  it('DENIES when no layer permits (fail-closed default)', () => {
    expect(policyDecisionStage(ctx(deps([]))).status).not.toBe('COMPLETED')
    expect(policyDecisionStage(ctx(deps([permitLayer('other.action')]))).status).not.toBe('COMPLETED')
  })
  it('DENIES fail-closed when principal/resource missing', () => {
    expect(policyDecisionStage(ctx(deps([permitLayer('message.send')]), { principal: undefined })).status).toBe('DENIED')
    expect(policyDecisionStage(ctx(deps([permitLayer('message.send')]), { resource: undefined })).status).toBe('DENIED')
  })
  it('propagates the policy denial verbatim (non-success)', () => {
    const r = policyDecisionStage(ctx(deps([])))
    expect(isSuccess(r)).toBe(false)
  })
  it('never throws', () => {
    expect(() => policyDecisionStage(ctx(deps([])))).not.toThrow()
  })
})
