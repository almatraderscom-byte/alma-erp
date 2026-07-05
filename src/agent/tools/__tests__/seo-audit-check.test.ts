/**
 * check_website_seo_audit must be resilient to a lost/invalid id (the head loses
 * the pendingActionId across a yield and even passes "last"): it falls back to
 * the LATEST seo_audit for the conversation so the report is always retrievable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<{ id: string; type: string; status: string; summary: string; result: unknown; conversationId: string | null; createdAt: Date }> = []

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
  },
}))

import { SEO_AUDIT_TOOLS } from '@/agent/tools/seo-audit-tools'
const check = SEO_AUDIT_TOOLS.find((t) => t.name === 'check_website_seo_audit')!

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
})

describe('check_website_seo_audit latest-fallback', () => {
  it('returns the executed audit by exact id', async () => {
    rows.push({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', type: 'seo_audit', status: 'executed', summary: 'x', result: { score: 60 }, conversationId: 'c1', createdAt: new Date() })
    const r = await check.handler({ pendingActionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(r.success).toBe(true)
    expect((r.data as { status: string }).status).toBe('executed')
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
