import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Dynamic per-turn toolset (owner decision 2026-07-08): with no working provider
 * cache on today's heads, each turn should carry only the groups the message
 * needs — not the fixed 188-tool prefix.
 */
describe('dynamic toolset', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('AGENT_DYNAMIC_TOOLSET', 'true')
  })

  it('routine sales question ships a slim set, not the full router set', async () => {
    const mod = await import('@/agent/tools/select-tools')
    const { tools, groups } = await mod.selectToolsAndGroupsForTurnAsync('aj koto sale holo?', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    const fullRouter = mod.assembleSelectedTools([
      'base', 'erp', 'staff', 'finance', 'cs', 'website', 'diag', 'vision', 'cost',
    ] as never[])
    expect(tools.length).toBeLessThan(fullRouter.length)
    expect(groups).toContain('base') // memory/ask/delegate always ride along
    // Approval-card growth tools the head must never lose (owner-facing cards).
    expect(tools.some((t) => t.name === 'launch_campaign')).toBe(true)
  })

  it('delegated domains (content/growth) stay off the head even on keyword match', async () => {
    const mod = await import('@/agent/tools/select-tools')
    const { groups } = await mod.selectToolsAndGroupsForTurnAsync('facebook post banao ekta', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    if (mod.SLIM_ROUTER_ENABLED) {
      expect(groups).not.toContain('content')
      expect(groups).not.toContain('growth')
    }
  })

  it('kill switch restores the fixed router set', async () => {
    vi.stubEnv('AGENT_DYNAMIC_TOOLSET', 'false')
    vi.resetModules()
    const mod = await import('@/agent/tools/select-tools')
    const { tools } = await mod.selectToolsAndGroupsForTurnAsync('aj koto sale holo?', {
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    // Fixed mode: the full slim-router schema payload (150+ tools).
    expect(tools.length).toBeGreaterThan(150)
  })
})
