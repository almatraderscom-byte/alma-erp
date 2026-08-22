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
const laneLockQuery = vi.fn()
const turnFindFirst = vi.fn()
const turnUpdateMany = vi.fn()
const commandCreate = vi.fn()
const commandCount = vi.fn()
const leaseFindUnique = vi.fn()
const leaseDeleteMany = vi.fn()
const leaseUpsert = vi.fn()
const leaseUpdateMany = vi.fn()
const kvFindUnique = vi.fn()
const kvUpsert = vi.fn()
const deviceFindFirst = vi.fn()
const ownerTurnCurrent = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true))
const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback({
  $queryRaw: (...args: unknown[]) => {
    const query = args[0] as { strings?: readonly string[] }
    const sql = query?.strings?.join('?') ?? ''
    if (sql.includes('live_browser_preview_device')) {
      callOrder.push('device_lock')
      return Promise.resolve([])
    }
    if (sql.includes('live_browser_dispatch_global')) {
      callOrder.push('dispatch_lock')
      return Promise.resolve([])
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      callOrder.push('authority_lock')
      return Promise.resolve([])
    }
    callOrder.push('lane_lock')
    return laneLockQuery(...args)
  },
  agentTurn: {
    findFirst: (...args: unknown[]) => {
      callOrder.push('turn')
      return turnFindFirst(...args)
    },
    updateMany: (...args: unknown[]) => turnUpdateMany(...args),
  },
  liveBrowserPreviewLease: {
    findUnique: (...args: unknown[]) => leaseFindUnique(...args),
    deleteMany: (...args: unknown[]) => leaseDeleteMany(...args),
    upsert: (...args: unknown[]) => {
      callOrder.push('lease')
      return leaseUpsert(...args)
    },
    updateMany: (...args: unknown[]) => leaseUpdateMany(...args),
  },
  liveBrowserCommand: {
    create: (...args: unknown[]) => {
      callOrder.push('command')
      return commandCreate(...args)
    },
    updateMany: (...args: unknown[]) => commandUpdateMany(...args),
    findUnique: (...args: unknown[]) => commandFindUnique(...args),
    findFirst: (...args: unknown[]) => commandFindFirst(...args),
    count: (...args: unknown[]) => commandCount(...args),
  },
  agentKvSetting: {
    findUnique: (...args: unknown[]) => kvFindUnique(...args),
    upsert: (...args: unknown[]) => kvUpsert(...args),
  },
  liveBrowserDevice: {
    findFirst: (...args: unknown[]) => deviceFindFirst(...args),
  },
}))

vi.mock('../turn-owner-input', () => ({
  isTurnOwnerExecutionCurrent: (conversationId: unknown, turnId: unknown, client: unknown) => (
    ownerTurnCurrent(conversationId, turnId, client)
  ),
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
    agentKvSetting: {
      findUnique: (...args: unknown[]) => kvFindUnique(...args),
      upsert: (...args: unknown[]) => kvUpsert(...args),
    },
    agentTurn: { findFirst: vi.fn() },
  },
}))

import {
  BROWSER_DELIVERY_LEASE_MS,
  claimNextCommand,
  getActiveBrowserPreviewLease,
  renewBrowserPreviewLease,
  resolveCommand,
  runCommand,
  storeBrowserPreviewFrame,
  LIVE_BROWSER_AUTHORIZE_PROTOCOL,
} from '../companion'

beforeEach(() => {
  vi.clearAllMocks()
  callOrder.length = 0
  commandFindUnique.mockResolvedValue({ status: 'done', result: {}, error: null })
  commandFindMany.mockReset().mockResolvedValue([])
  commandFindFirst.mockReset().mockResolvedValue(null)
  commandUpdateMany.mockReset().mockResolvedValue({ count: 0 })
  commandCount.mockReset().mockResolvedValue(0)
  frameFindMany.mockResolvedValue([])
  frameDeleteMany.mockResolvedValue({ count: 0 })
  leaseDeleteMany.mockResolvedValue({ count: 1 })
  leaseFindUnique.mockReset().mockResolvedValue(null)
  leaseUpsert.mockReset().mockResolvedValue({
    deviceId: 'dev-1',
    turnId: 'turn-1',
    conversationId: 'conv-1',
    expiresAt: new Date('2026-08-19T10:00:25.000Z'),
  })
  leaseUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  kvFindUnique.mockReset().mockResolvedValue({ value: 'true' })
  kvUpsert.mockReset().mockResolvedValue({ key: 'live_browser_enabled', value: 'true' })
  deviceFindFirst.mockReset().mockResolvedValue({ id: 'dev-1' })
  ownerTurnCurrent.mockReset().mockResolvedValue(true)
  laneLockQuery.mockReset().mockResolvedValue([{ id: 'direct-youtube-lane' }])
  turnFindFirst.mockReset().mockResolvedValue({ id: 'turn-1' })
  turnUpdateMany.mockReset().mockResolvedValue({ count: 1 })
  commandCreate.mockReset().mockResolvedValue({ id: 'cmd-1' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('live Browser preview producer ordering', () => {
  it('locks renewal and removes an older running turn lease after newer owner input', async () => {
    ownerTurnCurrent.mockImplementationOnce(async () => {
      callOrder.push('owner_current')
      return false
    })

    await expect(renewBrowserPreviewLease({
      deviceId: 'dev-1',
      turnId: 'turn-old',
      conversationId: 'conv-1',
    })).resolves.toBeNull()

    expect(callOrder).toEqual(['authority_lock', 'device_lock', 'owner_current'])
    expect(ownerTurnCurrent).toHaveBeenCalledWith(
      'conv-1',
      'turn-old',
      expect.objectContaining({ liveBrowserPreviewLease: expect.any(Object) }),
    )
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1', turnId: 'turn-old', conversationId: 'conv-1' },
    })
    expect(leaseUpsert).not.toHaveBeenCalled()
  })

  it('deletes a still-running preview lease when its owner turn is no longer current', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    const expiresAt = new Date('2026-08-19T10:00:25.000Z')
    leaseFindUnique.mockResolvedValue({
      deviceId: 'dev-1', turnId: 'turn-old', conversationId: 'conv-1', expiresAt,
    })
    ownerTurnCurrent.mockImplementationOnce(async () => {
      callOrder.push('owner_current')
      return false
    })

    await expect(getActiveBrowserPreviewLease('dev-1')).resolves.toBeNull()

    expect(callOrder).toEqual(['authority_lock', 'device_lock', 'owner_current'])
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: {
        deviceId: 'dev-1', turnId: 'turn-old', conversationId: 'conv-1', expiresAt,
      },
    })
  })

  it('queues the command without publishing a device-global preview lease', async () => {
    vi.useFakeTimers()
    const resultPromise = runCommand('dev-1', 'read_text', {}, 2_000, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })
    await vi.advanceTimersByTimeAsync(701)
    await expect(resultPromise).resolves.toMatchObject({ ok: true, commandId: 'cmd-1' })
    expect(callOrder).toEqual(['authority_lock', 'dispatch_lock', 'turn', 'command'])
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('locks and rejects a stale direct-browser lane before command creation', async () => {
    laneLockQuery.mockResolvedValueOnce([])
    await expect(runCommand('dev-1', 'click', { ref: 'e1' }, 2_000, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'superseded-token',
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringContaining('direct_browser_lane_stale'),
    })
    expect(callOrder).toEqual(['authority_lock', 'dispatch_lock', 'lane_lock'])
    expect(callOrder).not.toContain('command')
    expect(commandFindUnique).not.toHaveBeenCalled()
  })

  it('serializes a current direct-browser lane lock before command creation', async () => {
    vi.useFakeTimers()
    const resultPromise = runCommand('dev-1', 'click', { ref: 'e1' }, 2_000, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'current-token',
    })
    await vi.advanceTimersByTimeAsync(701)
    await expect(resultPromise).resolves.toMatchObject({ ok: true, commandId: 'cmd-1' })
    expect(callOrder).toEqual(['authority_lock', 'dispatch_lock', 'lane_lock', 'turn', 'command'])
  })

  it('claims a command with a freshly coupled preview grant for that exact turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:30.000Z'))
    commandFindFirst.mockResolvedValueOnce({
      id: 'cmd-coupled',
      action: 'read_text',
      params: {},
      turnId: 'turn-1',
      conversationId: 'conv-1',
    })
    commandUpdateMany.mockResolvedValueOnce({ count: 1 })
    const expiresAt = new Date('2026-08-19T10:00:55.000Z')
    leaseUpsert.mockResolvedValueOnce({
      deviceId: 'dev-1', turnId: 'turn-1', conversationId: 'conv-1', expiresAt,
    })

    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toMatchObject({
      id: 'cmd-coupled',
      preview: {
        deviceId: 'dev-1',
        turnId: 'turn-1',
        conversationId: 'conv-1',
        expiresAt,
      },
    })
    expect(leaseUpsert).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      create: { deviceId: 'dev-1', turnId: 'turn-1', conversationId: 'conv-1', expiresAt },
      update: { turnId: 'turn-1', conversationId: 'conv-1', expiresAt },
      select: { deviceId: true, turnId: true, conversationId: true, expiresAt: true },
    })
    expect(callOrder).toContain('lease')
  })

  it('does not let another conversation overwrite an in-flight command preview', async () => {
    commandFindFirst.mockResolvedValueOnce({
      turnId: 'turn-a',
      conversationId: 'conv-a',
    })

    await expect(renewBrowserPreviewLease({
      deviceId: 'dev-1',
      turnId: 'turn-b',
      conversationId: 'conv-b',
    })).resolves.toBeNull()

    expect(callOrder).toEqual(['authority_lock', 'device_lock'])
    expect(ownerTurnCurrent).not.toHaveBeenCalled()
    expect(leaseUpsert).not.toHaveBeenCalled()
  })

  it('does not claim a second command while this device has an in-flight effect', async () => {
    commandFindFirst
      .mockResolvedValueOnce({
        id: 'cmd-b',
        action: 'click',
        params: {},
        turnId: 'turn-b',
        conversationId: 'conv-b',
      })
      .mockResolvedValueOnce({ id: 'cmd-a' })

    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(callOrder).toEqual(['authority_lock', 'dispatch_lock', 'device_lock'])
    expect(commandUpdateMany).not.toHaveBeenCalled()
    expect(leaseUpsert).not.toHaveBeenCalled()
  })

  it('does not enqueue for a canceled/terminal direct-browser turn', async () => {
    turnFindFirst.mockResolvedValueOnce(null)
    await expect(runCommand('dev-1', 'click', { ref: 'e1' }, 2_000, {
      turnId: 'turn-canceled',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'current-token',
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringContaining('direct_browser_turn_not_running'),
    })
    expect(callOrder).toEqual(['authority_lock', 'dispatch_lock', 'lane_lock', 'turn'])
    expect(callOrder).not.toContain('command')
  })

  it('never dispatches a second effect for an already-tombstoned reserved command id', async () => {
    const reserved = '123e4567-e89b-42d3-a456-426614174000'
    commandCreate.mockRejectedValueOnce(Object.assign(new Error('unique id'), { code: 'P2002' }))
    await expect(runCommand('dev-1', 'click', { ref: 'e1' }, 2_000, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'current-token',
    }, reserved)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      commandId: reserved,
      error: expect.stringContaining('will not be dispatched twice'),
    })
    expect(commandCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: reserved, action: 'click' }),
    }))
    expect(commandFindUnique).not.toHaveBeenCalled()
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

  it('reclaims a read-only command after a dropped poll response and a bounded lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    const state: {
      status: string
      deliveredAt: Date | null
      deliveryAttempts: number
    } = { status: 'queued', deliveredAt: null, deliveryAttempts: 0 }
    const row = { id: 'cmd-drop', action: 'read_text', params: {} }

    commandFindMany.mockImplementation(async (args: {
      where: { status?: string | { in?: string[] }; deliveredAt: { lt: Date } }
    }) => (
      typeof args.where.status === 'string'
        ? state.status === args.where.status
        : (args.where.status?.in ?? []).includes(state.status)
    )
      && state.deliveredAt
      && state.deliveredAt < args.where.deliveredAt.lt
      ? [{
        id: row.id,
        action: row.action,
        status: state.status,
        deliveredAt: state.deliveredAt,
        deliveryAttempts: state.deliveryAttempts,
      }]
      : [])
    commandFindFirst.mockImplementation(async (args: { where?: { status?: string } }) => (
      state.status === (args.where?.status ?? 'queued') ? row : null
    ))
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

    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toMatchObject({ id: 'cmd-drop' })
    expect(state).toMatchObject({ status: 'delivered', deliveryAttempts: 1 })

    vi.advanceTimersByTime(BROWSER_DELIVERY_LEASE_MS + 1)
    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toMatchObject({ id: 'cmd-drop' })
    expect(state).toMatchObject({ status: 'delivered', deliveryAttempts: 2 })
  })

  it('never replays a mutating command after a crash between effect and result persistence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    const state: {
      status: string
      deliveredAt: Date | null
      deliveryAttempts: number
      error: string | null
    } = { status: 'queued', deliveredAt: null, deliveryAttempts: 0, error: null }
    const row = {
      id: 'cmd-effect-crash',
      action: 'click',
      params: { ref: 'e1', observationPrecondition: { domObservationId: 'dom-1' } },
    }

    commandFindMany.mockImplementation(async (args: {
      where: { status?: string | { in?: string[] }; deliveredAt: { lt: Date } }
    }) => (
      typeof args.where.status === 'string'
        ? state.status === args.where.status
        : (args.where.status?.in ?? []).includes(state.status)
    )
      && state.deliveredAt
      && state.deliveredAt < args.where.deliveredAt.lt
      ? [{
        id: row.id,
        action: row.action,
        status: state.status,
        deliveredAt: state.deliveredAt,
          deliveryAttempts: state.deliveryAttempts,
        }]
      : [])
    commandFindFirst.mockImplementation(async (args: { where?: { status?: string } }) => (
      state.status === (args.where?.status ?? 'queued') ? row : null
    ))
    commandUpdateMany.mockImplementation(async (args: {
      where: { status?: string }
      data: {
        status?: string
        deliveredAt?: Date | null
        deliveryAttempts?: { increment: number }
        error?: string
      }
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
        state.error = args.data.error ?? state.error
        return { count: 1 }
      }
      return { count: 0 }
    })

    // The Companion claims and executes this click, then dies before POSTing a
    // result. Once the delivery lease expires, server state becomes terminal
    // unknown; it must never return the click for a second execution.
    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toMatchObject({ id: row.id, action: 'click' })
    expect(state).toMatchObject({ status: 'delivered', deliveryAttempts: 1 })
    vi.advanceTimersByTime(BROWSER_DELIVERY_LEASE_MS + 1)
    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(state).toMatchObject({
      status: 'failed',
      deliveryAttempts: 1,
      error: expect.stringContaining('delivery_outcome_unknown'),
    })
  })

  it('commits a result once and ignores a duplicate without making it claimable again', async () => {
    commandUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    commandFindUnique.mockResolvedValue({
      deviceId: 'dev-1', status: 'done', turnId: null, conversationId: null,
    })

    await expect(resolveCommand('dev-1', 'cmd-1', { ok: true, data: { title: 'done' } }))
      .resolves.toEqual({ ok: true })
    await expect(resolveCommand('dev-1', 'cmd-1', { ok: true, data: { title: 'duplicate' } }))
      .resolves.toEqual({ ok: true, ignored: true })
    await expect(claimNextCommand('dev-1', LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commandUpdateMany.mock.calls[1]?.[0]).toMatchObject({
      where: { id: 'cmd-1', deviceId: 'dev-1', status: 'executing' },
    })
  })

  it('never accepts legacy success from delivered, while allowing fail-closed denial', async () => {
    commandFindUnique.mockResolvedValue({
      deviceId: 'dev-1', status: 'delivered', turnId: null, conversationId: null,
    })
    commandUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(resolveCommand('dev-1', 'legacy-delivered', { ok: true, data: { changed: true } }))
      .resolves.toEqual({ ok: true, ignored: true })
    expect(commandUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'legacy-delivered', deviceId: 'dev-1', status: 'executing' },
    }))

    commandUpdateMany.mockResolvedValueOnce({ count: 1 })
    await expect(resolveCommand('dev-1', 'legacy-delivered', {
      ok: false,
      error: 'authorization_update_required',
    })).resolves.toEqual({ ok: true })
    expect(commandUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: {
        id: 'legacy-delivered',
        deviceId: 'dev-1',
        status: { in: ['delivered', 'executing'] },
      },
      data: expect.objectContaining({
        status: 'failed',
        error: 'authorization_update_required',
      }),
    }))
  })
})
