import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
export async function POST(req: NextRequest) {
  try {
    const { id, status } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    const result = await serverPost('update_status', await mergeActorPayload(req, { id, status }))
    await sendOrderAlert({
      businessId: 'ALMA_LIFESTYLE',
      subject: `Order updated · ${id}`,
      title: String(status).toLowerCase().includes('cancel') ? 'Order cancelled' : 'Order status updated',
      preview: `Order ${id} status changed to ${status}.`,
      text: `Order ${id} status changed to ${status}.`,
      priority: String(status).toLowerCase().includes('cancel') ? 'HIGH' : 'NORMAL',
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `order-status:${id}:${status}`,
      metadata: { orderId: id, status, result },
    })
    return NextResponse.json(result)
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
