/**
 * Marketing-head tool-set guard.
 *
 * The Qwen MARKETING head is the owner's marketing + Facebook + website specialist
 * and must do that work ITSELF — DeepSeek is the wrong worker for marketing quality.
 * So the marketing head:
 *   - carries the FULL owner toolset, including the `content` (FB posting, creatives)
 *     `growth` (ads, SEO, marketing) and `website` groups the slim head drops, and
 *   - LOSES `delegate_to_specialist`, so it physically cannot hand marketing to a
 *     cheap worker. Its larger MARKETING_HEAD_TOOL_BUDGET keeps the spree bounded.
 *
 * Every other head keeps the lean slim profile AND keeps delegate_to_specialist.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { selectToolsAndGroupsForTurnAsync } from '@/agent/tools/select-tools'

describe('selectToolsAndGroupsForTurnAsync — marketing head tool set', () => {
  beforeAll(() => {
    // Exercise the default test-mode behavior deterministically.
    delete process.env.DELEGATION_APPROVAL
    delete process.env.ENABLE_SLIM_ROUTER
  })

  it('marketing head: STRIPS delegate_to_specialist and KEEPS full marketing/content/growth/website tools (does it all itself, no DeepSeek)', async () => {
    const { tools } = await selectToolsAndGroupsForTurnAsync('ekta fb post banao', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      headTier: 'marketing',
    })
    const names = tools.map((t) => t.name)
    // No hand-off to a cheap worker — marketing stays on Qwen.
    expect(names).not.toContain('delegate_to_specialist')
    // Marketing read-tools (short-task path).
    expect(names).toContain('get_fb_recent_posts')
    expect(names).toContain('get_marketing_intel')
    expect(names).toContain('get_marketing_history')
    // content group (FB posting / creatives) — dropped by the slim head, kept here.
    expect(names).toContain('run_content_post')
    // website group — Qwen does website work itself too.
    expect(names).toContain('fetch_website_page')
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
