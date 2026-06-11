/**
 * Server-side aggregations for /agent/costs dashboard.
 */
import { prisma } from '@/lib/prisma'
import { getBudgetSettings, sumCostUsdBetween } from '@/agent/lib/cost-events'
import { subscriptionDailyUsd } from '@/agent/lib/pricing'

const DHAKA_TZ = 'Asia/Dhaka'

function dhakaDateStr(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: DHAKA_TZ })
}

function dhakaDayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00+06:00`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

function monthBounds(dateStr: string): { start: Date; end: Date } {
  const [y, m] = dateStr.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1) - 6 * 60 * 60 * 1000) // approx Dhaka month start
  const nextMonth = m === 12 ? [y + 1, 1] : [y, m + 1]
  const end = new Date(Date.UTC(nextMonth[0], nextMonth[1] - 1, 1) - 6 * 60 * 60 * 1000)
  return { start, end }
}

export async function getCostDashboardData() {
  const todayStr = dhakaDateStr()
  const todayBounds = dhakaDayBounds(todayStr)
  const monthB = monthBounds(todayStr)

  const [todayUsd, monthUsd, budgets] = await Promise.all([
    sumCostUsdBetween(todayBounds.start, todayBounds.end),
    sumCostUsdBetween(monthB.start, monthB.end),
    getBudgetSettings(),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const dailyRows: Array<{ day: string; provider: string; total: string }> = await db.$queryRawUnsafe(
    `SELECT to_char((occurred_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day,
            provider,
            SUM(cost_usd)::text AS total
     FROM agent_cost_events
     WHERE occurred_at >= NOW() - INTERVAL '30 days'
     GROUP BY 1, 2
     ORDER BY 1 ASC`,
  )

  const dailyMap = new Map<string, Record<string, number>>()
  for (const r of dailyRows) {
    if (!dailyMap.has(r.day)) dailyMap.set(r.day, {})
    const bucket = dailyMap.get(r.day)!
    bucket[r.provider] = parseFloat(r.total) || 0
    bucket.total = (bucket.total ?? 0) + (parseFloat(r.total) || 0)
  }
  const dailyLast30 = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, providers]) => ({ date, ...providers }))

  const providerRows: Array<{ provider: string; total: string }> = await db.$queryRawUnsafe(
    `SELECT provider, SUM(cost_usd)::text AS total
     FROM agent_cost_events
     WHERE occurred_at >= $1 AND occurred_at < $2
     GROUP BY provider
     ORDER BY SUM(cost_usd) DESC`,
    monthB.start,
    monthB.end,
  )
  const byProvider = providerRows.map((r) => ({
    provider: r.provider,
    totalUsd: parseFloat(r.total) || 0,
  }))

  const topConvRows: Array<{ conversation_id: string; total: string; title: string | null }> =
    await db.$queryRawUnsafe(
      `SELECT e.conversation_id,
              SUM(e.cost_usd)::text AS total,
              c.title
       FROM agent_cost_events e
       LEFT JOIN agent_conversations c ON c.id = e.conversation_id
       WHERE e.conversation_id IS NOT NULL
         AND e.occurred_at >= $1 AND e.occurred_at < $2
       GROUP BY e.conversation_id, c.title
       ORDER BY SUM(e.cost_usd) DESC
       LIMIT 10`,
      monthB.start,
      monthB.end,
    )

  const subscriptions = await db.agentSubscription.findMany({
    where: { active: true },
    orderBy: { nextRenewalAt: 'asc' },
  })

  const subMonthlyUsd = subscriptions.reduce((s: number, sub: { amount: unknown; billingCycle: string; currency: string }) => {
    const amt = parseFloat(String(sub.amount))
    if (sub.currency !== 'USD') return s
    return s + (sub.billingCycle === 'yearly' ? amt / 12 : amt)
  }, 0)

  const dayOfMonth = parseInt(todayStr.split('-')[2], 10)
  const daysInMonth = new Date(parseInt(todayStr.slice(0, 4), 10), parseInt(todayStr.slice(5, 7), 10), 0).getDate()
  const apiForecast = dayOfMonth > 0 ? (monthUsd / dayOfMonth) * daysInMonth : monthUsd
  const forecastUsd = apiForecast + subMonthlyUsd

  return {
    todayUsd,
    monthUsd,
    forecastUsd: Math.round(forecastUsd * 1_000_000) / 1_000_000,
    subscriptionAmortMonthUsd: Math.round(subMonthlyUsd * 1_000_000) / 1_000_000,
    dailyLast30,
    byProvider,
    topConversations: topConvRows.map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      totalUsd: parseFloat(r.total) || 0,
    })),
    subscriptions: subscriptions.map((s: {
      id: string; name: string; amount: unknown; currency: string
      billingCycle: string; nextRenewalAt: Date; category: string | null; notes: string | null
    }) => ({
      id: s.id,
      name: s.name,
      amount: parseFloat(String(s.amount)),
      currency: s.currency,
      billingCycle: s.billingCycle,
      nextRenewalAt: s.nextRenewalAt.toISOString().slice(0, 10),
      category: s.category,
      notes: s.notes,
      dailyUsd: subscriptionDailyUsd(parseFloat(String(s.amount)), s.billingCycle as 'monthly' | 'yearly'),
    })),
    budgets,
    asOf: new Date().toISOString(),
  }
}
