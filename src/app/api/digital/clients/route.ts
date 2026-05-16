import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { errorMeta, logEvent } from '@/lib/logger'

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
    const data = await serverPost<{ ok?: boolean; error?: string; client_id?: string }>(
      'cdit_create_client',
      await mergeActorPayload(req, body as Record<string, unknown>),
    )
    logEvent('info', 'digital.clients.create_completed', { ok: data?.ok, clientId: data?.client_id })
    if (data && data.ok === false) {
      return NextResponse.json({ error: data.error || 'Create client failed' }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (e) {
    const msg = (e as Error).message
    logEvent('error', 'digital.clients.create_failed', {
      ...errorMeta(e),
      businessId: body.business_id,
      clientName: body.client_name || body.name,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
