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

import {
  announcedSkill,
  announcementLine,
  resolveSkillPin,
  isExplicitErpRecordRead,
  setOwnerPin,
  shouldReleaseRouterPin,
} from '@/agent/lib/skill-engine/pin'

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

  it('releases a router-owned staff pin for an explicit order/approval job', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'alma-staff-dispatch',
      skillRouteTrace: { source: 'router', layer: 'rule', reason: 'staff', candidates: [], at: '' },
    })

    const pin = await resolveSkillPin(
      'c1',
      "Check today's pending approval count and the three newest orders read-only.",
    )

    expect(pin.skill).toBeNull()
    expect(pin.trace?.reason).toContain('scope-exit')
    expect(mockPrisma.agentConversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { pinnedSkill: null, skillRouteTrace: null },
    })
  })

  it('releases a router-owned incident pin when the chat moves to ERP orders', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'alma-agent-incident-diagnosis',
      skillRouteTrace: { source: 'router', layer: 'model', reason: 'incident', candidates: [], at: '' },
    })

    const pin = await resolveSkillPin(
      'c1',
      'PROD-ROUTER-CHECK: Show the three newest orders with order ID and status, read-only.',
    )

    expect(pin.skill).toBeNull()
    expect(pin.trace?.reason).toContain('scope-exit')
    expect(mockPrisma.agentConversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { pinnedSkill: null, skillRouteTrace: null },
    })
  })

  it('keeps short staff follow-ups and never releases unrelated pins', () => {
    expect(shouldReleaseRouterPin('alma-staff-dispatch', 'ha koro')).toBe(false)
    expect(shouldReleaseRouterPin('alma-staff-dispatch', 'Mustahid ke pathao')).toBe(false)
    expect(shouldReleaseRouterPin('alma-agent-incident-diagnosis', 'run health scan again')).toBe(false)
    expect(shouldReleaseRouterPin('alma-agent-incident-diagnosis', 'latest orders dekhao')).toBe(true)
    expect(shouldReleaseRouterPin('seo-auditing-own-site', 'latest orders dekhao')).toBe(false)
  })

  it('releases any router workflow for a pure rich-answer request', () => {
    const prompt = 'Return one rich response with a syntax-highlighted code block and rendered LaTeX.'
    expect(shouldReleaseRouterPin('alma-image-generation', prompt)).toBe(true)
    expect(shouldReleaseRouterPin('alma-research', prompt)).toBe(true)
  })

  it('keeps research pinned when only its output format changes', () => {
    const prompt = 'Compare Gemini and Claude; provide a bullet list with inline citations.'
    expect(shouldReleaseRouterPin('alma-research', prompt)).toBe(false)
  })

  it('keeps plain ERP record reads out of narrow workflow skills', () => {
    expect(isExplicitErpRecordRead('Show the three newest orders with order ID and status')).toBe(true)
    expect(isExplicitErpRecordRead('latest orders dekhao')).toBe(true)
    expect(isExplicitErpRecordRead('why are the newest orders failing?')).toBe(false)
    expect(isExplicitErpRecordRead('run health scan again')).toBe(false)
  })

  it('does not re-pin a narrow skill after an ERP record-read scope exit', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({ pinnedSkill: null, skillRouteTrace: null })

    const pin = await resolveSkillPin(
      'c1',
      'Show the three newest orders with order ID and status',
      { includeDraft: true },
    )

    expect(pin.skill).toBeNull()
    expect(pin.source).toBe('none')
    expect(pin.trace?.reason).toContain('erp-record-read')
    expect(mockPrisma.agentConversation.update).not.toHaveBeenCalled()
  })

  it('does not release an owner-selected staff pin', async () => {
    mockPrisma.agentConversation.findUnique.mockResolvedValue({
      pinnedSkill: 'alma-staff-dispatch',
      skillRouteTrace: { source: 'owner', layer: 'owner', reason: '', candidates: [], at: '' },
    })

    const pin = await resolveSkillPin('c1', 'latest orders dekhao')
    expect(pin.skill).toBe('alma-staff-dispatch')
    expect(pin.source).toBe('owner')
    expect(mockPrisma.agentConversation.update).not.toHaveBeenCalled()
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
