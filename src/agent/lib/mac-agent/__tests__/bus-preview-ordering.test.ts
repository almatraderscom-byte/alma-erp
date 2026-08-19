import { beforeEach, describe, expect, it, vi } from 'vitest'

const created: Array<Record<string, unknown>> = []
const outerFindFirst = vi.fn()
const findMany = vi.fn(async (_args?: unknown) => [] as Array<Record<string, unknown>>)
const updateMany = vi.fn()
const txFrameFind = vi.fn()
const txCommandFind = vi.fn()
const txTurnFind = vi.fn()
const txCommandCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
  created.push(args.data)
  return { id: `row-${created.length}` }
})
const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback({
  $executeRaw: vi.fn(async () => 1),
  agentTurn: { findFirst: txTurnFind },
  macAgentFrame: { findUnique: txFrameFind },
  macAgentCommand: { findFirst: txCommandFind, create: txCommandCreate },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => transaction(callback),
    macAgentFrame: { findUnique: vi.fn() },
    macAgentCommand: {
      create: vi.fn(),
      findFirst: (...args: unknown[]) => outerFindFirst(...args),
      findMany: (args: unknown) => findMany(args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    agentKvSetting: { findUnique: vi.fn(async () => ({ value: 'true' })) },
  },
}))

import {
  SCREEN_STREAM_DELIVERY_LEASE_MS,
  claimNextCommand,
  enqueueCommand,
} from '../bus'

beforeEach(() => {
  vi.clearAllMocks()
  created.length = 0
  txFrameFind.mockResolvedValue(null)
  txCommandFind.mockResolvedValue(null)
  txTurnFind.mockResolvedValue({ id: 'turn-1' })
  findMany.mockResolvedValue([])
  updateMany.mockResolvedValue({ count: 1 })
})

describe('Mac preview producer ordering', () => {
  it('prepends a bound auto stream before a run_mac_command row', async () => {
    await enqueueCommand({
      deviceId: 'mac-1',
      action: 'run_command',
      params: { command: 'git status' },
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })

    expect(created.map((row) => row.action)).toEqual(['screen_stream', 'run_command'])
    expect(created[0]).toMatchObject({
      params: { mode: 'start', reason: 'computer_use', maxSeconds: 120 },
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })
  })

  it('preserves FIFO so an older A-stop cannot be leapfrogged by a B-start', async () => {
    outerFindFirst.mockResolvedValueOnce({
      id: 'stop-a',
      action: 'screen_stream',
      params: { mode: 'stop', reason: 'computer_use' },
      sessionKey: null,
      turnId: 'turn-a',
      conversationId: 'conv-1',
    })
    const claimed = await claimNextCommand('mac-1')
    expect(outerFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { deviceId: 'mac-1', status: { in: ['queued', 'delivered'] } },
    })
    expect(outerFindFirst.mock.calls[0]?.[0]?.where).not.toHaveProperty('action')
    expect(claimed?.id).toBe('stop-a')
    expect(claimed).toMatchObject({ turnId: 'turn-a', conversationId: 'conv-1' })
  })

  it('reclaims a lost screen-stream poll quickly before releasing the scoped work behind it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
    const row = {
      id: 'start-a',
      action: 'screen_stream',
      status: 'queued',
      params: { mode: 'start', reason: 'computer_use' },
      sessionKey: null,
      turnId: 'turn-a',
      conversationId: 'conv-a',
      deliveredAt: null as Date | null,
      deliveryAttempts: 0,
    }
    outerFindFirst.mockImplementation(async () => ({ ...row }))
    findMany.mockImplementation(async () => {
      if (row.status !== 'delivered' || !row.deliveredAt) return []
      return Date.now() - row.deliveredAt.getTime() > SCREEN_STREAM_DELIVERY_LEASE_MS
        ? [{
            id: row.id,
            deliveredAt: row.deliveredAt,
            deliveryAttempts: row.deliveryAttempts,
          }]
        : []
    })
    updateMany.mockImplementation(async (args: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => {
      if (args.where.status === 'queued' && row.status === 'queued') {
        row.status = 'delivered'
        row.deliveredAt = args.data.deliveredAt as Date
        return { count: 1 }
      }
      if (args.where.status === 'delivered' && row.status === 'delivered') {
        row.status = String(args.data.status)
        row.deliveredAt = (args.data.deliveredAt as Date | null) ?? row.deliveredAt
        if (args.data.deliveryAttempts) row.deliveryAttempts += 1
        return { count: 1 }
      }
      return { count: 0 }
    })

    const first = await claimNextCommand('mac-1')
    expect(first).toMatchObject({
      id: 'start-a',
      action: 'screen_stream',
      turnId: 'turn-a',
      conversationId: 'conv-a',
    })
    // Dropped HTTP response: the daemon asks again, but later visual work must
    // not leapfrog the still-leased stream start.
    await expect(claimNextCommand('mac-1')).resolves.toBeNull()

    vi.advanceTimersByTime(SCREEN_STREAM_DELIVERY_LEASE_MS + 1)
    const recovered = await claimNextCommand('mac-1')
    expect(recovered).toMatchObject({
      id: 'start-a',
      action: 'screen_stream',
      turnId: 'turn-a',
      conversationId: 'conv-a',
    })
    expect(row.deliveryAttempts).toBe(1)
    vi.useRealTimers()
  })

  it('restarts a done auto start when its frame is stale', async () => {
    txFrameFind.mockResolvedValue({ at: new Date(Date.now() - 11_000) })
    txCommandFind.mockResolvedValue({
      status: 'done',
      params: { mode: 'start', reason: 'computer_use' },
    })
    await enqueueCommand({
      deviceId: 'mac-1',
      action: 'screenshot',
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })
    expect(created.map((row) => row.action)).toEqual(['screen_stream', 'screenshot'])
  })

  it('does not treat another turn\'s fresh device frame as this turn\'s stream', async () => {
    txFrameFind.mockResolvedValue({
      at: new Date(),
      turnId: 'turn-b',
      conversationId: 'conv-1',
    })
    txCommandFind.mockResolvedValue({
      status: 'done',
      params: { mode: 'start', reason: 'computer_use' },
    })
    await enqueueCommand({
      deviceId: 'mac-1',
      action: 'screenshot',
      turnId: 'turn-a',
      conversationId: 'conv-1',
    })

    expect(created.map((row) => row.action)).toEqual(['screen_stream', 'screenshot'])
  })

  it('does not auto-start capture for a terminal turn', async () => {
    txTurnFind.mockResolvedValue(null)
    await enqueueCommand({
      deviceId: 'mac-1',
      action: 'screenshot',
      turnId: 'turn-done',
      conversationId: 'conv-1',
    })

    expect(created.map((row) => row.action)).toEqual(['screenshot'])
    expect(txFrameFind).not.toHaveBeenCalled()
    expect(txCommandFind).not.toHaveBeenCalled()
  })
})
