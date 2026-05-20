import { parseBusinessAccess, businessAllowed } from '@/lib/business-access'
import { logEvent } from '@/lib/logger'

/** Validates token business access against a target business; logs mismatch. */
export function safeBusinessAccess(
  businessAccess: string | null | undefined,
  businessId: string,
): boolean {
  const allowed = parseBusinessAccess(businessAccess ?? undefined)
  const ok = businessAllowed(businessAccess, businessId)
  if (!ok) {
    logEvent('warn', 'business.scope.mismatch', {
      businessId,
      allowed,
    })
  }
  return ok
}

export function requireBusinessAccess(
  businessAccess: string | null | undefined,
  businessId: string,
): { ok: true } | { ok: false; code: string; message: string } {
  if (safeBusinessAccess(businessAccess, businessId)) return { ok: true }
  return {
    ok: false,
    code: 'business_scope_mismatch',
    message: 'You do not have access to this business scope.',
  }
}

export { parseBusinessAccess } from '@/lib/business-access'
