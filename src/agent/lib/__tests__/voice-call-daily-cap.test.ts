import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock prisma BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentVoiceCall: { count: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { callsPlacedToday, callAttemptsToday } from '@/agent/lib/voice-call'

/**
 * The daily cap used to count every row in agent_voice_calls. On 2026-07-25 that meant 49
 * INBOUND calls (23 of them the self-test harness's fake caller) ate the owner's outbound
 * budget, and the agent then refused to phone anyone for the rest of the day. Failed attempts
 * counted too, so a bad day at the provider turned into an outage of our own making.
 */
describe('daily call cap accounting', () => {
  beforeEach(() => {
    mockPrisma.agentVoiceCall.count.mockReset()
    mockPrisma.agentVoiceCall.count.mockResolvedValue(0)
  })

  it('counts only outbound calls that actually reached the network', async () => {
    await callsPlacedToday()
    const where = mockPrisma.agentVoiceCall.count.mock.calls[0][0].where

    // Reached the network — a row exists long before this is set.
    expect(where.dialedAt).toEqual({ not: null })

    // Inbound rows are somebody calling US; they are not our spend.
    expect(where.OR).toEqual([
      { purpose: null },
      { purpose: { notIn: ['inbound_call', 'inbound_owner_call', 'inbound_voicemail'] } },
    ])
  })

  it('counts every outbound attempt for the runaway-loop backstop, reached or not', async () => {
    await callAttemptsToday()
    const where = mockPrisma.agentVoiceCall.count.mock.calls[0][0].where

    // The backstop must see failures — that is its whole point.
    expect(where.dialedAt).toBeUndefined()
    // But still only ours, so a busy inbound morning cannot trip it either.
    expect(where.OR).toEqual([
      { purpose: null },
      { purpose: { notIn: ['inbound_call', 'inbound_owner_call', 'inbound_voicemail'] } },
    ])
  })

  it('both windows start at Dhaka midnight, not UTC midnight', async () => {
    await callsPlacedToday()
    const gte: Date = mockPrisma.agentVoiceCall.count.mock.calls[0][0].where.createdAt.gte
    // Dhaka is UTC+6, so its midnight is 18:00 UTC the day before.
    expect(gte.getUTCHours()).toBe(18)
    expect(gte.getUTCMinutes()).toBe(0)
  })
})
