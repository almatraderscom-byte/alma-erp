import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  isSystemOwner: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  isPendingActionExpired: vi.fn(),
  settlePlanStepsLinkedToPendingAction: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: mocks.isSystemOwner }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
  },
}))
vi.mock('@/agent/lib/pending-action', () => ({
  isPendingActionExpired: mocks.isPendingActionExpired,
}))
vi.mock('@/agent/lib/planner', () => ({
  settlePlanStepsLinkedToPendingAction: mocks.settlePlanStepsLinkedToPendingAction,
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
  })

  it('returns a stable cursor and only the requested page size', async () => {
    mocks.findMany.mockResolvedValue([
      row('a3', '2026-07-29T03:00:00Z'),
      row('a2', '2026-07-29T02:00:00Z'),
      row('a1', '2026-07-29T01:00:00Z'),
    ])

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

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      actions: [{ id: 'legacy-card' }],
    })
    expect(mocks.findMany).toHaveBeenCalledTimes(2)
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
    mocks.findMany.mockResolvedValue([
      row('expired-a', '2026-07-29T03:00:00Z'),
      row('expired-b', '2026-07-29T02:00:00Z'),
    ])
    mocks.updateMany.mockResolvedValue({ count: 2 })

    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/actions?status=pending&limit=20',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ count: 0, actions: [] })
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['expired-a', 'expired-b'] }, status: 'pending' },
      data: expect.objectContaining({ status: 'expired' }),
    }))
    expect(mocks.settlePlanStepsLinkedToPendingAction.mock.calls.map(([id]) => id)).toEqual([
      'expired-a',
      'expired-b',
    ])
  })
})
