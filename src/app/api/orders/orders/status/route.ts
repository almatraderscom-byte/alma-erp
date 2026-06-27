import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { apiFailure } from '@/lib/safe-api-response'
import { fetchOrderById } from '@/lib/lifestyle/read'
import { dispatchUpdateOrderStatus } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'
import { handleOrderCommissionStatus, resolveOrderHandlerUser } from '@/lib/payroll-compensation'
import { enqueueCourierUpdateSms } from '@/services/sms/events'

const VALID_STATUSES = new Set([
  'Pending', 'Confirmed', 'Packed', 'Shipped', 'Delivered',
  'CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID',
])
const DESTRUCTIVE_STATUSES = new Set(['CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID'])

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  try {
    const { id, status, reason } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    const nextStatus = normalizeRequestedStatus(String(status))
    if (!VALID_STATUSES.has(nextStatus)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
    }

    const beforeOrder = await fetchOrderById(id, 'ALMA_LIFESTYLE')
    if (!beforeOrder) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const previousStatus = beforeOrder.status
    if (isTerminal(previousStatus) && previousStatus !== nextStatus) {
      return NextResponse.json({ error: `Order is already terminal: ${previousStatus}` }, { status: 409 })
    }

    const businessId = String(beforeOrder.business_id || 'ALMA_LIFESTYLE')
    const actorPayload = await mergeActorPayload(req, {
      id,
      status: nextStatus,
      previous_status: previousStatus,
      business_id: businessId,
      reason: String(reason || '').slice(0, 500),
    })
    const result = await dispatchUpdateOrderStatus(actorPayload)
    let commission: unknown = null
    try {
      commission = await handleOrderCommissionStatus(beforeOrder, nextStatus, String(actorPayload.actor_user_id || ''))
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
    const title = statusTitle(nextStatus)
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
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId,
        type: 'ORDER_ASSIGNED',
        priority,
        title,
        message,
        actionUrl: '/orders',
      }),
      notifyUser({
        userId: handler?.id,
        businessId,
        type: 'ORDER_ASSIGNED',
        priority,
        title,
        message,
        actionUrl: '/orders',
      }),
    ])
    logEvent('info', 'orders.status_changed', {
      orderId: id,
      previousStatus,
      nextStatus,
      businessId,
      actorUserId: actorPayload.actor_user_id,
      commission,
    })
    return NextResponse.json({ ...(result as Record<string, unknown>), commission })
  } catch (e) {
    logEvent('error', 'orders.status_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not update order status.', { status: 500 })
  }
}

function normalizeRequestedStatus(status: string) {
  const key = status.trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'CANCELLED' || key === 'CANCELED') return 'CANCELLED'
  if (key === 'FAILED_DELIVERY') return 'RETURNED_UNPAID'
  if (key === 'RETURNED') return 'RETURNED'
  if (key === 'RETURNED_PAID') return 'RETURNED_PAID'
  if (key === 'RETURNED_UNPAID') return 'RETURNED_UNPAID'
  if (key === 'PENDING') return 'Pending'
  if (key === 'CONFIRMED') return 'Confirmed'
  if (key === 'PACKED') return 'Packed'
  if (key === 'SHIPPED') return 'Shipped'
  if (key === 'DELIVERED') return 'Delivered'
  return status
}

function isTerminal(status: string) {
  return [
    'CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID',
    'Cancelled', 'Returned',
  ].includes(status)
}

function statusTitle(status: string) {
  if (status === 'CANCELLED') return 'Order cancelled'
  if (status === 'RETURNED') return 'Order returned'
  if (status === 'RETURNED_PAID') return 'Order returned (paid delivery)'
  if (status === 'RETURNED_UNPAID') return 'Order returned (refused)'
  return 'Order status updated'
}
