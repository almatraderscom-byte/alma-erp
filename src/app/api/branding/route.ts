import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const route = p.all === '1' ? 'branding_all' : 'branding'
    const data = await serverGet(route, p.business_id ? { business_id: p.business_id } : {}, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const merged = withActorPayload(req, body as Record<string, unknown>)
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
