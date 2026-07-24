import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  scheduledCall: { create: vi.fn().mockResolvedValue({ id: 'sc1' }) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn().mockResolvedValue({}) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)
const mockWa = vi.hoisted(() => ({ sendTwilioWaText: vi.fn().mockResolvedValue({ sid: 'SM1' }) }))
vi.mock('@/agent/lib/wa/twilio-wa', () => mockWa)

import { applyCallRetryPolicy, parseRetryCount, retryEligible } from '@/agent/lib/call-retry-policy'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OWNER_PHONE_NUMBERS = '01779640373'
})

const rec = (over = {}) => ({
  id: 'c1', toNumber: '+8801712345678', recipientName: 'করিম',
  purpose: 'দাম জিজ্ঞেস', firstMessage: null, conversationId: null, ...over,
})

describe('call retry policy (human-PA point 3)', () => {
  it('parses the retry tag', () => {
    expect(parseRetryCount('x [পুনঃচেষ্টা 2/2]')).toBe(2)
    expect(parseRetryCount('x')).toBe(0)
  })
  it('owner / inbound / answered are not eligible', () => {
    expect(retryEligible(rec({ toNumber: '+8801779640373' }), 'no_answer')).toBe(false)
    expect(retryEligible(rec({ purpose: 'inbound_call' }), 'no_answer')).toBe(false)
    expect(retryEligible(rec(), 'completed')).toBe(false)
    expect(retryEligible(rec(), 'busy')).toBe(true)
  })
  it('first miss → rebooks +10min with tag 1/2', async () => {
    const out = await applyCallRetryPolicy(rec(), 'no_answer')
    expect(out).toBe('rebooked')
    const data = mockPrisma.scheduledCall.create.mock.calls[0][0].data
    expect(data.purpose).toContain('[পুনঃচেষ্টা 1/2]')
    expect(data.dueAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000)
  })
  it('retries exhausted → WhatsApp text fallback + tier-2 notify', async () => {
    const out = await applyCallRetryPolicy(rec({ purpose: 'দাম জিজ্ঞেস [পুনঃচেষ্টা 2/2]' }), 'no_answer')
    expect(out).toBe('text_fallback')
    expect(mockWa.sendTwilioWaText).toHaveBeenCalled()
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ tier: 2 }))
    expect(mockPrisma.scheduledCall.create).not.toHaveBeenCalled()
  })
})
