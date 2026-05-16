import type { BusinessId } from '@/lib/businesses'

export function parseBusinessAccess(raw: string | undefined | null): BusinessId[] {
  const u = String(raw || '').trim()
  if (!u) return ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT']
  const ids = u.split(',').map(s => s.trim()).filter(Boolean) as BusinessId[]
  const ok = ids.filter(id => id === 'ALMA_LIFESTYLE' || id === 'CREATIVE_DIGITAL_IT')
  return ok.length ? ok : ['ALMA_LIFESTYLE']
}

export function businessAllowed(tokenBizRaw: string | undefined | null, businessId: string): boolean {
  const allowed = parseBusinessAccess(tokenBizRaw)
  return allowed.includes(businessId as BusinessId)
}
