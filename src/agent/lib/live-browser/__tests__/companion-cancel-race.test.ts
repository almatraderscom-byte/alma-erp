import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

type CommandRow = {
  id: string
  deviceId: string
  action: string
  params: Record<string, unknown>
  status: string
  turnId: string | null
  conversationId: string | null
  result: Record<string, unknown> | null
  error: string | null
  deliveryAttempts: number
  deliveredAt: Date | null
  resolvedAt: Date | null
  createdAt: Date
}

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  turnFindUnique: vi.fn(),
  turnFindFirst: vi.fn(),
  turnUpdateMany: vi.fn(),
  focusUpdateMany: vi.fn(),
  focusEventCreate: vi.fn(),
  askCardUpdateMany: vi.fn(),
  commandCreate: vi.fn(),
  commandFindUnique: vi.fn(),
  commandFindMany: vi.fn(),
  commandFindFirst: vi.fn(),
  commandUpdateMany: vi.fn(),
  commandCount: vi.fn(),
  previewLeaseUpsert: vi.fn(),
  previewLeaseFindUnique: vi.fn(),
  previewLeaseUpdateMany: vi.fn(),
  previewLeaseDeleteMany: vi.fn(),
  kvFindUnique: vi.fn(),
  kvUpsert: vi.fn(),
  ownerTurnCurrent: vi.fn(),
  activeFocusFindMany: vi.fn(),
  deviceFindFirst: vi.fn(),
  deviceFindMany: vi.fn(),
  deviceUpdateMany: vi.fn(),
}))

vi.mock('../turn-owner-input', () => ({
  isTurnOwnerExecutionCurrent: (...args: unknown[]) => mocks.ownerTurnCurrent(...args),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => mocks.transaction(callback),
    agentTurn: {
      findUnique: (...args: unknown[]) => mocks.turnFindUnique(...args),
    },
    liveBrowserCommand: {
      findUnique: (...args: unknown[]) => mocks.commandFindUnique(...args),
      findMany: (...args: unknown[]) => mocks.commandFindMany(...args),
      findFirst: (...args: unknown[]) => mocks.commandFindFirst(...args),
      updateMany: (...args: unknown[]) => mocks.commandUpdateMany(...args),
      count: (...args: unknown[]) => mocks.commandCount(...args),
    },
    agentConversationFocus: {
      findMany: (...args: unknown[]) => mocks.activeFocusFindMany(...args),
    },
    liveBrowserPreviewLease: {
      findUnique: (...args: unknown[]) => mocks.previewLeaseFindUnique(...args),
      deleteMany: (...args: unknown[]) => mocks.previewLeaseDeleteMany(...args),
    },
    liveBrowserDevice: {
      findMany: (...args: unknown[]) => mocks.deviceFindMany(...args),
    },
  },
}))

import {
  authenticateDevice,
  authorizeClaimedBrowserCommand,
  BROWSER_DELIVERY_LEASE_MS,
  cancelLiveBrowserTurn,
  claimNextCommand,
  getActiveBrowserPreviewLease,
  LIVE_BROWSER_AUTHORIZE_PROTOCOL,
  resolveCommand,
  revokeDeviceSafely,
  runCommand,
  setLiveBrowserEnabled,
  stopAllLiveBrowserDispatches,
} from '../companion'

const conversationId = 'conv-direct'
const turnId = 'turn-direct'
const deviceId = 'device-1'
// Production heads use the durable AgentTurn id as the lane fencing token.
const laneToken = turnId

let lane: { id: string; status: string; currentStep: string; version: number; token: string; expectedAskCardId?: string }
let turn: {
  id: string
  conversationId: string
  status: string
  cancelRequested: boolean
  startedAt: Date
}
let commands: CommandRow[]
let transactionTail: Promise<void>
let globalEnabled: boolean
let dispatchNotBefore: string | null
let deviceRevoked: boolean
let deviceTokenHash: string | null

function applyCommandUpdate(
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } {
  let count = 0
  for (const command of commands) {
    if (where.id && command.id !== where.id) continue
    if (where.deviceId && command.deviceId !== where.deviceId) continue
    if (where.turnId && command.turnId !== where.turnId) continue
    if (where.conversationId && command.conversationId !== where.conversationId) continue
    if (
      where.deliveredAt instanceof Date
      && command.deliveredAt?.getTime() !== where.deliveredAt.getTime()
    ) continue
    if (typeof where.status === 'string' && command.status !== where.status) continue
    if (
      where.status
      && typeof where.status === 'object'
      && !((where.status as { in?: string[] }).in ?? []).includes(command.status)
    ) continue
    count += 1
    if (typeof data.status === 'string') command.status = data.status
    if (typeof data.error === 'string') command.error = data.error
    if (data.deliveredAt instanceof Date) command.deliveredAt = data.deliveredAt
    if (data.resolvedAt instanceof Date) command.resolvedAt = data.resolvedAt
    const attempts = data.deliveryAttempts as { increment?: unknown } | undefined
    if (typeof attempts?.increment === 'number') command.deliveryAttempts += attempts.increment
  }
  return { count }
}

beforeEach(() => {
  vi.clearAllMocks()
  lane = {
    id: 'direct-youtube-lane',
    status: 'active',
    currentStep: 'open',
    version: 1,
    token: laneToken,
  }
  turn = {
    id: turnId,
    conversationId,
    status: 'running',
    cancelRequested: false,
    startedAt: new Date('2026-08-20T00:00:00.000Z'),
  }
  commands = []
  globalEnabled = true
  dispatchNotBefore = null
  deviceRevoked = false
  deviceTokenHash = createHash('sha256').update('paired-device-token').digest('hex')
  transactionTail = Promise.resolve()

  mocks.turnFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (
    where.id === turn.id ? { id: turn.id, conversationId: turn.conversationId } : null
  ))
  mocks.turnFindFirst.mockImplementation(async ({ where }: {
    where: { id: string; conversationId: string; status?: string; cancelRequested?: boolean }
  }) => (
    where.id === turn.id
    && where.conversationId === turn.conversationId
    && (where.status === undefined || turn.status === where.status)
    && (where.cancelRequested === undefined || turn.cancelRequested === where.cancelRequested)
      ? {
          id: turn.id,
          status: turn.status,
          cancelRequested: turn.cancelRequested,
          startedAt: turn.startedAt,
        }
      : null
  ))
  mocks.turnUpdateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }) => {
    if (
      where.id !== turn.id
      || where.conversationId !== turn.conversationId
      || where.status !== turn.status
      || where.cancelRequested !== turn.cancelRequested
    ) return { count: 0 }
    if (typeof data.status === 'string') turn.status = data.status
    if (typeof data.cancelRequested === 'boolean') turn.cancelRequested = data.cancelRequested
    return { count: 1 }
  })
  mocks.focusUpdateMany.mockImplementation(async () => {
    lane.status = 'abandoned'
    lane.currentStep = 'canceled_by_owner'
    lane.version += 1
    return { count: 1 }
  })
  mocks.focusEventCreate.mockResolvedValue({ id: 'focus-event-1' })
  mocks.askCardUpdateMany.mockResolvedValue({ count: 1 })
  mocks.queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) => {
    const sql = query.strings?.join('?') ?? ''
    if (sql.includes('live_browser_stop_boundary_clock')) {
      return [{ now: new Date() }]
    }
    const requiresCurrentLane = sql.includes('"status" IN')
    if (requiresCurrentLane && (
      lane.status !== 'active'
      || lane.currentStep !== 'open'
      || lane.token !== laneToken
    )) return []
    return [{
      id: lane.id,
      status: lane.status,
      currentStep: lane.currentStep,
      version: lane.version,
      artifacts: {
        laneToken: lane.token,
        ...(lane.expectedAskCardId ? { expectedAskCardId: lane.expectedAskCardId } : {}),
      },
    }]
  })
  mocks.commandCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const command: CommandRow = {
      id: String(data.id ?? 'command-1'),
      deviceId: String(data.deviceId),
      action: String(data.action),
      params: data.params as Record<string, unknown>,
      status: String(data.status),
      turnId: String(data.turnId),
      conversationId: String(data.conversationId),
      result: null,
      error: null,
      deliveryAttempts: 0,
      deliveredAt: null,
      resolvedAt: null,
      createdAt: new Date(),
    }
    commands.push(command)
    return { id: command.id }
  })
  mocks.commandFindMany.mockImplementation(async ({ where }: { where?: Record<string, unknown> }) => {
    if (!where) return []
    const statuses = typeof where.status === 'object'
      ? (where.status as { in?: string[] }).in ?? []
      : typeof where.status === 'string' ? [where.status] : []
    return commands
      .filter((command) => (
        (!where.deviceId || command.deviceId === where.deviceId)
        && (!where.turnId || command.turnId === where.turnId)
        && (!where.conversationId || command.conversationId === where.conversationId)
        && (statuses.length === 0 || statuses.includes(command.status))
        && (
          !where.deliveredAt
          || Boolean(
            command.deliveredAt
            && command.deliveredAt < (where.deliveredAt as { lt: Date }).lt
          )
        )
      ))
      .map((command) => ({ ...command }))
  })
  mocks.commandFindFirst.mockImplementation(async (args?: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? { status: 'queued' }
    const statuses = typeof where.status === 'object'
      ? (where.status as { in?: string[] }).in ?? []
      : typeof where.status === 'string' ? [where.status] : []
    return commands.find((command) => (
      (!where.deviceId || command.deviceId === where.deviceId)
      && (!where.turnId || command.turnId === where.turnId)
      && (!where.conversationId || command.conversationId === where.conversationId)
      && (statuses.length === 0 || statuses.includes(command.status))
    )) ?? null
  })
  mocks.commandFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const command = commands.find((candidate) => candidate.id === where.id)
    return command
      ? { ...command }
      : null
  })
  mocks.commandUpdateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }) => applyCommandUpdate(where, data))
  mocks.previewLeaseUpsert.mockResolvedValue({ deviceId })
  mocks.previewLeaseFindUnique.mockResolvedValue(null)
  mocks.previewLeaseDeleteMany.mockResolvedValue({ count: 1 })
  mocks.commandCount.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (
    commands.filter((command) => (
      (!where.turnId || command.turnId === where.turnId)
      && (!where.conversationId || command.conversationId === where.conversationId)
      && (!where.status || command.status === where.status)
    )).length
  ))
  mocks.previewLeaseUpdateMany.mockResolvedValue({ count: 1 })
  mocks.kvFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (
    where.key === 'live_browser_enabled'
      ? { value: globalEnabled ? 'true' : 'false' }
      : dispatchNotBefore ? { value: dispatchNotBefore } : null
  ))
  mocks.kvUpsert.mockImplementation(async ({ where, update }: {
    where: { key: string }
    update: { value: string }
  }) => {
    if (where.key === 'live_browser_enabled') globalEnabled = update.value === 'true'
    else dispatchNotBefore = update.value
    return { key: where.key, value: update.value }
  })
  mocks.ownerTurnCurrent.mockReset().mockResolvedValue(true)
  mocks.activeFocusFindMany.mockImplementation(async () => (
    lane.status === 'active' || lane.status === 'awaiting_owner'
      ? [{ conversationId, artifacts: { laneToken: lane.token } }]
      : []
  ))
  mocks.deviceFindFirst.mockImplementation(async ({ where }: {
    where: { id?: string; revoked?: boolean; tokenHash?: { not?: null } }
  }) => {
    if (where.id && where.id !== deviceId) return null
    if (typeof where.revoked === 'boolean' && where.revoked !== deviceRevoked) return null
    if (where.tokenHash?.not === null && !deviceTokenHash) return null
    return { id: deviceId }
  })
  mocks.deviceFindMany.mockImplementation(async ({ where }: {
    where: { revoked?: boolean; tokenHash?: { not?: null } }
  }) => {
    if (typeof where.revoked === 'boolean' && where.revoked !== deviceRevoked) return []
    if (where.tokenHash?.not === null && !deviceTokenHash) return []
    return [{
      id: deviceId,
      ownerUserId: 'owner-1',
      tokenHash: deviceTokenHash,
      revoked: deviceRevoked,
    }]
  })
  mocks.deviceUpdateMany.mockImplementation(async ({ where, data }: {
    where: { id?: string; revoked?: boolean; tokenHash?: { not?: null } }
    data: { revoked?: boolean; tokenHash?: string | null }
  }) => {
    if (where.id && where.id !== deviceId) return { count: 0 }
    if (typeof where.revoked === 'boolean' && where.revoked !== deviceRevoked) return { count: 0 }
    if (where.tokenHash?.not === null && !deviceTokenHash) return { count: 0 }
    if (typeof data.revoked === 'boolean') deviceRevoked = data.revoked
    if (data.tokenHash === null || typeof data.tokenHash === 'string') {
      deviceTokenHash = data.tokenHash
    }
    return { count: 1 }
  })

  const tx = {
    $queryRaw: (...args: unknown[]) => mocks.queryRaw(...args),
    agentTurn: {
      findFirst: (...args: unknown[]) => mocks.turnFindFirst(...args),
      updateMany: (...args: unknown[]) => mocks.turnUpdateMany(...args),
    },
    agentConversationFocus: {
      updateMany: (...args: unknown[]) => mocks.focusUpdateMany(...args),
    },
    agentFocusEvent: {
      create: (...args: unknown[]) => mocks.focusEventCreate(...args),
    },
    agentAskCard: {
      updateMany: (...args: unknown[]) => mocks.askCardUpdateMany(...args),
    },
    liveBrowserCommand: {
      create: (...args: unknown[]) => mocks.commandCreate(...args),
      findUnique: (...args: unknown[]) => mocks.commandFindUnique(...args),
      findMany: (...args: unknown[]) => mocks.commandFindMany(...args),
      findFirst: (...args: unknown[]) => mocks.commandFindFirst(...args),
      count: (...args: unknown[]) => mocks.commandCount(...args),
      updateMany: (...args: unknown[]) => mocks.commandUpdateMany(...args),
    },
    liveBrowserPreviewLease: {
      findUnique: (...args: unknown[]) => mocks.previewLeaseFindUnique(...args),
      upsert: (...args: unknown[]) => mocks.previewLeaseUpsert(...args),
      updateMany: (...args: unknown[]) => mocks.previewLeaseUpdateMany(...args),
      deleteMany: (...args: unknown[]) => mocks.previewLeaseDeleteMany(...args),
    },
    agentKvSetting: {
      findUnique: (...args: unknown[]) => mocks.kvFindUnique(...args),
      upsert: (...args: unknown[]) => mocks.kvUpsert(...args),
    },
    liveBrowserDevice: {
      findFirst: (...args: unknown[]) => mocks.deviceFindFirst(...args),
      updateMany: (...args: unknown[]) => mocks.deviceUpdateMany(...args),
    },
  }
  mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
    const predecessor = transactionTail
    let release!: () => void
    transactionTail = new Promise<void>((resolve) => { release = resolve })
    await predecessor
    try {
      return await callback(tx)
    } finally {
      release()
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('direct browser Stop/claim linearization', () => {
  it('global STOP wins before enqueue and a later ON cannot resurrect stale work', async () => {
    await expect(stopAllLiveBrowserDispatches([deviceId])).resolves.toEqual({
      stoppedQueuedOrDelivered: 0,
      executing: 0,
    })
    expect(globalEnabled).toBe(false)
    expect(turn).toMatchObject({ status: 'canceled', cancelRequested: true })
    expect(lane).toMatchObject({ status: 'abandoned', currentStep: 'canceled_by_owner' })

    await expect(runCommand(deviceId, 'click', { ref: 'e1' }, 2_000, {
      turnId,
      conversationId,
      directBrowserLaneToken: laneToken,
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'live_browser_disabled_before_enqueue',
    })
    expect(commands).toHaveLength(0)

    await expect(setLiveBrowserEnabled(true)).resolves.toBe(true)
    // Even if a pre-STOP lane escaped/reopened after the snapshot, the durable
    // boundary rejects its old AgentTurn after UI Resume.
    turn.status = 'running'
    turn.cancelRequested = false
    lane.status = 'active'
    lane.currentStep = 'open'
    await expect(runCommand(deviceId, 'click', { ref: 'late' }, 2_000, {
      turnId,
      conversationId,
      directBrowserLaneToken: laneToken,
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'direct_browser_turn_predates_owner_stop',
    })
    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands).toHaveLength(0)
  })

  it('server-owned global STOP reaps stale executing without another device poll', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T16:00:00.000Z'))
    commands.push({
      id: 'stale-executing',
      deviceId,
      action: 'click',
      params: { ref: 'e1', __almaDirectBrowserLaneToken: laneToken },
      status: 'executing',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 1,
      deliveredAt: new Date(Date.now() - 40_001),
      resolvedAt: null,
      createdAt: new Date(Date.now() - 45_000),
    })

    await expect(stopAllLiveBrowserDispatches([deviceId])).resolves.toEqual({
      stoppedQueuedOrDelivered: 0,
      executing: 0,
    })
    expect(commands[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('bounded execution lease'),
    })
    expect(turn).toMatchObject({ status: 'canceled', cancelRequested: true })
    expect(mocks.previewLeaseDeleteMany).toHaveBeenCalled()
  })

  it('setting global OFF atomically sweeps queued and delivered but witnesses executing', async () => {
    const makeCommand = (id: string, status: string): CommandRow => ({
      id,
      deviceId,
      action: 'click',
      params: { ref: 'e1', __almaDirectBrowserLaneToken: laneToken },
      status,
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: status === 'queued' ? 0 : 1,
      deliveredAt: status === 'queued' ? null : new Date(),
      resolvedAt: null,
      createdAt: new Date(),
    })
    commands.push(
      makeCommand('queued-before-off', 'queued'),
      makeCommand('delivered-before-off', 'delivered'),
      makeCommand('executing-before-off', 'executing'),
    )

    await expect(setLiveBrowserEnabled(false)).resolves.toBe(false)
    expect(globalEnabled).toBe(false)
    expect(commands[0]).toMatchObject({
      status: 'failed', error: 'live_browser_disabled_before_execution',
    })
    expect(commands[1]).toMatchObject({
      status: 'failed', error: 'live_browser_disabled_before_execution',
    })
    expect(commands[2]).toMatchObject({ status: 'executing', error: null })

    await expect(setLiveBrowserEnabled(true)).resolves.toBe(true)
    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands.filter((command) => command.status === 'queued')).toHaveLength(0)
  })

  it('durably fences a copied bearer while executing, then clears the token on retry', async () => {
    const makeCommand = (id: string, status: string): CommandRow => ({
      id,
      deviceId,
      action: 'click',
      params: { ref: 'e1' },
      status,
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: status === 'queued' ? 0 : 1,
      deliveredAt: status === 'queued' ? null : new Date(),
      resolvedAt: null,
      createdAt: new Date(),
    })
    commands.push(
      makeCommand('executing-before-unpair', 'executing'),
      makeCommand('queued-before-unpair', 'queued'),
      makeCommand('delivered-before-unpair', 'delivered'),
    )

    await expect(revokeDeviceSafely(deviceId)).resolves.toEqual({
      revoked: false,
      inFlightEffects: 1,
      stoppedQueuedOrDelivered: 2,
    })
    expect(commands[0]).toMatchObject({ status: 'executing', error: null })
    expect(commands.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'queued-before-unpair',
        status: 'failed',
        error: 'device_unpaired_by_owner_before_execution',
      }),
      expect.objectContaining({
        id: 'delivered-before-unpair',
        status: 'failed',
        error: 'device_unpaired_by_owner_before_execution',
      }),
    ]))
    expect(deviceRevoked).toBe(true)
    expect(deviceTokenHash).not.toBeNull()
    expect(mocks.deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: deviceId, tokenHash: { not: null } },
      data: { revoked: true, lastSeenAt: null },
    })
    expect(mocks.previewLeaseDeleteMany).not.toHaveBeenCalled()

    // A copied bearer cannot poll/authorize ordinary work after the first 202,
    // while result/frame routes may authenticate the exact pending execution.
    await expect(authenticateDevice('paired-device-token', { touchLastSeen: false }))
      .resolves.toBeNull()
    await expect(authenticateDevice('paired-device-token', {
      touchLastSeen: false,
      allowRevocationPending: true,
    })).resolves.toMatchObject({ id: deviceId, revocationPending: true })
    await expect(runCommand(deviceId, 'click', { ref: 'late-enqueue' }, 2_000, {
      turnId,
      conversationId,
      directBrowserLaneToken: laneToken,
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'device_unpair_pending_before_enqueue',
    })

    commands.push(makeCommand('late-queued-copy', 'queued'))
    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands.at(-1)).toMatchObject({
      status: 'failed',
      error: 'device_unpair_pending_before_dispatch',
    })

    commands.push(makeCommand('late-delivered-copy', 'delivered'))
    await expect(authorizeClaimedBrowserCommand(deviceId, 'late-delivered-copy'))
      .resolves.toEqual({ authorized: false, reason: 'device_unpair_pending' })
    expect(commands.at(-1)).toMatchObject({
      status: 'failed',
      error: 'dispatch_authorization_denied:device_unpair_pending',
    })

    await expect(resolveCommand(deviceId, 'executing-before-unpair', { ok: true }))
      .resolves.toEqual({ ok: true })
    await expect(revokeDeviceSafely(deviceId)).resolves.toEqual({
      revoked: true,
      inFlightEffects: 0,
      stoppedQueuedOrDelivered: 0,
    })
    expect(deviceTokenHash).toBeNull()
    expect(mocks.deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: deviceId, revoked: true, tokenHash: { not: null } },
      data: { tokenHash: null },
    })
    expect(mocks.previewLeaseDeleteMany).toHaveBeenCalledWith({ where: { deviceId } })
  })

  it('reaps a stale authorized execution before safely revoking the device', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T16:00:00.000Z'))
    commands.push({
      id: 'stale-executing-before-unpair',
      deviceId,
      action: 'click',
      params: { ref: 'e1' },
      status: 'executing',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 1,
      deliveredAt: new Date(Date.now() - BROWSER_DELIVERY_LEASE_MS - 1),
      resolvedAt: null,
      createdAt: new Date(Date.now() - BROWSER_DELIVERY_LEASE_MS - 5_000),
    })

    await expect(revokeDeviceSafely(deviceId)).resolves.toEqual({
      revoked: true,
      inFlightEffects: 0,
      stoppedQueuedOrDelivered: 0,
    })
    expect(commands[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('bounded execution lease'),
    })
    expect(mocks.deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: deviceId, revoked: true, tokenHash: { not: null } },
      data: { tokenHash: null },
    })
    expect(mocks.previewLeaseDeleteMany).toHaveBeenCalledWith({ where: { deviceId } })
  })

  it('does not enqueue after a newer owner message supersedes the turn', async () => {
    mocks.ownerTurnCurrent.mockResolvedValueOnce(false)
    await expect(runCommand(
      deviceId,
      'click',
      {},
      1,
      { turnId, conversationId, directBrowserLaneToken: laneToken },
    )).resolves.toMatchObject({ ok: false, status: 'failed' })
    expect(mocks.commandCreate).not.toHaveBeenCalled()
  })

  it('supersedes the immediately lane-bound ask card in the Stop transaction', async () => {
    lane.expectedAskCardId = 'ask-device-choice'

    await expect(cancelLiveBrowserTurn(turnId)).resolves.toEqual({ found: true, canceledCommands: 0 })

    expect(mocks.askCardUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'ask-device-choice',
        conversationId,
        status: { in: ['pending', 'answered'] },
      },
      data: { status: 'superseded' },
    })
  })

  it('does not let a delayed Stop for an old turn revoke the newer lane/card', async () => {
    lane.token = 'newer-turn-token'
    lane.expectedAskCardId = 'newer-card'
    turn.status = 'done'

    await expect(cancelLiveBrowserTurn(turnId)).resolves.toEqual({ found: false, canceledCommands: 0 })

    expect(lane).toMatchObject({ status: 'active', currentStep: 'open', token: 'newer-turn-token' })
    expect(mocks.focusUpdateMany).not.toHaveBeenCalled()
    expect(mocks.askCardUpdateMany).not.toHaveBeenCalled()
  })

  it('terminalizes a command from an earlier delayed enqueue before Stop returns', async () => {
    vi.useFakeTimers()
    let releaseCreate!: () => void
    let announceCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const createStarted = new Promise<void>((resolve) => { announceCreate = resolve })
    mocks.commandCreate.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => {
      announceCreate()
      await createGate
      const command: CommandRow = {
        id: 'delayed-command',
        deviceId,
        action: String(data.action),
        params: data.params as Record<string, unknown>,
        status: 'queued',
        turnId,
        conversationId,
        result: null,
        error: null,
        deliveryAttempts: 0,
        deliveredAt: null,
        resolvedAt: null,
        createdAt: new Date(),
      }
      commands.push(command)
      return { id: command.id }
    })

    const enqueue = runCommand(deviceId, 'click', { ref: 'e1' }, 2_000, {
      turnId,
      conversationId,
      directBrowserLaneToken: laneToken,
    })
    await createStarted

    let stopReturned = false
    const stop = cancelLiveBrowserTurn(turnId).then((result) => {
      stopReturned = true
      return result
    })
    await Promise.resolve()
    expect(stopReturned).toBe(false)

    releaseCreate()
    await expect(stop).resolves.toEqual({ found: true, canceledCommands: 1 })
    expect(commands[0]).toMatchObject({
      status: 'failed',
      error: 'canceled_by_owner_before_delivery',
    })
    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()

    await vi.advanceTimersByTimeAsync(701)
    await expect(enqueue).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'canceled_by_owner_before_delivery',
    })
  })

  it('records Stop during executing, preserves only its witness, and settles with no next command', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T16:00:00.000Z'))
    const preview = {
      deviceId,
      turnId,
      conversationId,
      expiresAt: new Date('2026-08-21T16:00:25.000Z'),
    }
    mocks.previewLeaseFindUnique.mockResolvedValue(preview)
    mocks.ownerTurnCurrent.mockResolvedValue(false)
    commands.push({
      id: 'executing-command',
      deviceId,
      action: 'click',
      params: { ref: 'e1', __almaDirectBrowserLaneToken: laneToken },
      status: 'executing',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 1,
      deliveredAt: new Date('2026-08-21T15:59:59.000Z'),
      resolvedAt: null,
      createdAt: new Date('2026-08-21T15:59:58.000Z'),
    })

    await expect(cancelLiveBrowserTurn(turnId)).resolves.toEqual({
      found: true,
      canceledCommands: 0,
      inFlightEffects: 1,
    })
    expect(turn).toMatchObject({ status: 'running', cancelRequested: true })
    expect(lane).toMatchObject({ status: 'abandoned', currentStep: 'canceled_by_owner' })
    expect(commands[0]).toMatchObject({ status: 'executing' })
    expect(mocks.previewLeaseDeleteMany).not.toHaveBeenCalled()
    expect(mocks.previewLeaseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { turnId, conversationId, deviceId: { in: [deviceId] } },
    }))

    // Turn authority is revoked, but capture for the exact already-executing
    // command remains active until its outcome is durably recorded.
    await expect(getActiveBrowserPreviewLease(deviceId)).resolves.toEqual(preview)
    await expect(runCommand(deviceId, 'click', { ref: 'e2' }, 2_000, {
      turnId,
      conversationId,
      directBrowserLaneToken: laneToken,
    })).resolves.toMatchObject({ ok: false, status: 'failed' })
    expect(commands).toHaveLength(1)

    await expect(resolveCommand(deviceId, 'executing-command', { ok: true }))
      .resolves.toEqual({ ok: true })
    expect(commands[0]).toMatchObject({ status: 'done' })
    expect(turn).toMatchObject({ status: 'canceled', cancelRequested: true })
    expect(mocks.previewLeaseDeleteMany).toHaveBeenCalledWith({
      where: { turnId, conversationId },
    })

    commands.push({
      id: 'late-command',
      deviceId,
      action: 'click',
      params: { ref: 'e3', __almaDirectBrowserLaneToken: laneToken },
      status: 'queued',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 0,
      deliveredAt: null,
      resolvedAt: null,
      createdAt: new Date(),
    })
    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands[1]).toMatchObject({
      status: 'failed',
      error: 'direct_browser_command_lane_stale',
    })
  })

  it('refuses a queued direct command whose target turn is no longer running', async () => {
    turn.status = 'canceled'
    turn.cancelRequested = true
    commands.push({
      id: 'stale-direct-command',
      deviceId,
      action: 'click',
      params: {
        ref: 'e1',
        __almaDirectBrowserLaneToken: laneToken,
      },
      status: 'queued',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 0,
      deliveredAt: null,
      resolvedAt: null,
      createdAt: new Date(),
    })

    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands[0]).toMatchObject({
      status: 'failed',
      error: 'direct_browser_command_turn_not_running',
      deliveryAttempts: 0,
    })
  })

  it('refuses a queued direct command after its lane token is replaced', async () => {
    lane.token = 'replacement-lane-token'
    commands.push({
      id: 'superseded-direct-command',
      deviceId,
      action: 'click',
      params: {
        ref: 'e1',
        __almaDirectBrowserLaneToken: laneToken,
      },
      status: 'queued',
      turnId,
      conversationId,
      result: null,
      error: null,
      deliveryAttempts: 0,
      deliveredAt: null,
      resolvedAt: null,
      createdAt: new Date(),
    })

    await expect(claimNextCommand(deviceId, LIVE_BROWSER_AUTHORIZE_PROTOCOL)).resolves.toBeNull()
    expect(commands[0]).toMatchObject({
      status: 'failed',
      error: 'direct_browser_command_lane_stale',
      deliveryAttempts: 0,
    })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
  })
})
