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
      // A row written UNDER the contract carries the durable marker; the base
      // fixture models that, since a bare `references` array is now (correctly)
      // read as a shadow-era row (Codex P1 round 8).
      usage: { references: [reference], referencesActive: true },
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

  it('leaves pre-contract history in legacy mode even while ON', async () => {
    // Codex P1 round 4: every reply written before this pipeline existed has no
    // references and never could have. Marking those active the moment the
    // rollout flips strips the links out of the owner's whole history.
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    mocks.messages.mockResolvedValueOnce([{
      id: 'msg-legacy',
      role: 'assistant',
      content: [{ type: 'text', text: 'পুরোনো উত্তর [Orders](/orders)' }],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      clientRequestId: null,
      usage: { model: 'legacy' },
    }])
    const response = await GET(
      new NextRequest('https://alma.test/api/assistant/conversations/conv-1/messages'),
      { params: Promise.resolve({ id: 'conv-1' }) },
    )
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body[0].referencesActive).toBe(false)
  })

  it('keeps a shadow-era row in legacy mode after promotion to ON', async () => {
    // Codex P1 round 8: shadow persists references WITHOUT the marker. Reading
    // "has references" as "was written under an ON contract" would flip every
    // shadow-era row to strict mode the moment the rollout is promoted.
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    mocks.messages.mockResolvedValueOnce([{
      id: 'msg-shadow-era',
      role: 'assistant',
      content: [{ type: 'text', text: 'shadow যুগের উত্তর [Orders](/orders)' }],
      createdAt: new Date('2026-08-20T00:00:00Z'),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      clientRequestId: null,
      usage: { model: 'x', references: [reference] },
    }])
    const response = await GET(
      new NextRequest('https://alma.test/api/assistant/conversations/conv-1/messages'),
      { params: Promise.resolve({ id: 'conv-1' }) },
    )
    const body = await response.json()
    expect(body[0].referencesActive).toBe(false)
  })

  it('honours the durable per-row marker for an ON turn that cited nothing', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    mocks.messages.mockResolvedValueOnce([{
      id: 'msg-on-empty',
      role: 'assistant',
      content: [{ type: 'text', text: 'কোনো verified destination ছিল না।' }],
      createdAt: new Date('2026-08-24T00:00:00Z'),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      clientRequestId: null,
      usage: { model: 'x', referencesActive: true },
    }])
    const response = await GET(
      new NextRequest('https://alma.test/api/assistant/conversations/conv-1/messages'),
      { params: Promise.resolve({ id: 'conv-1' }) },
    )
    const body = await response.json()
    expect(body[0].references).toEqual([])
    expect(body[0].referencesActive).toBe(true)
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
    expect(body[0].referencesActive).toBe(true)
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
      // …and the clients are told WHY it is empty. Without this an empty list is
      // indistinguishable from "contract on, nothing cited", which turned every
      // legacy link and tool screenshot inert in the default mode (Codex P1 #845).
      expect(body[0].referencesActive).toBe(false)
    },
  )
})
