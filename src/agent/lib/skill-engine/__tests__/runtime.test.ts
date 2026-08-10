import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn() },
  agentConversation: { findUnique: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { buildActiveSkillsBlock, isSkillEngineEnabled, __resetSkillIndexCache } from '@/agent/lib/skill-engine/runtime'

describe('skill-engine runtime bridge (gated)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ pinnedSkill: null, skillRouteTrace: null })
    mockPrisma.agentConversation.update.mockResolvedValue({})
  })

  afterEach(() => {
    delete process.env.SKILL_ENGINE_ENABLED
    __resetSkillIndexCache()
  })

  it('is OFF by default (no KV row, no env)', async () => {
    expect(await isSkillEngineEnabled()).toBe(false)
  })

  it('returns empty when the engine is disabled (no work, no FS scan)', async () => {
    const block = await buildActiveSkillsBlock('Boss ajker daily brief ta dao')
    expect(block).toBe('')
  })

  it('keeps native P0 image generation active when the broad rollout switch is off', async () => {
    const block = await buildActiveSkillsBlock(
      'Create three separate visual variations of an ALMA AI poster as separate images.',
    )
    expect(block).toContain('alma-image-generation')
    expect(block).toContain('generate_image')
  })

  it('keeps native P0 cited research active when the broad rollout switch is off', async () => {
    const block = await buildActiveSkillsBlock(
      'Compare OpenAI and Anthropic using only official sources with inline citations.',
    )
    expect(block).toContain('alma-research')
  })

  it('continues an existing P0 image pin when a short follow-up does not re-match the rule', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'alma-image-generation',
      skillRouteTrace: { source: 'router', layer: 'rule', reason: 'image', candidates: [], at: '' },
    })

    const block = await buildActiveSkillsBlock('make another one', { conversationId: 'c1' })

    expect(block).toContain('alma-image-generation')
    expect(block).toContain('generate_image')
    expect(mockPrisma.agentConversation.findUnique).toHaveBeenCalledTimes(1)
  })

  it('does not revive a non-P0 pin while the broad rollout switch is off', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'seo-fixing-own-site',
      skillRouteTrace: { source: 'router', layer: 'rule', reason: 'seo', candidates: [], at: '' },
    })

    expect(await buildActiveSkillsBlock('continue', { conversationId: 'c1' })).toBe('')
  })

  it('does not let a disabled non-P0 owner pin hijack a fresh P0 image request', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'seo-fixing-own-site',
      skillRouteTrace: { source: 'owner', layer: 'owner', reason: 'owner', candidates: [], at: '' },
    })

    const block = await buildActiveSkillsBlock('Create a launch poster image.', { conversationId: 'c1' })

    expect(block).toContain('alma-image-generation')
    expect(block).toContain('generate_image')
    expect(block).not.toContain('seo-fixing-own-site')
  })

  it('when enabled, an active skill matching the message is injected', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    // alma-owner-daily-briefing is status:active and keyword-matches "daily brief".
    const block = await buildActiveSkillsBlock('Boss ajker daily brief ta dao')
    expect(block).toContain('alma-owner-daily-briefing')
    expect(block).toContain('সক্রিয় Skill')
  })

  it('an unrelated message selects no skill even when enabled', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    expect(await buildActiveSkillsBlock('weather in Dhaka tomorrow')).toBe('')
  })

  it('empty user text yields no skills even when enabled', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    expect(await buildActiveSkillsBlock('   ')).toBe('')
  })
})
