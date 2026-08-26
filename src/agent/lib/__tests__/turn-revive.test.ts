import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  agentTurn: {
    findUnique: vi.fn(async () => null as unknown),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  agentTurnEvent: {
    findFirst: vi.fn(async () => null as unknown),
    create: vi.fn(async () => ({} as unknown)),
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

const selfContinue = vi.hoisted(() => ({
  scheduleSelfContinue: vi.fn(async () => ({ scheduled: true, hops: 1 })),
}))
vi.mock('@/agent/lib/self-continue', () => selfContinue)

const watchdog = vi.hoisted(() => ({
  publishTurnTerminal: vi.fn(async () => {}),
}))
vi.mock('@/agent/lib/turn-watchdog', () => watchdog)

import { reviveStalledInlineTurn, reviveSilentMs, REVIVE_TERMINAL_MESSAGE } from '@/agent/lib/turn-revive'

const NOW = new Date('2026-08-26T12:00:00Z')
const SILENT = new Date(NOW.getTime() - 10 * 60 * 1000)
const FRESH = new Date(NOW.getTime() - 30 * 1000)

const runningTurn = (over: Record<string, unknown> = {}) => ({
  id: 'turn-1', conversationId: 'conv-1', status: 'running',
  executionMode: 'inline', startedAt: SILENT, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.agentTurn.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.agentTurnEvent.create.mockResolvedValue({})
  selfContinue.scheduleSelfContinue.mockResolvedValue({ scheduled: true, hops: 1 })
  delete process.env.AGENT_REOPEN_REVIVE_SILENT_MS
})

describe('reviveStalledInlineTurn', () => {
  it('settles a silent inline turn: continuation first, then claim, terminal at next seq, publish', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 51, createdAt: SILENT })

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res).toEqual({ revived: true, continuationScheduled: true })
    expect(selfContinue.scheduleSelfContinue).toHaveBeenCalledWith({ conversationId: 'conv-1', sourceTurnId: 'turn-1' })
    // schedule happened BEFORE the status flip (binding requires running/done)
    const scheduleOrder = selfContinue.scheduleSelfContinue.mock.invocationCallOrder[0]
    const claimOrder = prismaMock.agentTurn.updateMany.mock.invocationCallOrder[0]
    expect(scheduleOrder).toBeLessThan(claimOrder)
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith({
      data: { turnId: 'turn-1', seq: 52, type: 'error', payload: { type: 'error', message: REVIVE_TERMINAL_MESSAGE } },
    })
    expect(watchdog.publishTurnTerminal).toHaveBeenCalledWith('turn-1', 52, expect.anything())
  })

  it('a turn with fresh durable events is left alone', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 51, createdAt: FRESH })

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(false)
    expect(prismaMock.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(selfContinue.scheduleSelfContinue).not.toHaveBeenCalled()
  })

  it('worker/engine turns are never revived here — the slice-aware watchdog owns them', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn({ executionMode: 'worker' }))

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(false)
    expect(prismaMock.agentTurnEvent.findFirst).not.toHaveBeenCalled()
  })

  it('losing the claim CAS means the real executor settled — reports not revived', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 51, createdAt: SILENT })
    prismaMock.agentTurn.updateMany.mockResolvedValueOnce({ count: 0 })

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(false)
    expect(prismaMock.agentTurnEvent.create).not.toHaveBeenCalled()
  })

  it('a failed continuation schedule still settles the turn honestly', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 5, createdAt: SILENT })
    selfContinue.scheduleSelfContinue.mockRejectedValue(new Error('continuation_self_authority_missing'))

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res).toEqual({ revived: true, continuationScheduled: false })
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalled()
  })

  it('a conversation mismatch never touches the turn', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn({ conversationId: 'other' }))
    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })
    expect(res.revived).toBe(false)
  })

  it('a turn with no events uses startedAt as last activity and reaps at seq 0', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue(null)

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(true)
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seq: 0 }) }),
    )
  })

  it('reviveSilentMs floors the env override', () => {
    process.env.AGENT_REOPEN_REVIVE_SILENT_MS = '1000'
    expect(reviveSilentMs()).toBe(180_000)
    process.env.AGENT_REOPEN_REVIVE_SILENT_MS = '300000'
    expect(reviveSilentMs()).toBe(300_000)
  })
})
