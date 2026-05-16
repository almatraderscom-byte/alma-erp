import type { BusinessId } from '@/lib/businesses'
import { BUSINESSES } from '@/lib/businesses'
import type { BusinessBranding } from '@/types/branding'

export function defaultBusinessBranding(businessId: BusinessId): BusinessBranding {
  const business = BUSINESSES[businessId]
  return {
    business_id: businessId,
    company_name: business.name,
    tagline: business.tagline,
    phone: '',
    email: '',
    website: '',
    address: '',
    facebook: '',
    logo_file_id: '',
    logo_url: '',
    favicon_file_id: '',
    favicon_url: '',
    color_primary: '#C9A84C',
    color_secondary: '#8B6914',
    color_accent: '#F0D080',
    invoice_footer_thanks: 'Thank you for choosing Alma.',
    invoice_footer_policy: '',
    invoice_footer_note: '',
    invoice_prefix: businessId === 'CREATIVE_DIGITAL_IT' ? 'CDIT-INV' : 'AL-INV',
  }
}

export function brandingCacheKey(businessId: BusinessId) {
  return `alma-branding:${businessId}`
}

export function readCachedBranding(businessId: BusinessId): BusinessBranding | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(brandingCacheKey(businessId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as BusinessBranding
    return parsed?.business_id ? parsed : null
  } catch {
    return null
  }
}

export function writeCachedBranding(businessId: BusinessId, branding: BusinessBranding) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(brandingCacheKey(businessId), JSON.stringify(branding))
  } catch {
    /* Ignore storage quota/private mode failures. */
  }
}
