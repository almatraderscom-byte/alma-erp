import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { apiFailure } from '@/lib/safe-api-response'
import { logEvent } from '@/lib/logger'
import { getLifestyleOrder } from '@/lib/lifestyle/read'
import { dispatchUpdateOrderTracking } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import { enqueueCourierUpdateSms } from '@/services/sms/events'
export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  try {
    const { id, tracking_id, courier } = await req.json()
    if (!id || !tracking_id) return NextResponse.json({ error: 'id and tracking_id required' }, { status: 400 })
    const result = await dispatchUpdateOrderTracking(await mergeActorPayload(req, { id, tracking_id, courier }))
    void getLifestyleOrder(String(id), {})
      .then(data => enqueueCourierUpdateSms({
        businessId: data.order?.business_id || 'ALMA_LIFESTYLE',
        phone: data.order?.phone,
        tracking: String(tracking_id),
        orderId: String(id),
      }))
      .catch(() => null)
    await sendOrderAlert({
      businessId: 'ALMA_LIFESTYLE',
      subject: `Order tracking updated · ${id}`,
      title: 'Order tracking updated',
      preview: `Tracking ${tracking_id} added to order ${id}.`,
      text: `Tracking ${tracking_id} (${courier || 'courier'}) added to order ${id}.`,
      priority: 'NORMAL',
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `order-tracking:${id}:${tracking_id}`,
      metadata: { orderId: id, trackingId: tracking_id, courier, result },
    })
    return NextResponse.json(result)
  } catch (e) {
    logEvent('error', 'orders.tracking_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not update tracking.', { status: 500 })
  }
}
