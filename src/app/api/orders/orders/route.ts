import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleOrder, getLifestyleOrders } from '@/lib/lifestyle/read'
import { dispatchCreateOrder } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { notifyRole } from '@/lib/notifications'
import { sendOrderAlert } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'
import { enqueueOrderConfirmationSms } from '@/services/sms/events'
import { parseArchiveVisibility } from '@/lib/business-archive/query'
import {
  filterListByArchivedIds,
  getArchivedRegistryIds,
} from '@/lib/business-archive/registry-filter'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  const url = new URL(req.url)
  const archiveVisibility = parseArchiveVisibility(url.searchParams.get('archive_visibility'))
  try {
    const data = p.id ? await getLifestyleOrder(p.id, p) : await getLifestyleOrders(p)
    const businessId = String(p.business_id || 'ALMA_LIFESTYLE')
    if (!p.id && archiveVisibility === 'active' && data && typeof data === 'object') {
      const archivedIds = await getArchivedRegistryIds(businessId, 'orders')
      const payload = data as { orders?: Array<{ id?: string; order_id?: string }> }
      if (payload.orders) {
        payload.orders = filterListByArchivedIds(payload.orders, archivedIds, 'id')
      }
    }
    if (!p.id && archiveVisibility === 'archived' && data && typeof data === 'object') {
      const archivedIds = await getArchivedRegistryIds(businessId, 'orders')
      const payload = data as { orders?: Array<{ id?: string; order_id?: string }> }
      if (payload.orders) {
        payload.orders = payload.orders.filter(o => archivedIds.has(String(o.id || o.order_id || '')))
      }
    }
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
    const payload = body as Record<string, unknown>
    const actorPayload = await mergeActorPayload(req, payload)
    if (!actorPayload.handled_by && actorPayload.actor_user_id) {
      actorPayload.handled_by = `${String(actorPayload.actor || 'User')} (${String(actorPayload.actor_user_id)})`
    }
    const result = await dispatchCreateOrder(actorPayload)
    await enqueueOrderConfirmationSms({
      businessId: String(payload.business_id || 'ALMA_LIFESTYLE'),
      phone: String(payload.phone || payload.customer_phone || ''),
      invoice: String((result as { invoice_num?: string; invoice_number?: string; order_id?: string }).invoice_num || (result as { invoice_number?: string }).invoice_number || (result as { order_id?: string }).order_id || ''),
      orderId: String((result as { order_id?: string }).order_id || payload.id || ''),
    })
    void Promise.all([
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
    ]).catch(err => logEvent('warn', 'orders.create_post_commit_dispatch_failed', errorMeta(err)))
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
