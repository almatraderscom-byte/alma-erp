/**
 * Marketing-head one-pass guard.
 *
 * Root cause this locks down: the Qwen marketing head was given the SAME tool set
 * as every other head — which (in DELEGATION_APPROVAL test mode) strips the
 * marketing read-tools AND keeps `delegate_to_specialist`. So Qwen-as-head could
 * not do marketing itself and was forced to delegate to a `marketer` sub-agent
 * (also Qwen) — a second full agent loop, the "Qwen calls the agent again" bug.
 *
 * The fix: when headTier === 'marketing', keep the marketing read-tools and drop
 * `delegate_to_specialist`, so Qwen answers marketing DIRECTLY in one pass. Every
 * other head keeps the previous behavior unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'

describe('selectToolsAndGroupsForTurnAsync — marketing head answers directly', () => {
  beforeAll(() => {
    // Exercise the default test-mode behavior deterministically.
    delete process.env.DELEGATION_APPROVAL
    delete process.env.ENABLE_SLIM_ROUTER
  })

  it('marketing head: KEEPS marketing read-tools and DROPS delegate_to_specialist (no double hop)', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('ekta fb post banao', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      headTier: 'marketing',
    })
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('delegate_to_specialist')
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
