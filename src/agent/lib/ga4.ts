/**
 * Google Analytics 4 (GA4) Data API — read-only traffic / conversion / revenue
 * data (Growth Feature 5). Reuses the SAME Google OAuth the owner authorizes for
 * Search Console (Feature 1); the consent now also requests `analytics.readonly`
 * (see GA4_SCOPE in gsc.ts). No `googleapis` SDK — we hit the REST endpoint with
 * a freshly-minted access token, mirroring the GSC helper style.
 *
 * Everything here is READ-ONLY, so tools built on it need no approval card.
 */
import { getConnectedGoogleAccessToken, isGscConnected } from '@/agent/lib/gsc'

const GA4_DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta'

export const GA4_NOT_CONNECTED = {
  success: false as const,
  error:
    'Google Analytics যুক্ত করা নেই। ALMA Agent → সাইডবারে 🔍 (Growth) পেজ থেকে "Google Search Console যুক্ত করুন"-এ ' +
    'ক্লিক করে owner একবার connect করলে (Analytics permission-সহ) real GA4 data আসবে।',
}

export const GA4_NO_PROPERTY = {
  success: false as const,
  error:
    'GA4_PROPERTY_ID সেট করা নেই। GA4 property-র numeric ID (Admin → Property Settings) env-এ GA4_PROPERTY_ID হিসেবে দিন।',
}

/** Owner re-consent needed: token predates the analytics.readonly scope. */
export const GA4_SCOPE_MISSING = {
  success: false as const,
  error:
    'Google connection-এ Analytics permission নেই (Search Console-এর আগে connect করা হয়েছিল)। Growth পেজ থেকে ' +
    'আবার "connect" করলে Analytics access যুক্ত হবে — GSC ঠিকঠাক চলতে থাকবে।',
}

export function resolveGa4PropertyId(explicit?: string): string | null {
  const raw = (explicit ?? process.env.GA4_PROPERTY_ID ?? '').trim()
  // Accept "properties/123", "123", or "G-..."→invalid (that's a measurement id).
  const m = raw.match(/(\d{6,})/)
  return m ? m[1] : null
}

/** True when a GA4 property id is configured AND Google is connected. */
export async function isGa4Configured(): Promise<boolean> {
  if (!resolveGa4PropertyId()) return false
  return isGscConnected()
}

export type Ga4Row = { dimensions: string[]; metrics: number[] }
export type Ga4ReportResult =
  | { ok: true; rows: Ga4Row[]; metricHeaders: string[]; dimensionHeaders: string[] }
  | { ok: false; kind: 'not_connected' | 'no_property' | 'scope_missing' | 'error'; error: string }

/**
 * Run a GA4 report. Never throws — returns a tagged result the tool layer maps
 * to friendly Bangla. Metrics are returned as numbers (GA4 sends strings).
 */
export async function runGa4Report(params: {
  startDate: string
  endDate: string
  dimensions: string[]
  metrics: string[]
  limit?: number
  propertyId?: string
}): Promise<Ga4ReportResult> {
  const propertyId = resolveGa4PropertyId(params.propertyId)
  if (!propertyId) return { ok: false, kind: 'no_property', error: GA4_NO_PROPERTY.error }

  let accessToken: string
  try {
    accessToken = await getConnectedGoogleAccessToken()
  } catch {
    return { ok: false, kind: 'not_connected', error: GA4_NOT_CONNECTED.error }
  }

  const body = {
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    dimensions: params.dimensions.map((name) => ({ name })),
    metrics: params.metrics.map((name) => ({ name })),
    limit: String(Math.min(Math.max(params.limit ?? 20, 1), 100)),
  }

  let res: Response
  try {
    res = await fetch(`${GA4_DATA_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    return { ok: false, kind: 'error', error: `GA4 request failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // A GSC-only token lacks the analytics scope → 403 PERMISSION_DENIED /
    // ACCESS_TOKEN_SCOPE_INSUFFICIENT. Steer the owner to re-consent.
    if (res.status === 403 && /scope|insufficient|permission/i.test(text)) {
      return { ok: false, kind: 'scope_missing', error: GA4_SCOPE_MISSING.error }
    }
    return { ok: false, kind: 'error', error: `GA4 ${res.status}: ${text.slice(0, 300)}` }
  }

  const data = (await res.json()) as {
    rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>
    metricHeaders?: Array<{ name?: string }>
    dimensionHeaders?: Array<{ name?: string }>
  }

  const rows: Ga4Row[] = (data.rows ?? []).map((r) => ({
    dimensions: (r.dimensionValues ?? []).map((d) => d.value ?? ''),
    metrics: (r.metricValues ?? []).map((m) => Number(m.value ?? 0)),
  }))

  return {
    ok: true,
    rows,
    metricHeaders: (data.metricHeaders ?? []).map((h) => h.name ?? ''),
    dimensionHeaders: (data.dimensionHeaders ?? []).map((h) => h.name ?? ''),
  }
}

/**
 * Phase 43 — per-event counts for reconciliation (event ledger vs GA4).
 * Returns null when GA4 is unreadable; never throws.
 */
export async function fetchGa4EventCounts(
  eventNames: string[],
  days: number,
): Promise<Record<string, number> | null> {
  const res = await runGa4Report({
    startDate: `${Math.min(Math.max(days, 1), 90)}daysAgo`,
    endDate: 'today',
    dimensions: ['eventName'],
    metrics: ['eventCount'],
    limit: 100,
  }).catch(() => null)
  if (!res || !res.ok) return null
  const wanted = new Set(eventNames)
  const out: Record<string, number> = {}
  for (const row of res.rows) {
    const name = row.dimensions[0]
    if (wanted.size === 0 || wanted.has(name)) out[name] = (out[name] ?? 0) + (row.metrics[0] ?? 0)
  }
  return out
}
