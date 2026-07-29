import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  isSystemOwner: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
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
  isPendingActionExpired: () => false,
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
})
