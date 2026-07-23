import { createSign } from 'crypto'

export type ProviderSyncStatus = 'live' | 'partial' | 'manual' | 'unconfigured' | 'stale' | 'error' | 'free'
export type ProviderSourceType =
  | 'provider_api'
  | 'provider_export'
  | 'local_measured'
  | 'manual'
  | 'free'

export type ProviderFetchResult<T> = {
  configured: boolean
  ok: boolean
  fetchedAt: string
  value: T | null
  error: string | null
}

export type ProviderCostSnapshot = {
  todayUsd: number
  monthUsd: number
  syncedThrough: string | null
}

export type ProviderQuotaSnapshot = {
  used: number
  limit: number
  remaining: number
  unit: string
  plan: string | null
  resetAt: string | null
  subscription: number | null
  onDemand: number | null
  invoice: ProviderInvoiceSnapshot | null
}

export type ProviderInvoiceSnapshot = {
  kind: 'open' | 'next'
  amount: number
  currency: string
  dueAt: string | null
  status: string
}

export type SupabasePlanSnapshot = {
  plan: string
  organization: string | null
}

export type GoogleProviderCosts = {
  gemini: ProviderCostSnapshot
  google_tts: ProviderCostSnapshot
  veo: ProviderCostSnapshot
}

type ElevenLabsInvoice = {
  amount_due_cents?: number
  next_payment_attempt_unix?: number
  payment_intent_status?: string
}

type ElevenLabsSubscriptionResponse = {
  tier?: string
  character_count?: number
  character_limit?: number
  next_character_count_reset_unix?: number
  currency?: string | null
  has_open_invoices?: boolean
  open_invoices?: ElevenLabsInvoice[]
  next_invoice?: ElevenLabsInvoice | null
}

type VercelFocusCharge = {
  BilledCost?: number | string
  EffectiveCost?: number | string
  BillingCurrency?: string
  ChargePeriodStart?: string
}

type BigQueryField = { name?: string }
type BigQueryRow = { f?: Array<{ v?: unknown }> }

function nowIso(): string {
  return new Date().toISOString()
}

function unconfigured<T>(): ProviderFetchResult<T> {
  return { configured: false, ok: false, fetchedAt: nowIso(), value: null, error: null }
}

function failed<T>(message: string): ProviderFetchResult<T> {
  return { configured: true, ok: false, fetchedAt: nowIso(), value: null, error: message }
}

function succeeded<T>(value: T): ProviderFetchResult<T> {
  return { configured: true, ok: true, fetchedAt: nowIso(), value, error: null }
}

export function roundProviderUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function parseVercelFocusCharges(raw: string, todayYmd: string): ProviderCostSnapshot {
  const trimmed = raw.trim()
  if (!trimmed) return { todayUsd: 0, monthUsd: 0, syncedThrough: null }

  let rows: VercelFocusCharge[] = []
  try {
    const parsed = JSON.parse(trimmed) as VercelFocusCharge | VercelFocusCharge[]
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    rows = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as VercelFocusCharge]
        } catch {
          return []
        }
      })
  }

  let todayUsd = 0
  let monthUsd = 0
  let syncedThrough: string | null = null
  for (const row of rows) {
    const currency = (row.BillingCurrency ?? 'USD').toUpperCase()
    if (currency !== 'USD') {
      throw new Error(`Vercel billing currency ${currency} is not supported as USD`)
    }
    const amount = Number(row.BilledCost ?? row.EffectiveCost ?? 0)
    if (!Number.isFinite(amount)) continue
    monthUsd += amount
    const day = row.ChargePeriodStart?.slice(0, 10) ?? null
    if (day === todayYmd) todayUsd += amount
    if (day && (syncedThrough == null || day > syncedThrough)) syncedThrough = day
  }
  return {
    todayUsd: roundProviderUsd(todayUsd),
    monthUsd: roundProviderUsd(monthUsd),
    syncedThrough,
  }
}

export async function fetchVercelBillingCosts(
  monthStart: Date,
  now = new Date(),
  todayYmd: string,
): Promise<ProviderFetchResult<ProviderCostSnapshot>> {
  const token = (process.env.VERCEL_BILLING_TOKEN ?? process.env.VERCEL_TOKEN)?.trim()
  const teamId = (process.env.VERCEL_BILLING_TEAM_ID ?? process.env.VERCEL_ORG_ID)?.trim()
  const teamSlug = process.env.VERCEL_BILLING_TEAM_SLUG?.trim()
  if (!token || (!teamId && !teamSlug)) return unconfigured()

  try {
    const url = new URL('https://api.vercel.com/v1/billing/charges')
    url.searchParams.set('from', monthStart.toISOString())
    url.searchParams.set('to', new Date(now.getTime() + 1_000).toISOString())
    if (teamId) url.searchParams.set('teamId', teamId)
    else if (teamSlug) url.searchParams.set('slug', teamSlug)

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) return failed(`Vercel billing HTTP ${response.status}`)
    return succeeded(parseVercelFocusCharges(await response.text(), todayYmd))
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'Vercel billing request failed')
  }
}

export async function fetchSupabaseOrganizationPlan(): Promise<ProviderFetchResult<SupabasePlanSnapshot>> {
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN?.trim()
  const slug = process.env.SUPABASE_ORGANIZATION_SLUG?.trim()
  if (!token || !slug) return unconfigured()

  try {
    const response = await fetch(`https://api.supabase.com/v1/organizations/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return failed(`Supabase Management API HTTP ${response.status}`)
    const data = await response.json() as { plan?: string; name?: string }
    if (!data.plan) return failed('Supabase organization response did not include a plan')
    return succeeded({ plan: data.plan, organization: data.name ?? null })
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'Supabase Management API request failed')
  }
}

export function parseElevenLabsSubscription(data: ElevenLabsSubscriptionResponse): ProviderQuotaSnapshot {
  const used = Number(data.character_count ?? 0)
  const limit = Number(data.character_limit ?? 0)
  const openInvoice = data.has_open_invoices ? data.open_invoices?.[0] : null
  const rawInvoice = openInvoice ?? data.next_invoice ?? null
  const invoiceKind: ProviderInvoiceSnapshot['kind'] = openInvoice ? 'open' : 'next'
  const amountCents = Number(rawInvoice?.amount_due_cents ?? 0)
  const invoice = rawInvoice && Number.isFinite(amountCents)
    ? {
        kind: invoiceKind,
        amount: roundProviderUsd(amountCents / 100),
        currency: (data.currency ?? 'usd').toUpperCase(),
        dueAt: rawInvoice.next_payment_attempt_unix
          ? new Date(rawInvoice.next_payment_attempt_unix * 1_000).toISOString()
          : null,
        status: rawInvoice.payment_intent_status ?? invoiceKind,
      }
    : null
  return {
    used: Number.isFinite(used) ? used : 0,
    limit: Number.isFinite(limit) ? limit : 0,
    remaining: Math.max(0, (Number.isFinite(limit) ? limit : 0) - (Number.isFinite(used) ? used : 0)),
    unit: 'characters',
    plan: data.tier ?? null,
    resetAt: data.next_character_count_reset_unix
      ? new Date(data.next_character_count_reset_unix * 1_000).toISOString()
      : null,
    subscription: null,
    onDemand: null,
    invoice,
  }
}

export async function fetchElevenLabsQuota(): Promise<ProviderFetchResult<ProviderQuotaSnapshot>> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim()
  if (!apiKey) return unconfigured()
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return failed(`ElevenLabs subscription HTTP ${response.status}`)
    return succeeded(parseElevenLabsSubscription(await response.json() as ElevenLabsSubscriptionResponse))
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'ElevenLabs subscription request failed')
  }
}

export async function fetchFashnQuota(): Promise<ProviderFetchResult<ProviderQuotaSnapshot>> {
  const apiKey = process.env.FASHN_API_KEY?.trim()
  if (!apiKey) return unconfigured()
  try {
    const response = await fetch('https://api.fashn.ai/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return failed(`FASHN credits HTTP ${response.status}`)
    const data = await response.json() as {
      credits?: number | { total?: number; subscription?: number; on_demand?: number }
    }
    const total = typeof data.credits === 'number' ? data.credits : Number(data.credits?.total ?? 0)
    const subscription = typeof data.credits === 'object' ? Number(data.credits?.subscription ?? 0) : null
    const onDemand = typeof data.credits === 'object' ? Number(data.credits?.on_demand ?? 0) : null
    if (!Number.isFinite(total)) return failed('FASHN credits response was invalid')
    return succeeded({
      used: 0,
      limit: total,
      remaining: total,
      unit: 'credits',
      plan: null,
      resetAt: null,
      subscription: subscription != null && Number.isFinite(subscription) ? subscription : null,
      onDemand: onDemand != null && Number.isFinite(onDemand) ? onDemand : null,
      invoice: null,
    })
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'FASHN credits request failed')
  }
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function getGoogleServiceAccountToken(): Promise<string> {
  const raw = process.env.GOOGLE_BILLING_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('Google billing service account is not configured')
  const credentials = JSON.parse(raw) as {
    client_email?: string
    private_key?: string
    token_uri?: string
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google billing service account JSON is incomplete')
  }

  const issuedAt = Math.floor(Date.now() / 1_000)
  const tokenUri = credentials.token_uri ?? 'https://oauth2.googleapis.com/token'
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3_000,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  signer.end()
  const signature = signer.sign(credentials.private_key, 'base64url')
  const assertion = `${header}.${claim}.${signature}`

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Google OAuth HTTP ${response.status}`)
  const data = await response.json() as { access_token?: string }
  if (!data.access_token) throw new Error('Google OAuth response did not include an access token')
  return data.access_token
}

function classifyGoogleCost(service: string, sku: string): keyof GoogleProviderCosts | null {
  const value = `${service} ${sku}`.toLowerCase()
  if (/\bveo\b|video generation/.test(value)) return 'veo'
  if (/text.to.speech|cloud tts|speech synthesis/.test(value)) return 'google_tts'
  if (/gemini|generative language|vertex ai/.test(value)) return 'gemini'
  return null
}

export function parseGoogleBillingRows(
  fields: BigQueryField[],
  rows: BigQueryRow[],
  todayYmd: string,
): GoogleProviderCosts {
  const empty = (): ProviderCostSnapshot => ({ todayUsd: 0, monthUsd: 0, syncedThrough: null })
  const result: GoogleProviderCosts = {
    gemini: empty(),
    google_tts: empty(),
    veo: empty(),
  }
  const names = fields.map((field) => field.name ?? '')

  for (const row of rows) {
    const record: Record<string, unknown> = {}
    for (let index = 0; index < names.length; index++) {
      record[names[index]] = row.f?.[index]?.v
    }
    const provider = classifyGoogleCost(String(record.service ?? ''), String(record.sku ?? ''))
    if (!provider) continue
    const cost = Number(record.cost_usd ?? 0)
    if (!Number.isFinite(cost)) continue
    const currency = String(record.currency ?? 'USD').toUpperCase()
    if (currency !== 'USD') {
      throw new Error(`Google billing currency ${currency} is not supported as USD`)
    }
    const usageDate = String(record.usage_date ?? '').slice(0, 10)
    result[provider].monthUsd += cost
    if (usageDate === todayYmd) result[provider].todayUsd += cost
    if (usageDate && (
      result[provider].syncedThrough == null
      || usageDate > (result[provider].syncedThrough as string)
    )) {
      result[provider].syncedThrough = usageDate
    }
  }

  for (const provider of Object.keys(result) as Array<keyof GoogleProviderCosts>) {
    result[provider].todayUsd = roundProviderUsd(result[provider].todayUsd)
    result[provider].monthUsd = roundProviderUsd(result[provider].monthUsd)
  }
  return result
}

export async function fetchGoogleCloudBillingCosts(
  monthStart: Date,
  todayYmd: string,
): Promise<ProviderFetchResult<GoogleProviderCosts>> {
  const table = process.env.GOOGLE_BILLING_EXPORT_TABLE?.trim()
  const billingProject = process.env.GOOGLE_BILLING_QUERY_PROJECT_ID?.trim()
  const credentials = process.env.GOOGLE_BILLING_SERVICE_ACCOUNT_JSON?.trim()
  if (!table || !billingProject || !credentials) return unconfigured()
  if (!/^[A-Za-z0-9_.:-]+$/.test(table) || table.split('.').length !== 3) {
    return failed('GOOGLE_BILLING_EXPORT_TABLE must be project.dataset.table')
  }

  try {
    const token = await getGoogleServiceAccountToken()
    const query = `
      SELECT
        service.description AS service,
        sku.description AS sku,
        currency,
        FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Dhaka')) AS usage_date,
        SUM(cost + IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0)) AS cost_usd
      FROM \`${table}\`
      WHERE usage_start_time >= @month_start
        AND usage_start_time < CURRENT_TIMESTAMP()
      GROUP BY service, sku, currency, usage_date
    `
    const response = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(billingProject)}/queries`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          useLegacySql: false,
          timeoutMs: 20_000,
          parameterMode: 'NAMED',
          queryParameters: [{
            name: 'month_start',
            parameterType: { type: 'TIMESTAMP' },
            parameterValue: { value: monthStart.toISOString() },
          }],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok) return failed(`Google BigQuery HTTP ${response.status}`)
    const data = await response.json() as {
      jobComplete?: boolean
      errors?: Array<{ message?: string }>
      schema?: { fields?: BigQueryField[] }
      rows?: BigQueryRow[]
    }
    if (data.errors?.length) return failed(data.errors.map((item) => item.message).filter(Boolean).join('; '))
    if (data.jobComplete === false) return failed('Google billing query did not complete within the timeout')
    return succeeded(parseGoogleBillingRows(data.schema?.fields ?? [], data.rows ?? [], todayYmd))
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'Google Cloud Billing request failed')
  }
}
