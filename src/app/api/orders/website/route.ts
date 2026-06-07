import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { errorMeta, logEvent } from '@/lib/logger'
import { ingestWebsiteOrder, type WebsiteOrderPayload } from '@/lib/website-order-ingest'

function authorized(req: NextRequest) {
  const secret = process.env.WEBSITE_ORDER_SECRET?.trim()
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  if (auth === `Bearer ${secret}`) return true
  const header = req.headers.get('x-website-order-secret') || ''
  return header === secret
}

function parseBody(raw: unknown): WebsiteOrderPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const websiteOrderId = String(body.website_order_id || '').trim()
  const customerName = String(body.customer_name || body.customer || '').trim()
  const customerPhone = String(body.customer_phone || body.phone || '').trim()
  const deliveryAddress = String(body.delivery_address || body.address || '').trim()
  const deliveryCity = String(body.delivery_city || body.city || '').trim()
  const deliveryCountry = String(body.delivery_country || body.country || 'Bangladesh').trim()
  const items = Array.isArray(body.items) ? body.items : []
  if (!websiteOrderId || !customerName || !customerPhone || !deliveryAddress || !deliveryCity || !items.length) {
    return null
  }
  const lines = items
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const productName = String(row.product_name || row.product || '').trim()
      const quantity = Number(row.quantity || row.qty || 0)
      const unitPrice = Number(row.unit_price || 0)
      if (!productName || quantity <= 0) return null
      return {
        product_name: productName,
        collection_name: String(row.collection_name || row.category || '').trim() || undefined,
        size: String(row.size || '').trim() || undefined,
        color: String(row.color || row.variant || '').trim() || undefined,
        quantity,
        unit_price: unitPrice,
      }
    })
    .filter((line): line is NonNullable<typeof line> => Boolean(line))
  if (!lines.length) return null
  const total = Number(body.total) || lines.reduce((sum, line) => sum + line.unit_price * line.quantity, 0)
  return {
    website_order_id: websiteOrderId,
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_email: body.customer_email ? String(body.customer_email) : null,
    delivery_address: deliveryAddress,
    delivery_city: deliveryCity,
    delivery_country: deliveryCountry,
    delivery_postal: body.delivery_postal ? String(body.delivery_postal) : null,
    notes: body.notes ? String(body.notes) : null,
    total,
    currency: body.currency ? String(body.currency) : 'BDT',
    items: lines,
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const limited = rateLimit(req, 'website-order', 60)
  if (limited) return limited

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const payload = parseBody(raw)
  if (!payload) {
    return NextResponse.json({ error: 'Invalid website order payload' }, { status: 400 })
  }

  try {
    const result = await ingestWebsiteOrder(payload)
    return NextResponse.json({
      ok: true,
      website_order_id: payload.website_order_id,
      erp_order_id: result.erpOrderId,
    })
  } catch (e) {
    logEvent('error', 'website_order.ingest_failed', {
      websiteOrderId: payload.website_order_id,
      ...errorMeta(e),
    })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
