/**
 * Owner incident 2026-07-26 — "একই কাজ এই টার্নে আগেই হয়েছে/স্টেজ হয়েছে" for a
 * card that was never created.
 *
 * `draft_seo_fixes` passed the guard, its handler rejected the batch, and no
 * approval card existed — yet the guard had already claimed the idempotency key,
 * so the head's next identical attempt was refused as a duplicate for ten
 * minutes. An ALLOWED call is not a COMPLETED effect.
 *
 * These tests pin both halves: a real effect still blocks its duplicate, and a
 * failed one hands the key back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { guardToolCall, clearEffectClaims } from '@/agent/lib/policy/tool-guard'
import { runRegisteredTool, type AgentTool } from '@/agent/tools/registry'
import { resolveClassification } from '@/agent/tools/tool-contract'

vi.mock('@/agent/lib/live-browser/turn-owner-input', () => ({
  isTurnOwnerExecutionCurrent: vi.fn(async () => true),
}))

const stageSeo = resolveClassification({ domain: 'seo', mode: 'stage', risk: 'medium' })
const ctx = { surface: 'owner' as const, conversationId: 'conv-1', turnId: 'turn-1', businessId: 'ALMA_LIFESTYLE' }

const BATCH_A = { fixes: [{ slugOrId: 'p1', title: 'ভালো একটা টাইটেল' }], note: 'batch' }
const BATCH_B = { fixes: [{ slugOrId: 'p2', title: 'অন্য একটা টাইটেল' }], note: 'batch' }

/**
 * A stand-in that carries the REAL tool name (so it inherits the real
 * stage/seo classification and the real guard path) with a handler we control.
 */
function fakeDraftTool(handler: AgentTool['handler']): AgentTool {
  return {
    name: 'draft_seo_fixes',
    description: 'test double',
    input_schema: {
      type: 'object' as const,
      properties: {
        fixes: { type: 'array', items: { type: 'object' } },
        note: { type: 'string' },
      },
      required: ['fixes'],
    },
    handler,
  }
}

describe('duplicate-effect claim lifecycle', () => {
  beforeEach(() => clearEffectClaims())

  it('a genuinely different batch is never a duplicate', async () => {
    await guardToolCall('draft_seo_fixes', BATCH_A, stageSeo, ctx)
    const other = await guardToolCall('draft_seo_fixes', BATCH_B, stageSeo, ctx)
    expect(other.action).toBe('proceed')
  })

  it('the same batch in a different turn is never a duplicate', async () => {
    await guardToolCall('draft_seo_fixes', BATCH_A, stageSeo, ctx)
    const nextTurn = await guardToolCall('draft_seo_fixes', BATCH_A, stageSeo, { ...ctx, turnId: 'turn-2' })
    expect(nextTurn.action).toBe('proceed')
  })

  it('a FAILED staging call does not block an identical retry', async () => {
    const failing = fakeDraftTool(async () => ({ success: false, error: 'ফিক্স #১: meta description 168 chars' }))
    const first = await runRegisteredTool(failing, BATCH_A, {}, ctx)
    expect(first.success).toBe(false)

    // The retry must be judged on its own merits, not refused as a duplicate.
    let ran = false
    const succeeding = fakeDraftTool(async () => {
      ran = true
      return { success: true, data: { pendingActionId: 'card-1' } }
    })
    const second = await runRegisteredTool(succeeding, BATCH_A, {}, ctx)
    expect(second.success).toBe(true)
    expect(ran).toBe(true)
  })

  it('a THROWN staging call does not block an identical retry', async () => {
    const throwing = fakeDraftTool(async () => {
      throw new Error('website supabase timeout')
    })
    const first = await runRegisteredTool(throwing, BATCH_A, {}, ctx)
    expect(first.success).toBe(false)

    const succeeding = fakeDraftTool(async () => ({ success: true, data: { pendingActionId: 'card-1' } }))
    const second = await runRegisteredTool(succeeding, BATCH_A, {}, ctx)
    expect(second.success).toBe(true)
  })

  it('a SUCCEEDED staging call still blocks its duplicate', async () => {
    const succeeding = fakeDraftTool(async () => ({ success: true, data: { pendingActionId: 'card-1' } }))
    const first = await runRegisteredTool(succeeding, BATCH_A, {}, ctx)
    expect(first.success).toBe(true)

    let ranTwice = false
    const again = fakeDraftTool(async () => {
      ranTwice = true
      return { success: true, data: { pendingActionId: 'card-2' } }
    })
    const second = await runRegisteredTool(again, BATCH_A, {}, ctx)
    expect(second.success).toBe(false)
    expect(second.errorCode).toBe('guard_duplicate_effect')
    expect(ranTwice).toBe(false)
  })
})
