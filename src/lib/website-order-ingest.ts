import { serverPost } from '@/lib/server-api'
import { notifyRole } from '@/lib/notifications'
import { sendOrderAlert } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'
import { enqueueOrderConfirmationSms } from '@/services/sms/events'

export type WebsiteOrderLine = {
  product_name: string
  collection_name?: string
  size?: string
  color?: string
  quantity: number
  unit_price: number
}

export type WebsiteOrderPayload = {
  website_order_id: string
  customer_name: string
  customer_phone: string
  customer_email?: string | null
  delivery_address: string
  delivery_city: string
  delivery_country: string
  delivery_postal?: string | null
  notes?: string | null
  total: number
  currency?: string
  items: WebsiteOrderLine[]
}

function normalizePhone(raw: string) {
  return String(raw || '').replace(/\D/g, '')
}

function buildErpPayload(input: WebsiteOrderPayload): Record<string, unknown> {
  const phone = normalizePhone(input.customer_phone)
  const address = [
    input.delivery_address,
    input.delivery_city,
    input.delivery_country,
    input.delivery_postal || '',
  ]
    .filter(Boolean)
    .join(', ')
  const totalQty = input.items.reduce((sum, line) => sum + Math.max(1, line.quantity), 0)
  const productSummary = input.items
    .map(line => `${line.product_name}${line.size ? ` (${line.size})` : ''} ×${line.quantity}`)
    .join(' | ')
  const noteLines = [
    `[Website ${input.website_order_id}]`,
    input.notes?.trim() || '',
    input.customer_email ? `Email: ${input.customer_email}` : '',
    `Currency: ${input.currency || 'BDT'}`,
  ].filter(Boolean)

  return {
    business_id: 'ALMA_LIFESTYLE',
    customer: input.customer_name.trim(),
    phone,
    address,
    payment: 'COD',
    payment_method: 'COD',
    source: 'Website',
    status: 'Pending',
    product: productSummary.slice(0, 500),
    category: input.items[0]?.collection_name || 'Website',
    size: input.items[0]?.size || input.items[0]?.color || '',
    qty: totalQty,
    unit_price: totalQty > 0 ? input.total / totalQty : input.total,
    sell_price: input.total,
    shipping_fee: 0,
    discount: 0,
    notes: noteLines.join('\n').slice(0, 4000),
    handled_by: 'Website (almatraders.com)',
    actor: 'Website',
    actor_role: 'STAFF',
  }
}

export async function ingestWebsiteOrder(input: WebsiteOrderPayload) {
  const gasPayload = buildErpPayload(input)
  const result = await serverPost<{
    order_id?: string
    invoice_num?: string
    invoice_number?: string
    error?: string
  }>('create_order', gasPayload)

  const erpOrderId = String(
    result.order_id || result.invoice_num || result.invoice_number || '',
  ).trim()

  const smsResult = await enqueueOrderConfirmationSms({
    businessId: 'ALMA_LIFESTYLE',
    phone: input.customer_phone,
    invoice: erpOrderId || input.website_order_id,
    orderId: erpOrderId || input.website_order_id,
  })
  logEvent('info', 'website_order.sms_enqueue', {
    websiteOrderId: input.website_order_id,
    smsOk: smsResult?.ok,
    smsSkipped: smsResult && 'skipped' in smsResult ? smsResult.skipped : undefined,
    smsReason: smsResult && 'reason' in smsResult ? smsResult.reason : undefined,
    smsDuplicate: smsResult && 'duplicate' in smsResult ? smsResult.duplicate : undefined,
  })

  void Promise.all([
    notifyRole({
      role: 'ADMIN',
      businessId: 'ALMA_LIFESTYLE',
      type: 'ORDER_ASSIGNED',
      priority: 'NORMAL',
      title: 'New website order',
      message: `Order ${erpOrderId || input.website_order_id} from ${input.customer_name} (${input.website_order_id}).`,
      actionUrl: '/orders',
    }),
    notifyRole({
      role: 'SUPER_ADMIN',
      businessId: 'ALMA_LIFESTYLE',
      type: 'ORDER_ASSIGNED',
      priority: 'NORMAL',
      title: 'New website order',
      message: `Order ${erpOrderId || input.website_order_id} from ${input.customer_name} (${input.website_order_id}).`,
      actionUrl: '/orders',
    }),
    sendOrderAlert({
      businessId: 'ALMA_LIFESTYLE',
      subject: `Website order · ${erpOrderId || input.website_order_id}`,
      title: 'Website order received',
      preview: `${input.customer_name} — ${input.website_order_id}`,
      text: `Website order ${input.website_order_id} synced as ${erpOrderId || 'pending ID'} for ${input.customer_name}.`,
      priority: 'NORMAL',
      actionUrl: '/orders',
      actionLabel: 'Open orders',
      dedupeKey: `website-order:${input.website_order_id}`,
      metadata: { input, result },
    }),
  ]).catch(err => logEvent('warn', 'website_order.post_commit_dispatch_failed', errorMeta(err)))

  logEvent('info', 'website_order.ingested', {
    websiteOrderId: input.website_order_id,
    erpOrderId,
    phone: gasPayload.phone,
  })

  return { ok: true as const, erpOrderId, result, sms: smsResult }
}
