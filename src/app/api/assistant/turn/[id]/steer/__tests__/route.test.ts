import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  lane: null as null | {
    id: string
    status: string
    currentStep: string | null
    version: number
    artifacts: Record<string, unknown>
  },
  created: 0,
}))

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(async () => state.lane ? [state.lane] : []),
  agentConversationFocus: { updateMany: vi.fn(async () => ({ count: 1 })) },
  agentFocusEvent: { create: vi.fn(async () => ({})) },
  agentTurn: { findUnique: vi.fn(async () => ({ status: 'running' })) },
  agentMessage: {
    create: vi.fn(async () => {
      state.created += 1
      return { id: `steer-${state.created}` }
    }),
  },
  agentConversation: { update: vi.fn(async () => ({})) },
}))

const prismaMock = vi.hoisted(() => ({
  agentTurn: {
    findUnique: vi.fn(async () => ({ id: 'turn-a', conversationId: 'conv-1', status: 'running' })),
  },
  agentMessage: { findUnique: vi.fn(async () => null) },
  $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
}))

const lockLane = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => ({ sub: 'owner-1', role: 'OWNER' })),
}))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/agent/lib/live-browser/turn-lane', () => ({
  directYouTubeLaneIdForConversation: () => 'direct-lane-conv-1',
  lockDirectYouTubeLaneAuthority: lockLane,
}))

import { POST } from '../route'

function request(message: string) {
  return new NextRequest('https://alma.test/api/assistant/turn/turn-a/steer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), message }),
  })
}

describe('POST /api/assistant/turn/:id/steer direct-browser authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.created = 0
    state.lane = null
  })

  it('returns a direct-like steer to the outbox for a fresh immutable turn', async () => {
    const response = await POST(request('Play Fix You on YouTube'), {
      params: Promise.resolve({ id: 'turn-a' }),
    })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'direct_browser_requires_fresh_turn',
      turnId: 'turn-a',
    })
    expect(tx.agentMessage.create).not.toHaveBeenCalled()
    expect(lockLane).toHaveBeenCalledWith(tx, 'conv-1')
  })

  it('never lets an old broad turn steer revoke a newer direct turn lane', async () => {
    state.lane = {
      id: 'direct-lane-conv-1',
      status: 'active',
      currentStep: 'open',
      version: 4,
      artifacts: { laneToken: 'turn-b' },
    }
    const response = await POST(request('Also send the invoice tomorrow'), {
      params: Promise.resolve({ id: 'turn-a' }),
    })
    expect(response.status).toBe(200)
    expect(tx.agentConversationFocus.updateMany).not.toHaveBeenCalled()
    expect(tx.agentMessage.create).toHaveBeenCalledOnce()
  })

  it('revokes its own direct lane and requires non-direct steering to start fresh', async () => {
    state.lane = {
      id: 'direct-lane-conv-1',
      status: 'active',
      currentStep: 'open',
      version: 2,
      artifacts: { laneToken: 'turn-a' },
    }
    const response = await POST(request('Send the invoice instead'), {
      params: Promise.resolve({ id: 'turn-a' }),
    })
    expect(response.status).toBe(409)
    expect(tx.agentConversationFocus.updateMany).toHaveBeenCalledOnce()
    expect(tx.agentMessage.create).not.toHaveBeenCalled()
  })
})
