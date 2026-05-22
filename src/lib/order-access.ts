import type { Order, OrderStatus } from '@/types'
import type { AlmaRole } from '@/lib/roles'
import { can } from '@/lib/roles'

const TERMINAL_STATUSES = new Set<OrderStatus>([
  'Delivered',
  'Returned',
  'Cancelled',
  'CANCELLED',
  'RETURNED',
  'FAILED_DELIVERY',
])

/** Staff may correct their own order only while it is still early in fulfillment. */
const STAFF_EDIT_STATUSES = new Set<OrderStatus>(['Pending', 'Confirmed', 'Packed'])

export const ORDER_EDITABLE_FIELDS = [
  'customer',
  'phone',
  'address',
  'payment',
  'source',
  'product',
  'category',
  'size',
  'qty',
  'unit_price',
  'discount',
  'notes',
] as const

export type OrderEditableField = (typeof ORDER_EDITABLE_FIELDS)[number]

const GAS_FIELD_MAP: Record<OrderEditableField, string> = {
  customer: 'CUSTOMER',
  phone: 'PHONE',
  address: 'ADDRESS',
  payment: 'PAYMENT',
  source: 'SOURCE',
  product: 'PRODUCT',
  category: 'CATEGORY',
  size: 'SIZE',
  qty: 'QTY',
  unit_price: 'UNIT_PRICE',
  discount: 'DISCOUNT',
  notes: 'NOTES',
}

export function orderFieldToGas(field: string): string | null {
  const key = field.toLowerCase() as OrderEditableField
  return GAS_FIELD_MAP[key] || null
}

export function parseHandledByUserId(handledBy?: string | null): string | null {
  if (!handledBy) return null
  const match = handledBy.match(/\(([a-f0-9-]{8,})\)\s*$/i)
  return match ? match[1] : null
}

export function isOrderTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function isOrderCreator(userId: string, order: Pick<Order, 'handled_by'>): boolean {
  const creatorId = parseHandledByUserId(order.handled_by)
  return Boolean(creatorId && creatorId === userId)
}

export function canEditOrder(
  role: AlmaRole,
  userId: string,
  order: Pick<Order, 'status' | 'handled_by'>,
): boolean {
  if (isOrderTerminal(order.status)) return false
  if (can(role, 'ordersEditField')) return true
  if (role === 'VIEWER') return false
  return isOrderCreator(userId, order) && STAFF_EDIT_STATUSES.has(order.status)
}

export function canRequestOrderDelete(role: AlmaRole): boolean {
  return role !== 'VIEWER'
}

export function orderSnapshotForApproval(order: Order) {
  return {
    orderId: order.id,
    businessId: order.business_id || 'ALMA_LIFESTYLE',
    customer: order.customer,
    phone: order.phone,
    product: order.product,
    status: order.status,
    sell_price: order.sell_price,
    handled_by: order.handled_by,
    date: order.date,
    payment: order.payment,
    source: order.source,
  }
}
