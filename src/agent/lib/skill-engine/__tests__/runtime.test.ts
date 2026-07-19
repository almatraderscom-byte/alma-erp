import { describe, it, expect, afterEach } from 'vitest'
import { buildActiveSkillsBlock, isSkillEngineEnabled, __resetSkillIndexCache } from '@/agent/lib/skill-engine/runtime'

describe('skill-engine runtime bridge (gated)', () => {
  afterEach(() => {
    delete process.env.SKILL_ENGINE_ENABLED
    __resetSkillIndexCache()
  })

  it('is OFF by default', () => {
    expect(isSkillEngineEnabled()).toBe(false)
  })

  it('returns empty when the engine is disabled (no work, no FS scan)', async () => {
    const block = await buildActiveSkillsBlock('Boss ajker daily brief ta dao')
    expect(block).toBe('')
  })

  it('when enabled, scans the real skills dir and never throws (draft skills stay excluded)', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    // The only shipped skill (alma-owner-daily-briefing) is status:draft, so discovery
    // offers nothing yet → '' — proving the enabled path is fail-open and status-gated.
    const block = await buildActiveSkillsBlock('Boss ajker daily brief ta dao')
    expect(typeof block).toBe('string')
    expect(block).toBe('')
  })

  it('empty user text yields no skills even when enabled', async () => {
    process.env.SKILL_ENGINE_ENABLED = 'true'
    expect(await buildActiveSkillsBlock('   ')).toBe('')
  })
})
