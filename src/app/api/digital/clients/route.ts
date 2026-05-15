import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet('cdit_clients', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
    console.log('[POST /api/digital/clients] payload keys:', Object.keys(body).join(','))
    const data = await serverPost<{ ok?: boolean; error?: string; client_id?: string }>(
      'cdit_create_client',
      withActorPayload(req, body as Record<string, unknown>),
    )
    console.log('[POST /api/digital/clients] GAS ok:', data?.ok, 'client_id:', data?.client_id)
    if (data && data.ok === false) {
      return NextResponse.json({ error: data.error || 'Create client failed' }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (e) {
    const msg = (e as Error).message
    console.error('[POST /api/digital/clients] error:', msg, '| body:', JSON.stringify(body).slice(0, 200))
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
