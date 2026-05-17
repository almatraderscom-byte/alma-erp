import type { BusinessBranding } from '@/types/branding'
import type { InvoicePdfBranding } from '@/lib/pdf/types'
import { errorMeta, logEvent } from '@/lib/logger'

const LOGO_CACHE_TTL_MS = 10 * 60 * 1000
const LOGO_FETCH_TIMEOUT_MS = 5000
const logoDataUrlCache = new Map<string, { expiresAt: number; promise: Promise<string | undefined> }>()

export function brandingToPdf(b: BusinessBranding, logoDataUrl?: string): InvoicePdfBranding {
  return {
    companyName: b.company_name || 'Company',
    tagline: b.tagline || '',
    phone: b.phone || '',
    email: b.email || '',
    website: b.website || '',
    address: b.address || '',
    facebook: b.facebook || '',
    logoUrl: b.logo_url || '',
    logoDataUrl,
    colorPrimary: b.color_primary || '#C9A84C',
    colorSecondary: b.color_secondary || '#8B6914',
    colorAccent: b.color_accent || '#F0D080',
    footerThanks: b.invoice_footer_thanks || '',
    footerPolicy: b.invoice_footer_policy || '',
    footerNote: b.invoice_footer_note || '',
  }
}

export async function fetchLogoDataUrl(logoUrl: string | undefined): Promise<string | undefined> {
  if (!logoUrl || !logoUrl.startsWith('http')) return undefined
  const cached = logoDataUrlCache.get(logoUrl)
  if (cached && cached.expiresAt > Date.now()) return cached.promise

  const promise = fetchLogoDataUrlUncached(logoUrl)
  logoDataUrlCache.set(logoUrl, { expiresAt: Date.now() + LOGO_CACHE_TTL_MS, promise })
  return promise
}

async function fetchLogoDataUrlUncached(logoUrl: string): Promise<string | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOGO_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(logoProxyUrl(logoUrl), { signal: ctrl.signal, cache: 'force-cache' })
    if (!res.ok) {
      logEvent('warn', 'pdf.branding_logo_load_failed', { logoUrl: redactUrl(logoUrl), status: res.status })
      return undefined
    }
    const data = await res.json() as { dataUrl?: string }
    return data.dataUrl
  } catch (e) {
    logEvent('warn', 'pdf.branding_logo_load_failed', { logoUrl: redactUrl(logoUrl), ...errorMeta(e) })
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function logoProxyUrl(logoUrl: string) {
  const path = `/api/branding/image-proxy?url=${encodeURIComponent(logoUrl)}`
  if (typeof window !== 'undefined') return path
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  if (!appUrl) throw new Error('App URL is required for server-side logo proxying')
  return `${appUrl.replace(/\/$/, '')}${path}`
}

function redactUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'invalid-url'
  }
}
