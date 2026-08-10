import { describe, it, expect, afterEach } from 'vitest'
import { buildActiveSkillsBlock, isSkillEngineEnabled, __resetSkillIndexCache } from '@/agent/lib/skill-engine/runtime'

describe('skill-engine runtime bridge (gated)', () => {
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
