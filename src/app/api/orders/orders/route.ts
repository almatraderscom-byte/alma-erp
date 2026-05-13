import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet(p.id ? 'order' : 'orders', p, 30)
    return NextResponse.json(data, { headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' } })
  } catch (e) {
    console.error('[/api/orders/orders GET]', (e as Error).message)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
    const b = body as Record<string, unknown>

    // The deployed GAS uses legacy field names; map frontend names → GAS names
    const gasPayload: Record<string, unknown> = {
      ...b,
      customer_name:    b.customer    ?? b.customer_name,
      customer_phone:   b.phone       ?? b.customer_phone,
      customer_address: b.address     ?? b.customer_address,
      product_name:     b.product     ?? b.product_name,
    }

    console.log('[/api/orders/orders POST] customer=', b.customer, 'product=', b.product)
    const result = await serverPost('create_order', gasPayload)
    console.log('[/api/orders/orders POST] success', JSON.stringify(result))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[/api/orders/orders POST] failed:', (e as Error).message, '| body:', JSON.stringify(body))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
