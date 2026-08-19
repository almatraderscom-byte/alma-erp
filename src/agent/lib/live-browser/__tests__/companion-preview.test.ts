import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callOrder: string[] = []
const commandFindUnique = vi.fn()
const commandFindMany = vi.fn()
const commandFindFirst = vi.fn()
const commandUpdateMany = vi.fn()
const frameFindMany = vi.fn()
const frameFindUniqueOrThrow = vi.fn()
const frameDeleteMany = vi.fn()
const queryRaw = vi.fn()
const leaseFindUnique = vi.fn()
const leaseDeleteMany = vi.fn()
const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback({
  agentTurn: {
    findFirst: vi.fn(async () => {
      callOrder.push('turn')
      return { id: 'turn-1' }
    }),
  },
  liveBrowserPreviewLease: {
    upsert: vi.fn(async () => {
      callOrder.push('lease')
      return { deviceId: 'dev-1' }
    }),
  },
  liveBrowserCommand: {
    create: vi.fn(async () => {
      callOrder.push('command')
      return { id: 'cmd-1' }
    }),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => transaction(callback),
    $queryRaw: (query: unknown) => queryRaw(query),
    liveBrowserCommand: {
      create: vi.fn(),
      findUnique: (...args: unknown[]) => commandFindUnique(...args),
      findMany: (...args: unknown[]) => commandFindMany(...args),
      findFirst: (...args: unknown[]) => commandFindFirst(...args),
      updateMany: (...args: unknown[]) => commandUpdateMany(...args),
      update: vi.fn(),
    },
    liveBrowserFrame: {
      findMany: (...args: unknown[]) => frameFindMany(...args),
      findUniqueOrThrow: (...args: unknown[]) => frameFindUniqueOrThrow(...args),
      deleteMany: (...args: unknown[]) => frameDeleteMany(...args),
    },
    liveBrowserPreviewLease: {
      findUnique: (...args: unknown[]) => leaseFindUnique(...args),
      deleteMany: (...args: unknown[]) => leaseDeleteMany(...args),
    },
    agentTurn: { findFirst: vi.fn() },
  },
}))

import {
  BROWSER_DELIVERY_LEASE_MS,
  claimNextCommand,
  getActiveBrowserPreviewLease,
  resolveCommand,
  runCommand,
  storeBrowserPreviewFrame,
} from '../companion'

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  commandFindUnique.mockResolvedValue({ status: 'done', result: {}, error: null })
  commandFindMany.mockReset().mockResolvedValue([])
  commandFindFirst.mockReset().mockResolvedValue(null)
  commandUpdateMany.mockReset().mockResolvedValue({ count: 0 })
  frameFindMany.mockResolvedValue([])
  frameDeleteMany.mockResolvedValue({ count: 0 })
  leaseDeleteMany.mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('live Browser preview producer ordering', () => {
  it('commits the running-turn lease before the command can become claimable', async () => {
    vi.useFakeTimers()
    const resultPromise = runCommand('dev-1', 'read_text', {}, 2_000, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })
    await vi.advanceTimersByTimeAsync(701)
    await expect(resultPromise).resolves.toMatchObject({ ok: true, commandId: 'cmd-1' })
    expect(callOrder).toEqual(['turn', 'lease', 'command'])
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('uses the server-returned monotonic sequence and prunes old tab contexts', async () => {
    const capturedAt = new Date('2026-08-19T10:00:00.000Z')
    queryRaw.mockResolvedValue([{ capturedAt, sequence: 9 }])
    frameFindMany.mockResolvedValue([{ contextId: 'tab:1' }])
    await expect(storeBrowserPreviewFrame({
      deviceId: 'dev-1',
      contextId: 'tab:9',
      dataUri: 'data:image/jpeg;base64,AAA=',
      capturedAt,
      lease: {
        deviceId: 'dev-1',
        turnId: 'turn-1',
        conversationId: 'conv-1',
        expiresAt: new Date(capturedAt.getTime() + 20_000),
      },
    })).resolves.toEqual({ accepted: true, frameAt: capturedAt, frameSeq: 9 })
    expect(frameFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 8 }))
    expect(frameDeleteMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1', contextId: { in: ['tab:1'] } },
    })
  })

  it('does not replace pixels when the capture timestamp did not advance', async () => {
    const currentAt = new Date('2026-08-19T10:00:01.000Z')
    queryRaw.mockResolvedValue([])
    frameFindUniqueOrThrow.mockResolvedValue({ capturedAt: currentAt, sequence: 4 })
    const result = await storeBrowserPreviewFrame({
      deviceId: 'dev-1',
      contextId: 'tab:9',
      dataUri: 'data:image/jpeg;base64,OLD=',
      capturedAt: new Date('2026-08-19T10:00:00.000Z'),
      lease: {
        deviceId: 'dev-1',
        turnId: 'turn-1',
        conversationId: 'conv-1',
        expiresAt: new Date('2026-08-19T10:00:20.000Z'),
      },
    })
    expect(result).toEqual({ accepted: false, frameAt: currentAt, frameSeq: 4 })
  })

  it('clears an expired lease only if the exact observed lease still owns the row', async () => {
    const expiresAt = new Date('2026-08-19T09:00:00.000Z')
    leaseFindUnique.mockResolvedValue({
      deviceId: 'dev-1', turnId: 'turn-a', conversationId: 'conv-a', expiresAt,
    })
    await expect(getActiveBrowserPreviewLease('dev-1')).resolves.toBeNull()
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'dev-1', turnId: 'turn-a', conversationId: 'conv-a', expiresAt,
      },
    })
  })

  it('reclaims the same command after a dropped poll response and a bounded lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    const state: {
      status: string
      deliveredAt: Date | null
      deliveryAttempts: number
    } = { status: 'queued', deliveredAt: null, deliveryAttempts: 0 }
    const row = { id: 'cmd-drop', action: 'click', params: { selector: '#go' } }

    commandFindMany.mockImplementation(async (args: {
      where: { deliveredAt: { lt: Date } }
    }) => state.status === 'delivered'
      && state.deliveredAt
      && state.deliveredAt < args.where.deliveredAt.lt
      ? [{ id: row.id, deliveredAt: state.deliveredAt, deliveryAttempts: state.deliveryAttempts }]
      : [])
    commandFindFirst.mockImplementation(async () => state.status === 'queued' ? row : null)
    commandUpdateMany.mockImplementation(async (args: {
      where: { status?: string }
      data: { status?: string; deliveredAt?: Date | null; deliveryAttempts?: { increment: number } }
    }) => {
      if (args.where.status === 'queued' && state.status === 'queued') {
        state.status = 'delivered'
        state.deliveredAt = args.data.deliveredAt as Date
        state.deliveryAttempts += args.data.deliveryAttempts?.increment ?? 0
        return { count: 1 }
      }
      if (args.where.status === 'delivered' && state.status === 'delivered') {
        state.status = args.data.status ?? state.status
        state.deliveredAt = args.data.deliveredAt ?? state.deliveredAt
        return { count: 1 }
      }
      return { count: 0 }
    })

    await expect(claimNextCommand('dev-1')).resolves.toMatchObject({ id: 'cmd-drop' })
    expect(state).toMatchObject({ status: 'delivered', deliveryAttempts: 1 })

    vi.advanceTimersByTime(BROWSER_DELIVERY_LEASE_MS + 1)
    await expect(claimNextCommand('dev-1')).resolves.toMatchObject({ id: 'cmd-drop' })
    expect(state).toMatchObject({ status: 'delivered', deliveryAttempts: 2 })
  })

  it('commits a result once and ignores a duplicate without making it claimable again', async () => {
    commandUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    commandFindUnique.mockResolvedValue({ deviceId: 'dev-1', status: 'done' })

    await expect(resolveCommand('dev-1', 'cmd-1', { ok: true, data: { title: 'done' } }))
      .resolves.toEqual({ ok: true })
    await expect(resolveCommand('dev-1', 'cmd-1', { ok: true, data: { title: 'duplicate' } }))
      .resolves.toEqual({ ok: true, ignored: true })
    await expect(claimNextCommand('dev-1')).resolves.toBeNull()
    expect(commandUpdateMany.mock.calls[1]?.[0]).toMatchObject({
      where: { id: 'cmd-1', deviceId: 'dev-1', status: { in: ['queued', 'delivered'] } },
    })
  })
})
