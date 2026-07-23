/**
 * API provider balance tracking — KV credits + live/provider usage APIs + cost_events spend.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaDayBounds, dhakaMonthBounds, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import {
  fetchElevenLabsQuota,
  fetchFalUsageCosts,
  fetchFashnQuota,
  fetchGoogleCloudBillingCosts,
  fetchOxylabsUsage,
  fetchSupabaseOrganizationPlan,
  fetchVercelBillingCosts,
  fetchXaiBilling,
  type ProviderInvoiceSnapshot,
  type ProviderQuotaSnapshot,
  type ProviderSourceType,
  type ProviderSyncStatus,
  type ProviderUsageSnapshot,
} from '@/agent/lib/provider-billing'

export const API_BALANCE_CACHE_KEY = 'api_balance_cache'

// OpenRouter live-balance micro-cache. The full balance snapshot only refreshes
// on the 6-hourly cron (or a manual POST), so between refreshes the subscription
// screen showed a stale OpenRouter balance while labelled "Live API" — the owner's
// mismatch. We re-fetch /credits on read when this micro-cache is older than the
// TTL, throttled to at most one call per TTL across all readers.
const OPENROUTER_LIVE_KEY = 'api_balance:openrouter_live'
const OPENROUTER_LIVE_TTL_MS = 180_000 // 3 min

export type BalanceProviderId =
  | 'anthropic'
  | 'twilio'
  | 'openai'
  | 'openrouter'
  | 'gemini'
  | 'google_tts'
  | 'meta_free'
  | 'oxylabs'
  | 'elevenlabs'
  | 'veo'
  | 'fal'
  | 'fashn'
  | 'xai'
  | 'vercel'
  | 'supabase'

export type BalanceKind = 'wallet' | 'manual_estimate' | 'quota' | 'none'

export type ApiBalanceCredit = {
  initialCredit: number
  lastTopup: string
  currency: 'USD'
}

export type BalanceProviderRow = {
  id: BalanceProviderId
  label: string
  // Legacy compatibility field. Only real USD wallets/manual USD estimates
  // populate it; quota providers intentionally leave it null.
  balanceUsd: number | null
  balanceKind: BalanceKind
  balanceAmount: number | null
  balanceCurrency: string | null
  balanceUnit: string | null
  quota?: ProviderQuotaSnapshot | null
  usage?: ProviderUsageSnapshot | null
  invoice?: ProviderInvoiceSnapshot | null
  todayUsd: number | null
  monthUsd: number | null
  providerMonthUsd?: number | null
  localDeltaUsd?: number | null
  source: string
  sourceType: ProviderSourceType
  costSourceType: ProviderSourceType
  status: ProviderSyncStatus
  statusMessage?: string | null
  // Authority is field-specific: a provider can expose a real wallet/quota but
  // still have only locally measured cost (Twilio/fal), or expose a plan but no
  // invoice/cost API (Supabase).
  balanceAuthoritative: boolean
  costAuthoritative: boolean
  planAuthoritative: boolean
  authoritative: boolean
  fetchedAt: string
  staleAfter: string | null
  dashboardUrl?: string | null
  plan?: string | null
  capabilities: string[]
  configuredCapabilities?: string[]
  free?: boolean
  // Latest day the provider's billing API has published data for (YYYY-MM-DD,
  // Anthropic only). The Admin cost API lags ~1–2 days, so monthUsd is accurate
  // only up to this date; the UI shows it as a "sync: <date>" note + a deep link
  // to the platform for the not-yet-synced most-recent days.
  syncedThrough?: string | null
}

export type ApiBalanceCache = {
  checkedAt: string
  providers: BalanceProviderRow[]
  summaryLine: string
  dueSummary?: {
    dueNow: number
    dueWithin7Days: number
    dueWithin30Days: number
    amountsWithin30Days: Array<{ currency: string; amount: number }>
  }
}

export type LowBalanceAlert = {
  provider: BalanceProviderId
  label: string
  balanceUsd: number
  thresholdUsd: number
}

const CREDIT_KEY_PREFIX = 'api_balance:'

export const PROVIDER_ALIASES: Record<string, BalanceProviderId> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  chatgpt: 'openai',
  gpt: 'openai',
  openrouter: 'openrouter',
  'open router': 'openrouter',
  router: 'openrouter',
  deepseek: 'openrouter',
  qwen: 'openrouter',
  gemini: 'gemini',
  google_tts: 'google_tts',
  'google tts': 'google_tts',
  tts: 'google_tts',
  oxylabs: 'oxylabs',
  oxy: 'oxylabs',
  elevenlabs: 'elevenlabs',
  eleven: 'elevenlabs',
  veo: 'veo',
  'veo 3': 'veo',
  veo3: 'veo',
  fal: 'fal',
  fashn: 'fashn',
  'fashn.ai': 'fashn',
  'fal.ai': 'fal',
  falai: 'fal',
  seedream: 'fal',
  xai: 'xai',
  grok: 'xai',
  vercel: 'vercel',
  supabase: 'supabase',
}

const PROVIDER_META: Record<BalanceProviderId, {
  label: string
  source: string
  dashboardUrl: string | null
  capabilities: string[]
  free?: boolean
}> = {
  anthropic: {
    label: 'Anthropic',
    source: 'Provider cost + local delta',
    dashboardUrl: 'https://platform.claude.com/workspaces/default/cost',
    capabilities: ['cost'],
  },
  twilio: {
    label: 'Twilio',
    source: 'Provider API',
    dashboardUrl: 'https://console.twilio.com/us1/billing/manage-billing/billing-overview',
    capabilities: ['wallet'],
  },
  openai: {
    label: 'OpenAI',
    source: 'Provider cost + local delta',
    dashboardUrl: 'https://platform.openai.com/settings/organization/usage',
    capabilities: ['cost'],
  },
  openrouter: {
    label: 'OpenRouter',
    source: 'Provider API',
    dashboardUrl: 'https://openrouter.ai/activity',
    capabilities: ['wallet', 'cost'],
  },
  gemini: {
    label: 'Gemini',
    source: 'Cloud Billing + local delta',
    dashboardUrl: 'https://aistudio.google.com/usage',
    capabilities: ['cost'],
  },
  google_tts: {
    label: 'Google TTS',
    source: 'Cloud Billing + local delta',
    dashboardUrl: 'https://console.cloud.google.com/billing',
    capabilities: ['cost'],
  },
  meta_free: {
    label: 'Meta/ntfy',
    source: 'Free',
    dashboardUrl: null,
    capabilities: ['free'],
    free: true,
  },
  oxylabs: {
    label: 'Oxylabs',
    source: 'Provider usage API',
    dashboardUrl: 'https://dashboard.oxylabs.io/',
    capabilities: ['usage'],
  },
  elevenlabs: {
    label: 'ElevenLabs',
    source: 'Provider quota API',
    dashboardUrl: 'https://elevenlabs.io/app/subscription',
    capabilities: ['quota', 'plan', 'usage', 'invoice'],
  },
  veo: {
    label: 'Veo',
    source: 'Cloud Billing + local delta',
    dashboardUrl: 'https://console.cloud.google.com/billing',
    capabilities: ['cost'],
  },
  fashn: {
    label: 'FASHN',
    source: 'Provider credits API',
    dashboardUrl: 'https://app.fashn.ai/',
    capabilities: ['quota', 'plan'],
  },
  fal: {
    label: 'fal.ai',
    source: 'Provider API',
    dashboardUrl: 'https://fal.ai/dashboard/billing',
    capabilities: ['wallet', 'cost', 'pricing'],
  },
  xai: {
    label: 'xAI',
    source: 'Management billing API',
    dashboardUrl: 'https://console.x.ai/',
    capabilities: ['wallet', 'cost', 'invoice'],
  },
  vercel: {
    label: 'Vercel',
    source: 'FOCUS billing charges',
    dashboardUrl: 'https://vercel.com/dashboard/~/usage',
    capabilities: ['cost'],
  },
  supabase: {
    label: 'Supabase',
    source: 'Management API',
    dashboardUrl: 'https://supabase.com/dashboard/organizations',
    capabilities: ['plan'],
  },
}

const TRACKED_COST_PROVIDERS: BalanceProviderId[] = [
  'anthropic', 'twilio', 'openai', 'openrouter', 'gemini', 'google_tts',
  'oxylabs', 'elevenlabs', 'veo', 'fal', 'fashn', 'xai', 'vercel', 'supabase',
]

function creditKey(provider: BalanceProviderId): string {
  return `${CREDIT_KEY_PREFIX}${provider}`
}

export function normalizeBalanceProvider(input: string): BalanceProviderId | null {
  const key = input.trim().toLowerCase().replace(/-/g, '_')
  return PROVIDER_ALIASES[key] ?? (key in PROVIDER_META ? key as BalanceProviderId : null)
}

export function dhakaSpendBounds() {
  const todayStr = todayYmdDhaka()
  const { start: dayStart, end: dayEnd } = dhakaDayBounds(todayStr)
  const { start: monthStart, end: monthEnd } = dhakaMonthBounds(todayStr)
  return { todayStr, dayStart, dayEnd, monthStart, monthEnd }
}

export async function getApiBalanceCredit(provider: BalanceProviderId): Promise<ApiBalanceCredit | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: creditKey(provider) } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as ApiBalanceCredit
    if (!Number.isFinite(parsed.initialCredit)) return null
    return {
      initialCredit: parsed.initialCredit,
      lastTopup: parsed.lastTopup ?? new Date(0).toISOString(),
      currency: parsed.currency === 'USD' ? 'USD' : 'USD',
    }
  } catch (err) {
    console.warn('[api-balances] getApiBalanceCredit parse failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function setApiCredit(
  provider: BalanceProviderId,
  amount: number,
  currency = 'USD',
): Promise<ApiBalanceCredit> {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('amount must be a non-negative number')
  }
  const credit: ApiBalanceCredit = {
    initialCredit: amount,
    lastTopup: new Date().toISOString(),
    currency: currency === 'USD' ? 'USD' : 'USD',
  }
  await prisma.agentKvSetting.upsert({
    where: { key: creditKey(provider) },
    update: { value: JSON.stringify(credit) },
    create: { key: creditKey(provider), value: JSON.stringify(credit) },
  })
  return credit
}

// Effective cost-provider for a row. Older OpenRouter chat turns were mislabeled
// with provider='openai' (the cost column), but the model's true provider was
// always recorded in units->>'provider' ('openrouter'). Remap from units when
// present so historical OpenRouter (DeepSeek/Qwen) spend shows under OpenRouter,
// while non-chat rows (no units.provider) keep their stored cost-provider column.
// Note: units.provider stores the raw model provider ('google' → 'gemini' here).
export const EFFECTIVE_PROVIDER_SQL = Prisma.sql`CASE
  WHEN units->>'provider' = 'openrouter' THEN 'openrouter'
  WHEN units->>'provider' = 'google' THEN 'gemini'
  WHEN units->>'provider' = 'openai' THEN 'openai'
  WHEN units->>'provider' = 'anthropic' THEN 'anthropic'
  ELSE provider
END`

export async function querySpendByProviderBetween(
  start: Date,
  end: Date,
): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ provider: string; total: string }>>(
    Prisma.sql`SELECT ${EFFECTIVE_PROVIDER_SQL} AS provider, COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE occurred_at >= ${start} AND occurred_at < ${end}
      GROUP BY 1`,
  )
  return Object.fromEntries(rows.map((r) => [r.provider, parseFloat(r.total) || 0]))
}

export async function querySpendSince(provider: string, since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: string }>>(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE ${EFFECTIVE_PROVIDER_SQL} = ${provider} AND occurred_at >= ${since}`,
  )
  return parseFloat(rows[0]?.total ?? '0') || 0
}

async function fetchTwilioBalance(): Promise<number | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return null
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString('base64')
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { balance?: string; currency?: string }
    const bal = parseFloat(data.balance ?? '')
    return Number.isFinite(bal) ? bal : null
  } catch (err) {
    console.warn('[api-balances] fetchTwilioBalance failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Live month-to-date Anthropic org spend via the Admin cost_report API.
 *
 * ROOT CAUSE of the old "$0.00" bug: the Cost API returns at most 7 daily
 * buckets per page (1d granularity) and signals the rest via has_more/next_page.
 * The previous code fetched only the FIRST page (days 1–7) — which can legitimately
 * be empty early in some months — summed to 0, and that 0 overwrote the real
 * tracked spend. We now paginate through every page so the whole month is summed.
 *
 * We also build the window at UTC midnight ([first-of-month 00:00Z .. tomorrow
 * 00:00Z)) to match the API's daily UTC buckets, and return null (not 0) when the
 * call fails or yields no buckets so the caller keeps locally tracked spend
 * instead of overwriting it with zero.
 *
 * Returns USD (the API reports `amount` as a decimal string of cents).
 */
async function fetchAnthropicMonthSpendUsd(
  todayStr: string,
): Promise<{ usd: number; syncedThrough: string | null } | null> {
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY
  if (!adminKey) return null
  try {
    const startingAt = `${todayStr.slice(0, 7)}-01T00:00:00Z`     // first of month, UTC midnight
    const endingAt = `${addDaysYmd(todayStr, 1)}T00:00:00Z`        // tomorrow, exclusive
    let page: string | null = null
    let cents = 0
    let syncedThrough: string | null = null   // latest UTC day the API has data for

    for (let i = 0; i < 12; i++) {
      const url = new URL('https://api.anthropic.com/v1/organizations/cost_report')
      url.searchParams.set('starting_at', startingAt)
      url.searchParams.set('ending_at', endingAt)
      if (page) url.searchParams.set('page', page)

      const res = await fetch(url, {
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn(`[api-balances] anthropic cost_report HTTP ${res.status}`)
        return null
      }
      const data = await res.json() as {
        data?: Array<{ starting_at?: string; results?: Array<{ amount?: string | number }> }>
        has_more?: boolean
        next_page?: string | null
      }
      for (const bucket of data.data ?? []) {
        const results = bucket.results ?? []
        // A requested trailing bucket may exist before the provider has published
        // its cost rows. Only a bucket with results advances the reconciliation
        // boundary; otherwise today's local events could disappear from the total.
        if (results.length > 0) {
          const day = bucket.starting_at?.slice(0, 10) ?? null
          if (day && (syncedThrough == null || day > syncedThrough)) syncedThrough = day
        }
        for (const row of results) {
          const amt = typeof row.amount === 'number' ? row.amount : parseFloat(row.amount ?? '0')
          cents += Number.isFinite(amt) ? amt : 0
        }
      }
      if (data.has_more && data.next_page) { page = data.next_page; continue }
      break
    }

    // A successful empty report is valid (for example, no billed usage yet).
    // syncedThrough stays null, so reconciliation adds the whole local month
    // instead of mistaking an unpublished trailing bucket for provider truth.
    return { usd: cents / 100, syncedThrough }
  } catch (err) {
    console.warn('[api-balances] fetchAnthropicMonthSpend failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export function parseOpenAICostPage(data: {
  data?: Array<{
    start_time?: number
    results?: Array<{ amount?: { value?: number; currency?: string } }>
  }>
  has_more?: boolean
  next_page?: string | null
}): {
  usd: number
  bucketCount: number
  syncedThrough: string | null
  hasMore: boolean
  nextPage: string | null
} {
  let usd = 0
  let bucketCount = 0
  let syncedThrough: string | null = null
  for (const bucket of data.data ?? []) {
    const results = bucket.results ?? []
    if (results.length > 0) bucketCount++
    if (results.length > 0 && typeof bucket.start_time === 'number') {
      const day = new Date(bucket.start_time * 1_000).toISOString().slice(0, 10)
      if (syncedThrough == null || day > syncedThrough) syncedThrough = day
    }
    for (const result of results) {
      if ((result.amount?.currency ?? 'usd').toLowerCase() !== 'usd') continue
      const amount = Number(result.amount?.value ?? 0)
      if (Number.isFinite(amount)) usd += amount
    }
  }
  return {
    usd,
    bucketCount,
    syncedThrough,
    hasMore: Boolean(data.has_more),
    nextPage: data.next_page ?? null,
  }
}

async function fetchOpenAIMonthSpendUsd(
  monthStart: Date,
  monthEnd: Date,
): Promise<{ usd: number; syncedThrough: string | null } | null> {
  const orgId = process.env.OPENAI_ORG_ID?.trim()
  const adminKey = process.env.OPENAI_ADMIN_API_KEY?.trim()
  if (!adminKey) return null
  try {
    const start = Math.floor(monthStart.getTime() / 1000)
    const end = Math.floor(Math.min(monthEnd.getTime(), Date.now() + 1_000) / 1000)
    let page: string | null = null
    let usd = 0
    let syncedThrough: string | null = null

    for (let index = 0; index < 12; index++) {
      const url = new URL('https://api.openai.com/v1/organization/costs')
      url.searchParams.set('start_time', String(start))
      url.searchParams.set('end_time', String(end))
      url.searchParams.set('bucket_width', '1d')
      url.searchParams.set('limit', '31')
      if (page) url.searchParams.set('page', page)

      const headers: Record<string, string> = { Authorization: `Bearer ${adminKey}` }
      if (orgId) headers['OpenAI-Organization'] = orgId
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        console.warn(`[api-balances] openai organization costs HTTP ${response.status}`)
        return null
      }
      const parsed = parseOpenAICostPage(await response.json())
      usd += parsed.usd
      if (parsed.syncedThrough && (
        syncedThrough == null || parsed.syncedThrough > syncedThrough
      )) {
        syncedThrough = parsed.syncedThrough
      }
      if (!parsed.hasMore || !parsed.nextPage) break
      page = parsed.nextPage
    }

    // Preserve a successful zero-cost response. A null boundary deliberately
    // causes reconciliation to add the whole local month.
    // OpenAI's amount.value is already the numeric currency value (USD), not cents.
    return { usd: roundUsd(usd), syncedThrough }
  } catch (err) {
    console.warn('[api-balances] fetchOpenAIMonthSpend failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * OpenRouter live credit balance. GET /api/v1/credits returns total_credits
 * (lifetime purchased/granted) and total_usage (lifetime spent); remaining
 * balance = total_credits − total_usage. This is the real money left on the key,
 * so we use it directly as the OpenRouter balance (no KV-credit fallback needed).
 */
async function fetchOpenRouterCreditsUsd(): Promise<number | null> {
  const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY?.trim()
  if (!apiKey) return null
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { data?: { total_credits?: number; total_usage?: number } }
    const credits = data.data?.total_credits ?? 0
    const usage = data.data?.total_usage ?? 0
    return roundUsd(credits - usage)
  } catch (err) {
    console.warn('[api-balances] fetchOpenRouterCredits failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * OpenRouter live balance for the READ path, throttled by a 3-min KV micro-cache.
 *
 * The default balances GET returns the cached snapshot (last 6-hourly cron), and
 * `overlayLiveLocalSpend` only recomputed today/month — never the balance itself —
 * so the OpenRouter row could sit up to 6h stale behind a "Live API" label. This
 * re-fetches /credits when the micro-cache is older than the TTL and reuses it
 * otherwise, so a hot dashboard poll doesn't hammer OpenRouter. Returns null when
 * no fresh value is available (call failed and nothing cached).
 */
async function getFreshOpenRouterBalanceUsd(): Promise<number | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: OPENROUTER_LIVE_KEY } })
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { usd?: number; at?: string }
      const at = parsed.at ? Date.parse(parsed.at) : NaN
      if (Number.isFinite(parsed.usd) && Number.isFinite(at) && Date.now() - at < OPENROUTER_LIVE_TTL_MS) {
        return parsed.usd as number
      }
    }
    const live = await fetchOpenRouterCreditsUsd()
    if (live != null) {
      await prisma.agentKvSetting.upsert({
        where: { key: OPENROUTER_LIVE_KEY },
        update: { value: JSON.stringify({ usd: live, at: new Date().toISOString() }) },
        create: { key: OPENROUTER_LIVE_KEY, value: JSON.stringify({ usd: live, at: new Date().toISOString() }) },
      })
      return live
    }
    // Live call failed — fall back to whatever we last stored, even if stale.
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { usd?: number }
      return Number.isFinite(parsed.usd) ? (parsed.usd as number) : null
    }
    return null
  } catch (err) {
    console.warn('[api-balances] getFreshOpenRouterBalanceUsd failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Authoritative month-to-date OpenRouter spend via the Activity API.
 *
 * Requires a *management* key — a normal inference key returns 403 on this endpoint.
 * IMPORTANT: reads OPENROUTER_MANAGEMENT_KEY, NEVER OPENROUTER_API_KEY. The management
 * key cannot make model/inference calls, so it is kept strictly separate from the
 * routing key — using it for inference would break all OpenRouter model usage.
 *
 * Account-wide across all keys/models (matches the OpenRouter Activity page and the
 * credit balance, which local agent tracking under-counts when non-agent usage draws
 * on the same credit). Only COMPLETED UTC days are reported and it lags ~1–2 days, so
 * syncedThrough marks the latest day included; the most-recent days fall back to local
 * tracking + the platform deep link (same pattern as Anthropic). `usage` is already USD.
 */
async function fetchOpenRouterActivityMonthUsd(
  todayStr: string,
): Promise<{ usd: number; syncedThrough: string | null } | null> {
  const mgmtKey = process.env.OPENROUTER_MANAGEMENT_KEY
  if (!mgmtKey) return null
  try {
    const res = await fetch('https://openrouter.ai/api/v1/activity', {
      headers: { Authorization: `Bearer ${mgmtKey}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      console.warn(`[api-balances] openrouter activity HTTP ${res.status}`)
      return null
    }
    const data = await res.json() as { data?: Array<{ date?: string; usage?: number }> }
    const ym = todayStr.slice(0, 7)            // current YYYY-MM
    let usd = 0
    let syncedThrough: string | null = null
    let matched = false
    for (const row of data.data ?? []) {
      const day = (row.date ?? '').slice(0, 10)
      if (!day.startsWith(ym) || day > todayStr) continue
      matched = true
      usd += typeof row.usage === 'number' && Number.isFinite(row.usage) ? row.usage : 0
      if (syncedThrough == null || day > syncedThrough) syncedThrough = day
    }
    if (!matched) return null
    return { usd: roundUsd(usd), syncedThrough }
  } catch (err) {
    console.warn('[api-balances] fetchOpenRouterActivityMonth failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** fal.ai prepaid credits — the admin key's account billing API (owner 2026-07-12:
 *  live balance visible on the Credit Usage + Subscriptions screens). */
async function fetchFalBalanceUsd(): Promise<number | null> {
  const apiKey = process.env.FAL_KEY
  if (!apiKey) return null
  try {
    const res = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { credits?: { current_balance?: number } }
    const bal = data.credits?.current_balance
    return typeof bal === 'number' && Number.isFinite(bal) ? roundUsd(bal) : null
  } catch (err) {
    console.warn('[api-balances] fetchFalBalance failed:', err instanceof Error ? err.message : err)
    return null
  }
}

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100
}

function formatSummaryUsd(n: number): string {
  if (n >= 10) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(1)}`
  return `$${n.toFixed(2)}`
}

export function buildBalanceSummaryLine(rows: BalanceProviderRow[]): string {
  const parts = rows
    .filter((r) => !r.free && r.balanceKind === 'wallet' && r.balanceUsd != null && r.balanceUsd >= 0)
    .map((r) => `${r.label}: ${formatSummaryUsd(r.balanceUsd!)}`)
  return parts.length ? `💳 ${parts.join(' | ')}` : ''
}

export async function readBalanceCache(): Promise<ApiBalanceCache | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: API_BALANCE_CACHE_KEY } })
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as ApiBalanceCache
  } catch (err) {
    console.warn('[api-balances] readBalanceCache parse failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function storeBalanceCache(cache: ApiBalanceCache): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: API_BALANCE_CACHE_KEY },
    update: { value: JSON.stringify(cache) },
    create: { key: API_BALANCE_CACHE_KEY, value: JSON.stringify(cache) },
  })
}

function normalizeCachedProvider(
  row: Partial<BalanceProviderRow> & Pick<BalanceProviderRow, 'id' | 'label'>,
  cacheCheckedAt: string,
): BalanceProviderRow {
  const meta = PROVIDER_META[row.id]
  const oldWallet = row.id === 'twilio' || row.id === 'openrouter' || row.id === 'fal'
  const oldQuota = row.id === 'elevenlabs' || row.id === 'fashn'
  const balanceKind = row.balanceKind
    ?? (oldWallet && row.balanceUsd != null
      ? 'wallet'
      : oldQuota
        ? 'none'
        : row.balanceUsd != null
          ? 'manual_estimate'
          : 'none')
  const balanceAmount = oldQuota ? null : (row.balanceAmount ?? row.balanceUsd ?? null)
  const sourceType = row.sourceType
    ?? (oldWallet ? 'provider_api' : row.free ? 'free' : row.balanceUsd != null ? 'manual' : 'local_measured')
  return {
    id: row.id,
    label: row.label,
    balanceUsd: oldQuota ? null : (row.balanceUsd ?? null),
    balanceKind,
    balanceAmount,
    balanceCurrency: row.balanceCurrency ?? (balanceAmount != null && row.id !== 'oxylabs' ? 'USD' : null),
    balanceUnit: row.balanceUnit ?? (balanceAmount != null ? (row.id === 'oxylabs' ? 'credits' : 'USD') : null),
    quota: row.quota ?? null,
    usage: row.usage ?? null,
    invoice: row.invoice ?? row.quota?.invoice ?? null,
    todayUsd: row.todayUsd ?? null,
    monthUsd: row.monthUsd ?? null,
    providerMonthUsd: row.providerMonthUsd ?? null,
    localDeltaUsd: row.localDeltaUsd ?? null,
    source: row.source ?? meta.source,
    sourceType,
    costSourceType: row.costSourceType ?? 'local_measured',
    status: row.status ?? (row.free ? 'free' : 'stale'),
    statusMessage: row.statusMessage ?? null,
    balanceAuthoritative: row.balanceAuthoritative
      ?? Boolean(row.authoritative && (balanceKind === 'wallet' || balanceKind === 'quota')),
    costAuthoritative: row.costAuthoritative
      ?? Boolean(row.authoritative && row.providerMonthUsd != null),
    planAuthoritative: row.planAuthoritative
      ?? Boolean(row.authoritative && row.plan && sourceType === 'provider_api'),
    authoritative: row.authoritative ?? oldWallet,
    fetchedAt: row.fetchedAt ?? cacheCheckedAt,
    staleAfter: row.staleAfter ?? null,
    dashboardUrl: row.dashboardUrl ?? meta.dashboardUrl,
    plan: row.plan ?? null,
    capabilities: row.capabilities ?? meta.capabilities,
    configuredCapabilities: row.configuredCapabilities ?? [],
    free: row.free,
    syncedThrough: row.syncedThrough ?? null,
  }
}

function previousProvider(cache: ApiBalanceCache | null, id: BalanceProviderId): BalanceProviderRow | null {
  const row = cache?.providers?.find((candidate) => candidate.id === id)
  if (!row) return null
  return normalizeCachedProvider(row, cache?.checkedAt ?? new Date(0).toISOString())
}

function staleAfter(fetchedAt: string, minutes: number): string {
  return new Date(Date.parse(fetchedAt) + minutes * 60_000).toISOString()
}

export function providerLocalDeltaStart(
  provider: BalanceProviderId,
  syncedThrough: string | null,
): Date | null {
  if (!syncedThrough) return null
  const nextDay = addDaysYmd(syncedThrough, 1)
  return provider === 'gemini' || provider === 'google_tts' || provider === 'veo'
    ? dhakaDayBounds(nextDay).start
    : new Date(`${nextDay}T00:00:00Z`)
}

async function reconcileProviderMonth(
  provider: BalanceProviderId,
  providerMonthUsd: number,
  syncedThrough: string | null,
): Promise<{ monthUsd: number; localDeltaUsd: number }> {
  if (!syncedThrough) {
    const monthStart = dhakaMonthBounds(todayYmdDhaka()).start
    const localDeltaUsd = roundUsd(await querySpendSince(provider, monthStart))
    return {
      monthUsd: roundUsd(providerMonthUsd + localDeltaUsd),
      localDeltaUsd,
    }
  }
  // Google billing rows are grouped in Asia/Dhaka. Admin/API daily buckets from
  // Anthropic, OpenAI and OpenRouter are UTC. The boundary must match the source
  // or six hours of local usage can be dropped/duplicated.
  const localStart = providerLocalDeltaStart(provider, syncedThrough)
  if (!localStart) return { monthUsd: roundUsd(providerMonthUsd), localDeltaUsd: 0 }
  const localDeltaUsd = roundUsd(await querySpendSince(provider, localStart))
  return {
    monthUsd: roundUsd(providerMonthUsd + localDeltaUsd),
    localDeltaUsd,
  }
}

async function getSubscriptionDueSummary(
  todayStr: string,
  excludeProviderIds = new Set<string>(),
): Promise<NonNullable<ApiBalanceCache['dueSummary']>> {
  const end30 = addDaysYmd(todayStr, 30)
  const end30At = new Date(`${end30}T23:59:59+06:00`)
  const rows = await prisma.agentSubscription.findMany({
    where: {
      active: true,
      OR: [
        { invoiceDueAt: { lte: end30At } },
        { nextRenewalAt: { lte: end30At } },
      ],
    },
    select: {
      providerId: true,
      name: true,
      nextRenewalAt: true,
      amount: true,
      currency: true,
      invoiceDueAt: true,
      invoiceAmount: true,
      invoiceCurrency: true,
      invoiceStatus: true,
    },
  })
  return summarizeSubscriptionDues(rows, todayStr, excludeProviderIds)
}

export function summarizeSubscriptionDues(
  rows: Array<{
    providerId?: string | null
    name?: string | null
    nextRenewalAt: Date
    amount: unknown
    currency: string
    invoiceDueAt: Date | null
    invoiceAmount: unknown | null
    invoiceCurrency: string | null
    invoiceStatus: string | null
  }>,
  todayStr: string,
  excludeProviderIds = new Set<string>(),
): NonNullable<ApiBalanceCache['dueSummary']> {
  const end30 = addDaysYmd(todayStr, 30)
  let dueNow = 0
  let dueWithin7Days = 0
  let dueWithin30Days = 0
  const amounts = new Map<string, number>()
  const in7 = addDaysYmd(todayStr, 7)

  for (const row of rows) {
    const linkedProvider = row.providerId?.toLowerCase()
      ?? (row.name ? normalizeBalanceProvider(row.name) : null)
    if (linkedProvider && excludeProviderIds.has(linkedProvider)) continue
    const invoiceSettled = ['paid', 'void', 'cancelled', 'canceled'].includes(
      (row.invoiceStatus ?? '').trim().toLowerCase(),
    )
    const useInvoice = Boolean(row.invoiceDueAt && !invoiceSettled)
    const dueDate = useInvoice && row.invoiceDueAt ? row.invoiceDueAt : row.nextRenewalAt
    const due = todayYmdDhaka(dueDate)
    if (due > end30) continue
    const currency = useInvoice
      ? (row.invoiceCurrency?.trim().toUpperCase() || row.currency)
      : row.currency
    const amount = useInvoice && row.invoiceAmount != null
      ? Number(row.invoiceAmount)
      : Number(row.amount)
    if (due <= todayStr) dueNow++
    if (due <= in7) dueWithin7Days++
    dueWithin30Days++
    amounts.set(currency, (amounts.get(currency) ?? 0) + amount)
  }
  return {
    dueNow,
    dueWithin7Days,
    dueWithin30Days,
    amountsWithin30Days: Array.from(amounts, ([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100,
    })),
  }
}

export function mergeProviderInvoiceDues(
  summary: NonNullable<ApiBalanceCache['dueSummary']>,
  invoices: ProviderInvoiceSnapshot[],
  todayStr: string,
): NonNullable<ApiBalanceCache['dueSummary']> {
  const amounts = new Map(summary.amountsWithin30Days.map((item) => [item.currency, item.amount]))
  let dueNow = summary.dueNow
  let dueWithin7Days = summary.dueWithin7Days
  let dueWithin30Days = summary.dueWithin30Days
  const in7 = addDaysYmd(todayStr, 7)
  const in30 = addDaysYmd(todayStr, 30)

  for (const invoice of invoices) {
    if (!invoice.dueAt || ['paid', 'void', 'cancelled', 'canceled'].includes(invoice.status.toLowerCase())) continue
    const due = todayYmdDhaka(new Date(invoice.dueAt))
    if (due > in30) continue
    if (due <= todayStr) dueNow++
    if (due <= in7) dueWithin7Days++
    dueWithin30Days++
    amounts.set(invoice.currency, (amounts.get(invoice.currency) ?? 0) + invoice.amount)
  }
  return {
    dueNow,
    dueWithin7Days,
    dueWithin30Days,
    amountsWithin30Days: Array.from(amounts, ([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100,
    })),
  }
}

async function persistProviderBillingSnapshots(
  providers: BalanceProviderRow[],
  startedAt: Date,
): Promise<void> {
  try {
    // Keep the read path on the existing KV cache for compatibility, while the
    // normalized snapshot table supplies durable per-provider audit/provenance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const writes = providers.map((row) => {
      const nextUnreportedAt = providerLocalDeltaStart(row.id, row.syncedThrough ?? null)
      const providerAsOf = nextUnreportedAt
        ? new Date(nextUnreportedAt.getTime() - 1)
        : null
      const metadata = JSON.parse(JSON.stringify(row))
      return db.agentProviderBillingSnapshot.upsert({
        where: { provider_metric: { provider: row.id, metric: 'summary' } },
        update: {
          status: row.status,
          sourceType: row.sourceType,
          authoritative: row.authoritative,
          amount: row.monthUsd,
          currency: row.monthUsd != null ? 'USD' : row.balanceCurrency,
          unit: row.balanceUnit,
          textValue: row.plan,
          providerAsOf,
          fetchedAt: new Date(row.fetchedAt),
          staleAfter: row.staleAfter ? new Date(row.staleAfter) : null,
          metadata,
        },
        create: {
          provider: row.id,
          metric: 'summary',
          status: row.status,
          sourceType: row.sourceType,
          authoritative: row.authoritative,
          amount: row.monthUsd,
          currency: row.monthUsd != null ? 'USD' : row.balanceCurrency,
          unit: row.balanceUnit,
          textValue: row.plan,
          providerAsOf,
          fetchedAt: new Date(row.fetchedAt),
          staleAfter: row.staleAfter ? new Date(row.staleAfter) : null,
          metadata,
        },
      })
    })
    await db.$transaction(writes)
    const errors = providers.filter((row) => row.status === 'error' || row.status === 'stale')
    await db.agentProviderSyncRun.create({
      data: {
        provider: 'all',
        status: errors.length ? 'partial' : 'success',
        startedAt,
        finishedAt: new Date(),
        fieldsUpdated: providers.length,
        error: errors.length
          ? errors.map((row) => `${row.id}: ${row.statusMessage ?? row.status}`).join('; ')
          : null,
        metadata: {
          live: providers.filter((row) => row.status === 'live').length,
          partial: providers.filter((row) => row.status === 'partial').length,
          manual: providers.filter((row) => row.status === 'manual').length,
          unconfigured: providers.filter((row) => row.status === 'unconfigured').length,
        },
      },
    })
  } catch (error) {
    // The KV cache remains the compatibility source during migration rollout.
    console.warn('[api-balances] provider snapshot persistence failed:', error instanceof Error ? error.message : error)
  }
}

export async function refreshApiBalanceCache(): Promise<{
  cache: ApiBalanceCache
  twilioRaw?: { balance: string; currency: string } | null
  alerts: LowBalanceAlert[]
}> {
  const startedAt = new Date()
  const { todayStr, dayStart, dayEnd, monthStart, monthEnd } = dhakaSpendBounds()
  const [
    previousCache,
    todayByProvider,
    monthByProvider,
    twilioLive,
    anthropicAdminMonth,
    openaiAdminMonth,
    openRouterLive,
    openRouterActivityMonth,
    elevenLabsQuota,
    falLive,
    falUsage,
    fashnQuota,
    oxylabsUsage,
    xaiBilling,
    vercelBilling,
    supabasePlan,
    googleBilling,
    credits,
  ] = await Promise.all([
    readBalanceCache(),
    querySpendByProviderBetween(dayStart, dayEnd),
    querySpendByProviderBetween(monthStart, monthEnd),
    fetchTwilioBalance(),
    fetchAnthropicMonthSpendUsd(todayStr),
    fetchOpenAIMonthSpendUsd(monthStart, monthEnd),
    fetchOpenRouterCreditsUsd(),
    fetchOpenRouterActivityMonthUsd(todayStr),
    fetchElevenLabsQuota(),
    fetchFalBalanceUsd(),
    fetchFalUsageCosts(monthStart, new Date(), todayStr),
    fetchFashnQuota(),
    fetchOxylabsUsage(`${todayStr.slice(0, 7)}-01`, todayStr),
    fetchXaiBilling(monthStart, new Date(), todayStr),
    fetchVercelBillingCosts(monthStart, new Date(), todayStr),
    fetchSupabaseOrganizationPlan(),
    fetchGoogleCloudBillingCosts(monthStart, todayStr),
    Promise.all(TRACKED_COST_PROVIDERS.map(async (provider) => ({
      provider,
      credit: await getApiBalanceCredit(provider),
    }))),
  ])
  const creditByProvider = new Map(credits.map((item) => [item.provider, item.credit]))

  let twilioRaw: { balance: string; currency: string } | null = null
  if (twilioLive != null) {
    twilioRaw = { balance: String(twilioLive), currency: 'USD' }
  }

  const providers: BalanceProviderRow[] = []

  for (const id of TRACKED_COST_PROVIDERS) {
    const meta = PROVIDER_META[id]
    const previous = previousProvider(previousCache, id)
    const credit = creditByProvider.get(id) ?? null
    let todayUsd: number | null = roundUsd(todayByProvider[id] ?? 0)
    let monthUsd: number | null = roundUsd(monthByProvider[id] ?? 0)
    let providerMonthUsd: number | null = null
    let localDeltaUsd: number | null = null
    let balanceUsd: number | null = null
    let balanceKind: BalanceKind = 'none'
    let balanceAmount: number | null = null
    let balanceCurrency: string | null = null
    let balanceUnit: string | null = null
    let quota: ProviderQuotaSnapshot | null = null
    let usage: ProviderUsageSnapshot | null = null
    let invoice: ProviderInvoiceSnapshot | null = null
    let syncedThrough: string | null = null
    let plan: string | null = null
    let sourceType: ProviderSourceType = 'local_measured'
    let costSourceType: ProviderSourceType = 'local_measured'
    let status: ProviderSyncStatus = monthUsd > 0 ? 'manual' : 'unconfigured'
    let statusMessage: string | null = monthUsd > 0
      ? 'শুধু local request events পাওয়া গেছে; provider billing credential এখনো connected নয়।'
      : 'এই provider-এর billing connection configure করা হয়নি।'
    let balanceAuthoritative = false
    let costAuthoritative = false
    let planAuthoritative = false
    let authoritative = false
    let fetchedAt = startedAt.toISOString()
    let staleAt: string | null = null
    const configuredCapabilities: string[] = []
    if (id === 'anthropic' && process.env.ANTHROPIC_ADMIN_API_KEY) configuredCapabilities.push('cost')
    if (id === 'twilio' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) configuredCapabilities.push('wallet')
    if (id === 'openai' && process.env.OPENAI_ADMIN_API_KEY) configuredCapabilities.push('cost')
    if (id === 'openrouter' && process.env.OPENROUTER_MANAGEMENT_KEY) configuredCapabilities.push('wallet', 'cost')
    if ((id === 'gemini' || id === 'google_tts' || id === 'veo') && googleBilling.configured) configuredCapabilities.push('cost')
    if (id === 'oxylabs' && oxylabsUsage.configured) configuredCapabilities.push('usage')
    if (id === 'elevenlabs' && elevenLabsQuota.configured) configuredCapabilities.push('quota', 'plan', 'usage', 'invoice')
    if (id === 'fal') {
      if (process.env.FAL_KEY) configuredCapabilities.push('wallet')
      if (falUsage.configured) configuredCapabilities.push('cost')
    }
    if (id === 'fashn' && fashnQuota.configured) configuredCapabilities.push('quota', 'plan')
    if (id === 'xai' && xaiBilling.configured) configuredCapabilities.push('wallet', 'cost', 'invoice')
    if (id === 'vercel' && vercelBilling.configured) configuredCapabilities.push('cost')
    if (id === 'supabase' && supabasePlan.configured) configuredCapabilities.push('plan')

    // ---- Authoritative wallet/quota fields ----
    if (id === 'twilio') {
      const configured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
      if (twilioLive != null) {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = roundUsd(twilioLive)
        balanceCurrency = balanceUnit = 'USD'
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'Twilio account wallet থেকে সরাসরি পাওয়া।'
        balanceAuthoritative = true
        staleAt = staleAfter(fetchedAt, 20)
      } else if (configured && previous?.balanceKind === 'wallet') {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = previous.balanceAmount
        balanceCurrency = previous.balanceCurrency
        balanceUnit = previous.balanceUnit
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = 'Twilio refresh ব্যর্থ; শেষ সফল wallet value রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (configured) {
        status = 'error'
        statusMessage = 'Twilio balance API refresh ব্যর্থ।'
      }
    } else if (id === 'openrouter') {
      if (openRouterLive != null) {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = roundUsd(openRouterLive)
        balanceCurrency = balanceUnit = 'USD'
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'Purchased credit minus lifetime usage; provider API value।'
        balanceAuthoritative = true
        staleAt = staleAfter(fetchedAt, 20)
      } else if (process.env.OPENROUTER_MANAGEMENT_KEY && previous?.balanceKind === 'wallet') {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = previous.balanceAmount
        balanceCurrency = previous.balanceCurrency
        balanceUnit = previous.balanceUnit
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = 'OpenRouter refresh ব্যর্থ; শেষ সফল wallet value রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (process.env.OPENROUTER_MANAGEMENT_KEY) {
        status = 'error'
        statusMessage = 'OpenRouter credits API refresh ব্যর্থ।'
      }
    } else if (id === 'fal') {
      if (falLive != null) {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = roundUsd(falLive)
        balanceCurrency = balanceUnit = 'USD'
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'fal.ai prepaid credit balance।'
        balanceAuthoritative = true
        staleAt = staleAfter(fetchedAt, 20)
      } else if (process.env.FAL_KEY && previous?.balanceKind === 'wallet') {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = previous.balanceAmount
        balanceCurrency = previous.balanceCurrency
        balanceUnit = previous.balanceUnit
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = 'fal.ai refresh ব্যর্থ; শেষ সফল wallet value রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (process.env.FAL_KEY) {
        status = 'error'
        statusMessage = 'fal.ai billing API refresh ব্যর্থ।'
      }
    } else if (id === 'elevenlabs') {
      if (elevenLabsQuota.ok && elevenLabsQuota.value) {
        quota = elevenLabsQuota.value
        invoice = quota.invoice
        plan = quota.plan
        balanceKind = 'quota'
        balanceAmount = quota.remaining
        balanceUnit = quota.unit
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'এটি character quota; cash balance নয়।'
        balanceAuthoritative = true
        planAuthoritative = Boolean(plan)
        fetchedAt = elevenLabsQuota.fetchedAt
        staleAt = staleAfter(fetchedAt, 20)
      } else if (elevenLabsQuota.configured && previous?.quota) {
        quota = previous.quota
        invoice = previous.invoice ?? quota.invoice
        plan = previous.plan ?? null
        balanceKind = 'quota'
        balanceAmount = quota.remaining
        balanceUnit = quota.unit
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = elevenLabsQuota.error ?? 'ElevenLabs quota refresh ব্যর্থ; শেষ সফল value রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        planAuthoritative = previous.planAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (elevenLabsQuota.configured) {
        status = 'error'
        statusMessage = elevenLabsQuota.error
      }
    } else if (id === 'fashn') {
      if (fashnQuota.ok && fashnQuota.value) {
        quota = fashnQuota.value
        balanceKind = 'quota'
        balanceAmount = quota.remaining
        balanceUnit = quota.unit
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'Subscription + on-demand credits; USD cash নয়।'
        balanceAuthoritative = true
        fetchedAt = fashnQuota.fetchedAt
        staleAt = staleAfter(fetchedAt, 20)
      } else if (fashnQuota.configured && previous?.quota) {
        quota = previous.quota
        balanceKind = 'quota'
        balanceAmount = quota.remaining
        balanceUnit = quota.unit
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = fashnQuota.error ?? 'FASHN refresh ব্যর্থ; শেষ সফল credits রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (fashnQuota.configured) {
        status = 'error'
        statusMessage = fashnQuota.error
      }
    } else if (id === 'oxylabs') {
      if (oxylabsUsage.ok && oxylabsUsage.value) {
        usage = oxylabsUsage.value
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'Monthly request usage সরাসরি Oxylabs stats API থেকে পাওয়া; cash balance endpoint নেই।'
        fetchedAt = oxylabsUsage.fetchedAt
        staleAt = staleAfter(fetchedAt, 180)
      } else if (oxylabsUsage.configured && previous?.usage) {
        usage = previous.usage
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = oxylabsUsage.error ?? 'Oxylabs stats refresh ব্যর্থ; শেষ সফল usage রাখা হয়েছে।'
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (oxylabsUsage.configured) {
        status = 'error'
        statusMessage = oxylabsUsage.error
      }
    } else if (id === 'xai') {
      if (xaiBilling.ok && xaiBilling.value) {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = roundUsd(xaiBilling.value.balanceUsd)
        balanceCurrency = balanceUnit = 'USD'
        invoice = xaiBilling.value.invoice
        sourceType = 'provider_api'
        status = 'live'
        statusMessage = 'Prepaid balance, usage ও current invoice preview সরাসরি xAI Management API থেকে পাওয়া।'
        balanceAuthoritative = true
        fetchedAt = xaiBilling.fetchedAt
        staleAt = staleAfter(fetchedAt, 20)
      } else if (xaiBilling.configured && previous?.balanceKind === 'wallet') {
        balanceKind = 'wallet'
        balanceAmount = balanceUsd = previous.balanceAmount
        balanceCurrency = previous.balanceCurrency
        balanceUnit = previous.balanceUnit
        invoice = previous.invoice ?? null
        sourceType = 'provider_api'
        status = 'stale'
        statusMessage = xaiBilling.error ?? 'xAI refresh ব্যর্থ; শেষ সফল billing snapshot রাখা হয়েছে।'
        balanceAuthoritative = previous.balanceAuthoritative
        fetchedAt = previous.fetchedAt
        staleAt = previous.staleAfter
      } else if (xaiBilling.configured) {
        status = 'error'
        statusMessage = xaiBilling.error
      }
    }

    // ---- Provider-reported cost + non-overlapping local delta ----
    if (id === 'anthropic' && anthropicAdminMonth != null) {
      providerMonthUsd = roundUsd(anthropicAdminMonth.usd)
      syncedThrough = anthropicAdminMonth.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      costSourceType = 'provider_api'
      sourceType = 'provider_api'
      status = 'live'
      statusMessage = 'Official Anthropic cost connected; report boundary-এর পরের request local delta হিসেবে আলাদা। Wallet endpoint provider দেয় না।'
      costAuthoritative = true
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'openai' && openaiAdminMonth != null) {
      providerMonthUsd = roundUsd(openaiAdminMonth.usd)
      syncedThrough = openaiAdminMonth.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      costSourceType = 'provider_api'
      status = 'live'
      statusMessage = 'Official OpenAI organization cost connected; report boundary-এর পরের request local delta হিসেবে আলাদা। Wallet endpoint provider দেয় না।'
      costAuthoritative = true
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'openrouter' && openRouterActivityMonth != null) {
      providerMonthUsd = roundUsd(openRouterActivityMonth.usd)
      syncedThrough = openRouterActivityMonth.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      costSourceType = 'provider_api'
      costAuthoritative = true
      status = 'live'
      statusMessage = 'Wallet ও official activity report connected; report boundary-এর পরের request local delta হিসেবে আলাদা।'
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'fal' && falUsage.ok && falUsage.value) {
      providerMonthUsd = falUsage.value.monthUsd
      syncedThrough = falUsage.value.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      todayUsd = syncedThrough === todayStr ? falUsage.value.todayUsd : todayUsd
      costSourceType = 'provider_api'
      costAuthoritative = true
      status = 'live'
      statusMessage = balanceAuthoritative
        ? 'Prepaid wallet ও workspace usage দুইটিই fal.ai provider API থেকে connected।'
        : 'Workspace usage fal.ai Admin API থেকে connected; wallet field-এর API key আলাদা।'
      fetchedAt = falUsage.fetchedAt
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'xai' && xaiBilling.ok && xaiBilling.value) {
      providerMonthUsd = xaiBilling.value.cost.monthUsd
      syncedThrough = xaiBilling.value.cost.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      todayUsd = syncedThrough === todayStr ? xaiBilling.value.cost.todayUsd : todayUsd
      costSourceType = 'provider_api'
      costAuthoritative = true
      status = 'live'
      staleAt = staleAfter(fetchedAt, 180)
    } else if ((id === 'gemini' || id === 'google_tts' || id === 'veo') && googleBilling.ok && googleBilling.value) {
      const google = googleBilling.value[id]
      providerMonthUsd = google.monthUsd
      syncedThrough = google.syncedThrough
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      todayUsd = syncedThrough === todayStr ? google.todayUsd : todayUsd
      costSourceType = 'provider_export'
      sourceType = 'provider_export'
      status = 'live'
      statusMessage = 'Google Cloud Billing export connected; export boundary-এর পরের request local delta হিসেবে আলাদা। Google Cloud wallet endpoint নেই।'
      costAuthoritative = true
      fetchedAt = googleBilling.fetchedAt
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'vercel' && vercelBilling.ok && vercelBilling.value) {
      providerMonthUsd = vercelBilling.value.monthUsd
      monthUsd = providerMonthUsd
      todayUsd = vercelBilling.value.todayUsd
      syncedThrough = vercelBilling.value.syncedThrough
      sourceType = costSourceType = 'provider_export'
      status = 'live'
      statusMessage = 'FOCUS billed charges connected; upcoming invoice/due field Vercel public API-তে exposed নয়।'
      costAuthoritative = true
      fetchedAt = vercelBilling.fetchedAt
      staleAt = staleAfter(fetchedAt, 180)
    } else if (id === 'supabase' && supabasePlan.ok && supabasePlan.value) {
      todayUsd = null
      monthUsd = null
      plan = supabasePlan.value.plan
      sourceType = 'provider_api'
      costSourceType = 'manual'
      status = 'live'
      statusMessage = 'Organization plan connected; cost ও upcoming invoice/due Supabase public Management API-তে exposed নয়।'
      planAuthoritative = true
      fetchedAt = supabasePlan.fetchedAt
      staleAt = staleAfter(fetchedAt, 1_440)
    }

    // Configured provider call failed: preserve the last authoritative cost base,
    // then add only local events after its recorded boundary.
    const externalCostFailed =
      (id === 'anthropic' && Boolean(process.env.ANTHROPIC_ADMIN_API_KEY) && anthropicAdminMonth == null)
      || (id === 'openai' && Boolean(process.env.OPENAI_ADMIN_API_KEY) && openaiAdminMonth == null)
      || (id === 'fal' && falUsage.configured && !falUsage.ok)
      || (id === 'xai' && xaiBilling.configured && !xaiBilling.ok)
      || ((id === 'gemini' || id === 'google_tts' || id === 'veo') && googleBilling.configured && !googleBilling.ok)
      || (id === 'vercel' && vercelBilling.configured && !vercelBilling.ok)
      || (id === 'supabase' && supabasePlan.configured && !supabasePlan.ok)
    const providerFailure = id === 'fal'
      ? falUsage.error
      : id === 'xai'
        ? xaiBilling.error
        : (id === 'gemini' || id === 'google_tts' || id === 'veo')
          ? googleBilling.error
          : id === 'vercel'
            ? vercelBilling.error
            : id === 'supabase'
              ? supabasePlan.error
              : null
    if (externalCostFailed && id === 'supabase' && previous?.plan) {
      plan = previous.plan
      sourceType = previous.sourceType
      costSourceType = previous.costSourceType
      status = 'stale'
      statusMessage = 'Supabase refresh ব্যর্থ; শেষ সফল plan রাখা হয়েছে।'
      fetchedAt = previous.fetchedAt
      staleAt = previous.staleAfter
      planAuthoritative = previous.planAuthoritative
    } else if (externalCostFailed && previous?.providerMonthUsd != null) {
      providerMonthUsd = previous.providerMonthUsd
      syncedThrough = previous.syncedThrough ?? null
      const reconciled = await reconcileProviderMonth(id, providerMonthUsd, syncedThrough)
      monthUsd = reconciled.monthUsd
      localDeltaUsd = reconciled.localDeltaUsd
      costSourceType = previous.costSourceType
      if (id === 'supabase') plan = previous.plan ?? null
      status = 'stale'
      statusMessage = `Provider refresh ব্যর্থ${providerFailure ? ` (${providerFailure})` : ''}; শেষ authoritative snapshot + নতুন local delta দেখানো হচ্ছে।`
      fetchedAt = previous.fetchedAt
      staleAt = previous.staleAfter
      costAuthoritative = previous.costAuthoritative
    } else if (externalCostFailed && status !== 'stale') {
      status = 'error'
      statusMessage = `Provider billing refresh ব্যর্থ${providerFailure ? `: ${providerFailure}` : ''}; local measured data থাকলে শুধু সেটিই দেখানো হচ্ছে।`
    }

    // Providers without a wallet API may retain a user-entered opening credit,
    // but it is labelled as a manual estimate and never treated as authoritative.
    if (balanceKind === 'none' && credit && id !== 'twilio' && id !== 'elevenlabs' && id !== 'fashn') {
      const since = new Date(credit.lastTopup)
      const spent = await querySpendSince(id, since)
      balanceAmount = roundUsd(credit.initialCredit - spent)
      balanceKind = 'manual_estimate'
      balanceUnit = id === 'oxylabs' ? 'credits' : 'USD'
      balanceCurrency = id === 'oxylabs' ? null : 'USD'
      balanceUsd = id === 'oxylabs' ? null : balanceAmount
      sourceType = 'manual'
      if (!costAuthoritative && !planAuthoritative) {
        status = 'manual'
        statusMessage = balanceAmount < 0
          ? 'Manual opening estimate শেষ হয়েছে; এটি provider wallet balance নয়।'
          : 'Manual opening amount minus locally measured usage; provider wallet balance নয়।'
      }
    }

    if (id === 'xai' && !xaiBilling.configured) {
      status = (monthUsd ?? 0) > 0 ? 'manual' : 'unconfigured'
      statusMessage = status === 'manual'
        ? 'শুধু local xAI request events আছে; live billing-এর জন্য XAI_MANAGEMENT_API_KEY + XAI_TEAM_ID দরকার।'
        : 'Live billing-এর জন্য XAI_MANAGEMENT_API_KEY + XAI_TEAM_ID দরকার।'
    } else if (id === 'oxylabs' && !oxylabsUsage.configured && !credit) {
      status = (monthUsd ?? 0) > 0 ? 'manual' : 'unconfigured'
      statusMessage = status === 'manual'
        ? 'শুধু local usage আছে; live monthly request stats-এর জন্য OXYLABS_USERNAME + OXYLABS_PASSWORD দরকার।'
        : 'Live monthly request stats-এর জন্য OXYLABS_USERNAME + OXYLABS_PASSWORD দরকার।'
    } else if (id === 'supabase' && !supabasePlan.configured) {
      todayUsd = null
      monthUsd = null
      status = 'unconfigured'
      statusMessage = 'Supabase Management token ও organization slug configure করা হয়নি।'
    } else if (id === 'vercel' && !vercelBilling.configured) {
      todayUsd = null
      monthUsd = null
      status = 'unconfigured'
      statusMessage = 'Vercel billing token ও team ID/slug configure করা হয়নি।'
    }

    authoritative = balanceAuthoritative || costAuthoritative || planAuthoritative

    providers.push({
      id,
      label: meta.label,
      balanceUsd,
      balanceKind,
      balanceAmount,
      balanceCurrency,
      balanceUnit,
      quota,
      usage,
      invoice,
      todayUsd,
      monthUsd,
      providerMonthUsd,
      localDeltaUsd,
      source: meta.source,
      sourceType,
      costSourceType,
      status,
      statusMessage,
      balanceAuthoritative,
      costAuthoritative,
      planAuthoritative,
      authoritative,
      fetchedAt,
      staleAfter: staleAt,
      dashboardUrl: meta.dashboardUrl,
      plan,
      capabilities: meta.capabilities,
      configuredCapabilities,
      syncedThrough,
    })
  }

  const metaFree = PROVIDER_META.meta_free
  providers.push({
    id: 'meta_free',
    label: metaFree.label,
    balanceUsd: null,
    balanceKind: 'none',
    balanceAmount: null,
    balanceCurrency: null,
    balanceUnit: null,
    quota: null,
    invoice: null,
    todayUsd: null,
    monthUsd: null,
    providerMonthUsd: null,
    localDeltaUsd: null,
    source: metaFree.source,
    sourceType: 'free',
    costSourceType: 'free',
    status: 'free',
    statusMessage: 'বর্তমান integration-এ paid provider charge নেই।',
    balanceAuthoritative: true,
    costAuthoritative: true,
    planAuthoritative: true,
    authoritative: true,
    fetchedAt: startedAt.toISOString(),
    staleAfter: null,
    dashboardUrl: metaFree.dashboardUrl,
    plan: 'Free',
    capabilities: metaFree.capabilities,
    configuredCapabilities: metaFree.capabilities,
    free: true,
  })

  const providerInvoices = providers
    .filter((row) => row.invoice != null)
    .map((row) => row.invoice as ProviderInvoiceSnapshot)
  const invoiceProviderIds = new Set(
    providers.filter((row) => row.invoice != null).map((row) => row.id),
  )
  const subscriptionDueSummary = await getSubscriptionDueSummary(todayStr, invoiceProviderIds)
  const dueSummary = mergeProviderInvoiceDues(subscriptionDueSummary, providerInvoices, todayStr)

  const cache: ApiBalanceCache = {
    checkedAt: startedAt.toISOString(),
    providers,
    summaryLine: buildBalanceSummaryLine(providers),
    dueSummary,
  }

  await storeBalanceCache(cache)
  await persistProviderBillingSnapshots(providers, startedAt)

  const creditFlags: Partial<Record<BalanceProviderId, boolean>> = {}
  for (const id of ['anthropic', 'openai', 'gemini', 'google_tts', 'oxylabs', 'veo'] as BalanceProviderId[]) {
    creditFlags[id] = Boolean(creditByProvider.get(id))
  }
  creditFlags.elevenlabs = Boolean(process.env.ELEVENLABS_API_KEY)
  // OpenRouter low-balance alerting keys off the live credits API being available.
  creditFlags.openrouter = Boolean(process.env.OPENROUTER_MANAGEMENT_KEY || creditByProvider.get('openrouter'))
  creditFlags.fal = Boolean(process.env.FAL_KEY || creditByProvider.get('fal'))
  creditFlags.fashn = Boolean(process.env.FASHN_API_KEY)

  const alerts = computeLowBalanceAlerts(providers, {
    anthropicAdmin: Boolean(process.env.ANTHROPIC_ADMIN_API_KEY),
    openaiAdmin: Boolean(process.env.OPENAI_ADMIN_API_KEY),
    twilioConfigured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    creditSet: creditFlags,
  })

  return { cache, twilioRaw, alerts }
}

export function computeLowBalanceAlerts(
  providers: BalanceProviderRow[],
  opts: {
    anthropicAdmin: boolean
    openaiAdmin: boolean
    twilioConfigured: boolean
    creditSet: Partial<Record<BalanceProviderId, boolean>>
  },
): LowBalanceAlert[] {
  const alerts: LowBalanceAlert[] = []
  const generalThreshold = 3
  const twilioThreshold = 5

  for (const row of providers) {
    // Alerts are only valid for authoritative cash wallets. Manual estimates and
    // quota units must never trigger a "recharge $X" cash warning.
    if (row.free || row.balanceKind !== 'wallet' || row.balanceUsd == null) continue

    if (row.id === 'twilio') {
      if (!opts.twilioConfigured || row.balanceUsd >= twilioThreshold) continue
      alerts.push({
        provider: row.id,
        label: row.label,
        balanceUsd: row.balanceUsd,
        thresholdUsd: twilioThreshold,
      })
      continue
    }

    const configured =
      row.id === 'anthropic'
        ? Boolean(opts.creditSet.anthropic || opts.anthropicAdmin)
        : row.id === 'openai'
          ? Boolean(opts.creditSet.openai || opts.openaiAdmin)
          : row.id === 'elevenlabs'
            ? Boolean(opts.creditSet.elevenlabs)
            : Boolean(opts.creditSet[row.id])

    if (!configured || row.balanceUsd >= generalThreshold) continue

    alerts.push({
      provider: row.id,
      label: row.label,
      balanceUsd: row.balanceUsd,
      thresholdUsd: generalThreshold,
    })
  }

  return alerts
}

export async function getApiBalances(opts?: { refresh?: boolean }): Promise<ApiBalanceCache> {
  if (opts?.refresh) {
    const { cache } = await refreshApiBalanceCache()
    return cache
  }
  const cached = await readBalanceCache()
  if (cached) return overlayLiveLocalSpend(cached)
  const { cache } = await refreshApiBalanceCache()
  return cache
}

/**
 * The expensive live-API balances (Anthropic admin cost, OpenRouter credits,
 * Twilio, ElevenLabs) are cached and refreshed periodically. But each provider's
 * "today / this month" spend is just a cheap local DB aggregate — so recompute it
 * on every read and overlay it onto the cached snapshot. Without this the table
 * shows a stale midnight snapshot (e.g. "today $0.00" all day until someone hits
 * Refresh), even though spend is accruing. Live-API balances stay from cache.
 */
async function overlayLiveLocalSpend(cache: ApiBalanceCache): Promise<ApiBalanceCache> {
  try {
    const { todayStr, dayStart, dayEnd, monthStart, monthEnd } = dhakaSpendBounds()
    // Refresh the OpenRouter live balance too (throttled) — the cached snapshot's
    // balance could be up to 6h stale behind its "Live API" label.
    const [todayByProvider, monthByProvider, freshOpenRouterBalance] = await Promise.all([
      querySpendByProviderBetween(dayStart, dayEnd),
      querySpendByProviderBetween(monthStart, monthEnd),
      getFreshOpenRouterBalanceUsd(),
    ])
    const normalized = cache.providers.map((row) => normalizeCachedProvider(row, cache.checkedAt))
    const providers = await Promise.all(normalized.map(async (row) => {
      if (row.free) return row
      const liveToday = roundUsd(todayByProvider[row.id] ?? 0)
      const liveMonth = roundUsd(monthByProvider[row.id] ?? 0)
      let monthUsd = row.monthUsd
      let localDeltaUsd = row.localDeltaUsd ?? null
      if (row.providerMonthUsd != null) {
        const reconciled = await reconcileProviderMonth(row.id, row.providerMonthUsd, row.syncedThrough ?? null)
        monthUsd = reconciled.monthUsd
        localDeltaUsd = reconciled.localDeltaUsd
      } else if (row.id !== 'supabase' && row.id !== 'vercel') {
        monthUsd = liveMonth
      }

      let todayUsd: number | null = liveToday
      if (row.id === 'supabase') todayUsd = null
      if (
        row.id === 'vercel'
        || ((row.id === 'gemini' || row.id === 'google_tts' || row.id === 'veo') && row.syncedThrough === todayStr)
      ) {
        todayUsd = row.todayUsd ?? liveToday
      }

      let balanceUsd = row.balanceUsd
      let balanceAmount = row.balanceAmount
      let fetchedAt = row.fetchedAt
      let staleAt = row.staleAfter
      let status = row.status
      let statusMessage = row.statusMessage
      if (row.id === 'openrouter' && freshOpenRouterBalance != null) {
        balanceUsd = balanceAmount = roundUsd(freshOpenRouterBalance)
        fetchedAt = new Date().toISOString()
        staleAt = staleAfter(fetchedAt, 20)
        status = 'live'
        statusMessage = row.costAuthoritative
          ? 'Wallet ও official activity report connected; report boundary-এর পরের local usage আলাদা।'
          : 'Wallet connected; মাসের cost local request events থেকে estimated।'
      } else if (
        staleAt
        && Date.parse(staleAt) < Date.now()
        && (status === 'live' || status === 'partial')
      ) {
        status = 'stale'
        statusMessage = `${statusMessage ?? 'Provider snapshot'} শেষ freshness window পার করেছে।`
      }
      return {
        ...row,
        todayUsd,
        monthUsd,
        localDeltaUsd,
        balanceUsd,
        balanceAmount,
        fetchedAt,
        staleAfter: staleAt,
        status,
        statusMessage,
      }
    }))
    const providerInvoices = providers
      .filter((row) => row.invoice != null)
      .map((row) => row.invoice as ProviderInvoiceSnapshot)
    const invoiceProviderIds = new Set(
      providers.filter((row) => row.invoice != null).map((row) => row.id),
    )
    const subscriptionDueSummary = await getSubscriptionDueSummary(todayStr, invoiceProviderIds)
    const dueSummary = mergeProviderInvoiceDues(subscriptionDueSummary, providerInvoices, todayStr)
    return { ...cache, providers, dueSummary, summaryLine: buildBalanceSummaryLine(providers) }
  } catch (err) {
    console.warn('[api-balances] overlayLiveLocalSpend failed:', err instanceof Error ? err.message : err)
    return cache
  }
}

export async function wasLowBalanceAlerted(provider: string, dateStr: string): Promise<boolean> {
  const key = `cost.alert.lowbalance.${provider}.${dateStr}`
  const row = await prisma.agentKvSetting.findUnique({ where: { key } })
  return Boolean(row?.value)
}

export async function markLowBalanceAlerted(provider: string, dateStr: string): Promise<void> {
  const key = `cost.alert.lowbalance.${provider}.${dateStr}`
  await prisma.agentKvSetting.upsert({
    where: { key },
    update: { value: new Date().toISOString() },
    create: { key, value: new Date().toISOString() },
  })
}
