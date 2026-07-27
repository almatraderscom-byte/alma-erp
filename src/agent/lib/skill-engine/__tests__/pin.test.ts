/**
 * SK-3 — the pin: decided once, announced, owner-overridable.
 *
 * The two properties that matter are cost and truth. A skill re-picked every
 * turn changes the cached prompt prefix every turn (the owner's meter already
 * showed what that costs), and a value that changes silently is not something
 * he can "see", which was the whole request.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentConversation: { findUnique: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { announcedSkill, announcementLine, resolveSkillPin, setOwnerPin } from '@/agent/lib/skill-engine/pin'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentConversation.update.mockResolvedValue({})
})

describe('the pin sticks', () => {
  it('returns the existing pin without re-routing', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'seo-fixing-own-site',
      skillRouteTrace: { source: 'router', layer: 'rule', reason: 'x', candidates: [], at: '' },
    })

    const pin = await resolveSkillPin('c1', 'সম্পূর্ণ ভিন্ন একটা প্রশ্ন')

    expect(pin.skill).toBe('seo-fixing-own-site')
    expect(mockPrisma.agentConversation.update).not.toHaveBeenCalled()
  })

  it('remembers that BOSS chose it, not the router', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'seo-auditing-own-site',
      skillRouteTrace: { source: 'owner', layer: 'owner', reason: '', candidates: [], at: '' },
    })

    expect((await resolveSkillPin('c1', 'যা খুশি')).source).toBe('owner')
  })

  it('routes and stores the trace when nothing is pinned yet', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ pinnedSkill: null, skillRouteTrace: null })

    const pin = await resolveSkillPin('c1', 'almatraders.com এর ছবির alt ঠিক করো', { includeDraft: true })

    expect(pin.skill).toBe('seo-fixing-own-site')
    expect(pin.source).toBe('router')
    const written = mockPrisma.agentConversation.update.mock.calls[0][0].data
    expect(written.pinnedSkill).toBe('seo-fixing-own-site')
    expect(written.skillRouteTrace.layer).toBe('rule')
    expect(written.skillRouteTrace.reason).toContain('own-site-fix')
  })

  it('pins nothing rather than guessing on a plain question', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ pinnedSkill: null, skillRouteTrace: null })

    const pin = await resolveSkillPin('c1', 'valo acho?', { includeDraft: true })

    expect(pin.skill).toBeNull()
    expect(mockPrisma.agentConversation.update).not.toHaveBeenCalled()
  })

  it('fails open — a skill-engine hiccup must never break a turn', async () => {
    mockPrisma.agentConversation.findUnique.mockRejectedValue(new Error('db down'))
    expect((await resolveSkillPin('c1', 'যেকোনো কিছু')).skill).toBeNull()
  })
})

describe('the owner override', () => {
  it('records that he chose it', async () => {
    await setOwnerPin('c1', 'seo-auditing-own-site')
    const data = mockPrisma.agentConversation.update.mock.calls[0][0].data
    expect(data.pinnedSkill).toBe('seo-auditing-own-site')
    expect(data.skillRouteTrace.source).toBe('owner')
  })

  it('clearing the chip wipes the pin AND its trace', async () => {
    await setOwnerPin('c1', null)
    expect(mockPrisma.agentConversation.update.mock.calls[0][0].data).toEqual({
      pinnedSkill: null,
      skillRouteTrace: null,
    })
  })
})

describe('the announcement', () => {
  it('names the skill', () => {
    expect(announcementLine('seo-fixing-own-site')).toContain('seo-fixing-own-site')
  })

  it('can tell whether the reply actually said it', () => {
    expect(announcedSkill('`seo-fixing-own-site` skill ব্যবহার করছি।', 'seo-fixing-own-site')).toBe(true)
    expect(announcedSkill('বস, কাজ শুরু করছি।', 'seo-fixing-own-site')).toBe(false)
  })
})
