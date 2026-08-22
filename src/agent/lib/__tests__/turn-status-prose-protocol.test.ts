import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Prose lifecycle v2 — the protocol stamp on the turn row is part of the
 * negotiation (Codex P1 on #834): a turn whose row could not be stamped must be
 * served as protocol 1, because every reconnect reader derives the protocol
 * from that row.
 */
const mocks = vi.hoisted(() => ({ updateMany: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { agentTurn: { updateMany: mocks.updateMany } } }))
vi.mock('@/agent/lib/live-browser/turn-lane', () => ({ lockDirectYouTubeLaneAuthority: async () => {} }))

import { setTurnProseProtocol, turnVersionsFor } from '@/agent/lib/turn-status'

beforeEach(() => mocks.updateMany.mockReset())

describe('setTurnProseProtocol', () => {
  it('is true only when the row was actually stamped', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })
    expect(await setTurnProseProtocol('turn-1', 2)).toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'turn-1' }, data: { versions: turnVersionsFor(2) } })
  })

  it('is false on a zero-row update, a thrown error, or a missing turn id', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })
    expect(await setTurnProseProtocol('turn-gone', 2)).toBe(false)
    mocks.updateMany.mockRejectedValueOnce(new Error('db down'))
    expect(await setTurnProseProtocol('turn-1', 2)).toBe(false)
    expect(await setTurnProseProtocol(null, 2)).toBe(false)
  })

  it('protocol 1 needs no stamp', async () => {
    expect(await setTurnProseProtocol('turn-1', 1)).toBe(true)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})
