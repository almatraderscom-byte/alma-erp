import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { withActorPayload } from '@/lib/api-route-actor'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    return NextResponse.json(await serverGet('finance', p, 0), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    return NextResponse.json(await serverPost('add_expense', withActorPayload(req, raw)))
  }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
