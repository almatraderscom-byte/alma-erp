import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { buildInternalEntityReference } from '@/agent/lib/references/internal-registry'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  isSystemOwner: vi.fn(),
  conversation: vi.fn(),
  messages: vi.fn(),
  actions: vi.fn(),
  asks: vi.fn(),
  plans: vi.fn(),
  toolCalls: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/roles')>()
  return { ...original, isSystemOwner: mocks.isSystemOwner }
})
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentConversation: { findUnique: mocks.conversation },
    agentMessage: { findMany: mocks.messages, findUnique: vi.fn() },
    agentPendingAction: { findMany: mocks.actions },
    agentAskCard: { findMany: mocks.asks },
    agentPlan: { findMany: mocks.plans },
    agentToolCall: { findMany: mocks.toolCalls },
  },
}))
vi.mock('@/lib/creative-studio/taste', () => ({ readKv: vi.fn().mockResolvedValue(null) }))

import { GET } from '../route'

const reference = buildInternalEntityReference({
  namespace: 'order', id: 'ord_reload', label: 'Order reload',
  sourceTool: 'get_orders', outputPath: 'data.orders[0].id',
  context: { businessId: 'ALMA_LIFESTYLE', roles: ['SUPER_ADMIN'] },
})!

describe('message reload reference projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getToken.mockResolvedValue({ sub: 'owner-1', role: 'SUPER_ADMIN' })
    mocks.isSystemOwner.mockReturnValue(true)
    mocks.conversation.mockResolvedValue({ id: 'conv-1', businessId: 'ALMA_LIFESTYLE' })
    mocks.messages.mockResolvedValue([{
      id: 'msg-1', clientRequestId: null, role: 'assistant', content: [],
      tokensIn: 1, tokensOut: 2, costUsd: null, createdAt: new Date('2026-08-23T00:00:00Z'),
      usage: { references: [reference] },
    }])
    mocks.actions.mockResolvedValue([])
    mocks.asks.mockResolvedValue([])
    mocks.plans.mockResolvedValue([])
    mocks.toolCalls.mockResolvedValue([])
  })

  afterAll(() => {
    if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
    else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
  })

  it('returns canonical references while ON', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    const response = await GET(
      new NextRequest('https://alma.test/api/assistant/conversations/conv-1/messages'),
      { params: Promise.resolve({ id: 'conv-1' }) },
    )
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(Array.isArray(body), JSON.stringify(body)).toBe(true)
    expect(body[0].references).toEqual([reference])
  })

  it.each(['off', 'shadow'] as const)(
    'returns an authoritative empty projection while %s instead of omitting the field',
    async (mode) => {
      process.env.AGENT_REFERENCES_ROLLOUT = mode
      const response = await GET(
        new NextRequest('https://alma.test/api/assistant/conversations/conv-1/messages'),
        { params: Promise.resolve({ id: 'conv-1' }) },
      )
      const body = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(Array.isArray(body), JSON.stringify(body)).toBe(true)
      expect(body[0]).toHaveProperty('references')
      expect(body[0].references).toEqual([])
      expect(body[0].presentation.references ?? null).toBeNull()
    },
  )
})
