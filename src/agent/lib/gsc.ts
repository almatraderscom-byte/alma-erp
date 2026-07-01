/**
 * Google Search Console access — OAuth on the OWNER's own account.
 *
 * Mirrors the Google Drive integration (src/agent/lib/drive.ts): the owner
 * connects once via the gsc-auth routes, and the refresh token is stored in
 * agent_kv_settings under `gsc_oauth`. Everything here is READ-ONLY — scope
 * `webmasters.readonly`. No writes, so the tools that use this need no approval
 * card.
 *
 * Client creds: prefers a dedicated GSC OAuth client (GSC_CLIENT_ID/SECRET) but
 * falls back to the existing Drive OAuth client (GOOGLE_DRIVE_CLIENT_ID/SECRET)
 * so the owner can reuse one GCP OAuth client for all Google read integrations.
 */
import { prisma } from '@/lib/prisma'

export const GSC_OAUTH_KEY = 'gsc_oauth'
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3'
const URL_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'

type GscConnection = { refresh_token: string; email?: string; connected_at?: string }

export function getGscClientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GSC_CLIENT_ID || process.env.GOOGLE_DRIVE_CLIENT_ID || ''
  const clientSecret = process.env.GSC_CLIENT_SECRET || process.env.GOOGLE_DRIVE_CLIENT_SECRET || ''
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** The registered OAuth redirect URI — must match the GCP OAuth client exactly. */
export function getGscRedirectUri(): string {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? '').replace(/\/$/, '')
  return `${base}/api/assistant/growth/gsc-auth/callback`
}

export async function getGscConnection(): Promise<GscConnection | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentKvSetting.findUnique({
    where: { key: GSC_OAUTH_KEY },
    select: { value: true },
  })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as GscConnection
    return parsed?.refresh_token ? parsed : null
  } catch {
    return null
  }
}

export async function saveGscConnection(conn: GscConnection): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const value = JSON.stringify(conn)
  await db.agentKvSetting.upsert({
    where: { key: GSC_OAUTH_KEY },
    create: { key: GSC_OAUTH_KEY, value },
    update: { value },
  })
}

export async function clearGscConnection(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  await db.agentKvSetting.deleteMany({ where: { key: GSC_OAUTH_KEY } })
}

/** True when client creds AND a stored refresh token are both present. */
export async function isGscConnected(): Promise<boolean> {
  if (!getGscClientCreds()) return false
  return Boolean(await getGscConnection())
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const creds = getGscClientCreds()
  if (!creds) throw new Error('GSC/Google OAuth client creds not set')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GSC token refresh failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('GSC token refresh returned no access_token')
  return data.access_token
}

/** Exchange an OAuth authorization code for tokens (callback route). */
export async function exchangeCodeForTokens(code: string): Promise<GscConnection> {
  const creds = getGscClientCreds()
  if (!creds) throw new Error('GSC/Google OAuth client creds not set')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: getGscRedirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GSC code exchange failed: ${await res.text()}`)
  const data = (await res.json()) as { refresh_token?: string; access_token?: string }
  if (!data.refresh_token) {
    throw new Error('No refresh_token returned — re-consent with prompt=consent + access_type=offline')
  }

  let email = ''
  try {
    if (data.access_token) {
      const me = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${data.access_token}` },
        signal: AbortSignal.timeout(8_000),
      })
      if (me.ok) email = ((await me.json()) as { email?: string }).email ?? ''
    }
  } catch {
    // ignore — email is cosmetic
  }

  return { refresh_token: data.refresh_token, email, connected_at: new Date().toISOString() }
}

async function gscFetch(path: string, init: RequestInit): Promise<Response> {
  const conn = await getGscConnection()
  if (!conn) throw new Error('not_connected')
  const accessToken = await getAccessToken(conn.refresh_token)
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })
}

export type GscSite = { siteUrl: string; permissionLevel: string }

/** All Search Console properties the connected account can access. */
export async function listSites(): Promise<GscSite[]> {
  const res = await gscFetch(`${WEBMASTERS_BASE}/sites`, { method: 'GET' })
  if (!res.ok) throw new Error(`listSites failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { siteEntry?: GscSite[] }
  return data.siteEntry ?? []
}

/**
 * Resolve which GSC property to query for almatraders.com.
 * Priority: explicit arg → GSC_SITE_URL env → auto-pick from listSites()
 * (prefers a `sc-domain:` domain property matching almatraders).
 */
export async function resolveSiteUrl(explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) return explicit.trim()
  const envSite = (process.env.GSC_SITE_URL ?? '').trim()
  if (envSite) return envSite
  const sites = await listSites()
  const alma = sites.filter((s) => s.siteUrl.toLowerCase().includes('almatraders'))
  const domainProp = alma.find((s) => s.siteUrl.startsWith('sc-domain:'))
  const pick = domainProp ?? alma[0] ?? sites[0]
  if (!pick) throw new Error('no_sites — এই Google account-এ কোনো Search Console property নেই।')
  return pick.siteUrl
}

export type SearchAnalyticsRow = {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export async function searchAnalyticsQuery(params: {
  siteUrl: string
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
}): Promise<{ rows: SearchAnalyticsRow[] }> {
  const { siteUrl, startDate, endDate, dimensions, rowLimit } = params
  const res = await gscFetch(
    `${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: dimensions ?? [],
        rowLimit: rowLimit ?? 25,
      }),
    },
  )
  if (!res.ok) throw new Error(`searchAnalytics failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { rows?: SearchAnalyticsRow[] }
  return { rows: data.rows ?? [] }
}

export type SitemapEntry = {
  path?: string
  lastSubmitted?: string
  lastDownloaded?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  warnings?: string
  errors?: string
  contents?: Array<{ type?: string; submitted?: string; indexed?: string }>
}

export async function listSitemaps(siteUrl: string): Promise<SitemapEntry[]> {
  const res = await gscFetch(`${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
    method: 'GET',
  })
  if (!res.ok) throw new Error(`listSitemaps failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { sitemap?: SitemapEntry[] }
  return data.sitemap ?? []
}

export type UrlInspection = {
  verdict?: string
  coverageState?: string
  robotsTxtState?: string
  indexingState?: string
  lastCrawlTime?: string
  pageFetchState?: string
  googleCanonical?: string
  userCanonical?: string
}

export async function inspectUrl(siteUrl: string, inspectionUrl: string): Promise<UrlInspection> {
  const res = await gscFetch(URL_INSPECTION_URL, {
    method: 'POST',
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'en-US' }),
  })
  if (!res.ok) throw new Error(`inspectUrl failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as {
    inspectionResult?: { indexStatusResult?: UrlInspection }
  }
  return data.inspectionResult?.indexStatusResult ?? {}
}
