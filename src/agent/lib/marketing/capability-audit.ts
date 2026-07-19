/**
 * Phase 41 — read-only marketing capability audit.
 *
 * Answers one question honestly: what can ALMA actually reach right now, with
 * which account/asset scope, and is the data decision-grade? Every capability
 * is PROVEN by a live read-only probe or marked unknown/broken/unsupported —
 * the mere presence of an env variable never yields a green status.
 *
 * No writes to any external platform happen here. Ever.
 */
import { isGscConnected, listSites } from '@/agent/lib/gsc'
import { isGa4Configured, resolveGa4PropertyId, runGa4Report } from '@/agent/lib/ga4'
import { metaGraphBase } from '@/lib/meta-version'

const GRAPH_BASE = metaGraphBase()

export type CapabilityStatus =
  | 'read' // proven readable right now
  | 'draft' // proven: agent can prepare a draft locally (no external write)
  | 'stage' // proven read + an existing approval-card write path (write not exercised)
  | 'write-confirmed' // a real approved write was verified end-to-end (never set by this audit)
  | 'unsupported' // not configured / no integration
  | 'broken' // configured but the live probe failed
  | 'unknown' // configured but not probed (e.g. probe skipped/timeout)

export interface CapabilityCheck {
  key: string
  area: 'meta' | 'google' | 'website' | 'messaging' | 'erp'
  label: string
  status: CapabilityStatus
  /** Exact account/asset/domain scope the status applies to. */
  scope: string
  /** How the status was proven — human-readable, secrets redacted. */
  evidence: string
  error?: string
}

export interface CapabilityMatrix {
  checkedAt: string
  checks: CapabilityCheck[]
  summary: {
    total: number
    proven: number
    broken: number
    unknown: number
    unsupported: number
  }
  /** Files that hard-code the Meta Graph API version (migration must be centralized, not blind-bumped). */
  metaVersionCallSites: string[]
}

/**
 * The single honest status rule. Env presence alone NEVER yields a proven
 * status: configured-but-unprobed is 'unknown', configured-but-failing is
 * 'broken'. Only a successful live probe grants the proven level.
 */
export function deriveStatus(input: {
  configured: boolean
  probeRan: boolean
  probeOk: boolean
  provenLevel?: 'read' | 'draft' | 'stage'
}): CapabilityStatus {
  if (!input.configured) return 'unsupported'
  if (!input.probeRan) return 'unknown'
  if (!input.probeOk) return 'broken'
  return input.provenLevel ?? 'read'
}

/** Mask anything that looks like a token/key/secret; keeps last 4 chars for identification. */
export function redactSecrets(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{20,}/g, (m) => `…${m.slice(-4)}`)
}

/**
 * Central list of files that hard-code the Meta Graph API version today.
 * Source of truth for the Phase 45 versioned-client migration — check the
 * then-current Meta changelog before bumping; never blind-bump.
 */
export const META_VERSION_CALL_SITES: readonly string[] = [
  'src/agent/lib/meta.ts',
  'src/agent/lib/meta-ads.ts',
  'src/agent/lib/meta-audiences.ts',
  'src/agent/lib/meta-ad-library.ts',
  'src/agent/lib/meta-instagram.ts',
  'src/agent/lib/ads/insights.ts',
  'src/agent/lib/cs/messenger-ingest.ts',
  'src/agent/lib/cs/meta-messenger.ts',
  'src/agent/lib/wa/cloud-api.ts',
  'src/agent/lib/owner-briefing-data.ts',
  'src/lib/financial-intelligence.ts',
  'src/lib/weekly-strategic-data.ts',
  'src/app/api/assistant/internal/fb-token-health/route.ts',
  'worker/src/ads/monitor.mjs',
  'worker/src/cs/meta-send.mjs',
  'worker/src/cs/token-health.mjs',
  'worker/src/cs/messenger-poll.mjs',
  'worker/src/messenger/scan.mjs',
  'worker/src/staff/verify-task.mjs',
  'worker/src/wa/wa-template.mjs',
  'worker/src/wa/wa-send.mjs',
  'worker/scripts/check-fb-token.mjs',
  'worker/scripts/setup-meta-webhook.mjs',
]

const FB_PAGES = [
  { key: 'fb_page_lifestyle', label: 'Facebook Page — Alma Lifestyle', envKey: 'FB_PAGE_TOKEN_LIFESTYLE', pageId: '1044848232034171' },
  { key: 'fb_page_onlineshop', label: 'Facebook Page — Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP', pageId: '827260860637393' },
] as const

async function probeJson(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; body: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const err = (body as { error?: { message?: string } }).error
    if (!res.ok || err) {
      return { ok: false, body, error: err?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, body }
  } catch (err) {
    return { ok: false, body: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

async function checkFbPage(page: (typeof FB_PAGES)[number]): Promise<CapabilityCheck> {
  const token = process.env[page.envKey]?.trim()
  if (!token) {
    return {
      key: page.key,
      area: 'meta',
      label: page.label,
      status: deriveStatus({ configured: false, probeRan: false, probeOk: false }),
      scope: `page ${page.pageId}`,
      evidence: `${page.envKey} not set`,
    }
  }
  const probe = await probeJson(
    `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
  )
  const data = (probe.body as { data?: { is_valid?: boolean; type?: string; expires_at?: number } }).data
  const valid = probe.ok && data?.is_valid === true
  return {
    key: page.key,
    area: 'meta',
    label: page.label,
    // Page posting has an existing approval-card write path; a valid token proves 'stage'.
    status: deriveStatus({ configured: true, probeRan: true, probeOk: valid, provenLevel: 'stage' }),
    scope: `page ${page.pageId}`,
    evidence: valid
      ? `debug_token valid (type=${data?.type ?? 'unknown'}, expires=${data?.expires_at ? new Date(data.expires_at * 1000).toISOString() : 'never'}); posts go through approval cards`
      : 'debug_token probe failed',
    error: valid ? undefined : redactSecrets(probe.error ?? 'invalid token'),
  }
}

async function checkAdAccount(): Promise<CapabilityCheck> {
  const token = process.env.META_ADS_TOKEN?.trim()
  const accountId = process.env.META_AD_ACCOUNT_ID?.trim()
  const configured = Boolean(token && accountId)
  if (!configured) {
    return {
      key: 'meta_ad_account',
      area: 'meta',
      label: 'Meta Ad Account',
      status: 'unsupported',
      scope: accountId ? `act_${accountId}` : 'no ad account id',
      evidence: `${token ? '' : 'META_ADS_TOKEN not set. '}${accountId ? '' : 'META_AD_ACCOUNT_ID not set.'}`.trim(),
    }
  }
  const id = accountId!.startsWith('act_') ? accountId! : `act_${accountId}`
  const probe = await probeJson(`${GRAPH_BASE}/${id}?fields=name,account_status,currency&access_token=${encodeURIComponent(token!)}`)
  const name = (probe.body as { name?: string }).name
  const currency = (probe.body as { currency?: string }).currency
  return {
    key: 'meta_ad_account',
    area: 'meta',
    label: 'Meta Ad Account',
    // Campaign writes exist but create PAUSED campaigns behind approval cards → proven level is 'stage'.
    status: deriveStatus({ configured: true, probeRan: true, probeOk: probe.ok, provenLevel: 'stage' }),
    scope: id,
    evidence: probe.ok
      ? `account "${name ?? 'unnamed'}" readable, currency=${currency ?? 'unknown'}; campaign writes are approval-carded and created paused`
      : 'account read probe failed',
    error: probe.ok ? undefined : redactSecrets(probe.error ?? 'probe failed'),
  }
}

async function checkPixel(): Promise<CapabilityCheck> {
  const token = process.env.META_ADS_TOKEN?.trim()
  const pixelId = (process.env.META_PIXEL_ID ?? process.env.FB_PIXEL_ID ?? '').trim()
  if (!pixelId || !token) {
    return {
      key: 'meta_pixel',
      area: 'meta',
      label: 'Meta Pixel / Dataset',
      status: 'unsupported',
      scope: pixelId ? `pixel ${pixelId}` : 'no pixel id',
      evidence: pixelId ? 'META_ADS_TOKEN not set' : 'META_PIXEL_ID / FB_PIXEL_ID not set — Conversions API pipeline is Phase 43 work',
    }
  }
  const probe = await probeJson(`${GRAPH_BASE}/${pixelId}?fields=name,is_unavailable&access_token=${encodeURIComponent(token)}`)
  return {
    key: 'meta_pixel',
    area: 'meta',
    label: 'Meta Pixel / Dataset',
    status: deriveStatus({ configured: true, probeRan: true, probeOk: probe.ok }),
    scope: `pixel ${pixelId}`,
    evidence: probe.ok ? `pixel "${(probe.body as { name?: string }).name ?? 'unnamed'}" readable` : 'pixel read probe failed',
    error: probe.ok ? undefined : redactSecrets(probe.error ?? 'probe failed'),
  }
}

async function checkInstagram(): Promise<CapabilityCheck> {
  // IG publishing rides the Lifestyle page token (meta-instagram.ts); current path is single-image only.
  const token = process.env.FB_PAGE_TOKEN_LIFESTYLE?.trim()
  if (!token) {
    return {
      key: 'instagram_account',
      area: 'meta',
      label: 'Instagram Professional Account',
      status: 'unsupported',
      scope: 'via Lifestyle page',
      evidence: 'FB_PAGE_TOKEN_LIFESTYLE not set',
    }
  }
  const probe = await probeJson(
    `${GRAPH_BASE}/1044848232034171?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`,
  )
  const ig = (probe.body as { instagram_business_account?: { id?: string; username?: string } }).instagram_business_account
  const linked = probe.ok && Boolean(ig?.id)
  return {
    key: 'instagram_account',
    area: 'meta',
    label: 'Instagram Professional Account',
    status: deriveStatus({ configured: true, probeRan: true, probeOk: linked, provenLevel: 'stage' }),
    scope: ig?.id ? `ig ${ig.id} (@${ig.username ?? '?'})` : 'not linked',
    evidence: linked
      ? `linked to Lifestyle page; publish path today is single-image only (Reels/video unsupported until Phase 46)`
      : probe.ok
        ? 'page readable but no instagram_business_account linked'
        : 'probe failed',
    error: linked ? undefined : redactSecrets(probe.error ?? (probe.ok ? 'no IG account linked' : 'probe failed')),
  }
}

async function checkGsc(): Promise<CapabilityCheck> {
  const connected = await isGscConnected().catch(() => false)
  if (!connected) {
    return {
      key: 'google_search_console',
      area: 'google',
      label: 'Google Search Console',
      status: 'unsupported',
      scope: 'no Google connection',
      evidence: 'Google OAuth not connected (Growth page → connect)',
    }
  }
  try {
    const sites = await listSites()
    return {
      key: 'google_search_console',
      area: 'google',
      label: 'Google Search Console',
      status: deriveStatus({ configured: true, probeRan: true, probeOk: sites.length > 0 }),
      scope: sites.map((s) => s.siteUrl).join(', ') || 'no properties',
      evidence: sites.length > 0 ? `${sites.length} propert${sites.length === 1 ? 'y' : 'ies'} listed via Search Console API` : 'connected but zero properties returned',
      error: sites.length > 0 ? undefined : 'no GSC properties on this Google account',
    }
  } catch (err) {
    return {
      key: 'google_search_console',
      area: 'google',
      label: 'Google Search Console',
      status: 'broken',
      scope: 'connected account',
      evidence: 'listSites probe failed',
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    }
  }
}

async function checkGa4(): Promise<CapabilityCheck> {
  const propertyId = resolveGa4PropertyId()
  const configured = await isGa4Configured().catch(() => false)
  if (!configured) {
    return {
      key: 'ga4',
      area: 'google',
      label: 'Google Analytics 4',
      status: 'unsupported',
      scope: propertyId ? `property ${propertyId}` : 'no GA4_PROPERTY_ID',
      evidence: propertyId ? 'Google OAuth not connected' : 'GA4_PROPERTY_ID not set',
    }
  }
  const probe = await runGa4Report({
    startDate: '7daysAgo',
    endDate: 'today',
    dimensions: ['date'],
    metrics: ['sessions', 'keyEvents'],
    limit: 7,
  })
  if (!probe.ok) {
    return {
      key: 'ga4',
      area: 'google',
      label: 'Google Analytics 4',
      status: probe.kind === 'scope_missing' ? 'broken' : 'broken',
      scope: `property ${propertyId}`,
      evidence: `runReport probe failed (${probe.kind})`,
      error: redactSecrets(probe.error),
    }
  }
  const sessions = probe.rows.reduce((s, r) => s + (r.metrics[0] ?? 0), 0)
  const keyEvents = probe.rows.reduce((s, r) => s + (r.metrics[1] ?? 0), 0)
  return {
    key: 'ga4',
    area: 'google',
    label: 'Google Analytics 4',
    status: 'read',
    scope: `property ${propertyId}`,
    evidence: `7-day probe: ${sessions} sessions, ${keyEvents} key events`,
  }
}

function checkWhatsApp(): CapabilityCheck {
  const configured = Boolean(process.env.WA_PHONE_ID?.trim() && process.env.WA_TOKEN?.trim())
  return {
    key: 'whatsapp_cloud',
    area: 'messaging',
    label: 'WhatsApp Cloud API',
    // No safe read-only probe wired here yet — configured is honestly 'unknown', not green.
    status: configured ? 'unknown' : 'unsupported',
    scope: configured ? `phone ${process.env.WA_PHONE_ID}` : 'not configured',
    evidence: configured ? 'env present; no read-only probe in this audit — do not treat as proven' : 'WA_PHONE_ID / WA_TOKEN not set',
  }
}

function checkGbp(): CapabilityCheck {
  const configured = Boolean(process.env.GBP_ACCOUNT_ID?.trim() && process.env.GBP_LOCATION_ID?.trim())
  return {
    key: 'google_business_profile',
    area: 'google',
    label: 'Google Business Profile',
    status: configured ? 'unknown' : 'unsupported',
    scope: configured ? `location ${process.env.GBP_LOCATION_ID}` : 'not configured',
    evidence: configured
      ? 'ids present; GBP shares the Google OAuth — probe not run in this audit (quota-heavy)'
      : 'GBP_ACCOUNT_ID / GBP_LOCATION_ID not set',
  }
}

async function checkWebsite(): Promise<CapabilityCheck> {
  const url = (process.env.WEBSITE_BASE_URL ?? process.env.NEXT_PUBLIC_WEBSITE_URL ?? '').trim()
  if (!url) {
    return {
      key: 'website',
      area: 'website',
      label: 'Business Website',
      status: 'unsupported',
      scope: 'no website url env',
      evidence: 'WEBSITE_BASE_URL / NEXT_PUBLIC_WEBSITE_URL not set',
    }
  }
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000), redirect: 'follow' })
    return {
      key: 'website',
      area: 'website',
      label: 'Business Website',
      status: deriveStatus({ configured: true, probeRan: true, probeOk: res.ok }),
      scope: url,
      evidence: res.ok ? `HEAD ${res.status}` : `HEAD returned ${res.status}`,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      key: 'website',
      area: 'website',
      label: 'Business Website',
      status: 'broken',
      scope: url,
      evidence: 'HEAD probe failed',
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    }
  }
}

export function buildMatrix(checks: CapabilityCheck[], checkedAt: string): CapabilityMatrix {
  const proven = checks.filter((c) => c.status === 'read' || c.status === 'draft' || c.status === 'stage' || c.status === 'write-confirmed').length
  return {
    checkedAt,
    checks,
    summary: {
      total: checks.length,
      proven,
      broken: checks.filter((c) => c.status === 'broken').length,
      unknown: checks.filter((c) => c.status === 'unknown').length,
      unsupported: checks.filter((c) => c.status === 'unsupported').length,
    },
    metaVersionCallSites: [...META_VERSION_CALL_SITES],
  }
}

/** Run the full read-only capability audit. Never throws; every probe degrades to a tagged status. */
export async function runCapabilityAudit(): Promise<CapabilityMatrix> {
  const settled = await Promise.allSettled([
    checkFbPage(FB_PAGES[0]),
    checkFbPage(FB_PAGES[1]),
    checkAdAccount(),
    checkPixel(),
    checkInstagram(),
    checkGsc(),
    checkGa4(),
    checkWebsite(),
  ])
  const checks: CapabilityCheck[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          key: `probe_${i}`,
          area: 'meta',
          label: 'probe crashed',
          status: 'unknown' as const,
          scope: 'unknown',
          evidence: 'probe promise rejected',
          error: redactSecrets(s.reason instanceof Error ? s.reason.message : String(s.reason)),
        },
  )
  checks.push(checkWhatsApp(), checkGbp())
  return buildMatrix(checks, new Date().toISOString())
}
