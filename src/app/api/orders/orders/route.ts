import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'

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
    const result = await serverPost('create_order', withActorPayload(req, body as Record<string, unknown>))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[/api/orders/orders POST] failed:', (e as Error).message, '| body:', JSON.stringify(body))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
