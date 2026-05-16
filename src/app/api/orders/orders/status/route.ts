import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import { handleOrderCommissionStatus } from '@/lib/payroll-compensation'
import type { Order } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const { id, status } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    const actorPayload = await mergeActorPayload(req, { id, status })
    const result = await serverPost('update_status', actorPayload)
    let commission: unknown = null
    try {
      const orderData = await serverGet<{ order: Order }>('order', { id }, 0)
      commission = await handleOrderCommissionStatus(orderData.order, String(status), String(actorPayload.actor_user_id || ''))
    } catch (commissionError) {
      commission = { ok: false, error: (commissionError as Error).message }
    }
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
      metadata: { orderId: id, status, result, commission },
    })
    return NextResponse.json({ ...(result as Record<string, unknown>), commission })
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
