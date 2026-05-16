import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { notifyRole } from '@/lib/notifications'
import { sendFinanceAlert } from '@/lib/resend'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet('cdit_invoices', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const route = body.action === 'update_status' ? 'cdit_update_invoice' : 'cdit_create_invoice'
    const data = await serverPost(route, await mergeActorPayload(req, body as Record<string, unknown>))
    if (route === 'cdit_create_invoice') {
      await notifyRole({
        role: 'ADMIN',
        businessId: 'CREATIVE_DIGITAL_IT',
        type: 'INVOICE_CREATED',
        priority: 'NORMAL',
        title: 'Digital invoice created',
        message: `A Creative Digital IT invoice was created for ${String(body.client_name || body.client_id || 'client')}.`,
        actionUrl: '/digital/invoices',
      })
      await sendFinanceAlert({
        businessId: 'CREATIVE_DIGITAL_IT',
        subject: 'Digital invoice created',
        title: 'Digital invoice created',
        preview: `A Creative Digital IT invoice was created for ${String(body.client_name || body.client_id || 'client')}.`,
        text: `A Creative Digital IT invoice was created for ${String(body.client_name || body.client_id || 'client')}.`,
        priority: 'NORMAL',
        actionUrl: '/digital/invoices',
        actionLabel: 'Open digital invoices',
        dedupeKey: `cdit-invoice-created:${String((data as { invoice_id?: string; invoice_number?: string }).invoice_id || (data as { invoice_number?: string }).invoice_number || Date.now())}`,
        metadata: { result: data },
      })
    }
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
