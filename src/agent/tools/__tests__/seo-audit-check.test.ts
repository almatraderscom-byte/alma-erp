/**
 * check_website_seo_audit must be resilient to a lost/invalid id (the head loses
 * the pendingActionId across a yield and even passes "last"): it falls back to
 * the LATEST seo_audit for the conversation so the report is always retrievable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rows, durable } = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; type: string; status: string; summary: string; result: unknown; conversationId: string | null; createdAt: Date }>,
  durable: {
    outbox: null as null | {
      status: string
      conversationId: string
      artifactId: string | null
      messageId: string | null
    },
    artifactMessageId: null as string | null,
    create: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { type: string; conversationId?: string } }) => {
        const matches = rows
          .filter((r) => r.type === where.type && (where.conversationId === undefined || r.conversationId === where.conversationId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return matches[0] ?? null
      }),
    },
    agentArtifactDeliveryOutbox: {
      findFirst: vi.fn(async () => durable.outbox),
    },
    agentArtifact: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; deliveryKey?: string } }) => (
        durable.outbox?.artifactId && where.id === durable.outbox.artifactId
          ? {
              id: durable.outbox.artifactId,
              title: 'SEO অডিট ড্যাশবোর্ড — example.test',
              type: 'html',
              version: 1,
              messageId: durable.artifactMessageId,
              conversationId: durable.outbox.conversationId,
            }
          : null
      )),
      findFirst: vi.fn(async () => null),
      create: durable.create,
      update: durable.update,
    },
    agentMessage: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
        durable.outbox?.messageId === where.id
          ? {
              id: where.id,
              conversationId: durable.outbox.conversationId,
              role: 'assistant',
            }
          : null
      )),
    },
  },
}))

import { SEO_AUDIT_TOOLS } from '@/agent/tools/seo-audit-tools'
const check = SEO_AUDIT_TOOLS.find((t) => t.name === 'check_website_seo_audit')!

beforeEach(() => {
  rows.length = 0
  durable.outbox = null
  durable.artifactMessageId = null
  vi.clearAllMocks()
})

describe('check_website_seo_audit latest-fallback', () => {
  it('returns the executed audit by exact id', async () => {
    rows.push({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'seo_audit', status: 'executed', summary: 'x', result: { score: 60 }, conversationId: 'c1', createdAt: new Date() })
    const r = await check.handler({ pendingActionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(r.success).toBe(true)
    expect((r.data as { status: string }).status).toBe('executed')
  })

  it('marks the durable linked card as canonically delivered without creating or updating another artifact', async () => {
    const artifactId = '69f9c18b-7c8f-4cf9-8c16-c41e6d9ba037'
    const messageId = 'd588c6c5-84bf-4c42-b15f-5d4cf8fdcf91'
    durable.outbox = {
      status: 'delivered',
      conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
      artifactId,
      messageId,
    }
    durable.artifactMessageId = messageId
    rows.push({
      id: '2617c17a-079f-4f6b-b49e-060e23f4380a',
      type: 'seo_audit',
      status: 'executed',
      summary: 'incident-shaped audit',
      result: {
        score: 61,
        __delivery: {
          state: 'delivered',
          via: 'artifact_outbox',
          artifactId,
          messageId,
        },
      },
      conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
      createdAt: new Date(),
    })
    const result = await check.handler({
      pendingActionId: '2617c17a-079f-4f6b-b49e-060e23f4380a',
      conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
    })
    expect(result.success).toBe(true)
    expect((result.data as { artifactCard: unknown }).artifactCard).toEqual({
      id: artifactId,
      title: 'SEO অডিট ড্যাশবোর্ড — example.test',
      type: 'html',
      version: 1,
      canonicalMessageDelivered: true,
      canonicalMessageId: messageId,
    })
    expect(durable.create).not.toHaveBeenCalled()
    expect(durable.update).not.toHaveBeenCalled()
  })

  it('returns a successful running poll without claiming an artifact delivery', async () => {
    rows.push({
      id: 'running-action',
      type: 'seo_audit',
      status: 'approved',
      summary: 'still crawling',
      result: null,
      conversationId: 'c1',
      createdAt: new Date(),
    })
    const result = await check.handler({ pendingActionId: 'running-action', conversationId: 'c1' })
    expect(result.success).toBe(true)
    expect((result.data as { status: string }).status).toBe('approved')
    expect((result.data as { artifactCard?: unknown }).artifactCard).toBeUndefined()
  })

  it('does not surface a card when execution exists but canonical delivery is partial', async () => {
    const artifactId = 'partial-artifact'
    const messageId = 'partial-message'
    durable.outbox = { status: 'delivered', conversationId: 'c1', artifactId, messageId }
    durable.artifactMessageId = messageId
    rows.push({
      id: 'partial-action',
      type: 'seo_audit',
      status: 'executed',
      summary: 'crawl complete; delivery pending',
      result: {
        score: 61,
        __delivery: { state: 'pending', via: 'artifact_outbox', artifactId },
      },
      conversationId: 'c1',
      createdAt: new Date(),
    })
    const result = await check.handler({ pendingActionId: 'partial-action', conversationId: 'c1' })
    expect(result.success).toBe(true)
    expect((result.data as { status: string }).status).toBe('executed')
    expect((result.data as { artifactCard?: unknown }).artifactCard).toBeUndefined()
  })

  it('falls back to the latest audit when the id is lost/invalid ("last")', async () => {
    rows.push(
      { id: 'id-old', type: 'seo_audit', status: 'executed', summary: 'old', result: { score: 40 }, conversationId: 'c1', createdAt: new Date(1000) },
      { id: 'id-new', type: 'seo_audit', status: 'executed', summary: 'new', result: { score: 72 }, conversationId: 'c1', createdAt: new Date(9000) },
    )
    const r = await check.handler({ pendingActionId: 'last', conversationId: 'c1' })
    expect(r.success).toBe(true)
    expect((r.data as { result: { score: number } }).result.score).toBe(72)
  })

  it('falls back when NO id is given at all', async () => {
    rows.push({ id: 'id-1', type: 'seo_audit', status: 'approved', summary: 's', result: null, conversationId: 'c1', createdAt: new Date() })
    const r = await check.handler({ conversationId: 'c1' })
    expect(r.success).toBe(true)
    expect((r.data as { status: string }).status).toBe('approved') // still crawling
  })

  it('scopes the fallback to the conversation', async () => {
    rows.push(
      { id: 'other', type: 'seo_audit', status: 'executed', summary: 'other conv', result: { score: 10 }, conversationId: 'c2', createdAt: new Date(9999) },
      { id: 'mine', type: 'seo_audit', status: 'executed', summary: 'my conv', result: { score: 88 }, conversationId: 'c1', createdAt: new Date(500) },
    )
    const r = await check.handler({ pendingActionId: '', conversationId: 'c1' })
    expect((r.data as { result: { score: number } }).result.score).toBe(88)
  })

  it('reports honestly when there is truly no audit', async () => {
    const r = await check.handler({ conversationId: 'c1' })
    expect(r.success).toBe(false)
  })
})
