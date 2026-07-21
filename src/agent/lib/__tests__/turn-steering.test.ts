import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows: Array<{ id: string; clientRequestId: string; content: unknown; usage: unknown }> = []
const updates: unknown[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async (args: unknown) => { updates.push(args); return { count: 1 } }),
    },
  },
}))

import { claimTurnSteeringMessages } from '../turn-steering'

describe('durable running-turn steering queue', () => {
  beforeEach(() => { rows.length = 0; updates.length = 0 })

  it('injects a queued owner instruction once into the same running turn', async () => {
    rows.push({
      id: 'm-steer-1',
      clientRequestId: 'client-1',
      content: [{ type: 'text', text: 'Primary text আরও family matching করে লিখো' }],
      usage: { steering: { targetTurnId: 'turn-1', status: 'queued' } },
    })
    const claimedIds = new Set<string>()
    const first = await claimTurnSteeringMessages('turn-1', 'conv-1', claimedIds)
    expect(first).toHaveLength(1)
    expect(first[0].prompt).toContain('BOSS LIVE UPDATE')
    expect(first[0].prompt).toContain('family matching')
    claimedIds.add(first[0].id)
    expect(await claimTurnSteeringMessages('turn-1', 'conv-1', claimedIds)).toEqual([])
    expect(updates).toHaveLength(1)
  })

  it('does nothing when there is no durable turn id', async () => {
    expect(await claimTurnSteeringMessages(null, 'conv-1', new Set())).toEqual([])
  })
})
