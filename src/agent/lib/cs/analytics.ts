import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CsAnalyticsKind =
  | 'conversation_started'
  | 'agent_reply'
  | 'comment_capture'
  | 'draft_created'
  | 'draft_confirmed'
  | 'followup_sent'
  | 'followup_expired'
  | 'followup_recovery'
  | 'rate_limited'
  | 'product_asked'
  | 'lost_sale'
  | 'hard_stop'
  | 'low_confidence'

export async function recordCsEvent(
  kind: CsAnalyticsKind,
  opts: { conversationId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.csAnalyticsEvent.create({
      data: {
        kind,
        conversationId: opts.conversationId ?? null,
        metadata: opts.metadata ?? {},
      },
    })
  } catch { /* non-fatal */ }
}

export async function getCsAnalyticsSummary(days = 7): Promise<{
  conversations: number
  agentReplies: number
  commentCaptures: number
  draftsCreated: number
  draftsConfirmed: number
  conversionChatToDraft: number
  conversionDraftToConfirmed: number
  followupsSent: number
  followupsExpired: number
  followupRecoveries: number
  topAskedProducts: Array<{ code: string; count: number }>
  lostSaleReasons: Record<string, number>
  csCostUsd: number
}> {
  const since = new Date(Date.now() - days * 86400000)

  const [
    convCount,
    events,
    draftsCreated,
    draftsConfirmed,
    followupsSent,
    followupsExpired,
    recoveries,
    costRows,
    lostReasons,
  ] = await Promise.all([
    db.csConversation.count({ where: { createdAt: { gte: since } } }),
    db.csAnalyticsEvent.findMany({
      where: { createdAt: { gte: since }, kind: { in: ['agent_reply', 'comment_capture', 'product_asked'] } },
      select: { kind: true, metadata: true },
    }),
    db.csOrderDraft.count({ where: { createdAt: { gte: since } } }),
    db.csOrderDraft.count({ where: { confirmedAt: { gte: since } } }),
    db.csFollowup.count({ where: { sentAt: { gte: since }, status: 'sent' } }),
    db.csFollowup.count({ where: { status: 'expired', scheduledAt: { gte: since } } }),
    db.csAnalyticsEvent.count({ where: { kind: 'followup_recovery', createdAt: { gte: since } } }),
    prisma.$queryRaw<Array<{ total: string }>>(
      Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM agent_cost_events
       WHERE kind LIKE 'cs_%' AND occurred_at >= ${since}`,
    ),
    db.csConversation.groupBy({
      by: ['lostSaleReason'],
      where: { lostSaleReason: { not: null }, updatedAt: { gte: since } },
      _count: true,
    }),
  ])

  const agentReplies = events.filter((e: { kind: string }) => e.kind === 'agent_reply').length
  const commentCaptures = events.filter((e: { kind: string }) => e.kind === 'comment_capture').length

  const productCounts = new Map<string, number>()
  for (const e of events) {
    if (e.kind !== 'product_asked') continue
    const code = String((e.metadata as Record<string, unknown>)?.code ?? '')
    if (!code) continue
    productCounts.set(code, (productCounts.get(code) ?? 0) + 1)
  }
  const topAskedProducts = [...productCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }))

  const lostSaleReasons: Record<string, number> = {}
  for (const row of lostReasons) {
    if (row.lostSaleReason) lostSaleReasons[row.lostSaleReason] = row._count
  }

  const convWithDraft = await db.csOrderDraft.findMany({
    where: { createdAt: { gte: since } },
    select: { conversationId: true },
    distinct: ['conversationId'],
  })

  return {
    conversations: convCount,
    agentReplies,
    commentCaptures,
    draftsCreated,
    draftsConfirmed,
    conversionChatToDraft: convCount > 0 ? Math.round((convWithDraft.length / convCount) * 100) : 0,
    conversionDraftToConfirmed: draftsCreated > 0 ? Math.round((draftsConfirmed / draftsCreated) * 100) : 0,
    followupsSent,
    followupsExpired,
    followupRecoveries: recoveries,
    topAskedProducts,
    lostSaleReasons,
    csCostUsd: parseFloat(costRows[0]?.total ?? '0') || 0,
  }
}

export function formatCsAnalyticsBangla(summary: ReturnType<typeof getCsAnalyticsSummary> extends Promise<infer T> ? T : never): string {
  const top = summary.topAskedProducts[0]
  const topLine = top
    ? `\n• সবচেয়ে জিজ্ঞেস: ${top.code} (${top.count} বার)`
    : ''
  const lost = Object.entries(summary.lostSaleReasons)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')

  return (
    `🛒 *CS সেলস (${summary.conversations} চ্যাট)*\n` +
    `• রিপ্লাই: ${summary.agentReplies} | কমেন্ট ক্যাপচার: ${summary.commentCaptures}\n` +
    `• Draft: ${summary.draftsCreated} → কনফার্ম: ${summary.draftsConfirmed} ` +
    `(${summary.conversionChatToDraft}% chat→draft, ${summary.conversionDraftToConfirmed}% draft→confirm)\n` +
    `• Follow-up: ${summary.followupsSent} পাঠানো, ${summary.followupsExpired} মেয়াদোত্তীর্ণ, ${summary.followupRecoveries} রিকভারি\n` +
    `• CS খরচ: $${summary.csCostUsd.toFixed(4)}` +
    topLine +
    (lost ? `\n• হারানো সেল: ${lost}` : '')
  )
}
