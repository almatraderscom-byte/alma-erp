import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet(p.id ? 'order' : 'orders', p, 30)
    return NextResponse.json(data, { headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' } })
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
export async function POST(req: NextRequest) {
  try { return NextResponse.json(await serverPost('create_order', await req.json())) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }) }
}
