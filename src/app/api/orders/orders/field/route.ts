import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
export async function POST(req: NextRequest) {
  try {
    const { id, field, value } = await req.json()
    if (!id || !field || value === undefined)
      return NextResponse.json({ error: 'id, field, value required' }, { status: 400 })
    const result = await serverPost('update_field', await mergeActorPayload(req, { id, field, value }))
    await sendOrderAlert({
      businessId: 'ALMA_LIFESTYLE',
      subject: `Order field updated · ${id}`,
      title: 'Order updated',
      preview: `${field} changed for order ${id}.`,
      text: `Field ${field} changed for order ${id}.`,
      priority: 'NORMAL',
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `order-field:${id}:${field}:${String(value).slice(0, 64)}`,
      metadata: { orderId: id, field, value, result },
    })
    return NextResponse.json(result)
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
