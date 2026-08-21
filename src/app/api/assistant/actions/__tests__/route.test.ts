import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  isSystemOwner: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  isPendingActionExpired: vi.fn(),
  settlePlanStepsLinkedToPendingAction: vi.fn(),
  settleTerminalFailedPlanStepsInTransaction: vi.fn(),
  reconcilePlanTrackersForPendingAction: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: mocks.isSystemOwner }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
    agentPendingAction: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
  },
}))
vi.mock('@/agent/lib/pending-action', () => ({
  isPendingActionExpired: mocks.isPendingActionExpired,
}))
vi.mock('@/agent/lib/planner', () => ({
  settlePlanStepsLinkedToPendingAction: mocks.settlePlanStepsLinkedToPendingAction,
  settleTerminalFailedPlanStepsInTransaction: mocks.settleTerminalFailedPlanStepsInTransaction,
  reconcilePlanTrackersForPendingAction: mocks.reconcilePlanTrackersForPendingAction,
}))

import { GET } from '../route'

function row(id: string, createdAt: string) {
  return {
    id,
    type: 'dispatch_staff_tasks',
    status: 'pending',
    summary: id,
    costEstimate: null,
    conversationId: 'conversation-1',
    result: null,
    createdAt: new Date(createdAt),
  }
}

describe('GET /api/assistant/actions pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getToken.mockResolvedValue({ sub: 'owner-1' })
    mocks.isSystemOwner.mockReturnValue(true)
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.isPendingActionExpired.mockReturnValue(false)
    mocks.settlePlanStepsLinkedToPendingAction.mockResolvedValue(null)
    mocks.settleTerminalFailedPlanStepsInTransaction.mockResolvedValue(undefined)
    mocks.reconcilePlanTrackersForPendingAction.mockResolvedValue(undefined)
    mocks.queryRaw.mockResolvedValue([])
    mocks.transaction.mockImplementation(
      async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => callback({
        $queryRaw: mocks.queryRaw,
        agentPendingAction: {
          findUnique: mocks.findUnique,
          updateMany: mocks.updateMany,
          update: mocks.update,
        },
      }),
    )
    mocks.update.mockResolvedValue({})
  })

  it('returns a stable cursor and only the requested page size', async () => {
    mocks.findMany
      .mockResolvedValueOnce([
      row('a3', '2026-07-29T03:00:00Z'),
      row('a2', '2026-07-29T02:00:00Z'),
      row('a1', '2026-07-29T01:00:00Z'),
      ])
      .mockResolvedValueOnce([])

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=2&cursor=older-id',
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      count: 2,
      nextCursor: 'a2',
      actions: [{ id: 'a3' }, { id: 'a2' }],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 3,
      cursor: { id: 'older-id' },
      skip: 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }))
  })

  it('returns an explicit terminal cursor for staff', async () => {
    mocks.isSystemOwner.mockReturnValue(false)
    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending',
    ))
    await expect(response.json()).resolves.toEqual({
      count: 0,
      actions: [],
      nextCursor: null,
    })
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('falls back to the legacy projection instead of emptying the queue during migration rollout', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.findMany
      .mockRejectedValueOnce(Object.assign(new Error('column image_model does not exist'), {
        code: 'P2022',
        meta: { column: 'agent_pending_actions.image_model' },
      }))
      .mockResolvedValueOnce([row('legacy-card', '2026-07-29T03:00:00Z')])
      .mockResolvedValueOnce([])

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      actions: [{ id: 'legacy-card' }],
    })
    expect(mocks.findMany).toHaveBeenCalledTimes(3)
    expect(mocks.findMany.mock.calls[1][0].select).not.toHaveProperty('imageModel')
    consoleError.mockRestore()
  })

  it('fails loud on a generic database outage instead of reporting an empty approval queue', async () => {
    mocks.findMany.mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code: 'P1001' }))
    await expect(GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))).rejects.toThrow('database unavailable')
    expect(mocks.findMany).toHaveBeenCalledTimes(1)
  })

  it('settles every plan row whose approval card the pending sweep expires', async () => {
    mocks.isPendingActionExpired.mockReturnValue(true)
    mocks.findMany
      .mockResolvedValueOnce([
        row('expired-a', '2026-07-29T03:00:00Z'),
        row('expired-b', '2026-07-29T02:00:00Z'),
      ])
      .mockResolvedValueOnce([])
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUnique.mockImplementation(async ({ where, select }: {
      where: { id: string }
      select: Record<string, boolean>
    }) => select.id
      ? { id: where.id, type: 'dispatch_staff_tasks', status: 'pending', payload: {}, result: null }
      : { status: 'expired', result: { _agentPlanTrackerReconcilePending: true } })

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ count: 0, actions: [] })
    expect(mocks.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: 'expired-a', status: 'pending' },
      { id: 'expired-b', status: 'pending' },
    ])
    expect(mocks.settleTerminalFailedPlanStepsInTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.settlePlanStepsLinkedToPendingAction.mock.calls.map(([id]) => id)).toEqual([
      'expired-a',
      'expired-b',
    ])
    expect(mocks.reconcilePlanTrackersForPendingAction.mock.calls.map(([id]) => id)).toEqual([
      'expired-a',
      'expired-b',
    ])
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { result: expect.objectContaining({ _agentPlanTrackerReconcilePending: false }) },
    }))
  })

  it('retries a deferred terminal tracker projection on a later pending queue read', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'expired-deferred' }])
    mocks.findUnique.mockResolvedValue({
      status: 'expired', result: { _agentPlanTrackerReconcilePending: true },
    })

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))

    expect(response.status).toBe(200)
    expect(mocks.settlePlanStepsLinkedToPendingAction).toHaveBeenCalledWith('expired-deferred')
    expect(mocks.reconcilePlanTrackersForPendingAction).toHaveBeenCalledWith('expired-deferred')
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'expired-deferred' },
      data: { result: { _agentPlanTrackerReconcilePending: false } },
    })
  })
})
