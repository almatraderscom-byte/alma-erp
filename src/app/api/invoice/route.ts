import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost, INVOICE_SERVER_TIMEOUT_MS } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { notifyRole } from '@/lib/notifications'
import { sendFinanceAlert } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'

/** Allow GAS PDF + Drive to finish (set Vercel Pro / appropriate plan so this is honored). */
export const maxDuration = 120

export async function GET() {
  try {
    // Must match WebApp_API.gs.js routeGet_ case 'next_invoice_num'
    const data = await serverGet<{ next?: string; invoice_number?: string }>('next_invoice_num', {}, 0)
    return NextResponse.json(data)
  } catch (e) {
    const msg = (e as Error).message
    logEvent('error', 'invoice.next_number_failed', errorMeta(e))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let raw: unknown
  const wallStart = Date.now()
  try {
    raw = await req.json()
    const body = raw as Record<string, unknown>
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) {
      logEvent('warn', 'invoice.generate_missing_id')
      return NextResponse.json({ error: 'Missing required field: id', ok: false }, { status: 400 })
    }
    const t0 = Date.now()
    const result = await serverPost<Record<string, unknown>>('generate_invoice', await mergeActorPayload(req, { id }), {
      timeoutMs: INVOICE_SERVER_TIMEOUT_MS,
    })
    logEvent('info', 'invoice.generate_completed', {
      orderId: id,
      invoiceNumber: result?.invoice_number,
      ok: result?.ok,
      wallMs: Date.now() - t0,
    })
    await Promise.all([
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId: String(body.business_id || 'ALMA_LIFESTYLE'),
        type: 'INVOICE_CREATED',
        priority: 'NORMAL',
        title: 'Invoice created',
        message: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        actionUrl: '/invoice',
      }),
      notifyRole({
        role: 'ADMIN',
        businessId: String(body.business_id || 'ALMA_LIFESTYLE'),
        type: 'INVOICE_CREATED',
        priority: 'NORMAL',
        title: 'Invoice created',
        message: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        actionUrl: '/invoice',
      }),
      sendFinanceAlert({
        businessId: String(body.business_id || 'ALMA_LIFESTYLE'),
        subject: `Invoice generated · ${String(result.invoice_number || id)}`,
        title: 'Invoice generated',
        preview: `Invoice ${String(result.invoice_number || id)} was generated successfully.`,
        text: `Invoice ${String(result.invoice_number || id)} was generated successfully for order ${id}.`,
        priority: 'NORMAL',
        actionUrl: '/invoice',
        actionLabel: 'Open invoices',
        dedupeKey: `invoice-generated:${String(result.invoice_number || id)}`,
        metadata: { orderId: id, invoiceNumber: result.invoice_number },
      }),
    ])
    return NextResponse.json(result)
  } catch (e) {
    const msg = (e as Error).message
    const orderId = typeof raw === 'object' && raw && typeof (raw as Record<string, unknown>).id === 'string'
      ? (raw as Record<string, unknown>).id
      : undefined
    logEvent('error', 'invoice.generate_failed', { ...errorMeta(e), wallMs: Date.now() - wallStart, orderId })
    return NextResponse.json({ error: msg, ok: false }, { status: 502 })
  }
}
