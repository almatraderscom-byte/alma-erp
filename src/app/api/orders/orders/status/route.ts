import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import { notifyRole, notifyUser } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'
import { handleOrderCommissionStatus, resolveOrderHandlerUser } from '@/lib/payroll-compensation'
import type { Order } from '@/types'
import { enqueueCourierUpdateSms } from '@/services/sms/events'

const VALID_STATUSES = new Set(['Pending', 'Confirmed', 'Packed', 'Shipped', 'Delivered', 'CANCELLED', 'RETURNED', 'FAILED_DELIVERY'])
const DESTRUCTIVE_STATUSES = new Set(['CANCELLED', 'RETURNED', 'FAILED_DELIVERY'])

export async function POST(req: NextRequest) {
  try {
    const { id, status, reason } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    const nextStatus = normalizeRequestedStatus(String(status))
    if (!VALID_STATUSES.has(nextStatus)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
    }

    const beforeData = await serverGet<{ order: Order }>('order', { id }, 0)
    const beforeOrder = beforeData.order
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
    const result = await serverPost('update_status', actorPayload)
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
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}

function normalizeRequestedStatus(status: string) {
  const key = status.trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'CANCELLED' || key === 'CANCELED') return 'CANCELLED'
  if (key === 'RETURNED') return 'RETURNED'
  if (key === 'FAILED_DELIVERY') return 'FAILED_DELIVERY'
  if (key === 'PENDING') return 'Pending'
  if (key === 'CONFIRMED') return 'Confirmed'
  if (key === 'PACKED') return 'Packed'
  if (key === 'SHIPPED') return 'Shipped'
  if (key === 'DELIVERED') return 'Delivered'
  return status
}

function isTerminal(status: string) {
  return ['CANCELLED', 'RETURNED', 'FAILED_DELIVERY', 'Cancelled', 'Returned'].includes(status)
}

function statusTitle(status: string) {
  if (status === 'CANCELLED') return 'Order cancelled'
  if (status === 'RETURNED') return 'Order returned'
  if (status === 'FAILED_DELIVERY') return 'Failed delivery recorded'
  return 'Order status updated'
}
