import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'
export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await serverGet('customers', p, 60), { headers: { 'Cache-Control': 's-maxage=60' } })
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    return NextResponse.json(await serverPost('create_customer', withActorPayload(req, raw)))
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
