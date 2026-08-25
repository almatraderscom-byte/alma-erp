/**
 * Stranded-turn watchdog (owner incident 2026-08-26: 54 forever-'running'
 * corpses; the app truthfully showed "সংযোগ ফিরছে" indefinitely because the
 * server said running forever). Activity decides, not age: fresh events keep
 * a long slice alive; silence beyond the window reaps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  agentTurn: {
    findMany: vi.fn(async () => [] as unknown[]),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  agentTurnEvent: {
    findFirst: vi.fn(async (_args: { where: { turnId: string } }) => null as unknown),
    create: vi.fn(async () => ({} as unknown)),
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

const turnStatus = vi.hoisted(() => ({
  finalizeTurnIfRunning: vi.fn(async () => {}),
}))
vi.mock('@/agent/lib/turn-status', () => turnStatus)
// Claim-first semantics (Codex P1 #857 r2): updateMany on {id, status:'running'}
// IS the claim — default mock reports 1 row claimed.

import { sweepStrandedTurns, TURN_STALE_MS, WATCHDOG_TERMINAL_MESSAGE } from '@/agent/lib/turn-watchdog'

const NOW = new Date('2026-08-26T12:00:00Z')
const OLD = new Date(NOW.getTime() - 2 * TURN_STALE_MS)

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.agentTurn.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.agentTurnEvent.create.mockResolvedValue({})
  delete process.env.LONG_TASK_REDIS_URL
  delete process.env.REDIS_URL
})

describe('sweepStrandedTurns', () => {
  it('reaps a silent old turn: durable error terminal at next seq, then finalize', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([{ id: 'turn-dead', startedAt: OLD }])
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 8, createdAt: OLD })

    const res = await sweepStrandedTurns(NOW)

    expect(res.reaped).toEqual(['turn-dead'])
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith({
      data: {
        turnId: 'turn-dead',
        seq: 9,
        type: 'error',
        payload: { type: 'error', message: WATCHDOG_TERMINAL_MESSAGE },
      },
    })
    // Claim-first: the status CAS finalizes the row before any event append.
    expect(prismaMock.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'turn-dead', status: 'running' },
      data: expect.objectContaining({ status: 'error' }),
    }))
  })

  it('a turn that settled between selection and reap is NEVER fed a watchdog error', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([{ id: 'turn-settled', startedAt: OLD }])
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 8, createdAt: OLD })
    prismaMock.agentTurn.updateMany.mockResolvedValue({ count: 0 })

    const res = await sweepStrandedTurns(NOW)

    expect(res.reaped).toEqual([])
    expect(prismaMock.agentTurnEvent.create).not.toHaveBeenCalled()
  })

  it('an old turn with FRESH events is alive — never touched', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([{ id: 'turn-long-slice', startedAt: OLD }])
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({
      seq: 500,
      createdAt: new Date(NOW.getTime() - 60_000),
    })

    const res = await sweepStrandedTurns(NOW)

    expect(res.reaped).toEqual([])
    expect(res.stillAlive).toBe(1)
    expect(prismaMock.agentTurnEvent.create).not.toHaveBeenCalled()
    expect(turnStatus.finalizeTurnIfRunning).not.toHaveBeenCalled()
  })

  it('a zero-event corpse (lastSeq -1 class) reaps from startedAt with seq 0', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([{ id: 'turn-noevents', startedAt: OLD }])
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue(null)

    const res = await sweepStrandedTurns(NOW)

    expect(res.reaped).toEqual(['turn-noevents'])
    expect(prismaMock.agentTurnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seq: 0 }) }),
    )
  })

  it('a seq conflict after a WON claim still counts as reaped — status-only settlement covers tails', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([{ id: 'turn-racy', startedAt: OLD }])
    prismaMock.agentTurnEvent.findFirst.mockResolvedValue({ seq: 3, createdAt: OLD })
    prismaMock.agentTurnEvent.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))

    const res = await sweepStrandedTurns(NOW)

    // The claim already finalized the row; the tailer settles from status.
    expect(res.reaped).toEqual(['turn-racy'])
  })

  it('young running turns are not even candidates', async () => {
    prismaMock.agentTurn.findMany.mockResolvedValue([])
    const res = await sweepStrandedTurns(NOW)
    expect(res.scanned).toBe(0)
    const call = prismaMock.agentTurn.findMany.mock.calls[0] as unknown as [
      { where: { status: string; startedAt: { lt: Date } } },
    ]
    expect(call[0].where.status).toBe('running')
    expect(call[0].where.startedAt.lt.getTime()).toBe(NOW.getTime() - TURN_STALE_MS)
  })
})

describe('backlog starvation (Codex P2 #857)', () => {
  it('alive old turns at the head do not stop stranded turns behind them from reaping', async () => {
    const fresh = { seq: 10, createdAt: new Date(NOW.getTime() - 60_000) }
    const dead = { seq: 3, createdAt: OLD }
    prismaMock.agentTurn.findMany.mockResolvedValue([
      { id: 'alive-1', startedAt: OLD },
      { id: 'alive-2', startedAt: OLD },
      { id: 'dead-1', startedAt: OLD },
    ])
    prismaMock.agentTurnEvent.create.mockResolvedValue({})
    prismaMock.agentTurnEvent.findFirst.mockImplementation(async (args: { where: { turnId: string } }) =>
      args.where.turnId.startsWith('alive') ? fresh : dead)

    const res = await sweepStrandedTurns(NOW)

    expect(res.stillAlive).toBe(2)
    expect(res.reaped).toEqual(['dead-1'])
  })
})
