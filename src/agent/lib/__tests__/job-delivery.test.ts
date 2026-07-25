/**
 * Delivery contract (owner incident 2026-07-25 — the deep SEO audit finished and
 * the chat said only "done"): a finished job's result MUST reach the owner's
 * conversation. Verified against an in-memory prisma double:
 *   • a substantive assistant reply after the job counts as delivered;
 *   • a progress placeholder ("⏳ … কাজ চলমান") does NOT;
 *   • silence retries the continuation twice, then the server posts the result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type ActionRow = {
  id: string
  type: string
  status: string
  summary: string | null
  conversationId: string | null
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  resolvedAt: Date | null
}
type MessageRow = { conversationId: string; role: string; content: unknown; createdAt: Date }

const actions: ActionRow[] = []
const messages: MessageRow[] = []
const continuations: Array<{ conversationId: string; force?: boolean; message: string }> = []
const telegram: string[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: async ({ where }: { where: { id: string } }) => actions.find((a) => a.id === where.id) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const types = (where.type as { in: string[] } | undefined)?.in ?? null
        const resolved = where.resolvedAt as { lt?: Date; gt?: Date } | undefined
        return actions.filter((a) => {
          if (where.status && a.status !== where.status) return false
          if (types && !types.includes(a.type)) return false
          if (resolved?.lt && !(a.resolvedAt && a.resolvedAt < resolved.lt)) return false
          if (resolved?.gt && !(a.resolvedAt && a.resolvedAt > resolved.gt)) return false
          return true
        })
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = actions.find((a) => a.id === where.id)!
        Object.assign(row, data)
        return row
      },
    },
    agentMessage: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const after = (where.createdAt as { gt?: Date } | undefined)?.gt
        return messages.filter(
          (m) =>
            m.conversationId === where.conversationId
            && m.role === where.role
            && (!after || m.createdAt > after),
        )
      },
      create: async ({ data }: { data: MessageRow }) => {
        messages.push({ ...data, createdAt: new Date() })
        return data
      },
    },
    agentConversation: { update: async () => ({}) },
  },
}))

vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueAgentContinuation: async (opts: { conversationId: string; force?: boolean; message: string }) => {
    continuations.push(opts)
  },
}))

vi.mock('@/agent/lib/telegram-owner-notify', () => ({
  sendOwnerText: async (text: string) => {
    telegram.push(text)
    return { ok: true }
  },
}))

const {
  buildFallbackDeliveryMessage,
  isProgressPlaceholder,
  readDeliveryState,
  runJobDeliverySweep,
} = await import('@/agent/lib/job-delivery')

const MINUTES = 60 * 1000

function seedAudit(overrides: Partial<ActionRow> = {}): ActionRow {
  const row: ActionRow = {
    id: 'act-1',
    type: 'seo_audit',
    status: 'executed',
    summary: '🔎 SEO audit: https://almatraders.com',
    conversationId: 'conv-1',
    payload: { url: 'https://almatraders.com' },
    result: {
      score: 24,
      pagesCrawled: 12,
      counts: { critical: 2, high: 5, medium: 9, low: 3 },
      artifacts: ['seo-audits/act-1/report.md', 'seo-audits/act-1/audit.json'],
      __delivery: { state: 'pending', attempts: 0, since: new Date(Date.now() - 20 * MINUTES).toISOString() },
    },
    resolvedAt: new Date(Date.now() - 20 * MINUTES),
    ...overrides,
  }
  actions.push(row)
  return row
}

beforeEach(() => {
  actions.length = 0
  messages.length = 0
  continuations.length = 0
  telegram.length = 0
})

describe('job delivery sweep', () => {
  it('counts a substantive assistant reply as delivery and stops watching', async () => {
    const row = seedAudit()
    messages.push({
      conversationId: 'conv-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Boss, স্কোর ২৪/১০০। সবচেয়ে বড় সমস্যা: ১৪৬টা প্রোডাক্টের একটাও Google-এ index হয়নি।' }],
      createdAt: new Date(Date.now() - 19 * MINUTES),
    })

    const out = await runJobDeliverySweep()
    expect(out.alreadyDelivered).toBe(1)
    expect(out.retried).toBe(0)
    expect(readDeliveryState(row.result)).toMatchObject({ state: 'delivered', via: 'head' })
  })

  it('does NOT accept a progress placeholder as delivery — it retries instead', async () => {
    seedAudit()
    messages.push({
      conversationId: 'conv-1',
      role: 'assistant',
      content: [{ type: 'text', text: '⏳ Ordered SEO কাজ চলমান: target 1/1 — পরের ধাপ: complete_skill_pack_run.' }],
      createdAt: new Date(Date.now() - 19 * MINUTES),
    })

    const out = await runJobDeliverySweep()
    expect(out.alreadyDelivered).toBe(0)
    expect(out.retried).toBe(1)
    expect(continuations[0].force).toBe(true)
    expect(continuations[0].message).toMatch(/present it IN THIS REPLY/)
  })

  it('after two silent retries the server posts the result itself', async () => {
    const row = seedAudit()

    await runJobDeliverySweep()
    await runJobDeliverySweep()
    expect(continuations).toHaveLength(2)
    expect(messages).toHaveLength(0)

    const out = await runJobDeliverySweep()
    expect(out.forced).toBe(1)
    expect(messages).toHaveLength(1)
    const text = (messages[0].content as Array<{ text: string }>)[0].text
    expect(text).toContain('24/100')
    expect(text).toContain('12 পেজ')
    expect(text).toContain('/api/assistant/files?path=')
    expect(readDeliveryState(row.result)).toMatchObject({ state: 'delivered', via: 'server_fallback' })
    expect(telegram).toHaveLength(1)
  })

  it('leaves a freshly finished job alone during the grace window', async () => {
    seedAudit({ resolvedAt: new Date(Date.now() - 1 * MINUTES) })
    const out = await runJobDeliverySweep()
    expect(out).toMatchObject({ scanned: 0, retried: 0, forced: 0 })
    expect(continuations).toHaveLength(0)
  })

  it('never re-delivers an already delivered job', async () => {
    seedAudit({
      result: {
        score: 24,
        artifacts: [],
        __delivery: { state: 'delivered', attempts: 0, since: new Date().toISOString(), via: 'head' },
      },
    })
    const out = await runJobDeliverySweep()
    expect(out.scanned).toBe(0)
    expect(messages).toHaveLength(0)
  })
})

describe('delivery message building', () => {
  it('prefers the prepared Bangla summary and appends labelled file links', () => {
    const text = buildFallbackDeliveryMessage({
      type: 'seo_audit',
      summary: 'SEO audit',
      result: {
        deliverySummaryBn: 'Boss, almatraders.com-এর অডিট শেষ — স্কোর ২৪/১০০।',
        artifacts: ['seo-audits/a/report.html', 'seo-audits/a/issues.csv'],
      },
    })
    expect(text).toContain('স্কোর ২৪/১০০')
    expect(text).toContain('লাইভ ড্যাশবোর্ড (HTML)')
    expect(text).toContain('সব issue (Excel/CSV)')
  })

  it('recognises progress placeholders', () => {
    expect(isProgressPlaceholder('🔄 crawl চলছে…')).toBe(true)
    expect(isProgressPlaceholder('⏳ Ordered SEO কাজ চলমান')).toBe(true)
    expect(isProgressPlaceholder('')).toBe(true)
    expect(isProgressPlaceholder('Boss, রিপোর্ট এই যে: স্কোর ২৪/১০০, ৩টা critical সমস্যা।')).toBe(false)
  })
})
