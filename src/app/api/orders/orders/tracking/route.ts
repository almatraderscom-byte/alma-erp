import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleOrder } from '@/lib/lifestyle/read'
import { dispatchUpdateOrderTracking } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import type { Order } from '@/types'
import { enqueueCourierUpdateSms } from '@/services/sms/events'
export async function POST(req: NextRequest) {
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
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
