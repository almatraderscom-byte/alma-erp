import type { BusinessBranding } from '@/types/branding'
import type { InvoicePdfBranding } from '@/lib/pdf/types'

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
  try {
    const res = await fetch(`/api/branding/image-proxy?url=${encodeURIComponent(logoUrl)}`)
    if (!res.ok) return undefined
    const data = await res.json() as { dataUrl?: string }
    return data.dataUrl
  } catch {
    return undefined
  }
}
