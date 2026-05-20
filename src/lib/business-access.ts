import type { BusinessId } from '@/lib/businesses'

export const ALL_BUSINESS_IDS: BusinessId[] = ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT', 'ALMA_TRADING']

export function parseBusinessAccess(raw: string | undefined | null): BusinessId[] {
  const u = String(raw || '').trim()
  if (!u) return ALL_BUSINESS_IDS
  const ids = u.split(',').map(s => s.trim()).filter(Boolean) as BusinessId[]
  const ok = ids.filter(id => ALL_BUSINESS_IDS.includes(id))
  return ok.length ? ok : ['ALMA_LIFESTYLE']
}

export function normalizeBusinessAccessForRole(raw: string | undefined | null, role: string | undefined | null): string {
  if (String(role || '').toUpperCase() === 'SUPER_ADMIN') return ALL_BUSINESS_IDS.join(',')
  return parseBusinessAccess(raw).join(',')
}

export function businessAllowed(tokenBizRaw: string | undefined | null, businessId: string): boolean {
  const allowed = parseBusinessAccess(tokenBizRaw)
  return allowed.includes(businessId as BusinessId)
}
