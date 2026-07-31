/**
 * Changing an order's status is not a database write — it is a workflow.
 *
 * The ERP's own route has always done four more things after the row changes:
 * the handler's commission is created or reversed, the courier SMS is queued on
 * Shipped, the role matrix and the handler are notified, and the change is
 * logged. When the agent gained `update_order` (B1) it called the low-level
 * helper directly and skipped every one of them — an order would show
 * "Delivered" while nobody was paid and no customer was told. The review bot
 * caught it before it merged.
 *
 * So the workflow lives here, and both callers — the ERP UI route and the
 * agent's approval executor — go through it. There is one way to change an
 * order's status.
 */
import { fetchOrderById } from '@/lib/lifestyle/read'
import { dispatchUpdateOrderStatus } from '@/lib/lifestyle/write-dispatch'
import { sendOrderAlert } from '@/lib/resend'
import { notifyRoles, notifyUser } from '@/lib/notifications'
import { NOTIFY_ROLES } from '@/lib/notification-routing'
import { logEvent } from '@/lib/logger'
import { handleOrderCommissionStatus, resolveOrderHandlerUser } from '@/lib/payroll-compensation'
import { enqueueCourierUpdateSms } from '@/services/sms/events'

/** The only status words the ERP stores. Anything else is a bug upstream. */
export const VALID_ORDER_STATUSES = new Set([
  'Pending', 'Confirmed', 'Packed', 'Shipped', 'Delivered',
  'CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID',
])

const DESTRUCTIVE_STATUSES = new Set(['CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID'])

/**
 * Whatever a person (or a model) typed → the ERP's own spelling.
 *
 * `processing` matters: the agent's order adapter has always shown it as the
 * name for `Packed`, so a model asked to "set it to processing" would otherwise
 * store a word the ERP does not recognise — an order excluded from every
 * pending predicate, with no next transition in the UI.
 */
export function normalizeOrderStatus(status: string): string {
  const key = String(status ?? '').trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'CANCELLED' || key === 'CANCELED') return 'CANCELLED'
  if (key === 'FAILED_DELIVERY') return 'RETURNED_UNPAID'
  if (key === 'RETURNED') return 'RETURNED'
  if (key === 'RETURNED_PAID') return 'RETURNED_PAID'
  if (key === 'RETURNED_UNPAID') return 'RETURNED_UNPAID'
  if (key === 'PENDING') return 'Pending'
  if (key === 'CONFIRMED') return 'Confirmed'
  if (key === 'PACKED' || key === 'PROCESSING') return 'Packed'
  if (key === 'SHIPPED') return 'Shipped'
  if (key === 'DELIVERED') return 'Delivered'
  return String(status ?? '')
}

export function isTerminalOrderStatus(status: string): boolean {
  return [
    'CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID',
    'Cancelled', 'Returned',
  ].includes(String(status ?? ''))
}

export function orderStatusTitle(status: string): string {
  if (status === 'CANCELLED') return 'Order cancelled'
  if (status === 'RETURNED') return 'Order returned'
  if (status === 'RETURNED_PAID') return 'Order returned (paid delivery)'
  if (status === 'RETURNED_UNPAID') return 'Order returned (refused)'
  return 'Order status updated'
}

export interface OrderStatusChangeInput {
  id: string
  /** Raw or canonical — normalised here. */
  status: string
  reason?: string
  /** Who asked for it; the agent path passes the owner's approval as the actor. */
  actorUserId?: string
  /** Extra fields the caller already resolved (the UI route merges its actor payload). */
  extraPayload?: Record<string, unknown>
}

export type OrderStatusChangeResult =
  | { ok: true; status: string; previousStatus: string; result: unknown; commission: unknown }
  | { ok: false; code: 'not_found' | 'invalid_status' | 'terminal'; error: string }

export async function applyOrderStatusChange(
  input: OrderStatusChangeInput,
): Promise<OrderStatusChangeResult> {
  const id = String(input.id ?? '')
  const nextStatus = normalizeOrderStatus(input.status)
  if (!VALID_ORDER_STATUSES.has(nextStatus)) {
    return { ok: false, code: 'invalid_status', error: `Invalid status: ${input.status}` }
  }

  const beforeOrder = await fetchOrderById(id, 'ALMA_LIFESTYLE')
  if (!beforeOrder) return { ok: false, code: 'not_found', error: 'Order not found' }

  const previousStatus = String(beforeOrder.status ?? '')
  // A finalised order stays finalised. Reopening one re-applies the stock
  // deduction, so "un-cancelling" through any surface would move inventory.
  if (isTerminalOrderStatus(previousStatus) && previousStatus !== nextStatus) {
    return { ok: false, code: 'terminal', error: `Order is already terminal: ${previousStatus}` }
  }

  const businessId = String(beforeOrder.business_id || 'ALMA_LIFESTYLE')
  const payload: Record<string, unknown> = {
    id,
    status: nextStatus,
    previous_status: previousStatus,
    business_id: businessId,
    reason: String(input.reason || '').slice(0, 500),
    ...(input.extraPayload ?? {}),
  }
  if (input.actorUserId && !payload.actor_user_id) payload.actor_user_id = input.actorUserId

  const result = await dispatchUpdateOrderStatus(payload)

  let commission: unknown = null
  try {
    commission = await handleOrderCommissionStatus(
      beforeOrder,
      nextStatus,
      String(payload.actor_user_id || ''),
    )
  } catch (commissionError) {
    commission = { ok: false, error: (commissionError as Error).message }
  }

  const handler = await resolveOrderHandlerUser(beforeOrder)
  if (nextStatus === 'Shipped') {
    enqueueCourierUpdateSms({
      businessId,
      phone: beforeOrder.phone,
      tracking: beforeOrder.tracking_id,
      orderId: id,
    })
  }

  const priority = DESTRUCTIVE_STATUSES.has(nextStatus) ? 'HIGH' : 'NORMAL'
  const title = orderStatusTitle(nextStatus)
  const message = `Order ${id} changed from ${previousStatus} to ${nextStatus.replace(/_/g, ' ')}.`
  await Promise.all([
    sendOrderAlert({
      businessId,
      subject: `Order updated · ${id}`,
      title,
      preview: message,
      text: message,
      priority,
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `order-status:${id}:${nextStatus}`,
      metadata: { orderId: id, previousStatus, status: nextStatus, result, commission, businessId },
    }),
    // Role matrix (notification-routing.ts) + the resolved handler; ?q= lands
    // the tap on this order instead of the bare list.
    notifyRoles(NOTIFY_ROLES.orderStatusChanged, {
      businessId,
      type: 'ORDER_ASSIGNED',
      priority,
      title,
      message,
      actionUrl: `/orders?q=${encodeURIComponent(String(id))}`,
    }),
    notifyUser({
      userId: handler?.id,
      businessId,
      type: 'ORDER_ASSIGNED',
      priority,
      title,
      message,
      actionUrl: `/orders?q=${encodeURIComponent(String(id))}`,
    }),
  ])

  logEvent('info', 'orders.status_changed', {
    orderId: id,
    previousStatus,
    nextStatus,
    businessId,
    actorUserId: payload.actor_user_id,
    commission,
  })

  return { ok: true, status: nextStatus, previousStatus, result, commission }
}
