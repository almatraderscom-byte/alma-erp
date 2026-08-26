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

import { reviveStalledInlineTurn, reviveSilentMs, REVIVE_CONTINUED_MESSAGE } from '@/agent/lib/turn-revive'

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
    // Codex P1 #859 r2: the CLAIM comes first (running→done, binding-valid),
    // and only then is the continuation queued — a successor must never be
    // enqueued while the real executor could still resume and finish.
    const claimOrder = prismaMock.agentTurn.updateMany.mock.invocationCallOrder[0]
    const scheduleOrder = selfContinue.scheduleSelfContinue.mock.invocationCallOrder[0]
    expect(claimOrder).toBeLessThan(scheduleOrder)
    expect(prismaMock.agentTurn.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'turn-1', status: 'running' },
      data: expect.objectContaining({ status: 'done' }),
    }))
    // Codex P2 #859 r2: a continued turn's terminal agrees with the 'done'
    // settlement — no error toast for work the server already resumed.
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith({
      data: { turnId: 'turn-1', seq: 52, type: 'done', payload: { type: 'done', message: REVIVE_CONTINUED_MESSAGE } },
    })
    expect(watchdog.publishTurnTerminal).toHaveBeenCalledWith('turn-1', 52, expect.objectContaining({ type: 'done' }))
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

  it('a NULL execution mode is not inline — worker-bound continuations are bound without a stamp (Codex P1 r4)', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn({ executionMode: null }))

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(false)
    expect(prismaMock.agentTurnEvent.findFirst).not.toHaveBeenCalled()
  })

  it('losing the claim CAS means the real executor settled — nothing is queued or written', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 51, createdAt: SILENT })
    prismaMock.agentTurn.updateMany.mockResolvedValueOnce({ count: 0 })

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(false)
    expect(prismaMock.agentTurnEvent.create).not.toHaveBeenCalled()
    // Codex P1 #859 r2: no successor may be queued for a turn we never claimed.
    expect(selfContinue.scheduleSelfContinue).not.toHaveBeenCalled()
  })

  it('a failed continuation schedule still settles the turn honestly', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 5, createdAt: SILENT })
    selfContinue.scheduleSelfContinue.mockRejectedValue(new Error('continuation_self_authority_missing'))

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res).toEqual({ revived: true, continuationScheduled: false })
    // No resume queued: the claimed 'done' is downgraded to an honest 'error',
    // and the terminal event matches it.
    expect(prismaMock.agentTurn.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'turn-1', status: 'done' },
      data: expect.objectContaining({ status: 'error' }),
    }))
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'error' }) }),
    )
  })

  it('a seq collision (executor woke after the silence read) skips the stamp and publish', async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue(runningTurn())
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 51, createdAt: SILENT })
    prismaMock.agentTurnEvent.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))

    const res = await reviveStalledInlineTurn({ turnId: 'turn-1', conversationId: 'conv-1', now: NOW })

    expect(res.revived).toBe(true)
    // lastSeq was never stamped backwards, and nothing was published that is
    // not in the durable log (Codex P2 #859). (The claim + downgrade-free
    // continued path leaves exactly one row update.)
    expect(prismaMock.agentTurn.updateMany).toHaveBeenCalledTimes(1)
    expect(watchdog.publishTurnTerminal).not.toHaveBeenCalled()
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
