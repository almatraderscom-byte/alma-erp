import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendOrderAlert } from '@/lib/resend'
import { canEditOrder, orderFieldToGas } from '@/lib/order-access'
import { normalizeAlmaRole } from '@/lib/roles'
import type { Order } from '@/types'

export async function POST(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id, field, value, business_id: businessId } = await req.json()
    if (!id || !field || value === undefined) {
      return NextResponse.json({ error: 'id, field, value required' }, { status: 400 })
    }

    const gasField = orderFieldToGas(String(field)) || String(field).toUpperCase()
    if (!gasField) {
      return NextResponse.json({ error: `Field not editable: ${field}` }, { status: 400 })
    }

    let order: Order
    try {
      const data = await serverGet<{ order?: Order } | Order>(
        'order',
        { id, business_id: businessId || 'ALMA_LIFESTYLE' },
        0,
      )
      order = ('order' in (data as object) ? (data as { order?: Order }).order : data) as Order
      if (!order?.id) throw new Error('Order not found')
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message || 'Order not found' }, { status: 404 })
    }

    const role = normalizeAlmaRole(token.role as string)
    if (!canEditOrder(role, token.sub, order)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const result = await serverPost('update_field', await mergeActorPayload(req, { id, field: gasField, value }))
    await sendOrderAlert({
      businessId: String(businessId || order.business_id || 'ALMA_LIFESTYLE'),
      subject: `Order field updated · ${id}`,
      title: 'Order updated',
      preview: `${gasField} changed for order ${id}.`,
      text: `Field ${gasField} changed for order ${id}.`,
      priority: 'NORMAL',
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `order-field:${id}:${gasField}:${String(value).slice(0, 64)}`,
      metadata: { orderId: id, field: gasField, value, result },
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
