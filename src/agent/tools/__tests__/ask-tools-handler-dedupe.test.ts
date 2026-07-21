import { beforeEach, describe, expect, it, vi } from 'vitest'

const createdAt = new Date('2026-07-21T10:00:01Z')
const ownerCreatedAt = new Date('2026-07-21T10:00:00Z')
let pending: Record<string, unknown> | null = null
let creates = 0

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findFirst: vi.fn(async () => ({
        id: 'owner-request-1',
        createdAt: ownerCreatedAt,
        content: [{ type: 'text', text: 'কোন collection-এর caption লিখে দাও' }],
      })),
    },
    agentAskCard: {
      findFirst: vi.fn(async () => pending),
      updateMany: vi.fn(async () => ({ count: pending ? 1 : 0 })),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        if (!pending) {
          creates += 1
          pending = { createdAt, ...create }
        }
        return pending
      }),
    },
  },
}))

import { ASK_TOOLS } from '../ask-tools'

describe('ask_user handler duplicate prevention', () => {
  beforeEach(() => { pending = null; creates = 0 })

  it('creates at most one actionable card for one owner request', async () => {
    const tool = ASK_TOOLS.find((candidate) => candidate.name === 'ask_user')!
    const first = await tool.handler({
      conversationId: 'conv-1',
      question: 'কোন collection?',
      options: ['Lifestyle', 'Trading'],
    })
    const second = await tool.handler({
      conversationId: 'conv-1',
      question: 'কোন collection-এর product?',
      options: ['ALMA Lifestyle', 'ALMA Trading'],
    })
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(creates).toBe(1)
    expect((second.data as { askCardId?: string }).askCardId)
      .toBe((first.data as { askCardId?: string }).askCardId)
    expect((second.data as { deduplicated?: boolean }).deduplicated).toBe(true)
  })
})
