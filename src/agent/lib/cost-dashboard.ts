/**
 * Server-side aggregations for /agent/costs dashboard.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getBudgetSettings } from '@/agent/lib/cost-events'
import { subscriptionDailyUsd } from '@/agent/lib/pricing'
import { assertAgentCostSchemaReady, queryCostSumBetween, queryPromptCacheUsageBetween, type PromptCacheUsageRow } from '@/agent/lib/cost-db'
import { queryBillableCostSumBetween, formatBudgetPct } from '@/agent/lib/cost-budget'
import { todayYmdDhaka, dhakaDayBounds, dhakaMonthBounds } from '@/lib/agent-api/dhaka-date'
import { PRICING_META } from '@/agent/lib/pricing'
import { EFFECTIVE_PROVIDER_SQL } from '@/agent/lib/api-balances'
import { MODEL_REGISTRY } from '@/agent/lib/models/registry'

const DHAKA_TZ = 'Asia/Dhaka'

/** Min chat turns today before we alert that prompt caching may be broken. */
const CACHE_ALERT_MIN_TURNS = 5
/** cache_read / (cache_read + fresh input) — below this with enough turns → warning */
const CACHE_HIT_RATIO_WARN = 0.05

export type PromptCacheMonitorSnapshot = {
  dhakaDate: string
  tokensSaved: number
  usdSaved: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  chatTurns: number
  /** cache_read / (cache_read + input_tokens), 0–1 */
  cacheHitRatio: number
  cachingBroken: boolean
}

export function computePromptCacheSavings(usage: PromptCacheUsageRow): {
  tokensSaved: number
  usdSaved: number
} {
  const p = PRICING_META.anthropic
  const tokensSaved = usage.cacheReadTokens
  const rateDelta = (p.inputPerMillion - p.cacheReadPerMillion) / 1_000_000
  const usdSaved = Math.round(tokensSaved * rateDelta * 1_000_000) / 1_000_000
  return { tokensSaved, usdSaved }
}

export function buildPromptCacheMonitorSnapshot(
  dhakaDate: string,
  usage: PromptCacheUsageRow,
): PromptCacheMonitorSnapshot {
  const { tokensSaved, usdSaved } = computePromptCacheSavings(usage)
  const prefixTokens = usage.cacheReadTokens + usage.inputTokens
  const cacheHitRatio = prefixTokens > 0
    ? Math.round((usage.cacheReadTokens / prefixTokens) * 1000) / 1000
    : 0
  const cachingBroken =
    usage.chatTurns >= CACHE_ALERT_MIN_TURNS
    && usage.cacheReadTokens < 100
    && usage.inputTokens > 1_000

  return {
    dhakaDate,
    tokensSaved,
    usdSaved,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    chatTurns: usage.chatTurns,
    cacheHitRatio,
    cachingBroken,
  }
}

export async function getPromptCacheMonitorSnapshot(dhakaDate?: string): Promise<PromptCacheMonitorSnapshot> {
  const dateStr = dhakaDate ?? todayYmdDhaka()
  const bounds = dhakaDayBounds(dateStr)
  const usage = await queryPromptCacheUsageBetween(bounds.start, bounds.end)
  return buildPromptCacheMonitorSnapshot(dateStr, usage)
}

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
                      ${EFFECTIVE_PROVIDER_SQL} AS provider,
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
    Prisma.sql`SELECT ${EFFECTIVE_PROVIDER_SQL} AS provider, SUM(cost_usd)::text AS total
               FROM agent_cost_events
               WHERE occurred_at >= ${monthB.start} AND occurred_at < ${monthB.end}
               GROUP BY 1
               ORDER BY SUM(cost_usd) DESC`,
  )
  const byProvider = providerRows.map((r) => ({
    provider: r.provider,
    totalUsd: parseFloat(r.total) || 0,
  }))

  // Per-MODEL breakdown (chat turns carry units->>'model'). Answers the owner's
  // "every model, end-to-end, which day" — today/month totals plus a 30-day daily
  // stack keyed on the model id, mapped to its registry label + provider. Rows with
  // no units.model (TTS, images, calls, embeddings) are grouped under '_other'.
  const modelLabelMap = new Map(MODEL_REGISTRY.map((m) => [m.id, { label: m.label, provider: m.provider }]))
  const MODEL_KEY_SQL = Prisma.sql`COALESCE(NULLIF(units->>'model', ''), '_other')`

  const [modelMonthRows, modelTodayRows, modelDailyRows] = await Promise.all([
    prisma.$queryRaw<Array<{ model: string; provider: string; total: string }>>(
      Prisma.sql`SELECT ${MODEL_KEY_SQL} AS model, ${EFFECTIVE_PROVIDER_SQL} AS provider, SUM(cost_usd)::text AS total
                 FROM agent_cost_events
                 WHERE occurred_at >= ${monthB.start} AND occurred_at < ${monthB.end}
                 GROUP BY 1, 2
                 ORDER BY SUM(cost_usd) DESC`,
    ),
    prisma.$queryRaw<Array<{ model: string; total: string }>>(
      Prisma.sql`SELECT ${MODEL_KEY_SQL} AS model, SUM(cost_usd)::text AS total
                 FROM agent_cost_events
                 WHERE occurred_at >= ${todayBounds.start} AND occurred_at < ${todayBounds.end}
                 GROUP BY 1`,
    ),
    prisma.$queryRaw<Array<{ day: string; model: string; total: string }>>(
      Prisma.sql`SELECT to_char((occurred_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day,
                        ${MODEL_KEY_SQL} AS model,
                        SUM(cost_usd)::text AS total
                 FROM agent_cost_events
                 WHERE occurred_at >= NOW() - INTERVAL '30 days'
                 GROUP BY 1, 2
                 ORDER BY 1 ASC`,
    ),
  ])

  const todayByModel = new Map<string, number>()
  for (const r of modelTodayRows) todayByModel.set(r.model, parseFloat(r.total) || 0)

  const byModel = modelMonthRows.map((r) => {
    const meta = modelLabelMap.get(r.model)
    return {
      modelId: r.model,
      label: meta?.label ?? (r.model === '_other' ? 'Other (TTS / image / calls)' : r.model),
      provider: meta?.provider ?? r.provider,
      monthUsd: parseFloat(r.total) || 0,
      todayUsd: Math.round((todayByModel.get(r.model) ?? 0) * 1_000_000) / 1_000_000,
    }
  })

  const modelDailyMap = new Map<string, Record<string, number>>()
  for (const r of modelDailyRows) {
    if (!modelDailyMap.has(r.day)) modelDailyMap.set(r.day, {})
    const bucket = modelDailyMap.get(r.day)!
    bucket[r.model] = parseFloat(r.total) || 0
    bucket.total = (bucket.total ?? 0) + (parseFloat(r.total) || 0)
  }
  const modelDailyLast30 = [...modelDailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, models]) => ({ date, ...models }))

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
    promptCache,
  ] = await Promise.all([
    queryTtsProviderUsage('google_tts', todayBounds.start, todayBounds.end),
    queryTtsProviderUsage('google_tts', monthB.start, monthB.end),
    queryTtsProviderUsage('elevenlabs', todayBounds.start, todayBounds.end),
    queryTtsProviderUsage('elevenlabs', monthB.start, monthB.end),
    queryTwilioCallUsage(todayBounds.start, todayBounds.end),
    queryTwilioCallUsage(monthB.start, monthB.end),
    getPromptCacheMonitorSnapshot(todayStr),
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
    byModel,
    modelDailyLast30,
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
      plan: s.plan,
      paymentMethod: s.paymentMethod,
      providerId: s.providerId,
      sourceType: s.sourceType,
      invoiceAmount: s.invoiceAmount == null ? null : Number(s.invoiceAmount),
      invoiceCurrency: s.invoiceCurrency,
      invoiceDueAt: s.invoiceDueAt?.toISOString().slice(0, 10) ?? null,
      invoiceStatus: s.invoiceStatus,
      sourceUrl: s.sourceUrl,
      lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
      syncStatus: s.syncStatus,
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
    promptCache,
  }
}
