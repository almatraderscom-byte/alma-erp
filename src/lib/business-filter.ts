import type { BusinessId } from '@/lib/businesses'
import { DEFAULT_BUSINESS_ID } from '@/lib/businesses'
import type { Order, Customer } from '@/types'

/** Normalize legacy rows without business_id → Alma Lifestyle */
export function orderBusinessId(o: { business_id?: string }): BusinessId {
  const id = o.business_id?.trim()
  if (id === 'CREATIVE_DIGITAL_IT') return 'CREATIVE_DIGITAL_IT'
  return 'ALMA_LIFESTYLE'
}

export function filterOrdersByBusiness(orders: Order[], businessId: BusinessId): Order[] {
  return orders.filter(o => orderBusinessId(o) === businessId)
}

export function filterCustomersByBusiness(customers: Customer[], businessId: BusinessId): Customer[] {
  return customers.filter(c => {
    const id = (c as Customer & { business_id?: string }).business_id
    if (!id) return businessId === DEFAULT_BUSINESS_ID
    return id === businessId
  })
}

export function withBusinessParam<T extends Record<string, string>>(
  params: T,
  businessId: BusinessId,
): T & { business_id: string } {
  return { ...params, business_id: businessId }
}
