/**
 * API provider balance tracking — KV credits + live/provider usage APIs + cost_events spend.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaDayBounds, dhakaMonthBounds, addDaysYmd } from '@/lib/agent-api/dhaka-date'

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

export type ApiBalanceCredit = {
  initialCredit: number
  lastTopup: string
  currency: 'USD'
}

export type BalanceProviderRow = {
  id: BalanceProviderId
  label: string
  balanceUsd: number | null
  todayUsd: number | null
  monthUsd: number | null
  source: string
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
  'fal.ai': 'fal',
  falai: 'fal',
  seedream: 'fal',
}

const PROVIDER_META: Record<BalanceProviderId, { label: string; source: string; free?: boolean }> = {
  anthropic: { label: 'Anthropic', source: 'Auto+Input' },
  twilio: { label: 'Twilio', source: 'Live API' },
  openai: { label: 'OpenAI', source: 'Auto+Input' },
  openrouter: { label: 'OpenRouter', source: 'Live API' },
  gemini: { label: 'Gemini', source: 'Input+Track' },
  google_tts: { label: 'Google TTS', source: 'Input+Track' },
  meta_free: { label: 'Meta/ntfy', source: '—', free: true },
  oxylabs: { label: 'Oxylabs', source: 'Credit track' },
  elevenlabs: { label: 'ElevenLabs', source: 'Live API' },
  veo: { label: 'VEO 3', source: 'Input+Track' },
  fal: { label: 'fal.ai (Seedream)', source: 'Live API' },
}

const TRACKED_COST_PROVIDERS: BalanceProviderId[] = [
  'anthropic', 'twilio', 'openai', 'openrouter', 'gemini', 'google_tts', 'oxylabs', 'elevenlabs', 'veo', 'fal',
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
    let bucketCount = 0
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
        bucketCount++
        // The API returns a contiguous daily range up to its processing horizon,
        // so the max bucket date IS the latest day with published data.
        const day = bucket.starting_at?.slice(0, 10) ?? null
        if (day && (syncedThrough == null || day > syncedThrough)) syncedThrough = day
        for (const row of bucket.results ?? []) {
          const amt = typeof row.amount === 'number' ? row.amount : parseFloat(row.amount ?? '0')
          cents += Number.isFinite(amt) ? amt : 0
        }
      }
      if (data.has_more && data.next_page) { page = data.next_page; continue }
      break
    }

    // Empty response (e.g. individual account / misalignment) → "unavailable",
    // so the caller falls back to tracked spend rather than showing $0.00.
    if (bucketCount === 0) return null
    return { usd: cents / 100, syncedThrough }
  } catch (err) {
    console.warn('[api-balances] fetchAnthropicMonthSpend failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function fetchOpenAIMonthSpendUsd(monthStart: Date, monthEnd: Date): Promise<number | null> {
  const orgId = process.env.OPENAI_ORG_ID
  const adminKey = process.env.OPENAI_ADMIN_API_KEY ?? process.env.OPENAI_API_KEY
  if (!orgId || !adminKey) return null
  try {
    const start = Math.floor(monthStart.getTime() / 1000)
    const end = Math.floor(monthEnd.getTime() / 1000)
    const res = await fetch(
      `https://api.openai.com/v1/organization/costs?start_time=${start}&end_time=${end}`,
      { headers: { Authorization: `Bearer ${adminKey}`, 'OpenAI-Organization': orgId }, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) return null
    const data = await res.json() as { data?: Array<{ amount?: { value?: number } }> }
    return (data.data ?? []).reduce((s, b) => s + (b.amount?.value ?? 0), 0) / 100
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
  const apiKey = process.env.OPENROUTER_API_KEY
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

/** ElevenLabs subscription — character quota remaining (Starter plan). */
async function fetchElevenLabsBalanceUsd(): Promise<number | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) return null
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { character_count?: number; character_limit?: number }
    const limit = data.character_limit ?? 0
    const used = data.character_count ?? 0
    const remainingChars = Math.max(0, limit - used)
    return roundUsd((remainingChars / 1000) * 0.30)
  } catch (err) {
    console.warn('[api-balances] fetchElevenLabsBalance failed:', err instanceof Error ? err.message : err)
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
    .filter((r) => !r.free && r.balanceUsd != null && r.balanceUsd >= 0)
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

export async function refreshApiBalanceCache(): Promise<{
  cache: ApiBalanceCache
  twilioRaw?: { balance: string; currency: string } | null
  alerts: LowBalanceAlert[]
}> {
  const { todayStr, dayStart, dayEnd, monthStart, monthEnd } = dhakaSpendBounds()
  const [todayByProvider, monthByProvider] = await Promise.all([
    querySpendByProviderBetween(dayStart, dayEnd),
    querySpendByProviderBetween(monthStart, monthEnd),
  ])

  const [twilioLive, anthropicAdminMonth, openaiAdminMonth, openRouterLive, openRouterActivityMonth, elevenLabsLive, falLive] = await Promise.all([
    fetchTwilioBalance(),
    fetchAnthropicMonthSpendUsd(todayStr),
    fetchOpenAIMonthSpendUsd(monthStart, monthEnd),
    fetchOpenRouterCreditsUsd(),
    fetchOpenRouterActivityMonthUsd(todayStr),
    fetchElevenLabsBalanceUsd(),
    fetchFalBalanceUsd(),
  ])

  let twilioRaw: { balance: string; currency: string } | null = null
  if (twilioLive != null) {
    twilioRaw = { balance: String(twilioLive), currency: 'USD' }
  }

  const providers: BalanceProviderRow[] = []

  for (const id of TRACKED_COST_PROVIDERS) {
    const meta = PROVIDER_META[id]
    const credit = await getApiBalanceCredit(id)
    const todayUsd = roundUsd(todayByProvider[id] ?? 0)
    let monthUsd = roundUsd(monthByProvider[id] ?? 0)
    let balanceUsd: number | null = null
    let syncedThrough: string | null = null

    // ---- Live balance (account credit / quota remaining) ----
    if (id === 'twilio') {
      balanceUsd = twilioLive != null ? roundUsd(twilioLive) : null
    } else if (id === 'elevenlabs' && elevenLabsLive != null) {
      balanceUsd = elevenLabsLive
    } else if (id === 'openrouter' && openRouterLive != null) {
      balanceUsd = openRouterLive
    } else if (id === 'fal' && falLive != null) {
      balanceUsd = falLive
    }

    // ---- Authoritative month-to-date from each provider's billing API ----
    // These APIs lag ~1–2 days; syncedThrough tells the UI which day the figure is
    // current to. Floor at locally tracked spend so a stale/partial report can never
    // display LESS than what we already know we spent.
    if (id === 'anthropic' && anthropicAdminMonth != null) {
      monthUsd = roundUsd(Math.max(anthropicAdminMonth.usd, monthUsd))
      syncedThrough = anthropicAdminMonth.syncedThrough
    } else if (id === 'openai' && openaiAdminMonth != null) {
      monthUsd = roundUsd(Math.max(openaiAdminMonth, monthUsd))
    } else if (id === 'openrouter' && openRouterActivityMonth != null) {
      monthUsd = roundUsd(Math.max(openRouterActivityMonth.usd, monthUsd))
      syncedThrough = openRouterActivityMonth.syncedThrough
    }

    // OpenRouter balance is live from the credits API; fall back to KV-credit
    // tracking only if the live call returned null (key unset / API down).
    const openRouterLiveResolved = id === 'openrouter' && openRouterLive != null
    const falLiveResolved = id === 'fal' && falLive != null
    if (id !== 'twilio' && id !== 'elevenlabs' && !openRouterLiveResolved && !falLiveResolved && credit) {
      const since = new Date(credit.lastTopup)
      const spent = await querySpendSince(id, since)
      balanceUsd = roundUsd(credit.initialCredit - spent)
    }

    providers.push({
      id,
      label: meta.label,
      balanceUsd,
      todayUsd,
      monthUsd,
      source: meta.source,
      syncedThrough,
    })
  }

  providers.push({
    id: 'meta_free',
    label: PROVIDER_META.meta_free.label,
    balanceUsd: null,
    todayUsd: null,
    monthUsd: null,
    source: PROVIDER_META.meta_free.source,
    free: true,
  })

  const cache: ApiBalanceCache = {
    checkedAt: new Date().toISOString(),
    providers,
    summaryLine: buildBalanceSummaryLine(providers),
  }

  await storeBalanceCache(cache)

  const creditFlags: Partial<Record<BalanceProviderId, boolean>> = {}
  for (const id of ['anthropic', 'openai', 'gemini', 'google_tts', 'oxylabs', 'veo'] as BalanceProviderId[]) {
    creditFlags[id] = Boolean(await getApiBalanceCredit(id))
  }
  creditFlags.elevenlabs = Boolean(process.env.ELEVENLABS_API_KEY || (await getApiBalanceCredit('elevenlabs')))
  // OpenRouter low-balance alerting keys off the live credits API being available.
  creditFlags.openrouter = Boolean(process.env.OPENROUTER_API_KEY || (await getApiBalanceCredit('openrouter')))
  creditFlags.fal = Boolean(process.env.FAL_KEY || (await getApiBalanceCredit('fal')))

  const alerts = computeLowBalanceAlerts(providers, {
    anthropicAdmin: Boolean(process.env.ANTHROPIC_ADMIN_API_KEY),
    openaiAdmin: Boolean(process.env.OPENAI_ORG_ID && (process.env.OPENAI_ADMIN_API_KEY ?? process.env.OPENAI_API_KEY)),
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
    if (row.free || row.balanceUsd == null) continue

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
    const { dayStart, dayEnd, monthStart, monthEnd } = dhakaSpendBounds()
    // Refresh the OpenRouter live balance too (throttled) — the cached snapshot's
    // balance could be up to 6h stale behind its "Live API" label.
    const [todayByProvider, monthByProvider, freshOpenRouterBalance] = await Promise.all([
      querySpendByProviderBetween(dayStart, dayEnd),
      querySpendByProviderBetween(monthStart, monthEnd),
      getFreshOpenRouterBalanceUsd(),
    ])
    const providers = cache.providers.map((row) => {
      if (row.free) return row
      const liveToday = roundUsd(todayByProvider[row.id] ?? 0)
      const liveMonth = roundUsd(monthByProvider[row.id] ?? 0)
      // Preserve any admin-API floor already baked into the cached month figure
      // (e.g. Anthropic's authoritative month-to-date), but let local spend grow it.
      const monthUsd = row.monthUsd != null ? roundUsd(Math.max(row.monthUsd, liveMonth)) : liveMonth
      const balanceUsd = row.id === 'openrouter' && freshOpenRouterBalance != null
        ? roundUsd(freshOpenRouterBalance)
        : row.balanceUsd
      return { ...row, todayUsd: liveToday, monthUsd, balanceUsd }
    })
    return { ...cache, providers }
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
