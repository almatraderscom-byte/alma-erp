import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { BUSINESS_LIST, resolveBusinessId } from '@/lib/businesses'
import { defaultBusinessBranding } from '@/lib/branding-defaults'
import { errorMeta, logEvent } from '@/lib/logger'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const route = p.all === '1' ? 'branding_all' : 'branding'
    const data = await serverGet(route, p.business_id ? { business_id: p.business_id } : {}, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    logEvent('warn', 'branding.gas_fallback', { ...errorMeta(e), all: p.all === '1', businessId: p.business_id })
    if (p.all === '1') {
      return NextResponse.json({
        ok: true,
        fallback: true,
        branding_by_business: Object.fromEntries(BUSINESS_LIST.map(b => [b.id, defaultBusinessBranding(b.id)])),
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const businessId = resolveBusinessId(typeof p.business_id === 'string' ? p.business_id : null)
    return NextResponse.json({
      ok: true,
      fallback: true,
      branding: defaultBusinessBranding(businessId),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const merged = await mergeActorPayload(req, body as Record<string, unknown>)
    const action = String(body.action || 'save')
    if (action === 'upload') {
      const data = await serverPost('upload_brand_asset', merged)
      return NextResponse.json(data)
    }
    const data = await serverPost('save_branding', merged)
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
