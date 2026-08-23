import type { Order } from '@/types'
import { ENTITY_ROUTE_BUSINESS_QUERY } from '@/lib/businesses'

const MAX_ORDER_ID_CHARS = 256
const ORDER_ID_CONTROL_CHAR = /[\u0000-\u001f\u007f]/

/** A bounded, non-empty order id suitable for an internal route. */
export function normalizeOrderFocusId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > MAX_ORDER_ID_CHARS || ORDER_ID_CONTROL_CHAR.test(id)) return null
  return id
}

/** Orders belong to the Lifestyle surface; never cross-fetch one from another business context. */
export function orderFocusIdForBusiness(
  businessId: string | null | undefined,
  value: string | null | undefined,
): string | null {
  return businessId === 'ALMA_LIFESTYLE' ? normalizeOrderFocusId(value) : null
}

/** Canonical, shareable route for one exact ERP order. */
export function orderDetailPath(
  orderId: string | null | undefined,
  businessId = 'ALMA_LIFESTYLE',
): string {
  const id = normalizeOrderFocusId(orderId)
  return id
    ? `/orders/${encodeURIComponent(id)}?${ENTITY_ROUTE_BUSINESS_QUERY}=${encodeURIComponent(businessId)}`
    : '/orders'
}

/** Internal list-screen state used by the canonical dynamic route. */
export function ordersFocusPath(
  orderId: string | null | undefined,
  businessId = 'ALMA_LIFESTYLE',
): string {
  const id = normalizeOrderFocusId(orderId)
  return id
    ? `/orders?focus=${encodeURIComponent(id)}&${ENTITY_ROUTE_BUSINESS_QUERY}=${encodeURIComponent(businessId)}`
    : '/orders'
}

/** Never open a different/partial order if an upstream exact lookup is malformed. */
export function exactFocusedOrder(
  focusId: string | null,
  order: Order | null | undefined,
): Order | null {
  return focusId && order?.id === focusId ? order : null
}
