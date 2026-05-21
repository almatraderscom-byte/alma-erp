import { logEvent } from '@/lib/logger'
import type { BusinessId } from '@/lib/businesses'

export function logOrdersProviderMissing(meta: {
  pathname?: string
  businessId?: string
  component?: string
  componentStack?: string
}) {
  logEvent('warn', 'orders.provider.missing', meta)
}

export function logOrdersContextInvalid(meta: {
  pathname?: string
  businessId?: BusinessId
  reason?: string
  component?: string
}) {
  logEvent('warn', 'orders.context.invalid', meta)
}

export function logOrdersRouteMismatch(meta: {
  pathname?: string
  businessId?: BusinessId
  component?: string
}) {
  logEvent('warn', 'orders.route.mismatch', meta)
}

export function logOrdersBusinessGuard(meta: {
  pathname?: string
  businessId?: BusinessId
  component?: string
}) {
  logEvent('warn', 'orders.business.guard', meta)
}

/** Routes that consume shared orders context (lifestyle ERP). */
export function ordersDataActiveForRoute(pathname: string, businessId: BusinessId): boolean {
  if (businessId !== 'ALMA_LIFESTYLE') return false
  return pathname === '/' || pathname.startsWith('/orders')
}
