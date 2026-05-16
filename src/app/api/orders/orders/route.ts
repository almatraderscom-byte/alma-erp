import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { notifyRole } from '@/lib/notifications'
import { sendOrderAlert } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet(p.id ? 'order' : 'orders', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store, must-revalidate' } })
  } catch (e) {
    logEvent('error', 'orders.list_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
    const result = await serverPost('create_order', await mergeActorPayload(req, body as Record<string, unknown>))
    const payload = body as Record<string, unknown>
    await Promise.all([
      notifyRole({
        role: 'ADMIN',
        businessId: String(payload.business_id || 'ALMA_LIFESTYLE'),
        type: 'ORDER_ASSIGNED',
        priority: 'NORMAL',
        title: 'New order assigned',
        message: `Order ${String((result as { order_id?: string }).order_id || '')} was created for ${String(payload.customer || payload.customer_name || 'customer')}.`,
        actionUrl: '/orders',
      }),
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId: String(payload.business_id || 'ALMA_LIFESTYLE'),
        type: 'ORDER_ASSIGNED',
        priority: 'NORMAL',
        title: 'New order assigned',
        message: `Order ${String((result as { order_id?: string }).order_id || '')} was created for ${String(payload.customer || payload.customer_name || 'customer')}.`,
        actionUrl: '/orders',
      }),
      sendOrderAlert({
        businessId: String(payload.business_id || 'ALMA_LIFESTYLE'),
        subject: `Order created · ${String((result as { order_id?: string }).order_id || '')}`,
        title: 'Order created',
        preview: `New order for ${String(payload.customer || payload.customer_name || 'customer')}.`,
        text: `Order ${String((result as { order_id?: string }).order_id || '')} was created for ${String(payload.customer || payload.customer_name || 'customer')}.`,
        priority: 'NORMAL',
        actionUrl: '/orders',
        actionLabel: 'Open orders',
        dedupeKey: `order-created:${String((result as { order_id?: string }).order_id || Date.now())}`,
        metadata: { result, payload },
      }),
    ])
    return NextResponse.json(result)
  } catch (e) {
    const payload = typeof body === 'object' && body ? body as Record<string, unknown> : {}
    logEvent('error', 'orders.create_failed', {
      ...errorMeta(e),
      businessId: payload.business_id,
      customer: payload.customer || payload.customer_name,
    })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
