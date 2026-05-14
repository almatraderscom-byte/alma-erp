import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'

/** No CDN stale reads — inventory and product forms need fresh PRODUCT MASTER after writes. */
export async function GET() {
  try {
    const data = await serverGet('products', {}, 0)
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const json = (await req.json()) as Record<string, unknown>
    console.log('[api/products POST] create_product keys=', Object.keys(json).join(','))
    const result = await serverPost('create_product', json)
    console.log('[api/products POST] ok=', (result as { ok?: boolean }).ok, 'product_id=', (result as { product_id?: string }).product_id)
    return NextResponse.json(result)
  } catch (e) {
    const msg = (e as Error).message
    console.error('[api/products POST] error', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
