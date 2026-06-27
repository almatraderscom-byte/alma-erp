import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleProducts } from '@/lib/lifestyle/read'
import { dispatchCreateProduct } from '@/lib/lifestyle/write-dispatch'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { errorMeta, logEvent } from '@/lib/logger'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { redactProductCost } from '@/lib/lifestyle/redact-cost'
import { apiFailure } from '@/lib/safe-api-response'

/** No CDN stale reads — inventory and product forms need fresh PRODUCT MASTER after writes. */
export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    const role = normalizeAlmaRole(token?.role as string)
    const data = await getLifestyleProducts()
    return NextResponse.json(redactProductCost(data, role), {
      headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=120' },
    })
  } catch (e) {
    logEvent('error', 'products.read_failed', errorMeta(e))
    return apiFailure('server_error', 'Could not load products.', { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const json = (await req.json()) as Record<string, unknown>
    const result = await dispatchCreateProduct(await mergeActorPayload(req, json))
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
