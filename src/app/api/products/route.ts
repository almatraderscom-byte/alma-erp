import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { errorMeta, logEvent } from '@/lib/logger'

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
    const result = await serverPost('create_product', await mergeActorPayload(req, json))
    logEvent('info', 'products.create_completed', {
      ok: (result as { ok?: boolean }).ok,
      productId: (result as { product_id?: string }).product_id,
    })
    return NextResponse.json(result)
  } catch (e) {
    const msg = (e as Error).message
    logEvent('error', 'products.create_failed', errorMeta(e))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
