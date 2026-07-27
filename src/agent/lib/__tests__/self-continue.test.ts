/**
 * The agent's own wake-up (owner ruling 2026-07-26).
 *
 * "এজেন্ট ১৩ মিনিট কাজ করার পর যদি কাজ শেষ না হয় … নিজে থেকে একটা wakeup সেট
 * করবে … এভাবে কন্টিনিউ করে শেষ করবে। এখানে Plan-Drive-এর কোনো কাজ নেই।"
 *
 * Two things used to stop that: continuation only fired for BROWSER turns, and
 * the resume was a hint to the client (so it needed his app open).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const continuation = vi.hoisted(() => ({ enqueueAgentContinuation: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/agent/lib/approval-continuation', () => continuation)

import { shouldAutoContinueTurn, mayContinueChain, MAX_SELF_CONTINUE_HOPS } from '@/agent/lib/continuation-policy'
import { scheduleSelfContinue, buildResumeDirective } from '@/agent/lib/self-continue'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
  mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
  mockPrisma.agentKvSetting.delete.mockResolvedValue({})
})

describe('when a deadline-hit turn should carry itself on', () => {
  const tools = (names: string[]) => names.map((toolName) => ({ toolName, status: 'success' as const }))

  it('resumes ANY unfinished tool work, not just browser work', () => {
    // The exact case that used to stop dead: a long SEO/tool job.
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false,
      tools: tools(['run_website_seo_audit', 'check_website_seo_audit']),
    })).toBe(true)
  })

  it('still resumes browser work', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false, tools: tools(['live_browser_click']),
    })).toBe(true)
  })

  it('does not resume when Boss has an open question', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: true, tools: tools(['get_orders']),
    })).toBe(false)
  })

  it('does not resume a turn that never hit the deadline', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: false, hasAskCard: false, tools: tools(['get_orders']),
    })).toBe(false)
  })

  it('does not resume once terminal proof landed', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false, tools: tools(['complete_skill_pack_run']),
    })).toBe(false)
  })

  it('does not resume a turn that achieved nothing', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false,
      tools: [{ toolName: 'get_orders', status: 'error' as const }],
    })).toBe(false)
  })
})

describe('the wake-up chain', () => {
  it('schedules the next hop on the server, so his app need not be open', async () => {
    const res = await scheduleSelfContinue({ conversationId: 'c1', summary: 'অডিট পড়া হয়েছে' })

    expect(res.scheduled).toBe(true)
    expect(res.hops).toBe(1)
    const call = continuation.enqueueAgentContinuation.mock.calls[0][0]
    expect(call.conversationId).toBe('c1')
    expect(call.force).toBe(true)               // not subject to the auto-continue toggle
    expect(call.message).toContain('SELF-CONTINUE')
    expect(call.message).toContain('অডিট পড়া হয়েছে')
  })

  it('counts hops so a confused task cannot run all night', () => {
    expect(mayContinueChain(0)).toBe(true)
    expect(mayContinueChain(MAX_SELF_CONTINUE_HOPS - 1)).toBe(true)
    expect(mayContinueChain(MAX_SELF_CONTINUE_HOPS)).toBe(false)
  })

  it('stops scheduling at the hop limit and says why', async () => {
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: String(MAX_SELF_CONTINUE_HOPS) })

    const res = await scheduleSelfContinue({ conversationId: 'c1', summary: 'x' })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toContain('hop limit')
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('tells the next hop to continue, not to re-plan from scratch', () => {
    const d = buildResumeDirective(3, 'ব্যাচ ২ শেষ')
    expect(d).toContain('hop 3')
    expect(d).toContain('আবার কোরো না')
    expect(d).toContain('Boss-কে জিজ্ঞেস করার দরকার নেই')
  })
})
