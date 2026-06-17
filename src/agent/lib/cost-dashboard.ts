/**
 * Server-side aggregations for /agent/costs dashboard.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getBudgetSettings } from '@/agent/lib/cost-events'
import { subscriptionDailyUsd } from '@/agent/lib/pricing'
import { assertAgentCostSchemaReady, queryCostSumBetween } from '@/agent/lib/cost-db'
import { queryBillableCostSumBetween, formatBudgetPct } from '@/agent/lib/cost-budget'
import { todayYmdDhaka, dhakaDayBounds, dhakaMonthBounds } from '@/lib/agent-api/dhaka-date'

const DHAKA_TZ = 'Asia/Dhaka'

/** ~750 characters ≈ 1 minute of spoken TTS at typical pace. */
const TTS_CHARS_PER_MINUTE = 750

export type TtsUsageSlice = {
  costUsd: number
  characters: number
  minutesUsed: number
  synthesisCount: number
}

export type TtsProviderUsage = {
  total: TtsUsageSlice
  phoneCalls: TtsUsageSlice & { callCount: number }
  voiceMessages: TtsUsageSlice
}

export type TwilioCallUsage = {
  callCount: number
  minutesUsed: number
  costUsd: number
}

function charsToMinutes(chars: number): number {
  return Math.round((chars / TTS_CHARS_PER_MINUTE) * 10) / 10
}

function parseUsageRow(row: { total_cost?: string; total_chars?: string; cnt?: string }) {
  const costUsd = Math.round((parseFloat(row.total_cost ?? '0') || 0) * 1_000_000) / 1_000_000
  const characters = parseInt(row.total_chars ?? '0', 10) || 0
  const synthesisCount = parseInt(row.cnt ?? '0', 10) || 0
  return {
    costUsd,
    characters,
    minutesUsed: charsToMinutes(characters),
    synthesisCount,
  }
}

function emptySlice(): TtsUsageSlice {
  return { costUsd: 0, characters: 0, minutesUsed: 0, synthesisCount: 0 }
}

/**
 * TTS usage split by purpose. Legacy rows without purpose:
 * - google_tts worker keys → treat as phone_call (calls were the main worker use)
 * - elevenlabs → treat as voice_message
 */
async function queryTtsProviderUsage(provider: 'google_tts' | 'elevenlabs', start: Date, end: Date): Promise<TtsProviderUsage> {
  const rows = await prisma.$queryRaw<Array<{ bucket: string; total_cost: string; total_chars: string; cnt: string }>>(
    Prisma.sql`SELECT
      CASE
        WHEN units->>'purpose' = 'phone_call' THEN 'phone_call'
        WHEN units->>'purpose' IN ('voice_message', 'web_voice', 'salah_voice') THEN 'voice_message'
        WHEN ${provider} = 'google_tts'
          AND (units->>'purpose' IS NULL OR units->>'purpose' = '')
          AND COALESCE(dedup_key, '') LIKE 'tts:worker:%' THEN 'phone_call'
        WHEN ${provider} = 'google_tts'
          AND (units->>'purpose' IS NULL OR units->>'purpose' = '')
          AND COALESCE(dedup_key, '') LIKE 'tts:web:%' THEN 'voice_message'
        WHEN ${provider} = 'elevenlabs'
          AND (units->>'purpose' IS NULL OR units->>'purpose' = '') THEN 'voice_message'
        ELSE 'voice_message'
      END AS bucket,
      COALESCE(SUM(cost_usd), 0)::text AS total_cost,
      COALESCE(SUM(COALESCE((units->>'characters')::int, 0)), 0)::text AS total_chars,
      COUNT(*)::text AS cnt
    FROM agent_cost_events
    WHERE provider = ${provider}
      AND kind = 'tts'
      AND occurred_at >= ${start} AND occurred_at < ${end}
    GROUP BY 1`,
  )

  const byBucket = new Map<string, TtsUsageSlice>()
  for (const row of rows) {
    byBucket.set(row.bucket, parseUsageRow(row))
  }

  const phoneCallsSlice = byBucket.get('phone_call') ?? emptySlice()
  const voiceMessages = byBucket.get('voice_message') ?? emptySlice()

  const total: TtsUsageSlice = {
    costUsd: Math.round((phoneCallsSlice.costUsd + voiceMessages.costUsd) * 1_000_000) / 1_000_000,
    characters: phoneCallsSlice.characters + voiceMessages.characters,
    minutesUsed: charsToMinutes(phoneCallsSlice.characters + voiceMessages.characters),
    synthesisCount: phoneCallsSlice.synthesisCount + voiceMessages.synthesisCount,
  }

  return {
    total,
    phoneCalls: { ...phoneCallsSlice, callCount: phoneCallsSlice.synthesisCount },
    voiceMessages,
  }
}

async function queryTwilioCallUsage(start: Date, end: Date): Promise<TwilioCallUsage> {
  const rows = await prisma.$queryRaw<Array<{ total_cost: string; call_count: string; total_seconds: string }>>(
    Prisma.sql`SELECT
      COALESCE(SUM(cost_usd), 0)::text AS total_cost,
      COUNT(*)::text AS call_count,
      COALESCE(SUM(COALESCE((units->>'estimated_seconds')::int, 60)), 0)::text AS total_seconds
    FROM agent_cost_events
    WHERE provider = 'twilio'
      AND kind = 'call'
      AND occurred_at >= ${start} AND occurred_at < ${end}`,
  )
  const costUsd = Math.round((parseFloat(rows[0]?.total_cost ?? '0') || 0) * 1_000_000) / 1_000_000
  const callCount = parseInt(rows[0]?.call_count ?? '0', 10) || 0
  const totalSeconds = parseInt(rows[0]?.total_seconds ?? '0', 10) || 0
  return {
    callCount,
    minutesUsed: Math.round((totalSeconds / 60) * 10) / 10,
    costUsd,
  }
}

export async function getCostDashboardData() {
  await assertAgentCostSchemaReady()

  const todayStr = todayYmdDhaka()
  const todayBounds = dhakaDayBounds(todayStr)
  const monthB = dhakaMonthBounds(todayStr)

  const [todayUsdAll, budgets, todayByProvider] = await Promise.all([
    queryCostSumBetween(todayBounds.start, todayBounds.end),
    getBudgetSettings(),
    import('@/agent/lib/api-balances').then((m) => m.querySpendByProviderBetween(todayBounds.start, todayBounds.end)),
  ])
  const todayOxylabsCredits = todayByProvider.oxylabs ?? 0
  const todayUsd = Math.round((todayUsdAll - todayOxylabsCredits) * 1_000_000) / 1_000_000
  const monthBillable = await queryBillableCostSumBetween(monthB.start, monthB.end)

  const dailyRows = await prisma.$queryRaw<Array<{ day: string; provider: string; total: string }>>(
    Prisma.sql`SELECT to_char((occurred_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day,
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

  let csAnalytics: Record<string, unknown> | null = null
  try {
    const { getCsAnalyticsSummary } = await import('@/agent/lib/cs/analytics')
    csAnalytics = await getCsAnalyticsSummary(7)
  } catch (err) {
    console.warn('[cost-dashboard] CS analytics load failed:', err instanceof Error ? err.message : err)
  }

  const csCostRows = await prisma.$queryRaw<Array<{ kind: string; total: string }>>(
    Prisma.sql`SELECT kind, SUM(cost_usd)::text AS total
               FROM agent_cost_events
               WHERE kind LIKE 'cs_%'
                 AND occurred_at >= ${monthB.start} AND occurred_at < ${monthB.end}
               GROUP BY kind
               ORDER BY SUM(cost_usd) DESC`,
  ).catch(() => [] as Array<{ kind: string; total: string }>)

  const providerRows = await prisma.$queryRaw<Array<{ provider: string; total: string }>>(
    Prisma.sql`SELECT provider, SUM(cost_usd)::text AS total
               FROM agent_cost_events
               WHERE occurred_at >= ${monthB.start} AND occurred_at < ${monthB.end}
               GROUP BY provider
               ORDER BY SUM(cost_usd) DESC`,
  )
  const byProvider = providerRows.map((r) => ({
    provider: r.provider,
    totalUsd: parseFloat(r.total) || 0,
  }))

  const topConvRows = await prisma.$queryRaw<Array<{ conversation_id: string; total: string; title: string | null; source: string | null }>>(
    Prisma.sql`SELECT e.conversation_id,
                      SUM(e.cost_usd)::text AS total,
                      c.title,
                      c.source
               FROM agent_cost_events e
               LEFT JOIN agent_conversations c ON c.id::text = e.conversation_id
               WHERE e.conversation_id IS NOT NULL
                 AND e.occurred_at >= ${monthB.start} AND e.occurred_at < ${monthB.end}
               GROUP BY e.conversation_id, c.title, c.source
               ORDER BY SUM(e.cost_usd) DESC
               LIMIT 20`,
  )

  const topWebConversations = topConvRows
    .filter((r) => r.source !== 'telegram')
    .slice(0, 10)
    .map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      totalUsd: parseFloat(r.total) || 0,
    }))

  const telegramDailyRows = await prisma.$queryRaw<Array<{ day: string; total: string }>>(
    Prisma.sql`SELECT to_char((e.occurred_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day,
                      SUM(e.cost_usd)::text AS total
               FROM agent_cost_events e
               INNER JOIN agent_conversations c ON c.id::text = e.conversation_id
               WHERE c.source = 'telegram'
                 AND e.occurred_at >= NOW() - INTERVAL '30 days'
               GROUP BY 1
               ORDER BY 1 ASC`,
  ).catch(() => [] as Array<{ day: string; total: string }>)

  const topTelegramConvRows = await prisma.$queryRaw<Array<{ conversation_id: string; total: string; title: string | null }>>(
    Prisma.sql`SELECT e.conversation_id,
                      SUM(e.cost_usd)::text AS total,
                      c.title
               FROM agent_cost_events e
               INNER JOIN agent_conversations c ON c.id::text = e.conversation_id
               WHERE c.source = 'telegram'
                 AND e.occurred_at >= ${monthB.start} AND e.occurred_at < ${monthB.end}
               GROUP BY e.conversation_id, c.title
               ORDER BY SUM(e.cost_usd) DESC
               LIMIT 15`,
  ).catch(() => [] as Array<{ conversation_id: string; total: string; title: string | null }>)

  const telegramTodayRow = await prisma.$queryRaw<Array<{ total: string }>>(
    Prisma.sql`SELECT COALESCE(SUM(e.cost_usd), 0)::text AS total
               FROM agent_cost_events e
               INNER JOIN agent_conversations c ON c.id::text = e.conversation_id
               WHERE c.source = 'telegram'
                 AND e.occurred_at >= ${todayBounds.start} AND e.occurred_at < ${todayBounds.end}`,
  ).catch(() => [{ total: '0' }])

  const telegramMonthRow = await prisma.$queryRaw<Array<{ total: string }>>(
    Prisma.sql`SELECT COALESCE(SUM(e.cost_usd), 0)::text AS total
               FROM agent_cost_events e
               INNER JOIN agent_conversations c ON c.id::text = e.conversation_id
               WHERE c.source = 'telegram'
                 AND e.occurred_at >= ${monthB.start} AND e.occurred_at < ${monthB.end}`,
  ).catch(() => [{ total: '0' }])

  const telegramMonthUsd = parseFloat(telegramMonthRow[0]?.total ?? '0') || 0

  const subscriptions = await prisma.agentSubscription.findMany({
    where: { active: true },
    orderBy: { nextRenewalAt: 'asc' },
  })

  const subMonthlyUsd = subscriptions.reduce((s, sub) => {
    const amt = Number(sub.amount)
    if (sub.currency !== 'USD') return s
    return s + (sub.billingCycle === 'yearly' ? amt / 12 : amt)
  }, 0)

  const dayOfMonth = parseInt(todayStr.split('-')[2], 10)
  const daysInMonth = new Date(parseInt(todayStr.slice(0, 4), 10), parseInt(todayStr.slice(5, 7), 10), 0).getDate()
  const apiForecast = dayOfMonth > 0 ? (monthBillable / dayOfMonth) * daysInMonth : monthBillable
  const forecastUsd = apiForecast + subMonthlyUsd

  const dailyBudgetPct = budgets.dailyUsd ? formatBudgetPct(todayUsd, budgets.dailyUsd) : null
  const monthlyBudgetPct = budgets.monthlyUsd ? formatBudgetPct(monthBillable, budgets.monthlyUsd) : null

  const [
    googleTtsToday,
    googleTtsMonth,
    elevenLabsToday,
    elevenLabsMonth,
    twilioCallsToday,
    twilioCallsMonth,
  ] = await Promise.all([
    queryTtsProviderUsage('google_tts', todayBounds.start, todayBounds.end),
    queryTtsProviderUsage('google_tts', monthB.start, monthB.end),
    queryTtsProviderUsage('elevenlabs', todayBounds.start, todayBounds.end),
    queryTtsProviderUsage('elevenlabs', monthB.start, monthB.end),
    queryTwilioCallUsage(todayBounds.start, todayBounds.end),
    queryTwilioCallUsage(monthB.start, monthB.end),
  ])

  return {
    todayDhakaDate: todayStr,
    todayUsd,
    todayOxylabsCredits,
    monthUsd: monthBillable,
    forecastUsd: Math.round(forecastUsd * 1_000_000) / 1_000_000,
    subscriptionAmortMonthUsd: Math.round(subMonthlyUsd * 1_000_000) / 1_000_000,
    dailyLast30,
    byProvider,
    topConversations: topWebConversations,
    telegramTodayUsd: parseFloat(telegramTodayRow[0]?.total ?? '0') || 0,
    telegramMonthUsd: Math.round(telegramMonthUsd * 1_000_000) / 1_000_000,
    telegramDailyLast30: telegramDailyRows.map((r) => ({
      date: r.day,
      totalUsd: parseFloat(r.total) || 0,
    })),
    topTelegramConversations: topTelegramConvRows.map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      totalUsd: parseFloat(r.total) || 0,
    })),
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      name: s.name,
      amount: Number(s.amount),
      currency: s.currency,
      billingCycle: s.billingCycle,
      nextRenewalAt: s.nextRenewalAt.toISOString().slice(0, 10),
      category: s.category,
      notes: s.notes,
      dailyUsd: subscriptionDailyUsd(Number(s.amount), s.billingCycle as 'monthly' | 'yearly'),
    })),
    budgets,
    dailyBudgetPct,
    monthlyBudgetPct,
    csByKind: csCostRows.map((r) => ({
      kind: r.kind,
      totalUsd: parseFloat(r.total) || 0,
    })),
    csAnalytics,
    asOf: new Date().toISOString(),
    googleTts: {
      today: googleTtsToday,
      month: googleTtsMonth,
      priceNote: '$16 / 1M chars (Chirp HD estimate)',
      twilioCallsToday,
      twilioCallsMonth,
    },
    elevenLabs: {
      today: elevenLabsToday,
      month: elevenLabsMonth,
      priceNote: '$0.30 / 1k chars (Starter estimate)',
    },
  }
}
