import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  actionFindUnique: vi.fn(),
  turnFindFirst: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: { findUnique: mocks.actionFindUnique },
    agentTurn: { findFirst: mocks.turnFindFirst },
  },
}))

import { GET } from '../route'

const params = { params: Promise.resolve({ id: 'action-1' }) }

function request() {
  return new NextRequest('https://alma.test/api/assistant/actions/action-1', {
    headers: { authorization: 'Bearer internal-test-token' },
  })
}

beforeEach(() => {
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  mocks.actionFindUnique.mockResolvedValue({
    id: 'action-1',
    type: 'live_browser_act',
    summary: 'Click confirm',
    status: 'approved',
    conversationId: 'conversation-a',
    payload: {
      conversationId: 'conversation-a',
      progressTurnId: 'progress-a',
      toolInput: { action: 'click', selector: '#confirm' },
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.AGENT_INTERNAL_TOKEN
})

describe('GET /api/assistant/actions/[id] progress identity', () => {
  it('exposes the exact action-owned progress turn as sanitized top-level fields', async () => {
    mocks.turnFindFirst.mockResolvedValue({
      id: 'progress-a',
      conversationId: 'conversation-a',
      status: 'running',
    })

    const response = await GET(request(), params)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: 'action-1',
      conversationId: 'conversation-a',
      progressTurnId: 'progress-a',
      progressConversationId: 'conversation-a',
      progressTurnStatus: 'running',
    })
    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: 'progress-a', conversationId: 'conversation-a' },
      select: { id: true, conversationId: true, status: true },
    })
  })

  it('fails closed when a payload references a turn from another conversation', async () => {
    mocks.turnFindFirst.mockResolvedValue(null)

    const response = await GET(request(), params)
    await expect(response.json()).resolves.toMatchObject({
      conversationId: 'conversation-a',
      progressTurnId: null,
      progressConversationId: null,
      progressTurnStatus: null,
    })
  })
})
