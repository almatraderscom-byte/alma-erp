import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveStateRouterMode, conversationInCanary } from '../state-router'
import { workflowTemplatesEnabled, templateKindsForCardType, getWorkflowTemplate } from '@/agent/lib/workflow-templates'
import { checkWorkflowGuards } from '@/agent/lib/workflow-guards'

/**
 * Phase 7 — canary rollout modes + per-component kill switches. The rollout
 * ladder must be pure and deterministic: the same conversation always lands in
 * the same cohort, and every switch reverts a component without a deploy.
 */

afterEach(() => vi.unstubAllEnvs())

describe('resolveStateRouterMode (rollout ladder)', () => {
  it('explicit flags win everywhere', () => {
    expect(resolveStateRouterMode('true', 'production')).toBe('on')
    expect(resolveStateRouterMode('false', 'preview')).toBe('off')
    expect(resolveStateRouterMode('shadow', 'preview')).toBe('shadow')
    expect(resolveStateRouterMode('canary:25', 'production')).toEqual({ canaryPct: 25 })
    expect(resolveStateRouterMode('canary:100', 'production')).toEqual({ canaryPct: 100 })
  })

  it('defaults: preview ON, production SHADOW (Phase 7 step 1), elsewhere OFF', () => {
    expect(resolveStateRouterMode(undefined, 'preview')).toBe('on')
    expect(resolveStateRouterMode(undefined, 'production')).toBe('shadow')
    expect(resolveStateRouterMode(undefined, undefined)).toBe('off')
  })

  it('malformed canary values fall back to environment defaults', () => {
    expect(resolveStateRouterMode('canary:', 'production')).toBe('shadow')
    expect(resolveStateRouterMode('canary:abc', 'preview')).toBe('on')
  })
})

describe('conversationInCanary (stable cohorts)', () => {
  it('is deterministic per conversation and monotonic in pct', () => {
    const id = '57d25308-d189-4cac-a17a-7250495aa0f2'
    const at10 = conversationInCanary(id, 10)
    expect(conversationInCanary(id, 10)).toBe(at10) // stable across calls
    if (at10) expect(conversationInCanary(id, 50)).toBe(true) // widening never evicts
    expect(conversationInCanary(id, 100)).toBe(true)
    expect(conversationInCanary(id, 0)).toBe(false)
  })

  it('spreads conversations roughly per the percentage', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `conv-${i}-${i * 7919}`)
    const hit25 = ids.filter((id) => conversationInCanary(id, 25)).length
    expect(hit25).toBeGreaterThan(150) // 25% ±10pt tolerance on 1k
    expect(hit25).toBeLessThan(350)
  })
})

describe('per-component kill switches', () => {
  it('AGENT_WORKFLOW_TEMPLATES=false silences the whole template layer', () => {
    expect(workflowTemplatesEnabled()).toBe(true)
    expect(templateKindsForCardType('image_gen')).toEqual(['product_post'])
    vi.stubEnv('AGENT_WORKFLOW_TEMPLATES', 'false')
    expect(workflowTemplatesEnabled()).toBe(false)
    expect(templateKindsForCardType('image_gen')).toEqual([])
    expect(getWorkflowTemplate('product_post')).toBeUndefined()
  })

  it('AGENT_WORKFLOW_GUARDS=false stops guard blocking without touching hooks', async () => {
    vi.stubEnv('AGENT_WORKFLOW_GUARDS', 'false')
    // Would normally hit the DB via activeRunOfKind — the switch returns first.
    const block = await checkWorkflowGuards('post_to_facebook', {}, { conversationId: 'any' })
    expect(block).toBeNull()
  })
})
