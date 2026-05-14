import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'

export async function GET() {
  try {
    // Must match WebApp_API.gs.js routeGet_ case 'next_invoice_num'
    const data = await serverGet<{ next?: string; invoice_number?: string }>('next_invoice_num', {}, 0)
    return NextResponse.json(data)
  } catch (e) {
    const msg = (e as Error).message
    console.error('[GET /api/invoice]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let raw: unknown
  try {
    raw = await req.json()
    const body = raw as Record<string, unknown>
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (!id) {
      console.warn('[POST /api/invoice] missing id', JSON.stringify(body))
      return NextResponse.json({ error: 'Missing required field: id', ok: false }, { status: 400 })
    }
    console.log('[POST /api/invoice] generate_invoice id=', id)
    const result = await serverPost<Record<string, unknown>>('generate_invoice', { id })
    console.log('[POST /api/invoice] GAS ok=', result?.ok, 'invoice_number=', result?.invoice_number)
    return NextResponse.json(result)
  } catch (e) {
    const msg = (e as Error).message
    console.error('[POST /api/invoice]', msg, '| body=', JSON.stringify(raw))
    return NextResponse.json({ error: msg, ok: false }, { status: 502 })
  }
}
