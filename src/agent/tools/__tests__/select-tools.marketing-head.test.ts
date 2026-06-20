/**
 * Marketing-head tool-set guard.
 *
 * History: the Qwen marketing head used to ALSO drop `delegate_to_specialist`, on
 * the theory that delegating marketing would spawn a SECOND Qwen agent loop (the
 * "Qwen calls the agent again" double-spend). That reason is now VOID: the worker
 * a head delegates to is DeepSeek (the cheap worker), never Qwen. So the marketing
 * head now KEEPS `delegate_to_specialist`. This is what lets the HARD tool-round
 * budget (HEAD_TOOL_BUDGET) force the expensive Qwen head to hand the rest of a
 * long job to the cheap DeepSeek worker instead of spree-calling tools itself.
 *
 * It still KEEPS its marketing read-tools (so it can read the page / history
 * directly for short tasks). Every other head keeps its prior behavior unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'

describe('selectToolsAndGroupsForTurnAsync — marketing head tool set', () => {
  beforeAll(() => {
    // Exercise the default test-mode behavior deterministically.
    delete process.env.DELEGATION_APPROVAL
    delete process.env.ENABLE_SLIM_ROUTER
  })

  it('marketing head: KEEPS marketing read-tools AND keeps delegate_to_specialist (hands long jobs to the cheap DeepSeek worker)', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('ekta fb post banao', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      headTier: 'marketing',
    })
    const names = tools.map((t) => t.name)
    expect(names).toContain('delegate_to_specialist')
    expect(names).toContain('get_fb_recent_posts')
    expect(names).toContain('get_marketing_intel')
    expect(names).toContain('get_marketing_history')
  })

  it('non-marketing head: KEEPS delegate_to_specialist and strips marketing read-tools (unchanged)', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('aj koto sale hoyeche', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      headTier: 'heavy',
    })
    const names = tools.map((t) => t.name)
    expect(names).toContain('delegate_to_specialist')
    expect(names).not.toContain('get_fb_recent_posts')
  })
})
